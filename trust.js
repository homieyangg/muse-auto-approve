'use strict';

// "Trust" on a recent-activity row: which rows offer it, the rule it saves, and undoing that one change
const AAT = (() => {
  const aam = typeof AAM !== 'undefined' ? AAM : require('./shared.js');

  // True when this entry's card would still stop and ask with the current settings. Purchases never qualify, and action
  // entries written before the log stored `purchase` are skipped since their purchase state is unknown
  function wouldAsk(settings, entry) {
    if (!entry.host && !entry.action) return false;
    if (aam.isPurchase(entry)) return false;
    if (!entry.host && entry.purchase == null) return false;
    if (aam.isTrusted(settings, entry)) return false;
    return !(settings.mode === 'all' && (entry.host || entry.site || settings.includeActions));
  }

  // The log is newest first; only the newest entry of each card gets the button
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

  function scopes(entry) {
    return entry.chat ? ['any', 'only'] : ['any'];
  }

  // The rule list with this entry's rule added or merged; "only" limits it to exactly the entry's chat
  function addRule(settings, entry, scope) {
    const chat = scope === 'only' ? entry.chat : '';
    if (entry.host) return { list: 'sites', rules: aam.addSiteRule(settings.sites, entry.host, { chat }) };
    const rules = aam.addActionRule(settings.actions || [], entry.action, { chat, policy: entry.policy || '', site: entry.site || '' });
    return { list: 'actions', rules };
  }

  // The one rule a trust click changed, with its state before the click (null when the click created it)
  function changedRule(before, after) {
    const old = new Map(before.map(r => [r.id, r]));
    for (const rule of after) {
      const prev = old.get(rule.id);
      if (!prev) return { id: rule.id, prev: null };
      if (JSON.stringify(prev) !== JSON.stringify(rule)) return { id: rule.id, prev };
    }
    return null;
  }

  // Returns the settings patch and the undo record, or null when the scope isn't offered, nothing would change, or the
  // merge would trust more than the picked scope
  function planTrust(settings, entry, scope) {
    if (!scopes(entry).includes(scope) || !wouldAsk(settings, entry)) return null;
    const { list, rules } = addRule(settings, entry, scope);
    const change = changedRule(settings[list] || [], rules);
    if (!change) return null;
    // An enabled rule that covers subdomains would extend them to this chat too; only a disabled one is reset to sub off
    if (change.prev && rules.find(r => r.id === change.id).sub) return null;
    return { patch: { [list]: rules }, change: { list, key: entry.key, ...change } };
  }

  // The inverse of one trust click applied to the current lists, so changes made elsewhere since then are kept
  function planUndo(settings, change) {
    const rules = settings[change.list] || [];
    if (!change.prev) return { [change.list]: rules.filter(r => r.id !== change.id) };
    return { [change.list]: rules.map(r => (r.id === change.id ? change.prev : r)) };
  }

  // storage is chrome.storage.sync; both read the settings fresh instead of using the page's copy
  async function trust(storage, entry, scope) {
    const plan = planTrust(await storage.get(aam.SETTINGS_DEFAULTS), entry, scope);
    if (!plan) return null;
    await storage.set(plan.patch);
    return plan.change;
  }

  async function undo(storage, change) {
    const current = await storage.get({ [change.list]: [] });
    await storage.set(planUndo(current, change));
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

    // Per shown entry: 'trusted' (with undo on the first shown row of that card), 'offer' (open when its scope buttons show) or ''
    function states(settings, log, shown) {
      const offered = offers(settings, log);
      const out = new Map();
      let undoShown = false;
      for (const entry of shown) {
        if (last && entry.key === last.key && !wouldAsk(settings, entry)) {
          out.set(entry, { state: 'trusted', undo: !undoShown });
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
        if (change) await undo(storage, change);
      });
    }

    return { states, trustButton, pickButtons, undoButton };
  }

  return { wouldAsk, offers, scopes, planTrust, planUndo, trust, undo, controls };
})();

if (typeof module !== 'undefined') module.exports = AAT;
