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
// sources replaces shared.js, guard.js and content.js with other versions of them; local is what chrome.storage.local holds.
// changed() runs the storage.onChanged listeners
function loadContent(sync = {}, sources = null, local = {}) {
  const reports = [];
  const listeners = [];
  const store = { sync: { ...AAM.SETTINGS_DEFAULTS, ...sync }, local: { allowOnce: [], ...local } };
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
    storage: { sync: area('sync'), local: area('local'), onChanged: { addListener(fn) { listeners.push(fn); } } },
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
  const changed = (changes, area) => listeners.forEach(fn => fn(changes, area));
  return { ctx, reports, store, changed, pending: () => Array.from(reports.filter(r => r.type === 'pending').at(-1)?.items || [], i => i.key) };
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

// Card -> parseCard -> log entry -> Trust offer. No muse website policy type is known yet, so these tests stand one in
const AAT = require('../trust.js');
const SITE = 'connector.example.site.open';
const UPLOAD = 'connector.browser.page.upload';
AAT.SITE_POLICIES.push(SITE);
const offered = entry => AAT.offers(AAM.SETTINGS_DEFAULTS, [entry]).size === 1;

// A chat card with the bridge.js attributes given; set() changes them as a later bridge read would, and onMark runs on each
// fresh mark request
function siteCard(text, marks = {}, local = {}) {
  makeDocument();
  const hooks = { onMark: () => {} };
  fakeBridge(el => hooks.onMark(el));
  const card = new El('div', { 'data-testid': 'hatch-inline-approval-card', 'data-hatch-approval-surface': 'chat', 'data-maa-state': 'clean' }, [
    new El('p', {}, [], text),
    new El('div', {}, [
      new El('button', { ...optAttrs('allow_once', 'allow_once'), 'data-hatch-approval-primary-action': 'true' }, [], 'Allow'),
      new El('button', optAttrs('deny', 'deny_for_this_task'), [], 'Deny'),
    ]),
  ]);
  doc.body.append(card);
  const set = ({ policy = '', host = '', id = 'appr-test-80', purchase = false, site = '' }) => {
    const attrs = [['data-maa-policy', policy], ['data-maa-host', host], ['data-maa-approval-id', id], ['data-maa-purchase', purchase ? '1' : ''], ['data-maa-site', site]];
    for (const [name, value] of attrs) {
      if (value) card.setAttribute(name, value);
      else card.removeAttribute(name);
    }
  };
  set(marks);
  const loaded = loadContent({}, null, local);
  const scan = async next => {
    if (next) set(next);
    loaded.ctx.scan();
    for (let i = 0; i < 6; i++) await tick();
    return loaded.store.local.log;
  };
  const trustSite = () => vm.runInContext("settings.sites = [{ id: 's1', host: 'a.example', sub: false, chats: [], on: true }]", loaded.ctx);
  return { ...loaded, scan, set, hooks, trustSite };
}

async function loggedRow(text, marks) {
  const [entry] = await siteCard(text, marks).scan();
  return entry;
}

const ACCESS = 'Access a.example? This task is from Chat A.';
const OPEN_UPLOAD = 'Open a.example to upload a file? This task is from Chat A.';

test('a card titled "open <host>" whose policy is an upload is logged with that policy and offers no Trust', async () => {
  const entry = await loggedRow(OPEN_UPLOAD, { policy: UPLOAD, host: 'browser' });
  assert.deepEqual([entry.host, entry.policy, entry.approvalHost, entry.mixed, entry.result], ['a.example', UPLOAD, 'browser', false, 'pending']);
  assert.equal(AAM.parseCard('Open a.example to upload a file?', '', UPLOAD, 'a.example').policy, '');
  assert.equal(offered(entry), false);
});

test('without a website policy type from muse a row offers no Trust: none read, an upload title, or an unknown type', async () => {
  for (const [text, marks] of [[ACCESS, {}], [OPEN_UPLOAD, {}], [ACCESS, { host: 'a.example' }], [ACCESS, { policy: 'connector.example.unknown' }]]) {
    const entry = await loggedRow(text, marks);
    assert.equal(entry.host, 'a.example');
    assert.equal(offered(entry), false, `${text} ${JSON.stringify(marks)}`);
  }
  const site = await loggedRow(ACCESS, { policy: SITE, host: 'a.example' });
  assert.deepEqual([site.policy, site.approvalHost, site.chat], [SITE, 'a.example', 'Chat A']);
  assert.equal(offered(site), true);
});

// Browser connector approvals that can name a site in their title are not website access
test('goto and download connector cards that name a site get no site Trust', async () => {
  const cards = [
    ['Open a.example? This task is from Chat A.', 'connector.browser.page.goto'],
    ['Access a.example? This task is from Chat A.', 'connector.browser.page.goto'],
    ['Open a.example to download a file? This task is from Chat A.', 'connector.browser.page.download'],
  ];
  for (const [text, policy] of cards) {
    const entry = await loggedRow(text, { policy, host: 'browser' });
    assert.deepEqual([entry.host, entry.policy], ['a.example', policy], text);
    assert.equal(offered(entry), false, text);
  }
});

test('a waiting card read without data first gets the data of a later scan on its one log row', async () => {
  const card = siteCard(ACCESS);
  const [first] = await card.scan();
  assert.deepEqual([first.policy, first.approvalHost, offered(first)], ['', '', false]);
  const log = await card.scan({ policy: SITE, host: 'a.example' });
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].result, log[0].policy, log[0].approvalHost, log[0].mixed], ['pending', SITE, 'a.example', false]);
  assert.equal(offered(log[0]), true);
  // A later scan that reads nothing keeps what was read
  const [kept] = await card.scan({});
  assert.deepEqual([kept.policy, kept.approvalHost, offered(kept)], [SITE, 'a.example', true]);
});

