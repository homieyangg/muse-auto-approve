'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AAM = require('../shared.js');
const AAT = require('../trust.js');

const POLICY = 'connector.example.post.create';
const UPLOAD = 'connector.browser.page.upload';

const settingsWith = (patch = {}) => ({ ...structuredClone(AAM.SETTINGS_DEFAULTS), ...structuredClone(patch) });
const site = (host, extra = {}) => ({ id: `s-${host}`, host, sub: false, chats: [], on: true, ...extra });
const action = (title, extra = {}) => ({ id: `a-${title}`, title, chats: [], on: true, ...extra });

// Log entries shaped like the ones content.js writes, with the card key built the same way
function siteEntry(host, chat, result = 'handled', extra = {}) {
  const e = { ts: Date.now(), host, chat, title: `Access ${host}`, action: '', site: '', result, ...extra };
  return { ...e, key: AAM.cardKey({ host, chat, policy: '', action: '', site: '' }) };
}
function actionEntry(title, chat, result = 'handled', extra = {}) {
  const e = { ts: Date.now(), host: '', chat, title, action: title, policy: POLICY, site: '', purchase: false, result, ...extra };
  return { ...e, key: AAM.cardKey(e) };
}
function uploadEntry(dest, chat, result = 'handled') {
  const e = { ts: Date.now(), host: '', chat, title: 'Upload this file', action: 'Upload this file', policy: UPLOAD, site: dest, purchase: false, result };
  return { ...e, key: AAM.cardKey(e) };
}

const offered = (settings, log) => log.map(e => AAT.offers(settings, log).has(e));

test('rule 1: waiting, answered in muse and skipped rows offer Trust', () => {
  const s = settingsWith();
  for (const result of ['pending', 'handled', 'skipped']) {
    assert.ok(AAT.wouldAsk(s, siteEntry('a.example', 'Chat A', result)), `site ${result}`);
    assert.ok(AAT.wouldAsk(s, actionEntry('Post to Example', 'Chat A', result)), `action ${result}`);
  }
});

test('rule 1: an allowed-once row offers Trust only while no rule covers it', () => {
  const entry = siteEntry('a.example', 'Chat A', 'allowed');
  assert.ok(AAT.wouldAsk(settingsWith(), entry));
  assert.ok(AAT.wouldAsk(settingsWith({ sites: [site('a.example', { chats: ['Chat B'] })] }), entry));
  assert.ok(AAT.wouldAsk(settingsWith({ sites: [site('a.example', { on: false })] }), entry));
});

test('rule 1: a row allowed by an existing rule offers nothing', () => {
  assert.ok(!AAT.wouldAsk(settingsWith({ sites: [site('a.example')] }), siteEntry('a.example', 'Chat A', 'allowed')));
  assert.ok(!AAT.wouldAsk(settingsWith({ sites: [site('a.example', { chats: ['Chat A'] })] }), siteEntry('a.example', 'Chat A', 'allowed')));
  assert.ok(!AAT.wouldAsk(settingsWith({ sites: [site('example.com', { sub: true })] }), siteEntry('www.example.com', 'Chat A')));
  assert.ok(!AAT.wouldAsk(settingsWith({ actions: [action('Other title', { policy: POLICY })] }), actionEntry('Post to Example', 'Chat A', 'allowed')));
  assert.ok(!AAT.wouldAsk(settingsWith({ chats: [{ id: 'c1', name: 'Chat A', on: true }] }), siteEntry('a.example', 'Chat A')));
});

test('rule 1: in Allow everything, site and upload rows offer nothing; action rows only while actions are excluded', () => {
  const all = settingsWith({ mode: 'all' });
  assert.ok(!AAT.wouldAsk(all, siteEntry('a.example', 'Chat A')));
  assert.ok(!AAT.wouldAsk(all, uploadEntry('upload.example', 'Chat A')));
  assert.ok(AAT.wouldAsk(all, actionEntry('Post to Example', 'Chat A')));
  assert.ok(!AAT.wouldAsk(settingsWith({ mode: 'all', includeActions: true }), actionEntry('Post to Example', 'Chat A')));
});

test('rule 1: purchase and checkout rows never offer Trust', () => {
  const s = settingsWith();
  assert.ok(!AAT.wouldAsk(s, actionEntry('Confirm', 'Chat A', 'handled', { purchase: true })));
  assert.ok(!AAT.wouldAsk(s, actionEntry('Check out on shop.example', 'Chat A', 'handled', { purchase: false })));
  assert.ok(!AAT.wouldAsk(s, siteEntry('shop.example', 'Chat A', 'handled', { purchase: true })));
});

