'use strict';

// popup、設定頁、背景和 content script 共用的設定結構與判斷規則
const AAM = (() => {
  const SETTINGS_DEFAULTS = { enabled: true, mode: 'trusted', preferAlways: true, openBackground: true, includeActions: false, lang: 'auto', sites: [], chats: [], actions: [] };
  const LOCAL_DEFAULTS = { log: [], allowOnce: [], dismissed: [], approvals: 0, installedAt: 0, ratingDismissed: false, museChats: [], museChatNames: {} };
  const LOG_LIMIT = 200;
  const STORE_URL = 'https://chromewebstore.google.com/detail/hbcimibdadjhancbpjibbhnhlcflmoii';
  const REPO_URL = 'https://github.com/homieyangg/muse-auto-approve';

  const INVISIBLE_RE = /[‎‏⁦-⁩]/g;
  const HOST_RE = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}/i;
  // 來源：副聊天室寫「此任務來自…」，排程任務寫「這是針對排定的…任務」，排程名稱也當成聊天室，才能用信任清單涵蓋
  // 日本語は「このタスクは…から」「予定されたタスク「…」」のような言い回しになる
  const CHAT_RES = [
    /此任務來自([^。]*)。/, /此任务来自([^。]*)。/, /這是針對排定的([^。]*)任務。/, /这是预定任务([^。]*)。/,
    /this task (?:is |comes |came )?from ([^.]*)\./i, /this is for the scheduled task ([^.]*)\./i,
    /このタスクは([^。]*)から/, /このタスクは([^。]*)のため/, /これは([^。]*)という予定/,
    /(?:予定|スケジュール)されたタスク[「『“"]([^」』”"]+)[」』”"]/,
  ];
  const QUOTED_RE = /[「『“"]([^」』”"]+)[」』”"]/;
  // English verbs need word boundaries, otherwise the "Browser" connector name in browser cards reads as "browse"
  // 日本語のサイト審批は「example.com にアクセスしますか？」のように動詞が漢字かな混じりになる
  const ACCESS_RE = /(存取|訪問|访问|開啟|打開|打开|前往|瀏覽|浏览|アクセス|閲覧|接続|開く|開きます|\b(?:access|visit|open|browse)\b)/i;
  // muse scopes browser upload approvals to the destination site ("Always allow uploads to this site")
  const UPLOAD_POLICY = 'connector.browser.page.upload';
  const PURCHASE_RE = /(結帳|下訂單|購買|结账|结帐|下单|购买|想买|購入|注文|決済|支払|チェックアウト|買う|check ?out|place (?:an )?order|purchase|\bbuy\b)/i;

  // 承認カードのボタン文字。日本語は「許可する」「許可しない」「常に許可」。
  // 「常に許可」は主語が前に付く（例: このサイトへのアップロードを常に許可）ので末尾で照合する。
  // 末尾を固定することで「常に許可しない」「常に許可済み」とは一致しない。
  // 「すべてを常に許可」はコネクター全体を許可する広い操作なので、英語・中国語と同じく対象外にする
  const ALWAYS_RE = /^(?:一律允許|永久允許|總是允許|始終允許|永遠允許|一律允许|永久允许|总是允许|始终允许|always allow|allow always)|^(?!.*すべて).*常に許可(?:する)?$/i;
  const ONCE_RE = /^(?:(?:允許|允许|allow)(?: ?(?:一次|本次|此次|once|this time))?|許可(?:する)?|(?:1|一)回だけ許可(?:する)?|今回(?:だけ|のみ)?許可(?:する)?|一度だけ許可(?:する)?)$/i;
  // 連接器動作卡的拒絕鈕是「不要＋動作」，例如寄信卡的「不要傳送」，簡體是「不发送」；日本語は「許可しない」「承認しない」「却下」「拒否」
  // キャンセル / やめる は通常のダイアログにもあるため、拒否ボタンとして扱わない
  const DENY_RE = /^(?:拒絕|拒绝|不允許|不允许|不要|不发|封鎖|阻擋|deny|reject|block|decline|don['’]t |do not |(?:この(?:サイト|タスク)を)?(?:許可|承認)しない|却下(?:する)?|拒否(?:する)?)/i;
  // カード本文にサイト・権限・許可の話が出ているか。DOM 標記が無いときの誤クリック防止に使う
  const CONTEXT_RE = /(網域|域名|網路|网络|網站|网站|連線|连接|存取|访问|外聯|外联|請求|请求|審批|审批|核准|批准|權限|权限|瀏覽器|浏览器|許可|承認|アクセス|サイト|ウェブ|ブラウザ|接続|権限|リクエスト|ドメイン|ネットワーク|読み取り|書き込み|approv|domain|network|website|egress|request|access|permission|browser|https?:\/\/)/i;
  // 右側面板の分頁按鈕は「承認」「承認待ち」。「許可」は他のボタンにもあるため使わない
  const APPROVALS_TAB_RE = /^(?:核可工具|批准|approvals|承認(?:待ち)?)$/i;

  // Button options read by bridge.js from muse's decisionOptions. Always-allow is a whitelist: anything muse adds later,
  // or anything wider than one site, is never picked as always
  const ALWAYS_SCOPES = ['destination', 'destination_domain'];
  const BROAD_LABEL_KINDS = ['allow_all_web_access_for_this_task'];
  const BROAD_SCOPES = ['connector_all_actions'];

  // Returns 'always', 'once', 'deny', or '' for an option nobody may auto-pick
  function optionRole({ kind, labelKind, scope } = {}) {
    if (kind === 'deny' || kind === 'deny_always') return 'deny';
    if (BROAD_LABEL_KINDS.includes(labelKind) || BROAD_SCOPES.includes(scope)) return '';
    if (kind === 'allow_always') {
      if (labelKind === 'allow_always' && !scope) return 'always';
      if (labelKind === 'allow_always_scoped' && ALWAYS_SCOPES.includes(scope)) return 'always';
      return '';
    }
    if (kind === 'allow_once' && (!scope || ALWAYS_SCOPES.includes(scope))) return 'once';
    return '';
  }

  // candidates: clickable buttons in DOM order as { el, text, primary, menu, kind, labelKind, scope }.
  // state is bridge.js's read of a chat card: 'clean' picks by the whitelist; 'anomalous' (options read, but a button belongs
  // to another approval, a key does not map, the sources disagree or a fiber can't be confirmed) picks only a confirmed once
  // button; '' means no data and main's text rules. Returns null when nothing can be clicked
  function pickAllowButtons(candidates, state = '') {
    let always = null, once = null;
    for (const c of candidates) {
      if (state) {
        if (c.menu || !c.kind) continue;
        const role = optionRole(c);
        if (!always && role === 'always' && state === 'clean') always = c.el;
        else if (!once && role === 'once') once = c.el;
      } else if (!always && ALWAYS_RE.test(c.text)) always = c.el;
      else if (!once && (ONCE_RE.test(c.text) || c.primary)) once = c.el;
    }
    return always || once ? { always, once, data: !!state, state } : null;
  }

  // The button to click for the setting. Once data has been read, "once" never falls back to an always button
  function clickTarget(buttons, preferAlways) {
    if (!buttons) return null;
    if (preferAlways) return buttons.always || buttons.once;
    return buttons.once || (buttons.data ? null : buttons.always);
  }

  // Right before a click, the pick made on fresh attributes must match the earlier one: same card state and the target
  // still in the same role
  function samePick(before, after, target) {
    if (!after || after.state !== before.state) return false;
    const role = b => (target === b.always ? 'always' : target === b.once ? 'once' : '');
    return !!role(before) && role(before) === role(after);
  }

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

  // Cards without source ids keep main's key. With ids the key ends in "\nt:<thread>\ns:<schedule>": card.chat went through
  // cleanText, so a key without ids has a "|" after its last newline, and ids (SOURCE_ID_RE) never contain "|" or a newline.
  // So a key with ids never equals one without, and two keys with ids are equal only for the same main key and pair
  function cardKey(card) {
    const subject = card.host || card.policy || card.action || '';
    const key = `${card.site ? `${subject}@${card.site}` : subject}|${card.chat}`;
    const pair = cardPair(card);
    return hasIds(pair) ? `${key}\nt:${pair.threadId}\ns:${pair.scheduleId}` : key;
  }

  // Name shown in the popup and settings for a card, log entry, or action rule
  function cardLabel(item, t) {
    if (item.site) return t(item.sub ? 'uploadToWithSub' : 'uploadTo', item.site);
    return item.host || item.action || item.title || '';
  }

  // Source ids come from muse's approval data through bridge.js
  const SOURCE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
  const SOURCE_TYPES = ['threadId', 'scheduleId'];

  function sourceId(value) {
    return typeof value === 'string' && SOURCE_ID_RE.test(value) ? value : '';
  }

  // A card's ids as a full pair, '' for a type it does not have; an id that doesn't look like one is absent
  function cardPair(card) {
    return { threadId: sourceId(card?.threadId), scheduleId: sourceId(card?.scheduleId) };
  }

  // A chat entry in a trust list: a legacy name string, or { name, threadId?, scheduleId? }. Returns null for anything else,
  // including an entry whose id field is present but not a valid id: it is unreadable, never read as name-only
  function sourceOf(entry) {
    if (typeof entry === 'string') return { name: entry };
    if (!entry || typeof entry !== 'object') return null;
    const out = { name: typeof entry.name === 'string' ? entry.name : '' };
    for (const type of SOURCE_TYPES) {
      if (entry[type] === undefined) continue;
      if (!sourceId(entry[type])) return null;
      out[type] = entry[type];
    }
    return out;
  }

  const hasIds = src => !!src && SOURCE_TYPES.some(type => src[type]);

  // Ids are compared as the full (threadId, scheduleId) pair: a thread-only entry never matches a card that also has a
  // schedule, and the other way round
  const samePair = (a, b) => SOURCE_TYPES.every(type => (a[type] || '') === (b[type] || ''));

  // An entry with ids matches a card with ids on the exact pair alone, so a renamed chat still matches and another chat of
  // the same name does not. Without ids on either side it is main's name match: a legacy string exactly as
  // rule.chats.includes, an object only on a non-empty name
  function sourceMatches(entry, card) {
    const src = sourceOf(entry);
    if (!src) return false;
    const pair = cardPair(card);
    if (hasIds(src) && hasIds(pair)) return samePair(src, pair);
    if (typeof entry === 'string') return entry === card.chat;
    return !!src.name && src.name === card.chat;
  }

  // The same entry in a list: the same pair when either has ids, otherwise the same name
  function sameSource(a, b) {
    const x = sourceOf(a), y = sourceOf(b);
    if (!x || !y) return false;
    if (hasIds(x) || hasIds(y)) return hasIds(x) && hasIds(y) && samePair(x, y);
    return x.name === y.name;
  }

  function sourceName(entry) {
    return sourceOf(entry)?.name || '';
  }

  // Stored form of a rule's chat limit: main's plain name string unless there are ids
  function sourceEntry(src) {
    return hasIds(src) ? { name: src.name, ...pickIds(src) } : src.name;
  }

  function pickIds(src) {
    return Object.fromEntries(SOURCE_TYPES.filter(type => src?.[type]).map(type => [type, src[type]]));
  }

  // A chat to limit a rule to: null when none was given (any chat), false when one was given but can't be used
  function chatLimit(chat) {
    if (chat === '' || chat == null) return null;
    const src = sourceOf(chat);
    return src && (src.name || hasIds(src)) ? src : false;
  }

  // Adds a chat to a rule's chat limit. A name-only chat is added as main does, next to any entry with ids. A chat with ids
  // is kept if the exact pair is there, replaces a name-only entry of the same name (attaching the ids), or is appended.
  // Entries with another pair are never touched
  function addSource(list, src) {
    if (!hasIds(src)) return list.some(e => typeof e === 'string' && e === src.name) ? list : [...list, src.name];
    if (list.some(e => sameSource(e, src))) return list.map(e => (sameSource(e, src) && !sourceName(e) && src.name ? sourceEntry(src) : e));
    const legacy = src.name ? list.findIndex(e => typeof e === 'string' && e === src.name) : -1;
    if (legacy >= 0) return list.map((e, i) => (i === legacy ? sourceEntry(src) : e));
    return [...list, sourceEntry(src)];
  }

  // The chat a new rule gets from a pending card: its pair with the name read from the card (never the sidebar's), or main's
  // plain name; null when the card names no usable chat
  function ruleChatOf(item) {
    const pair = cardPair(item);
    if (hasIds(pair)) return { name: item.chat || '', ...pickIds(pair) };
    return item.chat || null;
  }

  // Chats offered for a rule's chat limit: pairs for chats seen with ids (pending, log, rules, sidebar rows), plain names for
  // the rest. A chat seen with ids is never offered as its plain name, which would trust every chat of that name
  function pickableChats({ museChats = [], museChatNames = {}, settings, items = [] }) {
    const ruleChats = [...settings.chats, ...settings.sites.flatMap(s => s.chats), ...settings.actions.flatMap(a => a.chats)].map(sourceOf).filter(Boolean);
    const pairs = [
      ...items.map(ruleChatOf).filter(c => c && typeof c === 'object'),
      ...ruleChats.filter(hasIds).map(sourceEntry),
      ...Object.keys(museChatNames || {}).map(sourceId).filter(Boolean).map(threadId => ({ name: '', threadId })),
    ];
    const names = [
      ...museChats,
      ...ruleChats.filter(src => !hasIds(src)).map(src => src.name),
      ...items.map(ruleChatOf).filter(c => typeof c === 'string'),
    ].filter(n => typeof n === 'string' && n);
    const all = [...pairs, ...names];
    return all.filter((e, i) => all.findIndex(o => sameSource(o, e)) === i);
  }

  // 符合任一條就信任：信任的聊天室；信任的網站或動作（不限聊天室，或來源是它限定的聊天室）。動作有權限種類就比權限種類，否則比標題
  function isTrusted(settings, card) {
    if (settings.chats.some(c => c.on && sourceMatches(c, card))) return true;
    const scoped = rule => rule.on && (!rule.chats.length || rule.chats.some(c => sourceMatches(c, card)));
    if (card.host) return settings.sites.some(s => scoped(s) && hostMatches(s, card.host));
    // An action rule with a site only covers uploads to that site (and its subdomains when sub is on); rules without one cover every site
    const sameSite = a => !a.site || hostMatches({ host: a.site, sub: !!a.sub }, card.site || '');
    const sameAction = a => sameSite(a) && (a.title === card.action || (!!a.policy && a.policy === card.policy));
    return !!card.action && (settings.actions || []).some(a => scoped(a) && sameAction(a));
  }

  // 結帳、下單、購買的卡會花到錢，不管信任設定都不自動按，只接受使用者在 popup 按的「只允許這一次」
  // card.purchase comes from muse's approval data (bridge.js) and holds in any language; the wording is only a fallback
  function isPurchase(card) {
    if (card.purchase) return true;
    return !card.host && PURCHASE_RE.test(card.title || card.action || '');
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // 加網站規則；同一個網站已經有規則時合併，不重複新增
  // chat is '' for any chat, a name string, or { name, threadId?, scheduleId? }; a chat that can't be used adds nothing
  function addSiteRule(sites, host, { sub = false, chat = '' } = {}) {
    const limit = chatLimit(chat);
    if (limit === false) return sites;
    const next = sites.map(s => ({ ...s, chats: [...s.chats] }));
    const found = next.find(s => bareHost(s.host) === bareHost(host));
    if (!found) return [...next, { id: newId(), host, sub, chats: limit ? addSource([], limit) : [], on: true }];
    found.on = true;
    found.sub = found.sub || sub;
    if (!limit) found.chats = [];
    else if (found.chats.length) found.chats = addSource(found.chats, limit);
    return next;
  }

  function addActionRule(actions, title, { chat = '', policy = '', site = '' } = {}) {
    const limit = chatLimit(chat);
    if (limit === false) return actions;
    const next = actions.map(a => ({ ...a, chats: [...a.chats] }));
    const found = next.find(a => (a.site || '') === site && (a.title === title || (policy && a.policy === policy)));
    if (!found) return [...next, { id: newId(), title, ...(policy && { policy }), ...(site && { site }), chats: limit ? addSource([], limit) : [], on: true }];
    found.on = true;
    if (policy) found.policy = policy;
    if (!limit) found.chats = [];
    else if (found.chats.length) found.chats = addSource(found.chats, limit);
    return next;
  }

  // Without ids this is main's: the name-only entry of that name is turned on, or one is added; entries with ids are never
  // touched. With ids: the entry with the exact pair is turned on, else a name-only entry of the same name gets the ids, else
  // one is added. The stored name is the card's name, never the sidebar's
  function addChatRule(chats, name, ids = {}) {
    const src = chatLimit({ ...ids, name });
    if (!src) return chats;
    const legacy = c => !hasIds(sourceOf(c)) && c.name === src.name;
    if (!hasIds(src)) {
      if (chats.some(legacy)) return chats.map(c => (legacy(c) ? { ...c, on: true } : c));
      return [...chats, { id: newId(), name: src.name, on: true }];
    }
    const same = chats.findIndex(c => sameSource(c, src));
    if (same >= 0) return chats.map((c, i) => (i === same ? { ...c, name: c.name || src.name, on: true } : c));
    const at = src.name ? chats.findIndex(legacy) : -1;
    if (at >= 0) return chats.map((c, i) => (i === at ? { id: c.id, name: src.name, ...pickIds(src), on: true } : c));
    return [...chats, { id: newId(), name: src.name, ...pickIds(src), on: true }];
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

  function supportedLangs() {
    if (typeof I18N !== 'undefined' && Array.isArray(I18N.LANGUAGES)) return I18N.LANGUAGES.map(l => l.code);
    if (typeof require === 'function') return require('./i18n.js').LANGUAGES.map(l => l.code);
    return [];
  }

  // A rule's chat limit on import: name strings as on main, objects with their name and ids. null drops the whole rule: an
  // entry that can't be read (an invalid id, neither name nor id, not a string or object), or a limit whose entries were all
  // dropped, must never turn into "any chat"
  function sanitizeRuleChats(chats) {
    if (!Array.isArray(chats)) return [];
    const out = [];
    for (const c of chats) {
      if (typeof c === 'string') {
        if (c) out.push(c);
        continue;
      }
      const src = chatLimit(c && typeof c === 'object' ? c : false);
      if (!src) return null;
      out.push(sourceEntry(src));
    }
    return chats.length && !out.length ? null : out;
  }

  // 匯入的設定只留認得的欄位，型別不對就用預設值
  function sanitizeSettings(raw) {
    const out = { ...SETTINGS_DEFAULTS };
    if (!raw || typeof raw !== 'object') return out;
    for (const key of ['enabled', 'preferAlways', 'openBackground', 'includeActions']) if (typeof raw[key] === 'boolean') out[key] = raw[key];
    if (['all', 'trusted'].includes(raw.mode)) out.mode = raw.mode;
    if (raw.lang === 'auto' || supportedLangs().includes(raw.lang)) out.lang = raw.lang;
    if (Array.isArray(raw.sites)) {
      out.sites = raw.sites
        .map(s => ({ id: String(s.id || newId()), host: normalizeHost(s.host), sub: !!s.sub, on: s.on !== false, chats: sanitizeRuleChats(s.chats) }))
        .filter(s => s.host && s.chats);
    }
    if (Array.isArray(raw.chats)) {
      out.chats = raw.chats
        .filter(c => c && typeof c === 'object' && sourceOf(c) && ((typeof c.name === 'string' && c.name) || hasIds(sourceOf(c))))
        .map(c => ({ id: String(c.id || newId()), name: sourceName(c), ...pickIds(sourceOf(c)), on: c.on !== false }));
    }
    if (Array.isArray(raw.actions)) {
      out.actions = raw.actions
        .filter(a => a && typeof a.title === 'string' && a.title)
        .map(a => ({
          id: String(a.id || newId()),
          title: a.title.slice(0, 120),
          ...(typeof a.policy === 'string' && a.policy && { policy: a.policy.slice(0, 200) }),
          ...(typeof a.site === 'string' && normalizeHost(a.site) && { site: normalizeHost(a.site), ...(a.sub === true && { sub: true }) }),
          on: a.on !== false,
          chats: sanitizeRuleChats(a.chats),
        }))
        .filter(a => a.chats);
    }
    return out;
  }

  return { SETTINGS_DEFAULTS, LOCAL_DEFAULTS, LOG_LIMIT, STORE_URL, REPO_URL, ALWAYS_RE, ONCE_RE, DENY_RE, CONTEXT_RE, APPROVALS_TAB_RE, optionRole, pickAllowButtons, clickTarget, samePick, cleanText, normalizeHost, hostMatches, parseCard, cardKey, cardLabel, sourceId, cardPair, sourceOf, sourceMatches, sameSource, sourceName, ruleChatOf, pickableChats, isTrusted, isPurchase, addSiteRule, addActionRule, addChatRule, mergePending, sanitizeSettings };
})();

if (typeof module !== 'undefined') module.exports = AAM;
