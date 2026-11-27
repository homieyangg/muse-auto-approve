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
  // The full pair must be equal: a partial pair never matches a fuller one, either way (review item 4)
  assert.deepEqual(trusted({ name: 'Research', ...T1, ...S1 }, 'Research', { ...T1, scheduleId: 'schedule-test-2' }), all(false));
  assert.deepEqual(trusted({ name: 'Research', ...T1, ...S1 }, 'Research', T1), all(false));
  assert.deepEqual(trusted({ name: 'Research', ...T1, ...S1 }, 'Research', S1), all(false));
  assert.deepEqual(trusted({ name: 'Research', ...T1 }, 'Research', { ...T1, ...S1 }), all(false));
  assert.deepEqual(trusted({ name: 'Research', ...T1, ...S1 }, 'Other', { ...T1, ...S1 }), all(true));
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

test('an entry with the same pair is kept as stored and not duplicated', () => {
  const sites = [site([{ name: 'Old name', ...T1 }])];
  assert.deepEqual(AAM.addSiteRule(sites, 'example.com', { chat: { name: 'New name', ...T1 } })[0].chats, [{ name: 'Old name', ...T1 }]);
  assert.deepEqual(AAM.addSiteRule([site([{ name: '', ...T1 }])], 'example.com', { chat: { name: 'Research', ...T1 } })[0].chats, [{ name: 'Research', ...T1 }]);
  // Another chat with the same name is added next to it
  assert.equal(AAM.addSiteRule(sites, 'example.com', { chat: { name: 'Old name', ...T2 } })[0].chats.length, 2);
  const chats = [chat('Old name', T1)];
  assert.deepEqual(AAM.addChatRule(chats, 'New name', T1), [{ id: 'chat-test-Old name', name: 'Old name', ...T1, on: true }]);
  assert.equal(AAM.addChatRule(chats, 'Old name', T2).length, 2);
});

// Review item 1: a rule takes the name read from the card, never the sidebar's, so a card without ids is matched as on main
test('a new rule stores the card\'s own name with its pair, and a plain name for a card without ids', () => {
  assert.deepEqual(AAM.ruleChatOf({ chat: 'Research', ...T1 }), { name: 'Research', ...T1 });
  assert.deepEqual(AAM.ruleChatOf({ chat: '', ...T1, ...S1 }), { name: '', ...T1, ...S1 });
  assert.equal(AAM.ruleChatOf({ chat: 'Research' }), 'Research');
  assert.equal(AAM.ruleChatOf({ chat: 'Research', threadId: 'bad id' }), 'Research');
  // Review item 6: nothing usable gives no chat
  assert.equal(AAM.ruleChatOf({ chat: '', threadId: 'bad id' }), null);
  // A rule saved from an unnamed card with ids never trusts a card without ids by a sidebar name
  const sites = AAM.addSiteRule([], 'example.com', { chat: AAM.ruleChatOf({ chat: '', ...T1 }) });
  assert.equal(AAM.isTrusted(settingsWith({ sites }), hostCard('Sidebar name')), false);
  assert.equal(AAM.isTrusted(settingsWith({ sites }), hostCard('', T1)), true);
});

// Review item 5: options lists key on the full pair and never offer a chat seen with ids as its plain name
test('pickable chats keep every pair apart and offer chats seen with ids only by their pair', () => {
  const settings = settingsWith({ sites: [site([{ name: 'Ops', ...T1, ...S1 }, 'Legacy'])] });
  const items = [{ chat: 'Research', ...T1 }, { chat: 'Research', ...T1, scheduleId: 'schedule-test-2' }, { chat: 'Plain' }, { chat: 'Research', ...T1 }];
  const picks = AAM.pickableChats({ museChats: ['Sidebar only'], museChatNames: { 'thread-test-1': 'Sidebar title', 'bad id': 'x' }, settings, items });
  assert.deepEqual(picks, [
    { name: 'Research', ...T1 },
    { name: 'Research', ...T1, scheduleId: 'schedule-test-2' },
    { name: 'Ops', ...T1, ...S1 },
    'Sidebar only',
    'Legacy',
    'Plain',
  ]);
  // A sidebar row known only by id is offered unnamed, by its thread
  assert.deepEqual(AAM.pickableChats({ museChatNames: { 'thread-test-3': 'Sidebar title' }, settings: settingsWith({}) }), [{ name: '', threadId: 'thread-test-3' }]);
});

