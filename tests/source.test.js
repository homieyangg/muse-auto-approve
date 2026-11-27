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
const chat = (name, ids = {}, on = true) => ({ id: `chat-test-${name || 'unnamed'}`, name, ...ids, on });
const bound = (name, ids) => ({ name, ...ids });
const hostCard = (chatName, ids = {}) => ({ host: 'example.com', chat: chatName, title: 'Access example.com', action: '', policy: '', site: '', ...ids });
const actionCard = (chatName, ids = {}) => ({ host: '', chat: chatName, title: 'Send email', action: 'Send email', policy: 'connector.gmail.users.messages.send', site: '', ...ids });
const plainCopy = value => JSON.parse(JSON.stringify(value));

const T1 = { threadId: 'thread-test-1' };
const T2 = { threadId: 'thread-test-2' };
const S1 = { scheduleId: 'schedule-test-1' };
const NO_IDS = { threadId: '', scheduleId: '' };

// What main would have stored for the same clicks: names only, no pairs, no entries without a name
function strip(settings) {
  const rule = ({ sources, ...rest }) => rest;
  const { chatSources = [], ...rest } = settings;
  return {
    ...rest,
    sites: settings.sites.map(rule),
    actions: settings.actions.map(rule),
    chats: [...settings.chats, ...chatSources.filter(c => c.name).map(({ threadId, scheduleId, ...c }) => c)],
  };
}

// A site limit and an action limit with the same chats and pairs
function limited(chats, sources) {
  return {
    site: [settingsWith({ sites: [site(chats, { sources })] }), hostCard],
    action: [settingsWith({ actions: [action(chats, { sources })] }), actionCard],
  };
}

function trustedBy(rules, chatName, ids) {
  return Object.fromEntries(Object.entries(rules).map(([where, [settings, make]]) => [where, AAM.isTrusted(settings, make(chatName, ids))]));
}
const both = value => ({ site: value, action: value });

test('a chat entry with ids matches the exact pair under any name, and by name only for a card without ids', () => {
  const settings = withChats([chat('Research', T1)]);
  const yes = [hostCard('Research', T1), hostCard('Renamed', T1), hostCard('Research'), actionCard('Renamed', T1)];
  const no = [hostCard('Research', T2), hostCard('Research', { ...T1, ...S1 }), hostCard('Research', S1), hostCard('', S1), hostCard('')];
  for (const card of yes) assert.equal(AAM.isTrusted(settings, card), true, JSON.stringify(card));
  for (const card of no) assert.equal(AAM.isTrusted(settings, card), false, JSON.stringify(card));
});

test('a rule limit keeps names; a bound name matches a card with ids only on its pairs', () => {
  const rules = limited(['Research'], [bound('Research', T1)]);
  assert.deepEqual(trustedBy(rules, 'Research', T1), both(true));
  assert.deepEqual(trustedBy(rules, 'Renamed', T1), both(true));
  assert.deepEqual(trustedBy(rules, 'Research'), both(true));
  assert.deepEqual(trustedBy(rules, 'Research', T2), both(false));
  assert.deepEqual(trustedBy(rules, 'Other', T2), both(false));
  assert.deepEqual(trustedBy(rules, 'Research', { ...T1, ...S1 }), both(false));
});

test('a name the limit holds without pairs matches as on main', () => {
  const rules = limited(['Research', 'Ops'], [bound('Ops', T1)]);
  assert.deepEqual(trustedBy(rules, 'Research', T2), both(true));
  assert.deepEqual(trustedBy(rules, 'Ops', T2), both(false));
  assert.deepEqual(trustedBy(rules, 'Ops', T1), both(true));
  assert.deepEqual(trustedBy(rules, 'Other', T2), both(false));
});

