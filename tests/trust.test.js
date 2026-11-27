'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AAM = require('../shared.js');
const AAT = require('../trust.js');

const POLICY = 'connector.example.post.create';
const UPLOAD = 'connector.browser.page.upload';
// No muse website policy type is known yet; the tests stand one in
const SITE = 'connector.example.site.open';
AAT.SITE_POLICIES.push(SITE);

const settingsWith = (patch = {}) => ({ ...structuredClone(AAM.SETTINGS_DEFAULTS), ...structuredClone(patch) });
const site = (host, extra = {}) => ({ id: `s-${host}`, host, sub: false, chats: [], on: true, ...extra });
const apply = (settings, plan) => ({ ...settings, ...plan.patch });

// Log entries shaped like the ones content.js writes, with the card key built the same way
function siteEntry(host, chat, result = 'handled', extra = {}) {
  const e = { ts: Date.now(), host, chat, title: `Access ${host}`, action: '', policy: SITE, approvalHost: host, mixed: false, site: '', result, ...extra };
  return { ...e, key: AAM.cardKey(e) };
}
function actionEntry(title, chat, result = 'handled', extra = {}) {
  const e = { ts: Date.now(), host: '', chat, title, action: title, policy: POLICY, site: '', purchase: false, result, ...extra };
  return { ...e, key: AAM.cardKey(e) };
}
function uploadEntry(dest, chat, result = 'handled') {
  const e = { ts: Date.now(), host: '', chat, title: 'Upload', action: 'Upload', policy: UPLOAD, site: dest, purchase: false, result };
  return { ...e, key: AAM.cardKey(e) };
}

const offered = (settings, log) => log.map(e => AAT.offers(settings, log).has(e));

const CHATS = ['Chat A', 'Chat B', 'Chat C', ''];
const SITE_PROBES = ['a.example', 'www.a.example', 'www.www.a.example', 'sub.a.example', 'wwwa.example', 'b.example']
  .flatMap(host => CHATS.map(chat => ({ id: `${host}|${chat}`, host, chat, action: '', policy: '', site: '' })));
const trustedProbes = settings => SITE_PROBES.filter(p => AAM.isTrusted(settings, p)).map(p => p.id);
const grown = (before, after) => {
  const old = new Set(trustedProbes(before));
  return trustedProbes(after).filter(id => !old.has(id));
};

test('rule 1: waiting, answered in muse and skipped website rows offer Trust', () => {
  for (const result of ['pending', 'handled', 'skipped']) {
    assert.deepEqual(offered(settingsWith(), [siteEntry('a.example', 'Chat A', result)]), [true], result);
  }
});

test('rule 1: an allowed-once row offers Trust only while no rule covers it', () => {
  const entry = siteEntry('a.example', 'Chat A', 'allowed');
  assert.deepEqual(offered(settingsWith(), [entry]), [true]);
  assert.deepEqual(offered(settingsWith({ sites: [site('a.example', { chats: ['Chat B'] })] }), [entry]), [true]);
  assert.deepEqual(offered(settingsWith({ sites: [site('a.example', { on: false })] }), [entry]), [true]);
});

test('rule 1: a row allowed by an existing rule offers nothing', () => {
  const entry = siteEntry('a.example', 'Chat A', 'allowed');
  assert.deepEqual(offered(settingsWith({ sites: [site('a.example')] }), [entry]), [false]);
  assert.deepEqual(offered(settingsWith({ sites: [site('a.example', { chats: ['Chat A'] })] }), [entry]), [false]);
  assert.deepEqual(offered(settingsWith({ sites: [site('example.com', { sub: true })] }), [siteEntry('www.example.com', 'Chat A')]), [false]);
  assert.deepEqual(offered(settingsWith({ chats: [{ id: 'c1', name: 'Chat A', on: true }] }), [entry]), [false]);
});

