'use strict';

// "Trust" on a recent-activity row: which rows offer it, the rule it saves, and undoing that one change.
// It never edits what an existing rule matches: it re-enables or extends a rule only when its criteria are exactly the
// card's, and otherwise appends a new rule. Website rows offer nothing until SITE_POLICIES has a value; action and upload
// rows save a strict rule under strictActions (AAM.strictMatch)
const AAT = (() => {
  const aam = typeof AAM !== 'undefined' ? AAM : require('./shared.js');

  // The matcher strips one leading www from both sides; this is only for comparing rules and labels, never for storing
  const bare = host => aam.bareHost(host || '');

  // Verified muse policy types for website access; none yet, so no website row offers Trust. Browser connector types such as
  // connector.browser.page.goto or .download can name a site in the title but are not website access
  const SITE_POLICIES = [];

  // parseCard reads any card whose title says open plus a hostname as a website, so the title alone is no evidence. A row is
  // a website only when muse's approval data, as content.js logged it, says so; an empty, ambiguous (several approvals) or
  // mixed read, and rows logged before the data was kept, say nothing. Only SITE_POLICIES counts for now. If website cards
  // turn out to carry no policy type, "the approval's own host (entry.approvalHost) equals the parsed host" goes here instead
  // A row without an approval id can't be tied to the other reads of its approval, so it is never evidence
  function siteEvidence(entry) {
    return !!entry.approvalId && !entry.mixed && SITE_POLICIES.includes(entry.policy);
  }

  // An action or upload row, with muse's data for one approval read fresh, no purchase seen and purchase known to be false.
  // An upload also needs its destination as normalizeHost gives it
  function actionEvidence(entry) {
    if (!entry.action || !entry.approvalId || entry.mixed || entry.purchase !== false) return false;
    if (!aam.strictPolicy(entry.policy)) return false;
    if (entry.policy !== aam.UPLOAD_POLICY) return !entry.site;
    return !!entry.site && aam.normalizeHost(entry.site) === entry.site;
  }

  // A row parsed as a website (a host in the title) is one whatever its policy: the matcher takes such cards down the
  // website path, so an action rule would never cover them
  const isSiteRow = entry => !!entry.host;

  // Rows logged before EVIDENCE_VERSION may hold evidence read from a node muse had reused, so they offer nothing
  const currentEvidence = entry => entry.evidenceVersion === aam.EVIDENCE_VERSION;

  // Approval ids that any row of the log, under any card key, or the stored doubts (content.js) show as a purchase or a mix
  function doubtedIds(log, doubts) {
    const ids = new Set(Array.isArray(doubts) ? doubts : []);
    for (const e of log || []) if (e?.approvalId && (e.purchase === true || e.mixed)) ids.add(e.approvalId);
    return ids;
  }

  function trustable(entry, doubted) {
    if (aam.isPurchase(entry) || !currentEvidence(entry) || doubted.has(entry.approvalId)) return false;
    if (isSiteRow(entry)) return siteEvidence(entry) && !!aam.normalizeHost(entry.host);
    return actionEvidence(entry);
  }

  // True when this card would still stop and ask: Allow everything approves website and upload cards, and other actions
  // only with "include actions" on
  function wouldAsk(settings, entry) {
    const all = settings.mode === 'all' && !!(entry.host || entry.site || settings.includeActions);
    return !all && !aam.isTrusted(settings, entry);
  }

  function scopes(entry) {
    return entry.chat ? ['any', 'only'] : ['any'];
  }

  // Compared the way hostMatches compares, so a rule for www.a.example and one for a.example count as the same
  const sameSite = (rule, host) => !rule.sub && bare(rule.host) === bare(host);

  const sameChats = (a, b) => a.length === b.length && a.every(c => b.includes(c));
  const canon = rule => JSON.stringify(Object.keys(rule).sort().map(k => [k, rule[k]]));

  function freshId(rules) {
    let id = aam.newId();
    while (rules.some(r => r?.id === id)) id = aam.newId();
    return id;
  }

  // addSiteRule isn't used because it merges into any rule for the host, including one with subdomains, a duplicate id, or
  // a disabled one whose old scope comes back. Here a rule is reused only when its id is unique and its host and sub are the
  // card's: a disabled one whose chats are exactly the pick is turned back on, and for "only" an enabled one limited to
  // other chats gains this chat. Anything else is appended, with the host as normalizeHost gives it
  function planSite(settings, entry, chats) {
    const host = aam.normalizeHost(entry.host);
    return planRule(settings.sites || [], 'sites', chats, r => sameSite(r, host), id => ({ id, host, sub: false, chats, on: true }));
  }

  // Same merge for action and upload rows, over valid strict rules with the same policy and site only. addActionRule isn't
  // used: it merges into a title-or-policy rule under actions and widens what it matches
  function planAction(settings, entry, chats) {
    const { policy, site } = entry;
    const usable = aam.usableStrictRules(settings);
    const same = r => usable.includes(r) && r.policy === policy && (r.site || '') === site;
    const rules = Array.isArray(settings.strictActions) ? settings.strictActions : [];
    const taken = [...rules, ...(Array.isArray(settings.actions) ? settings.actions : [])];
    return planRule(rules, 'strictActions', chats, same,
      id => ({ id, title: entry.action.slice(0, 120), policy, ...(site && { site }), chats, on: true }), taken);
  }

  // taken is every id the new rule must not reuse
  function planRule(rules, list, chats, same, make, taken = rules) {
    const exact = rules.filter(r => same(r) && rules.filter(o => o?.id === r.id).length === 1);
    const off = exact.find(r => !r.on && sameChats(r.chats, chats));
    const limited = chats.length > 0 && exact.find(r => r.on && r.chats.length);
    const prev = off || limited || null;
    const after = off ? { ...off, on: true }
      : limited ? { ...limited, chats: [...limited.chats, ...chats] }
      : make(freshId(taken));
    const next = prev ? rules.map(r => (r?.id === prev.id ? after : r)) : [...rules, after];
    return { patch: { [list]: next }, list, id: after.id, prev, after };
  }

  // Returns the patch and the undo record, or null when the row offers nothing for this scope. A row the saved rule would
  // not make the matcher trust gets no offer. doubted is doubtedIds over the whole log
  function planTrust(settings, entry, scope, doubted = new Set()) {
    if (!scopes(entry).includes(scope) || !trustable(entry, doubted) || !wouldAsk(settings, entry)) return null;
    const chats = scope === 'only' ? [entry.chat] : [];
    const plan = isSiteRow(entry) ? planSite(settings, entry, chats) : planAction(settings, entry, chats);
    if (!aam.isTrusted({ ...settings, ...plan.patch }, entry)) return null;
    return { patch: plan.patch, change: { key: entry.key, list: plan.list, id: plan.id, prev: plan.prev, after: plan.after } };
  }

  // The inverse of one trust click, only while that rule is still exactly as the click left it; null otherwise
  function planUndo(settings, change) {
    const list = change.list || 'sites';
    const rules = settings[list] || [];
    const hits = rules.filter(r => r?.id === change.id);
    if (hits.length !== 1 || canon(hits[0]) !== canon(change.after)) return null;
    if (!change.prev) return { [list]: rules.filter(r => r?.id !== change.id) };
    return { [list]: rules.map(r => (r?.id === change.id ? change.prev : r)) };
  }

  // Newest first; only the newest entry of each card gets the button. doubts is chrome.storage.local approvalDoubts
  function offers(settings, log, doubts = []) {
    const doubted = doubtedIds(log, doubts);
    const seen = new Set();
    const out = new Set();
    for (const entry of log) {
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      if (scopes(entry).some(scope => planTrust(settings, entry, scope, doubted))) out.add(entry);
    }
    return out;
  }

  // a.example and www.a.example are one site to the matcher, so the label drops the www. A host that still starts with
  // www after that (www.www.a.example) matches only itself and is shown as is
  function shownHost(host) {
    const b = bare(host);
    return b.startsWith('www.') ? host : b;
  }

  // Action and upload rows keep main's label: the upload one names the exact destination a strict rule matches
  function rowLabel(entry, t) {
    return aam.cardLabel(entry.host ? { ...entry, host: shownHost(entry.host) } : entry, t);
  }

  // Per shown entry: 'trusted' (undo on the first shown row of the card, while the rule is untouched since the click),
  // 'offer' (open when its scope buttons show) or ''. Purchase rows sharing the card key never show Trusted
  function rowStates(settings, log, shown, { last = null, openKey = '', doubts = [] } = {}) {
    const offered = offers(settings, log, doubts);
    const doubted = doubtedIds(log, doubts);
    const undoable = !!last && !!planUndo(settings, last);
    const out = new Map();
    let undoShown = false;
    for (const entry of shown) {
      if (last && entry.key === last.key && trustable(entry, doubted) && !wouldAsk(settings, entry)) {
        out.set(entry, { state: 'trusted', undo: undoable && !undoShown });
        undoShown = true;
      } else if (offered.has(entry)) out.set(entry, { state: 'offer', open: entry.key === openKey });
      else out.set(entry, { state: '' });
    }
    return out;
  }

  // The row as the log holds it now: the entry the menu was opened on may since have been read as a purchase or mixed, or
  // a newer row of the card taken the offer. Only the same row (time and approval id), still the card's newest, counts
  function freshRow(log, entry) {
    const newest = log.find(e => e.key === entry.key);
    return newest && newest.ts === entry.ts && (newest.approvalId || '') === (entry.approvalId || '') ? newest : null;
  }

  // storage is chrome.storage.sync and logStorage chrome.storage.local. chrome.storage has no compare-and-set, so the rule
  // list is read right before the write, with nothing awaited in between, instead of using the page's copy
  async function trust(storage, logStorage, entry, scope) {
    const { log, approvalDoubts } = await logStorage.get({ log: [], approvalDoubts: [] });
    const row = freshRow(log || [], entry);
    if (!row) return null;
    const plan = planTrust(await storage.get(aam.SETTINGS_DEFAULTS), row, scope, doubtedIds(log, approvalDoubts));
    if (!plan) return null;
    await storage.set(plan.patch);
    return plan.change;
  }

  async function undo(storage, change) {
    const list = change.list || 'sites';
    const patch = planUndo(await storage.get({ [list]: [] }), change);
    if (patch) await storage.set(patch);
    return !!patch;
  }

  // Row controls for the popup and the options page. The undo record lives until the next trust click or the page closes
  function controls({ t, storage, logStorage, render }) {
    let openKey = '';
    let last = null;
    const button = (className, text, onClick) => {
      const b = document.createElement('button');
      b.className = className;
      b.textContent = text;
      b.addEventListener('click', onClick);
      return b;
    };

    const states = (settings, log, shown, doubts) => rowStates(settings, log, shown, { last, openKey, doubts });

    function trustButton(entry, open) {
      return button(open ? 'tb on' : 'tb', t('trust'), () => {
        openKey = openKey === entry.key ? '' : entry.key;
        render();
      });
    }

    async function pick(entry, scope) {
      openKey = '';
      last = await trust(storage, logStorage, entry, scope);
      render();
    }

    function pickButtons(entry) {
      const wrap = document.createElement('div');
      wrap.className = 'pick-btns';
      wrap.append(button('btn', t('anyChat'), () => pick(entry, 'any')));
      if (scopes(entry).includes('only')) {
        const only = button('btn', t('onlyChat', entry.chat), () => pick(entry, 'only'));
        only.title = t('onlyChat', entry.chat);
        wrap.append(only);
      }
      wrap.append(button('btn link', t('cancel'), () => { openKey = ''; render(); }));
      return wrap;
    }

    function undoButton(className) {
      return button(className, t('undo'), async () => {
        const change = last;
        last = null;
        render();
        // Changed elsewhere since the click: keep showing Trusted, without Undo
        if (change && !(await undo(storage, change))) last = change;
        render();
      });
    }

    return { states, trustButton, pickButtons, undoButton };
  }

  return { SITE_POLICIES, doubtedIds, trustable, wouldAsk, offers, scopes, planTrust, planUndo, rowLabel, rowStates, trust, undo, controls };
})();

if (typeof module !== 'undefined') module.exports = AAT;
