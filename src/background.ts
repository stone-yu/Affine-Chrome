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
// Both calls must stay synchronous: sidePanel.open() requires a user gesture
// and loses that context after any await.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.sidePanel.setOptions({ tabId: tab.id, enabled: true, path: 'sidepanel.html' })
    .catch(console.error);
  chrome.sidePanel.open({ tabId: tab.id }).catch(console.error);
});