test('scans that disagree mark the row mixed for good, and it offers no Trust', async () => {
  for (const [before, after] of [[{ policy: SITE }, { policy: UPLOAD }], [{ policy: UPLOAD }, { policy: SITE }], [{ policy: SITE, host: 'a.example' }, { policy: SITE, host: 'browser' }]]) {
    const card = siteCard(ACCESS, before);
    await card.scan();
    const [mixed] = await card.scan(after);
    assert.deepEqual([mixed.mixed, offered(mixed)], [true, false], JSON.stringify([before, after]));
    const [again] = await card.scan(before);
    assert.deepEqual([again.mixed, offered(again)], [true, false]);
  }
});

test('an approved row keeps the evidence read while it waited, never relaxed by the read at the click', async () => {
  for (const [waited, clicked, policy, mixed] of [[{}, { policy: SITE }, SITE, false], [{ policy: UPLOAD }, { policy: SITE }, SITE, true]]) {
    const card = siteCard(ACCESS, waited);
    await card.scan();
    card.trustSite();
    const [entry] = await card.scan(clicked);
    assert.deepEqual([entry.result, entry.policy, entry.mixed], ['allowed', policy, mixed]);
    assert.equal(offered(entry), !mixed);
  }
});

test('a later read fills only the row its own approval wrote, never another tab\'s row with the same key', async () => {
  const card = siteCard(ACCESS);
  const [own] = await card.scan();
  // Another muse tab logged a different approval with the same card key after this one
  const other = { ...own, ts: own.ts + 1, approvalId: 'appr-test-81', policy: 'connector.example.unknown', approvalHost: '' };
  card.store.local.log = [other, ...card.store.local.log];
  const log = await card.scan({ policy: SITE, host: 'a.example' });
  assert.equal(log.length, 2);
  assert.deepEqual([log[0].approvalId, log[0].policy, log[0].approvalHost, offered(log[0])], ['appr-test-81', 'connector.example.unknown', '', false]);
  assert.deepEqual([log[1].approvalId, log[1].policy, log[1].approvalHost], ['appr-test-80', SITE, 'a.example']);
});

