export interface AFFiNEPayload {
  title: string;
  contentMarkdown: string;
  workspace: string;
}

const LOAD_TIMEOUT_MS = 15_000;

export async function sendToAFFiNE(
  affineUrl: string,
  payload: AFFiNEPayload
): Promise<void> {
  if (!affineUrl) throw new Error('AFFiNE URL not configured');

  // Remember the current active tab so we can restore focus after the import.
  const [originalTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Open AFFiNE in a FOREGROUND tab (active: true).
  // Background tabs (active: false) are throttled by Chrome — JS timers fire at
  // 1 Hz and React initialization can be suspended entirely, so AFFiNE's
  // window.addEventListener handler never runs and our postMessage is lost.
  // A foreground tab runs at full speed. We close it automatically after import.
  const tab = await chrome.tabs.create({
    url: `${affineUrl}/clipper/import`,
    active: true,
  });
  const tabId = tab.id!;

  const closeTab = async () => {
    await chrome.tabs.remove(tabId).catch(() => {});
    // Restore the original tab so the user sees their article again.
    if (originalTab?.id) {
      await chrome.tabs.update(originalTab.id, { active: true }).catch(() => {});
    }
  };

  // Wait for the page to finish loading.
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
    // Inject a script into the AFFiNE tab that sends the import message and
    // awaits the success reply. world:'MAIN' runs in the page's own JS context,
    // avoiding any isolated-world / MessagePort transfer complications.
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
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
        '导入超时 — 请在刚打开的 AFFiNE 页面中确认是否已登录并选择了工作区'
      );
    }
  } finally {
    await closeTab();
  }
}
