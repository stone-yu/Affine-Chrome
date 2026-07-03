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
  // Citadel :::open_iframe (Mermaid) and :::html (HTML blocks).
  // These render as a container <div data-node-id="..."> with a direct <iframe> child.
  // We don't rely on data-node-type (which varies by Citadel version) — instead we
  // detect by CSS :has(> iframe) so the ENTIRE container (including loading-state UI
  // text like "Mermaid（内测）服务加载中...") is replaced with the placeholder,
  // preventing that text from leaking into the Markdown output.
  // Fallback selectors included for known data-node-type values.
  // Citadel :::html → <div class="pk-html"><iframe src="onejs.meituan.net/..."></iframe></div>
  // The container has no data-node-id — must use class name.
  { match: 'km.sankuai.com', selector: '.pk-html', kind: 'HtmlBlock', label: 'HTML 块' },
  // Citadel :::open_iframe (Mermaid / 3rd-party embeds).
  // Log shows: <div class="ct-node-view-dom" data-type="511H2i0612540259">
  // Citadel wraps ALL complex node views in ct-node-view-dom — including tables,
  // code blocks, and drawio.  Standard blocks have data-type="" (empty).
  // Plugin/embed blocks (Mermaid, etc.) have a non-empty plugin type ID in data-type.
  // Selector: require non-empty data-type to exclude tables and other standard blocks.
  {
    match: 'km.sankuai.com',
    selector: [
      'div.ct-node-view-dom[data-type]:not([data-type=""])',   // non-empty plugin type only
      '.pk-mermaid',                                           // possible future class
      '[data-node-type="open_iframe"]',                        // possible data attribute
    ].join(', '),
    kind: 'IFrame',
    label: 'Mermaid 图表',
  },
];

function getRulesForHost(hostname: string): NodeRule[] {
  return RULES.filter((r) => r.match === '*' || hostname.includes(r.match));
}

/**
 * Try to extract the raw HTML source from a Citadel pk-html block.
 * The content is passed to the iframe via postMessage; the original string lives
 * in the React fiber of the ProseMirror node component.
 *
 * Content scripts share the DOM with the page (React fiber is a DOM property),
 * but it may be non-enumerable — use Object.getOwnPropertyNames, not Object.keys.
 */
