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
  const CHAT_RES = [/此任務來自([^。]*)。/, /此任务来自([^。]*)。/, /this task (?:is |came )?from ([^.]*)\./i];
  const QUOTED_RE = /[「『“"]([^」』”"]+)[」』”"]/;
  const ACCESS_RE = /(存取|訪問|访问|開啟|打開|打开|前往|瀏覽|浏览|access|visit|open|browse)/i;

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

  // 網站只從標題（第一個問號前）找，而且標題要是「存取某網站」；其他卡（發文、傳訊息）用標題當動作名稱
  function parseCard(text) {
    const t = cleanText(text);
    const title = t.split(/[？?]/)[0].slice(0, 120);
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
    return { host, chat, title, action: host ? '' : title };
  }

  function cardKey(card) {
    return `${card.host || card.action || ''}|${card.chat}`;
  }

  // 符合任一條就信任：信任的聊天室；信任的網站或動作（不限聊天室，或來源是它限定的聊天室）
  function isTrusted(settings, card) {
    if (card.chat && settings.chats.some(c => c.on && c.name === card.chat)) return true;
    const scoped = rule => rule.on && (!rule.chats.length || rule.chats.includes(card.chat));
    if (card.host) return settings.sites.some(s => scoped(s) && hostMatches(s, card.host));
    return !!card.action && (settings.actions || []).some(a => scoped(a) && a.title === card.action);
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

  function addActionRule(actions, title, { chat = '' } = {}) {
    const next = actions.map(a => ({ ...a, chats: [...a.chats] }));
    const found = next.find(a => a.title === title);
    if (!found) return [...next, { id: newId(), title, chats: chat ? [chat] : [], on: true }];
    found.on = true;
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
        .map(a => ({ id: String(a.id || newId()), title: a.title.slice(0, 120), on: a.on !== false, chats: Array.isArray(a.chats) ? a.chats.filter(c => typeof c === 'string' && c) : [] }));
    }
    return out;
  }

  return { SETTINGS_DEFAULTS, LOCAL_DEFAULTS, LOG_LIMIT, STORE_URL, REPO_URL, cleanText, normalizeHost, hostMatches, parseCard, cardKey, isTrusted, addSiteRule, addActionRule, addChatRule, mergePending, sanitizeSettings };
})();

if (typeof module !== 'undefined') module.exports = AAM;
