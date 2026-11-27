'use strict';

// popup、設定頁、背景和 content script 共用的設定結構與判斷規則
const AAM = (() => {
  const SETTINGS_DEFAULTS = { enabled: true, mode: 'trusted', preferAlways: true, openBackground: true, includeActions: false, lang: 'auto', sites: [], chats: [], actions: [], chatSources: [] };
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
  const NO_PAIR = Object.freeze({ threadId: '', scheduleId: '' });

  function sourceId(value) {
    return typeof value === 'string' && SOURCE_ID_RE.test(value) ? value : '';
  }

  // The (threadId, scheduleId) pair of a card or stored entry, '' for a type it does not have. null when a field is set but
  // is not a valid id: one bad half voids the pair, the other half is never matched on alone. Stored entries leave a type
  // out; on a card or a pair built from one (loose) '' and null also mean "none"
  function readPair(obj, loose = false) {
    const out = { ...NO_PAIR };
    for (const type of SOURCE_TYPES) {
      const value = obj?.[type];
      if (value === undefined || (loose && (value === null || value === ''))) continue;
      if (!sourceId(value)) return null;
      out[type] = value;
    }
    return out;
  }

  // A card whose pair can't be read has no ids and is matched by name, as on main
  function cardPair(card) {
    return readPair(card, true) || { ...NO_PAIR };
  }

  const hasIds = pair => !!pair && SOURCE_TYPES.some(type => pair[type]);
  // Ids are compared as the full pair: a thread-only entry never matches a card that also has a schedule, and the other way round
  const samePair = (a, b) => SOURCE_TYPES.every(type => (a[type] || '') === (b[type] || ''));
  const pickIds = pair => Object.fromEntries(SOURCE_TYPES.filter(type => pair?.[type]).map(type => [type, pair[type]]));

  // settings.chats keeps main's { id, name, on } entries. A chat trusted with ids is { id, name, threadId?, scheduleId?, on } in
  // settings.chatSources, which versions without ids don't read, so they never trust it, not even by name
  function trustedChats(settings) {
    return [...settings.chats, ...(Array.isArray(settings.chatSources) ? settings.chatSources : [])];
  }

  // Splits a list of trusted chats back into the two stored lists; an entry with any id field goes to chatSources
  function splitChats(list) {
    const withIds = c => SOURCE_TYPES.some(type => c[type] !== undefined);
    return { chats: list.filter(c => !withIds(c)), chatSources: list.filter(withIds) };
  }

  // With ids on both sides only the exact pair matches, so a renamed chat still matches and another chat of the same name
  // does not; otherwise it is main's name match. An entry whose ids can't be read matches nothing
  function chatMatches(entry, card) {
    const pair = readPair(entry);
    if (!pair) return false;
    const ids = cardPair(card);
    if (hasIds(pair) && hasIds(ids)) return samePair(pair, ids);
    return !!card.chat && entry.name === card.chat;
  }

  // The same chat choice: the same name and the same pair (none for a plain name)
  function sameChoice(a, b) {
    const x = readPair(a, true), y = readPair(b, true);
    return !!x && !!y && a.name === b.name && samePair(x, y);
  }

  // Chats the popup and settings offer for the trusted chat list, as { name, threadId?, scheduleId? }. names are the plain
  // candidates (sidebar, rule limits); chats is trustedChats(settings); items are pending cards and log entries. A chat seen
  // with ids is offered by its pair with the name read from its card, or '' (a sidebar name is only for display). A name
  // seen with ids, or on a card whose ids couldn't be read, is never offered plain: that would trust every chat of the name
  function chatChoices({ names = [], museChatNames = {}, chats = [], items = [] }) {
    const offered = [];
    const byId = new Set(Object.values(museChatNames || {}));
    const add = (name, pair) => {
      const choice = { name: typeof name === 'string' ? name : '', ...pickIds(pair) };
      if (hasIds(pair)) byId.add(choice.name);
      offered.push(choice);
    };
    for (const id of Object.keys(museChatNames || {})) if (sourceId(id)) add('', { threadId: id });
    for (const name of names) add(name, NO_PAIR);
    for (const c of chats) if (readPair(c)) add(c.name, readPair(c));
    for (const item of items) {
      if (item.badIds) byId.add(item.chat);
      else add(item.chat, cardPair(item));
    }
    const pairKey = c => `${c.threadId || ''}\n${c.scheduleId || ''}`;
    const namedPairs = new Set(offered.filter(c => hasIds(c) && c.name).map(pairKey));
    const all = offered.filter(c => (hasIds(c) ? c.name || !namedPairs.has(pairKey(c)) : c.name && !byId.has(c.name)));
    return all.filter((c, i) => all.findIndex(o => sameChoice(o, c)) === i);
  }

  // Whether the trusted chat list has this choice: an entry with its pair, or for a plain name a plain entry of that name
  function listsChat(chats, choice) {
    const pair = readPair(choice, true);
    if (!pair) return true;
    return chats.some(c => {
      const own = readPair(c);
      return !!own && (hasIds(pair) ? samePair(own, pair) : !hasIds(own) && c.name === choice.name);
    });
  }

  // Labels for chats shown together. Chats that would share a label get the end of each of their ids, so two chats of one
  // name can be told apart without showing whole ids
  function chatLabels(list, labelOf) {
    const base = list.map(labelOf);
    return list.map((c, i) => {
      const suffix = SOURCE_TYPES.map(type => c[type]).filter(Boolean).map(id => id.slice(-6)).join('/');
      return suffix && base.filter(b => b === base[i]).length > 1 ? `${base[i]} · ${suffix}` : base[i];
    });
  }

  // 符合任一條就信任：信任的聊天室；信任的網站或動作（不限聊天室，或來源是它限定的聊天室）。動作有權限種類就比權限種類，否則比標題
  function isTrusted(settings, card) {
    if (card.chat && settings.chats.some(c => c.on && c.name === card.chat)) return true;
    if ((Array.isArray(settings.chatSources) ? settings.chatSources : []).some(c => c.on && hasIds(readPair(c)) && chatMatches(c, card))) return true;
    const scoped = rule => rule.on && (!rule.chats.length || rule.chats.includes(card.chat));
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

  // Without ids this is main's, over the entries without ids: the one of that name is turned on, or one is added. With ids
  // only the entry with that name and pair is turned on, or one is added. No other entry is touched, so trusting a renamed
  // chat never turns its old name back on. chats is trustedChats(settings); splitChats stores the result
  function addChatRule(chats, name, ids = {}) {
    const pair = readPair(ids, true);
    if (!pair || (!name && !hasIds(pair))) return chats;
    const same = c => {
      const own = readPair(c);
      return !!own && c.name === name && samePair(own, pair);
    };
    if (chats.some(same)) return chats.map(c => (same(c) ? { ...c, on: true } : c));
    return [...chats, { id: newId(), name, ...pickIds(pair), on: true }];
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

  // 匯入的設定只留認得的欄位，型別不對就用預設值
  function sanitizeSettings(raw) {
    const out = { ...SETTINGS_DEFAULTS };
    if (!raw || typeof raw !== 'object') return out;
    for (const key of ['enabled', 'preferAlways', 'openBackground', 'includeActions']) if (typeof raw[key] === 'boolean') out[key] = raw[key];
    if (['all', 'trusted'].includes(raw.mode)) out.mode = raw.mode;
    if (raw.lang === 'auto' || supportedLangs().includes(raw.lang)) out.lang = raw.lang;
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
          ...(typeof a.site === 'string' && normalizeHost(a.site) && { site: normalizeHost(a.site), ...(a.sub === true && { sub: true }) }),
          on: a.on !== false,
          chats: Array.isArray(a.chats) ? a.chats.filter(c => typeof c === 'string' && c) : [],
        }));
    }
    // Every entry needs a pair it can read; one without a name is matched by the pair alone
    if (Array.isArray(raw.chatSources)) {
      out.chatSources = raw.chatSources
        .filter(c => c && typeof c === 'object' && typeof c.name === 'string' && hasIds(readPair(c)))
        .map(c => ({ id: String(c.id || newId()), name: c.name, ...pickIds(readPair(c)), on: c.on !== false }));
    }
    return out;
  }

  return { SETTINGS_DEFAULTS, LOCAL_DEFAULTS, LOG_LIMIT, STORE_URL, REPO_URL, ALWAYS_RE, ONCE_RE, DENY_RE, CONTEXT_RE, APPROVALS_TAB_RE, optionRole, pickAllowButtons, clickTarget, samePick, cleanText, normalizeHost, hostMatches, parseCard, cardKey, cardLabel, sourceId, readPair, cardPair, hasIds, trustedChats, splitChats, chatMatches, sameChoice, chatChoices, listsChat, chatLabels, isTrusted, isPurchase, addSiteRule, addActionRule, addChatRule, mergePending, sanitizeSettings };
})();

if (typeof module !== 'undefined') module.exports = AAM;
