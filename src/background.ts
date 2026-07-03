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
      const pkCodeEls = document.querySelectorAll('div.pk-code');
      console.log(`[AFFiNE Clipper] pk-code elements found: ${pkCodeEls.length}`);

      pkCodeEls.forEach((el, idx) => {
        // Strategy 1: CodeMirror API — most reliable, gives the FULL source including
        // lines not rendered in the DOM (CodeMirror v5 uses virtual scrolling).
        const cmEl = el.querySelector('.CodeMirror') as any;
        const cm = cmEl?.CodeMirror;
        console.log(`[AFFiNE Clipper] pk-code[${idx}]: cmEl=${!!cmEl} cm=${!!cm}`);

        if (cm) {
          try {
            // Force CodeMirror to refresh and recalculate its full content.
            // This ensures getValue() returns all text even when the editor is collapsed.
            try { cm.refresh(); } catch { /* ignore refresh errors */ }
            const code: string = cm.getValue() ?? cm.doc?.getValue() ?? '';
            console.log(`[AFFiNE Clipper] pk-code[${idx}]: getValue() len=${code.length}`);
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
          } catch (e) {
            console.warn(`[AFFiNE Clipper] pk-code[${idx}]: CodeMirror API error`, e);
          }
        }

        // Strategy 1b: force-render all lines by expanding the scroll container,
        // then read the full content from the CM doc directly.
        if (cm) {
          try {
            const scroller = el.querySelector('.CodeMirror-scroll') as HTMLElement | null;
            if (scroller) {
              const origH = scroller.style.maxHeight;
              scroller.style.maxHeight = '20000px';
              cm.refresh();
              const code: string = cm.getValue() ?? '';
              scroller.style.maxHeight = origH;
              console.log(`[AFFiNE Clipper] pk-code[${idx}]: after expand, code len=${code.length}`);
              if (code) {
                codeBlocks.push({ lang: '', code });
                return;
              }
            }
          } catch (e) {
            console.warn(`[AFFiNE Clipper] pk-code[${idx}]: expand strategy error`, e);
          }
        }

        // Strategy 2: React fiber (fallback for non-CodeMirror code blocks).
        const node = getNode(el);
        if (!node) { console.warn(`[AFFiNE Clipper] pk-code[${idx}]: no fiber node`); return; }
        const attrs = (node.attrs ?? {}) as Record<string, string>;
        const lang = (attrs.language ?? attrs.lang ?? attrs.params ?? '').toLowerCase();
        const code = getText(node);
        console.log(`[AFFiNE Clipper] pk-code[${idx}]: fiber code len=${code.length}`);
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
      const mermaidBlocks: { attachmentId: string }[] = [];
      const seenIds = new Set<string>();

      // Strategy A (primary): traverse ProseMirror document state.
      // The PM state has ALL nodes with their full attrs regardless of DOM visibility.
      // Walk up from .ProseMirror element's fiber until we find a component whose props/state
      // contain a ProseMirror state object (has state.doc with a descendants() method).
      const pmEl = document.querySelector('.ProseMirror');
      const pmFiberKey = pmEl
        ? Object.getOwnPropertyNames(pmEl).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'))
        : undefined;
      if (pmEl && pmFiberKey) {
        let fiber: any = (pmEl as any)[pmFiberKey];
        for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) {
          // Collect all values from props and hook states to search for a PM state
          const candidates: any[] = [];
          const props = fiber.memoizedProps;
          if (props) candidates.push(...Object.values(props));
          let hs = fiber.memoizedState;
          for (let hd = 0; hs && hd < 15; hd++, hs = hs.next) {
            if (hs.memoizedState != null) candidates.push(hs.memoizedState);
          }
          for (const c of candidates) {
            if (!c || typeof c !== 'object') continue;
            // PM state: has .doc.descendants (function)
            const doc = c.doc ?? c.state?.doc ?? c.editorState?.doc;
            if (typeof doc?.descendants === 'function') {
              doc.descendants((node: any) => {
                const id = node.attrs?.attachmentId;
                if (id && !seenIds.has(String(id))) {
                  seenIds.add(String(id));
                  mermaidBlocks.push({ attachmentId: String(id) });
                }
              });
              console.log(`[AFFiNE Clipper] PM doc traversal found ${mermaidBlocks.length} Mermaid blocks`);
              break;
            }
          }
          if (mermaidBlocks.length > 0) break;
        }
      }

      // Strategy B (fallback): scan ct-node-view-dom elements via direct attr + fiber BFS.
      if (mermaidBlocks.length === 0) {
        document.querySelectorAll('div.ct-node-view-dom[data-type]:not([data-type=""])').forEach(el => {
          // B0: check the element's OWN data-attachment-id attribute (simplest and most reliable).
          // HTML shows: <div class="ct-node-view-dom" data-attachment-id="244286845937" ...>
          const directId = el.getAttribute('data-attachment-id');
          if (directId && !seenIds.has(directId)) {
            seenIds.add(directId);
            mermaidBlocks.push({ attachmentId: directId });
            return;
          }
          // B1: check all descendant attributes for Mermaid URL pattern (el itself not in querySelectorAll)
          for (const attr of Array.from(el.attributes)) {         // also check el's own attrs
            const m = attr.value.match(/\/block\/mermaid\/(\d+)/);
            if (m && !seenIds.has(m[1])) { seenIds.add(m[1]); mermaidBlocks.push({ attachmentId: m[1] }); return; }
          }
          for (const child of Array.from(el.querySelectorAll('*'))) {
            for (const attr of Array.from(child.attributes)) {
              const m = attr.value.match(/\/block\/mermaid\/(\d+)/);
              if (m && !seenIds.has(m[1])) { seenIds.add(m[1]); mermaidBlocks.push({ attachmentId: m[1] }); return; }
            }
          }
          // B2: React fiber BFS on the element itself
          const k = Object.getOwnPropertyNames(el).find(key => key.startsWith('__reactFiber'));
          if (!k) return;
          const visited = new Set<any>();
          const queue: any[] = [(el as any)[k]];
          while (queue.length > 0) {
            const f = queue.shift();
            if (!f || visited.has(f) || visited.size > 400) continue;
            visited.add(f);
            for (const props of [f.memoizedProps, f.pendingProps]) {
              if (!props) continue;
              const id = props.node?.attrs?.attachmentId ?? props.attachmentId;
              if (id && !seenIds.has(String(id))) { seenIds.add(String(id)); mermaidBlocks.push({ attachmentId: String(id) }); return; }
            }
            let hs = f.memoizedState;
            for (let hd = 0; hs && hd < 10; hd++, hs = hs.next) {
              const v = hs.memoizedState;
              const id = v?.node?.attrs?.attachmentId ?? v?.attachmentId;
              if (id && !seenIds.has(String(id))) { seenIds.add(String(id)); mermaidBlocks.push({ attachmentId: String(id) }); return; }
            }
            if (f.child) queue.push(f.child);
            if (f.sibling) queue.push(f.sibling);
            if (f.return) queue.push(f.return);
          }
        });
      }
      console.log(`[AFFiNE Clipper] mermaidBlocks extracted: ${mermaidBlocks.length}`);

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
