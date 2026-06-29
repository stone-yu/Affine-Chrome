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