test('rule 1: only the newest row of a card offers Trust', () => {
  const log = [
    siteEntry('a.example', 'Chat A', 'pending'),
    siteEntry('b.example', 'Chat A', 'handled'),
    siteEntry('a.example', 'Chat A', 'handled'),
    siteEntry('a.example', 'Chat B', 'skipped'),
    siteEntry('b.example', 'Chat A', 'allowed'),
  ];
  assert.deepEqual(offered(settingsWith(), log), [true, true, false, true, false]);
});

test('rule 1: the newest row decides even when it no longer asks', () => {
  const log = [siteEntry('a.example', 'Chat A', 'allowed'), siteEntry('a.example', 'Chat A', 'handled')];
  assert.deepEqual(offered(settingsWith({ sites: [site('a.example')] }), log), [false, false]);
});

test('rule 1: action rows written before the log stored purchase offer nothing; site rows are unaffected', () => {
  const s = settingsWith();
  const old = actionEntry('Post to Example', 'Chat A');
  delete old.purchase;
  delete old.policy;
  assert.ok(!AAT.wouldAsk(s, old));
  assert.ok(!AAT.wouldAsk(s, { ...old, purchase: null }));
  const oldUpload = uploadEntry('upload.example', 'Chat A');
  delete oldUpload.purchase;
  assert.ok(!AAT.wouldAsk(s, oldUpload));
  assert.ok(AAT.wouldAsk(s, siteEntry('a.example', 'Chat A')));
});

test('scopes: a known chat gets Any and Only; an unknown chat gets Any only', () => {
  assert.deepEqual(AAT.scopes(siteEntry('a.example', 'Chat A')), ['any', 'only']);
  const unknown = siteEntry('a.example', '');
  assert.deepEqual(AAT.scopes(unknown), ['any']);
  assert.equal(AAT.planTrust(settingsWith(), unknown, 'only'), null);
  assert.deepEqual(AAT.planTrust(settingsWith(), unknown, 'any').patch.sites.map(r => [r.host, r.sub, r.chats, r.on]), [['a.example', false, [], true]]);
});

test('merge: a new site rule is for the exact host, sub off, with the picked chat scope', () => {
  const entry = siteEntry('www.a.example', 'Chat A');
  const any = AAT.planTrust(settingsWith(), entry, 'any');
  assert.deepEqual(any.patch.sites.map(r => [r.host, r.sub, r.chats, r.on]), [['www.a.example', false, [], true]]);
  assert.equal(any.change.prev, null);
  const only = AAT.planTrust(settingsWith(), entry, 'only');
  assert.deepEqual(only.patch.sites.map(r => [r.host, r.sub, r.chats]), [['www.a.example', false, ['Chat A']]]);
});

test('merge: a new action rule carries the entry policy and site as stored', () => {
  const plan = AAT.planTrust(settingsWith(), actionEntry('Post to Example', 'Chat A'), 'only');
  const [rule] = plan.patch.actions;
  assert.deepEqual({ title: rule.title, policy: rule.policy, site: rule.site, sub: rule.sub, chats: rule.chats }, { title: 'Post to Example', policy: POLICY, site: undefined, sub: undefined, chats: ['Chat A'] });
  const upload = AAT.planTrust(settingsWith(), uploadEntry('upload.example', 'Chat A'), 'any').patch.actions[0];
  assert.deepEqual([upload.policy, upload.site, upload.sub, upload.chats], [UPLOAD, 'upload.example', undefined, []]);
});

test('merge: a disabled rule is turned on with exactly the picked scope, not its old one', () => {
  const sites = [site('a.example', { sub: true, chats: [], on: false })];
  const only = AAT.planTrust(settingsWith({ sites }), siteEntry('a.example', 'Chat A'), 'only');
  assert.deepEqual(only.patch.sites.map(r => [r.id, r.sub, r.chats, r.on]), [['s-a.example', false, ['Chat A'], true]]);
  assert.deepEqual(only.change.prev, sites[0]);
  const limited = [site('a.example', { chats: ['Chat B'], on: false })];
  const other = AAT.planTrust(settingsWith({ sites: limited }), siteEntry('a.example', 'Chat A'), 'only');
  assert.deepEqual(other.patch.sites[0].chats, ['Chat A']);
  const actions = [action('Post to Example', { policy: POLICY, site: 'upload.example', sub: true, on: false })];
  const upload = { ...uploadEntry('upload.example', 'Chat A'), action: 'Post to Example', policy: POLICY };
  const rule = AAT.planTrust(settingsWith({ actions }), upload, 'only').patch.actions[0];
  assert.deepEqual([rule.id, rule.sub, rule.chats, rule.on, rule.site], ['a-Post to Example', undefined, ['Chat A'], true, 'upload.example']);
});