test('rule 1: in Allow everything, website rows offer nothing', () => {
  assert.deepEqual(offered(settingsWith({ mode: 'all' }), [siteEntry('a.example', 'Chat A')]), [false]);
  assert.deepEqual(offered(settingsWith({ mode: 'all', includeActions: true }), [siteEntry('a.example', 'Chat A')]), [false]);
});

test('rule 1: purchase rows never offer Trust', () => {
  assert.deepEqual(offered(settingsWith(), [siteEntry('shop.example', 'Chat A', 'handled', { purchase: true })]), [false]);
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
  const trusted = [siteEntry('a.example', 'Chat A', 'allowed'), siteEntry('a.example', 'Chat A', 'handled')];
  assert.deepEqual(offered(settingsWith({ sites: [site('a.example')] }), trusted), [false, false]);
});

test('website rows logged before the approval data was kept offer no Trust', () => {
  const old = siteEntry('a.example', 'Chat A');
  for (const field of ['policy', 'approvalHost', 'mixed', 'purchase']) delete old[field];
  assert.deepEqual(offered(settingsWith(), [old]), [false]);
  assert.equal(AAT.planTrust(settingsWith(), old, 'any'), null);
});

test('a website row offers Trust only with a website policy type that no scan contradicted', () => {
  for (const extra of [{ policy: '' }, { policy: UPLOAD }, { policy: POLICY }, { policy: 'connector.example.unknown' }, { mixed: true }]) {
    const entry = siteEntry('a.example', 'Chat A', 'handled', extra);
    assert.deepEqual(offered(settingsWith(), [entry]), [false], JSON.stringify(extra));
    assert.equal(AAT.planTrust(settingsWith(), entry, 'any'), null, JSON.stringify(extra));
  }
  assert.deepEqual(offered(settingsWith(), [siteEntry('a.example', 'Chat A')]), [true]);
});

test('action and upload rows never offer Trust and keep main\'s label', () => {
  const rows = [actionEntry('Post', 'Chat A'), actionEntry('Post', 'Chat B', 'pending'), uploadEntry('upload.example', 'Chat A'), uploadEntry('', 'Chat A')];
  for (const settings of [settingsWith(), settingsWith({ mode: 'all' }), settingsWith({ mode: 'all', includeActions: true })]) {
    assert.deepEqual(offered(settings, rows), [false, false, false, false]);
    for (const entry of rows) for (const scope of ['any', 'only']) assert.equal(AAT.planTrust(settings, entry, scope), null);
    const states = AAT.rowStates(settings, rows, rows);
    assert.deepEqual(rows.map(e => states.get(e)), rows.map(() => ({ state: '' })));
  }
  const t = (k, v) => `${k} ${v}`;
  assert.equal(AAT.rowLabel(uploadEntry('www.upload.example', 'Chat A'), t), AAM.cardLabel(uploadEntry('www.upload.example', 'Chat A'), t));
  assert.equal(AAT.rowLabel(actionEntry('Post', 'Chat A'), t), 'Post');
});

test('scopes: a known chat gets Any and Only; an unknown chat gets Any only', () => {
  assert.deepEqual(AAT.scopes(siteEntry('a.example', 'Chat A')), ['any', 'only']);
  const unknown = siteEntry('a.example', '');
  assert.deepEqual(AAT.scopes(unknown), ['any']);
  assert.equal(AAT.planTrust(settingsWith(), unknown, 'only'), null);
  const plan = AAT.planTrust(settingsWith(), unknown, 'any');
  assert.deepEqual(grown(settingsWith(), apply(settingsWith(), plan)),
    ['a.example|Chat A', 'a.example|Chat B', 'a.example|Chat C', 'a.example|', 'www.a.example|Chat A', 'www.a.example|Chat B', 'www.a.example|Chat C', 'www.a.example|']);
});

