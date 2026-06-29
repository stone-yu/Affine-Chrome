import type { ExtractResult, ExtractError } from '../types';
import { extractArticle } from './extractor';
import { toMarkdown } from './markdown';
import { findAndPrepare, captureAll, substituteImages } from './special-nodes';

/** Blob → base-64 data URI (inline helper so we don't need an extra import). */
function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Directly find and capture DrawIO diagrams on km.sankuai.com, bypassing
 * Readability entirely.  Two render strategies are tried:
 *
 *   A. <img src="…/api/file/cdn/…"> — fetch the SVG with session cookies.
 *   B. Inline <svg viewBox="-0.5 …"> — serialize the already-rendered DOM node.
 *      DrawIO SVGs always have a viewBox starting at -0.5; UI icons are tiny,
 *      so we skip any SVG whose rendered width × height is less than 200 × 100.
 */
async function captureDrawioDirectly(hostname: string): Promise<string[]> {
  if (!hostname.includes('km.sankuai.com')) return [];

  const results: string[] = [];

  // ── A: img elements with CDN URLs ────────────────────────────────────────
  const imgs = Array.from(
    document.querySelectorAll(
      'img[src*="/api/file/cdn/"], img[src*="contentType=0"], img[data-src*="/api/file/cdn/"]'
    )
  ) as HTMLImageElement[];
  console.log(`[AFFiNE Clipper] DrawIO: ${imgs.length} <img> candidate(s)`);

  for (const img of imgs) {
    const src = img.src || img.dataset['src'] || '';
    if (!src || src.startsWith('data:')) continue;
    console.log(`[AFFiNE Clipper]   fetching img ${src.substring(0, 80)}`);
    try {
      const res = await fetch(src, { credentials: 'include' });
      console.log(`[AFFiNE Clipper]   status=${res.status}`);
      if (!res.ok) continue;
      const blob = await res.blob();
      results.push(await blobToDataUri(blob));
      console.log(`[AFFiNE Clipper]   ✓ img ${blob.size}B`);
    } catch (err) {
      console.warn('[AFFiNE Clipper]   img fetch error:', err);
    }
  }

  // ── B: inline SVG elements ────────────────────────────────────────────────
  const svgs = Array.from(
    document.querySelectorAll('svg[viewBox^="-0.5"]')
  ) as SVGSVGElement[];
  console.log(`[AFFiNE Clipper] DrawIO: ${svgs.length} <svg viewBox^="-0.5"> candidate(s)`);

  for (const svg of svgs) {
    // DrawIO diagrams are large; skip tiny UI icons
    const { width, height } = svg.getBoundingClientRect();
    console.log(`[AFFiNE Clipper]   svg size=${width.toFixed(0)}×${height.toFixed(0)}`);
    if (width < 200 || height < 100) continue;

    try {
      const svgText = new XMLSerializer().serializeToString(svg);
      const b64 = btoa(unescape(encodeURIComponent(svgText)));
      results.push(`data:image/svg+xml;base64,${b64}`);
      console.log(`[AFFiNE Clipper]   ✓ svg serialized`);
    } catch (err) {
      console.warn('[AFFiNE Clipper]   svg serialize error:', err);
    }
  }

  console.log(`[AFFiNE Clipper] DrawIO direct-capture: ${results.length} total`);
  return results;
}

async function performExtraction(): Promise<ExtractResult | ExtractError> {
  try {
    const hostname = location.hostname;

    // ── Step 1: text + general special nodes ─────────────────────────────
    const { modifiedClone, jobs } = findAndPrepare(document);

    const article = extractArticle(modifiedClone);
    if (!article) {
      return { type: 'EXTRACT_ERROR', message: 'Could not extract article content from this page.' };
    }

    const markdown = toMarkdown(article.content);
    const images = await captureAll(jobs);
    let finalMarkdown = substituteImages(markdown, images);

    // ── Step 2: DrawIO diagrams (independent of Readability) ─────────────
    const drawioUris = await captureDrawioDirectly(hostname);
    if (drawioUris.length > 0) {
      finalMarkdown +=
        '\n\n---\n\n' +
        drawioUris.map((uri, i) => `![DrawIO 图表 ${i + 1}](${uri})`).join('\n\n');
    }

    return {
      type: 'EXTRACT_RESULT',
      title: article.title || document.title,
      markdown: finalMarkdown,
      wordCount: article.wordCount,
      specialNodes: [
        ...jobs.map((j) => j.info),
        ...drawioUris.map((_, i) => ({ label: `DrawIO 图表 ${i + 1}`, kind: 'DrawIO' })),
      ],
    };
  } catch (err) {
    return { type: 'EXTRACT_ERROR', message: String(err) };
  }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'EXTRACT') {
    performExtraction().then(sendResponse);
    return true; // keep message channel open for async response
  }
});