test('a thread id never matches a schedule id, and the other way round', () => {
  const asSchedule = { scheduleId: T1.threadId };
  assert.equal(AAM.isTrusted(withChats([chat('', T1)]), hostCard('', asSchedule)), false);
  assert.equal(AAM.isTrusted(withChats([chat('', asSchedule)]), hostCard('', T1)), false);
  assert.deepEqual(trustedBy(limited(['Research'], [bound('Research', T1)]), 'Research', asSchedule), both(false));
});

// Round 2 item 4
test('one invalid id voids the card\'s whole pair; the card is matched by name, as on main', () => {
  assert.deepEqual(AAM.cardPair({ ...T1, scheduleId: 'bad id' }), NO_IDS);
  assert.deepEqual(AAM.cardPair({ threadId: 'bad id', ...S1 }), NO_IDS);
  assert.deepEqual(AAM.cardPair({ ...T1, scheduleId: '' }), { ...T1, scheduleId: '' });
  const card = hostCard('Research', { ...T1, scheduleId: 'bad id' });
  assert.equal(AAM.isTrusted(withChats([chat('Old name', T1)]), card), false);
  assert.deepEqual(trustedBy(limited(['Old name'], [bound('Old name', T1)]), 'Research', { ...T1, scheduleId: 'bad id' }), both(false));
  assert.equal(AAM.cardKey(card), 'example.com|Research');
});

test('a stored entry with an invalid id never matches, not even by name', () => {
  for (const id of ['bad id', '', 42, null]) {
    const card = hostCard('Research', T1);
    assert.equal(AAM.isTrusted(withChats([chat('Research', { threadId: id })]), hostCard('Research')), false, JSON.stringify(id));
    assert.equal(AAM.isTrusted(withChats([chat('Research', { threadId: id })]), card), false, JSON.stringify(id));
    assert.deepEqual(trustedBy(limited(['Research'], [bound('Research', { threadId: id })]), 'Research'), both(false), JSON.stringify(id));
  }
});

test('rules from a card with ids store main\'s names plus the pair; without ids they are main\'s', () => {
  const sites = AAM.addSiteRule([], 'example.com', { chat: 'Research', ids: T1 });
  assert.deepEqual(sites.map(({ id, ...s }) => s), [{ host: 'example.com', sub: false, chats: ['Research'], sources: [bound('Research', T1)], on: true }]);
  const actions = AAM.addActionRule([], 'Send email', { chat: 'Research', ids: { ...T1, ...S1 }, policy: 'p' });
  assert.deepEqual(actions.map(({ id, ...a }) => a), [{ title: 'Send email', policy: 'p', chats: ['Research'], sources: [bound('Research', { ...T1, ...S1 })], on: true }]);
  const chats = AAM.addChatRule([], 'Research', T1);
  assert.deepEqual(chats.map(({ id, ...c }) => c), [{ name: 'Research', ...T1, on: true }]);
  // A card's pair as AAM.cardPair returns it, '' for a missing type
  assert.deepEqual(AAM.addChatRule([], 'Research', { ...T1, scheduleId: '' }).map(({ id, ...c }) => c), [{ name: 'Research', ...T1, on: true }]);
});

test('without ids every rule merge is main\'s', needsMain, () => {
  const strip = list => list.map(({ id, ...rest }) => rest);
  const sites = [site(['Research']), site([], { id: 'site-test-2', host: 'other.example', on: false }), site(['A', 'B'], { id: 'site-test-3', host: 'ab.example', on: false })];
  const actions = [action(['Research'], { on: false }), action([], { id: 'action-test-2', title: 'Upload', policy: 'up' })];
  const chats = [chat('Research', {}, false), chat('Other')];
  for (const [host, opts] of [['example.com', { chat: 'Ops' }], ['other.example', { chat: 'Ops' }], ['ab.example', { chat: '' }], ['new.example', { chat: 'Ops', sub: true }], ['ab.example', { chat: 'A' }]]) {
    assert.deepEqual(strip(AAM.addSiteRule(sites, host, opts)), strip(MAIN.addSiteRule(sites, host, opts)), host);
    assert.deepEqual(strip(AAM.addSiteRule(sites, host, { ...opts, ids: NO_IDS })), strip(MAIN.addSiteRule(sites, host, opts)), host);
  }
  for (const [title, opts] of [['Send email', { chat: 'Ops', policy: 'connector.gmail.users.messages.send' }], ['Upload', { chat: 'Ops', policy: 'up' }], ['New', { chat: '' }]]) {
    assert.deepEqual(strip(AAM.addActionRule(actions, title, opts)), strip(MAIN.addActionRule(actions, title, opts)), title);
  }
  for (const name of ['Research', 'Other', 'New']) assert.deepEqual(strip(AAM.addChatRule(chats, name)), strip(MAIN.addChatRule(chats, name)), name);
});

