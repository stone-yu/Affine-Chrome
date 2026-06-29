// Globally disable the side panel at startup so it doesn't appear on every
// tab by default (the manifest's default_path would otherwise enable it globally).
chrome.sidePanel.setOptions({ enabled: false }).catch(console.error);
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);

// On every browser start, re-apply the global disable (service worker can restart).
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setOptions({ enabled: false }).catch(console.error);
});

// When the user clicks the extension icon, enable and open the panel only
// for that specific tab — it won't appear on any other tab.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  await chrome.sidePanel.setOptions({
    tabId: tab.id,
    enabled: true,
    path: 'sidepanel.html',
  }).catch(console.error);
  chrome.sidePanel.open({ tabId: tab.id }).catch(console.error);
});
