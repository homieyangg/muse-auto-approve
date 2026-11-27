'use strict';

// The options page and the popup with strict rules (strictActions): what they list, and that every control they render
// writes strictActions only to turn one listed rule on or off or to delete it. Both pages run in vm contexts with a stub DOM
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const AAM = require('../shared.js');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const SOURCES = { options: read('options.js'), popup: read('popup.js'), trust: read('trust.js') };
const UPLOAD = 'connector.browser.page.upload';
const POST = 'connector.example.post.create';

const strict = (id, extra = {}) => ({ id, title: 'Saved title', policy: POST, chats: [], on: true, ...extra });
const VALID = [
  strict('only-a', { chats: ['Chat A'] }),
  strict('upload', { policy: UPLOAD, site: 'a.example', chats: ['Chat A', 'Chat B'], on: false }),
  strict('any'),
];
const MALFORMED = [
  null, 'rule', 7,
  strict('string-chats', { chats: 'Chat A' }),
  strict('null-chats', { chats: null }),
  strict('dup'), strict('dup', { policy: UPLOAD, site: 'a.example' }),
  strict('legacy-1'),
  strict('bad-policy', { policy: 'connector.example.' }),
];
const LEGACY = [{ id: 'legacy-1', title: 'Post to Example', chats: [], on: true }];

// Every node a page creates or looks up records its listeners, so a test can fire all of them
function stubDocument() {
  const nodes = [];
  const byId = new Map();
  function node(tag) {
    const n = {
      tag, children: [], listeners: {}, dataset: {}, style: {}, hidden: false, checked: false, value: '', textContent: '',
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      append(...c) { this.children.push(...c); },
      prepend(...c) { this.children.unshift(...c); },
      replaceChildren(...c) { this.children = c; },
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      removeEventListener() {},
      contains: () => false,
      closest: () => null,
      querySelector() { return node('div'); },
      querySelectorAll: () => [],
      getAttribute: () => null,
      setAttribute() {},
      removeAttribute() {},
      click() {},
      focus() {},
      matches: () => false,
      cloneNode() { return node(tag); },
    };
    nodes.push(n);
    return n;
  }
  const doc = {
    nodes,
    activeElement: null,
    body: node('body'),
    querySelector: sel => { if (!byId.has(sel)) byId.set(sel, node(sel)); return byId.get(sel); },
    querySelectorAll: () => [],
    getElementById: id => doc.querySelector(`#${id}`),
    createElement: node,
    createElementNS: (_ns, tag) => node(tag),
    addEventListener() {},
  };
  return doc;
}

function stubI18n() {
  return {
    code: 'en', LANGUAGES: [], load: () => Promise.resolve(), apply() {}, ago: () => 'just now', clock: () => '12:00',
    t: (key, ...subs) => [key, ...subs].join(' '),
  };
}

