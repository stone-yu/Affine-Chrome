import type { ExtractResult, ExtractError } from '../types';
import { extractArticle } from './extractor';
import { toMarkdown } from './markdown';
import { findAndPrepare, captureAll, substituteImages } from './special-nodes';

/** Blob -> base-64 data URI */
function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

interface DrawioCapture {
  dataUri: string;
  /** Preceding text (up to 80 chars) from a sibling/parent element.
   *  Used to insert the image after that text in the Markdown. null = append at end. */
  marker: string | null;
}

/**
 * Capture DrawIO diagrams on km.sankuai.com.
 *
 * km.sankuai.com uses virtual scrolling: SVG elements only exist in the DOM
 * while visible.  We use two strategies to find the CDN URLs:
 *
 *  A. Scan ALL element attributes — even with virtual scrolling the React
 *     placeholder containers (which hold the src URL as a data prop) remain in
 *     the DOM.  When found this way we can also extract a "marker" (text of the
 *     nearest preceding sibling) to insert the image at the right position.
 *
 *  B. Regex-scan the raw innerHTML — catches URLs that only live inside
 *     serialised JSON blobs / script tags (no position info).
 */
async function captureDrawioDirectly(hostname: string): Promise<DrawioCapture[]> {
  if (!hostname.includes('km.sankuai.com')) return [];

  const unescapeHtml = (s: string) =>
    s.replace(/&amp;/g, '&').replace(/&#x2F;/g, '/').replace(/&#47;/g, '/');

  // ── Strategy A: DOM attribute scan ───────────────────────────────────────
  const domRefs: { url: string; marker: string | null }[] = [];
  const seenA = new Set<string>();
  document.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.value.includes('/api/file/cdn/') && attr.value.includes('contentType=0')) {
        const url = unescapeHtml(attr.value.split(/["' <>\\]/)[0]);
        if (seenA.has(url)) break;
        seenA.add(url);

        // Walk up the DOM to find the nearest preceding sibling text (position marker)
        let marker: string | null = null;
        let node: Element | null = el;
        for (let depth = 0; depth < 8 && node && !marker; depth++, node = node.parentElement) {
          let prev = node.previousElementSibling;
          while (prev) {
            const txt = (prev.textContent ?? '').trim().replace(/\s+/g, ' ');
            if (txt.length > 4) { marker = txt.substring(0, 80); break; }
            prev = prev.previousElementSibling;
          }
        }
        domRefs.push({ url, marker });
        break;
      }
    }
  });
  console.log(`[AFFiNE Clipper] DrawIO from DOM attrs: ${domRefs.length}`);
  domRefs.forEach((r, i) => console.log(`  [${i}] marker="${r.marker}" url=${r.url.substring(0, 80)}`));

  // ── Strategy B: raw HTML scan (fallback) ─────────────────────────────────
  const rawMatches = (document.documentElement.innerHTML.match(
    /https?:\/\/km\.sankuai\.com\/api\/file\/cdn\/[^"' <>\s\\]+contentType=0[^"' <>\s\\]*/g
  ) ?? []).map(unescapeHtml);
  const uniqueFromHtml = [...new Set(rawMatches)].filter(u => !seenA.has(u));
  console.log(`[AFFiNE Clipper] DrawIO from HTML scan: ${uniqueFromHtml.length} extra`);

  // Merge: DOM refs first (have position info), then HTML-only extras
  const allRefs = [
    ...domRefs,
    ...uniqueFromHtml.map(url => ({ url, marker: null })),
  ];
  if (allRefs.length === 0) return [];

  // ── Fetch each SVG ────────────────────────────────────────────────────────
  const results: DrawioCapture[] = [];
  for (const { url, marker } of allRefs) {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      console.log(`[AFFiNE Clipper]   status=${res.status} for ${url.substring(0, 60)}`);
      if (!res.ok) continue;
      const blob = await res.blob();
      results.push({ dataUri: await blobToDataUri(blob), marker });
      console.log(`[AFFiNE Clipper]   captured ${blob.size}B, marker="${marker}"`);
    } catch (err) {
      console.warn('[AFFiNE Clipper]   fetch error:', err);
    }
  }
  console.log(`[AFFiNE Clipper] DrawIO: ${results.length}/${allRefs.length} captured`);
  return results;
}

/**
 * Insert DrawIO images at approximately the right positions in the Markdown.
 * If a capture has a marker, we search for that text and append the image
 * immediately after the paragraph that contains it.
 * Images without a marker (or whose marker wasn't found) are appended at the end.
 */
function insertDrawioImages(markdown: string, captures: DrawioCapture[]): string {
  let result = markdown;
  const unpositioned: string[] = [];

  for (let i = 0; i < captures.length; i++) {
    const { dataUri, marker } = captures[i];
    const imgMd = `![DrawIO 图表 ${i + 1}](${dataUri})`;
    let inserted = false;

    if (marker) {
      // Find the marker text (case-insensitive, first 40 chars for robustness)
      const key = marker.substring(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(key, 'i');
      const match = re.exec(result);
      if (match) {
        // Find the end of the paragraph/line containing the match
        const lineEnd = result.indexOf('\n\n', match.index);
        const insertAt = lineEnd === -1 ? result.length : lineEnd;
        result = result.slice(0, insertAt) + '\n\n' + imgMd + result.slice(insertAt);
        inserted = true;
      }
    }

    if (!inserted) unpositioned.push(imgMd);
  }

  if (unpositioned.length > 0) {
    result += '\n\n---\n\n' + unpositioned.join('\n\n');
  }

  return result;
}

async function performExtraction(): Promise<ExtractResult | ExtractError> {
  try {
    const hostname = location.hostname;

    const { modifiedClone, jobs } = findAndPrepare(document);

    const article = extractArticle(modifiedClone);
    if (!article) {
      return { type: 'EXTRACT_ERROR', message: 'Could not extract article content from this page.' };
    }

    const markdown = toMarkdown(article.content);
    const images = await captureAll(jobs);
    let finalMarkdown = substituteImages(markdown, images);

    // DrawIO on km.sankuai.com: fetch from page (independent of Readability)
    const drawioCaptures = await captureDrawioDirectly(hostname);
    if (drawioCaptures.length > 0) {
      finalMarkdown = insertDrawioImages(finalMarkdown, drawioCaptures);
    }

    return {
      type: 'EXTRACT_RESULT',
      title: article.title || document.title,
      markdown: finalMarkdown,
      wordCount: article.wordCount,
      specialNodes: [
        ...jobs.map((j) => j.info),
        ...drawioCaptures.map((_, i) => ({ label: `DrawIO 图表 ${i + 1}`, kind: 'DrawIO' })),
      ],
    };
  } catch (err) {
    return { type: 'EXTRACT_ERROR', message: String(err) };
  }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'EXTRACT') {
    performExtraction().then(sendResponse);
    return true;
  }
});