// Review item 4: an id rule is never turned on or changed from a card without ids or with another pair
test('rules with ids are only turned on or changed by the exact pair', () => {
  const off = [chat('Research', { ...T1, ...S1, on: false })];
  const noIds = AAM.addChatRule(off, 'Research');
  assert.deepEqual(noIds[0], off[0]);
  assert.deepEqual(noIds.slice(1).map(({ id, ...c }) => c), [{ name: 'Research', on: true }]);
  const threadOnly = AAM.addChatRule(off, 'Research', T1);
  assert.deepEqual(threadOnly[0], off[0]);
  assert.deepEqual(threadOnly.slice(1).map(({ id, ...c }) => c), [{ name: 'Research', ...T1, on: true }]);
  // Neither added rule lets a schedule-only card through, and the disabled pair rule stays off
  for (const chats of [noIds, threadOnly]) assert.equal(AAM.isTrusted(settingsWith({ chats }), hostCard('Other', S1)), false);
  assert.equal(AAM.addChatRule(off, 'Research', { ...T1, ...S1 })[0].on, true);
  // Rule chat limits: a name-only add sits next to the id entry, which stays as it was
  const sites = [site([{ name: 'Research', ...T1 }])];
  assert.deepEqual(AAM.addSiteRule(sites, 'example.com', { chat: 'Research' })[0].chats, [{ name: 'Research', ...T1 }, 'Research']);
});

// Review item 6: a chat limit that can't be used adds nothing, never a rule for every chat
test('an unusable chat limit adds no rule', () => {
  for (const chat of [{ name: '', threadId: 'bad id' }, { name: '' }, { threadId: 'bad id' }, 42]) {
    assert.deepEqual(AAM.addSiteRule([], 'example.com', { chat }), [], JSON.stringify(chat));
    assert.deepEqual(AAM.addActionRule([], 'Send email', { chat }), [], JSON.stringify(chat));
    const existing = [site(['Research'])];
    assert.equal(AAM.addSiteRule(existing, 'example.com', { chat }), existing);
  }
  assert.deepEqual(AAM.addChatRule([], '', { threadId: 'bad id' }), []);
  assert.deepEqual(AAM.addChatRule([], ''), []);
});

// Review item 7: a stored entry with an id field that isn't a valid id is unreadable, never a name rule
test('an entry with an invalid id never matches, not even by name', () => {
  for (const id of ['bad id', '', 42, null]) {
    assert.deepEqual(trusted({ name: 'Research', threadId: id }, 'Research'), all(false), JSON.stringify(id));
    assert.deepEqual(trusted({ name: 'Research', threadId: id }, 'Research', T1), all(false), JSON.stringify(id));
  }
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
  const odd = { sites: [site(['', 'Research'])], chats: [{ id: 'c', name: 'x', on: 'yes' }] };
  assert.equal(JSON.stringify(AAM.sanitizeSettings(odd)), JSON.stringify(MAIN.sanitizeSettings(odd)));
  // Where main would widen a limit of only empty names to every chat, the rule is dropped instead
  assert.deepEqual(MAIN.sanitizeSettings({ actions: [action([''])] }).actions[0].chats, []);
  assert.deepEqual(AAM.sanitizeSettings({ actions: [action([''])] }).actions, []);
});

test('the new format imports with its ids', () => {
  const raw = {
    sites: [site(['Research', { name: 'Ops', ...T1 }, { name: '', ...S1 }, { name: 'Named only' }, { name: 'Pair', ...T1, ...S1 }])],
    chats: [chat('Research', T1), chat('', S1), chat('Plain')],
    actions: [action([{ name: 'Ops', ...T1, extra: 'dropped' }])],
  };
  const clean = AAM.sanitizeSettings(raw);
  assert.deepEqual(clean.sites[0].chats, ['Research', { name: 'Ops', ...T1 }, { name: '', ...S1 }, 'Named only', { name: 'Pair', ...T1, ...S1 }]);
  assert.deepEqual(clean.chats, [
    { id: 'chat-test-Research', name: 'Research', ...T1, on: true },
    { id: 'chat-test-unnamed', name: '', ...S1, on: true },
    { id: 'chat-test-Plain', name: 'Plain', on: true },
  ]);
  assert.deepEqual(clean.actions[0].chats, [{ name: 'Ops', ...T1 }]);
});

