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
   *  Insert image AFTER the paragraph containing this text. null = try nextMarker. */
  marker: string | null;
  /** Following text (up to 80 chars) from a sibling/parent element.
   *  Insert image BEFORE the paragraph containing this text (fallback when marker fails). */
  nextMarker: string | null;
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
  const domRefs: { url: string; marker: string | null; nextMarker: string | null }[] = [];
  const seenA = new Set<string>();
  document.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.value.includes('/api/file/cdn/') && attr.value.includes('contentType=0')) {
        const url = unescapeHtml(attr.value.split(/["' <>\\]/)[0]);
        if (seenA.has(url)) break;
        seenA.add(url);

        // Walk up the DOM to find position markers.
        // Prefer heading elements (h1–h6) as the preceding marker because they
        // are always present in the ProseMirror-extracted Markdown and their text
        // matches reliably.  Other sibling text is used only as a last resort.
        let marker: string | null = null;
        let markerIsHeading = false;
        let nextMarker: string | null = null;
        let node: Element | null = el;
        for (let depth = 0; depth < 12 && node; depth++, node = node.parentElement) {
          let prev = node.previousElementSibling;
          while (prev) {
            const heading = /^H[1-6]$/.test(prev.tagName);
            const txt = (prev.textContent ?? '').trim().replace(/\s+/g, ' ');
            if (heading && txt.length > 2) {
              marker = txt.substring(0, 80);
              markerIsHeading = true;
              break; // headings are the best possible anchor — stop immediately
            }
            if (!markerIsHeading && txt.length > 4) {
              marker = txt.substring(0, 80); // keep as fallback, keep scanning
            }
            prev = prev.previousElementSibling;
          }
          if (!nextMarker) {
            let next = node.nextElementSibling;
            while (next) {
              const txt = (next.textContent ?? '').trim().replace(/\s+/g, ' ');
              if (txt.length > 4) { nextMarker = txt.substring(0, 80); break; }
              next = next.nextElementSibling;
            }
          }
          if (markerIsHeading && nextMarker) break; // found best anchors — done
        }
        domRefs.push({ url, marker, nextMarker });
        break;
      }
    }
  });
  console.log(`[AFFiNE Clipper] DrawIO from DOM attrs: ${domRefs.length}`);
  domRefs.forEach((r, i) => console.log(`  [${i}] marker="${r.marker}" nextMarker="${r.nextMarker}" url=${r.url.substring(0, 80)}`));

  // ── Strategy B: raw HTML scan (fallback) ─────────────────────────────────
  const rawMatches = (document.documentElement.innerHTML.match(
    /https?:\/\/km\.sankuai\.com\/api\/file\/cdn\/[^"' <>\s\\]+contentType=0[^"' <>\s\\]*/g
  ) ?? []).map(unescapeHtml);
  const uniqueFromHtml = [...new Set(rawMatches)].filter(u => !seenA.has(u));
  console.log(`[AFFiNE Clipper] DrawIO from HTML scan: ${uniqueFromHtml.length} extra`);

  // Merge: DOM refs first (have position info), then HTML-only extras
  const allRefs = [
    ...domRefs,
    ...uniqueFromHtml.map(url => ({ url, marker: null, nextMarker: null })),
  ];
  if (allRefs.length === 0) return [];

  // ── Fetch each SVG ────────────────────────────────────────────────────────
  const results: DrawioCapture[] = [];
  for (const { url, marker, nextMarker } of allRefs) {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      console.log(`[AFFiNE Clipper]   status=${res.status} for ${url.substring(0, 60)}`);
      if (!res.ok) continue;
      const blob = await res.blob();
      const svgText = await blob.text();
      // Strip the `content` attribute (mxGraph XML metadata, ~34KB/SVG) — not
      // needed for rendering and significantly reduces the payload sent to AFFiNE.
      const stripped = svgText.replace(/\s+content="[^"]*"/g, '');
      const strippedBlob = new Blob([stripped], { type: 'image/svg+xml' });
      results.push({ dataUri: await blobToDataUri(strippedBlob), marker, nextMarker });
      console.log(`[AFFiNE Clipper]   captured ${blob.size}B -> ${strippedBlob.size}B (stripped), marker="${marker}"`);
    } catch (err) {
      console.warn('[AFFiNE Clipper]   fetch error:', err);
    }
  }
  console.log(`[AFFiNE Clipper] DrawIO: ${results.length}/${allRefs.length} captured`);
  return results;
}

