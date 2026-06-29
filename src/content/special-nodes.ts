import html2canvas from 'html2canvas';
import type { CaptureJob, SpecialNodeInfo } from '../types';

interface NodeRule {
  match: string; // hostname or '*'
  selector: string;
  kind: string;
  label: string;
}

const RULES: NodeRule[] = [
  // km.sankuai.com DrawIO: Citadel renders :::drawio{src="..."}::: in several ways.
  // We try every known pattern; console logs show which ones actually match.
  {
    match: 'km.sankuai.com',
    selector: [
      // Inline SVG with mxGraph content attribute (most common when Citadel inlines the SVG)
      'svg[content]',
      // DrawIO SVGs are characterised by <foreignObject> inside; viewBox starting at -0.5
      // is the default drawio padding — use as heuristic to catch unlabelled inline SVGs
      'svg[viewBox^="-0.5"]',
      // Citadel/Quark data-node-type attributes
      '[data-node-type="drawio"]',
      '[data-node-type="drawio"] svg',
      '[data-node-type="drawio"] img',
      // Generic CDN image patterns
      'img[src*="/api/file/cdn/"]',
      'img[data-src*="/api/file/cdn/"]',
      'img[src*="contentType=0"]',
      'img[src*="isNewContent"]',
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

  // Diagnostic logging — visible in DevTools on the clipped page's console
  if (hostname.includes('km.sankuai.com')) {
    console.group('[AFFiNE Clipper] DrawIO detection on km.sankuai.com');
    console.log('Total SVGs on page:', document.querySelectorAll('svg').length);
    console.log('svg[content]:', document.querySelectorAll('svg[content]').length);
    console.log('svg[viewBox^="-0.5"]:', document.querySelectorAll('svg[viewBox^="-0.5"]').length);
    console.log('img[src*=cdn]:', document.querySelectorAll('img[src*="/api/file/cdn/"]').length);
    console.log('[data-node-type=drawio]:', document.querySelectorAll('[data-node-type="drawio"]').length);
    console.log('Total matched special nodes:', found.length);
    found.forEach(({ element, rule }, i) => {
      console.log(`  [${i}] ${rule.kind} → <${element.tagName.toLowerCase()}>`
        + ` class="${element.getAttribute('class') ?? ''}"`,
        element
      );
    });
    console.groupEnd();
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
  console.log(`[affine-clipper] captureAuthSvgImg src="${src.substring(0, 80)}"`);
  if (!src || src.startsWith('data:')) {
    console.warn('[affine-clipper] captureAuthSvgImg: no valid src');
    return null;
  }

  try {
    const res = await fetch(src, { credentials: 'include' });
    console.log(`[affine-clipper] fetch status=${res.status} type=${res.headers.get('content-type')}`);
    if (!res.ok) {
      console.warn(`[affine-clipper] fetch failed: ${res.status}`);
      return null;
    }
    const blob = await res.blob();
    console.log(`[affine-clipper] blob size=${blob.size} type=${blob.type}`);
    const uri = await blobToDataUri(blob);
    console.log(`[affine-clipper] dataUri length=${uri.length}`);
    return uri;
  } catch (err) {
    console.warn('[affine-clipper] captureAuthSvgImg fetch error:', err);
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

      // Inline <svg> element (e.g. Citadel DrawIO rendered as inline SVG):
      // Serialize the SVG DOM directly to a data URI. No fetch or canvas needed,
      // and no foreignObject taint issue since we never touch a canvas.
      if (job.element.tagName === 'svg' || job.element.tagName === 'SVG') {
        try {
          const svgText = new XMLSerializer().serializeToString(job.element);
          const b64 = btoa(unescape(encodeURIComponent(svgText)));
          results.set(job.id, `data:image/svg+xml;base64,${b64}`);
          continue;
        } catch (err) {
          console.warn(`[affine-clipper] SVG serialize failed for ${job.id}:`, err);
        }
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