test('merge: a rule limited to other chats gains this chat, or becomes any-chat when Any is picked', () => {
  const sites = [site('a.example', { chats: ['Chat B'] })];
  const entry = siteEntry('a.example', 'Chat A');
  assert.deepEqual(AAT.planTrust(settingsWith({ sites }), entry, 'only').patch.sites[0].chats, ['Chat B', 'Chat A']);
  assert.deepEqual(AAT.planTrust(settingsWith({ sites }), entry, 'any').patch.sites[0].chats, []);
  const actions = [action('Post to Example', { policy: POLICY, chats: ['Chat B'] })];
  assert.deepEqual(AAT.planTrust(settingsWith({ actions }), actionEntry('Post to Example', 'Chat A'), 'only').patch.actions[0].chats, ['Chat B', 'Chat A']);
});

test('merge: an any-chat rule is never narrowed or touched when Only is picked', () => {
  const sites = [site('a.example')];
  assert.equal(AAT.planTrust(settingsWith({ sites }), siteEntry('a.example', 'Chat A'), 'only'), null);
  assert.deepEqual(AAM.addSiteRule(sites, 'a.example', { chat: 'Chat A' })[0].chats, []);
  const disabled = [site('a.example', { on: false })];
  const plan = AAT.planTrust(settingsWith({ sites: disabled }), siteEntry('a.example', 'Chat A'), 'only');
  assert.deepEqual(plan.patch.sites[0].chats, ['Chat A']);
});

test('never wider: a subdomain rule limited to other chats is not merged, so the row offers nothing', () => {
  const sites = [site('a.example', { sub: true, chats: ['Chat B'] })];
  const entry = siteEntry('a.example', 'Chat A');
  const s = settingsWith({ sites });
  assert.ok(AAT.wouldAsk(s, entry));
  assert.equal(AAT.planTrust(s, entry, 'any'), null);
  assert.equal(AAT.planTrust(s, entry, 'only'), null);
  assert.deepEqual(offered(s, [entry]), [false]);
  const actions = [action('Upload this file', { policy: UPLOAD, site: 'upload.example', sub: true, chats: ['Chat B'] })];
  assert.deepEqual(offered(settingsWith({ actions }), [uploadEntry('upload.example', 'Chat A')]), [false]);
  assert.deepEqual(offered(settingsWith({ sites: [site('a.example', { sub: true, chats: ['Chat B'], on: false })] }), [entry]), [true]);
});

// Never wider: after the click, every card the settings trust was either trusted before or is inside the picked scope
test('never wider than the picked scope, for every starting rule', () => {
  const hosts = ['a.example', 'www.a.example', 'sub.a.example', 'b.example'];
  const chats = ['Chat A', 'Chat B', ''];
  const siteStarts = [
    [], [site('a.example', { on: false })], [site('a.example', { on: false, sub: true })], [site('a.example', { chats: ['Chat B'] })],
    [site('a.example', { chats: ['Chat B'], on: false })], [site('a.example', { sub: true, chats: ['Chat B'] })], [site('www.a.example', { on: false, sub: true })],
  ];
  for (const start of siteStarts) {
    for (const scope of ['any', 'only']) {
      const before = settingsWith({ sites: start });
      const entry = siteEntry('a.example', 'Chat A');
      const plan = AAT.planTrust(before, entry, scope);
      if (!plan) continue;
      const after = { ...before, ...plan.patch };
      for (const host of hosts) {
        for (const chat of chats) {
          const card = { host, chat, action: '', policy: '', site: '' };
          const picked = AAM.hostMatches({ host: entry.host, sub: false }, host) && (scope === 'any' || chat === entry.chat);
          if (AAM.isTrusted(after, card)) assert.ok(AAM.isTrusted(before, card) || picked, `${JSON.stringify(start)} ${scope}: ${host} from "${chat}"`);
        }
      }
    }
  }
  const actionStarts = [
    [], [action('Post to Example', { policy: POLICY, on: false })], [action('Upload this file', { policy: UPLOAD, site: 'upload.example', sub: true, on: false })],
    [action('Post to Example', { policy: POLICY, chats: ['Chat B'] })], [action('Upload this file', { policy: UPLOAD, site: 'upload.example', chats: ['Chat B'], on: false })],
  ];
  const probes = ['upload.example', 'x.upload.example', 'other.example', ''];
  for (const start of actionStarts) {
    for (const entry of [actionEntry('Post to Example', 'Chat A'), uploadEntry('upload.example', 'Chat A')]) {
      for (const scope of ['any', 'only']) {
        const before = settingsWith({ actions: start });
        const plan = AAT.planTrust(before, entry, scope);
        if (!plan) continue;
        const after = { ...before, ...plan.patch };
        for (const dest of probes) {
          for (const chat of chats) {
            const card = { host: '', chat, action: entry.action, policy: entry.policy, site: entry.site ? dest : '' };
            const picked = (card.site || '') === entry.site && (scope === 'any' || chat === entry.chat);
            if (AAM.isTrusted(after, card)) assert.ok(AAM.isTrusted(before, card) || picked, `${JSON.stringify(start)} ${entry.action} ${scope}: ${dest} from "${chat}"`);
          }
        }
      }
    }
  }
});