test('"Only Chat A" on www.a.example is shown as a.example and trusts exactly a.example and www.a.example in Chat A', () => {
  const entry = siteEntry('www.a.example', 'Chat A');
  assert.equal(AAT.rowLabel(entry, k => k), 'a.example');
  const plan = AAT.planTrust(settingsWith(), entry, 'only');
  assert.deepEqual(plan.patch.sites.map(r => [r.host, r.sub, r.chats, r.on]), [['www.a.example', false, ['Chat A'], true]]);
  assert.deepEqual(grown(settingsWith(), apply(settingsWith(), plan)), ['a.example|Chat A', 'www.a.example|Chat A']);
});

// The host is stored as normalizeHost gives it and the matcher strips one www, so a rule covers its own card and the hosts
// normalizeHost-equivalent to it: a.example and www.a.example are one site, www.www.a.example is only itself
test('a double-www host is stored as is and covers only itself', () => {
  const covers = { 'a.example': ['a.example', 'www.a.example'], 'www.a.example': ['a.example', 'www.a.example'], 'www.www.a.example': ['www.www.a.example'] };
  for (const [raw, hosts] of Object.entries(covers)) {
    const entry = siteEntry(raw, 'Chat A');
    const plan = AAT.planTrust(settingsWith(), entry, 'only');
    assert.equal(plan.patch.sites[0].host, raw);
    const after = apply(settingsWith(), plan);
    assert.ok(AAM.isTrusted(after, entry), raw);
    assert.deepEqual(grown(settingsWith(), after), hosts.map(h => `${h}|Chat A`), raw);
  }
  assert.equal(AAT.rowLabel(siteEntry('www.www.a.example', 'Chat A'), k => k), 'www.www.a.example');
});

test('an older purchase row of the same card never shows Trusted or Undo', () => {
  const newest = siteEntry('a.example', 'Chat A');
  const purchase = siteEntry('a.example', 'Chat A', 'handled', { purchase: true, ts: 0 });
  assert.equal(newest.key, purchase.key);
  const log = [newest, purchase];
  const plan = AAT.planTrust(settingsWith(), newest, 'only');
  const states = AAT.rowStates(apply(settingsWith(), plan), log, log, { last: plan.change });
  assert.deepEqual(log.map(e => states.get(e)), [{ state: 'trusted', undo: true }, { state: '' }]);
});

test('a disabled rule with another scope is left alone and a new rule is appended', () => {
  const sites = [site('a.example', { sub: true, on: false }), site('a.example', { id: 's-2', chats: ['Chat B'], on: false })];
  const plan = AAT.planTrust(settingsWith({ sites }), siteEntry('a.example', 'Chat A'), 'only');
  assert.deepEqual(plan.patch.sites.slice(0, 2), sites);
  assert.deepEqual(plan.patch.sites.slice(2).map(r => [r.host, r.sub, r.chats]), [['a.example', false, ['Chat A']]]);
});

test('merge: a disabled rule whose host, sub and chats are exactly the pick is turned back on', () => {
  const sites = [site('www.a.example', { chats: ['Chat A'], on: false })];
  const plan = AAT.planTrust(settingsWith({ sites }), siteEntry('a.example', 'Chat A'), 'only');
  assert.deepEqual(plan.patch.sites, [{ ...sites[0], on: true }]);
  assert.deepEqual(plan.change.prev, sites[0]);
});

test('merge: "only" adds the chat to an exact rule limited to other chats; "any" appends an any-chat rule', () => {
  const sites = [site('a.example', { chats: ['Chat B'] })];
  const entry = siteEntry('a.example', 'Chat A');
  assert.deepEqual(AAT.planTrust(settingsWith({ sites }), entry, 'only').patch.sites, [{ ...sites[0], chats: ['Chat B', 'Chat A'] }]);
  const any = AAT.planTrust(settingsWith({ sites }), entry, 'any').patch.sites;
  assert.deepEqual(any[0], sites[0]);
  assert.deepEqual(any.slice(1).map(r => [r.host, r.chats]), [['a.example', []]]);
});

