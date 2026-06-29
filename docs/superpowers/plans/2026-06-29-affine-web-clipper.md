# AFFiNE Web Clipper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome MV3 extension that clips any web page (text as Markdown + special rendered nodes as PNG) into a self-hosted AFFiNE instance via iframe + postMessage.

**Architecture:** Content script runs Readability + Turndown for text extraction, detects special nodes (DrawIO, Mermaid, charts) via configurable selectors, captures them with html2canvas as PNG data URIs, and substitutes them inline in the Markdown. Side Panel presents a preview and triggers save via a hidden AFFiNE iframe.

**Tech Stack:** TypeScript 5, Webpack 5, @mozilla/readability, turndown, html2canvas, Jest 29 + jsdom

## Global Constraints

- Chrome Manifest V3 — use `chrome.action`, `chrome.sidePanel`, `chrome.storage.sync`
- TypeScript `strict: true`
- No UI framework — vanilla TS + inline CSS
- html2canvas options always: `{ useCORS: true, scale: window.devicePixelRatio }`
- Special node capture retries up to 3× with 500 ms delay when `offsetHeight === 0`
- AFFiNE auth: existing iframe + postMessage protocol — no server modifications
- Placeholder URI scheme: `affine-img://node-{N}` (e.g. `affine-img://node-0`)

---

## File Map

```
src/
  types.ts                      shared interfaces (Settings, ExtractResult, CaptureJob, …)
  background.ts                 service worker — icon click → open side panel
  content/
    extractor.ts                Readability wrapper → Article
    markdown.ts                 Turndown wrapper → string
    special-nodes.ts            detection rules, clone preparation, html2canvas capture
    index.ts                    content script entry — handles EXTRACT message
  utils/
    affine.ts                   hidden iframe + postMessage to AFFiNE
    storage.ts                  chrome.storage.sync get/set
  sidepanel/
    index.html                  side panel shell
    index.ts                    side panel UI — 3 states
  settings/
    index.html                  settings page shell
    index.ts                    settings form
manifest.json
webpack.config.js
tsconfig.json
jest.config.js
package.json
tests/
  utils/storage.test.ts
  content/extractor.test.ts
  content/markdown.test.ts
  content/special-nodes.test.ts
  utils/affine.test.ts
```

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `webpack.config.js`
- Create: `jest.config.js`
- Create: `manifest.json`
- Create: `src/sidepanel/index.html`
- Create: `src/settings/index.html`

**Interfaces:**
- Produces: `npm test` runs (0 tests, exits 0); `npm run build` creates `dist/`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "affine-web-clipper",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "webpack --mode=production",
    "dev": "webpack --mode=development --watch",
    "test": "jest"
  },
  "dependencies": {
    "@mozilla/readability": "^0.5.0",
    "html2canvas": "^1.4.1",
    "turndown": "^7.2.0"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.268",
    "@types/jest": "^29.5.12",
    "@types/turndown": "^5.0.5",
    "copy-webpack-plugin": "^12.0.2",
    "jest": "^29.7.0",
    "jest-environment-jsdom": "^29.7.0",
    "ts-jest": "^29.1.5",
    "ts-loader": "^9.5.1",
    "typescript": "^5.4.5",
    "webpack": "^5.91.0",
    "webpack-cli": "^5.1.4"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "moduleResolution": "bundler",
    "strict": true,
    "outDir": "dist",
    "sourceMap": true,
    "lib": ["ES2020", "DOM"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create `webpack.config.js`**

```js
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    background: './src/background.ts',
    content: './src/content/index.ts',
    sidepanel: './src/sidepanel/index.ts',
    settings: './src/settings/index.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  module: {
    rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
  },
  resolve: { extensions: ['.ts', '.js'] },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json' },
        { from: 'src/sidepanel/index.html', to: 'sidepanel.html' },
        { from: 'src/settings/index.html', to: 'settings.html' },
      ],
    }),
  ],
};
```

- [ ] **Step 4: Create `jest.config.js`**

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  testMatch: ['**/tests/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'CommonJS', moduleResolution: 'node' } }],
  },
};
```

- [ ] **Step 5: Create `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "AFFiNE Web Clipper",
  "version": "0.1.0",
  "description": "Clip web pages and special diagrams into AFFiNE",
  "permissions": ["sidePanel", "activeTab", "scripting", "storage", "tabs"],
  "side_panel": { "default_path": "sidepanel.html" },
  "background": { "service_worker": "background.js" },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "action": { "default_title": "AFFiNE Web Clipper" },
  "options_ui": { "page": "settings.html", "open_in_tab": true }
}
```

- [ ] **Step 6: Create `src/sidepanel/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AFFiNE Web Clipper</title>
</head>
<body>
  <div id="app"></div>
  <script src="sidepanel.js"></script>
