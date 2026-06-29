export interface AFFiNEPayload {
  title: string;
  contentMarkdown: string;
  workspace: string;
}

const LOAD_TIMEOUT_MS = 15_000;
const IMPORT_TIMEOUT_MS = 30_000;

export async function sendToAFFiNE(
  affineUrl: string,
  payload: AFFiNEPayload
): Promise<void> {
  if (!affineUrl) throw new Error('AFFiNE URL not configured');

  // Open AFFiNE in a background tab rather than a hidden iframe.
  // Iframes inside extension pages inherit the extension's strict MV3 CSP
  // (script-src 'self' …), which blocks any external JS the AFFiNE page loads.
  // A separate browser tab runs under the remote server's own CSP instead.
  const tab = await chrome.tabs.create({
    url: `${affineUrl}/clipper/import`,
    active: false,
  });
  const tabId = tab.id!;
  const closeTab = () => chrome.tabs.remove(tabId).catch(() => {});

  // Wait for the page to finish loading before injecting our script.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      closeTab();
      reject(new Error('页面加载超时，请检查 AFFiNE 地址是否正确且服务正在运行'));
    }, LOAD_TIMEOUT_MS);

    function listener(id: number, info: chrome.tabs.TabChangeInfo) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });

  try {
    // Inject a script into the AFFiNE tab that:
    //   1. Sends the import postMessage (with a MessagePort so AFFiNE uses the
    //      port path rather than its window.postMessage fallback)
    //   2. Waits for the success reply
    //   3. Returns true/false to the caller
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (p: { title: string; contentMarkdown: string; workspace: string }) => {
        return new Promise<boolean>((resolve) => {
          const channel = new MessageChannel();

          // Path 1: AFFiNE replies via the transferred MessagePort
          channel.port1.onmessage = (e: MessageEvent) => {
            if (e?.data?.type === 'affine-clipper:import:success') resolve(true);
          };

          // Path 2: AFFiNE replies via window.postMessage (fallback)
          const onMsg = (ev: MessageEvent) => {
            if (ev?.data?.type === 'affine-clipper:import:success') {
              window.removeEventListener('message', onMsg);
              resolve(true);
            }
          };
          window.addEventListener('message', onMsg);

          window.postMessage(
            { type: 'affine-clipper:import', payload: p },
            location.origin,
            [channel.port2]
          );

          // Inner timeout slightly shorter than the outer so we can report cleanly
          setTimeout(() => {
            window.removeEventListener('message', onMsg);
            resolve(false);
          }, 28_000);
        });
      },
      args: [payload],
    });

    if (!results?.[0]?.result) {
      throw new Error(
        'timeout — 请确认：① 已在浏览器中登录 AFFiNE；② AFFiNE 地址正确；③ 自托管版本支持 Clipper 功能（需较新版本）'
      );
    }
  } finally {
    closeTab();
  }
}