test('a card first read without an approval id is never filled by a later read', async () => {
  const card = siteCard(ACCESS, { id: '' });
  const [first] = await card.scan();
  assert.deepEqual([first.result, first.approvalId, first.policy], ['pending', '', '']);
  const [after] = await card.scan({ policy: SITE, host: 'a.example' });
  assert.deepEqual([after.approvalId, after.policy, after.approvalHost, offered(after)], ['', '', '', false]);
});

test('two cards with one key in one scan make a mixed row unless they hold the same approval id', async () => {
  for (const [id, mixed] of [['appr-test-81', true], ['', true], ['appr-test-80', false]]) {
    const card = siteCard(ACCESS, { policy: SITE, host: 'a.example' });
    const attrs = { 'data-testid': 'hatch-inline-approval-card', 'data-hatch-approval-surface': 'panel', 'data-maa-state': 'clean', 'data-maa-policy': SITE, 'data-maa-host': 'a.example', ...(id && { 'data-maa-approval-id': id }) };
    doc.body.append(new El('div', attrs, [
      new El('p', {}, [], ACCESS),
      new El('div', {}, [
        new El('button', { ...optAttrs('allow_once', 'allow_once'), 'data-hatch-approval-primary-action': 'true' }, [], 'Allow'),
        new El('button', optAttrs('deny', 'deny_for_this_task'), [], 'Deny'),
      ]),
    ]));
    const log = await card.scan();
    assert.equal(log.length, 1, id);
    assert.deepEqual([log[0].mixed, offered(log[0])], [mixed, !mixed], id);
  }
});

test('an approved row merges the pre-click re-read: a policy or host that changed there makes it mixed', async () => {
  for (const [change, mixed] of [[null, false], [['data-maa-policy', UPLOAD], true], [['data-maa-host', 'browser'], true]]) {
    const card = siteCard(ACCESS, { policy: SITE, host: 'a.example' });
    card.trustSite();
    let marks = 0;
    // The scan's own read is the first mark; the re-reads before the click come after it
    card.hooks.onMark = el => { if (++marks === 2 && change) el.setAttribute(...change); };
    const [entry] = await card.scan();
    assert.ok(marks >= 2);
    assert.deepEqual([entry.result, entry.mixed], ['allowed', mixed], JSON.stringify(change));
    assert.equal(offered(entry), !mixed);
  }
});

test('a purchase seen on any read stays a purchase on the row', async () => {
  const waiting = siteCard(ACCESS, { policy: SITE, purchase: true });
  await waiting.scan();
  const [kept] = await waiting.scan({ policy: SITE, purchase: false });
  assert.deepEqual([kept.result, kept.purchase, offered(kept)], ['pending', true, false]);

  const later = siteCard(ACCESS, { policy: SITE });
  const [before] = await later.scan();
  assert.equal(before.purchase, false);
  const [filled] = await later.scan({ policy: SITE, purchase: true });
  assert.deepEqual([filled.purchase, offered(filled)], [true, false]);

  const approved = siteCard(ACCESS, { policy: SITE, purchase: true });
  await approved.scan();
  approved.trustSite();
  const [entry] = await approved.scan({ policy: SITE, purchase: false });
  assert.deepEqual([entry.result, entry.purchase], ['allowed', true]);
});

test('an approved row is mixed when what was read while it waited is not the same approval id', async () => {
  for (const [waitedId, mixed] of [['', true], ['appr-test-81', true], ['appr-test-80', false]]) {
    const card = siteCard(ACCESS, { id: waitedId });
    const [first] = await card.scan();
    assert.equal(first.result, 'pending');
    card.trustSite();
    const [entry] = await card.scan({ policy: SITE, host: 'a.example' });
    assert.deepEqual([entry.result, entry.approvalId, entry.mixed], ['allowed', 'appr-test-80', mixed], waitedId);
    assert.equal(offered(entry), !mixed);
  }
  // A later waiting read with an id does not make the id-less first read count
  const card = siteCard(ACCESS, { id: '' });
  await card.scan();
  await card.scan({ policy: SITE, host: 'a.example' });
  card.trustSite();
  const [entry] = await card.scan({ policy: SITE, host: 'a.example' });
  assert.deepEqual([entry.result, entry.mixed], ['allowed', true]);
});