test('merge: an enabled any-chat rule means no button and the rule is never touched', () => {
  assert.equal(AAT.planTrust(settingsWith({ sites: [site('a.example')] }), siteEntry('a.example', 'Chat A'), 'only'), null);
  const disabled = [site('a.example', { on: false })];
  const plan = AAT.planTrust(settingsWith({ sites: disabled }), siteEntry('a.example', 'Chat A'), 'only');
  assert.deepEqual(plan.patch.sites[0], disabled[0]);
  assert.deepEqual(plan.patch.sites[1].chats, ['Chat A']);
});

test('a subdomain rule limited to Chat B stays; Chat A gets an exact-host rule', () => {
  const sites = [site('a.example', { sub: true, chats: ['Chat B'] })];
  const before = settingsWith({ sites });
  const entry = siteEntry('a.example', 'Chat A');
  assert.deepEqual(offered(before, [entry]), [true]);
  const plan = AAT.planTrust(before, entry, 'only');
  assert.deepEqual(plan.patch.sites[0], sites[0]);
  assert.deepEqual(grown(before, apply(before, plan)), ['a.example|Chat A', 'www.a.example|Chat A']);
});

test('duplicate ids are never the target, and a new rule gets an id nobody has', () => {
  const sites = [site('x.example', { id: 'dup' }), site('y.example', { id: 'dup' }), site('a.example', { id: 'dup2', on: false, chats: ['Chat A'] }), site('a.example', { id: 'dup2', host: 'z.example' })];
  const before = settingsWith({ sites });
  const plan = AAT.planTrust(before, siteEntry('a.example', 'Chat A'), 'only');
  assert.deepEqual(plan.patch.sites.slice(0, 4), sites);
  const added = plan.patch.sites[4];
  assert.ok(!['dup', 'dup2'].includes(added.id));
  assert.equal(plan.change.id, added.id);
  assert.deepEqual(AAT.planUndo(apply(before, plan), plan.change).sites, sites);
});

// Over every starting state and pick, the trusted probes grow by at most the probes the pick names, written out literally
test('never wider than the pick, for every starting rule', () => {
  const starts = [
    [], [site('a.example', { on: false })], [site('a.example', { on: false, sub: true })], [site('a.example', { chats: ['Chat B'] })],
    [site('a.example', { chats: ['Chat B'], on: false })], [site('a.example', { sub: true, chats: ['Chat B'] })],
    [site('www.a.example', { on: false, sub: true })], [site('a.example', { on: false, chats: ['Chat A'] })],
    [site('a.example', { id: 'd' }), site('b.example', { id: 'd', on: false })], [site('www.www.a.example', { chats: ['Chat B'] })],
  ];
  const pick = { 'a.example': ['a.example', 'www.a.example'], 'www.a.example': ['a.example', 'www.a.example'], 'www.www.a.example': ['www.www.a.example'] };
  let checked = 0;
  for (const start of starts) {
    for (const host of Object.keys(pick)) {
      for (const scope of ['any', 'only']) {
        const before = settingsWith({ sites: start });
        const plan = AAT.planTrust(before, siteEntry(host, 'Chat A'), scope);
        if (!plan) continue;
        checked++;
        for (const id of grown(before, apply(before, plan))) {
          const [h, chat] = id.split('|');
          assert.ok(pick[host].includes(h) && (scope === 'any' || chat === 'Chat A'), `${JSON.stringify(start)} ${host} ${scope}: ${id}`);
        }
      }
    }
  }
  assert.ok(checked > 40);
});

test('undo removes a rule the click created', () => {
  const before = settingsWith({ sites: [site('b.example')] });
  const plan = AAT.planTrust(before, siteEntry('a.example', 'Chat A'), 'any');
  assert.deepEqual(AAT.planUndo(apply(before, plan), plan.change).sites, before.sites);
});