function loadPage(page, sync, local = {}) {
  const doc = stubDocument();
  const store = { sync: { ...AAM.SETTINGS_DEFAULTS, ...structuredClone(sync) }, local: { ...AAM.LOCAL_DEFAULTS, ...structuredClone(local) }, session: { pendingByTab: {} } };
  const writes = [];
  const area = name => ({
    get(defaults) {
      return Promise.resolve(structuredClone({ ...defaults, ...Object.fromEntries(Object.keys(defaults).filter(k => k in store[name]).map(k => [k, store[name][k]])) }));
    },
    set(values) {
      if (name === 'sync') writes.push({ before: structuredClone(store.sync), values: structuredClone(values) });
      Object.assign(store[name], structuredClone(values));
      return Promise.resolve();
    },
  });
  const ctx = {
    AAM, I18N: stubI18n(), document: doc, URLSearchParams, setTimeout, clearTimeout,
    location: { hash: '#actions', reload() {} },
    window: { close() {}, addEventListener() {} },
    confirm: () => false,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    Blob: class {},
    chrome: {
      runtime: { getManifest: () => ({ version: '0.0.0' }), openOptionsPage() {} },
      i18n: { getUILanguage: () => 'en' },
      tabs: { create() {} },
      storage: { sync: area('sync'), local: area('local'), session: area('session'), onChanged: { addListener() {} } },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCES.trust, ctx);
  vm.runInContext(SOURCES[page], ctx);
  return { doc, store, writes, ctx };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

// Fires every listener on every node, with checkboxes both ticked and not, a few rounds since each render adds nodes
async function fireEverything(page) {
  for (let round = 0; round < 3; round++) {
    for (const n of [...page.doc.nodes]) {
      for (const [type, fns] of Object.entries(n.listeners)) {
        for (const checked of [true, false]) {
          n.checked = checked;
          n.value = 'b.example';
          const event = { type, target: n, currentTarget: n, preventDefault() {}, stopPropagation() {} };
          for (const fn of fns) {
            try { await fn(event); } catch { /* a handler that needs a real DOM; the writes are what is checked */ }
          }
          await flush();
        }
      }
    }
  }
}

// A strictActions write is allowed only when it turns one usable rule on or off or deletes it, leaving the rest as it was
function allowedStrictWrite({ before, values }) {
  const old = before.strictActions;
  const next = values.strictActions;
  const usable = AAM.usableStrictRules(before);
  if (!Array.isArray(next)) return false;
  if (next.length === old.length - 1) return usable.some(r => JSON.stringify(old.filter(o => o?.id !== r.id)) === JSON.stringify(next) && old.filter(o => o?.id === r.id).length === 1);
  if (next.length !== old.length) return false;
  const changed = old.map((o, i) => JSON.stringify(o) !== JSON.stringify(next[i]));
  // Setting a rule to the value it already has changes nothing
  if (!changed.includes(true)) return true;
  if (changed.filter(Boolean).length !== 1) return false;
  const i = changed.indexOf(true);
  return usable.some(r => r.id === old[i].id) && JSON.stringify({ ...old[i], on: next[i].on }) === JSON.stringify(next[i]) && typeof next[i].on === 'boolean';
}

for (const page of ['options', 'popup']) {
  test(`${page}: no control writes strictActions except turning one listed rule on or off or deleting it`, async () => {
    const loaded = loadPage(page, { actions: LEGACY, strictActions: [...VALID, ...MALFORMED] });
    await flush();
    await fireEverything(loaded);
    const strictWrites = loaded.writes.filter(w => 'strictActions' in w.values);
    for (const w of strictWrites) assert.ok(allowedStrictWrite(w), JSON.stringify(w.values.strictActions));
    if (page === 'options') {
      // Toggling and deleting were reached, so the check above covered them
      assert.ok(strictWrites.some(w => w.values.strictActions.length === w.before.strictActions.length), 'toggle');
    }
    assert.ok(strictWrites.some(w => w.values.strictActions.length < w.before.strictActions.length), 'delete');
    // Malformed rules are never removed or changed by the page
    for (const w of strictWrites) {
      const malformed = w.before.strictActions.filter(r => !AAM.usableStrictRules(w.before).includes(r));
      for (const bad of malformed) assert.ok(w.values.strictActions.some(r => JSON.stringify(r) === JSON.stringify(bad)), JSON.stringify(bad));
    }
  });

  test(`${page}: malformed strict rules render without throwing and are not listed`, async () => {
    for (const strictActions of [MALFORMED, 'rules', null, { 0: strict('x') }, [...VALID, ...MALFORMED]]) {
      const loaded = loadPage(page, { actions: LEGACY, strictActions });
      await flush();
      const count = loaded.doc.querySelector(page === 'options' ? '#nav-actions-n' : '#actions-n').textContent;
      const usable = Array.isArray(strictActions) ? AAM.usableStrictRules({ actions: LEGACY, strictActions }).length : 0;
      assert.equal(Number(count), LEGACY.length + usable, JSON.stringify(strictActions));
    }
  });
}

test('options: a strict rule\'s panel has no chat, site or subdomain controls', async () => {
  const loaded = loadPage('options', { strictActions: [strict('upload', { policy: UPLOAD, site: 'a.example', chats: ['Chat A'] })] });
  await flush();
  const detail = loaded.doc.querySelector('#action-detail');
  const all = [];
  const walk = n => { if (n && typeof n === 'object') { all.push(n); (n.children || []).forEach(walk); } };
  detail.children.forEach(walk);
  assert.ok(all.length > 0);
  assert.deepEqual(all.filter(n => n.tag === 'input').length, 0);
  assert.ok(all.some(n => n.tag === 'button' && n.textContent === 'deleteRule'));
});

test('toggle and delete act on one usable rule by id only', () => {
  const settings = { actions: LEGACY, strictActions: [...VALID, ...MALFORMED] };
  assert.deepEqual(AAM.toggleStrictRule(settings, 'only-a', false).strictActions.map(r => r?.on), [false, false, true, ...MALFORMED.map(r => r?.on)]);
  for (const id of ['dup', 'legacy-1', 'string-chats', 'null-chats', 'bad-policy', 'missing', undefined]) {
    assert.equal(AAM.toggleStrictRule(settings, id, true), null, String(id));
    assert.equal(AAM.removeStrictRule(settings, id), null, String(id));
  }
  assert.equal(AAM.toggleStrictRule(settings, 'only-a', 'false'), null);
  assert.deepEqual(AAM.removeStrictRule(settings, 'any').strictActions, [VALID[0], VALID[1], ...MALFORMED]);
  assert.equal(AAM.toggleStrictRule({ strictActions: 'rules' }, 'only-a', true), null);
});

// Codex round 2, item 5: both pages hand the stored doubts to the row states
test('a row whose approval id is a stored doubt shows no Trust on either page', async () => {
  const e = { ts: Date.now(), host: '', chat: 'Chat A', title: 'Post to Example', action: 'Post to Example', policy: POST, approvalHost: '', approvalId: 'appr-1', purchase: false, mixed: false, evidenceVersion: AAM.EVIDENCE_VERSION, site: '', result: 'pending' };
  const log = [{ ...e, key: AAM.cardKey(e) }];
  for (const page of ['options', 'popup']) {
    for (const [doubts, shown] of [[[], 1], [['appr-1'], 0]]) {
      const loaded = loadPage(page, {}, { log, approvalDoubts: doubts });
      await flush();
      assert.equal(loaded.doc.nodes.filter(n => n.tag === 'button' && n.textContent === 'trust').length, shown, `${page} ${doubts}`);
    }
  }
});