test('a purchase seen by the re-read that refuses the click stays on the card\'s rows', async () => {
  const card = siteCard(ACCESS, { policy: SITE, host: 'a.example' });
  const [waiting] = await card.scan();
  assert.deepEqual([waiting.result, waiting.purchase], ['pending', false]);
  card.trustSite();
  let marks = 0;
  card.hooks.onMark = el => { if (++marks === 2) el.setAttribute('data-maa-purchase', '1'); };
  const log = await card.scan();
  assert.deepEqual(Array.from(log, e => [e.result, e.purchase]), [['handled', true]]);
  assert.equal(offered(log[0]), false);
  // Back to waiting on the next scan, read without the purchase: the new row of that approval keeps it
  card.hooks.onMark = () => {};
  vm.runInContext('settings.sites = []', card.ctx);
  const next = await card.scan({ policy: SITE, host: 'a.example' });
  assert.deepEqual(Array.from(next, e => [e.result, e.purchase]), [['pending', true], ['handled', true]]);
});

test('an approved row merges the rows another tab wrote for the same approval id', async () => {
  const template = await loggedRow(ACCESS, { policy: SITE, host: 'a.example' });
  const cases = [[{ purchase: true }, { purchase: true, mixed: false }], [{ mixed: true }, { purchase: false, mixed: true }], [{ approvalId: 'appr-test-81', purchase: true, mixed: true }, { purchase: false, mixed: false }]];
  for (const [other, expected] of cases) {
    const card = siteCard(ACCESS, { policy: SITE, host: 'a.example' });
    card.store.local.log = [{ ...template, ...other }];
    card.trustSite();
    const [entry] = await card.scan();
    assert.deepEqual([entry.result, entry.approvalId, entry.purchase, entry.mixed], ['allowed', 'appr-test-80', expected.purchase, expected.mixed], JSON.stringify(other));
  }
});

// bridge.js answers no mark request without an approval id, so nothing on the node counts as read (#15 follow-up, item 4)
test('a row whose first read had a site policy but no approval id is never trustable', async () => {
  const card = siteCard(ACCESS, { id: '', policy: SITE, host: 'a.example' });
  const [first] = await card.scan();
  assert.deepEqual([first.approvalId, first.policy, offered(first)], ['', '', false]);
  const [after] = await card.scan({ policy: SITE, host: 'a.example' });
  assert.deepEqual([after.approvalId, offered(after)], ['', false]);
});

// Strict rules saved from an action or upload row (AAM.strictMatch), from card to click
const POST = 'connector.example.post.create';
const UPLOAD_TEXT = 'Allow the assistant to use Browser to upload this file? This task is from Chat A.';
const UPLOAD_MARKS = { policy: UPLOAD, host: 'browser', site: 'a.example' };
const strictRule = (policy, extra = {}) => ({ id: 'r1', title: 'Saved title', policy, chats: [], on: true, ...extra });
const setActions = (card, actions) => vm.runInContext(`settings.strictActions = ${JSON.stringify(actions)}`, card.ctx);
const allowClicks = () => doc.querySelector('[data-hatch-approval-primary-action="true"]').clicks;

