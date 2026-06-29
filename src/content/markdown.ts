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

    const cellText = (cell: Element) =>
      (cell.textContent ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();

    const headerCells = Array.from(rows[0].cells).map(cellText);
    const separator = headerCells.map(() => '---');
    const dataRows = rows.slice(1).map((row) =>
      Array.from(row.cells).map(cellText)
    );

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
