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
// Settings with these trusted chats, stored as this version stores them
const withChats = (list, patch = {}) => settingsWith({ ...AAM.splitChats(list), ...patch });
const site = (chats, extra = {}) => ({ id: 'site-test-1', host: 'example.com', sub: false, on: true, chats, ...extra });
const action = (chats, extra = {}) => ({ id: 'action-test-1', title: 'Send email', policy: 'connector.gmail.users.messages.send', on: true, chats, ...extra });
const chat = (name, ids = {}, on = true) => ({ id: `chat-test-${name || 'unnamed'}${ids.threadId ? `-${ids.threadId}` : ''}${ids.scheduleId ? `-${ids.scheduleId}` : ''}`, name, ...ids, on });
const hostCard = (chatName, ids = {}) => ({ host: 'example.com', chat: chatName, title: 'Access example.com', action: '', policy: '', site: '', ...ids });
const actionCard = (chatName, ids = {}) => ({ host: '', chat: chatName, title: 'Send email', action: 'Send email', policy: 'connector.gmail.users.messages.send', site: '', ...ids });
const plainCopy = value => JSON.parse(JSON.stringify(value));
const noIds = list => list.map(({ id, ...rest }) => rest);

const T1 = { threadId: 'thread-test-1' };
const T2 = { threadId: 'thread-test-2' };
const S1 = { scheduleId: 'schedule-test-1' };
const S2 = { scheduleId: 'schedule-test-2' };
const NO_IDS = { threadId: '', scheduleId: '' };

// What main would have stored for the same clicks: chats trusted with ids become main's name entries, unnamed ones drop
function strip(settings) {
  const { chatSources = [], ...rest } = settings;
  return { ...rest, chats: [...settings.chats, ...chatSources.filter(c => c.name).map(({ threadId, scheduleId, ...c }) => c)] };
}

test('a chat trusted with ids matches the exact pair under any name, and by name only a card without ids', () => {
  const settings = withChats([chat('Research', T1)]);
  const yes = [hostCard('Research', T1), hostCard('Renamed', T1), hostCard('Research'), actionCard('Renamed', T1), hostCard('', T1)];
  const no = [hostCard('Research', T2), hostCard('Research', { ...T1, ...S1 }), hostCard('Research', S1), hostCard('', S1), hostCard('')];
  for (const card of yes) assert.equal(AAM.isTrusted(settings, card), true, JSON.stringify(card));
  for (const card of no) assert.equal(AAM.isTrusted(settings, card), false, JSON.stringify(card));
});

test('site and action chat limits are main\'s names, whatever ids the card has', () => {
  const settings = settingsWith({ sites: [site(['Research'])], actions: [action(['Research'])] });
  for (const make of [hostCard, actionCard]) {
    assert.equal(AAM.isTrusted(settings, make('Research', T1)), true);
    assert.equal(AAM.isTrusted(settings, make('Renamed', T1)), false);
  }
  // A rule never stores ids: adding with ids is not even an option
  const [rule] = AAM.addSiteRule([], 'example.com', { chat: 'Research', ids: T1 });
  assert.deepEqual(Object.keys(rule), ['id', 'host', 'sub', 'chats', 'on']);
});

test('a thread id never matches a schedule id, and the other way round', () => {
  const asSchedule = { scheduleId: T1.threadId };
  assert.equal(AAM.isTrusted(withChats([chat('', T1)]), hostCard('', asSchedule)), false);
  assert.equal(AAM.isTrusted(withChats([chat('', asSchedule)]), hostCard('', T1)), false);
});

// Round 2 item 4
test('one invalid id voids the card\'s whole pair; the card is matched by name, as on main', () => {
  assert.deepEqual(AAM.cardPair({ ...T1, scheduleId: 'bad id' }), NO_IDS);
  assert.deepEqual(AAM.cardPair({ threadId: 'bad id', ...S1 }), NO_IDS);
  assert.deepEqual(AAM.cardPair({ ...T1, scheduleId: '' }), { ...T1, scheduleId: '' });
  const card = hostCard('Research', { ...T1, scheduleId: 'bad id' });
  assert.equal(AAM.isTrusted(withChats([chat('Old name', T1)]), card), false);
  assert.equal(AAM.cardKey(card), 'example.com|Research');
});