test('a strict upload rule clicks only an upload to its exact site, read fresh, from a picked chat', async () => {
  const cases = [
    ['exact site', UPLOAD_MARKS, {}, 1],
    ['other site', { ...UPLOAD_MARKS, site: 'b.example' }, {}, 0],
    ['subdomain', { ...UPLOAD_MARKS, site: 'sub.a.example' }, {}, 0],
    ['www twin', { ...UPLOAD_MARKS, site: 'www.a.example' }, {}, 0],
    ['other policy', { ...UPLOAD_MARKS, policy: 'connector.browser.page.download' }, {}, 0],
    ['purchase', { ...UPLOAD_MARKS, purchase: true }, {}, 0],
    ['other chat', UPLOAD_MARKS, { chats: ['Chat B'] }, 0],
    ['picked chat', UPLOAD_MARKS, { chats: ['Chat A'] }, 1],
  ];
  for (const [name, marks, extra, clicks] of cases) {
    const card = siteCard(UPLOAD_TEXT, marks);
    setActions(card, [strictRule(UPLOAD, { site: 'a.example', ...extra })]);
    const [row] = await card.scan();
    assert.equal(allowClicks(), clicks, name);
    assert.equal(row.result, clicks ? 'allowed' : 'pending', name);
  }
});

test('a strict action rule clicks a card with its policy under another title, not one with its title and another policy', async () => {
  for (const [text, policy, clicks] of [['Publish a post? This task is from Chat A.', POST, 1], ['Saved title? This task is from Chat A.', 'connector.example.message.send', 0], ['Saved title? This task is from Chat A.', '', 0]]) {
    const card = siteCard(text, { policy });
    setActions(card, [strictRule(POST)]);
    await card.scan();
    assert.equal(allowClicks(), clicks, `${text} ${policy}`);
  }
});

test('a strict rule clicks nothing when bridge.js gives no fresh reply, whatever the node still holds', async () => {
  const card = siteCard(UPLOAD_TEXT, UPLOAD_MARKS);
  setActions(card, [strictRule(UPLOAD, { site: 'a.example' })]);
  card.hooks.onMark = () => false;
  const [row] = await card.scan();
  assert.equal(allowClicks(), 0);
  assert.equal(row.result, 'pending');
});

test('an upload row offers Trust, and the pick makes the next upload to that site in that chat click', async () => {
  const card = siteCard(UPLOAD_TEXT, UPLOAD_MARKS);
  const [row] = await card.scan();
  assert.deepEqual([row.result, row.policy, row.site, row.approvalId, row.purchase, row.mixed], ['pending', UPLOAD, 'a.example', 'appr-test-80', false, false]);
  assert.equal(offered(row), true);
  const plan = AAT.planTrust(AAM.SETTINGS_DEFAULTS, row, 'only');
  assert.deepEqual(Object.keys(plan.patch), ['strictActions']);
  assert.deepEqual(plan.patch.strictActions.map(a => [a.policy, a.site, a.chats]), [[UPLOAD, 'a.example', ['Chat A']]]);
  const next = siteCard(UPLOAD_TEXT, { ...UPLOAD_MARKS, id: 'appr-test-81' });
  setActions(next, plan.patch.strictActions);
  await next.scan();
  assert.equal(allowClicks(), 1);
  const other = siteCard(UPLOAD_TEXT.replace('Chat A', 'Chat B'), { ...UPLOAD_MARKS, id: 'appr-test-82' });
  setActions(other, plan.patch.strictActions);
  await other.scan();
  assert.equal(allowClicks(), 0);
});

// #15 follow-up, item 3; Codex round 1, item 1: the strict rule that was refused never clicks that approval later
test('a purchase seen by a first-scan refused click is on the approval\'s later rows', async () => {
  for (const trustedLater of [false, true]) {
    const card = siteCard(UPLOAD_TEXT, UPLOAD_MARKS);
    setActions(card, [strictRule(UPLOAD, { site: 'a.example' })]);
    let marks = 0;
    card.hooks.onMark = el => { if (++marks === 2) el.setAttribute('data-maa-purchase', '1'); };
    const refused = await card.scan();
    assert.equal(allowClicks(), 0);
    assert.equal(refused.length, 0);
    card.hooks.onMark = () => {};
    if (!trustedLater) setActions(card, []);
    const [row] = await card.scan(UPLOAD_MARKS);
    assert.equal(allowClicks(), 0, String(trustedLater));
    assert.deepEqual([row.result, row.approvalId, row.purchase], ['pending', 'appr-test-80', true], String(trustedLater));
    assert.equal(offered(row), false);
  }
});

