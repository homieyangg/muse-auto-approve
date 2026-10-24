'use strict';

const ALWAYS_RE = /^(一律允許|永久允許|總是允許|始終允許|永遠允許|一律允许|永久允许|总是允许|始终允许|always allow|allow always)/i;
const ONCE_RE = /^(允許|允许|allow)( ?(一次|本次|此次|once|this time))?$/i;
// 連接器動作卡的拒絕鈕是「不要＋動作」，例如寄信卡的「不要傳送」，簡體是「不发送」
const DENY_RE = /^(拒絕|拒绝|不允許|不允许|不要|不发|封鎖|阻擋|deny|reject|block|decline|don['’]t |do not )/i;
const CONTEXT_RE = /(網域|域名|網路|网络|網站|网站|連線|连接|存取|访问|外聯|外联|請求|请求|審批|审批|核准|批准|權限|权限|瀏覽器|浏览器|approv|domain|network|website|egress|request|access|permission|browser|https?:\/\/)/i;
const MAX_DEPTH = 6;
const MAX_CONTEXT_TEXT = 1500;
const RETRY_AFTER_MS = 5000;
const SETTLE_MS = 1000;
const BUTTON_SELECTOR = 'button, [role="button"]';
// 連接器動作卡的允許鈕寫的是動作本身（例如傳送），文字認不出來，改認 muse 標的主要動作
const PRIMARY_SELECTOR = '[data-hatch-approval-primary-action="true"]';
const SUB_APPROVAL_SELECTOR = '[role="button"][aria-expanded]';
const MENU_SELECTOR = '[aria-haspopup="menu"]';
const PREVIEW_SELECTOR = 'button[aria-expanded="false"]';
const MENU_WAIT_MS = 1000;
const BACKGROUND_SURFACE_SELECTOR = '[data-testid="hatch-inline-approval-card"][data-hatch-background-approval-surface="true"]';
const CARD_SELECTOR = '[data-testid="hatch-inline-approval-card"]:not([data-hatch-background-approval-surface="true"])';
const REVIEW_RETRY_MS = 10000;
const REVIEW_BLOCK_MS = 10 * 60 * 1000;
// bridge.js 從 React 內部讀出來標在 DOM 上的審批 ID、權限種類和全部待審 ID
const ID_ATTR = 'data-maa-approval-id';
const POLICY_ATTR = 'data-maa-policy';
const PENDING_ATTR = 'data-maa-pending';
const SEEN_LIMIT = 2000;
const AVATAR_SELECTOR = '[data-hatch-avatar-interaction="true"]';
// 右側面板的分頁按鈕只有各語言的名稱可認
const APPROVALS_TAB_RE = /^(核可工具|批准|approvals)$/i;
// 只有副聊天室的列有右鍵選單，主要聊天室和 WhatsApp 這類頻道沒有
const CHAT_ROW_SELECTOR = '[data-testid="hatch-thread-row"][data-slot="context-menu-trigger"]';

let settings = { ...AAM.SETTINGS_DEFAULTS };
let allowOnce = [];
const handledAt = new WeakMap();
const handledKeys = new Map();
const handledIds = new Map();
const seenIds = new Set();
const linkedTitles = new Set();
const settleUntil = new WeakMap();
const waitingState = new Map();
let lastReviewAt = 0;
let lastClickedBanner = '';
let blockedBanner = { text: '', at: 0 };
let lastReported = null;
let lastChats = '';
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
    else if (!once && (ONCE_RE.test(text) || b.matches(PRIMARY_SELECTOR))) once = b;
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

function hasDeny(scope) {
  return [...scope.querySelectorAll(BUTTON_SELECTOR)].some(b => DENY_RE.test(labelOf(b)) && isClickable(b));
}

// 批次卡每項的標題放在 span[title]，文字和 span 之間沒有空白，例如「在GmailSend email」
function subHeading(item) {
  const head = item.querySelector('span[title]');
  return head ? [...head.childNodes].map(n => n.textContent).join(' ') : '';
}

// muse 會把審批卡標成 hatch-inline-approval-card，優先用標記認卡片；同時要多項批准時會併成一張，裡面每項各有按鈕，拆開逐項處理。
// 沒有標記的才走舊判斷：從拒絕鈕往上找最近一層有允許鈕的容器，再看卡片文字像不像存取網站
function approvalCards() {
  const cards = new Map();
  for (const card of document.querySelectorAll(CARD_SELECTOR)) {
    const items = [...card.querySelectorAll(SUB_APPROVAL_SELECTOR)].filter(item => item.querySelector(PRIMARY_SELECTOR));
    const scopes = items.length ? items.map(item => [item, subHeading(item)]) : [[card, '']];
    for (const [node, heading] of scopes) {
      // bridge 標了審批 ID 就確定是審批，不必再靠拒絕鈕的文字判斷
      const buttons = (node.hasAttribute(ID_ATTR) || hasDeny(node)) && findAllowButtons(node);
      if (!buttons) continue;
      const surface = card.getAttribute('data-hatch-approval-surface') || '';
      cards.set(node, { ...buttons, menu: node.querySelector(MENU_SELECTOR), body: card, heading, surface, approvalId: node.getAttribute(ID_ATTR) || '', policy: node.getAttribute(POLICY_ATTR) || '' });
    }
  }
  for (const deny of document.querySelectorAll(BUTTON_SELECTOR)) {
    if (deny.closest(CARD_SELECTOR) || !DENY_RE.test(labelOf(deny)) || !isClickable(deny)) continue;
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

// 側邊欄打開時記下副聊天室名稱給信任清單挑；收起來時整串不在 DOM，保留上次記的
function recordChats() {
  const names = [...document.querySelectorAll(CHAT_ROW_SELECTOR)]
    .map(row => AAM.cleanText(row.querySelector('[title]')?.getAttribute('title')))
    .filter(Boolean);
  const json = JSON.stringify([...new Set(names)]);
  if (!names.length || json === lastChats) return;
  lastChats = json;
  chrome.storage.local.set({ museChats: JSON.parse(json) }).catch(() => {});
}

// 掃描頁面上的審批卡：信任的按掉，不信任的列進等你決定
function scan() {
  if (!contextAlive()) return;
  recordChats();
  const cards = settings.enabled ? [...approvalCards()] : [];
  const previews = settings.enabled ? panelPreviews() : [];
  rememberSeen([...cards.map(([, b]) => b.approvalId), ...previews.map(p => p.getAttribute(ID_ATTR))]);
  const now = Date.now();
  const waiting = new Map();
  const busyCards = new Set();
  let trusted = 0;
  for (const [node, buttons] of cards) {
    const card = AAM.parseCard(labelOf(buttons.body), buttons.heading, buttons.policy);
    const key = AAM.cardKey(card);
    linkActionPolicy(card);
    if (handledElsewhere(buttons, key, now)) {
      trusted++;
      busyCards.add(buttons.body);
      continue;
    }
    const onceOnly = allowOnce.includes(key);
    if (!shouldAllow(card, onceOnly)) {
      waiting.set(key, pendingItem(card, key));
      continue;
    }
    trusted++;
    // 批次卡有一項還在處理時 muse 不理同卡其他項目的點擊，一張卡一輪只按一項；
    // 按完 muse 會重畫整張卡（剩一項時變回單張卡、換新節點），等它畫完再按下一項，免得同一項又被按一次
    if (busyCards.has(buttons.body) || now < (settleUntil.get(buttons.body) || 0)) continue;
    busyCards.add(buttons.body);
    if (now - (handledAt.get(node) || 0) >= RETRY_AFTER_MS) approve(node, buttons, card, key, onceOnly);
  }
  trusted += reviewPreviews(previews, now, waiting, !trusted);
  const banner = bannerText();
  const tracking = settings.enabled;
  // 其他聊天室的卡片收起來、只剩「檢閱」提示時保留等你決定，不能當成使用者已經處理
  if (!(tracking && !cards.length && banner && waitingState.size)) syncWaiting([...waiting.values()], now, tracking);
  if (!settings.enabled || !settings.openBackground || trusted) return;
  // 沒有能按的卡：有畫面上看不到的審批（別的聊天室、排程）就把右側面板的核可頁打開叫出來；
  // 打開了還是都不信任，同一批審批先不再點
  const hidden = hiddenPending();
  const signature = hidden?.length ? hidden.join(' ') : banner;
  const panelOpen = previews.length || cards.some(([, b]) => b.surface === 'panel');
  if (!panelOpen) openBackgroundApproval(now, signature, hidden);
  else blockedBanner = { text: lastClickedBanner || signature, at: now };
}

// 全部允許預設只按存取網站的卡；發文這類動作公開又收不回來，要另外打開才一起按。結帳、購買只按使用者指定的這一次
function shouldAllow(card, onceOnly) {
  if (onceOnly) return true;
  if (AAM.isPurchase(card)) return false;
  return (settings.mode === 'all' && !!(card.host || settings.includeActions)) || AAM.isTrusted(settings, card);
}

function pendingItem(card, key) {
  return { key, host: card.host, chat: card.chat, title: card.title, action: card.action, policy: card.policy };
}

// 同一筆審批剛按過就先跳過等 muse 收掉：右側面板開著時聊天室和面板各一份，批次卡縮回單張卡時也會換新節點。
// 有審批 ID 就用 ID 認；沒有的話，同一張批次卡裡其他項目的 key 可能一樣，只能擋另一個位置（聊天室／面板）的同 key 卡
function handledElsewhere({ approvalId, surface }, key, now) {
  if (approvalId) return now - (handledIds.get(approvalId) || 0) < RETRY_AFTER_MS;
  const last = handledKeys.get(key);
  return !!last && last.surface !== surface && now - last.at < RETRY_AFTER_MS;
}

// 舊版信任的動作只記標題；看到同標題的卡就把權限種類補進規則，之後標題寫法不同的批次卡也認得
function linkActionPolicy(card) {
  if (!card.policy || linkedTitles.has(card.action)) return;
  if (!settings.actions.some(a => a.title === card.action && !a.policy)) return;
  linkedTitles.add(card.action);
  chrome.storage.sync.get({ actions: [] })
    .then(({ actions }) => chrome.storage.sync.set({ actions: actions.map(a => (a.title === card.action && !a.policy ? { ...a, policy: card.policy } : a)) }))
    .catch(() => {});
}

function rememberSeen(ids) {
  for (const id of ids) if (id) seenIds.add(id);
  if (seenIds.size <= SEEN_LIMIT) return;
  for (const id of seenIds) {
    seenIds.delete(id);
    if (seenIds.size <= SEEN_LIMIT / 2) break;
  }
}

// 全部待審扣掉在這個分頁出現過的；出現過又消失的是已經處理或正在處理，不算看不到。拿不到 bridge 資料時回傳 null
function hiddenPending() {
  const all = document.documentElement.getAttribute(PENDING_ATTR);
  return all === null ? null : all.split(' ').filter(id => id && !seenIds.has(id));
}

// 右側面板的待檢閱清單一次只展開一張，其他收成預覽列，預覽列上看得到標題和來源
function panelPreviews() {
  const section = document.querySelector(`${CARD_SELECTOR}[data-hatch-approval-surface="panel"]`)?.closest('section');
  if (!section) return [];
  return [...section.querySelectorAll(PREVIEW_SELECTOR)].filter(b => !b.closest(CARD_SELECTOR) && isClickable(b));
}

// 信任的審批收在預覽列裡就展開它，下一輪再按。展開會把原本那張收起來，所以這輪有卡在按就不動，一輪也只展開一張
function reviewPreviews(previews, now, waiting, canExpand) {
  let trusted = 0;
  for (const preview of previews) {
    const card = AAM.parseCard(labelOf(preview), '', preview.getAttribute(POLICY_ATTR) || '');
    const key = AAM.cardKey(card);
    if (!shouldAllow(card, allowOnce.includes(key))) {
      if (!waiting.has(key)) waiting.set(key, pendingItem(card, key));
      continue;
    }
    if (canExpand && !trusted && settings.openBackground && now - (handledAt.get(preview) || 0) >= RETRY_AFTER_MS) {
      handledAt.set(preview, now);
      preview.click();
    }
    trusted++;
  }
  return trusted;
}

async function approve(node, buttons, card, key, onceOnly) {
  handledAt.set(node, Date.now());
  handledKeys.set(key, { at: Date.now(), surface: buttons.surface });
  if (buttons.approvalId) handledIds.set(buttons.approvalId, Date.now());
  settleUntil.set(buttons.body, Date.now() + SETTLE_MS);
  waitingState.delete(key);
  const kind = await clickAllow(buttons, settings.preferAlways && !onceOnly);
  console.info('[MAA] approved', card.host || card.action, card.chat);
  const entry = { ts: Date.now(), key, host: card.host, chat: card.chat, title: card.title, action: card.action, result: 'allowed', kind };
  updateLocal({ log: [], approvals: 0, allowOnce: [] }, data => {
    const log = data.log.filter(e => !(e.key === key && e.result === 'pending'));
    const patch = { log: [entry, ...log].slice(0, AAM.LOG_LIMIT), approvals: data.approvals + 1 };
    if (onceOnly) patch.allowOnce = data.allowOnce.filter(k => k !== key);
    return patch;
  });
}

// 右側面板和批次卡把一律允許收進「更多允許選項」選單，要的話打開選單去按；選單裡沒有才按允許一次
async function clickAllow({ always, once, menu }, preferAlways) {
  const item = preferAlways && !always && once && menu && isClickable(menu) ? await openAlwaysItem(menu) : null;
  if (item) {
    item.click();
    return 'always';
  }
  const target = preferAlways ? (always || once) : (once || always);
  target.click();
  return target === always ? 'always' : 'once';
}

// Radix 選單要 pointerdown 才會打開，選項渲染在卡片外，從 aria-controls 找；找不到一律允許就關掉選單
async function openAlwaysItem(menu) {
  if (menu.getAttribute('aria-expanded') !== 'true') {
    menu.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
  }
  for (let waited = 0; waited < MENU_WAIT_MS; waited += 100) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const list = document.getElementById(menu.getAttribute('aria-controls'));
    if (!list) continue;
    const item = [...list.querySelectorAll('[role="menuitem"]')].find(i => ALWAYS_RE.test(labelOf(i)));
    if (item) return item;
    break;
  }
  if (menu.getAttribute('aria-expanded') === 'true') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return null;
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
    const fresh = added.map(w => ({ ts: Date.now(), key: w.key, host: w.host, chat: w.chat, title: w.title, action: w.action, result: 'pending' }));
    return { log: [...fresh, ...log].slice(0, AAM.LOG_LIMIT), dismissed: data.dismissed.filter(k => waitingState.has(k)) };
  });
}

function bannerText() {
  const el = document.querySelector(BACKGROUND_SURFACE_SELECTOR);
  return el ? labelOf(el) : '';
}

// 把別的聊天室來的審批叫出來；叫出來都不信任的話，同一批 10 分鐘內不再點
function openBackgroundApproval(now, signature, hidden) {
  if (!signature || (signature === blockedBanner.text && now - blockedBanner.at < REVIEW_BLOCK_MS)) return;
  const target = backgroundEntry(hidden);
  if (!target) return;
  // 剛點頭像打開面板、接著切到核可頁的話不用等
  const followUp = target.matches('button[aria-pressed]') && signature === lastClickedBanner;
  if (now - lastReviewAt < REVIEW_RETRY_MS && !followUp) return;
  lastReviewAt = now;
  lastClickedBanner = signature;
  target.click();
}

// 有「N 項工作需要檢閱」就點檢閱。這個聊天室自己也有卡在等時 muse 不顯示這個提示，
// 這時右側面板開著就切到核可頁，關著就點頭像打開（會停在上次的分頁，下一輪再切）
function backgroundEntry(hidden) {
  const review = document.querySelector(`${BACKGROUND_SURFACE_SELECTOR} button`);
  if (review && isClickable(review)) return review;
  if (!hidden?.length) return null;
  const tab = [...document.querySelectorAll('button[aria-pressed]')].find(b => APPROVALS_TAB_RE.test(b.getAttribute('aria-label') || ''));
  if (tab) return tab.getAttribute('aria-pressed') === 'true' ? null : tab;
  const avatar = document.querySelector(AVATAR_SELECTOR);
  return avatar && isClickable(avatar) ? avatar : null;
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
