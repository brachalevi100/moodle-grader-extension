// Background service worker.
const GRADER_RE = /^https:\/\/moodle\.cyber\.org\.il\/mod\/assign\/view\.php\?.*\baction=grader\b/;

// Clicking the toolbar icon opens the side panel.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

// Badge shows when the current tab is a Moodle grading page.
function updateBadge(tabId, url) {
  const on = GRADER_RE.test(url || '');
  chrome.action.setBadgeText({ tabId, text: on ? '✓' : '' });
  if (on) chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
}
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'complete') updateBadge(tabId, tab.url);
});
