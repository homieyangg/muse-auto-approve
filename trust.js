'use strict';

// "Trust" on a recent-activity row: which rows offer it, the rule it saves, and undoing that one change.
// It never edits what an existing rule matches: it re-enables or extends a rule only when its criteria are exactly the
// card's, and otherwise appends a new rule
const AAT = (() => {
  const aam = typeof AAM !== 'undefined' ? AAM : require('./shared.js');

  const bare = host => aam.bareHost(host || '');

  // Entry-level conditions. Action entries need a stored purchase answer and a policy: without a policy the rule would
  // match by title alone, and an upload card read without its destination would then be trusted for any site
  function trustable(entry) {
    if (!entry.host && !entry.action) return false;
    if (aam.isPurchase(entry)) return false;
    if (entry.host) return true;
    if (entry.purchase == null || !entry.policy) return false;
    return entry.policy !== aam.UPLOAD_POLICY || !!entry.site;
  }

  // True when this entry's card would still stop and ask with the current settings
  function wouldAsk(settings, entry) {
    if (aam.isTrusted(settings, entry)) return false;
    return !(settings.mode === 'all' && (entry.host || entry.site || settings.includeActions));
  }

  function scopes(entry) {
    return entry.chat ? ['any', 'only'] : ['any'];
  }

  // What the saved rule matches. The matcher ignores a leading www, so the host is stored and shown without it
  function criteria(entry) {
    if (entry.host) return { list: 'sites', match: { host: bare(entry.host), sub: false } };
    return { list: 'actions', match: { title: entry.action, policy: entry.policy, ...(entry.site && { site: bare(entry.site) }) } };
  }

  function sameCriteria(list, rule, match) {
    if (rule.sub) return false;
    if (list === 'sites') return bare(rule.host) === match.host;
    return rule.title === match.title && (rule.policy || '') === match.policy && bare(rule.site) === (match.site || '');
  }

  const sameChats = (a, b) => a.length === b.length && a.every(c => b.includes(c));
  const canon = rule => JSON.stringify(Object.keys(rule).sort().map(k => [k, rule[k]]));

  function freshId(rules) {
    let id = aam.newId();
    while (rules.some(r => r.id === id)) id = aam.newId();
    return id;
  }

  // Returns the settings patch and the undo record, or null when the row offers nothing for this scope.
  // A rule is reused only when its id is unique and its criteria are the card's: a disabled one whose chats are exactly the
  // pick is turned back on, and for "only" an enabled one limited to other chats gains this chat. Anything else is appended
  function planTrust(settings, entry, scope) {
    if (!scopes(entry).includes(scope) || !trustable(entry) || !wouldAsk(settings, entry)) return null;
    const { list, match } = criteria(entry);
    const rules = settings[list] || [];
    const chats = scope === 'only' ? [entry.chat] : [];
    const exact = rules.filter(r => sameCriteria(list, r, match) && rules.filter(o => o.id === r.id).length === 1);
    const off = exact.find(r => !r.on && sameChats(r.chats, chats));
    const limited = scope === 'only' && exact.find(r => r.on && r.chats.length);
    const prev = off || limited || null;
    const after = off ? { ...off, on: true }
      : limited ? { ...limited, chats: [...limited.chats, entry.chat] }
      : { id: freshId(rules), ...match, chats, on: true };
    const next = prev ? rules.map(r => (r.id === prev.id ? after : r)) : [...rules, after];
    return { patch: { [list]: next }, change: { list, key: entry.key, id: after.id, prev, after } };
  }

  // The inverse of one trust click, only while that rule is still exactly as the click left it; null otherwise
  function planUndo(settings, change) {
    const rules = settings[change.list] || [];
    const hits = rules.filter(r => r.id === change.id);
    if (hits.length !== 1 || canon(hits[0]) !== canon(change.after)) return null;
    if (!change.prev) return { [change.list]: rules.filter(r => r.id !== change.id) };
    return { [change.list]: rules.map(r => (r.id === change.id ? change.prev : r)) };
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

  // Row label with hosts as the matcher reads them, so the row names exactly what Trust saves
  function rowLabel(entry, t) {
    return aam.cardLabel({ ...entry, host: bare(entry.host), site: bare(entry.site) }, t);
  }

  // storage is chrome.storage.sync. chrome.storage has no compare-and-set, so the lists are read right before the write,
  // with nothing awaited in between, instead of using the page's copy
  async function trust(storage, entry, scope) {
    const plan = planTrust(await storage.get(aam.SETTINGS_DEFAULTS), entry, scope);
    if (!plan) return null;
    await storage.set(plan.patch);
    return plan.change;
  }

  async function undo(storage, change) {
    const patch = planUndo(await storage.get({ [change.list]: [] }), change);
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

    // Per shown entry: 'trusted' (undo on the first shown row of that card, while the rule is untouched since),
    // 'offer' (open when its scope buttons show) or ''
    function states(settings, log, shown) {
      const offered = offers(settings, log);
      const undoable = !!last && !!planUndo(settings, last);
      const out = new Map();
      let undoShown = false;
      for (const entry of shown) {
        if (last && entry.key === last.key && !wouldAsk(settings, entry)) {
          out.set(entry, { state: 'trusted', undo: undoable && !undoShown });
          undoShown = true;
        } else if (offered.has(entry)) out.set(entry, { state: 'offer', open: entry.key === openKey });
        else out.set(entry, { state: '' });
      }
      return out;
    }

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

  return { trustable, wouldAsk, offers, scopes, planTrust, planUndo, rowLabel, trust, undo, controls };
})();

if (typeof module !== 'undefined') module.exports = AAT;
