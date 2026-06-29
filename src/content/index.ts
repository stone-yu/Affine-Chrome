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

/**
 * Extract DrawIO CDN URLs from the raw page HTML, then fetch each one.
 *
 * km.sankuai.com uses virtual scrolling, so DrawIO elements are only mounted
 * in the DOM while visible.  The src URLs are however always present in the
 * page's raw HTML (serialised as React props / data attributes).  We scan
 * document.documentElement.innerHTML with a regex and fetch each unique URL
 * with the user's session cookies.
 */
async function captureDrawioDirectly(hostname: string): Promise<string[]> {
  if (!hostname.includes('km.sankuai.com')) return [];

  // Scan the raw HTML for CDN URLs that carry DrawIO content
  const html = document.documentElement.innerHTML;
  const rawMatches = html.match(
    /https?:\/\/km\.sankuai\.com\/api\/file\/cdn\/[^"' <>\s\\]+contentType=0[^"' <>\s\\]*/g
  ) ?? [];

  // Unescape HTML entities (&amp; -> &, &#x2F; -> /, etc.)
  const unescapeHtml = (s: string) =>
    s.replace(/&amp;/g, '&').replace(/&#x2F;/g, '/').replace(/&#47;/g, '/');

  const uniqueUrls = [...new Set(rawMatches.map(unescapeHtml))];
  console.log(`[AFFiNE Clipper] DrawIO URLs found in page HTML: ${uniqueUrls.length}`);
  uniqueUrls.forEach((u, i) => console.log(`  [${i}] ${u.substring(0, 100)}`));

  if (uniqueUrls.length === 0) return [];

  const results: string[] = [];
  for (const src of uniqueUrls) {
    console.log(`[AFFiNE Clipper]   fetching ${src.substring(0, 80)}...`);
    try {
      // 'same-origin': sends cookies on the initial km.sankuai.com request
      // (needed for auth), but NOT on the cross-origin redirect to it.meituan.net
      // (which uses a pre-signed URL — no cookies required there).
      // 'include' would cause CORS failure on the redirect because
      // it.meituan.net responds with ACAO:* which is incompatible with credentials.
      const res = await fetch(src, { credentials: 'same-origin' });
      console.log(`[AFFiNE Clipper]   -> status=${res.status}`);
      if (!res.ok) continue;
      const blob = await res.blob();
      results.push(await blobToDataUri(blob));
      console.log(`[AFFiNE Clipper]   captured ${blob.size}B`);
    } catch (err) {
      console.warn('[AFFiNE Clipper]   fetch error:', err);
    }
  }
  console.log(`[AFFiNE Clipper] DrawIO: ${results.length}/${uniqueUrls.length} captured`);
  return results;
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

    // DrawIO on km.sankuai.com: fetch directly from page HTML, independent of Readability
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
    return true;
  }
});
