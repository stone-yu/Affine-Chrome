import { toMarkdown } from '../../src/content/markdown';

describe('toMarkdown', () => {
  it('converts h1 to markdown heading', () => {
    expect(toMarkdown('<h1>Hello</h1>')).toBe('# Hello');
  });

  it('converts h2 to markdown heading', () => {
    expect(toMarkdown('<h2>World</h2>')).toBe('## World');
  });

  it('converts anchor to markdown link', () => {
    const result = toMarkdown('<a href="https://example.com">click</a>');
    expect(result).toBe('[click](https://example.com)');
  });

  it('converts img to markdown image', () => {
    const result = toMarkdown('<img src="https://example.com/img.png" alt="photo" />');
    expect(result).toBe('![photo](https://example.com/img.png)');
  });

  it('preserves affine-img:// placeholder src unchanged', () => {
    const result = toMarkdown('<img src="affine-img://node-0" alt="DrawIO" />');
    expect(result).toContain('affine-img://node-0');
  });

  it('converts code block', () => {
    const result = toMarkdown('<pre><code>const x = 1;</code></pre>');
    expect(result).toContain('const x = 1;');
    expect(result).toContain('```');
  });

  it('converts strong to bold', () => {
    expect(toMarkdown('<strong>bold</strong>')).toBe('<b>bold</b>');
  });

  it('callout with list items: no > prefix (AFFiNE cannot handle > - item)', () => {
    const html = `<div data-type="blockquote"><ul><li>item 1</li><li>item 2</li></ul></div>`;
    const md = toMarkdown(html);
    expect(md).not.toMatch(/^> /m);  // no blockquote prefix
    expect(md).toContain('item 1');
    expect(md).toContain('item 2');
  });

  it('callout without list items: keeps > prefix', () => {
    const html = `<div class="km-quote-block">some plain quoted text</div>`;
    const md = toMarkdown(html);
    expect(md).toContain('> some plain quoted text');
  });

  it('table cell with ordered list does not start with <br>', () => {
    const html = `<table><tr><th>名词</th><th>解释</th></tr><tr><td>渠道</td><td><ol><li>第一条</li><li>第二条</li></ol></td></tr></table>`;
    const md = toMarkdown(html);
    // cell content must not start with <br>
    const cellContent = md.split('|').find(part => part.includes('第一条')) ?? '';
    expect(cellContent.trimStart()).not.toMatch(/^<br>/);
    expect(cellContent).toContain('第一条');
    expect(cellContent).toContain('第二条');
  });

  it('Citadel code block: <pre data-language> without <code> child → fenced block', () => {
    const html = `<pre data-language="SQL">SELECT * FROM t;</pre>`;
    const md = toMarkdown(html);
    expect(md).toContain('```sql');
    expect(md).toContain('SELECT * FROM t;');
    expect(md).toContain('```');
  });

  it('Citadel code block: <pre data-language> with <code> child → fenced block', () => {
    const html = `<pre data-language="JavaScript"><code>const x = 1;</code></pre>`;
    const md = toMarkdown(html);
    expect(md).toContain('```javascript');
    expect(md).toContain('const x = 1;');
  });

  it('Citadel code block: language attribute is lowercased', () => {
    const html = `<pre data-language="SQL">SELECT 1;</pre>`;
    const md = toMarkdown(html);
    expect(md).toContain('```sql');
    expect(md).not.toContain('```SQL');
  });
});
