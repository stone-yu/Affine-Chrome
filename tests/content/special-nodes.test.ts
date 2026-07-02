import { findAndPrepare, substituteImages, toPlantUmlSvgUrl } from '../../src/content/special-nodes';

function makeDoc(body: string): Document {
  const doc = document.implementation.createHTMLDocument('');
  doc.body.innerHTML = body;
  return doc;
}

describe('findAndPrepare', () => {
  it('returns empty jobs when no special nodes match', () => {
    const doc = makeDoc('<p>Hello world</p>');
    const { jobs } = findAndPrepare(doc);
    expect(jobs).toHaveLength(0);
  });

  it('detects a mermaid SVG node', () => {
    const doc = makeDoc('<div class="mermaid"><svg width="100" height="100"></svg></div>');
    const { jobs } = findAndPrepare(doc);
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0].info.kind).toBe('Mermaid');
  });

  it('replaces special node with placeholder img in the clone', () => {
    const doc = makeDoc('<div class="mermaid"><svg width="100" height="100"></svg></div>');
    const { modifiedClone, jobs } = findAndPrepare(doc);
    const placeholder = modifiedClone.querySelector(`img[src="affine-img://${jobs[0].id}"]`);
    expect(placeholder).not.toBeNull();
  });

  it('does not modify the original document', () => {
    const doc = makeDoc('<div class="mermaid"><svg width="100" height="100"></svg></div>');
    findAndPrepare(doc);
    expect(doc.querySelector('svg')).not.toBeNull();
  });

  it('assigns sequential node IDs', () => {
    const doc = makeDoc(`
      <div class="mermaid"><svg></svg></div>
      <div class="mermaid"><svg></svg></div>
    `);
    const { jobs } = findAndPrepare(doc);
    expect(jobs[0].id).toBe('node-0');
    expect(jobs[1].id).toBe('node-1');
  });
});

describe('substituteImages', () => {
  it('replaces affine-img:// with data URI', () => {
    const md = '![DrawIO](affine-img://node-0)';
    const map = new Map([['node-0', 'data:image/png;base64,ABC']]);
    expect(substituteImages(md, map)).toBe('![DrawIO](data:image/png;base64,ABC)');
  });

  it('keeps affine-img:// placeholder when id has no captured data (preserves position for retry)', () => {
    const md = 'before\n![DrawIO](affine-img://node-0)\nafter';
    const map = new Map<string, string>();
    const result = substituteImages(md, map);
    // placeholder is kept so insertDrawioImages can replace it at the correct position
    expect(result).toContain('affine-img://node-0');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('handles multiple images', () => {
    const md = '![A](affine-img://node-0)\n![B](affine-img://node-1)';
    const map = new Map([
      ['node-0', 'data:image/png;base64,AAA'],
      ['node-1', 'data:image/png;base64,BBB'],
    ]);
    const result = substituteImages(md, map);
    expect(result).toContain('data:image/png;base64,AAA');
    expect(result).toContain('data:image/png;base64,BBB');
  });
});

describe('toPlantUmlSvgUrl', () => {
  it('replaces png format with svg', () => {
    const src = 'https://km.sankuai.com/plantuml/png/bLHDQnD16BxFhtZDAO6Oc8AN';
    expect(toPlantUmlSvgUrl(src)).toBe('https://km.sankuai.com/plantuml/svg/bLHDQnD16BxFhtZDAO6Oc8AN');
  });

  it('replaces jpg format with svg', () => {
    const src = 'https://km.sankuai.com/plantuml/jpg/ENCODED';
    expect(toPlantUmlSvgUrl(src)).toBe('https://km.sankuai.com/plantuml/svg/ENCODED');
  });

  it('replaces txt format with svg', () => {
    const src = 'https://km.sankuai.com/plantuml/txt/ENCODED';
    expect(toPlantUmlSvgUrl(src)).toBe('https://km.sankuai.com/plantuml/svg/ENCODED');
  });

  it('leaves unrelated URLs unchanged', () => {
    const src = 'https://example.com/image.png';
    expect(toPlantUmlSvgUrl(src)).toBe(src);
  });

  it('does not double-replace already-svg URLs', () => {
    const src = 'https://km.sankuai.com/plantuml/svg/ENCODED';
    expect(toPlantUmlSvgUrl(src)).toBe(src);
  });
});
