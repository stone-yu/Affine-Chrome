import type { ExtractResult, ExtractError } from '../types';
import { extractArticle } from './extractor';
import { toMarkdown } from './markdown';
import { findAndPrepare, captureAll, substituteImages } from './special-nodes';

/**
 * Directly find and fetch DrawIO images from the page DOM, completely bypassing
 * Readability. This is necessary because:
 *   1. Readability strips <img src="affine-img://..."> placeholders (non-std scheme).
 *   2. The CDN URLs require session cookies; fetch() from a content script has them.
 *
 * We scan for known DrawIO img selectors, fetch each SVG, and return data URIs.
 */
async function captureDrawioDirectly(hostname: string): Promise<string[]> {
  if (!hostname.includes('km.sankuai.com')) return [];

  const imgs = Array.from(
    document.querySelectorAll(
      'img[src*="/api/file/cdn/"], img[src*="contentType=0"], img[data-src*="/api/file/cdn/"]'
    )
  ) as HTMLImageElement[];

  console.log(`[AFFiNE Clipper] DrawIO direct-capture: found ${imgs.length} candidate img(s)`);
  if (imgs.length === 0) return [];

  const results: string[] = [];
  for (const img of imgs) {
    const src = img.src || img.dataset['src'] || '';
    if (!src || src.startsWith('data:')) continue;

    console.log(`[AFFiNE Clipper]   fetching ${src.substring(0, 80)}…`);
    try {
      const res = await fetch(src, { credentials: 'include' });
      console.log(`[AFFiNE Clipper]   → status=${res.status} type=${res.headers.get('content-type')}`);
      if (!res.ok) {
        console.warn(`[AFFiNE Clipper]   fetch failed (${res.status})`);
        continue;
      }
      const blob = await res.blob();
      console.log(`[AFFiNE Clipper]   blob size=${blob.size}`);
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      results.push(dataUri);
      console.log(`[AFFiNE Clipper]   ✓ captured, dataUri.length=${dataUri.length}`);
    } catch (err) {
      console.warn('[AFFiNE Clipper]   fetch error:', err);
    }
  }
  console.log(`[AFFiNE Clipper] DrawIO direct-capture: ${results.length}/${imgs.length} succeeded`);
  return results;
}

async function performExtraction(): Promise<ExtractResult | ExtractError> {
  try {
    const hostname = location.hostname;

    // ── Step 1: extract text + general special nodes ──────────────────────
    const { modifiedClone, jobs } = findAndPrepare(document);

    const article = extractArticle(modifiedClone);
    if (!article) {
      return { type: 'EXTRACT_ERROR', message: 'Could not extract article content from this page.' };
    }

    const markdown = toMarkdown(article.content);
    const images = await captureAll(jobs);
    let finalMarkdown = substituteImages(markdown, images);

    // ── Step 2: DrawIO on km.sankuai.com (direct fetch, bypasses Readability) ─
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
