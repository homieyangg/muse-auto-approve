'use strict';

const ALWAYS_RE = /^(一律允許|永久允許|總是允許|始終允許|永遠允許|一律允许|永久允许|总是允许|始终允许|always allow|allow always)/i;
const ONCE_RE = /^(允許|允许|allow)( ?(一次|本次|此次|once|this time))?$/i;
const DENY_RE = /^(拒絕|拒绝|不允許|不允许|封鎖|阻擋|deny|reject|block|decline|don['’]t allow|do not allow)/i;
const CONTEXT_RE = /(網域|域名|網路|网络|網站|网站|連線|连接|存取|访问|外聯|外联|請求|请求|審批|审批|核准|批准|權限|权限|瀏覽器|浏览器|approv|domain|network|website|egress|request|access|permission|browser|https?:\/\/)/i;
const MAX_DEPTH = 6;
const MAX_CONTEXT_TEXT = 1500;
const RETRY_AFTER_MS = 5000;
const LOG_LIMIT = 20;
const BUTTON_SELECTOR = 'button, [role="button"]';
const BACKGROUND_REVIEW_SELECTOR = '[data-testid="hatch-inline-approval-card"][data-hatch-background-approval-surface="true"] button';
const REVIEW_RETRY_MS = 10000;

let settings = { enabled: true, preferAlways: true };
const handledAt = new WeakMap();
let lastReviewAt = 0;

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

function scan() {
  if (!contextAlive() || !settings.enabled) return;
  const now = Date.now();
  let approved = false;
  for (const [card, { always, once, body }] of approvalCards()) {
    if (now - (handledAt.get(card) || 0) < RETRY_AFTER_MS) continue;
    const target = settings.preferAlways ? (always || once) : (once || always);
    handledAt.set(card, now);
    target.click();
    approved = true;
    record(target === always ? 'always' : 'once', labelOf(body).slice(0, 240));
  }
  if (!approved) openBackgroundApproval(now);
}

// 別的聊天室來的審批在這裡只顯示「N 項工作需要檢閱」，先點檢閱把卡片叫出來，下一輪 scan 再按允許
function openBackgroundApproval(now) {
  if (now - lastReviewAt < REVIEW_RETRY_MS) return;
  const review = document.querySelector(BACKGROUND_REVIEW_SELECTOR);
  if (!review || !isClickable(review)) return;
  lastReviewAt = now;
  review.click();
  console.info('[MAA] opened background approval');
}

function record(kind, summary) {
  console.info('[MAA] approved', kind, summary);
  if (!contextAlive()) return;
  chrome.storage.local.get({ count: 0, log: [] }, ({ count, log }) => {
    log.unshift({ ts: Date.now(), kind, summary });
    chrome.storage.local.set({ count: count + 1, log: log.slice(0, LOG_LIMIT) });
  });
}

let pending = null;
function scheduleScan() {
  if (pending) return;
  pending = setTimeout(() => { pending = null; scan(); }, 300);
}

const observer = new MutationObserver(scheduleScan);
observer.observe(document.documentElement, { childList: true, subtree: true });
const timer = setInterval(scan, 2000);

chrome.storage.local.get(settings, stored => {
  settings = { ...settings, ...stored };
  scan();
});
chrome.storage.onChanged.addListener(changes => {
  for (const key of Object.keys(settings)) {
    if (changes[key]) settings[key] = changes[key].newValue;
  }
  if (changes.enabled?.newValue) scan();
});