function extractHtmlSource(container: Element): string | null {
  // Primary: data attribute written by the main-world injected script in findAndPrepare.
  // This is the most reliable path since main-world JS can access React fiber.
  const encoded = container.getAttribute('data-affine-html-content');
  if (encoded) {
    container.removeAttribute('data-affine-html-content');
    const src = decodeURIComponent(encoded);
    console.log(`[affine-clipper] extractHtmlSource: found via main-world script, len=${src.length}`);
    return src;
  }

  // Fallback: isolated-world fiber access (may not work in Chrome; kept for other browsers).
  // React 16–18: fiber stored as __reactFiber$HASH or __reactInternalInstance$HASH
  try {
    const fiberKey = Object.getOwnPropertyNames(container).find(
      k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'),
    );
    if (fiberKey) {
      let fiber: any = (container as any)[fiberKey];
      for (let depth = 0; depth < 80 && fiber; depth++) {
        const props = fiber.memoizedProps;
        if (props) {
          // ProseMirror node attrs: the HTML source may be in node.attrs.html / node.content
          const node = props.node;
          if (node) {
            const src =
              node.attrs?.html ?? node.attrs?.content ?? node.attrs?.htmlContent ??
              (node.textContent && node.textContent.length > 20 ? node.textContent : null);
            if (typeof src === 'string' && src.includes('<')) {
              console.log(`[affine-clipper] extractHtmlSource: found via node.attrs depth=${depth} len=${src.length}`);
              return src;
            }
          }
          // Direct prop names used by Citadel/Quark HTML block component
          for (const key of ['html', 'htmlContent', 'content', 'initialHtml', 'src']) {
            const v = props[key];
            if (typeof v === 'string' && v.length > 20 && v.includes('<')) {
              console.log(`[affine-clipper] extractHtmlSource: found via props.${key} depth=${depth} len=${v.length}`);
              return v;
            }
          }
        }
        fiber = fiber.return;
      }
    }
  } catch (err) {
    console.warn('[affine-clipper] extractHtmlSource fiber error:', err);
  }
  console.warn('[affine-clipper] extractHtmlSource: could not find HTML source in React fiber');
  return null;
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
        // Don't add this element if it wraps something already in `seen`.
        // Example: a ct-node-view-dom wrapper around .pk-html must not shadow
        // the HtmlBlock job that was already created for the inner .pk-html.
        const wrapsSeenEl = Array.from(seen).some(s => el.contains(s));
        if (!wrapsSeenEl) {
          seen.add(el);
          found.push({ element: el, rule });
        }
      }
    });
  }

  // km.sankuai.com: detect Citadel iframe blocks (Mermaid :::open_iframe, HTML :::html).
  // CSS :has() selectors are unreliable when the <iframe> is a grandchild (not a direct
  // child).  Instead, find all iframes and walk up to the nearest [data-node-id] ancestor
  // (max 6 levels), which is the Citadel block root for the embed.
  if (hostname.includes('km.sankuai.com')) {
    doc.querySelectorAll<HTMLIFrameElement>('iframe').forEach((iframe) => {
      // Skip DrawIO-related iframes (those are handled separately).
      const iframeSrc = iframe.getAttribute('src') ?? '';
      if (iframeSrc.includes('contentType=0') || iframeSrc.includes('/api/file/cdn/')) return;

      // Walk up from the iframe to find the Citadel block container.
      // Stop at: [data-node-id] (generic Citadel block) OR known embed container classes.
      let container: Element | null = iframe.parentElement;
      for (let depth = 0; depth < 6 && container; depth++) {
        const cls = container.getAttribute('class') ?? '';
        const isHtmlBlock = cls.includes('pk-html');
        const isMermaid = cls.includes('pk-mermaid');
        if (container.hasAttribute('data-node-id') || isHtmlBlock || isMermaid) {
          if (!seen.has(container)) {
            // Skip if this container WRAPS an already-matched element (e.g. a parent div with
            // data-node-id that contains a .pk-html already added as HtmlBlock).  Adding the
            // parent would create a second job whose replaceWith() overwrites the first job's
            // carefully-placed <pre> with a broken affine-img:// placeholder.
            const containsSeenEl = Array.from(seen).some(el => container!.contains(el));
            if (!containsSeenEl) {
              seen.add(container);
              const kind = isHtmlBlock ? 'HtmlBlock' : 'IFrame';
              const label = isHtmlBlock ? 'HTML 块' : 'Mermaid 图表';
              found.push({ element: container, rule: { match: 'km.sankuai.com', selector: '', kind, label } });
              console.log(`[affine-clipper] iframe embed found: depth=${depth} kind="${kind}" src="${iframeSrc.substring(0, 60)}" container.class="${cls.substring(0, 60)}"`);
            }
          }
          break;
        }
        container = container.parentElement;
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

    // Print ALL SVG attributes so we can see their actual viewBox / size
    console.group('All SVG elements on page:');
    document.querySelectorAll('svg').forEach((svg, i) => {
      const r = svg.getBoundingClientRect();
      console.log(
        `  svg[${i}] viewBox="${svg.getAttribute('viewBox') ?? ''}"` +
        ` w=${svg.getAttribute('width') ?? ''} h=${svg.getAttribute('height') ?? ''}` +
        ` rendered=${r.width.toFixed(0)}×${r.height.toFixed(0)}` +
        ` class="${(svg.getAttribute('class') ?? '').substring(0, 40)}"`
      );
    });
    console.groupEnd();

    // Look inside the Citadel editor container for note/callout block structure
    console.group('Citadel editor direct children (note block detection):');
    // The real content is in the INNER ProseMirror (the outer one has layout wrappers).
    // '.ProseMirror .ProseMirror' selects the nested content div.
    const editorContent =
      document.querySelector('.ProseMirror .ProseMirror') ||
      document.querySelector('.ProseMirror') ||
      document.querySelector('.react-markdown-render');
    if (editorContent) {
      Array.from(editorContent.children).forEach((el, i) => {
        if (i > 30) return;
        const cls = (el.getAttribute('class') ?? '').substring(0, 100);
        const dataType = el.getAttribute('data-type') ?? el.getAttribute('data-node-type') ?? '';
        const preview = (el.textContent ?? '').trim().replace(/\s+/g, ' ').substring(0, 50);
        console.log(`  [${i}] <${el.tagName.toLowerCase()}> class="${cls}" data-type="${dataType}" text="${preview}"`);
      });
    } else {
      console.log('  editor container not found — dumping first 15 divs with class:');
      let count = 0;
      document.querySelectorAll('div[class]').forEach(el => {
        if (count++ > 15) return;
        const cls = el.getAttribute('class') ?? '';
        if (cls.includes('note') || cls.includes('callout') || cls.includes('info') || cls.includes('block')) {
          console.log(`  <div class="${cls.substring(0, 100)}"> text="${(el.textContent ?? '').trim().substring(0, 50)}"`);
        }
      });
    }
    console.groupEnd();

    // Check for iframes (DrawIO might be inside one)
    const iframes = document.querySelectorAll('iframe');
    console.log('iframes on page:', iframes.length);
    iframes.forEach((f, i) =>
      console.log(`  iframe[${i}] src="${(f.src ?? '').substring(0, 80)}" w=${f.offsetWidth} h=${f.offsetHeight}`)
    );

    // Check for canvas (DrawIO might render via canvas)
    const canvases = document.querySelectorAll('canvas');
    console.log('canvas elements:', canvases.length);
    canvases.forEach((c, i) => {
      const r = c.getBoundingClientRect();
      console.log(`  canvas[${i}] w=${c.width} h=${c.height} rendered=${r.width.toFixed(0)}×${r.height.toFixed(0)}`);
    });

    // Show ALL large elements (rendered > 300×100) — DrawIO should be among them
    console.group('Large elements (rendered w>300 h>100):');
    document.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 300 && r.height > 100) {
        const tag = el.tagName.toLowerCase();
        if (!['div', 'section', 'article', 'main', 'body', 'html', 'header', 'footer', 'nav', 'aside', 'ul', 'li', 'p', 'span', 'a', 'table', 'tbody', 'tr', 'td', 'th'].includes(tag)) {
          console.log(`  <${tag}> ${r.width.toFixed(0)}×${r.height.toFixed(0)} class="${(el.getAttribute('class') ?? '').substring(0, 50)}"`);
        }
      }
    });
    console.groupEnd();

    // Code block structure (to verify data-language attribute presence)
    console.group('PRE elements (code blocks):');
    document.querySelectorAll('pre').forEach((pre, i) => {
      if (i > 10) return;
      const lang = pre.getAttribute('data-language') ?? pre.getAttribute('data-lang') ?? '';
      const cls = (pre.getAttribute('class') ?? '').substring(0, 60);
      const hasCode = !!pre.querySelector('code');
      console.log(`  pre[${i}] data-language="${lang}" class="${cls}" hasCodeChild=${hasCode} textLen=${(pre.textContent ?? '').length}`);
    });
    console.groupEnd();

    // Iframe elements (for Mermaid open_iframe / HTML blocks)
    console.group('IFRAME elements inside .ProseMirror:');
    const proseMirrorEl = document.querySelector('.ProseMirror');
    (proseMirrorEl ?? document).querySelectorAll('iframe').forEach((f, i) => {
      const parent = f.parentElement;
      console.log(`  iframe[${i}] src="${(f.src ?? '').substring(0, 60)}" srcdoc=${f.hasAttribute('srcdoc')} ` +
        `parent.data-node-type="${parent?.getAttribute('data-node-type') ?? ''}" ` +
        `parent.class="${(parent?.getAttribute('class') ?? '').substring(0, 50)}"`);
    });
    console.groupEnd();

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

    // HTML blocks: extract raw HTML via React fiber and insert as a fenced code block.
    // This lets AFFiNE import the HTML code directly rather than showing an image.
    if (job.info.kind === 'HtmlBlock') {
      const htmlSource = extractHtmlSource(job.element);
      if (htmlSource) {
        const pre = modifiedClone.createElement('pre');
        pre.setAttribute('data-language', 'html');
        pre.textContent = htmlSource;
        cloneEl.replaceWith(pre);
        continue;
      }
      // React fiber extraction failed: remove the container so its loading-state
      // text ("Mermaid（内测）服务加载中..." etc.) doesn't leak into the output.
      // No image fallback — AFFiNE supports HTML content natively, so a broken
      // image placeholder would be worse than nothing.
      cloneEl.remove();
      continue;
    }

    const placeholder = modifiedClone.createElement('img');
    placeholder.setAttribute('src', `affine-img://${job.id}`);
    placeholder.setAttribute('alt', job.info.label);
    cloneEl.replaceWith(placeholder);
  }

  return { modifiedClone, jobs };
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
 * Convert a PlantUML image URL to its SVG variant.
 * KM/Citadel serves PlantUML diagrams at .../plantuml/{format}/{encoded}
 * where format can be png, jpg, txt, etc.  Replacing the format segment with
 * "svg" gives a lossless, full-quality SVG at the same encoded content.
 * Returns the original URL unchanged if it doesn't match the pattern.
 */
