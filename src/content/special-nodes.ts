import html2canvas from 'html2canvas';
import type { CaptureJob, SpecialNodeInfo } from '../types';

interface NodeRule {
  match: string; // hostname or '*'
  selector: string;
  kind: string;
  label: string;
}

const RULES: NodeRule[] = [
  // km.sankuai.com DrawIO: the CitadelMD :::drawio{src="..."} block renders as
  // <img src="https://km.sankuai.com/api/file/cdn/...?contentType=0...">
  // We also cover data-src lazy-loading variants.
  {
    match: 'km.sankuai.com',
    selector: [
      '[data-node-type="drawio"]',
      'img[src*="/api/file/cdn/"]',
      'img[data-src*="/api/file/cdn/"]',
      'img[src*="contentType=0"]',
    ].join(', '),
    kind: 'DrawIO',
    label: 'DrawIO 图表',
  },
  { match: '*', selector: '.mermaid > svg, [class*="mermaid"] > svg', kind: 'Mermaid', label: 'Mermaid 图表' },
  { match: '*', selector: 'img[src*="plantuml"]', kind: 'PlantUML', label: 'PlantUML 图表' },
  { match: '*', selector: '.chart-container svg, .diagram-container svg, [class*="echarts"] svg', kind: 'Chart', label: '图表' },
];

function getRulesForHost(hostname: string): NodeRule[] {
  return RULES.filter((r) => r.match === '*' || hostname.includes(r.match));
}

export function findAndPrepare(
  doc: Document
): { modifiedClone: Document; jobs: CaptureJob[] } {
  const hostname = doc.location?.hostname ?? (typeof location !== 'undefined' ? location.hostname : '');
  const rules = getRulesForHost(hostname);

  // Collect unique original elements (avoid duplicates from overlapping selectors)
  const seen = new Set<Element>();
  const found: { element: Element; rule: NodeRule }[] = [];
  for (const rule of rules) {
    doc.querySelectorAll(rule.selector).forEach((el) => {
      if (!seen.has(el)) {
        seen.add(el);
        found.push({ element: el, rule });
      }
    });
  }

  // Build jobs referencing original elements
  const jobs: CaptureJob[] = found.map(({ element, rule }, i) => ({
    id: `node-${i}`,
    element,
    info: { label: rule.label, kind: rule.kind },
  }));

  // Build a modified clone with placeholders.
  // Snapshot both node lists BEFORE the loop — replacing nodes in the clone
  // changes its querySelectorAll count, making index-based lookup unreliable mid-loop.
  const modifiedClone = doc.cloneNode(true) as Document;
  const allOriginal = Array.from(doc.querySelectorAll('*'));
  const allClone = Array.from(modifiedClone.querySelectorAll('*'));

  for (const job of jobs) {
    const idx = allOriginal.indexOf(job.element);
    if (idx === -1) continue;
    const cloneEl = allClone[idx];
    if (!cloneEl) continue;
    const placeholder = modifiedClone.createElement('img');
    placeholder.setAttribute('src', `affine-img://${job.id}`);
    placeholder.setAttribute('alt', job.info.label);
    cloneEl.replaceWith(placeholder);
  }

  return { modifiedClone, jobs };
}

async function waitForRender(el: Element, retries = 3): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    if ((el as HTMLElement).offsetHeight > 0) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Convert a Blob to a base-64 data URI. */
function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Try to capture an <img> whose src points to an authenticated SVG (e.g. km.sankuai.com
 * DrawIO diagrams). html2canvas can't handle these because:
 *   1. The SVG contains <foreignObject>, which taints the canvas on drawing.
 *   2. Re-fetching the URL without session cookies returns 401.
 *
 * Instead, we fetch the URL from within the content script (which inherits the page's
 * cookies) and return a data URI of the SVG content directly.
 */
async function captureAuthSvgImg(el: Element): Promise<string | null> {
  const img = el as HTMLImageElement;
  // Support both src and data-src (lazy loading)
  const src = img.src || img.dataset.src || img.getAttribute('data-src') || '';
  if (!src || src.startsWith('data:')) return null;

  try {
    const res = await fetch(src, { credentials: 'include' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return blobToDataUri(blob);
  } catch {
    return null;
  }
}

export async function captureAll(jobs: CaptureJob[]): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  for (const job of jobs) {
    try {
      const ready = await waitForRender(job.element);
      if (!ready) {
        console.warn(`[affine-clipper] Skipping ${job.id}: element has no height after retries`);
        continue;
      }

      // DrawIO images on km.sankuai.com are SVGs served via authenticated CDN URLs.
      // Fetch them directly instead of using html2canvas (which would taint the canvas).
      if (job.info.kind === 'DrawIO' && job.element.tagName === 'IMG') {
        const dataUri = await captureAuthSvgImg(job.element);
        if (dataUri) {
          results.set(job.id, dataUri);
          continue;
        }
        // Fall through to html2canvas if fetch failed
      }

      const canvas = await html2canvas(job.element as HTMLElement, {
        useCORS: true,
        scale: window.devicePixelRatio,
      });
      results.set(job.id, canvas.toDataURL('image/png'));
    } catch (err) {
      console.warn(`[affine-clipper] Failed to capture ${job.id}:`, err);
    }
  }
  return results;
}

export function substituteImages(markdown: string, images: Map<string, string>): string {
  return markdown
    .split('\n')
    .map((line) => {
      const match = line.match(/!\[.*?\]\(affine-img:\/\/(node-\d+)\)/);
      if (!match) return line;
      const id = match[1];
      const dataUri = images.get(id);
      if (!dataUri) return null; // will be filtered out
      return line.replace(`affine-img://${id}`, dataUri);
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}
