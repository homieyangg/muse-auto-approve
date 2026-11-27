'use strict';

// Runs content.js in a vm context against a minimal fake DOM and chrome API, with a stand-in for bridge.js answering
// the maa-mark requests, so scan() can be checked end to end
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const AAM = require('../shared.js');
const AAG = require('../guard.js');

const CONTENT = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

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

// Loads content.js with the given stored settings; returns the context and what it reported to the background
function loadContent(sync = {}) {
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
    AAM, AAG, chrome, document: doc, console: { info() {}, warn() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: Ev, KeyboardEvent: Ev, PointerEvent: Ev,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  };
  vm.createContext(ctx);
  vm.runInContext(CONTENT, ctx);
  return { ctx, reports, pending: () => Array.from(reports.filter(r => r.type === 'pending').at(-1)?.items || [], i => i.key) };
}

// Stand-in for bridge.js: answers maa-mark for cards holding an approval id and for marked menu items. onMark may change
// attributes first, or return false to leave the request unanswered while the old attributes stay
function fakeBridge(onMark = () => {}) {
  doc.addEventListener('maa-mark', e => {
    const el = e.target;
    el.removeAttribute('data-maa-marked');
    if (onMark(el) === false) return;
    if (el.hasAttribute('data-maa-approval-id') || el.hasAttribute('data-maa-option-approval')) el.setAttribute('data-maa-marked', el.getAttribute('data-maa-mark-request'));
  });
}

const optAttrs = (kind, labelKind, scope = '') => ({ 'data-maa-option-kind': kind, 'data-maa-label-kind': labelKind, ...(scope && { 'data-maa-scope': scope }) });

// A chat-surface card for a website access approval. withData false leaves out every bridge.js option attribute;
// marked false keeps the card's option list but leaves its buttons unmarked, as when the keys did not match
function accessCard(buttons, { withData = true, options = null, marked = withData } = {}) {
  const attrs = { 'data-testid': 'hatch-inline-approval-card', 'data-hatch-approval-surface': 'chat', 'data-maa-approval-id': 'appr-test-50' };
  if (withData && options) attrs['data-maa-options'] = JSON.stringify(options);
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
  const { buttons } = accessCard(SAFE_BUTTONS, { options: [], marked: false });
  const { ctx, pending } = loadContent({ mode: 'all' });
  ctx.scan();
  await tick();
  assert.deepEqual(buttons.map(b => b.clicks), [0, 0, 0]);
  assert.deepEqual(pending(), ['example.com|']);
});

// Codex re-review P1-4
test('with options read but the buttons unmarked, the text pick still needs the fresh mark token', async () => {
  for (const answering of [true, false]) {
    makeDocument();
    let marks = 0;
    fakeBridge(() => answering || ++marks <= 1);
    const { buttons } = accessCard(SAFE_BUTTONS, { options: SAFE_OPTIONS, marked: false });
    const { ctx } = loadContent({ mode: 'all' });
    ctx.scan();
    await tick();
    assert.deepEqual(buttons.map(b => b.clicks), answering ? [0, 1, 0] : [0, 0, 0], `answering=${answering}`);
  }
});

const DOMAIN_OPTIONS = [SAFE_OPTIONS[0], { ...SAFE_OPTIONS[1], scope: 'destination_domain' }, SAFE_OPTIONS[2]];
const menuItemAttrs = scope => ({ 'data-maa-option-approval': 'appr-test-50', ...optAttrs('allow_always', 'allow_always_scoped', scope) });

// A panel card: keyless primary, a "more allow options" menu holding one always item, and deny. marked false leaves the
// card's buttons unmarked; itemAttrs is what bridge.js wrote on the menu item; bare leaves out every bridge.js attribute
function panelCard(options, { marked = true, itemAttrs = {}, bare = false } = {}) {
  const item = new El('div', { role: 'menuitem', ...itemAttrs }, [], 'Always allow this site');
  doc.body.append(new El('div', { id: 'menu-test-1', role: 'menu' }, [item]));
  const primary = new El('button', { 'data-hatch-approval-primary-action': 'true', ...(marked && !bare ? optAttrs('allow_once', 'allow_once') : {}) }, [], 'Allow once');
  const menu = new El('button', { 'aria-haspopup': 'menu', 'aria-expanded': 'true', 'aria-controls': 'menu-test-1' }, [], 'More allow options');
  const deny = new El('button', marked && !bare ? optAttrs('deny', 'deny_for_this_task') : {}, [], 'Deny');
  const attrs = { 'data-testid': 'hatch-inline-approval-card', 'data-hatch-approval-surface': 'panel' };
  if (!bare) Object.assign(attrs, { 'data-maa-approval-id': 'appr-test-50', 'data-maa-options': JSON.stringify(options) });
  doc.body.append(new El('div', attrs, [new El('p', {}, [], 'Access example.com? The assistant wants to open this website.'), new El('div', {}, [primary, menu, deny])]));
  return { primary, deny, item };
}
const menuWait = () => new Promise(resolve => setTimeout(resolve, 300));

