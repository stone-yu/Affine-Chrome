import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const td = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// GFM plugin adds proper pipe-table support: | col | col |
td.use(gfm);

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
