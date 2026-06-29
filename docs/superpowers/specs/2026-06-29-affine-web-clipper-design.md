# AFFiNE Web Clipper Chrome Extension — Design Spec

**Date**: 2026-06-29  
**Status**: Approved

---

## Overview

A from-scratch Chrome extension that clips any web page into a self-hosted AFFiNE instance. Core capability: article text is saved as Markdown; special rendered nodes (DrawIO, Mermaid, PlantUML, chart SVGs) are captured as PNG images via html2canvas and embedded inline.

---

## Goals

- Clip any web page (text + images) into a self-hosted AFFiNE workspace
- Detect and screenshot special rendered nodes that cannot be expressed as Markdown
- Zero modifications to AFFiNE server — communicate via the existing iframe + postMessage protocol
- Lightweight: no UI framework, minimal dependencies

## Non-Goals

- AFFiNE Cloud support (self-hosted only)
- Modifying AFFiNE source code
- Full-page screenshot mode
- Video / audio capture

---

## Architecture

### Directory Structure

```
affine-chrome/
├── src/
│   ├── background.ts              # Service Worker: opens side panel, message routing
│   ├── sidepanel/
│   │   ├── index.html
│   │   └── index.ts               # Preview UI, workspace selector, save trigger
│   ├── content/
│   │   ├── extractor.ts           # Readability article extraction
│   │   ├── markdown.ts            # Turndown HTML→Markdown conversion
│   │   ├── special-nodes.ts       # Special node detection + html2canvas capture
│   │   └── index.ts               # Content script entry, message handler
│   ├── utils/
│   │   ├── affine.ts              # AFFiNE iframe + postMessage communication
│   │   └── storage.ts             # chrome.storage.sync wrapper
│   └── settings/
│       ├── index.html
│       └── index.ts               # Settings page: AFFiNE URL, default workspace
├── manifest.json
├── package.json
├── tsconfig.json
└── webpack.config.js
```

### Message Flow

```
User clicks icon
  → background.ts opens Side Panel

Side Panel loads
  → sends { type: 'EXTRACT' } to content script

content/index.ts
  → extractor.ts: Readability.parse(document.cloneNode(true))
  → special-nodes.ts: find nodes in original DOM, replace with placeholders in clone
  → markdown.ts: Turndown(article.content) → markdown with affine-img://node-N refs
  → special-nodes.ts: html2canvas each original node → PNG base64
  → replace affine-img://node-N in markdown with data:image/png;base64,...
  → return { title, markdown, specialNodeCount, nodeLabels }

Side Panel renders preview
  → user edits title (optional), selects workspace, clicks Save

affine.ts
  → create hidden iframe: src = `${affineUrl}/clipper/import`
  → iframe onload → postMessage { type: 'affine-clipper:import', payload: { title, contentMarkdown, workspace } }
  → listen for 'affine-clipper:import:success' → show success state
  → timeout 30s → show error state
```

---

## Components

### `background.ts`

- Registers `chrome.action.onClicked` to toggle the side panel
- Routes messages between content script and side panel where needed

### `sidepanel/index.ts`

Three UI states:

1. **Extracting**: spinner while content script processes the page
2. **Preview**: editable title, word count, special node summary (e.g. "DrawIO × 2, Mermaid × 1"), workspace dropdown, Save button
3. **Result**: success (with "Open in AFFiNE" link) or error with retry

Workspace ID is loaded from `chrome.storage.sync`. If not configured, shows "Configure AFFiNE URL in Settings ⚙" prompt instead of Save button.

### `content/special-nodes.ts`

Maintains a rule table of special node selectors:

```ts
const SPECIAL_NODE_RULES: NodeRule[] = [
  { match: 'km.sankuai.com', selector: '[data-node-type="drawio"]' },
  { match: '*', selector: '.mermaid > svg, [class*="mermaid"] > svg' },
  { match: '*', selector: 'img[src*="plantuml"]' },
  { match: '*', selector: '.chart-container svg, .diagram-container svg' },
];
```

**Capture process**:
1. Find matching nodes in the original DOM
2. In a cloned document, replace each with `<img src="affine-img://node-N" alt="{label}" />`
3. Run Readability + Turndown on the clone → produces `![label](affine-img://node-N)` in Markdown
4. Back on the original DOM, run `html2canvas(node, { useCORS: true, scale: window.devicePixelRatio })` on each node (wait for `offsetHeight > 0`)
5. Replace `affine-img://node-N` refs in Markdown with the PNG data URIs

### `utils/affine.ts`

```ts
async function sendToAFFiNE(
  affineUrl: string,
  payload: { title: string; contentMarkdown: string; workspace: string }
): Promise<void>
```

Creates a hidden `<iframe>` in the side panel document, waits for load, sends postMessage, awaits success reply or 30s timeout, then removes the iframe.

### `settings/index.ts`

Form with two fields:
- **AFFiNE URL** — validated as a valid URL, saved to `chrome.storage.sync`
- **Default Workspace** — free-text workspace ID (user copies from AFFiNE URL)

---

## Data Structures

```ts
// Message from side panel to content script
interface ExtractRequest {
  type: 'EXTRACT';
}

// Message from content script to side panel
interface ExtractResult {
  type: 'EXTRACT_RESULT';
  title: string;
  markdown: string;           // final markdown with data URIs already substituted
  wordCount: number;
  specialNodes: { label: string; kind: string }[]; // for preview display
}

// chrome.storage.sync
interface Settings {
  affineUrl: string;          // e.g. 'http://localhost:3000'
  defaultWorkspace: string;   // workspace ID
}
```

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@mozilla/readability` | latest | Article body extraction |
| `turndown` | latest | HTML → Markdown |
| `html2canvas` | latest | Special node PNG capture |
| `webpack` | 5 | Build bundling |
| `ts-loader` | latest | TypeScript compilation |

No UI framework. Vanilla TypeScript + CSS.

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Readability extracts nothing | Show "Could not extract article content" in side panel |
| html2canvas fails on a node | Skip that node, log warning, continue with rest |
| AFFiNE iframe timeout (30s) | Show error state with retry button |
| AFFiNE URL not configured | Show "Set up AFFiNE URL in Settings" prompt |
| Special node not yet rendered (offsetHeight = 0) | Retry up to 3× with 500ms delay, then skip |

---

## Manifest (v3)

```json
{
  "manifest_version": 3,
  "name": "AFFiNE Web Clipper",
  "version": "0.1.0",
  "permissions": ["sidePanel", "activeTab", "scripting", "storage"],
  "side_panel": { "default_path": "sidepanel.html" },
  "background": { "service_worker": "background.js" },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "action": { "default_title": "AFFiNE Web Clipper" }
}
```

---

## Open Questions

None — all design decisions resolved.