// Round 2 item 1
test('a chat limit from a card with ids but no name changes nothing', () => {
  const sites = [site([], { on: false }), site(['Research'], { id: 'site-test-2', host: 'other.example', on: false, sources: [bound('Research', T2)] })];
  const actions = [action([], { on: false }), action(['Research'], { id: 'action-test-2', title: 'Upload', policy: 'up', on: false, sources: [bound('Research', T2)] })];
  for (const host of ['example.com', 'other.example', 'new.example']) assert.equal(AAM.addSiteRule(sites, host, { chat: '', ids: T1 }), sites, host);
  for (const [title, policy] of [['Send email', 'connector.gmail.users.messages.send'], ['Upload', 'up'], ['New', 'new']]) {
    assert.equal(AAM.addActionRule(actions, title, { chat: '', ids: T1, policy }), actions, title);
  }
  // Ids that can't be read change nothing either
  assert.equal(AAM.addSiteRule(sites, 'example.com', { chat: 'Research', ids: { threadId: 'bad id' } }), sites);
  assert.equal(AAM.addChatRule([], 'Research', { ...T1, scheduleId: 'bad id' }).length, 0);
  assert.equal(AAM.addChatRule([], '', NO_IDS).length, 0);
});

test('a name the limit has without pairs is left as it is; a bound name gains the new pair and keeps its others', () => {
  const [plain] = AAM.addSiteRule([site(['Research'])], 'example.com', { chat: 'Research', ids: T1 });
  assert.deepEqual([plain.chats, plain.sources], [['Research'], undefined]);
  const [more] = AAM.addSiteRule([site(['Research'], { sources: [bound('Research', T2)] })], 'example.com', { chat: 'Research', ids: T1 });
  assert.deepEqual([more.chats, more.sources], [['Research'], [bound('Research', T2), bound('Research', T1)]]);
  const [same] = AAM.addActionRule([action(['Research'], { sources: [bound('Research', T1)] })], 'Send email', { chat: 'Research', ids: T1 });
  assert.deepEqual(same.sources, [bound('Research', T1)]);
  const [added] = AAM.addActionRule([action(['Ops'])], 'Send email', { chat: 'Research', ids: T1 });
  assert.deepEqual([added.chats, added.sources], [['Ops', 'Research'], [bound('Research', T1)]]);
  // Trusting from any chat clears the limit with its pairs
  const [any] = AAM.addSiteRule([site(['Research'], { sources: [bound('Research', T1)] })], 'example.com', { chat: '' });
  assert.deepEqual([any.chats, 'sources' in any], [[], false]);
});

// Round 2 item 2
test('trusting a renamed chat never turns its old name back on', () => {
  const chats = [chat('Old name', T1, false)];
  const renamed = AAM.addChatRule(chats, 'New name', T1);
  assert.deepEqual(renamed.map(({ id, ...c }) => c), [{ name: 'Old name', ...T1, on: false }, { name: 'New name', ...T1, on: true }]);
  const settings = withChats(renamed);
  assert.equal(AAM.isTrusted(settings, hostCard('Old name')), false);
  assert.equal(AAM.isTrusted(settings, hostCard('New name', T1)), true);
  // Without a name, and without ids, only an entry of the exact kind is touched
  assert.equal(AAM.addChatRule(chats, '', T1)[0].on, false);
  const byName = AAM.addChatRule(chats, 'Old name');
  assert.deepEqual(byName.map(({ id, ...c }) => c), [{ name: 'Old name', ...T1, on: false }, { name: 'Old name', on: true }]);
  // The exact entry is turned back on
  assert.deepEqual(AAM.addChatRule(chats, 'Old name', T1).map(({ id, ...c }) => c), [{ name: 'Old name', ...T1, on: true }]);
});