// Review item 7: an id that is present but invalid drops the entry (and a rule's whole chat limit), never leaves a name rule
test('an imported entry with an invalid id is dropped, not downgraded to its name', () => {
  const bad = ['', 'has space', 'x'.repeat(129), 'quote"', 'ünïcode', 42, { id: 1 }, null];
  for (const id of bad) {
    const clean = AAM.sanitizeSettings({
      sites: [site([{ name: 'Research', threadId: id }, 'Other'])],
      actions: [action([{ name: 'Research', ...T1, scheduleId: id }])],
      chats: [chat('Research', { threadId: id }), chat('Kept', T1)],
    });
    assert.deepEqual(clean.sites, [], JSON.stringify(id));
    assert.deepEqual(clean.actions, [], JSON.stringify(id));
    assert.deepEqual(clean.chats.map(c => c.name), ['Kept'], JSON.stringify(id));
  }
});

test('an unreadable chat limit entry drops its rule, never widening it to every chat', () => {
  const clean = AAM.sanitizeSettings({
    sites: [site([{ name: '' }]), site([7, 'Research'], { id: 'site-test-2', host: 'other.example' }), site(['Research'], { id: 'site-test-3', host: 'kept.example' })],
    chats: [chat(''), { id: 'chat-test-x', on: true }],
    actions: [action([null])],
  });
  assert.deepEqual(clean.sites.map(s => [s.host, s.chats]), [['kept.example', ['Research']]]);
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

test('a card key carries its full pair, so two chats of one name are different cards', () => {
  assert.equal(AAM.cardKey(hostCard('Research')), 'example.com|Research');
  assert.equal(AAM.cardKey(hostCard('Research', T1)), 'example.com|Research\nt:thread-test-1\ns:');
  assert.notEqual(AAM.cardKey(hostCard('Research', T1)), AAM.cardKey(hostCard('Research', T2)));
  assert.notEqual(AAM.cardKey(hostCard('Research', T1)), AAM.cardKey(hostCard('Research', { ...T1, ...S1 })));
});

// Review item 2: names are cleaned (no newline), so no name or title of a card without ids can rebuild a key with ids
test('a key with ids never equals the key of a card without ids', () => {
  const withIds = [hostCard('Research', T1), hostCard('Research', S1), hostCard('', { ...T1, ...S1 }), actionCard('A|t:x', T1)];
  const keys = new Set(withIds.map(AAM.cardKey));
  assert.equal(keys.size, withIds.length);
  const names = ['Research|t:thread-test-1', 'Research\nt:thread-test-1\ns:', 'Research nt:thread-test-1 s:', '|t:thread-test-1'];
  for (const name of names) {
    const card = AAM.parseCard(`Access example.com? This task is from ${name}.`);
    assert.ok(!keys.has(AAM.cardKey(card)), JSON.stringify(card.chat));
    assert.ok(!keys.has(AAM.cardKey({ ...card, ...actionCard(card.chat), action: `Send email\nt:thread-test-1`, policy: '' })));
  }
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
  // Review item 3: a button keyed to another approval makes the card anomalous, so no ids even beside a confirmed once
  const foreign = cardTree(appr);
  foreign.hosts[2].return.key = 'appr-test-other-cta-2-deny';
  const foreignButtons = foreign.hosts.map(h => fakeEl(h));
  const foreignEl = fakeEl(foreign.row, { buttons: foreignButtons });
  markItem(foreignEl, undefined, () => null);
  assert.equal(foreignEl.attrs['data-maa-state'], 'anomalous');
  assert.equal(foreignButtons[0].attrs['data-maa-option-kind'], 'allow_once');
  assert.equal(foreignEl.attrs['data-maa-thread-id'], undefined);
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