// #15 follow-up, item 4
test('a node bridge.js does not answer for logs no approval data, even when it still holds an earlier mark', async () => {
  const card = siteCard(UPLOAD_TEXT, UPLOAD_MARKS);
  card.hooks.onMark = () => false;
  const [row] = await card.scan();
  assert.deepEqual([row.approvalId, row.policy, row.approvalHost, row.purchase], ['', '', '', null]);
  assert.equal(offered(row), false);
  // muse reused the node for another upload while the attributes still name the first one
  const reused = siteCard(UPLOAD_TEXT, UPLOAD_MARKS);
  await reused.scan();
  reused.hooks.onMark = () => false;
  doc.querySelector('p').text = 'Allow the assistant to use Browser to upload this file? This task is from Chat B.';
  const log = await reused.scan();
  assert.deepEqual(Array.from(log, e => [e.chat, e.approvalId, e.policy]), [['Chat B', '', ''], ['Chat A', 'appr-test-80', UPLOAD]]);
  assert.equal(offered(log[0]), false);
});

// Codex round 1, item 1: what another read of the approval saw, in this tab or the shared log, keeps a strict rule off it
test('a strict rule never clicks an approval a logged, waiting or refused read saw as a purchase or a mix', async () => {
  const logged = extra => [{ ts: 1, key: 'connector.browser.page.upload@a.example|Chat A', approvalId: 'appr-test-80', purchase: false, mixed: false, result: 'pending', ...extra }];
  const cases = [
    ['logged purchase', { log: logged({ purchase: true }) }, 0],
    ['logged mix', { log: logged({ mixed: true }) }, 0],
    ['logged purchase on another approval', { log: logged({ purchase: true, approvalId: 'appr-test-81' }) }, 1],
    ['clean log', { log: logged({}) }, 1],
  ];
  for (const [name, local, clicks] of cases) {
    const card = siteCard(UPLOAD_TEXT, UPLOAD_MARKS, local);
    setActions(card, [strictRule(UPLOAD, { site: 'a.example' })]);
    await card.scan();
    assert.equal(allowClicks(), clicks, name);
  }
  // A row another tab writes after this one loaded
  const later = siteCard(UPLOAD_TEXT, UPLOAD_MARKS);
  setActions(later, [strictRule(UPLOAD, { site: 'a.example' })]);
  later.changed({ log: { newValue: logged({ purchase: true }) } }, 'local');
  await later.scan();
  assert.equal(allowClicks(), 0, 'logged later');
  // The log not read yet
  const unread = siteCard(UPLOAD_TEXT, UPLOAD_MARKS);
  setActions(unread, [strictRule(UPLOAD, { site: 'a.example' })]);
  vm.runInContext('loggedDoubts = null', unread.ctx);
  await unread.scan();
  assert.equal(allowClicks(), 0, 'log not read');
  // Waiting as a purchase, then read without it while the rule is on
  const waiting = siteCard(UPLOAD_TEXT, { ...UPLOAD_MARKS, purchase: true });
  await waiting.scan();
  setActions(waiting, [strictRule(UPLOAD, { site: 'a.example' })]);
  await waiting.scan(UPLOAD_MARKS);
  assert.equal(allowClicks(), 0, 'waiting purchase');
  // A rule under actions keeps main's behaviour
  const old = siteCard(UPLOAD_TEXT, UPLOAD_MARKS, { log: logged({ purchase: true }) });
  vm.runInContext(`settings.actions = ${JSON.stringify([{ id: 'a1', title: 'x', policy: UPLOAD, site: 'a.example', chats: [], on: true }])}`, old.ctx);
  await old.scan();
  assert.equal(allowClicks(), 1, 'old rule');
});

