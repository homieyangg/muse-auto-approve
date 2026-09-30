'use strict';

importScripts('shared.js');

const BADGE_COLOR = '#dc2626';
let sessionQueue = Promise.resolve();
let setupRun = null;

// 1.0.0 的設定放在 local；sync 還沒有模式的話沿用「全部允許」，讓升級後行為不變
async function migrateFromV1(local, mode) {
  if (!mode) await chrome.storage.sync.set({ mode: 'all', enabled: local.enabled ?? true, preferAlways: local.preferAlways ?? true });
  const log = (local.log || []).map(e => {
    if (e.result) return e;
    const card = AAM.parseCard(e.summary);
    return { ts: e.ts, key: AAM.cardKey(card), ...card, result: 'allowed', kind: e.kind };
  });
  await chrome.storage.local.set({ log, approvals: (local.approvals || 0) + (local.count || 0), installedAt: local.installedAt || Date.now(), welcomeShown: true });
  await chrome.storage.local.remove(['enabled', 'preferAlways', 'count']);
}

// 用資料判斷是新安裝還是從 1.0.0 升級，不看 onInstalled 的 reason：命令列載入的未封裝插件每次重開瀏覽器都會收到 install
async function ensureSetup() {
  const [{ mode }, local] = await Promise.all([chrome.storage.sync.get('mode'), chrome.storage.local.get(null)]);
  const legacy = ['count', 'enabled', 'preferAlways'].some(k => k in local) || (local.log || []).some(e => !e.result);
  if (legacy) return migrateFromV1(local, mode);
  if (mode || local.welcomeShown) return;
  await chrome.storage.sync.set({ mode: 'trusted' });
  await chrome.storage.local.set({ installedAt: Date.now(), welcomeShown: true });
  chrome.tabs.create({ url: 'welcome.html' });
}

// 啟動時 onInstalled 和 onStartup 可能同時觸發，共用同一次執行，免得開出兩個歡迎頁
function runSetup() {
  setupRun = setupRun || ensureSetup().finally(() => { setupRun = null; });
  return setupRun.then(refreshBadge).catch(e => console.error('[MAA] setup failed', e));
}

async function refreshBadge() {
  const [{ pendingByTab }, { dismissed }, { enabled }] = await Promise.all([
    chrome.storage.session.get({ pendingByTab: {} }),
    chrome.storage.local.get({ dismissed: [] }),
    chrome.storage.sync.get({ enabled: true }),
  ]);
  const count = enabled ? AAM.mergePending(pendingByTab, dismissed).length : 0;
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
}

// 每個分頁各自回報看到的等你決定，排隊寫入避免兩個分頁同時回報時互相蓋掉
function setTabPending(tabId, items) {
  sessionQueue = sessionQueue
    .then(async () => {
      const { pendingByTab } = await chrome.storage.session.get({ pendingByTab: {} });
      if (items.length) pendingByTab[tabId] = items;
      else if (pendingByTab[tabId]) delete pendingByTab[tabId];
      else return;
      await chrome.storage.session.set({ pendingByTab });
    })
    .then(refreshBadge)
    .catch(e => console.error('[MAA] setTabPending failed', e));
}

chrome.runtime.onInstalled.addListener(runSetup);

chrome.runtime.onStartup.addListener(runSetup);

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'pending' && sender.tab) setTabPending(sender.tab.id, Array.isArray(msg.items) ? msg.items : []);
});

chrome.tabs.onRemoved.addListener(tabId => setTabPending(tabId, []));

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') setTabPending(tabId, []);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'sync' && (changes.enabled || changes.mode)) || (area === 'local' && changes.dismissed)) refreshBadge();
});
