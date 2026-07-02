import TurndownService from 'turndown';
import { strikethrough, taskListItems } from 'turndown-plugin-gfm';

const td = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

td.use(strikethrough);
td.use(taskListItems);

// ── Underline ──────────────────────────────────────────────────────────────
// Citadel uses __..__ for underline (not bold), which renders as <u>.
// Standard Markdown has no underline; we emit inline HTML <u>...</u> since
// AFFiNE's Markdown importer handles it.
td.addRule('underline', {
  filter: (node: HTMLElement) => {
    if (node.nodeName === 'U') return true;
    const td_ = node.style?.textDecoration ?? '';
    return (td_.includes('underline') && ['SPAN', 'A', 'LABEL'].includes(node.nodeName));
  },
  replacement: (content: string) => (content ? `<u>${content}</u>` : ''),
});

// ── Citadel code blocks ────────────────────────────────────────────────────
// Citadel ProseMirror renders code_block as <pre data-language="SQL">.
// Turndown's built-in fenced-code rule requires a <code> child (isFenced),
// so a bare <pre data-language="..."> falls through to plain text.
// This rule catches both patterns: with or without a <code> child.
td.addRule('citadel-code', {
  filter: (node: HTMLElement) => node.nodeName === 'PRE' && node.hasAttribute('data-language'),
  replacement: (_content: string, node: HTMLElement) => {
    const lang = (node.getAttribute('data-language') ?? '').toLowerCase();
    const codeEl = node.querySelector('code');
    const code = (codeEl?.textContent ?? node.textContent ?? '').trimEnd();
    return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
  },
});

// ── Bold: always use HTML <b> tags instead of **...**  ────────────────────
// GFM **..** fails when bold content starts/ends with Unicode punctuation
// (e.g. curly quotes "text"): CommonMark left-flanking delimiter rules
// require the ** to be preceded by whitespace/punctuation, which Chinese
// text like 定位为** doesn't satisfy.  <b> is unambiguous for all parsers.
td.addRule('strong', {
  filter: ['strong', 'b'],
  replacement: (content: string) => (content.trim() ? `<b>${content.trim()}</b>` : ''),
});

// ── CSS bold (font-weight without <strong>/<b>) ────────────────────────────
td.addRule('css-bold', {
  filter: (node: HTMLElement) => {
    const INLINE = new Set(['SPAN', 'A', 'LABEL', 'CITE', 'DFN', 'ABBR', 'MARK']);
    if (!INLINE.has(node.nodeName)) return false;
    const fw = node.style?.fontWeight ?? '';
    return fw === 'bold' || fw === '700' || fw === '600';
  },
  replacement: (content: string) => (content.trim() ? `<b>${content.trim()}</b>` : ''),
});

// ── Blockquote / Callout replacement helper ────────────────────────────────
// AFFiNE's Markdown importer cannot handle `> - item` (list items inside a
// blockquote).  When the content contains list items, output it as-is so
// AFFiNE imports each item as a proper list block.  When there are no list
// items, keep the standard `> ` prefix so the quote formatting is preserved.
function blockquoteReplacement(content: string): string {
  const trimmed = content.trim();
  // Detect any Markdown list line: "- ", "* ", "+ ", or "1. " etc.
  const hasListItems = /^[ \t]*(?:[-*+]|\d+\.)\s/m.test(trimmed);
  if (hasListItems) {
    return '\n\n' + trimmed + '\n\n';
  }
  const lines = trimmed.split('\n').map(l => `> ${l}`).join('\n');
  return '\n\n' + lines + '\n\n';
}

// ── Callout / Note blocks (Citadel :::note{type=info}:::) ─────────────────
// Citadel renders note/callout blocks as a div whose class or data attributes
// indicate a "note", "callout", "tip", "warning", "info", or "alert" role.
// We convert them to Markdown blockquote (> ...).
td.addRule('callout', {
  filter: (node: HTMLElement) => {
    if (!['DIV', 'SECTION', 'ASIDE'].includes(node.nodeName)) return false;
    // data-was-blockquote is set by extractor.ts preprocessing on Citadel <blockquote>
    // elements that were converted to <section> to survive Readability's cleanup pass.
    if (node.getAttribute('data-was-blockquote') === '1') return true;
    const cls = (node.getAttribute('class') ?? '').toLowerCase();
    const dataType = (node.getAttribute('data-type') ?? node.getAttribute('data-node-type') ?? '').toLowerCase();
    const role = (node.getAttribute('role') ?? '').toLowerCase();
    const keywords = ['note', 'callout', 'tip', 'warning', 'info', 'alert', 'notice', 'hint', 'quark', 'quote', 'blockquote'];
    // Avoid false positives on inner structural containers such as 'pk-note-wrapper',
    // 'ct-note-title', 'ct-note-content', 'pk-note-icon'.  These share the same 'note'
    // substring but are child layout divs, not the outer callout/note block.
    // Strategy: per class-token, skip tokens that end with a known structural suffix.
    const STRUCTURAL = ['wrapper', 'title', 'content', 'icon', 'body', 'header', 'footer', 'inner', 'outer'];
    const classTokens = cls.split(/\s+/);
    const classMatch = classTokens.some(token => {
      if (STRUCTURAL.some(s => token === s || token.endsWith('-' + s))) return false;
      return keywords.some(k => token.includes(k));
    });
    const dataTypeMatch = keywords.some(k => dataType.includes(k));
    const roleMatch = keywords.some(k => role.includes(k));
    return classMatch || dataTypeMatch || roleMatch;
  },
  replacement: (content: string) => blockquoteReplacement(content),
});

