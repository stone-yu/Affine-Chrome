import { Readability } from '@mozilla/readability';

export interface Article {
  title: string;
  content: string; // HTML string
  wordCount: number;
}

/**
 * Count "words" in a CJK-aware way.
 * Each CJK character (Chinese/Japanese/Korean) counts as one word.
 * Latin and other scripts use whitespace-separated token counting.
 */
function countWords(text: string): number {
  // \u4e00-\u9fff  CJK Unified Ideographs (main Chinese block)
  // \u3040-\u30ff  Hiragana + Katakana
  // \u3400-\u4dbf  CJK Extension A
  const CJK = /[\u4e00-\u9fff\u3040-\u30ff\u3400-\u4dbf]/g;
  const cjkCount = (text.match(CJK) ?? []).length;
  const latinCount = text.replace(CJK, ' ').trim().split(/\s+/).filter(Boolean).length;
  return cjkCount + latinCount;
}

/**
 * Pre-process a cloned document before handing it to Readability.
 * Only used on the Readability fallback path.
 */
function preProcessForReadability(doc: Document): void {
  doc.querySelectorAll('.ct-adaptive-tooltip-wrapper').forEach(el => el.remove());
  doc.querySelectorAll<HTMLElement>('div[style*="display: contents"], div[style*="display:contents"]')
    .forEach(div => {
      const parent = div.parentNode;
      if (!parent) return;
      while (div.firstChild) parent.insertBefore(div.firstChild, div);
      div.remove();
    });
  // Replace <blockquote> with <section data-was-blockquote="1"> so:
  //  • Readability never strips it
  //  • data-* attribute survives Readability._cleanClasses()
  //  • Turndown callout rule detects it and emits > prefix
  doc.querySelectorAll('blockquote').forEach(bq => {
    const section = doc.createElement('section');
    section.setAttribute('data-was-blockquote', '1');
    while (bq.firstChild) section.appendChild(bq.firstChild);
    bq.parentNode?.replaceChild(section, bq);
  });
}

/**
 * Extract the article content from a document.
 *
 * The `doc` argument is the *modifiedClone* from findAndPrepare — DrawIO and
 * other special nodes have already been replaced with affine-img:// placeholders,
 * so on Citadel/KM pages there is typically only ONE remaining ProseMirror
 * element (the main article editor).  We prefer it over Readability because
 * Readability's scoring / cleanup strips Citadel-specific blocks (blockquotes,
 * callouts, etc.) on complex wiki pages.
 *
 * Detection: any document that contains [data-node-id] attributes is treated
 * as a Citadel page.  Generic pages fall back to Readability.
 */
export function extractArticle(doc: Document): Article | null {
  // ── Citadel / KM path ────────────────────────────────────────────────────
  // data-node-id is a Citadel-specific attribute present on every block element.
  const isCitadel = doc.querySelector('[data-node-id]') !== null;

  if (isCitadel) {
    // In the modifiedClone, DrawIO inner editors are already replaced with
    // affine-img:// placeholders, so the *first* .ProseMirror is the main
    // article editor (there are no more nested ones to confuse the selector).
    const editor =
      doc.querySelector<HTMLElement>('.ProseMirror') ||
      doc.querySelector<HTMLElement>('.react-markdown-render');

    if (editor) {
      const titleEl =
        doc.querySelector<HTMLElement>('h1') ||
        doc.querySelector<HTMLElement>('[class*="page-title"]') ||
        doc.querySelector<HTMLElement>('title');
      const title = titleEl?.textContent?.trim() || doc.title || '';
      const content = editor.innerHTML;
      const wordCount = countWords(editor.textContent ?? '');
      console.log('[affine-clipper] Citadel path: extracted from .ProseMirror, words=', wordCount);
      return { title, content, wordCount };
    }
  }

  // ── Readability fallback ─────────────────────────────────────────────────
  const clone = doc.cloneNode(true) as Document;
  preProcessForReadability(clone);
  const reader = new Readability(clone);
  const article = reader.parse();
  if (!article) return null;
  return {
    title: article.title,
    content: article.content,
    wordCount: countWords(article.textContent),
  };
}