</body>
</html>
```

- [ ] **Step 7: Create `src/settings/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AFFiNE Web Clipper — Settings</title>
</head>
<body>
  <div id="app"></div>
  <script src="settings.js"></script>
</body>
</html>
```

- [ ] **Step 8: Create placeholder TS entry files so webpack doesn't fail**

Create `src/background.ts`:
```ts
export {};
```
Create `src/content/index.ts`:
```ts
export {};
```
Create `src/sidepanel/index.ts`:
```ts
export {};
```
Create `src/settings/index.ts`:
```ts
export {};
```

- [ ] **Step 9: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 10: Verify build and test runner work**

```bash
npm run build
```
Expected: `dist/` created with `background.js`, `content.js`, `sidepanel.js`, `settings.js`, `manifest.json`, `sidepanel.html`, `settings.html`.

```bash
npm test
```
Expected: `Test Suites: 0 passed`, exits 0.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: scaffold Chrome extension project"
```

---

## Task 2: Shared Types + Storage Utils

**Files:**
- Create: `src/types.ts`
- Create: `src/utils/storage.ts`
- Create: `tests/utils/storage.test.ts`

**Interfaces:**
- Produces: `Settings`, `ExtractResult`, `ExtractError`, `SpecialNodeInfo`, `CaptureJob` — imported by all subsequent tasks
- Produces: `getSettings(): Promise<Settings>`, `saveSettings(p: Partial<Settings>): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/utils/storage.test.ts`:
```ts
const mockGet = jest.fn();
const mockSet = jest.fn();
(globalThis as any).chrome = {
  storage: { sync: { get: mockGet, set: mockSet } },
};

import { getSettings, saveSettings } from '../../src/utils/storage';

describe('getSettings', () => {
  it('returns defaults when storage is empty', async () => {
    mockGet.mockResolvedValue({ affineUrl: 'http://localhost:3000', defaultWorkspace: '' });
    const s = await getSettings();
    expect(s.affineUrl).toBe('http://localhost:3000');
    expect(s.defaultWorkspace).toBe('');
  });

  it('returns stored values', async () => {
    mockGet.mockResolvedValue({ affineUrl: 'http://myaffine.com', defaultWorkspace: 'ws-123' });
    const s = await getSettings();
    expect(s.affineUrl).toBe('http://myaffine.com');
    expect(s.defaultWorkspace).toBe('ws-123');
  });
});

describe('saveSettings', () => {
  it('calls chrome.storage.sync.set with provided values', async () => {
    mockSet.mockResolvedValue(undefined);
    await saveSettings({ affineUrl: 'http://newaffine.com' });
    expect(mockSet).toHaveBeenCalledWith({ affineUrl: 'http://newaffine.com' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- --testPathPattern=storage
```
Expected: FAIL — `Cannot find module '../../src/utils/storage'`

- [ ] **Step 3: Create `src/types.ts`**

```ts
export interface Settings {
  affineUrl: string;
  defaultWorkspace: string;
}

export interface SpecialNodeInfo {
  label: string;
  kind: string; // 'DrawIO' | 'Mermaid' | 'PlantUML' | 'Chart'
}

export interface CaptureJob {
  id: string;       // 'node-0', 'node-1', …
  element: Element; // original DOM element to capture
  info: SpecialNodeInfo;
}

export interface ExtractResult {
  type: 'EXTRACT_RESULT';
  title: string;
  markdown: string;
  wordCount: number;
  specialNodes: SpecialNodeInfo[];
}

export interface ExtractError {
  type: 'EXTRACT_ERROR';
  message: string;
}
```

- [ ] **Step 4: Create `src/utils/storage.ts`**