test('undo puts back the earlier state of a reused rule', () => {
  const sites = [site('a.example', { chats: ['Chat B'] }), site('b.example')];
  const before = settingsWith({ sites });
  const plan = AAT.planTrust(before, siteEntry('a.example', 'Chat A'), 'only');
  assert.deepEqual(AAT.planUndo(apply(before, plan), plan.change).sites, sites);
  const off = [site('a.example', { chats: ['Chat A'], on: false })];
  const reenable = AAT.planTrust(settingsWith({ sites: off }), siteEntry('a.example', 'Chat A'), 'only');
  assert.deepEqual(AAT.planUndo(reenable.patch, reenable.change).sites, off);
});

test('undo does nothing once that rule was changed or deleted elsewhere', () => {
  const before = settingsWith({ sites: [site('a.example', { chats: ['Chat B'] })] });
  const merged = AAT.planTrust(before, siteEntry('a.example', 'Chat A'), 'only');
  assert.equal(AAT.planUndo({ sites: [{ ...merged.patch.sites[0], chats: ['Chat A', 'Chat C'] }] }, merged.change), null);
  const created = AAT.planTrust(settingsWith(), siteEntry('n.example', 'Chat A'), 'only');
  assert.equal(AAT.planUndo({ sites: [{ ...created.patch.sites[0], chats: ['Chat A', 'Chat C'] }] }, created.change), null);
  assert.equal(AAT.planUndo({ sites: [] }, created.change), null);
  const reordered = Object.fromEntries(Object.entries(created.patch.sites[0]).reverse());
  assert.deepEqual(AAT.planUndo({ sites: [reordered] }, created.change).sites, []);
});

function fakeStorage(initial) {
  const data = structuredClone(initial);
  return {
    data,
    async get(defaults) { return structuredClone(Object.fromEntries(Object.keys(defaults).map(k => [k, k in data ? data[k] : defaults[k]]))); },
    async set(values) { Object.assign(data, structuredClone(values)); },
  };
}

test('trust and undo write over the stored list, not the page copy, and keep changes made elsewhere', async () => {
  const storage = fakeStorage(settingsWith({ sites: [site('a.example', { chats: ['Chat B'] }), site('c.example')] }));
  // Another page turned c.example off after this page loaded; the page copy still has it on
  storage.data.sites[1].on = false;
  const created = await AAT.trust(storage, siteEntry('n.example', 'Chat A'), 'only');
  const merged = await AAT.trust(storage, siteEntry('a.example', 'Chat A'), 'only');
  assert.equal(storage.data.sites[1].on, false);
  storage.data.sites.push(site('d.example'));
  storage.data.mode = 'all';
  assert.equal(await AAT.undo(storage, merged), true);
  assert.deepEqual(storage.data.sites.map(s => [s.host, s.chats, s.on]), [['a.example', ['Chat B'], true], ['c.example', [], false], ['n.example', ['Chat A'], true], ['d.example', [], true]]);
  assert.equal(storage.data.mode, 'all');
  storage.data.sites[2].chats.push('Chat C');
  assert.equal(await AAT.undo(storage, created), false);
  assert.deepEqual(storage.data.sites.map(s => s.host), ['a.example', 'c.example', 'n.example', 'd.example']);
});

test('trust does nothing when the stored settings already cover the card', async () => {
  const storage = fakeStorage(settingsWith({ sites: [site('a.example')] }));
  assert.equal(await AAT.trust(storage, siteEntry('a.example', 'Chat A'), 'only'), null);
  assert.deepEqual(storage.data.sites, [site('a.example')]);
});

test('the Waiting list merge in shared.js is as on main: a disabled rule keeps its old scope when re-enabled', () => {
  const [rule] = AAM.addSiteRule([site('a.example', { sub: true, on: false })], 'a.example', { chat: 'Chat A' });
  assert.deepEqual([rule.sub, rule.chats, rule.on], [true, [], true]);
});
