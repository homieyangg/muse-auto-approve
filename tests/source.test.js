'use strict';

// Source chat or schedule by id: matching, rule merging, import/export, and the ids bridge.js writes
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const AAM = require('../shared.js');
const { optionMarks, markItem, threadIdOfRow } = require('../bridge.js');

const ROOT = path.join(__dirname, '..');
// main before this change; its shared.js is the reference for cards and settings without ids
const MAIN_COMMIT = '7889da9';
function mainShared() {
  try {
    const source = execFileSync('git', ['show', `${MAIN_COMMIT}:shared.js`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const file = path.join(ROOT, 'shared.js');
    const m = new Module(file, module);
    m.filename = file;
    m.paths = Module._nodeModulePaths(ROOT);
    m._compile(source, file);
    return m.exports;
  } catch {
    return null;
  }
}
const MAIN = mainShared();
const needsMain = { skip: !MAIN && `${MAIN_COMMIT} is not in this clone` };

const settingsWith = patch => ({ ...AAM.SETTINGS_DEFAULTS, mode: 'trusted', ...patch });
const site = (chats, extra = {}) => ({ id: 'site-test-1', host: 'example.com', sub: false, on: true, chats, ...extra });
const action = (chats, extra = {}) => ({ id: 'action-test-1', title: 'Send email', policy: 'connector.gmail.users.messages.send', on: true, chats, ...extra });
const chat = (name, ids = {}) => ({ id: `chat-test-${name || 'unnamed'}`, name, ...ids, on: true });
const hostCard = (chatName, ids = {}) => ({ host: 'example.com', chat: chatName, title: 'Access example.com', action: '', policy: '', site: '', ...ids });
const actionCard = (chatName, ids = {}) => ({ host: '', chat: chatName, title: 'Send email', action: 'Send email', policy: 'connector.gmail.users.messages.send', site: '', ...ids });

const T1 = { threadId: 'thread-test-1' };
const T2 = { threadId: 'thread-test-2' };
const S1 = { scheduleId: 'schedule-test-1' };

// Every place a chat can be trusted: the chat list, a site's chat limit and an action's chat limit
function everyRule(entry) {
  const asRule = typeof entry === 'string' ? entry : { name: entry.name, ...('threadId' in entry && { threadId: entry.threadId }), ...('scheduleId' in entry && { scheduleId: entry.scheduleId }) };
  return {
    chats: [settingsWith({ chats: [chat(asRule.name ?? asRule, typeof asRule === 'string' ? {} : asRule)] }), hostCard],
    site: [settingsWith({ sites: [site([asRule])] }), hostCard],
    action: [settingsWith({ actions: [action([asRule])] }), actionCard],
  };
}

function trusted(entry, chatName, ids) {
  return Object.fromEntries(Object.entries(everyRule(entry)).map(([where, [settings, make]]) => [where, AAM.isTrusted(settings, make(chatName, ids))]));
}
const all = value => ({ chats: value, site: value, action: value });

test('an entry with an id matches a card with the same id', () => {
  assert.deepEqual(trusted({ name: 'Research', ...T1 }, 'Research', T1), all(true));
  assert.deepEqual(trusted({ name: 'Research', ...S1 }, 'Research', S1), all(true));
});

test('the same name with a different id does not match', () => {
  assert.deepEqual(trusted({ name: 'Research', ...T1 }, 'Research', T2), all(false));
  assert.deepEqual(trusted({ name: 'Research', ...S1 }, 'Research', { scheduleId: 'schedule-test-2' }), all(false));
});

test('a renamed chat keeps matching by id', () => {
  assert.deepEqual(trusted({ name: 'Old name', ...T1 }, 'New name', T1), all(true));
  // Also when the card's wording gave no name at all
  assert.deepEqual(trusted({ name: 'Old name', ...T1 }, '', T1), all(true));
  // And an entry whose name was never known
  assert.deepEqual(trusted({ name: '', ...T1 }, '', T1), all(true));
});

test('a legacy name entry matches a card with an id by name, as on main', () => {
  assert.deepEqual(trusted('Research', 'Research', T1), all(true));
  assert.deepEqual(trusted('Research', 'Other', T1), all(false));
  assert.equal(AAM.isTrusted(settingsWith({ chats: [chat('Research')] }), hostCard('Research', T1)), true);
});

test('an entry with an id matches a card without ids by name', () => {
  assert.deepEqual(trusted({ name: 'Research', ...T1 }, 'Research'), all(true));
  assert.deepEqual(trusted({ name: 'Research', ...T1 }, 'Other'), all(false));
  // An unnamed entry never matches a card without a name
  assert.deepEqual(trusted({ name: '', ...T1 }, ''), all(false));
});

test('a thread entry never matches a schedule card, and the other way round', () => {
  assert.deepEqual(trusted({ name: 'Research', ...T1 }, 'Research', S1), all(false));
  assert.deepEqual(trusted({ name: 'Research', ...S1 }, 'Research', T1), all(false));
  // Both types on both sides must all agree
  assert.deepEqual(trusted({ name: 'Research', ...T1, ...S1 }, 'Research', { ...T1, scheduleId: 'schedule-test-2' }), all(false));
  assert.deepEqual(trusted({ name: 'Research', ...T1, ...S1 }, 'Research', T1), all(true));
});

test('a card id that is not a valid id is ignored: the name decides', () => {
  assert.deepEqual(trusted({ name: 'Research', ...T1 }, 'Research', { threadId: 'bad id with spaces' }), all(true));
  assert.deepEqual(trusted({ name: 'Research', ...T1 }, 'Other', { threadId: 'bad id with spaces' }), all(false));
});

test('rules from a card with ids store them; rules from a card without ids are main\'s', () => {
  const src = { name: 'Research', ...T1 };
  assert.deepEqual(AAM.addSiteRule([], 'example.com', { chat: src })[0].chats, [src]);
  assert.deepEqual(AAM.addSiteRule([], 'example.com', { chat: 'Research' })[0].chats, ['Research']);
  assert.deepEqual(AAM.addActionRule([], 'Send email', { chat: src })[0].chats, [src]);
  const chats = AAM.addChatRule([], 'Research', T1);
  assert.deepEqual(chats.map(({ id, ...c }) => c), [{ name: 'Research', ...T1, on: true }]);
  assert.deepEqual(AAM.addChatRule([], 'Research').map(({ id, ...c }) => c), [{ name: 'Research', on: true }]);
});

test('re-saving from a card with ids attaches them to a legacy entry of the same name', () => {
  const sites = [site(['Research', 'Other'])];
  assert.deepEqual(AAM.addSiteRule(sites, 'example.com', { chat: { name: 'Research', ...T1 } })[0].chats, [{ name: 'Research', ...T1 }, 'Other']);
  const chats = [chat('Research', { on: false })];
  const next = AAM.addChatRule(chats, 'Research', T1);
  assert.deepEqual(next, [{ id: 'chat-test-Research', name: 'Research', ...T1, on: true }]);
  // A legacy entry is not merged into an id'd chat of another name
  assert.equal(AAM.addChatRule(chats, 'Elsewhere', T1).length, 2);
});

test('an entry with the same id gets the better name and is not duplicated', () => {
  const sites = [site([{ name: 'Old name', ...T1 }])];
  assert.deepEqual(AAM.addSiteRule(sites, 'example.com', { chat: { name: 'New name', ...T1 } })[0].chats, [{ name: 'New name', ...T1 }]);
  assert.deepEqual(AAM.addSiteRule(sites, 'example.com', { chat: { name: '', ...T1 } })[0].chats, [{ name: 'Old name', ...T1 }]);
  // Another chat with the same name is added next to it
  assert.equal(AAM.addSiteRule(sites, 'example.com', { chat: { name: 'Old name', ...T2 } })[0].chats.length, 2);
  // A name-only add is already covered by the entry of that name
  assert.deepEqual(AAM.addSiteRule(sites, 'example.com', { chat: 'Old name' })[0].chats, [{ name: 'Old name', ...T1 }]);
  const chats = [chat('Old name', T1)];
  assert.deepEqual(AAM.addChatRule(chats, 'New name', T1), [{ id: 'chat-test-Old name', name: 'New name', ...T1, on: true }]);
  assert.deepEqual(AAM.addChatRule(chats, '', T1), [{ id: 'chat-test-Old name', name: 'Old name', ...T1, on: true }]);
  assert.equal(AAM.addChatRule(chats, 'Old name', T2).length, 2);
});

test('trusting a site from any chat still clears the chat limit', () => {
  assert.deepEqual(AAM.addSiteRule([site([{ name: 'Research', ...T1 }])], 'example.com', { chat: '' })[0].chats, []);
});

// Shape of a settings export from main: name strings in chat limits, name-only chat entries
const OLD_EXPORT = {
  enabled: true, mode: 'trusted', preferAlways: false, openBackground: true, includeActions: true, lang: 'ja',
  sites: [
    { id: 'site-test-1', host: 'Example.com', sub: true, on: true, chats: ['Research', 'Weekly digest'] },
    { id: 'site-test-2', host: 'https://upload.example/path', sub: false, on: false, chats: [] },
    { id: 'site-test-3', host: 'not a host', sub: false, on: true, chats: [] },
  ],
  chats: [{ id: 'chat-test-1', name: 'Research', on: true }, { id: 'chat-test-2', name: 'Weekly digest', on: false }, { id: 'chat-test-3', name: '' }],
  actions: [
    { id: 'action-test-1', title: 'Send email', policy: 'connector.gmail.users.messages.send', on: true, chats: ['Research'] },
    { id: 'action-test-2', title: 'Upload', policy: 'connector.browser.page.upload', site: 'upload.example', sub: true, on: true, chats: [] },
  ],
};

test('an old export imports byte-identically to main', needsMain, () => {
  assert.equal(JSON.stringify(AAM.sanitizeSettings(OLD_EXPORT)), JSON.stringify(MAIN.sanitizeSettings(OLD_EXPORT)));
  // Main's own edge cases on strings, kept as they were
  const odd = { sites: [site(['', 'Research'])], actions: [action([''])], chats: [{ id: 'c', name: 'x', on: 'yes' }] };
  assert.equal(JSON.stringify(AAM.sanitizeSettings(odd)), JSON.stringify(MAIN.sanitizeSettings(odd)));
});

test('the new format imports with its ids', () => {
  const raw = {
    sites: [site(['Research', { name: 'Ops', ...T1 }, { name: '', ...S1 }, { name: 'Named only' }])],
    chats: [chat('Research', T1), chat('', S1), chat('Plain')],
    actions: [action([{ name: 'Ops', ...T1, extra: 'dropped' }])],
  };
  const clean = AAM.sanitizeSettings(raw);
  assert.deepEqual(clean.sites[0].chats, ['Research', { name: 'Ops', ...T1 }, { name: '', ...S1 }, 'Named only']);
  assert.deepEqual(clean.chats, [
    { id: 'chat-test-Research', name: 'Research', ...T1, on: true },
    { id: 'chat-test-unnamed', name: '', ...S1, on: true },
    { id: 'chat-test-Plain', name: 'Plain', on: true },
  ]);
  assert.deepEqual(clean.actions[0].chats, [{ name: 'Ops', ...T1 }]);
});

test('invalid ids are dropped without dropping the name', () => {
  const bad = ['', 'has space', 'x'.repeat(129), 'quote"', 'ünïcode', 42, { id: 1 }, null];
  for (const id of bad) {
    const clean = AAM.sanitizeSettings({ sites: [site([{ name: 'Research', threadId: id }])], chats: [chat('Research', { threadId: id, scheduleId: id })] });
    assert.deepEqual(clean.sites[0].chats, ['Research'], JSON.stringify(id));
    assert.deepEqual(clean.chats, [{ id: 'chat-test-Research', name: 'Research', on: true }], JSON.stringify(id));
  }
  assert.deepEqual(AAM.sanitizeSettings({ chats: [chat('Research', { threadId: 'thread-test-1', scheduleId: 'bad id' })] }).chats[0].scheduleId, undefined);
});

test('an entry with neither a name nor a valid id is dropped, and never widens a rule to every chat', () => {
  const clean = AAM.sanitizeSettings({
    sites: [site([{ name: '', threadId: 'bad id' }]), site([{ threadId: 'bad id' }, 'Research'], { id: 'site-test-2', host: 'other.example' })],
    chats: [chat('', { threadId: 'bad id' })],
    actions: [action([7])],
  });
  assert.deepEqual(clean.sites.map(s => [s.host, s.chats]), [['other.example', ['Research']]]);
  assert.deepEqual(clean.chats, []);
  assert.deepEqual(clean.actions, []);
});

test('export then import gives the same settings', () => {
  const settings = AAM.sanitizeSettings({
    ...OLD_EXPORT,
    sites: [...OLD_EXPORT.sites, site([{ name: 'Ops', ...T1 }, 'Research'], { id: 'site-test-4', host: 'ops.example' })],
    chats: [...OLD_EXPORT.chats, chat('Ops', { ...T1, ...S1 })],
    actions: [...OLD_EXPORT.actions, action([{ name: '', ...S1 }], { id: 'action-test-3' })],
  });
  const exported = JSON.parse(JSON.stringify({ app: 'auto-approve-for-muse', version: 'test', settings }));
  assert.deepEqual(AAM.sanitizeSettings(exported.settings), settings);
});

// For cards without ids every trust decision is main's, whatever entries the rules hold
test('cards without ids are trusted exactly as on main', needsMain, () => {
  const entries = ['Research', 'Other', ''];
  const cardChats = ['Research', 'Other', ''];
  const settingsList = [];
  for (const name of entries) {
    for (const on of [true, false]) {
      settingsList.push(settingsWith({ chats: [{ id: 'c', name, on }] }));
      settingsList.push(settingsWith({ sites: [site([name].filter(Boolean), { on })] }));
      settingsList.push(settingsWith({ sites: [site([name])] }));
      settingsList.push(settingsWith({ actions: [action([name].filter(Boolean), { on })] }));
      settingsList.push(settingsWith({ actions: [action([], { policy: undefined }), action([name], { title: 'Other title' })] }));
    }
  }
  settingsList.push(settingsWith({ sites: [site([], { host: 'sub.example.com' }), site([], { host: 'example.com', sub: true })] }));
  const cards = cardChats.flatMap(name => [hostCard(name), actionCard(name), { ...hostCard(name), host: 'a.example.com' }, { ...actionCard(name), policy: '' }]);
  let checked = 0;
  for (const settings of settingsList) {
    for (const card of cards) {
      assert.equal(AAM.isTrusted(settings, card), MAIN.isTrusted(settings, card), JSON.stringify([settings.chats, settings.sites, settings.actions, card]));
      assert.equal(AAM.cardKey(card), MAIN.cardKey(card));
      checked++;
    }
  }
  assert.ok(checked > 100);
});

test('a card key carries its ids, so two chats of one name are different cards', () => {
  assert.equal(AAM.cardKey(hostCard('Research')), 'example.com|Research');
  assert.equal(AAM.cardKey(hostCard('Research', T1)), 'example.com|Research|t:thread-test-1');
  assert.notEqual(AAM.cardKey(hostCard('Research', T1)), AAM.cardKey(hostCard('Research', T2)));
});

// bridge.js: the same fabricated tree as tests/options.test.js
const opt = (kind, labelKind, scope) => ({ kind, label: scope ? { kind: labelKind, scope } : { kind: labelKind }, labelText: 'label' });
const OPTIONS = [opt('allow_once', 'allow_once'), opt('allow_always', 'allow_always_scoped', 'destination'), opt('deny', 'deny_for_this_task')];

function approval(id, scope = {}, extra = {}) {
  return {
    approvalId: id,
    policySubject: 'connector.browser.page.upload',
    payloadPreview: 'Destination: https://upload.example',
    scope: { sessionScopeId: 'session-test-1', threadId: null, displayName: null, scheduleId: null, ...scope },
    scheduleId: null,
    serverPresentation: { payloadType: 'connector', decisionOptions: OPTIONS },
    ...extra,
  };
}

function link(parent, children) {
  parent.child = children[0] || null;
  children.forEach((c, i) => { c.return = parent; c.sibling = children[i + 1] || null; });
}

function cardTree(appr, id = appr.approvalId) {
  const fiberRoot = {};
  const root = { stateNode: fiberRoot, memoizedProps: {} };
  fiberRoot.current = root;
  const card = { memoizedProps: { approval: appr } };
  const row = { memoizedProps: {} };
  link(root, [card]);
  link(card, [row]);
  const buttons = OPTIONS.map((o, i) => {
    const button = { key: `${id}-cta-${i}-${o.kind}`, memoizedProps: {} };
    const host = { memoizedProps: { type: 'button' } };
    link(button, [host]);
    return { button, host };
  });
  link(row, buttons.map(b => b.button));
  return { hosts: buttons.map(b => b.host), row };
}

const pendingOf = (...approvals) => id => approvals.find(a => a.approvalId === id) || null;
const read = (card, pending = () => null, tree = card) => optionMarks(card, cardTree(tree, card.approvalId).hosts.map(fiber => ({ fiber })), undefined, pending).source;

test('bridge: the source ids come from the approval scope when every source agrees', () => {
  const card = approval('appr-test-80', T1);
  assert.deepEqual(read(card), { threadId: 'thread-test-1', scheduleId: '' });
  assert.deepEqual(read(card, pendingOf(approval('appr-test-80', T1))), { threadId: 'thread-test-1', scheduleId: '' });
  const scheduled = approval('appr-test-81', S1, { scheduleId: 'schedule-test-1' });
  assert.deepEqual(read(scheduled), { threadId: '', scheduleId: 'schedule-test-1' });
  // Top-level scheduleId alone is read too
  assert.deepEqual(read(approval('appr-test-82', {}, { scheduleId: 'schedule-test-1' })), { threadId: '', scheduleId: 'schedule-test-1' });
  assert.equal(read(approval('appr-test-83')), null);
});

test('bridge: sources that disagree on the ids give no ids, never one of them', () => {
  const card = approval('appr-test-84', T1);
  // Pending entry with another thread, or without one
  assert.equal(read(card, pendingOf(approval('appr-test-84', T2))), null);
  assert.equal(read(card, pendingOf(approval('appr-test-84'))), null);
  // A button's own approval (same id, another object) with another thread
  assert.equal(read(card, () => null, approval('appr-test-84', T2)), null);
  // Scope and top level naming different schedules
  assert.equal(read(approval('appr-test-85', S1, { scheduleId: 'schedule-test-2' })), null);
  // An id that is not a string
  assert.equal(read(approval('appr-test-86', { threadId: 42 })), null);
  assert.equal(read(approval('appr-test-87', { threadId: { id: 'thread-test-1' } })), null);
});

function fakeEl(fiber, { buttons = [], surface = 'chat' } = {}) {
  const attrs = {};
  return {
    __reactFiber$test: fiber,
    getAttribute: name => (name in attrs ? attrs[name] : null),
    setAttribute: (name, value) => { attrs[name] = String(value); },
    removeAttribute: name => { delete attrs[name]; },
    hasAttribute: name => name in attrs,
    closest: sel => {
      if (!sel.includes('hatch-inline-approval-card') || sel.includes('background')) return null;
      const want = sel.match(/approval-surface="([a-z]+)"/);
      return !want || want[1] === surface ? {} : null;
    },
    querySelectorAll: () => buttons,
    querySelector: () => null,
    matches: () => false,
    attrs,
  };
}

test('bridge: a chat card gets the id attributes; a panel card and a card without data do not', () => {
  const appr = approval('appr-test-88', T1);
  const { hosts, row } = cardTree(appr);
  const chatEl = fakeEl(row, { buttons: hosts.map(h => fakeEl(h)) });
  markItem(chatEl, undefined, () => null);
  assert.equal(chatEl.attrs['data-maa-thread-id'], 'thread-test-1');
  assert.equal(chatEl.attrs['data-maa-schedule-id'], undefined);
  const panelEl = fakeEl(row, { buttons: hosts.map(h => fakeEl(h)), surface: 'panel' });
  markItem(panelEl, undefined, () => null);
  assert.equal(panelEl.attrs['data-maa-thread-id'], undefined);
  // The same card read again after its pending entry disagrees loses the ids
  markItem(chatEl, undefined, pendingOf(approval('appr-test-88', T2)));
  assert.equal(chatEl.attrs['data-maa-thread-id'], undefined);
  // Without option data (no state) no ids are written
  const bare = approval('appr-test-89', T1, { serverPresentation: { payloadType: 'connector', decisionOptions: null } });
  const tree = cardTree(bare);
  const bareEl = fakeEl(tree.row, { buttons: tree.hosts.map(h => fakeEl(h)) });
  markItem(bareEl, undefined, () => null);
  assert.equal(bareEl.attrs['data-maa-state'], undefined);
  assert.equal(bareEl.attrs['data-maa-thread-id'], undefined);
});

// Sidebar row: [title] element -> spans -> row component with actionAnalyticsMetadata -> keyed list item
function sidebarRow(id, { key = `thread-row-${id}`, depth = 23, metaId = id } = {}) {
  const fiberRoot = {};
  const root = { stateNode: fiberRoot, memoizedProps: {} };
  fiberRoot.current = root;
  const item = { key, memoizedProps: {} };
  const rowComponent = { memoizedProps: { actionAnalyticsMetadata: { thread_id: metaId } } };
  link(root, [item]);
  link(item, [rowComponent]);
  let parent = rowComponent;
  for (let i = 0; i < depth - 1; i++) {
    const f = { memoizedProps: {} };
    link(parent, [f]);
    parent = f;
  }
  const title = { memoizedProps: { title: 'Chat name' } };
  link(parent, [title]);
  return { querySelector: () => ({ __reactFiber$test: title }) };
}

test('bridge: a sidebar row maps to its thread id only when the key above agrees, within the bound', () => {
  const walk = () => ({ memo: new Map(), steps: 0 });
  assert.equal(threadIdOfRow(sidebarRow('thread-test-1'), walk()), 'thread-test-1');
  assert.equal(threadIdOfRow(sidebarRow('thread-test-1', { depth: 5 }), walk()), 'thread-test-1');
  assert.equal(threadIdOfRow(sidebarRow('thread-test-1', { key: 'thread-row-other' }), walk()), '');
  assert.equal(threadIdOfRow(sidebarRow('thread-test-1', { depth: 60 }), walk()), '');
  assert.equal(threadIdOfRow({ querySelector: () => null }, walk()), '');
});
