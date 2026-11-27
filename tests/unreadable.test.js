'use strict';

// Tests unreadable chat-card detection in content.js (debounce, clearing, panel exclusion, no card text stored)
// and the fallback notice + issue URL in popup.js using vm contexts and minimal fake DOMs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const AAM = require('../shared.js');
const AAG = require('../guard.js');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const CONTENT = read('content.js');
const POPUP = read('popup.js');
const MANIFEST = JSON.parse(read('manifest.json'));
const EN_MESSAGES = JSON.parse(read('_locales/en/messages.json'));

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
    for (const c of children) this.append(c);
  }
  append(c) { c.parent = this; this.children.push(c); return c; }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(c => c !== this);
    this.parent = null;
  }
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
  click() {}
  dispatchEvent(e) { e.target = this; return true; }
}

function makeContentEnv({ lang = 'en', sync = {}, startNow = 100000 } = {}) {
  let now = startNow;
  const html = new El('html', lang ? { lang } : {});
  const body = html.append(new El('body'));
  html.isRoot = true;
  const doc = {
    documentElement: html,
    body,
    querySelectorAll: sel => html.querySelectorAll(sel),
    querySelector: sel => html.querySelector(sel),
    getElementById: id => html.descendants().find(e => e.getAttribute('id') === id) || null,
  };
  const store = { sync: { ...AAM.SETTINGS_DEFAULTS, ...sync }, local: { ...AAM.LOCAL_DEFAULTS } };
  const area = name => ({
    get(defaults, cb) {
      const out = { ...defaults, ...Object.fromEntries(Object.keys(defaults).filter(k => k in store[name]).map(k => [k, store[name][k]])) };
      if (cb) cb(out);
      return Promise.resolve(out);
    },
    set(values) { Object.assign(store[name], values); return Promise.resolve(); },
  });
  class FakeDate extends Date {
    static now() { return now; }
  }
  class Ev { constructor(type, init = {}) { Object.assign(this, init); this.type = type; } }
  const ctx = {
    AAM, AAG, Date: FakeDate, document: doc,
    console: { info() {}, warn() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: Ev, KeyboardEvent: Ev, PointerEvent: Ev,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    chrome: {
      runtime: { id: 'test', sendMessage: () => Promise.resolve() },
      storage: { sync: area('sync'), local: area('local'), onChanged: { addListener() {} } },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(CONTENT, ctx);
  return {
    doc, body, store, ctx,
    setNow(t) { now = t; },
    scanAt(t) { now = t; ctx.scan(); },
  };
}

function makeCard(body, { surface = 'chat', id = 'appr-1', dataPath = '', withButtons = true, text = 'Access secret-bank.example.com? This task is from Private Chat.' } = {}) {
  const attrs = { 'data-testid': 'hatch-inline-approval-card', 'data-hatch-approval-surface': surface };
  if (id) attrs['data-maa-approval-id'] = id;
  if (dataPath) attrs['data-maa-data-path'] = dataPath;
  const buttons = withButtons ? [new El('button', {}, [], 'Allow once'), new El('button', {}, [], 'Deny')] : [];
  const card = new El('div', attrs, [new El('p', {}, [], text), new El('div', {}, buttons)]);
  body.append(card);
  return card;
}

test('unreadable debounce: flicker under 3s is not counted, persistent card is counted and cleared when clean or gone', () => {
  const env = makeContentEnv({ lang: 'ja', startNow: 10000 });
  const card = makeCard(env.body, { dataPath: 'missing' });

  env.scanAt(10000);
  assert.equal(env.store.local.unreadable.count, 0);

  env.scanAt(12500);
  assert.equal(env.store.local.unreadable.count, 0);

  // Brief clean render resets the 3s timer
  card.removeAttribute('data-maa-data-path');
  env.scanAt(12600);
  assert.equal(env.store.local.unreadable.count, 0);

  // Becomes unreadable again; still under 3s at +2900ms
  card.setAttribute('data-maa-data-path', 'missing');
  env.scanAt(13000);
  env.scanAt(15900);
  assert.equal(env.store.local.unreadable.count, 0);

  // Stays unreadable for >= 3s -> counted
  env.scanAt(16000);
  assert.deepEqual({ ...env.store.local.unreadable }, { count: 1, lastSeen: 16000, lang: 'ja' });

  // Reads clean -> cleared immediately
  card.removeAttribute('data-maa-data-path');
  env.scanAt(16100);
  assert.deepEqual({ ...env.store.local.unreadable }, { count: 0, lastSeen: 0, lang: '' });

  // Disappears from DOM -> cleared immediately
  card.setAttribute('data-maa-data-path', 'missing');
  env.scanAt(20000);
  env.scanAt(23000);
  assert.equal(env.store.local.unreadable.count, 1);
  card.remove();
  env.scanAt(23100);
  assert.deepEqual({ ...env.store.local.unreadable }, { count: 0, lastSeen: 0, lang: '' });
});

test('chat card without approval id counts after 3s; resolved card without buttons does not', () => {
  const env = makeContentEnv({ startNow: 50000 });
  makeCard(env.body, { id: '', dataPath: '' });
  makeCard(env.body, { id: '', dataPath: 'missing', withButtons: false });

  env.scanAt(50000);
  assert.equal(env.store.local.unreadable.count, 0);
  env.scanAt(53000);
  assert.equal(env.store.local.unreadable.count, 1);
});

test('panel surface cards are never counted as unreadable', () => {
  const env = makeContentEnv({ startNow: 10000 });
  makeCard(env.body, { surface: 'panel', id: 'appr-panel-1', dataPath: 'missing' });
  makeCard(env.body, { surface: 'panel', id: '', dataPath: '' });

  env.scanAt(10000);
  env.scanAt(15000);
  assert.deepEqual({ ...env.store.local.unreadable }, { count: 0, lastSeen: 0, lang: '' });
});

test('stored unreadable summary contains no card text, titles, chat names or URLs', () => {
  const env = makeContentEnv({ lang: 'zh-TW', startNow: 10000 });
  makeCard(env.body, {
    dataPath: 'missing',
    text: 'Access https://private.corp.example/secret? This task is from Payroll Bot.',
  });

  env.scanAt(10000);
  env.scanAt(14000);
  assert.deepEqual(Object.keys(env.store.local.unreadable).sort(), ['count', 'lang', 'lastSeen']);
  const serialized = JSON.stringify(env.store.local.unreadable);
  assert.ok(!serialized.includes('private.corp.example'));
  assert.ok(!serialized.includes('Payroll'));
  assert.ok(!serialized.includes('secret'));
});

// Minimal fake DOM for popup.js focusing on renderHome() and the unreadable notice
function makePopupEnv({ local = {}, uiLang = 'en-US', now = 1_000_000 } = {}) {
  const elements = new Map();
  const openedUrls = [];
  let closed = false;
  function makeStub(id) {
    const listeners = {};
    return {
      id,
      hidden: false,
      checked: false,
      value: '',
      textContent: '',
      href: '',
      dataset: {},
      classList: { toggle() {} },
      append() {},
      replaceChildren() {},
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      trigger(type, e = { preventDefault() {} }) { for (const fn of listeners[type] || []) fn(e); },
    };
  }
  const getEl = sel => {
    if (!elements.has(sel)) elements.set(sel, makeStub(sel));
    return elements.get(sel);
  };
  const doc = {
    querySelector: getEl,
    querySelectorAll: () => [],
    createElement: tag => makeStub(tag),
  };
  const store = {
    sync: { ...AAM.SETTINGS_DEFAULTS },
    local: { ...AAM.LOCAL_DEFAULTS, ...local },
    session: { pendingByTab: {} },
  };
  const area = name => ({
    get(defaults) {
      return Promise.resolve({ ...defaults, ...Object.fromEntries(Object.keys(defaults).filter(k => k in store[name]).map(k => [k, store[name][k]])) });
    },
    set(values) { Object.assign(store[name], values); return Promise.resolve(); },
  });
  class FakeDate extends Date {
    static now() { return now; }
  }
  const I18N = {
    code: 'en',
    load: () => Promise.resolve(),
    t(key, ...subs) {
      let text = EN_MESSAGES[key]?.message ?? key;
      subs.forEach((sub, i) => { text = text.split(`$${i + 1}`).join(String(sub)); });
      return text;
    },
    apply() {},
    ago: () => 'just now',
    clock: () => '12:00',
  };
  const ctx = {
    AAM, I18N, Date: FakeDate, URLSearchParams, document: doc,
    window: { close() { closed = true; } },
    chrome: {
      runtime: { getManifest: () => ({ version: MANIFEST.version }), openOptionsPage() {} },
      i18n: { getUILanguage: () => uiLang },
      tabs: { create({ url }) { openedUrls.push(url); } },
      storage: { sync: area('sync'), local: area('local'), session: area('session'), onChanged: { addListener() {} } },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(POPUP, ctx);
  return { getEl, openedUrls, isClosed: () => closed, ctx };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('popup shows and hides unreadable notice by count and recency', async () => {
  const now = 1_000_000;

  // count 0 -> hidden
  const zero = makePopupEnv({ local: { unreadable: { count: 0, lastSeen: now, lang: 'en' } }, now });
  await flush();
  assert.equal(zero.getEl('#unreadable').hidden, true);

  // count 1, recent -> shown with singular text
  const one = makePopupEnv({ local: { unreadable: { count: 1, lastSeen: now - 60_000, lang: 'en' } }, now });
  await flush();
  assert.equal(one.getEl('#unreadable').hidden, false);
  assert.equal(one.getEl('#unreadable-text').textContent, EN_MESSAGES.unreadableNoticeOne.message);

  // count 3, recent -> shown with count
  const many = makePopupEnv({ local: { unreadable: { count: 3, lastSeen: now - 9 * 60_000, lang: 'ja' } }, now });
  await flush();
  assert.equal(many.getEl('#unreadable').hidden, false);
  assert.ok(many.getEl('#unreadable-text').textContent.includes('3'));

  // stale (> 10 minutes) -> hidden
  const stale = makePopupEnv({ local: { unreadable: { count: 2, lastSeen: now - 11 * 60_000, lang: 'en' } }, now });
  await flush();
  assert.equal(stale.getEl('#unreadable').hidden, true);
});

test('popup report link pre-fills issue URL with metadata only and no card text', async () => {
  const now = 1_000_000;
  const env = makePopupEnv({
    local: {
      unreadable: { count: 2, lastSeen: now - 1000, lang: 'zh-TW' },
      log: [{ ts: now, key: 'secret.example|Private Chat', host: 'secret.example', chat: 'Private Chat', title: 'Access secret.example?', action: '', site: '', result: 'pending' }],
    },
    uiLang: 'zh-TW',
    now,
  });
  await flush();

  const link = env.getEl('#unreadable-report');
  assert.ok(link.href.startsWith(`${AAM.REPO_URL}/issues/new?`));
  const parsed = new URL(link.href);
  const title = parsed.searchParams.get('title');
  const body = parsed.searchParams.get('body');

  assert.ok(title && title.length > 0);
  assert.ok(body.includes(MANIFEST.version));
  assert.ok(body.includes('zh-TW'));
  assert.ok(body.includes('2'));
  assert.ok(!link.href.includes('secret.example'));
  assert.ok(!link.href.includes('Private'));

  link.trigger('click');
  assert.deepEqual(env.openedUrls, [link.href]);
  assert.equal(env.isClosed(), true);
});