// Codex re-review P1-2
test('with options read but the buttons unmarked, the menu item is picked by its fresh mark, never by text', async () => {
  for (const [itemAttrs, clicks] of [[{}, [1, 0]], [menuItemAttrs('connector_all_actions'), [1, 0]], [menuItemAttrs('destination'), [0, 1]]]) {
    makeDocument();
    fakeBridge();
    const { primary, item } = panelCard(SAFE_OPTIONS, { marked: false, itemAttrs });
    const { ctx } = loadContent({ mode: 'all' });
    ctx.scan();
    await menuWait();
    assert.deepEqual([primary.clicks, item.clicks], clicks, JSON.stringify(itemAttrs));
  }
});

// Codex re-review P2
test('a menu item refused because the card and the pending list disagree falls back to allow once', async () => {
  makeDocument();
  fakeBridge();
  const { primary, deny, item } = panelCard(DOMAIN_OPTIONS, { itemAttrs: menuItemAttrs('destination') });
  const { ctx } = loadContent({ mode: 'all' });
  ctx.scan();
  await menuWait();
  ctx.scan();
  await menuWait();
  assert.deepEqual([primary.clicks, item.clicks, deny.clicks], [1, 0, 0]);
});

// Codex re-review 2, P1
test('a button flagged foreign is never clicked; without a confirmed once nothing is', async () => {
  const foreignAlways = [SAFE_BUTTONS[0], [SAFE_BUTTONS[1][0], SAFE_BUTTONS[1][1], { 'data-maa-foreign': '1' }], SAFE_BUTTONS[2]];
  for (const [marked, clicks] of [[true, [1, 0, 0]], [false, [0, 0, 0]]]) {
    makeDocument();
    fakeBridge();
    const { buttons } = accessCard(foreignAlways, { options: SAFE_OPTIONS, marked });
    const { ctx, pending } = loadContent({ mode: 'all' });
    ctx.scan();
    await tick();
    assert.deepEqual(buttons.map(b => b.clicks), clicks, `marked=${marked}`);
    if (!marked) assert.deepEqual(pending(), ['example.com|']);
  }
});

// Codex re-review 2, P2: closing the menu re-renders the primary as a new node
test('after a refused menu item, the once button is looked up again on the re-rendered card', async () => {
  makeDocument();
  fakeBridge();
  const { primary, item } = panelCard(DOMAIN_OPTIONS, { itemAttrs: menuItemAttrs('destination') });
  let fresh = null;
  doc.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || fresh) return;
    const row = primary.parent;
    fresh = new El('button', Object.fromEntries(primary.attrs), [], 'Allow once');
    row.children[row.children.indexOf(primary)] = fresh;
    fresh.parent = row;
    primary.parent = null;
  });
  const { ctx } = loadContent({ mode: 'all' });
  ctx.scan();
  await menuWait();
  assert.deepEqual([primary.clicks, fresh?.clicks, item.clicks], [0, 1, 0]);
});

// Codex re-review 2, P2: without data the refused menu stays main's
test('without data, a menu item that disappears before the click leaves the card unclicked, as on main', async () => {
  makeDocument();
  fakeBridge();
  const { primary, item } = panelCard(null, { bare: true });
  let reads = 0;
  Object.defineProperty(item, 'innerText', { get() { if (!reads++) queueMicrotask(() => { item.parent.children = []; item.parent = null; }); return 'Always allow this site'; } });
  const { ctx } = loadContent({ mode: 'all' });
  ctx.scan();
  await menuWait();
  assert.deepEqual([primary.clicks, item.clicks], [0, 0]);
});