test('undo removes a rule the click created', () => {
  const before = settingsWith({ sites: [site('b.example')] });
  const { patch, change } = AAT.planTrust(before, siteEntry('a.example', 'Chat A'), 'any');
  const undone = AAT.planUndo({ ...before, ...patch }, change);
  assert.deepEqual(undone.sites, before.sites);
});

test('undo puts back the earlier state of a merged rule', () => {
  const sites = [site('a.example', { sub: true, chats: ['Chat B'], on: false }), site('b.example')];
  const before = settingsWith({ sites });
  const { patch, change } = AAT.planTrust(before, siteEntry('a.example', 'Chat A'), 'only');
  assert.deepEqual(AAT.planUndo({ ...before, ...patch }, change).sites, sites);
  const actions = [action('Post to Example', { chats: ['Chat B'] })];
  const merged = AAT.planTrust(settingsWith({ actions }), actionEntry('Post to Example', 'Chat A'), 'only');
  assert.equal(merged.patch.actions[0].policy, POLICY);
  assert.deepEqual(AAT.planUndo(merged.patch, merged.change).actions, actions);
});

function fakeStorage(initial) {
  const data = structuredClone(initial);
  return {
    data,
    async get(defaults) { return structuredClone(Object.fromEntries(Object.keys(defaults).map(k => [k, k in data ? data[k] : defaults[k]]))); },
    async set(values) { Object.assign(data, structuredClone(values)); },
  };
}

test('undo keeps changes made elsewhere after the click', async () => {
  const storage = fakeStorage(settingsWith({ sites: [site('a.example', { chats: ['Chat B'] })] }));
  const created = await AAT.trust(storage, siteEntry('new.example', 'Chat A'), 'only');
  const merged = await AAT.trust(storage, siteEntry('a.example', 'Chat A'), 'only');
  storage.data.sites.push(site('c.example'));
  storage.data.sites.find(s => s.host === 'new.example').chats.push('Chat C');
  storage.data.mode = 'all';
  await AAT.undo(storage, merged);
  assert.deepEqual(storage.data.sites.map(s => [s.host, s.chats]), [['a.example', ['Chat B']], ['new.example', ['Chat A', 'Chat C']], ['c.example', []]]);
  assert.equal(storage.data.mode, 'all');
  await AAT.undo(storage, created);
  assert.deepEqual(storage.data.sites.map(s => s.host), ['a.example', 'c.example']);
});

test('undo leaves a rule deleted elsewhere deleted', async () => {
  const storage = fakeStorage(settingsWith({ sites: [site('a.example', { on: false })] }));
  const change = await AAT.trust(storage, siteEntry('a.example', 'Chat A'), 'any');
  storage.data.sites = [];
  await AAT.undo(storage, change);
  assert.deepEqual(storage.data.sites, []);
});

test('trust reads the settings fresh and does nothing when the card no longer asks', async () => {
  const storage = fakeStorage(settingsWith({ sites: [site('a.example')] }));
  assert.equal(await AAT.trust(storage, siteEntry('a.example', 'Chat A'), 'only'), null);
  assert.deepEqual(storage.data.sites, [site('a.example')]);
});