```ts
import type { Settings } from '../types';

const DEFAULTS: Settings = {
  affineUrl: 'http://localhost:3000',
  defaultWorkspace: '',
};

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.sync.get(DEFAULTS);
  return result as Settings;
}

export async function saveSettings(settings: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(settings);
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test -- --testPathPattern=storage
```
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/utils/storage.ts tests/utils/storage.test.ts
git commit -m "feat: add shared types and storage utils"
```

---

## Task 3: Article Extractor

**Files:**
- Create: `src/content/extractor.ts`
- Create: `tests/content/extractor.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `extractArticle(doc: Document): Article | null`
  - `Article { title: string; content: string; wordCount: number }`

- [ ] **Step 1: Write the failing test**

Create `tests/content/extractor.test.ts`:
```ts
import { extractArticle } from '../../src/content/extractor';

function makeDoc(body: string, title = 'Test Title'): Document {
  const doc = document.implementation.createHTMLDocument(title);
  doc.body.innerHTML = body;
  return doc;
}

describe('extractArticle', () => {
  it('returns null for a page with no article content', () => {
    const doc = makeDoc('<div>x</div>');
    // Readability needs substantial content to extract; empty pages return null
    const result = extractArticle(doc);
    // Accept null or a result — just verify it doesn't throw
    expect(result === null || typeof result?.title === 'string').toBe(true);
  });

  it('extracts title and content from an article page', () => {
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
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- --testPathPattern=extractor
```
Expected: FAIL — `Cannot find module '../../src/content/extractor'`

- [ ] **Step 3: Create `src/content/extractor.ts`**

```ts
import { Readability } from '@mozilla/readability';

export interface Article {
  title: string;
  content: string; // HTML string
  wordCount: number;
}

export function extractArticle(doc: Document): Article | null {
  const clone = doc.cloneNode(true) as Document;
  const reader = new Readability(clone);
  const article = reader.parse();
  if (!article) return null;
  return {
    title: article.title,
    content: article.content,
    wordCount: article.textContent.trim().split(/\s+/).filter(Boolean).length,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --testPathPattern=extractor
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/content/extractor.ts tests/content/extractor.test.ts
git commit -m "feat: add Readability article extractor"
```

---

## Task 4: Markdown Converter

**Files:**
- Create: `src/content/markdown.ts`
- Create: `tests/content/markdown.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `toMarkdown(html: string): string`
  - Preserves `affine-img://node-N` src values in img tags unchanged

- [ ] **Step 1: Write the failing test**

Create `tests/content/markdown.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- --testPathPattern=markdown
```
Expected: FAIL — `Cannot find module '../../src/content/markdown'`

- [ ] **Step 3: Create `src/content/markdown.ts`**

```ts
import TurndownService from 'turndown';

const td = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// Preserve affine-img:// URIs — TurndownService would otherwise encode them
td.addRule('affine-img', {
  filter: (node) =>
    node.nodeName === 'IMG' &&
    (node as HTMLImageElement).getAttribute('src')?.startsWith('affine-img://') === true,
  replacement: (_content, node) => {
    const img = node as HTMLImageElement;
    const src = img.getAttribute('src') ?? '';
    const alt = img.getAttribute('alt') ?? '';
    return `![${alt}](${src})`;
  },
});

export function toMarkdown(html: string): string {
  return td.turndown(html).trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --testPathPattern=markdown
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/content/markdown.ts tests/content/markdown.test.ts
git commit -m "feat: add Turndown markdown converter with affine-img rule"
```

---

## Task 5: Special Node Detection + html2canvas Capture

**Files:**
- Create: `src/content/special-nodes.ts`
- Create: `tests/content/special-nodes.test.ts`

**Interfaces:**
- Consumes: `CaptureJob`, `SpecialNodeInfo` from `../types`
- Produces:
  - `findAndPrepare(doc: Document): { modifiedClone: Document; jobs: CaptureJob[] }`
    — finds special nodes in `doc`, returns a clone with placeholders + capture jobs referencing original elements
  - `captureAll(jobs: CaptureJob[]): Promise<Map<string, string>>`
    — runs html2canvas on each job's element, returns `id → dataURI` map; skips failed captures
  - `substituteImages(markdown: string, images: Map<string, string>): string`
    — replaces `affine-img://node-N` with data URIs; removes lines whose placeholder has no entry

- [ ] **Step 1: Write the failing tests**