test('a stored entry with an invalid id never matches, not even by name', () => {
  for (const id of ['bad id', '', 42, null]) {
    const settings = withChats([chat('Research', { threadId: id })]);
    assert.equal(AAM.isTrusted(settings, hostCard('Research')), false, JSON.stringify(id));
    assert.equal(AAM.isTrusted(settings, hostCard('Research', T1)), false, JSON.stringify(id));
  }
  // An entry in chatSources without ids is not a name entry either
  assert.equal(AAM.isTrusted(settingsWith({ chatSources: [chat('Research')] }), hostCard('Research')), false);
});

test('a chat trusted from a card with ids stores its name and pair in chatSources; without ids it is main\'s entry', () => {
  const stored = AAM.splitChats(AAM.addChatRule(AAM.addChatRule([], 'Research', T1), 'Plain'));
  assert.deepEqual([noIds(stored.chats), noIds(stored.chatSources)], [[{ name: 'Plain', on: true }], [{ name: 'Research', ...T1, on: true }]]);
  // A card's pair as AAM.cardPair returns it, '' for a missing type
  assert.deepEqual(noIds(AAM.addChatRule([], 'Research', { ...T1, scheduleId: '' })), [{ name: 'Research', ...T1, on: true }]);
  // Ids that can't be read, or neither name nor ids, add nothing
  assert.deepEqual(AAM.addChatRule([], 'Research', { ...T1, scheduleId: 'bad id' }), []);
  assert.deepEqual(AAM.addChatRule([], '', NO_IDS), []);
});

test('without ids the chat list and every rule merge are main\'s', needsMain, () => {
  const chats = [chat('Research', {}, false), chat('Other')];
  for (const name of ['Research', 'Other', 'New']) assert.deepEqual(noIds(AAM.addChatRule(chats, name)), noIds(MAIN.addChatRule(chats, name)), name);
  const sites = [site(['Research'], { on: false }), site([], { id: 'site-test-2', host: 'other.example', on: false })];
  for (const [host, opts] of [['example.com', { chat: 'Ops' }], ['other.example', { chat: 'Ops' }], ['example.com', { chat: '' }], ['new.example', { chat: 'Ops', sub: true }]]) {
    assert.deepEqual(noIds(AAM.addSiteRule(sites, host, opts)), noIds(MAIN.addSiteRule(sites, host, opts)), host);
  }
  const actions = [action(['Research'], { on: false })];
  for (const opts of [{ chat: 'Ops', policy: 'connector.gmail.users.messages.send' }, { chat: '' }]) {
    assert.deepEqual(noIds(AAM.addActionRule(actions, 'Send email', opts)), noIds(MAIN.addActionRule(actions, 'Send email', opts)));
  }
});

// Round 2 item 2
test('trusting a renamed chat never turns its old name back on', () => {
  const chats = [chat('Old name', T1, false)];
  const renamed = AAM.addChatRule(chats, 'New name', T1);
  assert.deepEqual(noIds(renamed), [{ name: 'Old name', ...T1, on: false }, { name: 'New name', ...T1, on: true }]);
  const settings = withChats(renamed);
  assert.equal(AAM.isTrusted(settings, hostCard('Old name')), false);
  assert.equal(AAM.isTrusted(settings, hostCard('New name', T1)), true);
  // Without a name, and without ids, only an entry of the exact kind is touched
  assert.equal(AAM.addChatRule(chats, '', T1)[0].on, false);
  assert.deepEqual(noIds(AAM.addChatRule(chats, 'Old name')), [{ name: 'Old name', ...T1, on: false }, { name: 'Old name', on: true }]);
  // The exact entry is turned back on
  assert.deepEqual(noIds(AAM.addChatRule(chats, 'Old name', T1)), [{ name: 'Old name', ...T1, on: true }]);
});

