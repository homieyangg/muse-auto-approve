'use strict';

const ALWAYS_RE = /^(一律允許|永久允許|總是允許|始終允許|永遠允許|一律允许|永久允许|总是允许|始终允许|always allow|allow always)/i;
const ONCE_RE = /^(允許|允许|allow)( ?(一次|本次|此次|once|this time))?$/i;
const DENY_RE = /^(拒絕|拒绝|不允許|不允许|封鎖|阻擋|deny|reject|block|decline|don['’]t allow|do not allow)/i;
const CONTEXT_RE = /(網域|域名|網路|网络|網站|网站|連線|连接|存取|访问|外聯|外联|請求|请求|審批|审批|核准|批准|權限|权限|瀏覽器|浏览器|approv|domain|network|website|egress|request|access|permission|browser|https?:\/\/)/i;
const MAX_DEPTH = 6;
const MAX_CONTEXT_TEXT = 1500;
const RETRY_AFTER_MS = 5000;
const BUTTON_SELECTOR = 'button, [role="button"]';
const BACKGROUND_SURFACE_SELECTOR = '[data-testid="hatch-inline-approval-card"][data-hatch-background-approval-surface="true"]';
const REVIEW_RETRY_MS = 10000;
const REVIEW_BLOCK_MS = 10 * 60 * 1000;

let settings = { ...AAM.SETTINGS_DEFAULTS };
let allowOnce = [];
const handledAt = new WeakMap();
const waitingState = new Map();
let lastReviewAt = 0;
let lastClickedBanner = '';
let blockedBanner = { text: '', at: 0 };
let lastReported = null;
let writeQueue = Promise.resolve();

function labelOf(el) {
  return (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
}

function isClickable(el) {
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
  return el.getClientRects().length > 0;
}

function findAllowButtons(scope) {
  let always = null, once = null;
  for (const b of scope.querySelectorAll(BUTTON_SELECTOR)) {
    if (!isClickable(b)) continue;
    const text = labelOf(b);
    if (!always && ALWAYS_RE.test(text)) always = b;
    else if (!once && ONCE_RE.test(text)) once = b;
  }
  return always || once ? { always, once } : null;
}

// 從按鈕區往上找第一層有按鈕以外文字的容器（卡片本體），只用它判斷是不是外聯審批，不再往外爬
function approvalBody(node) {
  for (let i = 0; node && i < MAX_DEPTH; i++, node = node.parentElement) {
    let text = labelOf(node);
    for (const b of node.querySelectorAll(BUTTON_SELECTOR)) text = text.replace(labelOf(b), '');
    text = text.trim();
    if (!text) continue;
    return text.length <= MAX_CONTEXT_TEXT && CONTEXT_RE.test(text) ? node : null;
  }
  return null;
}

// 審批卡一定有拒絕鈕：從拒絕鈕往上找最近一層有允許鈕的容器，避免點到卡片外的「允許」
function approvalCards() {
  const cards = new Map();
  for (const deny of document.querySelectorAll(BUTTON_SELECTOR)) {
    if (!DENY_RE.test(labelOf(deny)) || !isClickable(deny)) continue;
    let node = deny.parentElement;
    for (let i = 0; node && i < MAX_DEPTH; i++, node = node.parentElement) {
      const buttons = findAllowButtons(node);
      if (!buttons) continue;
      const body = !cards.has(node) && approvalBody(node);
      if (body) cards.set(node, { ...buttons, body });
      break;
    }
  }
  return cards;
}

// 插件重新載入後，舊分頁裡殘留的這份 script 會失去 chrome.* 權限，自己停掉等分頁重新整理換新版
function contextAlive() {
  if (chrome.runtime?.id) return true;
  observer.disconnect();
  clearInterval(timer);
  return false;
}

// 掃描頁面上的審批卡：信任的按掉，不信任的列進等你決定
function scan() {
  if (!contextAlive()) return;
  const cards = settings.enabled ? [...approvalCards()] : [];
  const now = Date.now();
  const waiting = [];
  for (const [node, buttons] of cards) {
    const card = AAM.parseCard(labelOf(buttons.body));
    const key = AAM.cardKey(card);
    const onceOnly = allowOnce.includes(key);
    if (settings.mode === 'all' || onceOnly || AAM.isTrusted(settings, card)) {
      if (now - (handledAt.get(node) || 0) >= RETRY_AFTER_MS) approve(node, buttons, card, key, onceOnly);
    } else {
      waiting.push({ key, host: card.host, chat: card.chat, title: card.title });
    }
  }
  const banner = bannerText();
  const tracking = settings.enabled && settings.mode === 'trusted';
  // 其他聊天室的卡片收起來、只剩「檢閱」提示時保留等你決定，不能當成使用者已經處理
  if (!(tracking && !cards.length && banner && waitingState.size)) syncWaiting(waiting, now, tracking);
  if (!settings.enabled || !settings.openBackground) return;
  if (!cards.length) openBackgroundApproval(now, banner);
  else if (waiting.length === cards.length) blockedBanner = { text: lastClickedBanner || banner, at: now };
}

function approve(node, { always, once }, card, key, onceOnly) {
  const target = settings.preferAlways && !onceOnly ? (always || once) : (once || always);
  handledAt.set(node, Date.now());
  target.click();
  console.info('[MAA] approved', card.host || card.title, card.chat);
  waitingState.delete(key);
  const entry = { ts: Date.now(), key, host: card.host, chat: card.chat, title: card.title, result: 'allowed', kind: target === always ? 'always' : 'once' };
  updateLocal({ log: [], approvals: 0, allowOnce: [] }, data => {
    const log = data.log.filter(e => !(e.key === key && e.result === 'pending'));
    const patch = { log: [entry, ...log].slice(0, AAM.LOG_LIMIT), approvals: data.approvals + 1 };
    if (onceOnly) patch.allowOnce = data.allowOnce.filter(k => k !== key);
    return patch;
  });
}

// 跟上一輪比對：新出現的記成等你決定，消失的代表使用者自己在 muse 處理了，最後回報給背景算工具列數字
function syncWaiting(waiting, now, tracking) {
  if (!tracking) waiting = [];
  const seen = new Set(waiting.map(w => w.key));
  const added = waiting.filter(w => !waitingState.has(w.key));
  const gone = tracking ? [...waitingState.keys()].filter(k => !seen.has(k)) : [];
  if (!tracking) waitingState.clear();
  for (const w of added) waitingState.set(w.key, { ...w, ts: now });
  for (const k of gone) waitingState.delete(k);
  if (!waitingState.size) blockedBanner = { text: '', at: 0 };
  if (added.length || gone.length) recordWaitingChanges(added, gone);
  const items = [...waitingState.values()];
  const report = items.map(i => i.key).join('\n');
  if (report === lastReported) return;
  lastReported = report;
  chrome.runtime.sendMessage({ type: 'pending', items }).catch(() => {});
}

function recordWaitingChanges(added, gone) {
  updateLocal({ log: [], dismissed: [] }, data => {
    const log = data.log.map(e => (gone.includes(e.key) && e.result === 'pending' ? { ...e, result: 'handled' } : e));
    const fresh = added.map(w => ({ ts: Date.now(), key: w.key, host: w.host, chat: w.chat, title: w.title, result: 'pending' }));
    return { log: [...fresh, ...log].slice(0, AAM.LOG_LIMIT), dismissed: data.dismissed.filter(k => waitingState.has(k)) };
  });
}

function bannerText() {
  const el = document.querySelector(BACKGROUND_SURFACE_SELECTOR);
  return el ? labelOf(el) : '';
}

// 別的聊天室來的審批在這裡只顯示「N 項工作需要檢閱」，先點檢閱把卡片叫出來；叫出來都不信任的話，同一個提示 10 分鐘內不再點
function openBackgroundApproval(now, banner) {
  if (!banner || now - lastReviewAt < REVIEW_RETRY_MS) return;
  if (banner === blockedBanner.text && now - blockedBanner.at < REVIEW_BLOCK_MS) return;
  const review = document.querySelector(`${BACKGROUND_SURFACE_SELECTOR} button`);
  if (!review || !isClickable(review)) return;
  lastReviewAt = now;
  lastClickedBanner = banner;
  review.click();
}

// content script 裡多個地方會同時改 local storage，排隊寫入避免互相蓋掉
function updateLocal(defaults, fn) {
  writeQueue = writeQueue
    .then(() => (contextAlive() ? chrome.storage.local.get(defaults) : null))
    .then(data => (data ? chrome.storage.local.set(fn(data)) : null))
    .catch(() => {});
}

let pending = null;
function scheduleScan() {
  if (pending) return;
  pending = setTimeout(() => { pending = null; scan(); }, 300);
}

const observer = new MutationObserver(scheduleScan);
observer.observe(document.documentElement, { childList: true, subtree: true });
const timer = setInterval(scan, 2000);

chrome.storage.sync.get(AAM.SETTINGS_DEFAULTS, stored => {
  settings = stored;
  scheduleScan();
});
chrome.storage.local.get({ allowOnce: [] }, stored => {
  allowOnce = stored.allowOnce;
  scheduleScan();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    for (const key of Object.keys(AAM.SETTINGS_DEFAULTS)) if (changes[key]) settings[key] = changes[key].newValue ?? AAM.SETTINGS_DEFAULTS[key];
  }
  if (area === 'local' && changes.allowOnce) allowOnce = changes.allowOnce.newValue || [];
  if (area === 'sync' || (area === 'local' && changes.allowOnce)) {
    blockedBanner = { text: '', at: 0 };
    lastReviewAt = 0;
    scheduleScan();
  }
});
