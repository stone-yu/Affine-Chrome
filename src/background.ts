// sidePanel.open({ tabId }) is tab-specific: the panel is visible only while
// that tab is active and hides automatically when the user switches tabs.
// openPanelOnActionClick: false prevents Chrome from opening it globally
// (for the whole window) when the icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch(console.error);

// sidePanel.open() must be called synchronously inside a user-gesture handler —
// any await before it breaks that requirement.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(console.error);
  }
});
