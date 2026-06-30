import TurndownService from 'turndown';
import { strikethrough, taskListItems } from 'turndown-plugin-gfm';

const td = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// Use only the non-table parts of GFM.
// The GFM `tables` plugin calls `turndownService.keep(...)` for tables that
// lack <th> headers, and `keep` rules have HIGHER priority than `addRule` rules,
// so our custom table rule would never fire for those tables.
// By omitting the tables plugin entirely we avoid that conflict.
td.use(strikethrough);
td.use(taskListItems);

// Convert ALL tables to pipe format: expand merged cells (colspan) with empty
// placeholders, treat the first row as the header regardless of <th>/<td>.
td.addRule('all-tables', {
  filter: ['table'],
  replacement: (_content, node) => {
    const table = node as HTMLTableElement;
    const rows = Array.from(table.rows);
    if (rows.length === 0) return '';

    // Build a full 2-D grid that correctly handles both colspan AND rowspan.
    // HTMLTableRowElement.cells only contains cells explicitly in that row;
    // columns covered by a rowspan from an earlier row are absent.
    // We track which grid columns are still "occupied" by a spanning cell.
    const cellText = (cell: HTMLTableCellElement) =>
      (cell.textContent ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();

    // Determine column count from the first row (colspan-expanded).
    const numCols = Array.from(rows[0].cells).reduce(
      (sum, c) => sum + Math.max(1, parseInt(c.getAttribute('colspan') ?? '1', 10) || 1),
      0
    );

    // grid[r][c] = cell text ('' for merged / empty cells)
    const grid: string[][] = rows.map(() => new Array(numCols).fill(''));
    // occupiedUntil[c] = first row index that is NO LONGER occupied by a rowspan
    const occupiedUntil: number[] = new Array(numCols).fill(0);

    rows.forEach((row, rowIdx) => {
      let gridCol = 0;
      for (const cell of Array.from(row.cells)) {
        // Advance past columns still occupied by a rowspan from above
        while (gridCol < numCols && occupiedUntil[gridCol] > rowIdx) gridCol++;
        if (gridCol >= numCols) break;

        const text = cellText(cell);
        const colspan = Math.max(1, parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1);
        const rowspan = Math.max(1, parseInt(cell.getAttribute('rowspan') ?? '1', 10) || 1);

        grid[rowIdx][gridCol] = text;

        // Mark the spanned columns in future rows as occupied
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

// Handle bold text that uses CSS font-weight instead of <strong>/<b> tags.
// Citadel and many web editors style bold via class or inline style rather
// than semantic HTML, so Turndown's built-in bold rule misses them.
td.addRule('css-bold', {
  filter: (node: HTMLElement) => {
    // Only inline-ish elements; avoid wrapping headings/blocks in **
    const INLINE = new Set(['SPAN', 'A', 'LABEL', 'CITE', 'DFN', 'ABBR', 'ACRONYM', 'MARK']);
    if (!INLINE.has(node.nodeName)) return false;
    const fw = node.style?.fontWeight ?? '';
    return fw === 'bold' || fw === '700' || fw === '600';
  },
  replacement: (content: string) => (content.trim() ? `**${content.trim()}**` : ''),
});

// Preserve affine-img:// URIs — TurndownService would otherwise encode them
td.addRule('affine-img', {
  filter: (node: HTMLElement) =>
    node.nodeName === 'IMG' &&
    (node as HTMLImageElement).getAttribute('src')?.startsWith('affine-img://') === true,
  replacement: (_content: string, node: HTMLElement) => {
    const img = node as HTMLImageElement;
    const src = img.getAttribute('src') ?? '';
    const alt = img.getAttribute('alt') ?? '';
    return `![${alt}](${src})`;
  },
});

export function toMarkdown(html: string): string {
  return td.turndown(html).trim();
}