// Codex round 1, item 5: an upload item of a combined card with a fresh id and site, but no fresh reply for the card itself
test('a strict rule never clicks a combined-card item unless the whole card answered not a purchase', async () => {
  for (const [parentAnswers, clicks] of [[false, 0], [true, 1]]) {
    makeDocument();
    fakeBridge();
    const allow = new El('button', { ...optAttrs('allow_once', 'allow_once'), 'data-hatch-approval-primary-action': 'true' }, [], 'Allow');
    const item = new El('div', { role: 'button', 'aria-expanded': 'true', 'data-maa-approval-id': 'appr-test-90', 'data-maa-state': 'clean', 'data-maa-policy': UPLOAD, 'data-maa-host': 'browser', 'data-maa-site': 'a.example' }, [
      new El('p', {}, [], 'Upload this file'),
      new El('div', {}, [allow, new El('button', optAttrs('deny', 'deny_for_this_task'), [], 'Deny')]),
    ]);
    const cardAttrs = { 'data-testid': 'hatch-inline-approval-card', 'data-hatch-approval-surface': 'chat', ...(parentAnswers && { 'data-maa-approval-id': 'appr-test-91' }) };
    doc.body.append(new El('div', cardAttrs, [new El('p', {}, [], 'Allow the assistant to use Browser? This task is from Chat A.'), item]));
    const { ctx, store } = loadContent({ strictActions: [strictRule(UPLOAD, { site: 'a.example' })] });
    ctx.scan();
    for (let i = 0; i < 6; i++) await tick();
    assert.equal(allow.clicks, clicks, String(parentAnswers));
    assert.equal(store.local.log[0].site, 'a.example');
  }
});

// Codex round 1, item 7
test('rows carry the evidence version unless they share an approval with a row an earlier version wrote', async () => {
  const [fresh] = await siteCard(UPLOAD_TEXT, UPLOAD_MARKS).scan();
  assert.equal(fresh.evidenceVersion, AAM.EVIDENCE_VERSION);
  assert.equal(offered(fresh), true);
  const { evidenceVersion, ...old } = { ...fresh, ts: 1, result: 'handled' };
  const [row, earlier] = await siteCard(UPLOAD_TEXT, UPLOAD_MARKS, { log: [old] }).scan();
  assert.deepEqual([row.result, row.approvalId, 'evidenceVersion' in row, 'evidenceVersion' in earlier], ['pending', 'appr-test-80', false, false]);
  assert.equal(offered(row), false);
  // A current row of the same approval loses the version once an older row is merged into it
  const [again, current, oldest] = await siteCard(UPLOAD_TEXT, UPLOAD_MARKS, { log: [{ ...fresh, ts: 2, result: 'handled' }, old] }).scan();
  assert.deepEqual([again, current, oldest].map(e => 'evidenceVersion' in e), [false, false, false]);
  // Another approval's old row leaves this one current
  const [other] = await siteCard(UPLOAD_TEXT, UPLOAD_MARKS, { log: [{ ...old, approvalId: 'appr-test-81' }] }).scan();
  assert.equal(other.evidenceVersion, AAM.EVIDENCE_VERSION);
});