/**
 * Insert DrawIO images at approximately the right positions in the Markdown.
 *
 * Priority:
 *  1. Replace any remaining `affine-img://node-N` placeholders in order — these
 *     were placed at the correct position by findAndPrepare but captureAll failed.
 *  2. Find preceding-text marker (text before the DrawIO in DOM), insert after it.
 *  3. Find following-text marker (text after the DrawIO in DOM), insert before it.
 *  4. Append at end behind a HR separator as last resort.
 */
function insertDrawioImages(markdown: string, captures: DrawioCapture[]): string {
  let result = markdown;

  // Pass 1: replace remaining affine-img:// placeholders in document order.
  // These are images whose main-flow fetch failed; the placeholder is already at
  // the correct position so we just need to fill in the data URI.
  const queue = [...captures];
  result = result.replace(
    /!\[.*?\]\(affine-img:\/\/node-\d+\)/g,
    () => {
      if (queue.length === 0) return ''; // no capture available → leave blank
      const { dataUri } = queue.shift()!;
      return `![DrawIO 图表](${dataUri})`;
    }
  );

  // Pass 2: remaining captures have no placeholder — use text markers.
  const unpositioned: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const { dataUri, marker, nextMarker } = queue[i];
    const imgMd = `![DrawIO 图表 ${i + 1}](${dataUri})`;
    let inserted = false;

    // Strategy A: preceding-text marker → insert image AFTER that paragraph
    if (marker && !inserted) {
      const key = marker.substring(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(key, 'i');
      const match = re.exec(result);
      if (match) {
        const lineEnd = result.indexOf('\n\n', match.index);
        const insertAt = lineEnd === -1 ? result.length : lineEnd;
        result = result.slice(0, insertAt) + '\n\n' + imgMd + result.slice(insertAt);
        inserted = true;
      }
    }

    // Strategy B: following-text marker → insert image BEFORE that paragraph
    if (nextMarker && !inserted) {
      const key = nextMarker.substring(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(key, 'i');
      const match = re.exec(result);
      if (match) {
        const paraStart = result.lastIndexOf('\n\n', match.index);
        const insertAt = paraStart === -1 ? 0 : paraStart;
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

/**
 * Scan the extracted ProseMirror HTML for any remaining DrawIO CDN images that
 * findAndPrepare might have missed (e.g. virtual-scrolled elements whose CDN URL
 * lives in a data-* attribute rather than in an <img src>).
 *
 * For each found URL, replace the element in-place with
 * <img src="affine-drawio://N" alt="DrawIO 图表"> so that Turndown emits
 * ![DrawIO 图表](affine-drawio://N) at the *exact* correct position.
 *
 * Returns the modified HTML and a map of index → CDN URL for later async fetch.
 */
function injectDrawioPlaceholders(
  html: string,
  hostname: string,
): { html: string; urlMap: Map<number, string> } {
  const urlMap = new Map<number, string>();
  if (!hostname.includes('km.sankuai.com')) return { html, urlMap };

  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  const seen = new Set<string>();
  let idx = 0;

  tmp.querySelectorAll('*').forEach((el) => {
    // Skip elements that are already affine-img:// or affine-drawio:// placeholders
    if (el.tagName === 'IMG') {
      const src = (el as HTMLImageElement).getAttribute('src') ?? '';
      if (src.startsWith('affine-img://') || src.startsWith('affine-drawio://')) return;
    }
    for (const attr of Array.from(el.attributes)) {
      if (attr.value.includes('/api/file/cdn/') && attr.value.includes('contentType=0')) {
        const url = attr.value.split(/["' <>\\]/)[0]
          .replace(/&amp;/g, '&').replace(/&#x2F;/g, '/').replace(/&#47;/g, '/');
        if (seen.has(url)) break;
        seen.add(url);
        const placeholder = document.createElement('img');
        placeholder.setAttribute('src', `affine-drawio://${idx}`);
        placeholder.setAttribute('alt', 'DrawIO 图表');
        urlMap.set(idx++, url);
        el.replaceWith(placeholder);
        break;
      }
    }
  });

  return { html: tmp.innerHTML, urlMap };
}

interface MainWorldData {
  codeBlocks: { lang: string; code: string }[];
  htmlBlocks: { html: string }[];
  mermaidBlocks: { attachmentId: string }[];
}

/** Ask the background service worker to run a script in the page's MAIN world. */
async function fetchMainWorldData(): Promise<MainWorldData> {
  const empty: MainWorldData = { codeBlocks: [], htmlBlocks: [], mermaidBlocks: [] };
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type: 'EXTRACT_MAIN_WORLD' }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[affine-clipper] EXTRACT_MAIN_WORLD error:', chrome.runtime.lastError.message);
          resolve(empty);
          return;
        }
        const d = response?.data as MainWorldData | null;
        console.log(`[affine-clipper] main-world data: codeBlocks=${d?.codeBlocks?.length ?? 0} htmlBlocks=${d?.htmlBlocks?.length ?? 0} mermaidBlocks=${d?.mermaidBlocks?.length ?? 0}`);
        resolve(d ?? empty);
      });
    } catch (err) {
      console.warn('[affine-clipper] fetchMainWorldData: sendMessage threw:', err);
      resolve(empty);
    }
  });
}

/**
 * Click the expand toggle on all collapsed Citadel code blocks so CodeMirror
 * renders all lines into the DOM.  Falls back to background/API path if needed.
 * Must run BEFORE findAndPrepare / clone is made.
 */
async function expandCitadelCodeBlocks(): Promise<void> {
  const blocks = Array.from(document.querySelectorAll<HTMLElement>('div.pk-code'));
  if (blocks.length === 0) return;
  let triggered = 0;

  for (const block of blocks) {
    // Strategy A: click the header toggle (first non-<pre> child).
    const toggle = Array.from(block.children)
      .find(el => el.tagName !== 'PRE') as HTMLElement | undefined;
    if (toggle) { toggle.click(); triggered++; }

    // Strategy B: make the CodeMirror scroll container very tall so its virtualiser
    // renders ALL lines (not just the ~11 visible in the collapsed viewport).
    // CodeMirror recalculates visible lines when the container height changes.
    const scroller = block.querySelector<HTMLElement>('.CodeMirror-scroll');
    if (scroller) {
      scroller.style.setProperty('max-height', '20000px', 'important');
      scroller.style.setProperty('height', 'auto', 'important');
      triggered++;
    }
  }

  if (triggered > 0) {
    console.log(`[affine-clipper] expandCitadelCodeBlocks: triggered=${triggered}, waiting for re-render…`);
    // Notify CodeMirror that the container size changed so it re-renders all lines.
    window.dispatchEvent(new Event('resize'));
    await new Promise(resolve => setTimeout(resolve, 800));
  }
}

/**
 * Normalize Citadel code blocks to standard <pre data-language="...">code</pre>
 * before Turndown processes them.
 *
 * Citadel renders :::code_block as a container div with several children:
 *   1. A language header div (e.g. "SQL")
 *   2. A collapsed-preview div showing the LAST line (visible when isExpand=false)
 *   3. A <pre> or <code> element with the FULL code (may have hidden/extra elements)
 *
 * Without normalization:
 *   - The language header leaks as a separate paragraph ("SQL")
 *   - The collapsed-preview last line appears BEFORE the actual code
 *   - Turndown escapes backticks/underscores inside divs (\` \_ \=)
 *
 * After normalization, the citadel-code Turndown rule produces a clean fenced block.
 */
function normalizeCodeBlocks(html: string, mainWorldData: MainWorldData = { codeBlocks: [], htmlBlocks: [], mermaidBlocks: [] }): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  // Selector for known Citadel code block container patterns.
  // pk-code: Citadel renders :::code_block as <div class="pk-code"> with CodeMirror inside.
  const containers = Array.from(tmp.querySelectorAll(
    'div.pk-code, [data-node-type="code_block"], div[class*="ct-code"], div[class*="code-block"]',
  )).filter(el => el.tagName !== 'PRE'); // skip if already a <pre>

  // Use main-world data (from background scripting API) for pk-code containers.
  // These have the FULL code from React fiber, bypassing CodeMirror virtual scrolling.
  const pkCodeContainers = containers.filter(el => (el.getAttribute('class') ?? '').includes('pk-code'));
  pkCodeContainers.forEach((container, i) => {
    const data = mainWorldData.codeBlocks[i];
    if (!data) return;
    const newPre = tmp.ownerDocument.createElement('pre');
    newPre.setAttribute('data-language', data.lang);
    newPre.textContent = data.code.trimEnd();
    console.log(`[affine-clipper] normalizeCodeBlocks: bg main-world lang="${data.lang}" codeLen=${data.code.length}`);
    container.replaceWith(newPre);
  });

  // Re-query containers (some pk-code ones were just replaced).
  const remaining = Array.from(tmp.querySelectorAll(
    'div.pk-code, [data-node-type="code_block"], div[class*="ct-code"], div[class*="code-block"]',
  )).filter(el => el.tagName !== 'PRE');

  for (const container of remaining) {
    // DOM data attribute path (set by background chrome.scripting.executeScript).
    const encodedContent = container.getAttribute('data-affine-code-content');
    if (encodedContent) {
      const code = decodeURIComponent(encodedContent).trimEnd();
      const lang = (container.getAttribute('data-affine-code-lang') ?? '').toLowerCase();
      const newPre = tmp.ownerDocument.createElement('pre');
      newPre.setAttribute('data-language', lang);
      newPre.textContent = code;
      container.replaceWith(newPre);
      continue;
    }

    // Fallback: DOM-based extraction (for when main-world script did not run or failed).
    //
    // Citadel renders div.pk-code with a CodeMirror editor inside.  Structure:
    //   <div class="pk-code">
    //     <pre class="CodeMirror-line-like">SQL</pre>   ← language label (not code)
    //     <pre class="CodeMirror-line">..last line..</pre>  ← collapsed-preview (DUPLICATE)
    //     <pre class=" CodeMirror-line ">CREATE TABLE...</pre>  ← line 1 (note leading space)
    //     <pre class=" CodeMirror-line ">  `id`...</pre>        ← line 2
    //     ...one <pre> per code line...
    //   </div>
    //
    // Key observations from DevTools:
    //   • "CodeMirror-line-like"  → language header or fold indicator — NOT a code line
    //   • "CodeMirror-line" (exact, no spaces) → the collapsed-preview showing the LAST line
    //   • " CodeMirror-line " (with leading/trailing space) → actual code lines in order

    // Language: look for programming language names in non-PRE children.
    // "CodeMirror-line-like" pre may contain garbage like "xxxxxxxxxx" (a sizing element),
    // so we look for tokens that look like real language names:
    //   - Starts with a letter, contains only [A-Za-z0-9+#._-]
    //   - Has ≥ 2 DISTINCT characters (rules out "xxxxxxxxxx", "aaaaaa")
    //   - Not "代码块" or other Chinese UI labels
    function looksLikeLang(token: string): boolean {
      return /^[A-Za-z][A-Za-z0-9+#._-]{0,18}$/.test(token)
        && new Set(token.toLowerCase()).size >= 2;
    }
    let lang = container.getAttribute('data-language') ?? '';
    if (!lang) {
      // Use match() to extract Latin tokens even when embedded in Chinese text (e.g. "代码块SQL").
      // Only check the header area (first few non-code-line children) to avoid picking up
      // SQL keywords like "DEFAULT", "NOT", "NULL" from the actual code lines.
      const headerChildren = Array.from(container.children).slice(0, 3);
      outer: for (const child of headerChildren) {
        const tokens = (child.textContent ?? '').match(/[A-Za-z][A-Za-z0-9+#._-]*/g) ?? [];
        for (const token of tokens) {
          if (looksLikeLang(token)) { lang = token; break outer; }
        }
      }
    }

    // Code lines: all <pre class="*CodeMirror-line*"> EXCLUDING the "line-like" header
    // and the collapsed-preview duplicate.  The preview has class="CodeMirror-line" (no
    // surrounding spaces) while real lines have class=" CodeMirror-line " (with spaces).
    // We distinguish them by checking the raw class attribute value for leading/trailing space.
    let code = '';
    const cmLines = Array.from(container.querySelectorAll('pre[class*="CodeMirror-line"]'))
      .filter(p => {
        const cls = p.getAttribute('class') ?? '';
        return !cls.includes('CodeMirror-line-like');  // skip language header
      });

    if (cmLines.length > 0) {
      // Real code lines have a leading space in the class attribute value (" CodeMirror-line ").
      // The collapsed-preview line has the exact class "CodeMirror-line" (no surrounding spaces).
      const realLines = cmLines.filter(p => (p.getAttribute('class') ?? '').startsWith(' '));
      const lines = (realLines.length > 0 ? realLines : cmLines).map(p => p.textContent ?? '');
      code = lines.join('\n').trimEnd();
    }

    // Generic fallback: <pre>/<code> element (non-CodeMirror code blocks).
    if (!code) {
      const PREVIEW_PATTERN = /preview|collapse|fold|peek|summary/i;
      const allPres = Array.from(container.querySelectorAll('pre'));
      const preEl = allPres
        .filter(p => !PREVIEW_PATTERN.test(p.getAttribute('class') ?? ''))
        .reduce<HTMLPreElement | null>((best, el) => {
          const len = (el.textContent ?? '').length;
          return !best || len > (best.textContent ?? '').length ? el as HTMLPreElement : best;
        }, null);
      const codeEl = preEl?.querySelector('code') ?? container.querySelector('code:not(pre *)');
      code = (codeEl?.textContent ?? preEl?.textContent ?? '').trimEnd();
    }

    // Last resort: cm-line divs (CodeMirror v6 style).
    if (!code) {
      const lines = Array.from(container.querySelectorAll('[class*="cm-line"], [class*="code-line"]'));
      if (lines.length > 0) code = lines.map(l => l.textContent ?? '').join('\n').trimEnd();
    }

    if (!code) {
      console.warn('[affine-clipper] normalizeCodeBlocks: no code found in', container.tagName, (container.getAttribute('class') ?? '').substring(0, 60));
      continue;
    }

    console.log(`[affine-clipper] normalizeCodeBlocks: lang="${lang}" codeLen=${code.length}`);
    const newPre = tmp.ownerDocument.createElement('pre');
    newPre.setAttribute('data-language', lang.toLowerCase());
    newPre.textContent = code;
    container.replaceWith(newPre);
  }

  return tmp.innerHTML;
}

async function performExtraction(): Promise<ExtractResult | ExtractError> {
  try {
    const hostname = location.hostname;

    // Expand collapsed Citadel code blocks so CodeMirror renders ALL lines into the DOM.
    // isExpand=false causes virtual scrolling to only show ~11 visible lines; clicking the
    // toggle header forces React to expand and render the full content.
    if (hostname.includes('km.sankuai.com')) await expandCitadelCodeBlocks();

    // Fetch data from the page's MAIN world via the background service worker.
    // This bypasses both the isolated-world restriction AND the page's CSP.
    // Runs before findAndPrepare so HTML block data is available for the clone step.
    const mainWorldData = hostname.includes('km.sankuai.com')
      ? await fetchMainWorldData()
      : { codeBlocks: [], htmlBlocks: [], mermaidBlocks: [] };

    // Write HTML block source into data attributes on live DOM elements so that
    // findAndPrepare / extractHtmlSource can read them.
    if (mainWorldData.htmlBlocks.length > 0) {
      const pkHtmlEls = Array.from(document.querySelectorAll('.pk-html'));
      mainWorldData.htmlBlocks.forEach((block, i) => {
        pkHtmlEls[i]?.setAttribute('data-affine-html-content', encodeURIComponent(block.html));
      });
    }

    // Write Mermaid attachmentIds into data attributes so captureAll can
    // construct the km.sankuai.com/block/mermaid/{id} same-origin URL.
    if (mainWorldData.mermaidBlocks.length > 0) {
      const mermaidEls = Array.from(document.querySelectorAll(
        'div.ct-node-view-dom[data-type]:not([data-type=""])',
      ));
      mainWorldData.mermaidBlocks.forEach((block, i) => {
        mermaidEls[i]?.setAttribute('data-affine-mermaid-id', block.attachmentId);
      });
      console.log(`[affine-clipper] mermaid blocks annotated (bg): ${mainWorldData.mermaidBlocks.length}`);
    }

    // DOM-based Mermaid discovery: read data-attachment-id directly from the element
    // (Citadel sets this attribute: <div class="ct-node-view-dom" data-attachment-id="...">)
    // or fall back to reading the already-created iframe's src URL.
    if (hostname.includes('km.sankuai.com')) {
      const mermaidContainers = Array.from(document.querySelectorAll<HTMLElement>(
        'div.ct-node-view-dom[data-type]:not([data-type=""])',
      )).filter(el => !el.getAttribute('data-affine-mermaid-id'));

      let scrollNeeded = false;
      for (const container of mermaidContainers) {
        // Priority 1: data-attachment-id directly on the element (most reliable)
        const directId = container.getAttribute('data-attachment-id');
        if (directId) {
          container.setAttribute('data-affine-mermaid-id', directId);
          // Scroll into view so Citadel mounts the iframe (it lazy-unmounts when off-screen).
          // Without this, expandCitadelCodeBlocks may have scrolled the block out of view.
          container.scrollIntoView({ behavior: 'instant', block: 'center' });
          await new Promise(r => setTimeout(r, 600));
          console.log(`[affine-clipper] mermaid annotated (data-attachment-id): id=${directId} iframe=${!!container.querySelector('iframe')}`);
          continue;
        }
        // Priority 2: existing iframe src already in DOM
        const iframe = container.querySelector<HTMLIFrameElement>('iframe[src*="/block/mermaid/"]');
        if (iframe?.src) {
          const m = iframe.src.match(/\/block\/mermaid\/(\d+)/);
          if (m) {
            container.setAttribute('data-affine-mermaid-id', m[1]);
            console.log(`[affine-clipper] mermaid annotated (iframe src): id=${m[1]}`);
            continue;
          }
        }
        // Priority 3: scroll into view to trigger lazy iframe creation
        scrollNeeded = true;
        container.scrollIntoView({ behavior: 'instant', block: 'center' });
        await new Promise(r => setTimeout(r, 1000));
        const lazyIframe = container.querySelector<HTMLIFrameElement>('iframe[src*="/block/mermaid/"]');
        if (lazyIframe?.src) {
          const m = lazyIframe.src.match(/\/block\/mermaid\/(\d+)/);
          if (m) {
            container.setAttribute('data-affine-mermaid-id', m[1]);
            console.log(`[affine-clipper] mermaid annotated (scroll trigger): id=${m[1]}`);
          } else {
            console.warn(`[affine-clipper] mermaid: iframe found but no id in src="${lazyIframe.src.substring(0, 80)}"`);
          }
        } else {
          console.warn(`[affine-clipper] mermaid: no iframe after scroll, data-type="${container.getAttribute('data-type')}"`);
        }
      }
      if (scrollNeeded) window.scrollTo({ top: 0, behavior: 'instant' });
    }

    const { modifiedClone, jobs } = findAndPrepare(document);

    const article = extractArticle(modifiedClone);
    if (!article) {
      return { type: 'EXTRACT_ERROR', message: 'Could not extract article content from this page.' };
    }

    // Inject affine-drawio:// placeholders for any DrawIO CDN images that
    // findAndPrepare missed (e.g. virtual-scrolled elements).  The placeholder
    // is at the EXACT correct position in the HTML — no marker matching needed.
    const { html: enrichedHtml, urlMap: drawioUrlMap } =
      injectDrawioPlaceholders(article.content, hostname);

    // Normalize Citadel code blocks BEFORE Turndown — converts complex containers
    // (with language headers and collapsed-preview elements) into plain <pre data-language>.
    const normalizedHtml = normalizeCodeBlocks(enrichedHtml, mainWorldData);

    const markdown = toMarkdown(normalizedHtml);
    const images = await captureAll(jobs);
    let finalMarkdown = substituteImages(markdown, images);

    // Fetch each affine-drawio:// CDN URL and replace the placeholder in-place.
    const extraNodes: import('../types').SpecialNodeInfo[] = [];
    for (const [idx, url] of drawioUrlMap) {
      const placeholder = `affine-drawio://${idx}`;
      if (!finalMarkdown.includes(placeholder)) continue;
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (res.ok) {
          const blob = await res.blob();
          // Strip the large `content` attribute from mxGraph SVGs (same as captureDrawioDirectly).
          const svgText = await blob.text();
          const stripped = svgText.replace(/\s+content="[^"]*"/g, '');
          const strippedBlob = new Blob([stripped], { type: blob.type });
          const dataUri = await blobToDataUri(strippedBlob);
          finalMarkdown = finalMarkdown.split(`![DrawIO 图表](${placeholder})`).join(`![DrawIO 图表](${dataUri})`);
          extraNodes.push({ label: `DrawIO 图表 ${idx + 1}`, kind: 'DrawIO' });
        }
      } catch (_) { /* leave placeholder; it will be stripped below */ }
      // Remove any unresolved placeholder lines so AFFiNE doesn't see broken refs.
      finalMarkdown = finalMarkdown.replace(
        new RegExp(`!\\[DrawIO 图表\\]\\(affine-drawio://${idx}\\)\\n?`, 'g'), '',
      );
    }

    return {
      type: 'EXTRACT_RESULT',
      title: article.title || document.title,
      markdown: finalMarkdown,
      wordCount: article.wordCount,
      specialNodes: [...jobs.map((j) => j.info), ...extraNodes],
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