// ── Native <blockquote> elements ─────────────────────────────────────────────
// Same logic as the callout rule: use > only when there are no list items inside.
td.addRule('blockquote-flat', {
  filter: 'blockquote',
  replacement: (content: string) => blockquoteReplacement(content),
});

// ── Collapsible / expand blocks (<details>/<summary>) ─────────────────────
// Citadel :::collapse{...}::: renders as <details><summary>title</summary>content</details>.
// We preserve the summary as a bold heading and include the body.
td.addRule('details', {
  filter: 'details',
  replacement: (content: string) => '\n\n' + content.trim() + '\n\n',
});
td.addRule('summary', {
  filter: 'summary',
  replacement: (content: string) => `\n\n**▶ ${content.trim()}**\n\n`,
});

// ── Tables (full 2-D grid: colspan + rowspan + formatted cells) ────────────
// IMPORTANT: cell content is converted via Turndown itself (not raw textContent)
// so bold, lists, strikethrough etc. inside cells are preserved.
td.addRule('all-tables', {
  filter: ['table'],
  replacement: (_content, node) => {
    const table = node as HTMLTableElement;
    const rows = Array.from(table.rows);
    if (rows.length === 0) return '';

    // Convert a cell's HTML to Markdown, preserving meaningful line breaks.
    // - Paragraph boundaries (\n\n) → single <br>  (no extra blank line)
    // - Inline newlines  (\n)       → space
    const cellMd = (cell: HTMLTableCellElement): string => {
      const raw = td.turndown(cell.innerHTML).trim(); // trim \n before <br> conversion
      return raw
        .replace(/\n{2,}/g, '\n')  // collapse multiple newlines → single \n
        .replace(/\n/g, '<br>')     // every newline → <br> (no blank lines)
        .replace(/\|/g, '\\|');
    };

    // Determine column count (colspan-expanded) from the first row.
    const numCols = Array.from(rows[0].cells).reduce(
      (sum, c) => sum + Math.max(1, parseInt(c.getAttribute('colspan') ?? '1', 10) || 1),
      0
    );

    const grid: string[][] = rows.map(() => new Array(numCols).fill(''));
    const occupiedUntil: number[] = new Array(numCols).fill(0);

    rows.forEach((row, rowIdx) => {
      let gridCol = 0;
      for (const cell of Array.from(row.cells)) {
        while (gridCol < numCols && occupiedUntil[gridCol] > rowIdx) gridCol++;
        if (gridCol >= numCols) break;

        const text = cellMd(cell);
        const colspan = Math.max(1, parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1);
        const rowspan = Math.max(1, parseInt(cell.getAttribute('rowspan') ?? '1', 10) || 1);

        grid[rowIdx][gridCol] = text;

        for (let c = gridCol; c < gridCol + colspan && c < numCols; c++) {
          occupiedUntil[c] = Math.max(occupiedUntil[c], rowIdx + rowspan);
        }
        gridCol += colspan;
      }
    });

    const headerCells = grid[0];
    const separator = headerCells.map(() => '---');
    const dataRows = grid.slice(1);

    const lines = [
      `| ${headerCells.join(' | ')} |`,
      `| ${separator.join(' | ')} |`,
      ...dataRows.map((cols) => `| ${cols.join(' | ')} |`),
    ];
    return '\n\n' + lines.join('\n') + '\n\n';
  },
});

// ── Preserve affine-img:// and affine-drawio:// placeholder URIs ───────────
// affine-img://node-N  → placed by findAndPrepare (visible DrawIO)
// affine-drawio://N    → placed by injectDrawioPlaceholders (virtual-scroll DrawIO)
td.addRule('affine-img', {
  filter: (node: HTMLElement) => {
    const src = (node as HTMLImageElement).getAttribute('src') ?? '';
    return node.nodeName === 'IMG' &&
      (src.startsWith('affine-img://') || src.startsWith('affine-drawio://'));
  },
  replacement: (_content: string, node: HTMLElement) => {
    const img = node as HTMLImageElement;
    return `![${img.getAttribute('alt') ?? ''}](${img.getAttribute('src') ?? ''})`;
  },
});

export function toMarkdown(html: string): string {
  return td.turndown(html).trim();
}