// Round 2 item 3
test('a chat known by id is never offered by its plain name', () => {
  const context = {
    museChats: ['Alpha', 'Beta'],
    museChatNames: { [T1.threadId]: 'Alpha', [T2.threadId]: 'Gamma' },
    settings: withChats([chat('Alpha', T1)]),
    items: [hostCard('Delta', S1), hostCard('Delta'), hostCard('Epsilon')],
  };
  const popup = AAM.chatChoices({ ...context, fromRules: false });
  assert.deepEqual(popup, [{ name: '', ...T2 }, { name: 'Beta' }, { name: 'Alpha', ...T1 }, { name: 'Delta', ...S1 }, { name: 'Epsilon' }]);
  assert.deepEqual(popup.filter(c => !AAM.listsChat(AAM.trustedChats(context.settings), c)), [{ name: '', ...T2 }, { name: 'Beta' }, { name: 'Delta', ...S1 }, { name: 'Epsilon' }]);
  // Rule limits keep names, so a chat known only by id is not offered there
  const named = AAM.chatChoices({ ...context, named: true });
  assert.deepEqual(named, [{ name: 'Beta' }, { name: 'Alpha', ...T1 }, { name: 'Delta', ...S1 }, { name: 'Epsilon' }]);
  // Names bound in a rule count as known by id
  const ruled = AAM.chatChoices({ settings: settingsWith({ sites: [site(['Zeta', 'Eta'], { sources: [bound('Zeta', T2)] })] }), museChats: ['Zeta'] });
  assert.deepEqual(ruled, [{ name: 'Zeta', ...T2 }, { name: 'Eta' }]);
  assert.deepEqual(AAM.chatChoices({ settings: settingsWith({ sites: [site(['Zeta'], { sources: [bound('Zeta', T2)] })] }), museChats: ['Zeta'], fromRules: false }), []);
});

test('the rule picker shows the limit\'s own choices, never a pair its plain name already covers', () => {
  const limit = { chats: ['Alpha', 'Beta'], sources: [bound('Beta', T2)] };
  const choices = [{ name: 'Alpha', ...T1 }, { name: 'Beta', ...T2 }, { name: 'Beta', ...S1 }, { name: 'Gamma' }, { name: '', ...T1 }];
  assert.deepEqual(AAM.limitChoices(limit), [{ name: 'Alpha' }, bound('Beta', T2)]);
  assert.deepEqual(AAM.limitOptions(limit, choices), [{ name: 'Alpha' }, bound('Beta', T2), { name: 'Beta', ...S1 }, { name: 'Gamma' }]);
});