// Round 2 item 3, round 3 item 5
test('a chat known by id, or seen on a card whose ids could not be read, is never offered by its plain name', () => {
  const context = {
    names: ['Alpha', 'Beta', 'Zeta'],
    museChatNames: { [T1.threadId]: 'Alpha', [T2.threadId]: 'Gamma' },
    chats: AAM.trustedChats(withChats([chat('Alpha', T1)])),
    items: [hostCard('Delta', S1), hostCard('Delta'), hostCard('Epsilon'), { ...hostCard('Zeta'), badIds: true }],
  };
  const choices = AAM.chatChoices(context);
  assert.deepEqual(choices, [{ name: '', ...T2 }, { name: 'Beta' }, { name: 'Alpha', ...T1 }, { name: 'Delta', ...S1 }, { name: 'Epsilon' }]);
  assert.deepEqual(choices.filter(c => !AAM.listsChat(context.chats, c)), [{ name: '', ...T2 }, { name: 'Beta' }, { name: 'Delta', ...S1 }, { name: 'Epsilon' }]);
});

// Round 3 item 6
test('chats that would share a label get a short id suffix', () => {
  const T3 = { threadId: 'thread-test-3' };
  const list = [chat('Alpha', { ...T1, ...S1 }), chat('Alpha', { ...T1, ...S2 }), chat('Alpha', { ...T3, ...S1 }), chat('Alpha'), chat('Beta', T2), chat('', T1), chat('', S2)];
  const label = c => c.name || 'Unknown chat';
  const labels = AAM.chatLabels(list, label);
  assert.deepEqual(labels, ['Alpha · test-1/test-1', 'Alpha · test-1/test-2', 'Alpha · test-3/test-1', 'Alpha', 'Beta', 'Unknown chat · test-1', 'Unknown chat · test-2']);
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(AAM.chatLabels(list, label).every(l => !l.includes('thread-test') && !l.includes('schedule-test')));
});

// popup.js without its startup, with storage writes recorded
function loadPopup(settings) {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const source = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8').replace(/\n\(async \(\) => \{[\s\S]*$/, '\n');
  const writes = [];
  const set = async patch => { writes.push(patch); };
  const chrome = { storage: { sync: { set }, local: { set } } };
  const ctx = vm.createContext({ AAM, I18N: { t: k => k }, chrome, document: { querySelector: () => null } });
  vm.runInContext(`${source}\nsettings = ${JSON.stringify(settings)};\nrender = () => {};`, ctx);
  return { ctx, writes };
}

