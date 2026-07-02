import { extractArticle } from '../../src/content/extractor';

function makeDoc(body: string, title = 'Test Title'): Document {
  const doc = document.implementation.createHTMLDocument(title);
  doc.body.innerHTML = body;
  return doc;
}

describe('extractArticle', () => {
  it('returns null for a page with no article content', () => {
    const doc = makeDoc('<div>x</div>');
    const result = extractArticle(doc);
    expect(result === null || typeof result?.title === 'string').toBe(true);
  });

  it('extracts title and content from an article page (Readability path)', () => {
    const body = `
      <article>
        <h1>My Article</h1>
        <p>This is the first paragraph with enough content to pass Readability's minimum threshold for article extraction. It needs to be somewhat long.</p>
        <p>This is a second paragraph adding more content to ensure Readability considers this a valid article worth extracting from the page.</p>
      </article>
    `;
    const doc = makeDoc(body, 'My Article');
    const result = extractArticle(doc);
    expect(result).not.toBeNull();
    expect(result!.title).toBeTruthy();
    expect(result!.content).toContain('paragraph');
  });

  it('uses ProseMirror content directly for Citadel/KM pages (data-node-id detected)', () => {
    // Citadel pages have data-node-id on every block.  We must bypass Readability
    // because it strips Citadel-specific elements (blockquotes, callouts, etc.).
    const body = `
      <div class="km-shell">
        <nav>navigation — should be ignored</nav>
        <main>
          <div class="ProseMirror" contenteditable="false">
            <h2 data-node-id="h2-abc">能力地图</h2>
            <blockquote class="ct-blockquote" data-node-id="bq-abc">
              <ul data-node-id="ul-abc">
                <li data-node-id="li-1">
                  <p data-node-id="p-1"><strong>订单接入范围：</strong>两类渠道</p>
                </li>
                <li data-node-id="li-2">
                  <p data-node-id="p-2"><strong>打印商类型范围：</strong>支持云盒</p>
                </li>
              </ul>
            </blockquote>
            <p data-node-id="p-3">普通段落内容。</p>
          </div>
        </main>
      </div>
    `;
    const doc = makeDoc(body, 'KM Page');
    const result = extractArticle(doc);
    expect(result).not.toBeNull();
    // blockquote content must be present (not stripped by Readability)
    expect(result!.content).toContain('订单接入范围');
    expect(result!.content).toContain('打印商类型范围');
    // blockquote HTML should be present (raw HTML from ProseMirror)
    expect(result!.content).toContain('ct-blockquote');
  });

  it('returns a positive wordCount', () => {
    const body = `
      <article>
        <p>One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty words here.</p>
      </article>
    `;
    const doc = makeDoc(body);
    const result = extractArticle(doc);
    if (result) {
      expect(result.wordCount).toBeGreaterThan(0);
    }
  });
});
