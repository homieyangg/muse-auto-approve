'use strict';

// The task-wide web-access card muse shows when its network default is "always ask". bridge.js runs for real on a
// fabricated React tree attached to a fake DOM, so content.js decides from the attributes main's bridge.js writes. The chat
// copy must click exactly what 1.4.0 (text rules) clicks; cards not sent down the text rules must click what main clicks
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const AAM = require('../shared.js');
const { markItem } = require('../bridge.js');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const HEAD_SOURCES = ['shared.js', 'guard.js', 'content.js'].map(read);
const MAIN_COMMIT = 'e17f0e2';
const show = (rev, files) => {
  try {
    return files.map(file => execFileSync('git', ['show', `${rev}:${file}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
};
// 1.4.0 had no guard.js; its content.js holds the trust decision
const V140 = show('v1.4.0', ['shared.js', 'content.js']);
const MAIN = show(MAIN_COMMIT, ['shared.js', 'guard.js', 'content.js']);

function parseCompound(sel) {
  const parts = [];
  let i = 0;
  const tag = sel.match(/^[a-z]+/i);
  if (tag) { parts.push(el => el.tag === tag[0].toLowerCase()); i = tag[0].length; }
  while (i < sel.length) {
    if (sel[i] === '[') {
      const end = sel.indexOf(']', i);
      const [, name, value] = sel.slice(i + 1, end).match(/^([\w-]+)(?:="([^"]*)")?$/);
      parts.push(el => (value === undefined ? el.attrs.has(name) : el.attrs.get(name) === value));
      i = end + 1;
    } else if (sel.startsWith(':not(', i)) {
      let depth = 1, j = i + 5;
      for (; depth; j++) depth += sel[j] === '(' ? 1 : sel[j] === ')' ? -1 : 0;
      const inner = parseCompound(sel.slice(i + 5, j - 1));
      parts.push(el => !inner(el));
      i = j;
    } else throw new Error(`unsupported selector ${sel}`);
  }
  return el => parts.every(p => p(el));
}

function matches(el, selector) {
  return selector.split(',').map(s => s.trim()).some(sel => {
    const chain = sel.split(/\s+/).map(parseCompound);
    if (!chain[chain.length - 1](el)) return false;
    let k = chain.length - 2;
    for (let p = el.parent; p && k >= 0; p = p.parent) if (p.tag && chain[k](p)) k--;
    return k < 0;
  });
}

class El {
  constructor(tag, attrs = {}, children = [], text = '') {
    this.tag = tag;
    this.attrs = new Map(Object.entries(attrs));
    this.children = [];
    this.text = text;
    this.parent = null;
    this.clicks = 0;
    for (const c of children) this.append(c);
  }
  append(c) { c.parent = this; this.children.push(c); return c; }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  removeAttribute(n) { this.attrs.delete(n); }
  hasAttribute(n) { return this.attrs.has(n); }
  matches(sel) { return matches(this, sel); }
  closest(sel) { for (let e = this; e && e.tag; e = e.parent) if (e.matches(sel)) return e; return null; }
  descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); }
  querySelectorAll(sel) { return this.descendants().filter(e => e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  contains(other) { for (let e = other; e; e = e.parent) if (e === this) return true; return false; }
  get isConnected() { let e = this; while (e.parent) e = e.parent; return e.isRoot === true; }
  get innerText() { return [this.text, ...this.children.map(c => c.innerText)].filter(Boolean).join(' '); }
  get textContent() { return this.innerText; }
  get childNodes() { return this.children; }
  get disabled() { return this.attrs.has('disabled'); }
  getClientRects() { return [{}]; }
  click() { this.clicks++; }
  dispatchEvent(e) { e.target = this; for (const fn of doc.listeners[e.type] || []) fn(e); return true; }
}

let doc;
function makeDocument() {
  const html = new El('html');
  const body = html.append(new El('body'));
  html.isRoot = true;
  doc = {
    documentElement: html,
    body,
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    dispatchEvent(e) { e.target = this; for (const fn of this.listeners[e.type] || []) fn(e); return true; },
    querySelectorAll: sel => html.querySelectorAll(sel),
    querySelector: sel => html.querySelector(sel),
    getElementById: id => html.descendants().find(e => e.getAttribute('id') === id) || null,
  };
  return doc;
}

function loadContent(sync, sources, local = {}) {
  const reports = [];
  const store = { sync: { ...AAM.SETTINGS_DEFAULTS, ...sync }, local: { allowOnce: [], log: [], dismissed: [], approvals: 0, ...local } };
  const area = name => ({
    get(defaults, cb) {
      const out = { ...defaults, ...Object.fromEntries(Object.keys(defaults).filter(k => k in store[name]).map(k => [k, store[name][k]])) };
      if (cb) cb(out);
      return Promise.resolve(out);
    },
    set(values) { Object.assign(store[name], values); return Promise.resolve(); },
  });
  const chrome = {
    runtime: { id: 'test', sendMessage(msg) { reports.push(msg); return Promise.resolve(); } },
    storage: { sync: area('sync'), local: area('local'), onChanged: { addListener() {} } },
  };
  class Ev { constructor(type, init = {}) { Object.assign(this, init); this.type = type; } }
  const ctx = {
    chrome, document: doc, console: { info() {}, warn() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: Ev, KeyboardEvent: Ev, PointerEvent: Ev,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  };
  vm.createContext(ctx);
  for (const source of sources) vm.runInContext(source, ctx);
  const pendingItems = () => Array.from(reports.filter(r => r.type === 'pending').at(-1)?.items || []);
  return { ctx, store, pendingItems, pending: () => pendingItems().map(i => i.key) };
}

const ID = 'network-attempt-test-1';
const CHAT = '測試聊天室';
const QUESTION = '是否允許Nova存取網路以執行此任務？';
const TITLE = '是否允許Nova存取網路以執行此任務';
const KEY = `tool.web_fetch|${CHAT}`;
const opt = (kind, labelKind, labelText, scope) => ({ kind, label: scope === undefined ? { kind: labelKind } : { kind: labelKind, scope }, labelText });
const TASK_WEB = opt('allow_once', 'allow_all_web_access_for_this_task', '允許');
const DENY = opt('deny', 'deny', '拒絕');

// The approval as recorded live (fake ids and assistant name)
function grantApproval({ id = ID, options = [TASK_WEB, DENY], question = 'network_turn_grant', policy = 'tool.web_fetch', host = 'example.org', text = QUESTION } = {}) {
  return {
    approvalId: id, policySubject: policy, host, port: 443, scheme: 'https', method: 'GET', path: '/',
    reason: 'Fetch web content from https://example.org', actionLabel: 'Web access for this task', workload: 'runtime_chat',
    declaredHosts: [], matchedPolicy: null, allowAlwaysScope: null, payloadPreview: '', turnGrantEligible: true, isExclusive: true,
    decisionOptions: Array.isArray(options) ? options.map(o => o?.kind) : null,
    serverPresentation: {
      payloadType: 'network', presentationKind: 'generic', summaryTitle: '此任務的網路存取權限',
      permissionQuestion: { kind: question, text },
      permissionCaption: '從⁨example.org⁩開始',
      decisionOptions: options,
    },
  };
}

function link(parent, children) {
  parent.child = children[0] || null;
  children.forEach((c, i) => { c.return = parent; c.sibling = children[i + 1] || null; });
}

function fiberRoot() {
  const container = {};
  const root = { stateNode: container, memoizedProps: {} };
  container.current = root;
  return root;
}

// Component holding the approval data -> host div (the card or item element) -> button row -> Button(key) -> span -> <button>.
// rowProps and buttonProps go on the button row and each Button component
function attachTree(parent, props, el, buttons, keys, { rowProps = {}, buttonProps = {} } = {}) {
  const comp = { memoizedProps: props };
  const host = { memoizedProps: {} };
  const row = { memoizedProps: rowProps };
  link(parent, [comp]);
  link(comp, [host]);
  link(host, [row]);
  const wrappers = buttons.map((b, i) => {
    const button = { key: keys[i], memoizedProps: { variant: 'primary', ...buttonProps } };
    const span = { memoizedProps: {} };
    const leaf = { memoizedProps: { type: 'button' } };
    link(button, [span]);
    link(span, [leaf]);
    b.__reactFiber$test = leaf;
    return button;
  });
  link(row, wrappers);
  el.__reactFiber$test = host;
  return comp;
}

function cardText(question = QUESTION) {
  return [new El('p', {}, [], question), new El('p', {}, [], '從⁨example.org⁩開始'), new El('p', {}, [], `此任務來自${CHAT}。`)];
}

function decisionButtons(options) {
  return options.map((o, i) => new El('button', i === 0 ? { 'data-hatch-approval-primary-action': 'true' } : { 'data-pel-click': 'chat_inline_approval_decision' }, [], o.labelText));
}

// A single-approval card on the chat surface (cta keys) or the approvals panel (compact, no cta keys)
function grantCard({ surface = 'chat', approval = grantApproval(), keys, props = { approval }, question, pending, tree } = {}) {
  const options = approval.serverPresentation.decisionOptions;
  const buttons = decisionButtons(options);
  const attrs = { 'data-testid': 'hatch-inline-approval-card', 'data-hatch-approval-surface': surface, 'data-hatch-single-approval': 'true' };
  const row = new El('div', {}, buttons);
  const card = new El('div', attrs, [...cardText(question), row]);
  const ctaKeys = keys || (surface === 'chat' ? options.map((o, i) => `${approval.approvalId}-cta-${i}-${o.kind}`) : options.map(() => null));
  attachTree(fiberRoot(), props, card, buttons, ctaKeys, tree);
  doc.body.append(surface === 'panel' ? new El('section', {}, [card]) : card);
  return { card, row, buttons, approval, pending };
}

// A button inside the card whose current fiber sits under the card's host without a cta key, as a details toggle would.
// bridge.js leaves it unmarked and the card clean
function withKeylessButton(fixture, text, attrs = {}) {
  const el = fixture.row.append(new El('button', attrs, [], text));
  const host = fixture.card.__reactFiber$test;
  const leaf = { memoizedProps: { type: 'button' } };
  link(host, [host.child, leaf]);
  el.__reactFiber$test = leaf;
  fixture.buttons.push(el);
  return fixture;
}

// A combined chat card holding two approvals, each in its own expandable item
function combinedCard(approvals) {
  const root = fiberRoot();
  const cardComp = { memoizedProps: { approvals } };
  const cardHost = { memoizedProps: {} };
  link(root, [cardComp]);
  link(cardComp, [cardHost]);
  const items = approvals.map(a => {
    const options = a.serverPresentation.decisionOptions;
    const buttons = decisionButtons(options);
    const item = new El('div', { role: 'button', 'aria-expanded': 'true' }, [new El('span', { title: QUESTION }, [], QUESTION), new El('div', {}, buttons)]);
    return { item, buttons, a, options };
  });
  const comps = items.map(({ item, buttons, a, options }) => {
    const holder = { memoizedProps: {} };
    attachTree(holder, { approval: a }, item, buttons, options.map((o, i) => `${a.approvalId}-cta-${i}-${o.kind}`));
    return holder.child;
  });
  link(cardHost, comps);
  const card = new El('div', { 'data-testid': 'hatch-inline-approval-card', 'data-hatch-approval-surface': 'chat' }, [...cardText(), ...items.map(i => i.item)]);
  card.__reactFiber$test = cardHost;
  doc.body.append(card);
  return { card, items, buttons: items.flatMap(i => i.buttons) };
}

// Runs bridge.js's markItem as its maa-mark listener and periodic pass do. onMark runs first on each request and may
// change the data, or return false to leave the request unanswered while the old attributes stay
function realBridge(pending, onMark = () => {}) {
  const pendingById = id => pending.find(a => a.approvalId === id) || null;
  for (const el of doc.querySelectorAll('[data-testid="hatch-inline-approval-card"], [aria-expanded]')) markItem(el, undefined, pendingById);
  doc.addEventListener('maa-mark', e => {
    const el = e.target;
    el.removeAttribute('data-maa-marked');
    if (onMark(el) === false) return;
    if (markItem(el, undefined, pendingById)) el.setAttribute('data-maa-marked', el.getAttribute('data-maa-mark-request') || '');
  });
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const quiet = fn => { const warn = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = warn; } };

async function run(build, sync, sources, { onMark, local } = {}) {
  makeDocument();
  const fixture = build();
  quiet(() => realBridge(fixture.pending || [fixture.approval || grantApproval()], onMark));
  const env = loadContent(sync, sources, local);
  env.ctx.scan();
  await tick();
  await tick();
  return { clicks: fixture.buttons.map(b => b.clicks), pending: env.pending(), fixture, env };
}

const SETUPS = {
  'trusted + site rule for the grant host': { sites: [{ id: 's1', host: 'example.org', sub: true, chats: [], on: true }] },
  'trusted, no rule': {},
  'trusted + action rule by policy': { actions: [{ id: 'a1', title: 'Some other title', policy: 'tool.web_fetch', chats: [], on: true }] },
  'trusted + action rule by title': { actions: [{ id: 'a2', title: TITLE, chats: [], on: true }] },
  'trusted chat': { chats: [{ id: 'c1', name: CHAT, on: true }] },
  'mode all, includeActions off': { mode: 'all' },
  'mode all, includeActions on': { mode: 'all', includeActions: true },
};
// What 1.4.0 does with the recorded card, the same on both surfaces: it is an action card, so only the trust decision for
// actions clicks it, and a site rule never does
const V140_CLICKS = {
  'trusted + site rule for the grant host': false,
  'trusted, no rule': false,
  'trusted + action rule by policy': true,
  'trusted + action rule by title': true,
  'trusted chat': true,
  'mode all, includeActions off': false,
  'mode all, includeActions on': true,
};

async function matrix(sources, build, surfaces = ['chat', 'panel']) {
  const rows = [];
  for (const surface of surfaces) {
    for (const [name, setup] of Object.entries(SETUPS)) {
      for (const preferAlways of [true, false]) {
        const result = await run(() => build(surface), { ...setup, preferAlways }, sources);
        rows.push({ label: `${surface}, ${name}, preferAlways ${preferAlways}`, surface, name, clicks: result.clicks, pending: result.pending });
      }
    }
  }
  return rows;
}

// Compares HEAD with 1.4.0 row by row after pinning 1.4.0's clicks, so two runs that both click nothing cannot pass
async function assertParity(build, expected, surfaces) {
  const before = await matrix(V140, build, surfaces);
  const after = await matrix(HEAD_SOURCES, build, surfaces);
  for (const [i, row] of before.entries()) {
    const clicks = row.clicks.map(() => 0);
    if (expected[row.name]) clicks[0] = 1;
    assert.deepEqual(row.clicks, clicks, `1.4.0: ${row.label}`);
    assert.deepEqual(after[i].clicks, row.clicks, row.label);
    assert.deepEqual(after[i].pending, row.pending, `pending: ${row.label}`);
  }
  return { before, after };
}

const parityOpts = { skip: (!V140 || !MAIN) && 'v1.4.0 or main is not in this clone' };

test('the task-wide web-access card clicks exactly what 1.4.0 clicks, on both surfaces', parityOpts, async () => {
  const { after } = await assertParity(surface => grantCard({ surface }), V140_CLICKS);
  // main differs on the chat rows only, so the rows above exercise the text-rule routing
  const main = await matrix(MAIN, surface => grantCard({ surface }));
  const changed = main.filter((row, i) => JSON.stringify(row.clicks) !== JSON.stringify(after[i].clicks)).map(r => r.label);
  assert.ok(changed.length > 0 && changed.every(l => l.startsWith('chat,')), changed.join('\n'));
});

// Codex round 2 on #17, each as a chat-card fixture
const ROUND2 = {
  // 1.4.0 reads the host from the title, so the card is a site card: an action rule does not cover it, a site rule does
  'assistant named example.org': {
    build: () => grantCard({ approval: grantApproval({ text: '是否允許example.org存取網路以執行此任務？' }), question: '是否允許example.org存取網路以執行此任務？' }),
    clicks: {
      'trusted + site rule for the grant host': true,
      'trusted, no rule': false,
      'trusted + action rule by policy': false,
      'trusted + action rule by title': false,
      'trusted chat': true,
      'mode all, includeActions off': true,
      'mode all, includeActions on': true,
    },
  },
  'card and buttons hold A, the button row holds [A, B]': {
    build: () => {
      const a = grantApproval();
      return grantCard({ approval: a, tree: { rowProps: { approvals: [a, grantApproval({ id: 'network-attempt-test-2' })] }, buttonProps: { approval: a } } });
    },
    clicks: V140_CLICKS,
  },
  'pending entry with the same id has decisionOptions {}': {
    build: () => grantCard({ pending: [grantApproval({ options: {} })] }),
    clicks: V140_CLICKS,
  },
  'deny option with label.scope null': {
    build: () => {
      const a = grantApproval({ options: [TASK_WEB, opt('deny', 'deny', '拒絕', null)] });
      return grantCard({ approval: a, pending: [a] });
    },
    clicks: V140_CLICKS,
  },
};

for (const [name, { build, clicks }] of Object.entries(ROUND2)) {
  test(`round 2: ${name}: the chat card clicks what 1.4.0 clicks`, parityOpts, async () => {
    await assertParity(() => build(), clicks, ['chat']);
  });
}

test('round 2 fixtures read clean on main bridge.js and take the text rules', () => {
  for (const [name, { build }] of Object.entries(ROUND2)) {
    makeDocument();
    const fixture = build();
    quiet(() => realBridge(fixture.pending || [fixture.approval]));
    assert.equal(fixture.card.getAttribute('data-maa-state'), 'clean', name);
    assert.equal(fixture.card.getAttribute('data-maa-policy'), 'tool.web_fetch', name);
    assert.deepEqual(fixture.buttons.map(b => b.getAttribute('data-maa-label-kind')), ['allow_all_web_access_for_this_task', 'deny'], name);
  }
});

const ALL_ACTIONS = { mode: 'all', includeActions: true };
const BY_POLICY = SETUPS['trusted + action rule by policy'];
const mainOpts = { skip: !MAIN && `${MAIN_COMMIT} is not in this clone` };

// Chat cards the condition does not send down the text rules: each clicks exactly what main clicks
test('chat cards outside the condition stay on main data path', mainOpts, async () => {
  const cases = {
    'extra single-site always': () => grantCard({ approval: grantApproval({ options: [TASK_WEB, opt('allow_always', 'allow_always_scoped', '一律允許此網站', 'destination'), DENY] }) }),
    'extra broad always': () => grantCard({ approval: grantApproval({ options: [TASK_WEB, opt('allow_always', 'allow_always_scoped', '一律允許所有動作', 'connector_all_actions'), DENY] }) }),
    'second allow once': () => grantCard({ approval: grantApproval({ options: [TASK_WEB, opt('allow_once', 'allow_once', '允許一次'), DENY] }) }),
    'grant with a scope': () => grantCard({ approval: grantApproval({ options: [opt('allow_once', 'allow_all_web_access_for_this_task', '允許', 'destination'), DENY] }) }),
    'grant with a non-string scope': () => grantCard({ approval: grantApproval({ options: [opt('allow_once', 'allow_all_web_access_for_this_task', '允許', {}), DENY] }) }),
    'grant as allow_always': () => grantCard({ approval: grantApproval({ options: [opt('allow_always', 'allow_all_web_access_for_this_task', '允許'), DENY] }) }),
    'other allow label kind': () => grantCard({ approval: grantApproval({ options: [opt('allow_once', 'allow_for_this_task', '允許'), DENY] }) }),
    'policy not tool.web_fetch': () => grantCard({ approval: grantApproval({ policy: 'connector.browser.page.open' }) }),
    'a keyless button beside the grant': () => withKeylessButton(grantCard(), '允許'),
    'a menu button in the card': () => withKeylessButton(grantCard(), '更多允許選項', { 'aria-haspopup': 'menu' }),
    'anomalous read (deny key does not map)': () => grantCard({ keys: [`${ID}-cta-0-allow_once`, `${ID}-cta-5-deny`] }),
    'two grants in a combined card': () => ({ ...combinedCard([grantApproval({ id: 'network-attempt-test-2' }), grantApproval({ id: 'network-attempt-test-3' })]), approval: null }),
  };
  for (const [name, build] of Object.entries(cases)) {
    for (const setup of [ALL_ACTIONS, BY_POLICY]) {
      for (const preferAlways of [true, false]) {
        const label = `${name}, ${setup === BY_POLICY ? 'action rule' : 'all + actions'}, preferAlways ${preferAlways}`;
        const head = await run(build, { ...setup, preferAlways }, HEAD_SOURCES);
        const main = await run(build, { ...setup, preferAlways }, MAIN);
        assert.ok(head.fixture.card.hasAttribute('data-maa-approval-id') || name.includes('combined'), label);
        assert.deepEqual(head.clicks, main.clicks, label);
        assert.deepEqual(head.pending, main.pending, `pending: ${label}`);
      }
    }
  }
});

test('the condition: clean, tool.web_fetch, no menu, one unscoped grant and only deny besides', () => {
  const grant = { kind: 'allow_once', labelKind: 'allow_all_web_access_for_this_task', scope: '' };
  const deny = { kind: 'deny', labelKind: 'deny', scope: '' };
  const base = { state: 'clean', policy: 'tool.web_fetch', menu: false, buttons: [grant, deny] };
  const yes = (patch, label) => assert.equal(AAM.takesTextRules({ ...base, ...patch }), true, label);
  const no = (patch, label) => assert.equal(AAM.takesTextRules({ ...base, ...patch }), false, label);
  yes({}, 'recorded card');
  yes({ buttons: [deny, grant, { kind: 'deny_always', labelKind: 'deny_always', scope: '' }] }, 'deny_always too');
  yes({ buttons: [grant] }, 'grant alone');
  no({ state: 'anomalous' }, 'anomalous');
  no({ state: '' }, 'no data');
  no({ policy: '' }, 'no policy');
  no({ policy: 'connector.browser.page.open' }, 'other policy');
  no({ menu: true }, 'menu');
  no({ buttons: [] }, 'no buttons');
  no({ buttons: [deny] }, 'no grant');
  no({ buttons: [grant, grant, deny] }, 'two grants');
  no({ buttons: [grant, { kind: '', labelKind: '', scope: '' }, deny] }, 'unmarked button');
  no({ buttons: [grant, { kind: 'allow_once', labelKind: 'allow_once', scope: '' }, deny] }, 'second allow once');
  no({ buttons: [grant, { kind: 'allow_always', labelKind: 'allow_always_scoped', scope: 'destination' }, deny] }, 'always');
  no({ buttons: [{ ...grant, scope: 'destination' }, deny] }, 'scoped grant');
  no({ buttons: [{ ...grant, scope: '?' }, deny] }, 'non-string scope');
  no({ buttons: [{ ...grant, kind: 'allow_always' }, deny] }, 'grant as always');
  no({ buttons: [grant, { kind: 'reject', labelKind: 'deny', scope: '' }] }, 'unknown kind');
  // optionRole and pickAllowButtons are untouched: the grant is still vetoed on the data path
  assert.equal(AAM.optionRole(grant), '');
  assert.equal(AAM.pickAllowButtons([{ ...grant, el: 'g', text: '允許', primary: true, menu: false }], 'clean'), null);
});

test('the pre-click re-check needs a fresh mark that still sends the same approval down the text rules', async () => {
  const control = await run(() => grantCard(), ALL_ACTIONS, HEAD_SOURCES);
  assert.deepEqual(control.clicks, [1, 0], 'control');
  // Requests: 1 is the scan's read, 2 and 3 are the re-checks before the click
  const cases = {
    'grant label kind changes in the data': (n, a) => { if (n > 1) a.serverPresentation.decisionOptions[0] = opt('allow_once', 'allow_for_this_task', '允許'); },
    'an always option appears in the data': (n, a, fixture) => {
      if (n !== 2) return;
      a.serverPresentation.decisionOptions.push(opt('allow_always', 'allow_always_scoped', '一律允許此網站', 'destination'));
      withKeylessButton(fixture, '一律允許此網站');
    },
    'bridge.js stops answering': n => n <= 1,
  };
  for (const [name, onMark] of Object.entries(cases)) {
    for (const onceOnly of [false, true]) {
      let n = 0, fixture = null, approval = null;
      const result = await run(() => {
        approval = grantApproval();
        fixture = grantCard({ approval });
        return fixture;
      }, onceOnly ? {} : ALL_ACTIONS, HEAD_SOURCES, { onMark: () => onMark(++n, approval, fixture), local: onceOnly ? { allowOnce: [KEY] } : {} });
      assert.deepEqual(result.clicks.slice(0, 2), [0, 0], `${name}, onceOnly ${onceOnly}`);
    }
  }
  const once = await run(() => grantCard(), {}, HEAD_SOURCES, { local: { allowOnce: [KEY] } });
  assert.deepEqual(once.clicks, [1, 0], 'just this once from the popup');
});

test('the chat and panel copies of one approval are clicked once', async () => {
  makeDocument();
  const approval = grantApproval();
  const chat = grantCard({ approval });
  const panel = grantCard({ surface: 'panel', approval });
  quiet(() => realBridge([approval]));
  const { ctx } = loadContent(ALL_ACTIONS, HEAD_SOURCES);
  ctx.scan();
  await tick();
  ctx.scan();
  await tick();
  assert.equal(chat.buttons[0].clicks + panel.buttons[0].clicks, 1);
});

// Strict rules from recent activity (AAM.strictMatch): the task-wide web-access card is not an action or upload row
test('the task-wide web-access card offers no Trust, and a strict rule for its policy never clicks it', async () => {
  const AAT = require('../trust.js');
  for (const surface of ['chat', 'panel']) {
    const untrusted = await run(() => grantCard({ surface }), {}, HEAD_SOURCES);
    for (let i = 0; i < 4; i++) await tick();
    const [row] = untrusted.env.store.local.log;
    assert.deepEqual([row.result, row.host, row.policy, row.approvalId], ['pending', '', 'tool.web_fetch', ID], surface);
    assert.equal(AAT.offers(AAM.SETTINGS_DEFAULTS, [row]).size, 0, surface);
    const strict = { actions: [{ id: 'r1', title: TITLE, policy: 'tool.web_fetch', match: 'strict', chats: [], on: true }] };
    const { clicks } = await run(() => grantCard({ surface }), strict, HEAD_SOURCES);
    assert.deepEqual(clicks, [0, 0], surface);
  }
});