// Round 3 item 5
test('popup: a named card whose ids could not be read is never offered trust by its name', async () => {
  const card = { ...hostCard('Alpha'), key: 'example.com|Alpha', badIds: true };
  const { ctx, writes } = loadPopup(settingsWith({}));
  assert.deepEqual([...ctx.scopeOptions(card)], ['site', 'once']);
  assert.deepEqual([...ctx.scopeOptions({ ...actionCard('Alpha'), badIds: true })], ['action', 'once']);
  for (const scope of ['chat', 'siteChat']) await ctx.allowPending(card, scope);
  assert.deepEqual(writes, []);
  // The same card with readable ids, and one without any, are offered as before
  assert.deepEqual([...ctx.scopeOptions(hostCard('Alpha', T1))], ['site', 'siteChat', 'chat', 'once']);
  assert.deepEqual([...ctx.scopeOptions(hostCard('', T1))], ['site', 'chat', 'once']);
  assert.deepEqual([...ctx.scopeOptions(hostCard('Alpha'))], ['site', 'siteChat', 'chat', 'once']);
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

// Settings as main stores them: this version only adds chatSources, after main's keys
const mainKeys = ({ chatSources, ...rest }) => rest;

test('sites, actions and chats import byte-identically to main, whatever they hold', needsMain, () => {
  const odd = {
    ...OLD_EXPORT,
    sites: [...OLD_EXPORT.sites, site(['', 'Research', { name: 'x', ...T1 }], { id: 'site-test-4', sources: [{ name: 'Research', ...T1 }] }), { id: 's', host: 'no-chats.example', chats: { name: 'x' } }],
    chats: [...OLD_EXPORT.chats, { id: 'c', name: 'x', on: 'yes' }, chat('Research', T1), chat('', S1), { id: 'chat-test-no-id', name: 'No id' }, null],
    actions: [...OLD_EXPORT.actions, action([''], { id: 'action-test-3' })],
  };
  for (const raw of [OLD_EXPORT, odd]) {
    assert.equal(JSON.stringify(mainKeys(AAM.sanitizeSettings(raw))), JSON.stringify(MAIN.sanitizeSettings(raw)));
    assert.deepEqual(AAM.sanitizeSettings(raw).chatSources, []);
  }
});

test('chatSources imports with its pairs; entries without a readable pair are dropped', () => {
  const bad = ['', 'has space', 'x'.repeat(129), 'quote"', 'ünïcode', 42, { id: 1 }, null];
  const raw = {
    chatSources: [
      { ...chat('Research', T1), extra: 'dropped' }, chat('', S1), chat('No ids'), 'Research', null, { id: 'x', ...T2, on: true },
      ...bad.flatMap(id => [chat('Bad', { threadId: id }), chat('Bad', { ...T1, scheduleId: id })]),
    ],
  };
  assert.deepEqual(AAM.sanitizeSettings(raw).chatSources, [
    { id: 'chat-test-Research-thread-test-1', name: 'Research', ...T1, on: true },
    { id: 'chat-test-unnamed-schedule-test-1', name: '', ...S1, on: true },
  ]);
  assert.deepEqual(AAM.sanitizeSettings({ chatSources: chat('Research', T1) }).chatSources, []);
});

test('export then import gives the same settings', () => {
  const settings = AAM.sanitizeSettings({ ...OLD_EXPORT, chatSources: [chat('Ops', { ...T1, ...S1 }), chat('', S1, false)] });
  const exported = plainCopy({ app: 'auto-approve-for-muse', version: 'test', settings });
  assert.deepEqual(AAM.sanitizeSettings(exported.settings), settings);
});

// Settings a user can reach on this version, for the old-reader, old-writer and parity checks
function newSettings() {
  let chats = AAM.addChatRule([], 'Research', T1);
  chats = AAM.addChatRule(chats, '', S1);
  chats = AAM.addChatRule(chats, 'Plain');
  chats = AAM.addChatRule(chats, 'Ops', { ...T2, ...S1 });
  chats = [...chats, chat('Off', T2, false), chat('Off', {}, false)];
  const sites = [site(['Research']), site([], { id: 'site-test-2', host: 'any.example' })];
  const actions = [action(['Ops'])];
  return plainCopy(AAM.sanitizeSettings(withChats(chats, { sites, actions })));
}

function everyCard() {
  const names = ['Research', 'Ops', 'Plain', 'Off', 'Other', ''];
  const pairs = [{}, T1, T2, S1, { ...T1, ...S1 }, { ...T2, ...S1 }, { threadId: 'thread-test-3' }];
  const cards = [];
  for (const name of names) {
    for (const ids of pairs) cards.push(hostCard(name, ids), { ...hostCard(name, ids), host: 'any.example' }, { ...hostCard(name, ids), host: 'none.example' }, actionCard(name, ids));
  }
  return cards;
}

// An on entry in chatSources with the card's exact pair
function pairMatch(settings, card) {
  const ids = AAM.cardPair(card);
  return AAM.hasIds(ids) && settings.chatSources.some(c => c.on && (c.threadId || '') === ids.threadId && (c.scheduleId || '') === ids.scheduleId);
}

// Round 2 item 5: an old version reads exports and synced settings with its own sanitizeSettings and isTrusted
test('an old version reading new settings trusts no more than main with the same rules', needsMain, () => {
  const settings = newSettings();
  assert.ok(settings.chatSources.some(c => c.threadId));
  // The lists main reads hold only what main stores
  assert.ok(settings.chats.every(c => JSON.stringify(Object.keys(c)) === '["id","name","on"]' && c.name));
  const oldImport = MAIN.sanitizeSettings(plainCopy(settings));
  const stripped = strip(settings);
  let narrower = 0;
  for (const card of everyCard()) {
    const imported = MAIN.isTrusted(oldImport, card);
    assert.equal(MAIN.isTrusted(settings, card), imported, `sync ${JSON.stringify(card)}`);
    assert.ok(!imported || MAIN.isTrusted(stripped, card), `import ${JSON.stringify(card)}`);
    if (MAIN.isTrusted(stripped, card) && !imported) narrower++;
  }
  // Chats trusted with ids are not trusted at all by an old version
  assert.ok(narrower > 0);
});

// What 7889da9's options.js and popup.js write to chrome.storage.sync for the chat list: each is a patch of main's keys,
// so chatSources is never written, and every entry they write is built by main's shared.js or main's own map and filter
function oldWrites(settings) {
  const first = settings.chats[0];
  return [
    { chats: settings.chats.map(c => (c.id === first.id ? { ...c, on: !c.on } : c)) },
    { chats: settings.chats.filter(c => c.id !== first.id) },
    ...['Research', 'Off', 'Ops', 'Plain', 'New'].map(name => ({ chats: MAIN.addChatRule(settings.chats, name) })),
    { sites: MAIN.addSiteRule(settings.sites, 'example.com', { chat: 'Ops' }) },
    { actions: MAIN.addActionRule(settings.actions, 'Send email', { chat: '', policy: 'connector.gmail.users.messages.send' }) },
    MAIN.sanitizeSettings(plainCopy(settings)),
    MAIN.sanitizeSettings({ ...OLD_EXPORT, chats: [{ id: 'chat-test-import', name: 'Research', on: true }] }),
  ];
}

// Round 3: an old writer on the same synced settings never makes this version trust more than main on the stored names
test('an old version writing back new settings never widens what this version trusts', needsMain, () => {
  const settings = newSettings();
  let checked = 0;
  for (const patch of oldWrites(settings)) {
    const after = { ...settings, ...plainCopy(patch) };
    assert.deepEqual(after.chatSources, settings.chatSources);
    const stripped = strip(after);
    for (const card of everyCard()) {
      if (AAM.isTrusted(after, card)) assert.ok(MAIN.isTrusted(stripped, card) || pairMatch(after, card), JSON.stringify([patch, card]));
      checked++;
    }
  }
  assert.ok(checked > 1000);
});

test('this version trusts more than main only on an exact pair match', needsMain, () => {
  const settings = newSettings();
  const stripped = strip(settings);
  let widened = 0;
  for (const card of everyCard()) {
    if (!AAM.isTrusted(settings, card) || MAIN.isTrusted(stripped, card)) continue;
    assert.ok(pairMatch(settings, card), JSON.stringify(card));
    widened++;
  }
  assert.ok(widened > 0);
});

// For cards without ids every trust decision is main's on the names main would have stored
test('cards without ids are trusted exactly as on main', needsMain, () => {
  const entries = ['Research', 'Other', ''];
  const settingsList = [newSettings()];
  for (const name of entries) {
    for (const on of [true, false]) {
      settingsList.push(settingsWith({ chats: [{ id: 'c', name, on }] }));
      settingsList.push(settingsWith({ chatSources: [{ id: 'c', name, ...T1, on }] }));
      settingsList.push(settingsWith({ sites: [site([name].filter(Boolean), { on })] }));
      settingsList.push(settingsWith({ sites: [site([name])] }));
      settingsList.push(settingsWith({ actions: [action([name].filter(Boolean), { on })] }));
      settingsList.push(settingsWith({ actions: [action([], { policy: undefined }), action([name], { title: 'Other title' })] }));
    }
  }
  settingsList.push(settingsWith({ sites: [site([], { host: 'sub.example.com' }), site([], { host: 'example.com', sub: true })] }));
  const cards = entries.flatMap(name => [hostCard(name), actionCard(name), { ...hostCard(name), host: 'a.example.com' }, { ...actionCard(name), policy: '' }, { ...hostCard(name), badIds: true }]);
  let checked = 0;
  for (const settings of settingsList) {
    for (const card of cards) {
      assert.equal(AAM.isTrusted(settings, card), MAIN.isTrusted(strip(settings), card), JSON.stringify([settings.chats, settings.chatSources, settings.sites, settings.actions, card]));
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
