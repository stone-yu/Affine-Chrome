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
    expect(toMarkdown('<strong>bold</strong>')).toBe('**bold**');
  });
});
