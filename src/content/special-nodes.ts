import html2canvas from 'html2canvas';
import type { CaptureJob, SpecialNodeInfo } from '../types';

interface NodeRule {
  match: string; // hostname or '*'
  selector: string;
  kind: string;
  label: string;
}

const RULES: NodeRule[] = [
  { match: 'km.sankuai.com', selector: '[data-node-type="drawio"], img[src*="/api/file/cdn/"]', kind: 'DrawIO', label: 'DrawIO 图表' },
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

export async function captureAll(jobs: CaptureJob[]): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  for (const job of jobs) {
    try {
      const ready = await waitForRender(job.element);
      if (!ready) {
        console.warn(`[affine-clipper] Skipping ${job.id}: element has no height after retries`);
        continue;
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