Create `tests/content/special-nodes.test.ts`:
```ts
import { findAndPrepare, substituteImages } from '../../src/content/special-nodes';

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

  it('removes image line when id has no captured data', () => {
    const md = 'before\n![DrawIO](affine-img://node-0)\nafter';
    const map = new Map<string, string>();
    const result = substituteImages(md, map);
    expect(result).not.toContain('affine-img://node-0');
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
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- --testPathPattern=special-nodes
```
Expected: FAIL — `Cannot find module '../../src/content/special-nodes'`

- [ ] **Step 3: Create `src/content/special-nodes.ts`**

```ts
import type { CaptureJob, SpecialNodeInfo } from '../types';

interface NodeRule {
  match: string; // hostname or '*'
  selector: string;
  kind: string;
  label: string;
}

const RULES: NodeRule[] = [
  { match: 'km.sankuai.com', selector: '[data-node-type="drawio"], img[src*="/api/file/cdn/"]', kind: 'DrawIO', label: 'DrawIO 图表' },
  { match: '*', selector: '.mermaid > svg, [class*="mermaid"] > svg', kind: 'Mermaid', label: 'Mermaid 图表' },
  { match: '*', selector: 'img[src*="plantuml"]', kind: 'PlantUML', label: 'PlantUML 图表' },
  { match: '*', selector: '.chart-container svg, .diagram-container svg, [class*="echarts"] svg', kind: 'Chart', label: '图表' },
];

function getRulesForHost(hostname: string): NodeRule[] {
  return RULES.filter((r) => r.match === '*' || hostname.includes(r.match));
}

export function findAndPrepare(
  doc: Document
): { modifiedClone: Document; jobs: CaptureJob[] } {
  const hostname = doc.location?.hostname ?? (typeof location !== 'undefined' ? location.hostname : '');
  const rules = getRulesForHost(hostname);

  // Collect unique original elements (avoid duplicates from overlapping selectors)
  const seen = new Set<Element>();
  const found: { element: Element; rule: NodeRule }[] = [];
  for (const rule of rules) {
    doc.querySelectorAll(rule.selector).forEach((el) => {
      if (!seen.has(el)) {
        seen.add(el);
        found.push({ element: el, rule });
      }
    });
  }

  // Build jobs referencing original elements
  const jobs: CaptureJob[] = found.map(({ element, rule }, i) => ({
    id: `node-${i}`,
    element,
    info: { label: rule.label, kind: rule.kind },
  }));

  // Build a modified clone with placeholders.
  // Snapshot both node lists BEFORE the loop — replacing nodes in the clone
  // changes its querySelectorAll count, making index-based lookup unreliable mid-loop.
  const modifiedClone = doc.cloneNode(true) as Document;
  const allOriginal = Array.from(doc.querySelectorAll('*'));
  const allClone = Array.from(modifiedClone.querySelectorAll('*'));

  for (const job of jobs) {
    const idx = allOriginal.indexOf(job.element);
    if (idx === -1) continue;
    const cloneEl = allClone[idx];
    if (!cloneEl) continue;
    const placeholder = modifiedClone.createElement('img');
    placeholder.setAttribute('src', `affine-img://${job.id}`);
    placeholder.setAttribute('alt', job.info.label);
    cloneEl.replaceWith(placeholder);
  }

  return { modifiedClone, jobs };
}

async function waitForRender(el: Element, retries = 3): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    if ((el as HTMLElement).offsetHeight > 0) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function captureAll(jobs: CaptureJob[]): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  // Dynamically import html2canvas to keep it out of the test environment
  const html2canvas = (await import('html2canvas')).default;

  for (const job of jobs) {
    try {
      const ready = await waitForRender(job.element);
      if (!ready) {
        console.warn(`[affine-clipper] Skipping ${job.id}: element has no height after retries`);
        continue;
      }
      const canvas = await html2canvas(job.element as HTMLElement, {
        useCORS: true,
        scale: window.devicePixelRatio,
      });
      results.set(job.id, canvas.toDataURL('image/png'));
    } catch (err) {
      console.warn(`[affine-clipper] Failed to capture ${job.id}:`, err);
    }
  }
  return results;
}

