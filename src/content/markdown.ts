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

// ── CSS bold (font-weight without <strong>/<b>) ────────────────────────────
td.addRule('css-bold', {
  filter: (node: HTMLElement) => {
    const INLINE = new Set(['SPAN', 'A', 'LABEL', 'CITE', 'DFN', 'ABBR', 'MARK']);
    if (!INLINE.has(node.nodeName)) return false;
    const fw = node.style?.fontWeight ?? '';
    return fw === 'bold' || fw === '700' || fw === '600';
  },
  replacement: (content: string) => (content.trim() ? `**${content.trim()}**` : ''),
});

// ── Callout / Note blocks (Citadel :::note{type=info}:::) ─────────────────
// Citadel renders note/callout blocks as a div with a class that typically
// contains "note" or "callout".  We convert them to Markdown blockquote.
td.addRule('callout', {
  filter: (node: HTMLElement) => {
    if (node.nodeName !== 'DIV' && node.nodeName !== 'SECTION') return false;
    const cls = (node.getAttribute('class') ?? '').toLowerCase();
    return cls.includes('note') || cls.includes('callout') || cls.includes('tip') ||
           cls.includes('warning') || cls.includes('info') || cls.includes('alert');
  },
  replacement: (content: string) => {
    const lines = content.trim().split('\n').map(l => `> ${l}`).join('\n');
    return '\n\n' + lines + '\n\n';
  },
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

    // Convert a cell's HTML to a single-line Markdown string.
    // Multi-line content (lists, paragraphs) is joined with " · ".
    const cellMd = (cell: HTMLTableCellElement): string => {
      const raw = td.turndown(cell.innerHTML);
      return raw
        .replace(/\n+/g, ' · ')  // collapse newlines for table cells
        .replace(/\|/g, '\\|')
        .trim();
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

// ── Preserve affine-img:// URIs ────────────────────────────────────────────
td.addRule('affine-img', {
  filter: (node: HTMLElement) =>
    node.nodeName === 'IMG' &&
    (node as HTMLImageElement).getAttribute('src')?.startsWith('affine-img://') === true,
  replacement: (_content: string, node: HTMLElement) => {
    const img = node as HTMLImageElement;
    return `![${img.getAttribute('alt') ?? ''}](${img.getAttribute('src') ?? ''})`;
  },
});

export function toMarkdown(html: string): string {
  return td.turndown(html).trim();
}
