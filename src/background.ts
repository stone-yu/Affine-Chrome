// Globally disable the side panel so it doesn't appear on every tab by default.
// The manifest's default_path would otherwise enable it globally.
chrome.sidePanel.setOptions({ enabled: false }).catch(console.error);
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);

// Re-apply on browser start (service worker may restart and lose state).
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ enabled: false }).catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setOptions({ enabled: false }).catch(console.error);
});

// Execute code in the page's MAIN world on behalf of content scripts.
// Content scripts run in an isolated world and cannot access React fiber
// (element.__reactFiber$HASH).  chrome.scripting.executeScript bypasses CSP
// and runs in the main world, where React fiber IS accessible.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type !== 'EXTRACT_MAIN_WORLD') return;
  const tabId = sender.tab?.id;
  if (!tabId) { sendResponse({ data: null }); return true; }

  chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    // NOTE: func is serialised and run in the browser — no external variable refs allowed.
    func: () => {
      function getNode(el: Element): any {
        const k = Object.getOwnPropertyNames(el).find(
          key => key.startsWith('__reactFiber') || key.startsWith('__reactInternalInstance')
        );
        if (!k) return null;
        let f: any = (el as any)[k];
        for (let d = 0; f && d < 120; d++, f = f.return) {
          if (f.memoizedProps?.node) return f.memoizedProps.node;
        }
        return null;
      }
      function getText(node: any): string {
        if (typeof node.textContent === 'string' && node.textContent) return node.textContent;
        let t = '';
        if (node.content?.forEach) node.content.forEach((c: any) => { t += c.text ?? ''; });
        return t;
      }

      const codeBlocks: { lang: string; code: string }[] = [];
      document.querySelectorAll('div.pk-code').forEach(el => {
        // Strategy 1: CodeMirror API — most reliable, gives the FULL source including
        // lines not rendered in the DOM (CodeMirror v5 uses virtual scrolling).
        const cmEl = el.querySelector('.CodeMirror') as any;
        if (cmEl?.CodeMirror) {
          const code: string = cmEl.CodeMirror.getValue();
          if (code) {
            // Language: look for a Latin token in non-PRE children (e.g. "代码块SQL" → "SQL").
            let lang = '';
            for (const child of Array.from(el.children)) {
              if ((child as HTMLElement).tagName === 'PRE') continue;
              const tokens = ((child as HTMLElement).textContent ?? '').match(/[A-Za-z][A-Za-z0-9+#._-]*/g) ?? [];
              for (const t of tokens) {
                if (/^[A-Za-z][A-Za-z0-9+#._-]{0,18}$/.test(t) && new Set(t.toLowerCase()).size >= 2) {
                  lang = t.toLowerCase(); break;
                }
              }
              if (lang) break;
            }
            codeBlocks.push({ lang, code });
            return;
          }
        }
        // Strategy 2: React fiber (fallback for non-CodeMirror code blocks).
        const node = getNode(el);
        if (!node) return;
        const attrs = (node.attrs ?? {}) as Record<string, string>;
        const lang = (attrs.language ?? attrs.lang ?? attrs.params ?? '').toLowerCase();
        const code = getText(node);
        if (code) codeBlocks.push({ lang, code });
      });

      const htmlBlocks: { html: string }[] = [];
      document.querySelectorAll('.pk-html').forEach(el => {
        const node = getNode(el);
        if (!node) return;
        const attrs = (node.attrs ?? {}) as Record<string, string>;
        const src = attrs.html ?? attrs.content ?? attrs.htmlContent ?? getText(node);
        if (src?.includes?.('<')) htmlBlocks.push({ html: src });
      });

      // Mermaid blocks: get attachmentId so content script can load the same-origin
      // km.sankuai.com/block/mermaid/{id} preview page and extract the SVG.
      // Multiple strategies because the fiber depth / prop name varies by Citadel version.
      const mermaidBlocks: { attachmentId: string }[] = [];

      function extractAttachmentId(el: Element): string {
        // Strategy 1: look for an anchor/element whose href/src/data-* contains the Mermaid URL.
        // Citadel embeds a "点击在新窗口打开" link inside the block.
        for (const child of Array.from(el.querySelectorAll('a, [href], [data-url], [data-href]'))) {
          for (const attr of Array.from(child.attributes)) {
            const m = attr.value.match(/\/block\/mermaid\/(\d+)/);
            if (m) return m[1];
          }
        }
        // Strategy 2: scan ALL attributes of ALL descendants for the Mermaid URL pattern.
        for (const child of Array.from(el.querySelectorAll('*'))) {
          for (const attr of Array.from(child.attributes)) {
            const m = attr.value.match(/\/block\/mermaid\/(\d+)/);
            if (m) return m[1];
          }
        }
        // Strategy 3: React fiber — walk BOTH up (return) and down (child/sibling).
        const k = Object.getOwnPropertyNames(el).find(
          key => key.startsWith('__reactFiber') || key.startsWith('__reactInternalInstance'),
        );
        if (k) {
          const visited = new Set<any>();
          const queue: any[] = [(el as any)[k]];
          while (queue.length > 0) {
            const f = queue.shift();
            if (!f || visited.has(f)) continue;
            visited.add(f);
            // Check props
            for (const props of [f.memoizedProps, f.pendingProps]) {
              if (!props) continue;
              const node = props.node;
              if (node?.attrs?.attachmentId) return String(node.attrs.attachmentId);
              if (props.attachmentId) return String(props.attachmentId);
              // Scan props shallowly for any object with attachmentId
              for (const v of Object.values(props)) {
                if (v && typeof v === 'object' && (v as any).attachmentId) {
                  return String((v as any).attachmentId);
                }
              }
            }
            // Check hooks (memoizedState linked list)
            let s = f.memoizedState;
            for (let sd = 0; s && sd < 20; sd++, s = s.next) {
              const v = s.memoizedState;
              if (v?.node?.attrs?.attachmentId) return String(v.node.attrs.attachmentId);
              if (v?.attachmentId) return String(v.attachmentId);
            }
            // Explore neighbors (limit depth to avoid traversing entire tree)
            if (visited.size < 300) {
              if (f.child) queue.push(f.child);
              if (f.sibling) queue.push(f.sibling);
              if (f.return) queue.push(f.return);
            }
          }
        }
        return '';
      }

      document.querySelectorAll('div.ct-node-view-dom[data-type]:not([data-type=""])').forEach(el => {
        const id = extractAttachmentId(el);
        console.log(`[AFFiNE Clipper] Mermaid el class="${el.getAttribute('class')}" id="${id}"`);
        if (id) mermaidBlocks.push({ attachmentId: id });
      });

      return { codeBlocks, htmlBlocks, mermaidBlocks };
    },
  })
    .then(([result]) => sendResponse({ data: result?.result ?? null }))
    .catch(err => {
      console.error('[AFFiNE Clipper] EXTRACT_MAIN_WORLD error:', err);
      sendResponse({ data: null });
    });
  return true; // async response
});

// On click: enable + open for this tab only.
// IMPORTANT: no async/await here — sidePanel.open() must be called
// synchronously within the user-gesture handler or Chrome rejects it.
// Both IPC calls are fire-and-forget; Chrome processes them in order,
// so setOptions({enabled:true}) is applied before open() takes effect.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.sidePanel
    .setOptions({ tabId: tab.id, enabled: true, path: 'sidepanel.html' })
    .catch(console.error);
  chrome.sidePanel.open({ tabId: tab.id }).catch(console.error);
});