test('ticking a pair limits the rule by it; unticking a name\'s last pair removes the name', () => {
  let limit = { chats: ['Beta'] };
  limit = AAM.toggleLimit(limit, { name: 'Alpha', ...T1 }, true);
  assert.deepEqual(limit, { chats: ['Beta', 'Alpha'], sources: [bound('Alpha', T1)] });
  const rule = AAM.setLimit(site(['x']), limit);
  assert.equal(AAM.isTrusted(settingsWith({ sites: [rule] }), hostCard('Alpha', T2)), false);
  assert.equal(AAM.isTrusted(settingsWith({ sites: [rule] }), hostCard('Renamed', T1)), true);
  // A plain tick on a bound name adds nothing that would match its other chats
  assert.deepEqual(AAM.toggleLimit(limit, { name: 'Alpha' }, true), limit);
  limit = AAM.toggleLimit(limit, { name: 'Alpha', ...S1 }, true);
  limit = AAM.toggleLimit(limit, { name: 'Alpha', ...T1 }, false);
  assert.deepEqual(limit, { chats: ['Beta', 'Alpha'], sources: [bound('Alpha', S1)] });
  limit = AAM.toggleLimit(limit, { name: 'Alpha', ...S1 }, false);
  assert.deepEqual(limit, { chats: ['Beta'], sources: [] });
  assert.equal('sources' in AAM.setLimit(site(['x'], { sources: [bound('x', T1)] }), limit), false);
  // A plain name's pair is not added on top of it: the name already covers it
  assert.deepEqual(AAM.toggleLimit({ chats: ['Beta'] }, { name: 'Beta', ...T1 }, true), { chats: ['Beta'], sources: [] });
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

test('an old export imports byte-identically to main', needsMain, () => {
  assert.equal(JSON.stringify(mainKeys(AAM.sanitizeSettings(OLD_EXPORT))), JSON.stringify(MAIN.sanitizeSettings(OLD_EXPORT)));
  assert.deepEqual(AAM.sanitizeSettings(OLD_EXPORT).chatSources, []);
  // Main's own edge cases, kept as they were; chats is main's sanitizer as is
  const odd = {
    sites: [site(['', 'Research']), { id: 's', host: 'no-chats.example' }],
    chats: [{ id: 'c', name: 'x', on: 'yes' }, chat('Research', T1), chat('', S1), { id: 'chat-test-no-id', name: 'No id' }, null],
  };
  assert.equal(JSON.stringify(mainKeys(AAM.sanitizeSettings(odd))), JSON.stringify(MAIN.sanitizeSettings(odd)));
  // Where main would widen a limit of only empty names to every chat, the rule is dropped instead
  assert.deepEqual(MAIN.sanitizeSettings({ actions: [action([''])] }).actions[0].chats, []);
  assert.deepEqual(AAM.sanitizeSettings({ actions: [action([''])] }).actions, []);
});

test('the new format imports with its pairs; pairs of names the limit lost are left out', () => {
  const raw = {
    sites: [site(['Research', 'Ops'], { sources: [{ ...bound('Ops', T1), extra: 'dropped' }, bound('Gone', T2)] })],
    chats: [chat('Plain')],
    chatSources: [{ ...chat('Research', T1), extra: 'dropped' }, chat('', S1), chat('No ids')],
    actions: [action(['Ops'], { sources: [bound('Ops', { ...T1, ...S1 })] }), action(['Ops'], { id: 'action-test-2', sources: [bound('Gone', T1)] })],
  };
  const clean = AAM.sanitizeSettings(raw);
  assert.deepEqual(clean.sites.map(s => [s.chats, s.sources]), [[['Research', 'Ops'], [bound('Ops', T1)]]]);
  assert.deepEqual(clean.chats, [{ id: 'chat-test-Plain', name: 'Plain', on: true }]);
  assert.deepEqual(clean.chatSources, [
    { id: 'chat-test-Research', name: 'Research', ...T1, on: true },
    { id: 'chat-test-unnamed', name: '', ...S1, on: true },
  ]);
  assert.deepEqual(clean.actions.map(a => [a.chats, a.sources]), [[['Ops'], [bound('Ops', { ...T1, ...S1 })]], [['Ops'], undefined]]);
});

test('an imported entry or pair with an invalid id is dropped, never downgraded to its name', () => {
  const bad = ['', 'has space', 'x'.repeat(129), 'quote"', 'ünïcode', 42, { id: 1 }, null];
  for (const id of bad) {
    const clean = AAM.sanitizeSettings({
      sites: [site(['Research'], { sources: [bound('Research', { threadId: id })] })],
      actions: [action(['Research'], { sources: [bound('Research', { ...T1, scheduleId: id })] })],
      chatSources: [chat('Research', { threadId: id }), chat('Research', { ...T1, scheduleId: id }), chat('Kept', T1)],
    });
    assert.deepEqual(clean.sites, [], JSON.stringify(id));
    assert.deepEqual(clean.actions, [], JSON.stringify(id));
    assert.deepEqual([clean.chats, clean.chatSources.map(c => c.name)], [[], ['Kept']], JSON.stringify(id));
  }
  // Pairs that are not a list of named pairs drop the rule too
  for (const sources of [{ name: 'Research', ...T1 }, 'Research', [bound('', T1)], [bound('Research', {})], [null]]) {
    assert.deepEqual(AAM.sanitizeSettings({ sites: [site(['Research'], { sources })] }).sites, [], JSON.stringify(sources));
  }
});

// Round 2 item 6
test('a chat limit that is not a list of names drops its rule, never widening it to every chat', () => {
  for (const chats of [{ name: 'Research' }, 'Research', null, 5, [{ name: 'Research', ...T1 }], [7, 'Research'], [null]]) {
    const clean = AAM.sanitizeSettings({ sites: [site(chats)], actions: [action(chats)] });
    assert.deepEqual([clean.sites, clean.actions], [[], []], JSON.stringify(chats));
  }
  // A rule that never had a limit is any chat, as on main
  assert.deepEqual(AAM.sanitizeSettings({ sites: [{ id: 's', host: 'example.com' }] }).sites[0].chats, []);
  // A chatSources that is not a list, or entries without a string name, are dropped
  assert.deepEqual(AAM.sanitizeSettings({ chatSources: chat('Research', T1) }).chatSources, []);
  assert.deepEqual(AAM.sanitizeSettings({ chatSources: [{ id: 'chat-test-x', ...T1, on: true }, 'Research', null] }).chatSources, []);
});

test('export then import gives the same settings', () => {
  const settings = AAM.sanitizeSettings({
    ...OLD_EXPORT,
    sites: [...OLD_EXPORT.sites, site(['Ops', 'Research'], { id: 'site-test-4', host: 'ops.example', sources: [bound('Ops', T1)] })],
    chatSources: [chat('Ops', { ...T1, ...S1 }), chat('', S1, false)],
    actions: [...OLD_EXPORT.actions, action(['Ops'], { id: 'action-test-3', sources: [bound('Ops', S1), bound('Ops', T2)] })],
  });
  const exported = plainCopy({ app: 'auto-approve-for-muse', version: 'test', settings });
  assert.deepEqual(AAM.sanitizeSettings(exported.settings), settings);
});

// Settings a user can reach on this version, for the old-reader and parity checks
function newSettings() {
  let sites = AAM.addSiteRule([], 'example.com', { chat: 'Research', ids: T1 });
  sites = AAM.addSiteRule(sites, 'ops.example', { chat: 'Ops' });
  sites = AAM.addSiteRule(sites, 'ops.example', { chat: 'Research', ids: T2 });
  sites = AAM.addSiteRule(sites, 'any.example', { chat: '' });
  let actions = AAM.addActionRule([], 'Send email', { chat: 'Research', ids: { ...T1, ...S1 }, policy: 'connector.gmail.users.messages.send' });
  actions = AAM.addActionRule(actions, 'Upload', { chat: 'Ops', ids: T2, policy: 'up' });
  let chats = AAM.addChatRule([], 'Research', T1);
  chats = AAM.addChatRule(chats, '', S1);
  chats = AAM.addChatRule(chats, 'Plain');
  chats = [...chats, chat('Off', T2, false)];
  const off = AAM.setLimit(site(['Ops'], { id: 'site-test-off', host: 'off.example', on: false }), AAM.toggleLimit({ chats: ['Ops'] }, { name: 'Research', ...S1 }, true));
  return plainCopy(AAM.sanitizeSettings(withChats(chats, { sites: [...sites, off], actions })));
}

function everyCard() {
  const names = ['Research', 'Ops', 'Plain', 'Off', 'Other', ''];
  const pairs = [{}, T1, T2, S1, { ...T1, ...S1 }, { threadId: 'thread-test-3' }];
  const hosts = ['example.com', 'ops.example', 'any.example', 'off.example', 'none.example'];
  const cards = [];
  for (const name of names) {
    for (const ids of pairs) {
      for (const host of hosts) cards.push({ ...hostCard(name, ids), host });
      cards.push(actionCard(name, ids), { ...actionCard(name, ids), title: 'Upload', action: 'Upload', policy: 'up' });
    }
  }
  return cards;
}

// An exact pair match: an entry or a bound name with the card's own pair, in a rule that covers the card
function pairMatch(settings, card) {
  const ids = AAM.cardPair(card);
  if (!AAM.hasIds(ids)) return false;
  const same = e => (e.threadId || '') === ids.threadId && (e.scheduleId || '') === ids.scheduleId;
  if (settings.chatSources.some(c => c.on && same(c))) return true;
  const rules = card.host ? settings.sites : settings.actions;
  return rules.some(r => r.on && (r.sources || []).some(same) && AAM.isTrusted({ ...settings, chats: [], sites: card.host ? [{ ...r, chats: [], sources: undefined }] : [], actions: card.host ? [] : [{ ...r, chats: [], sources: undefined }] }, card));
}

// Round 2 item 5: an old version reads exports and synced settings with its own sanitizeSettings and isTrusted
test('an old version reading new settings trusts no more than main with the same rules', needsMain, () => {
  const settings = newSettings();
  assert.ok(settings.sites.some(s => s.sources) && settings.actions.some(a => a.sources) && settings.chatSources.some(c => c.threadId));
  // The arrays main reads hold only what main stores
  assert.deepEqual(settings.chats.map(c => Object.keys(c)), [['id', 'name', 'on']]);
  assert.ok([...settings.sites, ...settings.actions].every(r => r.chats.every(c => typeof c === 'string' && c)));
  const oldImport = MAIN.sanitizeSettings(plainCopy(settings));
  const stripped = MAIN.sanitizeSettings(strip(settings));
  assert.deepEqual(oldImport.sites[0].chats, ['Research']);
  assert.deepEqual(oldImport.actions[0].chats, ['Research']);
  let checked = 0;
  let narrower = 0;
  for (const card of everyCard()) {
    const expected = MAIN.isTrusted(stripped, card);
    const imported = MAIN.isTrusted(oldImport, card);
    assert.equal(MAIN.isTrusted(settings, card), imported, `sync ${JSON.stringify(card)}`);
    assert.ok(!imported || expected, `import ${JSON.stringify(card)}`);
    if (expected && !imported) narrower++;
    checked++;
  }
  assert.ok(checked > 200);
  // Chats trusted with ids are not trusted at all by an old version
  assert.ok(narrower > 0);
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
  const cardChats = ['Research', 'Other', ''];
  const settingsList = [newSettings()];
  for (const name of entries) {
    for (const on of [true, false]) {
      settingsList.push(settingsWith({ chats: [{ id: 'c', name, on }] }));
      settingsList.push(settingsWith({ chatSources: [{ id: 'c', name, ...T1, on }] }));
      settingsList.push(settingsWith({ sites: [site([name].filter(Boolean), { on })] }));
      settingsList.push(settingsWith({ sites: [site([name])] }));
      settingsList.push(settingsWith({ sites: [site([name, 'Ops'].filter(Boolean), { on, sources: name ? [bound(name, T1)] : undefined })] }));
      settingsList.push(settingsWith({ actions: [action([name].filter(Boolean), { on })] }));
      settingsList.push(settingsWith({ actions: [action([], { policy: undefined }), action([name], { title: 'Other title' })] }));
    }
  }
  settingsList.push(settingsWith({ sites: [site([], { host: 'sub.example.com' }), site([], { host: 'example.com', sub: true })] }));
  const cards = cardChats.flatMap(name => [hostCard(name), actionCard(name), { ...hostCard(name), host: 'a.example.com' }, { ...actionCard(name), policy: '' }]);
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
