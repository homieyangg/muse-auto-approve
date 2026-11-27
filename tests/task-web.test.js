'use strict';

// The task-wide web-access card muse shows when its network default is "always ask". bridge.js runs for real on a
// fabricated React tree attached to a fake DOM, so content.js picks from the attributes it actually writes. Clicks are
// compared with v1.4.0 (text rules) and, for the negative cases, with main before this change
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const AAM = require('../shared.js');
const AAG = require('../guard.js');
const { markItem, isTaskWebGrant } = require('../bridge.js');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const HEAD_SOURCES = ['shared.js', 'guard.js', 'content.js'].map(read);
const MAIN_COMMIT = 'c5c40d8';
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

function loadContent(sync, sources) {
  const reports = [];
  const store = { sync: { ...AAM.SETTINGS_DEFAULTS, ...sync }, local: { allowOnce: [], log: [], dismissed: [], approvals: 0 } };
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
function grantApproval({ id = ID, options = [TASK_WEB, DENY], question = 'network_turn_grant', policy = 'tool.web_fetch', host = 'example.org' } = {}) {
  return {
    approvalId: id, policySubject: policy, host, port: 443, scheme: 'https', method: 'GET', path: '/',
    reason: 'Fetch web content from https://example.org', actionLabel: 'Web access for this task', workload: 'runtime_chat',
    declaredHosts: [], matchedPolicy: null, allowAlwaysScope: null, payloadPreview: '', turnGrantEligible: true, isExclusive: true,
    decisionOptions: Array.isArray(options) ? options.map(o => o?.kind) : null,
    serverPresentation: {
      payloadType: 'network', presentationKind: 'generic', summaryTitle: '此任務的網路存取權限',
      permissionQuestion: { kind: question, text: QUESTION },
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

// Component holding the approval data -> host div (the card or item element) -> button row -> Button(key) -> span -> <button>
function attachTree(parent, props, el, buttons, keys) {
  const comp = { memoizedProps: props };
  const host = { memoizedProps: {} };
  const row = { memoizedProps: {} };
  link(parent, [comp]);
  link(comp, [host]);
  link(host, [row]);
  const wrappers = buttons.map((b, i) => {
    const button = { key: keys[i], memoizedProps: { variant: 'primary' } };
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

function cardText() {
  return [new El('p', {}, [], QUESTION), new El('p', {}, [], '從⁨example.org⁩開始'), new El('p', {}, [], `此任務來自${CHAT}。`)];
}

function decisionButtons(options) {
  return options.map((o, i) => new El('button', i === 0 ? { 'data-hatch-approval-primary-action': 'true' } : { 'data-pel-click': 'chat_inline_approval_decision' }, [], o.labelText));
}

// A single-approval card on the chat surface (cta keys) or the approvals panel (compact, no cta keys)
function grantCard({ surface = 'chat', approval = grantApproval(), keys } = {}) {
  const options = approval.serverPresentation.decisionOptions;
  const buttons = decisionButtons(options);
  const attrs = { 'data-testid': 'hatch-inline-approval-card', 'data-hatch-approval-surface': surface, 'data-hatch-single-approval': 'true' };
  const card = new El('div', attrs, [...cardText(), new El('div', {}, buttons)]);
  const ctaKeys = keys || (surface === 'chat' ? options.map((o, i) => `${approval.approvalId}-cta-${i}-${o.kind}`) : options.map(() => null));
  attachTree(fiberRoot(), { approval }, card, buttons, ctaKeys);
  doc.body.append(surface === 'panel' ? new El('section', {}, [card]) : card);
  return { card, buttons, approval };
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
  const markAll = () => {
    for (const el of doc.querySelectorAll('[data-testid="hatch-inline-approval-card"], [aria-expanded]')) markItem(el, undefined, pendingById);
  };
  doc.addEventListener('maa-mark', e => {
    const el = e.target;
    el.removeAttribute('data-maa-marked');
    if (onMark(el) === false) return;
    if (markItem(el, undefined, pendingById)) el.setAttribute('data-maa-marked', el.getAttribute('data-maa-mark-request') || '');
  });
  markAll();
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const quiet = fn => { const warn = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = warn; } };

async function run(build, sync, sources, onMark) {
  makeDocument();
  const fixture = build();
  quiet(() => realBridge([fixture.approval || grantApproval()].filter(Boolean), onMark));
  const env = loadContent(sync, sources);
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
// What 1.4.0 does with this card, the same on both surfaces: it is an action card, so only the trust decision for actions
// clicks it, and a site rule never does
const V140_CLICKS = {
  'trusted + site rule for the grant host': false,
  'trusted, no rule': false,
  'trusted + action rule by policy': true,
  'trusted + action rule by title': true,
  'trusted chat': true,
  'mode all, includeActions off': false,
  'mode all, includeActions on': true,
};

async function matrix(sources) {
  const rows = [];
  for (const surface of ['chat', 'panel']) {
    for (const [name, setup] of Object.entries(SETUPS)) {
      for (const preferAlways of [true, false]) {
        const result = await run(() => grantCard({ surface }), { ...setup, preferAlways }, sources);
        rows.push({ label: `${surface}, ${name}, preferAlways ${preferAlways}`, surface, name, clicks: result.clicks, pending: result.pending });
      }
    }
  }
  return rows;
}

const parityOpts = { skip: !V140 && 'v1.4.0 is not in this clone' };

test('the task-wide web-access card clicks exactly what 1.4.0 clicks, on both surfaces', parityOpts, async () => {
  const before = await matrix(V140);
  const after = await matrix(HEAD_SOURCES);
  for (const [i, row] of before.entries()) {
    // Pins 1.4.0's behaviour so the comparison cannot pass on two runs that both click nothing
    assert.deepEqual(row.clicks, V140_CLICKS[row.name] ? [1, 0] : [0, 0], `1.4.0: ${row.label}`);
    assert.deepEqual(after[i].clicks, row.clicks, row.label);
    assert.deepEqual(after[i].pending, row.pending, `pending: ${row.label}`);
  }
});

test('parity fails without the exception and fails when the grant host is used as a site', parityOpts, async () => {
  const before = await matrix(V140);
  const differs = rows => rows.filter((row, i) => JSON.stringify(row.clicks) !== JSON.stringify(before[i].clicks)).map(r => r.label);
  const [shared, guard, content] = HEAD_SOURCES;
  const noException = shared.replace("return taskWeb ? 'once' : '';", "return '';");
  assert.notEqual(noException, shared);
  const lost = differs(await matrix([noException, guard, content]));
  assert.ok(lost.length > 0 && lost.every(l => l.startsWith('chat,')), lost.join('\n'));
  const asSite = content.replace('purchase, ...grantLabel(attr) };', "purchase, ...grantLabel(attr), host: attr(GRANT_HOST_ATTR) };");
  assert.notEqual(asSite, content);
  const widened = differs(await matrix([shared, guard, asSite]));
  assert.ok(widened.some(l => l.includes('site rule')), widened.join('\n'));
});

test('bridge.js marks the grant on both surfaces, and option marks only on the chat card', async () => {
  for (const surface of ['chat', 'panel']) {
    makeDocument();
    const { card, buttons } = grantCard({ surface });
    quiet(() => realBridge([grantApproval()]));
    assert.equal(card.getAttribute('data-maa-grant'), 'task-web', surface);
    assert.equal(card.getAttribute('data-maa-grant-host'), 'example.org', surface);
    assert.equal(card.getAttribute('data-maa-approval-id'), ID, surface);
    assert.equal(card.getAttribute('data-maa-policy'), 'tool.web_fetch', surface);
    assert.equal(card.getAttribute('data-maa-site'), null, surface);
    assert.equal(card.getAttribute('data-maa-state'), surface === 'chat' ? 'clean' : null, surface);
    assert.deepEqual(buttons.map(b => b.getAttribute('data-maa-label-kind')), surface === 'chat' ? ['allow_all_web_access_for_this_task', 'deny'] : [null, null], surface);
  }
});

test('isTaskWebGrant accepts only the recorded shape', () => {
  assert.equal(isTaskWebGrant(grantApproval()), true);
  assert.equal(isTaskWebGrant(grantApproval({ options: [DENY, TASK_WEB, opt('deny_always', 'deny_always', 'Never')] })), true);
  const no = {
    'another question kind': grantApproval({ question: 'network_site_grant' }),
    'question kind missing': grantApproval({ question: null }),
    'policy not tool.web_fetch': grantApproval({ policy: 'connector.browser.page.open' }),
    'extra always': grantApproval({ options: [TASK_WEB, opt('allow_always', 'allow_always_scoped', 'Always', 'destination'), DENY] }),
    'extra unscoped always': grantApproval({ options: [TASK_WEB, opt('allow_always', 'allow_always', 'Always'), DENY] }),
    'second allow once': grantApproval({ options: [TASK_WEB, opt('allow_once', 'allow_once', 'Once'), DENY] }),
    'scoped grant': grantApproval({ options: [opt('allow_once', 'allow_all_web_access_for_this_task', '允許', 'destination'), DENY] }),
    'other label kind': grantApproval({ options: [opt('allow_once', 'allow_for_this_task', '允許'), DENY] }),
    'grant as always': grantApproval({ options: [opt('allow_always', 'allow_all_web_access_for_this_task', '允許'), DENY] }),
    'no options': grantApproval({ options: [] }),
    'options missing': grantApproval({ options: null }),
    'options not an array': grantApproval({ options: { 0: TASK_WEB } }),
    'non-string kind': grantApproval({ options: [{ ...TASK_WEB, kind: ['allow_once'] }, DENY] }),
    'non-string label kind': grantApproval({ options: [TASK_WEB, { ...DENY, label: { kind: 7 } }] }),
    'non-string scope': grantApproval({ options: [opt('allow_once', 'allow_all_web_access_for_this_task', '允許', {}), DENY] }),
    'label missing': grantApproval({ options: [{ kind: 'allow_once', labelText: '允許' }, DENY] }),
    'option not an object': grantApproval({ options: [TASK_WEB, 'deny'] }),
  };
  for (const [name, a] of Object.entries(no)) assert.equal(isTaskWebGrant(a), false, name);
  const topLevel = grantApproval({ question: null });
  topLevel.permissionQuestion = { kind: 'network_turn_grant' };
  assert.equal(isTaskWebGrant(topLevel), false, 'question kind outside serverPresentation');
  const nonString = grantApproval();
  nonString.serverPresentation.permissionQuestion.kind = { toString: () => 'network_turn_grant' };
  assert.equal(isTaskWebGrant(nonString), false, 'non-string question kind');
});

const ALL_ACTIONS = { mode: 'all', includeActions: true };
const mainOpts = { skip: !MAIN && `${MAIN_COMMIT} is not in this clone` };

// Each card here must click exactly what main clicks, and never the task-wide grant button
test('cards that are not the recorded grant stay vetoed on the chat surface, as on main', mainOpts, async () => {
  const cases = {
    'same label kind, other question kind': () => grantCard({ approval: grantApproval({ question: 'network_site_grant' }) }),
    'same label kind, policy not tool.web_fetch': () => grantCard({ approval: grantApproval({ policy: 'connector.browser.page.open' }) }),
    'extra broad always': () => grantCard({ approval: grantApproval({ options: [TASK_WEB, opt('allow_always', 'allow_always_scoped', '一律允許所有動作', 'connector_all_actions'), DENY] }) }),
    'extra single-site always': () => grantCard({ approval: grantApproval({ options: [TASK_WEB, opt('allow_always', 'allow_always_scoped', '一律允許此網站', 'destination'), DENY] }) }),
    'second allow once': () => grantCard({ approval: grantApproval({ options: [TASK_WEB, opt('allow_once', 'allow_once', '允許一次'), DENY] }) }),
    'non-string scope': () => grantCard({ approval: grantApproval({ options: [opt('allow_once', 'allow_all_web_access_for_this_task', '允許', {}), DENY] }) }),
    'two approvals under the card': () => {
      const a = grantApproval({ id: 'network-attempt-test-2' });
      const b = grantApproval({ id: 'network-attempt-test-3' });
      return { ...combinedCard([a, b]), approval: null, grantButtons: [0, 2] };
    },
  };
  for (const [name, build] of Object.entries(cases)) {
    for (const preferAlways of [true, false]) {
      const label = `${name}, preferAlways ${preferAlways}`;
      const head = await run(build, { ...ALL_ACTIONS, preferAlways }, HEAD_SOURCES);
      const main = await run(build, { ...ALL_ACTIONS, preferAlways }, MAIN);
      assert.equal(head.fixture.card.getAttribute('data-maa-grant'), null, label);
      assert.deepEqual(head.clicks, main.clicks, label);
      for (const i of head.fixture.grantButtons || [0]) assert.equal(head.clicks[i], 0, label);
    }
  }
});

test('the exception holds only on a clean card with the grant mark, never for broad scopes', () => {
  const grant = { el: 'grant', text: '允許', primary: true, menu: false, kind: 'allow_once', labelKind: 'allow_all_web_access_for_this_task', scope: '' };
  const broad = { el: 'broad', text: 'Always allow all actions', primary: false, menu: false, kind: 'allow_always', labelKind: 'allow_always_scoped', scope: 'connector_all_actions' };
  const deny = { el: 'deny', text: '拒絕', primary: false, menu: false, kind: 'deny', labelKind: 'deny', scope: '' };
  const pick = (cands, state, g) => AAM.pickAllowButtons(cands, state, g);
  assert.deepEqual(pick([grant, deny], 'clean', 'task-web'), { always: null, once: 'grant', data: true, state: 'clean', grant: 'task-web' });
  assert.equal(pick([grant, deny], 'clean', ''), null);
  assert.equal(pick([grant, deny], 'anomalous', 'task-web'), null);
  assert.equal(pick([grant, deny], 'clean', 'task-web-x'), null);
  assert.equal(pick([broad, deny], 'clean', 'task-web'), null);
  assert.equal(pick([{ ...grant, scope: 'connector_all_actions' }, deny], 'clean', 'task-web'), null);
  assert.equal(pick([{ ...grant, scope: 'destination' }, deny], 'clean', 'task-web'), null);
  assert.equal(pick([{ ...grant, kind: 'allow_always' }, deny], 'clean', 'task-web'), null);
  assert.equal(AAM.optionRole(grant), '');
  // A grant pick never counts as always, whatever preferAlways says
  const picked = pick([grant, deny], 'clean', 'task-web');
  assert.equal(AAM.clickTarget(picked, true), 'grant');
  assert.equal(AAM.clickTarget(picked, false), 'grant');
  assert.equal(AAM.samePick(picked, { ...picked, grant: '' }, 'grant'), false);
  assert.equal(AAM.samePick(picked, picked, 'grant'), true);
});

test('an anomalous grant card is not clicked on the chat surface', async () => {
  // The pending list disagrees with the card about the options, so the read is anomalous
  const pendingCopy = grantApproval({ options: [opt('allow_once', 'allow_once', '允許'), DENY] });
  makeDocument();
  const { card, buttons } = grantCard();
  quiet(() => realBridge([pendingCopy]));
  assert.equal(card.getAttribute('data-maa-state'), 'anomalous');
  assert.equal(card.getAttribute('data-maa-grant'), 'task-web');
  const { ctx, pending } = loadContent(ALL_ACTIONS, HEAD_SOURCES);
  ctx.scan();
  await tick();
  assert.deepEqual(buttons.map(b => b.clicks), [0, 0]);
  assert.deepEqual(pending(), [KEY]);
});

test('a site rule for the grant host never clicks the card, with or without a chat scope', async () => {
  for (const surface of ['chat', 'panel']) {
    for (const sites of [[{ id: 's1', host: 'example.org', sub: false, chats: [], on: true }], [{ id: 's2', host: 'example.org', sub: true, chats: [CHAT], on: true }]]) {
      const result = await run(() => grantCard({ surface }), { sites }, HEAD_SOURCES);
      assert.deepEqual(result.clicks, [0, 0], surface);
      assert.deepEqual(result.pending, [KEY], surface);
    }
  }
});

test('the pre-click re-check refuses a stale grant mark', async () => {
  const control = await run(() => grantCard(), ALL_ACTIONS, HEAD_SOURCES);
  assert.deepEqual(control.clicks, [1, 0], 'control');
  const cases = {
    // The data no longer reads as the grant when content.js asks right before the click
    'grant gone from data': (n, a) => { if (n > 1) a.serverPresentation.permissionQuestion.kind = 'network_site_grant'; },
    // bridge.js stops answering; the old data-maa-grant attribute is still on the card
    'no fresh answer': n => n <= 1,
    // A stale attribute that the fresh mark removes, on a card whose data never was the grant
    'attribute without data': null,
  };
  for (const [name, onMark] of Object.entries(cases)) {
    makeDocument();
    let approval = grantApproval();
    if (!onMark) approval = grantApproval({ question: 'network_site_grant' });
    const { card, buttons } = grantCard({ approval });
    let n = 0;
    quiet(() => realBridge([approval], onMark ? () => onMark(++n, approval) : undefined));
    if (!onMark) card.setAttribute('data-maa-grant', 'task-web');
    const { ctx } = loadContent(ALL_ACTIONS, HEAD_SOURCES);
    ctx.scan();
    await tick();
    await tick();
    assert.deepEqual(buttons.map(b => b.clicks), [0, 0], name);
  }
});

test('the grant host stays out of the trust decision: host and site empty, key by policy', async () => {
  const { env } = await run(() => grantCard(), {}, HEAD_SOURCES);
  const [item] = env.pendingItems();
  assert.deepEqual(
    { key: item.key, host: item.host, site: item.site, policy: item.policy, action: item.action, chat: item.chat, grant: item.grant, grantHost: item.grantHost },
    { key: KEY, host: '', site: '', policy: 'tool.web_fetch', action: TITLE, chat: CHAT, grant: 'task-web', grantHost: 'example.org' },
  );
});

test('activity log rows carry the grant label fields; the clicked row keeps its usual fields', async () => {
  const waiting = await run(() => grantCard(), {}, HEAD_SOURCES);
  await tick();
  const [row] = waiting.env.store.local.log;
  assert.equal(row.result, 'pending');
  assert.deepEqual([row.key, row.host, row.site, row.title, row.grant, row.grantHost], [KEY, '', '', TITLE, 'task-web', 'example.org']);
  const clicked = await run(() => grantCard(), ALL_ACTIONS, HEAD_SOURCES);
  await tick();
  const [entry] = clicked.env.store.local.log;
  assert.deepEqual(
    { key: entry.key, host: entry.host, site: entry.site, action: entry.action, result: entry.result, kind: entry.kind, grant: entry.grant, grantHost: entry.grantHost },
    { key: KEY, host: '', site: '', action: TITLE, result: 'allowed', kind: 'once', grant: 'task-web', grantHost: 'example.org' },
  );
  // A host muse did not send as a hostname is left out of the label
  const noHost = await run(() => grantCard({ approval: grantApproval({ host: 'not a host' }) }), {}, HEAD_SOURCES);
  assert.equal(noHost.fixture.card.getAttribute('data-maa-grant-host'), null);
  assert.deepEqual([noHost.env.pendingItems()[0].grant, noHost.env.pendingItems()[0].grantHost], ['task-web', '']);
});

const LABELS = {
  en: ['Web access for this task (from example.org)', 'Web access for this task'],
  zh_TW: ['這個任務的網路存取（從 example.org）', '這個任務的網路存取'],
  zh_CN: ['这个任务的网络访问（从 example.org）', '这个任务的网络访问'],
  ja: ['このタスクのネットワークアクセス（example.org から）', 'このタスクのネットワークアクセス'],
};
const translator = locale => {
  const messages = JSON.parse(read(`_locales/${locale}/messages.json`));
  return (key, ...subs) => subs.reduce((text, sub, i) => text.split(`$${i + 1}`).join(String(sub)), messages[key]?.message ?? key);
};

test('cardLabel names the grant in every locale, with and without a host', () => {
  for (const [locale, [withHost, without]] of Object.entries(LABELS)) {
    const t = translator(locale);
    assert.equal(AAM.cardLabel({ grant: 'task-web', grantHost: 'example.org', action: TITLE }, t), withHost, locale);
    assert.equal(AAM.cardLabel({ grant: 'task-web', grantHost: '', action: TITLE }, t), without, locale);
    assert.equal(AAM.cardLabel({ action: TITLE, title: TITLE }, t), TITLE, locale);
  }
});

// Loads popup.js against stubs and evaluates in its scope
function popupScope(locale = 'en') {
  const stub = () => {
    const el = { hidden: false, checked: false, value: '', textContent: '', dataset: {}, children: [], classList: { toggle() {} } };
    el.append = (...c) => { el.children.push(...c); };
    el.replaceChildren = (...c) => { el.children = c; };
    el.addEventListener = () => {};
    return el;
  };
  const els = new Map();
  const area = values => ({ get: defaults => Promise.resolve({ ...defaults, ...values }), set: () => Promise.resolve() });
  const t = translator(locale);
  const ctx = {
    AAM, URLSearchParams,
    I18N: { code: locale, load: () => Promise.resolve(), t, apply() {}, ago: () => 'now', clock: () => '12:00' },
    document: { querySelector: sel => els.get(sel) || els.set(sel, stub()).get(sel), querySelectorAll: () => [], createElement: () => stub() },
    window: { close() {} },
    chrome: {
      runtime: { getManifest: () => ({ version: '0' }), openOptionsPage() {} },
      i18n: { getUILanguage: () => 'en' },
      tabs: { create() {} },
      storage: { sync: area({}), local: area({}), session: area({ pendingByTab: {} }), onChanged: { addListener() {} } },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(read('popup.js'), ctx);
  return expr => vm.runInContext(expr, ctx);
}

test('popup labels the pending card and the log row by the grant, and offers no site scope', () => {
  const evaluate = popupScope('en');
  const item = { key: KEY, host: '', chat: CHAT, title: TITLE, action: TITLE, policy: 'tool.web_fetch', site: '', grant: 'task-web', grantHost: 'example.org', ts: 0 };
  const g = JSON.stringify(item);
  assert.equal(evaluate(`label(${g})`), LABELS.en[0]);
  assert.equal(evaluate(`label(${JSON.stringify({ ...item, grantHost: '' })})`), LABELS.en[1]);
  assert.equal(evaluate(`label(${JSON.stringify({ ...item, grant: undefined, grantHost: undefined })})`), TITLE);
  assert.equal(evaluate(`logRow(${JSON.stringify({ ...item, result: 'pending' })}).children[1].textContent`), LABELS.en[0]);
  assert.equal(evaluate(`logRow(${JSON.stringify({ ...item, grantHost: '', result: 'allowed' })}).children[1].textContent`), LABELS.en[1]);
  assert.deepEqual(Array.from(evaluate(`scopeOptions(${g})`)), ['action', 'actionChat', 'chat', 'once']);
  assert.equal(popupScope('zh_TW')(`label(${g})`), LABELS.zh_TW[0]);
});

test('canAutoApprove is unchanged for the grant card: an action card under every guard', () => {
  const card = { ...AAM.parseCard(`${QUESTION} 從⁨example.org⁩開始 此任務來自${CHAT}。 允許 拒絕`, '', 'tool.web_fetch', ''), purchase: false, grant: 'task-web', grantHost: 'example.org' };
  assert.deepEqual([card.host, card.site, AAM.cardKey(card)], ['', '', KEY]);
  const base = AAM.SETTINGS_DEFAULTS;
  assert.equal(AAG.canAutoApprove({ ...base, mode: 'all' }, card, false), false);
  assert.equal(AAG.canAutoApprove({ ...base, mode: 'all', includeActions: true }, card, false), true);
  assert.equal(AAG.canAutoApprove({ ...base, sites: [{ host: 'example.org', sub: true, chats: [], on: true }] }, card, false), false);
  assert.equal(AAG.canAutoApprove({ ...base, mode: 'all', includeActions: true }, { ...card, purchase: null }, false), false);
});
