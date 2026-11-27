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

  // A trusted chat entry is main's { id, name, on } plus the pair it was saved from, which versions without ids ignore. With
  // ids on both sides only the exact pair matches, so a renamed chat still matches and another chat of the same name does
  // not; otherwise it is main's name match. An entry whose ids can't be read matches nothing
  function chatMatches(entry, card) {
    const pair = readPair(entry);
    if (!pair) return false;
    const ids = cardPair(card);
    if (hasIds(pair) && hasIds(ids)) return samePair(pair, ids);
    return !!card.chat && entry.name === card.chat;
  }

  // A site or action rule keeps main's chat limit: rule.chats holds names. rule.sources binds some of those names to the
  // pairs they were saved from; versions without ids ignore it and match the names. null when it can't be read
  function ruleSources(rule) {
    if (rule.sources === undefined) return [];
    if (!Array.isArray(rule.sources)) return null;
    const out = [];
    for (const src of rule.sources) {
      const pair = src && typeof src === 'object' ? readPair(src) : null;
      if (!pair || !hasIds(pair) || typeof src.name !== 'string' || !src.name) return null;
      out.push({ name: src.name, ...pickIds(pair) });
    }
    return out;
  }

  // A name bound to pairs matches a card with ids only on one of them. A card without ids, or a name without pairs, is
  // main's rule.chats.includes(card.chat)
  function limitMatches(rule, card) {
    if (!rule.chats.length) return true;
    const sources = ruleSources(rule);
    if (!sources) return false;
    const ids = cardPair(card);
    return rule.chats.some(name => {
      const bound = sources.filter(src => src.name === name);
      return bound.length && hasIds(ids) ? bound.some(src => samePair(src, ids)) : name === card.chat;
    });
  }

  // The same chat choice: the same name and the same pair (none for a plain name)
  function sameChoice(a, b) {
    const x = readPair(a, true), y = readPair(b, true);
    return !!x && !!y && a.name === b.name && samePair(x, y);
  }

  // Chats the popup and settings can offer, as { name, threadId?, scheduleId? }. A chat seen with ids is offered by its
  // pair with the name read from its card, or '' (a sidebar name is only for display). A name seen with ids anywhere is
  // never offered plain: that rule would trust every chat of the name. named leaves out choices without a name, for rule
  // limits; fromRules: false still learns names from site and action rules but doesn't offer them
  function chatChoices({ museChats = [], museChatNames = {}, settings, items = [], named = false, fromRules = true }) {
    const offered = [];
    const byId = new Set(Object.values(museChatNames || {}));
    const add = (name, pair, offer = true) => {
      const choice = { name: typeof name === 'string' ? name : '', ...pickIds(pair) };
      if (hasIds(pair)) byId.add(choice.name);
      if (offer) offered.push(choice);
    };
    for (const id of Object.keys(museChatNames || {})) if (sourceId(id)) add('', { threadId: id });
    for (const name of museChats) add(name, NO_PAIR);
    for (const c of settings.chats) if (readPair(c)) add(c.name, readPair(c));
    for (const rule of [...settings.sites, ...settings.actions]) {
      const sources = ruleSources(rule) || [];
      for (const src of sources) add(src.name, src, fromRules);
      for (const name of rule.chats) if (!sources.some(src => src.name === name)) add(name, NO_PAIR, fromRules);
    }
    for (const item of items) add(item.chat, cardPair(item));
    const pairKey = c => `${c.threadId || ''}\n${c.scheduleId || ''}`;
    const namedPairs = new Set(offered.filter(c => hasIds(c) && c.name).map(pairKey));
    const all = offered.filter(c => (hasIds(c) ? c.name || (!named && !namedPairs.has(pairKey(c))) : c.name && !byId.has(c.name)));
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

  // A rule's chat limit as choices: each bound name by its pairs, each other name plain
  function limitChoices(limit) {
    const sources = ruleSources(limit) || [];
    return limit.chats.flatMap(name => {
      const bound = sources.filter(src => src.name === name);
      return bound.length ? bound : [{ name }];
    });
  }

  // What a rule's chat picker shows: the limit's own choices, then the other named choices. A pair is left out when the
  // limit holds its name without one, since that name already covers it
  function limitOptions(limit, choices) {
    const current = limitChoices(limit);
    const plainNames = new Set(current.filter(c => !hasIds(c)).map(c => c.name));
    const rest = choices.filter(c => c.name && !current.some(o => sameChoice(o, c)) && !(hasIds(c) && plainNames.has(c.name)));
    return [...current, ...rest];
  }

  // Ticks or unticks a choice in a rule's chat limit. Unticking a name's last pair also removes the name: left without
  // pairs it would trust every chat of that name
  function toggleLimit(limit, choice, on) {
    const sources = ruleSources(limit) || [];
    const pair = readPair(choice, true);
    const name = choice.name;
    if (!name || !pair) return { chats: limit.chats, sources };
    const withName = limit.chats.includes(name) ? limit.chats : [...limit.chats, name];
    const bound = sources.some(src => src.name === name);
    if (!hasIds(pair)) {
      if (on) return { chats: withName, sources };
      return { chats: limit.chats.filter(n => n !== name), sources: sources.filter(src => src.name !== name) };
    }
    if (on) {
      if ((limit.chats.includes(name) && !bound) || sources.some(src => sameChoice(src, choice))) return { chats: limit.chats, sources };
      return { chats: withName, sources: [...sources, { name, ...pickIds(pair) }] };
    }
    const left = sources.filter(src => !sameChoice(src, choice));
    const stillBound = left.some(src => src.name === name);
    return { chats: bound && !stillBound ? limit.chats.filter(n => n !== name) : limit.chats, sources: left };
  }

  function withoutSources(rule) {
    const { sources, ...rest } = rule;
    return rest;
  }

  // A rule with a new chat limit; sources is left out when there are none, so the rule stays shaped as on main
  function setLimit(rule, limit) {
    return { ...withoutSources(rule), chats: limit.chats, ...(limit.sources?.length && { sources: limit.sources }) };
  }

  // 符合任一條就信任：信任的聊天室；信任的網站或動作（不限聊天室，或來源是它限定的聊天室）。動作有權限種類就比權限種類，否則比標題
  function isTrusted(settings, card) {
    if (settings.chats.some(c => c.on && chatMatches(c, card))) return true;
    const scoped = rule => rule.on && limitMatches(rule, card);
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
  // chat is '' for any chat or the name read from the card; ids is the card's pair. A chat limit needs a name, so ids
  // without one, or ids that can't be read, change nothing
  function addSiteRule(sites, host, { sub = false, chat = '', ids = {} } = {}) {
    const pair = readPair(ids, true);
    if (!pair || (!chat && hasIds(pair))) return sites;
    const next = sites.map(s => ({ ...s, chats: [...s.chats] }));
    const found = next.find(s => bareHost(s.host) === bareHost(host));
    if (!found) return [...next, { id: newId(), host, sub, ...newLimit(chat, pair), on: true }];
    found.on = true;
    found.sub = found.sub || sub;
    return next.map(s => (s === found ? mergeLimit(s, chat, pair) : s));
  }

  function addActionRule(actions, title, { chat = '', ids = {}, policy = '', site = '' } = {}) {
    const pair = readPair(ids, true);
    if (!pair || (!chat && hasIds(pair))) return actions;
    const next = actions.map(a => ({ ...a, chats: [...a.chats] }));
    const found = next.find(a => (a.site || '') === site && (a.title === title || (policy && a.policy === policy)));
    if (!found) return [...next, { id: newId(), title, ...(policy && { policy }), ...(site && { site }), ...newLimit(chat, pair), on: true }];
    found.on = true;
    if (policy) found.policy = policy;
    return next.map(a => (a === found ? mergeLimit(a, chat, pair) : a));
  }

  function newLimit(chat, pair) {
    return { chats: chat ? [chat] : [], ...(chat && hasIds(pair) && { sources: [{ name: chat, ...pickIds(pair) }] }) };
  }

  // main's merge of a chat into a rule's limit, plus the card's pair for a name the limit gains or already binds to pairs.
  // A name the limit had without pairs is left as it is: it already covers the chat
  function mergeLimit(rule, chat, pair) {
    if (!chat) return { ...withoutSources(rule), chats: [] };
    if (!rule.chats.length) return rule;
    const known = rule.chats.includes(chat);
    const chats = known ? rule.chats : [...rule.chats, chat];
    const sources = ruleSources(rule);
    if (!hasIds(pair) || !sources) return { ...rule, chats };
    const bound = sources.filter(src => src.name === chat);
    if ((known && !bound.length) || bound.some(src => samePair(src, pair))) return { ...rule, chats };
    return { ...rule, chats, sources: [...sources, { name: chat, ...pickIds(pair) }] };
  }

  // Without ids this is main's, over the entries without ids: the one of that name is turned on, or one is added. With ids
  // only the entry with that name and pair is turned on, or one is added. No other entry is touched, so trusting a renamed
  // chat never turns its old name back on
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

  // A rule's chat limit on import: main's name strings, plus the pairs of names it still has. null drops the whole rule:
  // a limit that is not a list, holds anything but names, loses every name, or has pairs that can't be read must never
  // turn into "any chat"
  function sanitizeLimit(rule) {
    if (rule.chats === undefined) return { chats: [] };
    if (!Array.isArray(rule.chats) || rule.chats.some(c => typeof c !== 'string')) return null;
    const chats = rule.chats.filter(Boolean);
    const sources = ruleSources(rule);
    if ((rule.chats.length && !chats.length) || !sources) return null;
    const kept = sources.filter(src => chats.includes(src.name));
    return { chats, ...(kept.length && { sources: kept }) };
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
        .map(s => {
          const limit = sanitizeLimit(s);
          return limit && { id: String(s.id || newId()), host: normalizeHost(s.host), sub: !!s.sub, on: s.on !== false, ...limit };
        })
        .filter(s => s && s.host);
    }
    if (Array.isArray(raw.chats)) {
      // An entry without a name needs its pair; versions without ids drop it
      out.chats = raw.chats
        .filter(c => c && typeof c === 'object' && typeof c.name === 'string' && readPair(c) && (c.name || hasIds(readPair(c))))
        .map(c => ({ id: String(c.id || newId()), name: c.name, ...pickIds(readPair(c)), on: c.on !== false }));
    }
    if (Array.isArray(raw.actions)) {
      out.actions = raw.actions
        .filter(a => a && typeof a.title === 'string' && a.title)
        .map(a => {
          const limit = sanitizeLimit(a);
          return limit && {
            id: String(a.id || newId()),
            title: a.title.slice(0, 120),
            ...(typeof a.policy === 'string' && a.policy && { policy: a.policy.slice(0, 200) }),
            ...(typeof a.site === 'string' && normalizeHost(a.site) && { site: normalizeHost(a.site), ...(a.sub === true && { sub: true }) }),
            on: a.on !== false,
            ...limit,
          };
        })
        .filter(Boolean);
    }
    return out;
  }

  return { SETTINGS_DEFAULTS, LOCAL_DEFAULTS, LOG_LIMIT, STORE_URL, REPO_URL, ALWAYS_RE, ONCE_RE, DENY_RE, CONTEXT_RE, APPROVALS_TAB_RE, optionRole, pickAllowButtons, clickTarget, samePick, cleanText, normalizeHost, hostMatches, parseCard, cardKey, cardLabel, sourceId, cardPair, hasIds, chatMatches, sameChoice, chatChoices, listsChat, limitChoices, limitOptions, toggleLimit, setLimit, isTrusted, isPurchase, addSiteRule, addActionRule, addChatRule, mergePending, sanitizeSettings };
})();

if (typeof module !== 'undefined') module.exports = AAM;
