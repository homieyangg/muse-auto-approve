'use strict';

// Runs content.js in a vm context against a minimal fake DOM and chrome API, with a stand-in for bridge.js answering
// the maa-mark requests, so scan() can be checked end to end
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const AAM = require('../shared.js');
const AAG = require('../guard.js');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const CONTENT = read('content.js');
// main before this change, to check that the panel surface still behaves exactly as there
const MAIN_COMMIT = '3720d1f';
function mainSources() {
  try {
    const show = file => execFileSync('git', ['show', `${MAIN_COMMIT}:${file}`], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return ['shared.js', 'guard.js', 'content.js'].map(show);
  } catch {
    return null;
  }
}

// Selectors content.js uses: comma lists, descendant combinators, tag, [attr], [attr="v"] and :not(...)
function parseCompound(sel) {
  const parts = [];
  let i = 0;
  const tag = sel.match(/^[a-z]+/i);
  if (tag) { parts.push(el => el.tag === tag[0].toLowerCase()); i = tag[0].length; }
  while (i < sel.length) {
    if (sel[i] === '[') {
      const end = sel.indexOf(']', i);
      const m = sel.slice(i + 1, end).match(/^([\w-]+)(?:="([^"]*)")?$/);
      const [, name, value] = m;
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
    this.hidden = false;
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
  get disabled() { return this.attrs.has('disabled'); }
  getClientRects() { return this.hidden ? [] : [{}]; }
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

// Loads content.js with the given stored settings; returns the context and what it reported to the background.
// sources replaces shared.js, guard.js and content.js with other versions of them
function loadContent(sync = {}, sources = null) {
  const reports = [];
  const store = { sync: { ...AAM.SETTINGS_DEFAULTS, ...sync }, local: { allowOnce: [] } };
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
    ...(sources ? {} : { AAM, AAG }), chrome, document: doc, console: { info() {}, warn() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: Ev, KeyboardEvent: Ev, PointerEvent: Ev,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  };
  vm.createContext(ctx);
  for (const source of sources || [CONTENT]) vm.runInContext(source, ctx);
  return { ctx, reports, store, pending: () => Array.from(reports.filter(r => r.type === 'pending').at(-1)?.items || [], i => i.key) };
}

// Stand-in for bridge.js: answers maa-mark for cards holding an approval id. onMark may change attributes first, or return
// false to leave the request unanswered while the old attributes stay
function fakeBridge(onMark = () => {}) {
  doc.addEventListener('maa-mark', e => {
    const el = e.target;
    el.removeAttribute('data-maa-marked');
    if (onMark(el) === false) return;
    if (el.hasAttribute('data-maa-approval-id')) el.setAttribute('data-maa-marked', el.getAttribute('data-maa-mark-request'));
  });
}

const optAttrs = (kind, labelKind, scope = '') => ({ 'data-maa-option-kind': kind, 'data-maa-label-kind': labelKind, ...(scope && { 'data-maa-scope': scope }) });

// A chat-surface card for a website access approval. withData false leaves out every bridge.js option attribute; state is
// the card state bridge.js wrote and marked false leaves the buttons unmarked, as when none of them could be confirmed
function accessCard(buttons, { withData = true, options = null, state = 'clean', marked = withData } = {}) {
  const attrs = { 'data-testid': 'hatch-inline-approval-card', 'data-hatch-approval-surface': 'chat', 'data-maa-approval-id': 'appr-test-50' };
  if (withData && options) attrs['data-maa-state'] = state;
  const els = buttons.map(([text, option, extra = {}]) => new El('button', { ...(marked ? option : {}), ...extra }, [], text));
  const card = new El('div', attrs, [new El('p', {}, [], 'Access example.com? The assistant wants to open this website.'), new El('div', {}, els)]);
  doc.body.append(card);
  return { card, buttons: els };
}

const BROAD_OPTIONS = [
  { kind: 'allow_always', labelKind: 'allow_always_scoped', scope: 'connector_all_actions' },
  { kind: 'deny', labelKind: 'deny_for_this_task', scope: '' },
];

test('popup: an untrusted card offering only a broad always and deny is listed as waiting, as on main', () => {
  for (const withData of [false, true]) {
    makeDocument();
    fakeBridge();
    const { buttons } = accessCard([
      ['Always allow all actions', optAttrs('allow_always', 'allow_always_scoped', 'connector_all_actions')],
      ['Deny', optAttrs('deny', 'deny_for_this_task')],
    ], { withData, options: BROAD_OPTIONS });
    const { ctx, pending } = loadContent();
    ctx.scan();
    assert.deepEqual(pending(), ['example.com|'], `withData=${withData}`);
    assert.equal(buttons[0].clicks, 0);
  }
});

test('a trusted card with only a broad always and deny is listed as waiting and never clicked', () => {
  makeDocument();
  fakeBridge();
  const { buttons } = accessCard([
    ['Always allow all actions', optAttrs('allow_always', 'allow_always_scoped', 'connector_all_actions')],
    ['Deny', optAttrs('deny', 'deny_for_this_task')],
  ], { options: BROAD_OPTIONS });
  const { ctx, pending } = loadContent({ mode: 'all' });
  ctx.scan();
  assert.deepEqual(pending(), ['example.com|']);
  assert.deepEqual(buttons.map(b => b.clicks), [0, 0]);
});

const SAFE_OPTIONS = [
  { kind: 'allow_once', labelKind: 'allow_once', scope: '' },
  { kind: 'allow_always', labelKind: 'allow_always_scoped', scope: 'destination' },
  { kind: 'deny', labelKind: 'deny_for_this_task', scope: '' },
];
const SAFE_BUTTONS = [
  ['Allow once', optAttrs('allow_once', 'allow_once'), { 'data-hatch-approval-primary-action': 'true' }],
  ['Always allow this site', optAttrs('allow_always', 'allow_always_scoped', 'destination')],
  ['Deny', optAttrs('deny', 'deny_for_this_task')],
];
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a trusted card clicks the single-site always button picked by data', async () => {
  makeDocument();
  fakeBridge();
  const { buttons } = accessCard(SAFE_BUTTONS, { options: SAFE_OPTIONS });
  const { ctx } = loadContent({ mode: 'all' });
  ctx.scan();
  await tick();
  assert.deepEqual(buttons.map(b => b.clicks), [0, 1, 0]);
});

test('the pre-click re-check refuses when the fresh mark turns the always button broad', async () => {
  makeDocument();
  let marks = 0;
  fakeBridge(el => {
    if (++marks > 1) el.querySelectorAll('button')[1]?.setAttribute('data-maa-scope', 'connector_all_actions');
  });
  const { buttons } = accessCard(SAFE_BUTTONS, { options: SAFE_OPTIONS });
  const { ctx } = loadContent({ mode: 'all' });
  ctx.scan();
  await tick();
  assert.deepEqual(buttons.map(b => b.clicks), [0, 0, 0]);
});

test('the pre-click re-check refuses when bridge.js stops answering', async () => {
  makeDocument();
  let marks = 0;
  fakeBridge(el => { if (++marks > 1) el.removeAttribute('data-maa-approval-id'); });
  const { buttons } = accessCard(SAFE_BUTTONS, { options: SAFE_OPTIONS });
  const { ctx } = loadContent({ mode: 'all' });
  ctx.scan();
  await tick();
  assert.deepEqual(buttons.map(b => b.clicks), [0, 0, 0]);
});

test('with Prefer "Always allow" off, a data card with only an always button is waiting, not clicked', async () => {
  makeDocument();
  fakeBridge();
  const { buttons } = accessCard([SAFE_BUTTONS[1], SAFE_BUTTONS[2]], { options: SAFE_OPTIONS.slice(1) });
  const { ctx, pending } = loadContent({ mode: 'all', preferAlways: false });
  ctx.scan();
  await tick();
  assert.deepEqual(buttons.map(b => b.clicks), [0, 0]);
  assert.deepEqual(pending(), ['example.com|']);
});

// Codex re-review P1-3
test('an empty option list that was read clicks nothing, even by text', async () => {
  makeDocument();
  fakeBridge();
  const { buttons } = accessCard(SAFE_BUTTONS, { options: [], state: 'anomalous', marked: false });
  const { ctx, pending } = loadContent({ mode: 'all' });
  ctx.scan();
  await tick();
  assert.deepEqual(buttons.map(b => b.clicks), [0, 0, 0]);
  assert.deepEqual(pending(), ['example.com|']);
});

// Codex re-review P1-4 and 3: an anomalous card clicks only its confirmed once, after a fresh answer for the same approval
test('an anomalous card clicks only its confirmed once button, and only on a fresh answer', async () => {
  const onlyOnceMarked = [SAFE_BUTTONS[0], [SAFE_BUTTONS[1][0], {}], [SAFE_BUTTONS[2][0], {}]];
  const cases = [
    ['answering', SAFE_BUTTONS, () => true, [1, 0, 0]],
    ['confirmed once only', onlyOnceMarked, () => true, [1, 0, 0]],
    ['no fresh answer', SAFE_BUTTONS, (el, n) => n <= 1, [0, 0, 0]],
    ['another approval now', SAFE_BUTTONS, (el, n) => { if (n > 1) el.setAttribute('data-maa-approval-id', 'appr-test-51'); }, [0, 0, 0]],
  ];
  for (const [name, spec, onMark, clicks] of cases) {
    makeDocument();
    let n = 0;
    fakeBridge(el => onMark(el, ++n));
    const { buttons } = accessCard(spec, { options: SAFE_OPTIONS, state: 'anomalous' });
    const { ctx } = loadContent({ mode: 'all' });
    ctx.scan();
    await tick();
    assert.deepEqual(buttons.map(b => b.clicks), clicks, name);
  }
  makeDocument();
  fakeBridge();
  const { buttons } = accessCard(SAFE_BUTTONS, { options: SAFE_OPTIONS, state: 'anomalous', marked: false });
  const { ctx, pending } = loadContent({ mode: 'all' });
  ctx.scan();
  await tick();
  assert.deepEqual(buttons.map(b => b.clicks), [0, 0, 0]);
  assert.deepEqual(pending(), ['example.com|']);
});

// A panel card as bridge.js leaves it: the approval id, but no state and no option marks. A primary, a "more allow
// options" menu holding one item, and deny. bare leaves out the approval id too; surface 'chat' makes it a chat card
// whose options were not read
function panelCard({ itemText = 'Always allow this site', primaryText = 'Allow once', bare = false, surface = 'panel' } = {}) {
  const item = new El('div', { role: 'menuitem' }, [], itemText);
  doc.body.append(new El('div', { id: 'menu-test-1', role: 'menu' }, [item]));
  const primary = new El('button', { 'data-hatch-approval-primary-action': 'true' }, [], primaryText);
  const menu = new El('button', { 'aria-haspopup': 'menu', 'aria-expanded': 'true', 'aria-controls': 'menu-test-1' }, [], 'More allow options');
  const deny = new El('button', {}, [], 'Deny');
  const attrs = { 'data-testid': 'hatch-inline-approval-card', 'data-hatch-approval-surface': surface };
  if (!bare) attrs['data-maa-approval-id'] = 'appr-test-50';
  const card = new El('div', attrs, [new El('p', {}, [], 'Access example.com? The assistant wants to open this website.'), new El('div', {}, [primary, menu, deny])]);
  doc.body.append(card);
  return { card, primary, deny, item };
}
const menuWait = () => new Promise(resolve => setTimeout(resolve, 300));

// Codex re-review 2, P2: without data the refused menu stays main's
test('without data, a menu item that disappears before the click leaves the card unclicked, as on main', async () => {
  makeDocument();
  fakeBridge();
  const { primary, item } = panelCard({ bare: true });
  let reads = 0;
  Object.defineProperty(item, 'innerText', { get() { if (!reads++) queueMicrotask(() => { item.parent.children = []; item.parent = null; }); return 'Always allow this site'; } });
  const { ctx } = loadContent({ mode: 'all' });
  ctx.scan();
  await menuWait();
  assert.deepEqual([primary.clicks, item.clicks], [0, 0]);
});

// Codex re-review 4, P2: on a chat card without data the pre-click check is main's, so a primary disabled while the menu is
// open does not stop the menu item; data turning up meanwhile sends the card back to the next scan instead
test('without data, the pre-click check is main\'s: a menu item is clicked though the primary is disabled meanwhile', async () => {
  for (const [name, dataAppears, clicks] of [['no data', false, 1], ['data turned up', true, 0]]) {
    makeDocument();
    let n = 0;
    fakeBridge(el => {
      if (dataAppears && el.matches('[data-testid]') && ++n > 1) {
        el.setAttribute('data-maa-approval-id', 'appr-test-63');
        el.setAttribute('data-maa-state', 'clean');
      }
    });
    const { primary, item } = panelCard({ bare: true, surface: 'chat' });
    const { ctx } = loadContent({ mode: 'all' });
    ctx.scan();
    primary.setAttribute('disabled', '');
    await menuWait();
    assert.deepEqual([primary.clicks, item.clicks], [0, clicks], name);
  }
});

// Scope cut: the panel and its menu are not read from data; every panel case must click exactly what main clicks
test('a panel card behaves exactly as on main', { skip: !mainSources() && `${MAIN_COMMIT} is not in this clone` }, async () => {
  const fixtures = {
    'always item in the menu': {},
    'no always item in the menu': { itemText: 'Allow once' },
    'broad always item in the menu': { itemText: 'Always allow all actions' },
    'text-only primary': { primaryText: 'Send', itemText: 'Other' },
    'without approval id': { bare: true },
  };
  const settings = { 'prefer always': { mode: 'all' }, 'just once': { mode: 'all', preferAlways: false }, untrusted: {} };
  const run = async (spec, sync, sources) => {
    makeDocument();
    fakeBridge();
    const { primary, deny, item } = panelCard(spec);
    const { ctx, pending } = loadContent(sync, sources);
    ctx.scan();
    await menuWait();
    return { clicks: [primary.clicks, deny.clicks, item.clicks], pending: pending() };
  };
  const main = mainSources();
  for (const [name, spec] of Object.entries(fixtures)) {
    for (const [mode, sync] of Object.entries(settings)) {
      const expected = await run(spec, sync, main);
      assert.deepEqual(await run(spec, sync, null), expected, `${name}, ${mode}`);
    }
  }
  // A sanity check that the fixture exercises the menu at all
  assert.deepEqual((await run({}, { mode: 'all' }, main)).clicks, [0, 0, 1]);
});

test('a chat card read from data never opens a menu: it clicks its once button instead', async () => {
  makeDocument();
  fakeBridge();
  const { card, buttons } = accessCard([SAFE_BUTTONS[0], SAFE_BUTTONS[2]], { options: SAFE_OPTIONS });
  const item = new El('div', { role: 'menuitem' }, [], 'Always allow this site');
  doc.body.append(new El('div', { id: 'menu-test-2', role: 'menu' }, [item]));
  card.children[1].append(new El('button', { 'aria-haspopup': 'menu', 'aria-expanded': 'true', 'aria-controls': 'menu-test-2' }, [], 'More allow options'));
  const { ctx } = loadContent({ mode: 'all' });
  ctx.scan();
  await menuWait();
  assert.deepEqual([...buttons.map(b => b.clicks), item.clicks], [1, 0, 0]);
});

// An action card bridge.js marked with its policy; the log keeps policy and purchase so a row can be trusted later
function postCard() {
  const attrs = { 'data-testid': 'hatch-inline-approval-card', 'data-hatch-approval-surface': 'chat', 'data-maa-approval-id': 'appr-test-70', 'data-maa-state': 'clean', 'data-maa-policy': 'connector.example.post.create' };
  const buttons = [
    new El('button', { ...optAttrs('allow_once', 'allow_once'), 'data-hatch-approval-primary-action': 'true' }, [], 'Post'),
    new El('button', optAttrs('deny', 'deny_for_this_task'), [], 'Deny'),
  ];
  doc.body.append(new El('div', attrs, [new El('p', {}, [], 'Post to Example? This task is from Chat A.'), new El('div', {}, buttons)]));
  return buttons;
}

test('log entries store the policy and purchase state of waiting and approved cards', async () => {
  makeDocument();
  fakeBridge();
  postCard();
  const waiting = loadContent();
  waiting.ctx.scan();
  for (let i = 0; i < 4; i++) await tick();
  const [pendingEntry] = waiting.store.local.log;
  assert.deepEqual([pendingEntry.result, pendingEntry.action, pendingEntry.chat, pendingEntry.policy, pendingEntry.purchase], ['pending', 'Post to Example', 'Chat A', 'connector.example.post.create', false]);

  makeDocument();
  fakeBridge();
  const buttons = postCard();
  const trusted = loadContent({ actions: [{ id: 'a1', title: 'Post to Example', chats: [], on: true }] });
  trusted.ctx.scan();
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(buttons[0].clicks, 1);
  const [allowedEntry] = trusted.store.local.log;
  assert.deepEqual([allowedEntry.result, allowedEntry.policy, allowedEntry.purchase], ['allowed', 'connector.example.post.create', false]);
});

// Card -> parseCard -> log entry -> Trust offer: a website row may only come from a card whose policy type is a website one
async function loggedRow(text, policy) {
  makeDocument();
  fakeBridge();
  const attrs = { 'data-testid': 'hatch-inline-approval-card', 'data-hatch-approval-surface': 'chat', 'data-maa-approval-id': 'appr-test-80', 'data-maa-state': 'clean', ...(policy && { 'data-maa-policy': policy }) };
  const buttons = [
    new El('button', { ...optAttrs('allow_once', 'allow_once'), 'data-hatch-approval-primary-action': 'true' }, [], 'Allow'),
    new El('button', optAttrs('deny', 'deny_for_this_task'), [], 'Deny'),
  ];
  doc.body.append(new El('div', attrs, [new El('p', {}, [], text), new El('div', {}, buttons)]));
  const { ctx, store } = loadContent();
  ctx.scan();
  for (let i = 0; i < 4; i++) await tick();
  return store.local.log[0];
}

test('a card titled "open <host>" whose policy is an upload is logged with that policy and offers no Trust', async () => {
  const AAT = require('../trust.js');
  const entry = await loggedRow('Open a.example to upload a file? This task is from Chat A.', 'connector.browser.page.upload');
  assert.deepEqual([entry.host, entry.policy, entry.result], ['a.example', 'connector.browser.page.upload', 'pending']);
  assert.equal(AAM.parseCard('Open a.example to upload a file?', '', 'connector.browser.page.upload', 'a.example').policy, '');
  assert.equal(AAT.offers(AAM.SETTINGS_DEFAULTS, [entry]).size, 0);
});

test('a website row with an unknown policy type offers no Trust; one without a policy does', async () => {
  const AAT = require('../trust.js');
  const unknown = await loggedRow('Access a.example? This task is from Chat A.', 'connector.example.unknown');
  assert.deepEqual([unknown.host, unknown.policy], ['a.example', 'connector.example.unknown']);
  assert.equal(AAT.offers(AAM.SETTINGS_DEFAULTS, [unknown]).size, 0);
  const plain = await loggedRow('Access a.example? This task is from Chat A.', '');
  assert.deepEqual([plain.host, plain.policy, plain.chat], ['a.example', '', 'Chat A']);
  assert.equal(AAT.offers(AAM.SETTINGS_DEFAULTS, [plain]).size, 1);
});