export function toPlantUmlSvgUrl(src: string): string {
  // Match: .../plantuml/<format>/<encoded>  (format = anything except '/')
  return src.replace(/\/plantuml\/[^/]+\//, '/plantuml/svg/');
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

/**
 * Wait for an iframe to finish loading (max 3 s), then attempt to access its
 * same-origin contentDocument.  Returns the document or null.
 */
async function getIframeDoc(iframe: HTMLIFrameElement): Promise<Document | null> {
  if (!iframe.contentDocument || iframe.contentDocument.readyState !== 'complete') {
    await new Promise<void>(resolve => {
      const onLoad = () => resolve();
      iframe.addEventListener('load', onLoad, { once: true });
      setTimeout(resolve, 5000);
    });
  }
  try { return iframe.contentDocument ?? null; } catch { return null; }
}

/**
 * Capture a Citadel Mermaid diagram by loading its same-origin preview URL in a
 * hidden off-screen iframe, waiting for mermaid.js to render the SVG, then
 * serialising the SVG to a data URI.
 *
 * URL pattern: https://km.sankuai.com/block/mermaid/{attachmentId}?openMode=preview&...
 * The page is same-origin so iframe.contentDocument is accessible.
 */
/** Extract SVG from an iframe.contentDocument (polls up to maxMs). */
async function extractSvgFromIframe(iframe: HTMLIFrameElement, maxMs = 5000): Promise<string | null> {
  const doc = await getIframeDoc(iframe);
  if (!doc) return null;
  const polls = Math.ceil(maxMs / 500);
  let svg: Element | null = null;
  for (let i = 0; i < polls && !svg; i++) {
    svg = doc.querySelector('svg');
    if (!svg) await new Promise(r => setTimeout(r, 500));
  }
  if (!svg) return null;
  try {
    const svgText = new XMLSerializer().serializeToString(svg);
    const b64 = btoa(unescape(encodeURIComponent(svgText)));
    return `data:image/svg+xml;base64,${b64}`;
  } catch { return null; }
}

async function captureMermaidBlock(attachmentId: string): Promise<string | null> {
  // Strategy 1: use the EXISTING rendered Mermaid iframe on the page.
  // The user can already see the diagram, so its iframe.contentDocument has the SVG.
  // Re-query the live DOM (job.element may be detached if React re-rendered the component).
  const liveContainer = document.querySelector<HTMLElement>(
    `div.ct-node-view-dom[data-attachment-id="${attachmentId}"],` +
    `div.ct-node-view-dom[data-affine-mermaid-id="${attachmentId}"]`,
  );
  let existingIframe = liveContainer?.querySelector<HTMLIFrameElement>('iframe');
  console.log(`[affine-clipper] captureMermaidBlock: liveContainer=${!!liveContainer} existingIframe=${!!existingIframe}`);

  // If the container exists but the iframe is missing, Citadel has lazy-unloaded it because
  // the block scrolled out of view (e.g. expandCitadelCodeBlocks moved the viewport).
  // Scroll back into view and wait for React to re-mount the iframe.
  if (liveContainer && !existingIframe) {
    liveContainer.scrollIntoView({ behavior: 'instant', block: 'center' });
    console.log(`[affine-clipper] captureMermaidBlock: scrolled into view, waiting for iframe…`);
    for (let i = 0; i < 10 && !existingIframe; i++) {
      await new Promise(r => setTimeout(r, 300));
      existingIframe = liveContainer.querySelector<HTMLIFrameElement>('iframe');
    }
    console.log(`[affine-clipper] captureMermaidBlock: after scroll, existingIframe=${!!existingIframe}`);
  }

  if (existingIframe) {
    console.log(`[affine-clipper] captureMermaidBlock: trying existing iframe src="${existingIframe.src.substring(0, 80)}"`);
    const dataUri = await extractSvgFromIframe(existingIframe, 5000);
    if (dataUri) {
      console.log(`[affine-clipper] captureMermaidBlock: captured from existing iframe`);
      return dataUri;
    }
    console.warn('[affine-clipper] captureMermaidBlock: no SVG in existing iframe, trying hidden iframe');
  }

  // Strategy 2: create a hidden same-origin iframe to render the Mermaid preview.
  // The Mermaid preview page needs several seconds for mermaid.js to render the SVG.
  const hostname = location.hostname;
  const url =
    `https://${hostname}/block/mermaid/${attachmentId}` +
    `?openMode=preview&openEmbed=citadel&openPlatform=pc&openCanAddDiscussion=0&lang=zh&isFirstLoad=1`;

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:800px;height:600px;visibility:hidden;';
  iframe.src = url;
  document.body.appendChild(iframe);
  console.log(`[affine-clipper] captureMermaidBlock: loading hidden iframe ${url.substring(0, 80)}`);

  try {
    const dataUri = await extractSvgFromIframe(iframe, 15000);  // 15 s for slow servers
    if (dataUri) {
      console.log(`[affine-clipper] captureMermaidBlock: captured from hidden iframe`);
      return dataUri;
    }
    console.warn('[affine-clipper] captureMermaidBlock: SVG not found after 15 s');
    return null;
  } finally {
    iframe.remove();
  }
}

/**
 * Capture the visual content of a container that holds a same-origin <iframe>
 * (Citadel open_iframe / html blocks).  Strategy:
 *  1. Extract SVG from iframe.contentDocument (good for Mermaid → lossless).
 *  2. html2canvas on iframe.contentDocument.body (good for HTML blocks).
 * Returns a data URI or null.
 */
async function captureIframeContainer(container: Element): Promise<string | null> {
  const iframe = container.querySelector('iframe') as HTMLIFrameElement | null;
  if (!iframe) return null;
  console.log(`[affine-clipper] captureIframeContainer: found iframe src="${iframe.src?.substring(0, 60)}" srcdoc=${iframe.hasAttribute('srcdoc')}`);

  const doc = await getIframeDoc(iframe);
  if (!doc) {
    console.warn('[affine-clipper] captureIframeContainer: could not access iframe document');
    return null;
  }

  // Strategy 1: serialize SVG if present (Mermaid renders as <svg>).
  // Mermaid rendering is async: the iframe loads first, then JS runs to produce
  // the SVG.  Poll up to 5 s (10 × 500 ms) to allow the diagram to appear.
  let svg: Element | null = null;
  for (let attempt = 0; attempt < 10 && !svg; attempt++) {
    svg = doc.querySelector('svg');
    if (!svg) await new Promise(r => setTimeout(r, 500));
  }
  if (svg) {
    try {
      const svgText = new XMLSerializer().serializeToString(svg);
      const b64 = btoa(unescape(encodeURIComponent(svgText)));
      console.log(`[affine-clipper] captureIframeContainer: captured SVG (${svgText.length}B)`);
      return `data:image/svg+xml;base64,${b64}`;
    } catch (err) {
      console.warn('[affine-clipper] captureIframeContainer SVG serialize error:', err);
    }
  }

  // No SVG found and html2canvas has been removed (it doesn't work reliably for
  // cross-origin iframes and added ~150 KiB to the bundle).  Return null so the
  // caller can fall through to the next strategy or skip.
  console.warn('[affine-clipper] captureIframeContainer: no SVG found in iframe');
  return null;
}

export async function captureAll(jobs: CaptureJob[]): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  for (const job of jobs) {
    try {
      // HtmlBlock: handled entirely in findAndPrepare (either converted to a fenced
      // html code block via React fiber extraction, or the container was removed).
      // Nothing to capture here — the iframe is cross-origin (onejs.meituan.net).
      if (job.info.kind === 'HtmlBlock') {
        console.log(`[affine-clipper] HtmlBlock ${job.id}: skipping capture (handled in findAndPrepare)`);
        continue;
      }

      // Citadel IFrame (Mermaid): try same-origin hidden-iframe approach first.
      if (job.info.kind === 'IFrame') {
        // Primary: captureMermaidBlock via attachmentId from main-world background script.
        let attachmentId = job.element.getAttribute('data-affine-mermaid-id') ?? '';
        console.log(`[affine-clipper] IFrame ${job.id}: data-affine-mermaid-id="${attachmentId}"`);

        // Fallback A: scan existing iframes inside the container for a Mermaid URL.
        // Citadel may have already created the iframe (e.g. if block was visible on screen).
        if (!attachmentId) {
          const existingIframe = job.element.querySelector<HTMLIFrameElement>('iframe[src*="/block/mermaid/"]');
          if (existingIframe?.src) {
            const m = existingIframe.src.match(/\/block\/mermaid\/(\d+)/);
            if (m) { attachmentId = m[1]; console.log(`[affine-clipper] IFrame ${job.id}: found existing Mermaid iframe, id=${attachmentId}`); }
          }
        }

        if (attachmentId) {
          const dataUri = await captureMermaidBlock(attachmentId);
          if (dataUri) { results.set(job.id, dataUri); continue; }
        }

        // Fallback B: generic iframe content access (SVG extraction from same-origin iframe).
        const dataUri = await captureIframeContainer(job.element);
        if (dataUri) {
          results.set(job.id, dataUri);
          continue;
        }
        console.warn(`[affine-clipper] Skipping ${job.id} (${job.info.kind}): Mermaid capture failed (attachmentId="${attachmentId}")`);
        continue;
      }

      // DrawIO / PlantUML images are fetched via HTTP — no need to wait for DOM
      // rendering. Virtual scrolling often removes these from the DOM after detection,
      // and direct URL fetch gives the full-resolution SVG.
      if ((job.info.kind === 'DrawIO' || job.info.kind === 'PlantUML') && job.element.tagName === 'IMG') {
        // For PlantUML: prefer the SVG variant (lossless, full quality) by rewriting
        // the format segment in the URL before fetching.
        if (job.info.kind === 'PlantUML') {
          const img = job.element as HTMLImageElement;
          const rawSrc = img.src || img.dataset.src || img.getAttribute('data-src') || '';
          const svgSrc = toPlantUmlSvgUrl(rawSrc);
          if (svgSrc !== rawSrc) {
            try {
              const res = await fetch(svgSrc, { credentials: 'include' });
              if (res.ok) {
                const blob = await res.blob();
                results.set(job.id, await blobToDataUri(blob));
                console.log(`[affine-clipper] PlantUML SVG captured (${blob.size}B)`);
                continue;
              }
            } catch (_) { /* fall through to PNG fetch below */ }
          }
        }

        const dataUri = await captureAuthSvgImg(job.element);
        if (dataUri) {
          results.set(job.id, dataUri);
          continue;
        }
        // Fall through to SVG serialisation if fetch failed
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

      // No other capture strategy available — skip.
      // html2canvas has been removed (added ~150 KiB; RULES selectors target SVG/IMG/IFrame
      // which are all handled before this point).
      console.warn(`[affine-clipper] Skipping ${job.id} (${job.info.kind}): no capture strategy matched`);
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
      if (!dataUri) return line; // keep placeholder so position is not lost
      return line.replace(`affine-img://${id}`, dataUri);
    })
    .join('\n');
}
