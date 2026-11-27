'use strict';

// "Trust" on a recent-activity website row: which rows offer it, the site rule it saves, and undoing that one change.
// It never edits what an existing rule matches: it re-enables or extends a rule only when its host and sub are exactly the
// card's, and otherwise appends a new rule. Action and upload rows don't offer it
const AAT = (() => {
  const aam = typeof AAM !== 'undefined' ? AAM : require('./shared.js');

  // The matcher strips one leading www from both sides; this is only for comparing rules and labels, never for storing
  const bare = host => aam.bareHost(host || '');

  function trustable(entry) {
    return !!entry.host && !!aam.normalizeHost(entry.host) && !aam.isPurchase(entry);
  }

  // True when this website card would still stop and ask: Allow everything approves every website card
  function wouldAsk(settings, entry) {
    return settings.mode !== 'all' && !aam.isTrusted(settings, entry);
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
    while (rules.some(r => r.id === id)) id = aam.newId();
    return id;
  }

  // Returns the sites patch and the undo record, or null when the row offers nothing for this scope.
  // addSiteRule isn't used because it merges into any rule for the host, including one with subdomains, a duplicate id, or
  // a disabled one whose old scope comes back. Here a rule is reused only when its id is unique and its host and sub are the
  // card's: a disabled one whose chats are exactly the pick is turned back on, and for "only" an enabled one limited to
  // other chats gains this chat. Anything else is appended, with the host as normalizeHost gives it
  function planTrust(settings, entry, scope) {
    if (!scopes(entry).includes(scope) || !trustable(entry) || !wouldAsk(settings, entry)) return null;
    const host = aam.normalizeHost(entry.host);
    const rules = settings.sites || [];
    const chats = scope === 'only' ? [entry.chat] : [];
    const exact = rules.filter(r => sameSite(r, host) && rules.filter(o => o.id === r.id).length === 1);
    const off = exact.find(r => !r.on && sameChats(r.chats, chats));
    const limited = scope === 'only' && exact.find(r => r.on && r.chats.length);
    const prev = off || limited || null;
    const after = off ? { ...off, on: true }
      : limited ? { ...limited, chats: [...limited.chats, entry.chat] }
      : { id: freshId(rules), host, sub: false, chats, on: true };
    const next = prev ? rules.map(r => (r.id === prev.id ? after : r)) : [...rules, after];
    return { patch: { sites: next }, change: { key: entry.key, id: after.id, prev, after } };
  }

  // The inverse of one trust click, only while that rule is still exactly as the click left it; null otherwise
  function planUndo(settings, change) {
    const rules = settings.sites || [];
    const hits = rules.filter(r => r.id === change.id);
    if (hits.length !== 1 || canon(hits[0]) !== canon(change.after)) return null;
    if (!change.prev) return { sites: rules.filter(r => r.id !== change.id) };
    return { sites: rules.map(r => (r.id === change.id ? change.prev : r)) };
  }

  // Newest first; only the newest entry of each card gets the button
  function offers(settings, log) {
    const seen = new Set();
    const out = new Set();
    for (const entry of log) {
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      if (scopes(entry).some(scope => planTrust(settings, entry, scope))) out.add(entry);
    }
    return out;
  }

  // a.example and www.a.example are one site to the matcher, so the label drops the www. A host that still starts with
  // www after that (www.www.a.example) matches only itself and is shown as is
  function shownHost(host) {
    const b = bare(host);
    return b.startsWith('www.') ? host : b;
  }

  // Action and upload rows keep main's label
  function rowLabel(entry, t) {
    return aam.cardLabel(entry.host ? { ...entry, host: shownHost(entry.host) } : entry, t);
  }

  // Per shown entry: 'trusted' (undo on the first shown row of the card, while the rule is untouched since the click),
  // 'offer' (open when its scope buttons show) or ''. Purchase rows sharing the card key never show Trusted
  function rowStates(settings, log, shown, { last = null, openKey = '' } = {}) {
    const offered = offers(settings, log);
    const undoable = !!last && !!planUndo(settings, last);
    const out = new Map();
    let undoShown = false;
    for (const entry of shown) {
      if (last && entry.key === last.key && trustable(entry) && !wouldAsk(settings, entry)) {
        out.set(entry, { state: 'trusted', undo: undoable && !undoShown });
        undoShown = true;
      } else if (offered.has(entry)) out.set(entry, { state: 'offer', open: entry.key === openKey });
      else out.set(entry, { state: '' });
    }
    return out;
  }

  // storage is chrome.storage.sync. chrome.storage has no compare-and-set, so the sites list is read right before the write,
  // with nothing awaited in between, instead of using the page's copy
  async function trust(storage, entry, scope) {
    const plan = planTrust(await storage.get(aam.SETTINGS_DEFAULTS), entry, scope);
    if (!plan) return null;
    await storage.set(plan.patch);
    return plan.change;
  }

  async function undo(storage, change) {
    const patch = planUndo(await storage.get({ sites: [] }), change);
    if (patch) await storage.set(patch);
    return !!patch;
  }

  // Row controls for the popup and the options page. The undo record lives until the next trust click or the page closes
  function controls({ t, storage, render }) {
    let openKey = '';
    let last = null;
    const button = (className, text, onClick) => {
      const b = document.createElement('button');
      b.className = className;
      b.textContent = text;
      b.addEventListener('click', onClick);
      return b;
    };

    const states = (settings, log, shown) => rowStates(settings, log, shown, { last, openKey });

    function trustButton(entry, open) {
      return button(open ? 'tb on' : 'tb', t('trust'), () => {
        openKey = openKey === entry.key ? '' : entry.key;
        render();
      });
    }

    async function pick(entry, scope) {
      openKey = '';
      last = await trust(storage, entry, scope);
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

  return { trustable, wouldAsk, offers, scopes, planTrust, planUndo, rowLabel, rowStates, trust, undo, controls };
})();

if (typeof module !== 'undefined') module.exports = AAT;
