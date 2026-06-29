import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const td = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// GFM plugin adds strikethrough, task lists, and basic table support.
td.use(gfm);

// The GFM tables rule only converts tables that have <th> heading cells;
// tables with only <td> rows get "kept" as raw HTML by the plugin.
// This override converts ALL tables to pipe format, treating the first row
// as the header regardless of whether it uses <th> or <td>.
td.addRule('all-tables', {
  filter: ['table'],
  replacement: (_content, node) => {
    const table = node as HTMLTableElement;
    const rows = Array.from(table.rows);
    if (rows.length === 0) return '';

    // Expand a row into flat cell strings, filling empty strings for merged columns.
    const expandRow = (row: HTMLTableRowElement): string[] => {
      const cells: string[] = [];
      for (const cell of Array.from(row.cells)) {
        const text = (cell.textContent ?? '')
          .replace(/\|/g, '\\|')
          .replace(/\n/g, ' ')
          .trim();
        const colspan = Math.max(1, parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1);
        cells.push(text);
        for (let i = 1; i < colspan; i++) cells.push(''); // empty placeholders
      }
      return cells;
    };

    const headerCells = expandRow(rows[0]);
    const separator = headerCells.map(() => '---');
    const dataRows = rows.slice(1).map((row) => {
      const expanded = expandRow(row);
      // Pad or truncate to match header column count
      while (expanded.length < headerCells.length) expanded.push('');
      return expanded.slice(0, headerCells.length);
    });

    const lines = [
      `| ${headerCells.join(' | ')} |`,
      `| ${separator.join(' | ')} |`,
      ...dataRows.map((cols) => `| ${cols.join(' | ')} |`),
    ];
    return '\n\n' + lines.join('\n') + '\n\n';
  },
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
