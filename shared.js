'use strict';

// popup、設定頁、背景和 content script 共用的設定結構與判斷規則
const AAM = (() => {
  const SETTINGS_DEFAULTS = { enabled: true, mode: 'trusted', preferAlways: true, openBackground: true, includeActions: false, lang: 'auto', sites: [], chats: [], actions: [] };
  const LOCAL_DEFAULTS = { log: [], allowOnce: [], dismissed: [], approvals: 0, installedAt: 0, ratingDismissed: false, museChats: [] };
  const LOG_LIMIT = 200;
  const STORE_URL = 'https://chromewebstore.google.com/detail/hbcimibdadjhancbpjibbhnhlcflmoii';
  const REPO_URL = 'https://github.com/homieyangg/muse-auto-approve';

  const INVISIBLE_RE = /[‎‏⁦-⁩]/g;
  const HOST_RE = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}/i;
  // 來源：副聊天室寫「此任務來自…」，排程任務寫「這是針對排定的…任務」，排程名稱也當成聊天室，才能用信任清單涵蓋
  const CHAT_RES = [/此任務來自([^。]*)。/, /此任务来自([^。]*)。/, /這是針對排定的([^。]*)任務。/, /这是预定任务([^。]*)。/, /this task (?:is |comes |came )?from ([^.]*)\./i, /this is for the scheduled task ([^.]*)\./i];
  const QUOTED_RE = /[「『“"]([^」』”"]+)[」』”"]/;
  // English verbs need word boundaries, otherwise the "Browser" connector name in browser cards reads as "browse"
  const ACCESS_RE = /(存取|訪問|访问|開啟|打開|打开|前往|瀏覽|浏览|\b(?:access|visit|open|browse)\b)/i;
  // muse scopes browser upload approvals to the destination site ("Always allow uploads to this site")
  const UPLOAD_POLICY = 'connector.browser.page.upload';
  const PURCHASE_RE = /(結帳|下訂單|購買|结账|结帐|下单|购买|想买|check ?out|place (?:an )?order|purchase|\bbuy\b)/i;

  function cleanText(text) {
    return (text || '').replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim();
  }

  // 使用者貼整串網址或輸入網站都轉成小寫主機名稱，看不懂就回傳空字串
  function normalizeHost(input) {
    let s = cleanText(input).toLowerCase().replace(/^\*\./, '');
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
      try { s = new URL(s).hostname; } catch { return ''; }
    }
    s = s.split(/[/?#]/)[0].split(':')[0].replace(/\.$/, '');
    const m = s.match(HOST_RE);
    return m && m[0] === s ? s : '';
  }

  function bareHost(host) {
    return host.replace(/^www\./, '');
  }

  function hostMatches(rule, host) {
    const r = bareHost(rule.host), h = bareHost(host);
    return h === r || (rule.sub && h.endsWith('.' + r));
  }

  // 網站只從標題（第一個問號前）找，而且標題要是「存取某網站」；其他卡（發文、傳訊息）用標題當動作名稱。
  // 批次卡的子項目沒有問號標題，由呼叫端傳 heading；policy 是 muse 的權限種類（例如 connector.gmail.users.messages.send），
  // 同一個動作在單張卡和批次卡標題寫法不同，靠它認成同一個
  // site is the upload destination read by bridge.js; only browser upload cards keep it
  function parseCard(text, heading, policy, site) {
    const t = cleanText(text);
    const title = (heading ? cleanText(heading) : t.split(/[？?]/)[0]).slice(0, 120);
    const hostMatch = ACCESS_RE.test(title) ? title.match(HOST_RE) : null;
    let chat = '';
    for (const re of CHAT_RES) {
      const m = t.match(re);
      if (!m) continue;
      const quoted = m[1].match(QUOTED_RE);
      chat = cleanText(quoted ? quoted[1] : m[1]);
      break;
    }
    const host = hostMatch ? hostMatch[0].toLowerCase() : '';
    const uploadSite = !host && policy === UPLOAD_POLICY ? normalizeHost(site) : '';
    return { host, chat, title, action: host ? '' : title, policy: host ? '' : policy || '', site: uploadSite };
  }

  function cardKey(card) {
    const subject = card.host || card.policy || card.action || '';
    return `${card.site ? `${subject}@${card.site}` : subject}|${card.chat}`;
  }

  // Name shown in the popup and settings for a card, log entry, or action rule
  function cardLabel(item, t) {
    return item.site ? t('uploadTo', item.site) : item.host || item.action || item.title || '';
  }

  // 符合任一條就信任：信任的聊天室；信任的網站或動作（不限聊天室，或來源是它限定的聊天室）。動作有權限種類就比權限種類，否則比標題
  function isTrusted(settings, card) {
    if (card.chat && settings.chats.some(c => c.on && c.name === card.chat)) return true;
    const scoped = rule => rule.on && (!rule.chats.length || rule.chats.includes(card.chat));
    if (card.host) return settings.sites.some(s => scoped(s) && hostMatches(s, card.host));
    // An action rule with a site only covers uploads to that site; rules without one cover every site
    const sameSite = a => !a.site || hostMatches({ host: a.site, sub: false }, card.site || '');
    const sameAction = a => sameSite(a) && (a.title === card.action || (!!a.policy && a.policy === card.policy));
    return !!card.action && (settings.actions || []).some(a => scoped(a) && sameAction(a));
  }

  // 結帳、下單、購買的卡會花到錢，不管信任設定都不自動按，只接受使用者在 popup 按的「只允許這一次」
  function isPurchase(card) {
    return !card.host && PURCHASE_RE.test(card.title || card.action || '');
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // 加網站規則；同一個網站已經有規則時合併，不重複新增
  function addSiteRule(sites, host, { sub = false, chat = '' } = {}) {
    const next = sites.map(s => ({ ...s, chats: [...s.chats] }));
    const found = next.find(s => bareHost(s.host) === bareHost(host));
    if (!found) return [...next, { id: newId(), host, sub, chats: chat ? [chat] : [], on: true }];
    found.on = true;
    found.sub = found.sub || sub;
    if (!chat) found.chats = [];
    else if (found.chats.length && !found.chats.includes(chat)) found.chats.push(chat);
    return next;
  }

  function addActionRule(actions, title, { chat = '', policy = '', site = '' } = {}) {
    const next = actions.map(a => ({ ...a, chats: [...a.chats] }));
    const found = next.find(a => (a.site || '') === site && (a.title === title || (policy && a.policy === policy)));
    if (!found) return [...next, { id: newId(), title, ...(policy && { policy }), ...(site && { site }), chats: chat ? [chat] : [], on: true }];
    found.on = true;
    if (policy) found.policy = policy;
    if (!chat) found.chats = [];
    else if (found.chats.length && !found.chats.includes(chat)) found.chats.push(chat);
    return next;
  }

  function addChatRule(chats, name) {
    if (chats.some(c => c.name === name)) return chats.map(c => (c.name === name ? { ...c, on: true } : c));
    return [...chats, { id: newId(), name, on: true }];
  }

  // 各分頁回報的等你決定合併成一份，同一張卡只留最早的時間
  function mergePending(byTab, dismissed = []) {
    const map = new Map();
    for (const items of Object.values(byTab || {})) {
      for (const item of items) {
        const prev = map.get(item.key);
        if (!prev || item.ts < prev.ts) map.set(item.key, item);
      }
    }
    return [...map.values()].filter(i => !dismissed.includes(i.key)).sort((a, b) => b.ts - a.ts);
  }

  // 匯入的設定只留認得的欄位，型別不對就用預設值
  function sanitizeSettings(raw) {
    const out = { ...SETTINGS_DEFAULTS };
    if (!raw || typeof raw !== 'object') return out;
    for (const key of ['enabled', 'preferAlways', 'openBackground', 'includeActions']) if (typeof raw[key] === 'boolean') out[key] = raw[key];
    if (['all', 'trusted'].includes(raw.mode)) out.mode = raw.mode;
    if (['auto', 'zh_TW', 'en'].includes(raw.lang)) out.lang = raw.lang;
    if (Array.isArray(raw.sites)) {
      out.sites = raw.sites
        .map(s => ({ id: String(s.id || newId()), host: normalizeHost(s.host), sub: !!s.sub, on: s.on !== false, chats: Array.isArray(s.chats) ? s.chats.filter(c => typeof c === 'string' && c) : [] }))
        .filter(s => s.host);
    }
    if (Array.isArray(raw.chats)) {
      out.chats = raw.chats.filter(c => c && typeof c.name === 'string' && c.name).map(c => ({ id: String(c.id || newId()), name: c.name, on: c.on !== false }));
    }
    if (Array.isArray(raw.actions)) {
      out.actions = raw.actions
        .filter(a => a && typeof a.title === 'string' && a.title)
        .map(a => ({
          id: String(a.id || newId()),
          title: a.title.slice(0, 120),
          ...(typeof a.policy === 'string' && a.policy && { policy: a.policy.slice(0, 200) }),
          ...(typeof a.site === 'string' && normalizeHost(a.site) && { site: normalizeHost(a.site) }),
          on: a.on !== false,
          chats: Array.isArray(a.chats) ? a.chats.filter(c => typeof c === 'string' && c) : [],
        }));
    }
    return out;
  }

  return { SETTINGS_DEFAULTS, LOCAL_DEFAULTS, LOG_LIMIT, STORE_URL, REPO_URL, cleanText, normalizeHost, hostMatches, parseCard, cardKey, cardLabel, isTrusted, isPurchase, addSiteRule, addActionRule, addChatRule, mergePending, sanitizeSettings };
})();

if (typeof module !== 'undefined') module.exports = AAM;