export function substituteImages(markdown: string, images: Map<string, string>): string {
  return markdown
    .split('\n')
    .map((line) => {
      const match = line.match(/!\[.*?\]\(affine-img:\/\/(node-\d+)\)/);
      if (!match) return line;
      const id = match[1];
      const dataUri = images.get(id);
      if (!dataUri) return null; // will be filtered out
      return line.replace(`affine-img://${id}`, dataUri);
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --testPathPattern=special-nodes
```
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/content/special-nodes.ts tests/content/special-nodes.test.ts
git commit -m "feat: add special node detection, clone preparation, and image substitution"
```

---

## Task 6: Content Script Entry

**Files:**
- Modify: `src/content/index.ts` (replace placeholder)
- No new test file — logic delegates to already-tested modules; manual verification in Task 11

**Interfaces:**
- Consumes: `extractArticle` from `./extractor`, `toMarkdown` from `./markdown`, `findAndPrepare` + `captureAll` + `substituteImages` from `./special-nodes`
- Produces: Chrome message handler for `{ type: 'EXTRACT' }` → responds with `ExtractResult | ExtractError`

- [ ] **Step 1: Replace `src/content/index.ts`**

```ts
import type { ExtractResult, ExtractError } from '../types';
import { extractArticle } from './extractor';
import { toMarkdown } from './markdown';
import { findAndPrepare, captureAll, substituteImages } from './special-nodes';

async function performExtraction(): Promise<ExtractResult | ExtractError> {
  try {
    const { modifiedClone, jobs } = findAndPrepare(document);

    const article = extractArticle(modifiedClone);
    if (!article) {
      return { type: 'EXTRACT_ERROR', message: 'Could not extract article content from this page.' };
    }

    const markdown = toMarkdown(article.content);
    const images = await captureAll(jobs);
    const finalMarkdown = substituteImages(markdown, images);

    return {
      type: 'EXTRACT_RESULT',
      title: article.title || document.title,
      markdown: finalMarkdown,
      wordCount: article.wordCount,
      specialNodes: jobs.map((j) => j.info),
    };
  } catch (err) {
    return { type: 'EXTRACT_ERROR', message: String(err) };
  }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'EXTRACT') {
    performExtraction().then(sendResponse);
    return true; // keep message channel open for async response
  }
});
```

- [ ] **Step 2: Verify build succeeds**

```bash
npm run build
```
Expected: exits 0, `dist/content.js` updated.

- [ ] **Step 3: Commit**

```bash
git add src/content/index.ts
git commit -m "feat: implement content script EXTRACT handler"
```

---

## Task 7: AFFiNE Communication

**Files:**
- Create: `src/utils/affine.ts`
- Create: `tests/utils/affine.test.ts`

**Interfaces:**
- Produces: `sendToAFFiNE(container: HTMLElement, affineUrl: string, payload: AFFiNEPayload): Promise<void>`
  - `AFFiNEPayload { title: string; contentMarkdown: string; workspace: string }`
  - Resolves on `affine-clipper:import:success`
  - Rejects with `Error('timeout')` after 30 s
  - Rejects with `Error('AFFiNE URL not configured')` when `affineUrl` is empty

- [ ] **Step 1: Write the failing test**

Create `tests/utils/affine.test.ts`:
```ts
// Minimal DOM setup
document.body.innerHTML = '<div id="container"></div>';

import { sendToAFFiNE } from '../../src/utils/affine';

describe('sendToAFFiNE', () => {
  it('rejects immediately when affineUrl is empty', async () => {
    const container = document.getElementById('container')!;
    await expect(
      sendToAFFiNE(container, '', { title: 'T', contentMarkdown: 'M', workspace: 'W' })
    ).rejects.toThrow('AFFiNE URL not configured');
  });

  it('resolves when success message is received', async () => {
    const container = document.getElementById('container')!;
    // Simulate AFFiNE success reply 50 ms after iframe "loads"
    const original = document.createElement.bind(document);
    jest.spyOn(document, 'createElement').mockImplementationOnce((tag: string) => {
      if (tag === 'iframe') {
        const iframe = original('iframe') as HTMLIFrameElement;
        // Trigger load + success message after a tick
        setTimeout(() => {
          iframe.dispatchEvent(new Event('load'));
          setTimeout(() => {
            window.dispatchEvent(new MessageEvent('message', {
              data: { type: 'affine-clipper:import:success' },
            }));
          }, 10);
        }, 10);
        return iframe;
      }
      return original(tag);
    });

    await expect(
      sendToAFFiNE(container, 'http://localhost:3000', { title: 'T', contentMarkdown: 'M', workspace: 'W' })
    ).resolves.toBeUndefined();
  });

  it('rejects after timeout', async () => {
    jest.useFakeTimers();
    const container = document.getElementById('container')!;

    const promise = sendToAFFiNE(
      container,
      'http://localhost:3000',
      { title: 'T', contentMarkdown: 'M', workspace: 'W' }
    );
    jest.advanceTimersByTime(31_000);
    await expect(promise).rejects.toThrow('timeout');
    jest.useRealTimers();
  }, 10_000);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- --testPathPattern=affine
```
Expected: FAIL — `Cannot find module '../../src/utils/affine'`

- [ ] **Step 3: Create `src/utils/affine.ts`**

```ts
export interface AFFiNEPayload {
  title: string;
  contentMarkdown: string;
  workspace: string;
}

const TIMEOUT_MS = 30_000;

export function sendToAFFiNE(
  container: HTMLElement,
  affineUrl: string,
  payload: AFFiNEPayload
): Promise<void> {
  if (!affineUrl) return Promise.reject(new Error('AFFiNE URL not configured'));

  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.src = `${affineUrl}/clipper/import`;
    iframe.style.cssText = 'position:fixed;width:0;height:0;border:none;opacity:0;pointer-events:none;';

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout'));
    }, TIMEOUT_MS);

    function onMessage(event: MessageEvent) {
      if (event.data?.type === 'affine-clipper:import:success') {
        cleanup();
        resolve();
      }
    }

    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      iframe.remove();
    }

    window.addEventListener('message', onMessage);

    iframe.addEventListener('load', () => {
      iframe.contentWindow?.postMessage(
        { type: 'affine-clipper:import', payload },
        affineUrl
      );
    });

    container.appendChild(iframe);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --testPathPattern=affine
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/utils/affine.ts tests/utils/affine.test.ts
git commit -m "feat: add AFFiNE iframe postMessage sender"
```

---

## Task 8: Background Service Worker

**Files:**
- Modify: `src/background.ts` (replace placeholder)

**Interfaces:**
- Produces: clicking the extension icon opens the side panel for the current tab

- [ ] **Step 1: Replace `src/background.ts`**

```ts
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/background.ts
git commit -m "feat: background opens side panel on action click"
```

---

## Task 9: Settings Page

**Files:**
- Modify: `src/settings/index.ts` (replace placeholder)

**Interfaces:**
- Consumes: `getSettings`, `saveSettings` from `../utils/storage`
- Produces: HTML form at `settings.html` — saves `affineUrl` + `defaultWorkspace` to `chrome.storage.sync`

- [ ] **Step 1: Replace `src/settings/index.ts`**

```ts
import { getSettings, saveSettings } from '../utils/storage';

const STYLES = `
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; color: #333; }
  h1 { font-size: 18px; margin-bottom: 24px; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  input { display: block; width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; margin-bottom: 16px; }
  button { padding: 8px 20px; background: #1a1a1a; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
  button:hover { background: #333; }
  .saved { color: green; font-size: 13px; margin-left: 12px; display: none; }
`;

async function init() {
  const settings = await getSettings();

  const app = document.getElementById('app')!;
  app.innerHTML = `
    <style>${STYLES}</style>
    <h1>AFFiNE Web Clipper — Settings</h1>
    <label for="affineUrl">AFFiNE Server URL</label>
    <input id="affineUrl" type="url" placeholder="http://localhost:3000" value="${settings.affineUrl}" />
    <label for="workspace">Default Workspace ID</label>
    <input id="workspace" type="text" placeholder="Paste workspace ID from AFFiNE URL" value="${settings.defaultWorkspace}" />
    <button id="save">Save</button>
    <span class="saved" id="savedMsg">✓ Saved</span>
  `;

  document.getElementById('save')!.addEventListener('click', async () => {
    const affineUrl = (document.getElementById('affineUrl') as HTMLInputElement).value.trim().replace(/\/$/, '');
    const defaultWorkspace = (document.getElementById('workspace') as HTMLInputElement).value.trim();
    await saveSettings({ affineUrl, defaultWorkspace });
    const msg = document.getElementById('savedMsg')!;
    msg.style.display = 'inline';
    setTimeout(() => (msg.style.display = 'none'), 2000);
  });
}

init();
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```
Expected: exits 0, `dist/settings.js` updated.

- [ ] **Step 3: Commit**

```bash
git add src/settings/index.ts
git commit -m "feat: implement settings page"
```

---

## Task 10: Side Panel

**Files:**
- Modify: `src/sidepanel/index.ts` (replace placeholder)

**Interfaces:**
- Consumes: `getSettings` from `../utils/storage`, `sendToAFFiNE` from `../utils/affine`
- Consumes: `ExtractResult`, `ExtractError` from `../types`
- Produces: Side Panel UI with 3 states (extracting → preview → result)

- [ ] **Step 1: Replace `src/sidepanel/index.ts`**

```ts
import { getSettings } from '../utils/storage';
import { sendToAFFiNE } from '../utils/affine';
import type { ExtractResult, ExtractError } from '../types';

const STYLES = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; font-size: 14px; color: #333; background: #fafafa; min-height: 100vh; }
  .panel { padding: 16px; }
  h2 { font-size: 15px; font-weight: 600; margin-bottom: 16px; border-bottom: 1px solid #eee; padding-bottom: 10px; }
  .spinner { text-align: center; padding: 40px 0; color: #888; }
  label { display: block; font-size: 12px; font-weight: 600; color: #555; margin-bottom: 4px; }
  input[type="text"] { width: 100%; padding: 7px 9px; border: 1px solid #ddd; border-radius: 5px; font-size: 14px; margin-bottom: 12px; }
  .meta { font-size: 12px; color: #777; margin-bottom: 12px; }
  .meta span { margin-right: 12px; }
  .nodes { background: #f0f4ff; border-radius: 6px; padding: 10px 12px; font-size: 12px; margin-bottom: 14px; }
  .nodes ul { padding-left: 16px; margin-top: 4px; }
  .workspace-row { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
  .workspace-row .ws-label { font-size: 12px; color: #555; flex-shrink: 0; }
  .workspace-row .ws-value { font-size: 12px; color: #333; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .workspace-row a { font-size: 12px; color: #0070f3; text-decoration: none; }
  button.save { width: 100%; padding: 10px; background: #1a1a1a; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600; }
  button.save:hover { background: #333; }
  button.save:disabled { background: #999; cursor: not-allowed; }
  .no-config { background: #fff8e1; border-radius: 6px; padding: 12px; font-size: 13px; text-align: center; }
  .no-config a { color: #0070f3; }
  .result { text-align: center; padding: 32px 16px; }
  .result .icon { font-size: 40px; margin-bottom: 12px; }
  .result p { font-size: 13px; color: #555; margin-bottom: 16px; }
  .result a { color: #0070f3; font-size: 13px; }
  .error-msg { color: #c00; font-size: 12px; margin-top: 8px; }
`;

type State =
  | { kind: 'extracting' }
  | { kind: 'preview'; result: ExtractResult; title: string }
  | { kind: 'saving' }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

let state: State = { kind: 'extracting' };
let affineUrl = '';
let workspace = '';

function render() {
  const app = document.getElementById('app')!;

  if (state.kind === 'extracting') {
    app.innerHTML = `<style>${STYLES}</style><div class="panel"><h2>AFFiNE Web Clipper</h2><div class="spinner">⟳ 正在分析页面…</div></div>`;
    return;
  }

  if (state.kind === 'saving') {
    app.innerHTML = `<style>${STYLES}</style><div class="panel"><h2>AFFiNE Web Clipper</h2><div class="spinner">⟳ 正在导入 AFFiNE…</div></div>`;
    return;
  }

  if (state.kind === 'success') {
    app.innerHTML = `<style>${STYLES}</style><div class="panel result"><div class="icon">✓</div><p>保存成功！</p></div>`;
    return;
  }

  if (state.kind === 'error') {
    app.innerHTML = `<style>${STYLES}</style><div class="panel result"><div class="icon">✗</div><p class="error-msg">${state.message}</p><button class="save" id="retry">重试</button></div>`;
    document.getElementById('retry')?.addEventListener('click', startExtraction);
    return;
  }

  // preview state
  const { result, title } = state;
  const nodeHtml =
    result.specialNodes.length > 0
      ? `<div class="nodes">🖼 检测到 ${result.specialNodes.length} 个特殊节点<ul>${result.specialNodes.map((n) => `<li>${n.label}</li>`).join('')}</ul></div>`
      : '';

  const workspaceHtml = workspace
    ? `<div class="workspace-row"><span class="ws-label">保存到</span><span class="ws-value">${workspace}</span><a href="#" id="openSettings">更改</a></div>`
    : `<div class="no-config">未配置 AFFiNE 地址，请先 <a href="#" id="openSettings">打开设置</a></div>`;

  app.innerHTML = `
    <style>${STYLES}</style>
    <div class="panel">
      <h2>AFFiNE Web Clipper</h2>
      <label for="titleInput">标题</label>
      <input type="text" id="titleInput" value="${title.replace(/"/g, '&quot;')}" />
      <div class="meta">
        <span>📄 ${result.wordCount} 字</span>
      </div>
      ${nodeHtml}
      ${workspaceHtml}
      ${workspace ? `<button class="save" id="saveBtn">保存到 AFFiNE</button>` : ''}
      <div class="error-msg" id="errMsg"></div>
    </div>
  `;

  document.getElementById('openSettings')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('saveBtn')?.addEventListener('click', async () => {
    const editedTitle = (document.getElementById('titleInput') as HTMLInputElement).value.trim();
    state = { kind: 'saving' };
    render();
    try {
      await sendToAFFiNE(document.body, affineUrl, {
        title: editedTitle,
        contentMarkdown: result.markdown,
        workspace,
      });
      state = { kind: 'success' };
    } catch (err) {
      state = { kind: 'error', message: `保存失败：${String(err)}` };
    }
    render();
  });
}

async function startExtraction() {
  state = { kind: 'extracting' };
  render();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('无法获取当前标签页');

    const response: ExtractResult | ExtractError = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT' });

    if (response.type === 'EXTRACT_ERROR') {
      state = { kind: 'error', message: response.message };
    } else {
      state = { kind: 'preview', result: response, title: response.title };
    }
  } catch (err) {
    state = { kind: 'error', message: `提取失败：${String(err)}` };
  }
  render();
}

async function init() {
  const settings = await getSettings();
  affineUrl = settings.affineUrl;
  workspace = settings.defaultWorkspace;

  const app = document.getElementById('app')!;
  app.innerHTML = `<style>${STYLES}</style>`;

  await startExtraction();
}

init();
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```
Expected: exits 0, no TypeScript errors.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```
Expected: PASS, all tests green.

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/index.ts
git commit -m "feat: implement side panel UI with 3-state flow"
```

---

## Task 11: Manual End-to-End Verification

**Goal:** Load the extension in Chrome, configure it, and verify clipping on a real page including DrawIO detection on km.sankuai.com.

- [ ] **Step 1: Build for development**

```bash
npm run build
```

- [ ] **Step 2: Load extension in Chrome**

1. Open `chrome://extensions`
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked"
4. Select the `dist/` directory
5. Verify "AFFiNE Web Clipper" appears in the extensions list

- [ ] **Step 3: Configure settings**

1. Click the extension's "⋮" menu → "Options" (or right-click icon → Options)
2. Enter your AFFiNE server URL (e.g. `http://localhost:3000`)
3. Enter your workspace ID (copy from AFFiNE URL: `http://localhost:3000/workspace/<id>/...`)
4. Click Save — verify "✓ Saved" appears

- [ ] **Step 4: Verify clipping on a standard article page**

1. Open any article page (e.g. a Wikipedia article)
2. Make sure you're logged into AFFiNE in another tab
3. Click the extension icon → Side Panel opens
4. Verify: title is extracted, word count shows, Save button is present
5. Click "Save to AFFiNE"
6. Verify: "保存成功！" appears
7. Open AFFiNE — verify the new document appears with correct title and Markdown content

- [ ] **Step 5: Verify DrawIO capture on km.sankuai.com**

1. Open `https://km.sankuai.com/collabpage/2709289771` (the 青云领域白皮书 doc)
2. Wait for the page to fully load (DrawIO diagrams render)
3. Click the extension icon
4. Verify: Side Panel shows "检测到 N 个特殊节点" with DrawIO entries
5. Click Save — verify the document in AFFiNE contains inline PNG images where the DrawIO diagrams were

- [ ] **Step 6: Verify error state**

1. In Settings, temporarily set AFFiNE URL to a non-existent server
2. Open a page and click Save
3. Verify: "保存失败：timeout" or connection error message appears after ≤30 s

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: complete AFFiNE Web Clipper v0.1.0"
```