// Codex round 2, item 3: the re-read right before the click finds another approval id on the node
test('a node swapped for another approval before the click stores both ids as doubted, for every tab, and clicks neither', async () => {
  const card = siteCard(UPLOAD_TEXT, UPLOAD_MARKS);
  setActions(card, [strictRule(UPLOAD, { site: 'a.example' })]);
  let marks = 0;
  card.hooks.onMark = el => { if (++marks === 2) el.setAttribute('data-maa-approval-id', 'appr-test-81'); };
  await card.scan();
  assert.equal(allowClicks(), 0);
  const doubts = Array.from(card.store.local.approvalDoubts);
  assert.deepEqual([...doubts].sort(), ['appr-test-80', 'appr-test-81']);
  // The next scan of this tab reads the second approval clean, and still clicks nothing
  card.hooks.onMark = () => {};
  const [row] = await card.scan({ ...UPLOAD_MARKS, id: 'appr-test-81' });
  assert.equal(allowClicks(), 0);
  assert.deepEqual([row.approvalId, row.result], ['appr-test-81', 'pending']);
  assert.equal(AAT.offers(AAM.SETTINGS_DEFAULTS, [row], doubts).size, 0);
  // Another tab that reads either approval clean
  for (const id of ['appr-test-80', 'appr-test-81']) {
    const other = siteCard(UPLOAD_TEXT, { ...UPLOAD_MARKS, id }, { approvalDoubts: doubts });
    setActions(other, [strictRule(UPLOAD, { site: 'a.example' })]);
    await other.scan();
    assert.equal(allowClicks(), 0, id);
  }
  const unrelated = siteCard(UPLOAD_TEXT, { ...UPLOAD_MARKS, id: 'appr-test-82' }, { approvalDoubts: doubts });
  setActions(unrelated, [strictRule(UPLOAD, { site: 'a.example' })]);
  await unrelated.scan();
  assert.equal(allowClicks(), 1);
});

// Codex round 2, items 4 and 5: refusal evidence lives in chrome.storage.local by approval id, whatever card key it had
test('a strict rule never clicks an approval another tab refused or logged as a doubt under any key', async () => {
  const rule = [strictRule(UPLOAD, { site: 'a.example' })];
  // A tab refuses the click on a purchase and writes no row; a tab opened later still knows
  const refusing = siteCard(UPLOAD_TEXT, UPLOAD_MARKS);
  setActions(refusing, rule);
  let marks = 0;
  refusing.hooks.onMark = el => { if (++marks === 2) el.setAttribute('data-maa-purchase', '1'); };
  assert.equal((await refusing.scan()).length, 0);
  assert.deepEqual(Array.from(refusing.store.local.approvalDoubts), ['appr-test-80']);
  const later = siteCard(UPLOAD_TEXT, UPLOAD_MARKS, { approvalDoubts: refusing.store.local.approvalDoubts });
  setActions(later, rule);
  await later.scan();
  assert.equal(allowClicks(), 0, 'stored refusal');
  // Stored doubts that arrive after the tab loaded
  const open = siteCard(UPLOAD_TEXT, UPLOAD_MARKS);
  setActions(open, rule);
  open.changed({ approvalDoubts: { newValue: ['appr-test-80'] } }, 'local');
  await open.scan();
  assert.equal(allowClicks(), 0, 'stored later');
  // Doubts reported before this tab's first read of the storage are kept when that read returns without them
  const early = siteCard(UPLOAD_TEXT, UPLOAD_MARKS);
  setActions(early, rule);
  vm.runInContext('loggedDoubts = null', early.ctx);
  early.changed({ approvalDoubts: { newValue: ['appr-test-80'] } }, 'local');
  vm.runInContext('rememberDoubts([], [], true)', early.ctx);
  await early.scan();
  assert.equal(allowClicks(), 0, 'stored before the first read');
  // A logged row of the same approval under another card key
  const otherKey = [{ ts: 1, key: 'connector.example.post.create|Chat B', approvalId: 'appr-test-80', purchase: true, mixed: false, result: 'pending' }];
  for (const [name, extra, clicks] of [['purchase', {}, 0], ['mixed', { purchase: false, mixed: true }, 0], ['clean', { purchase: false }, 1]]) {
    const card = siteCard(UPLOAD_TEXT, UPLOAD_MARKS, { log: [{ ...otherKey[0], ...extra }] });
    setActions(card, rule);
    await card.scan();
    assert.equal(allowClicks(), clicks, name);
  }
});
