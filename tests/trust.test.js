'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AAM = require('../shared.js');
const AAT = require('../trust.js');

const POLICY = 'connector.example.post.create';
const OTHER_POLICY = 'connector.example.message.send';
const UPLOAD = AAM.UPLOAD_POLICY;

const settingsWith = (patch = {}) => ({ ...structuredClone(AAM.SETTINGS_DEFAULTS), ...structuredClone(patch) });
const site = (host, extra = {}) => ({ id: `s-${host}`, host, sub: false, chats: [], on: true, ...extra });
const action = (title, extra = {}) => ({ id: `a-${title}`, title, chats: [], on: true, ...extra });
const apply = (settings, plan) => ({ ...settings, ...plan.patch });

// Log entries shaped like the ones content.js writes, with the card key built the same way
function siteEntry(host, chat, result = 'handled', extra = {}) {
  const e = { ts: Date.now(), host, chat, title: `Access ${host}`, action: '', policy: '', site: '', result, ...extra };
  return { ...e, key: AAM.cardKey(e) };
}
function actionEntry(title, chat, result = 'handled', extra = {}) {
  const e = { ts: Date.now(), host: '', chat, title, action: title, policy: POLICY, site: '', purchase: false, result, ...extra };
  return { ...e, key: AAM.cardKey(e) };
}
function uploadEntry(dest, chat, result = 'handled', extra = {}) {
  const e = { ts: Date.now(), host: '', chat, title: 'Upload', action: 'Upload', policy: UPLOAD, site: dest, purchase: false, result, ...extra };
  return { ...e, key: AAM.cardKey(e) };
}

const offered = (settings, log) => log.map(e => AAT.offers(settings, log).has(e));

const CHATS = ['Chat A', 'Chat B', 'Chat C', ''];
const SITE_PROBES = ['a.example', 'www.a.example', 'sub.a.example', 'wwwa.example', 'b.example']
  .flatMap(host => CHATS.map(chat => ({ id: `${host}|${chat}`, host, chat, action: '', policy: '', site: '' })));
const ACTION_PROBES = ['Post', 'Upload', 'Other'].flatMap(title => [POLICY, UPLOAD, ''].flatMap(policy =>
  ['', 'upload.example', 'www.upload.example', 'x.upload.example', 'other.example'].flatMap(dest => CHATS.map(chat =>
    ({ id: `${title}/${policy}@${dest}|${chat}`, host: '', chat, action: title, policy, site: dest })))));
const trustedProbes = (settings, probes) => probes.filter(p => AAM.isTrusted(settings, p)).map(p => p.id);
const grown = (before, after, probes) => {
  const old = new Set(trustedProbes(before, probes));
  return trustedProbes(after, probes).filter(id => !old.has(id));
};

test('rule 1: waiting, answered in muse and skipped rows offer Trust', () => {
  const s = settingsWith();
  for (const result of ['pending', 'handled', 'skipped']) {
    assert.deepEqual(offered(s, [siteEntry('a.example', 'Chat A', result)]), [true], `site ${result}`);
    assert.deepEqual(offered(s, [actionEntry('Post', 'Chat A', result)]), [true], `action ${result}`);
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
  assert.deepEqual(offered(settingsWith({ actions: [action('Other', { policy: POLICY })] }), [actionEntry('Post', 'Chat A', 'allowed')]), [false]);
  assert.deepEqual(offered(settingsWith({ chats: [{ id: 'c1', name: 'Chat A', on: true }] }), [entry]), [false]);
});

test('rule 1: in Allow everything, site and upload rows offer nothing; action rows only while actions are excluded', () => {
  const all = settingsWith({ mode: 'all' });
  assert.deepEqual(offered(all, [siteEntry('a.example', 'Chat A')]), [false]);
  assert.deepEqual(offered(all, [uploadEntry('upload.example', 'Chat A')]), [false]);
  assert.deepEqual(offered(all, [actionEntry('Post', 'Chat A')]), [true]);
  assert.deepEqual(offered(settingsWith({ mode: 'all', includeActions: true }), [actionEntry('Post', 'Chat A')]), [false]);
});

test('rule 1: purchase and checkout rows never offer Trust', () => {
  const s = settingsWith();
  assert.deepEqual(offered(s, [actionEntry('Confirm', 'Chat A', 'handled', { purchase: true })]), [false]);
  assert.deepEqual(offered(s, [actionEntry('Check out on shop.example', 'Chat A')]), [false]);
  assert.deepEqual(offered(s, [siteEntry('shop.example', 'Chat A', 'handled', { purchase: true })]), [false]);
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

test('rule 1: action rows written before the log stored purchase offer nothing; site rows are unaffected', () => {
  const old = actionEntry('Post', 'Chat A');
  delete old.purchase;
  delete old.policy;
  assert.deepEqual(offered(settingsWith(), [old, { ...old, policy: POLICY }, { ...old, purchase: null, policy: POLICY }]), [false, false, false]);
  const oldSite = siteEntry('a.example', 'Chat A');
  delete oldSite.policy;
  assert.deepEqual(offered(settingsWith(), [oldSite]), [true]);
});

test('finding: an upload without a destination, or an action without a policy, offers nothing', () => {
  const noDest = uploadEntry('', 'Chat A');
  assert.deepEqual(offered(settingsWith(), [noDest]), [false]);
  assert.equal(AAT.planTrust(settingsWith(), noDest, 'any'), null);
  const noPolicy = actionEntry('Upload', 'Chat A', 'handled', { policy: '' });
  assert.deepEqual(offered(settingsWith(), [noPolicy]), [false]);
  assert.equal(AAT.planTrust(settingsWith(), noPolicy, 'only'), null);
});

test('scopes: a known chat gets Any and Only; an unknown chat gets Any only', () => {
  assert.deepEqual(AAT.scopes(siteEntry('a.example', 'Chat A')), ['any', 'only']);
  const unknown = siteEntry('a.example', '');
  assert.deepEqual(AAT.scopes(unknown), ['any']);
  assert.equal(AAT.planTrust(settingsWith(), unknown, 'only'), null);
  const plan = AAT.planTrust(settingsWith(), unknown, 'any');
  assert.deepEqual(grown(settingsWith(), apply(settingsWith(), plan), SITE_PROBES),
    ['a.example|Chat A', 'a.example|Chat B', 'a.example|Chat C', 'a.example|', 'www.a.example|Chat A', 'www.a.example|Chat B', 'www.a.example|Chat C', 'www.a.example|']);
});

test('finding: "Only Chat A" on www.a.example names and trusts exactly a.example and www.a.example in Chat A', () => {
  const entry = siteEntry('www.a.example', 'Chat A');
  assert.equal(AAT.rowLabel(entry, k => k), 'a.example');
  const plan = AAT.planTrust(settingsWith(), entry, 'only');
  assert.deepEqual(plan.patch.sites.map(r => [r.host, r.sub, r.chats, r.on]), [['a.example', false, ['Chat A'], true]]);
  assert.deepEqual(grown(settingsWith(), apply(settingsWith(), plan), SITE_PROBES), ['a.example|Chat A', 'www.a.example|Chat A']);
});

test('finding: an upload to www.upload.example is shown and saved as upload.example, exact host only', () => {
  const entry = uploadEntry('www.upload.example', 'Chat A');
  assert.equal(AAT.rowLabel(entry, (k, v) => `${k} ${v}`), 'uploadTo upload.example');
  const plan = AAT.planTrust(settingsWith(), entry, 'only');
  const [rule] = plan.patch.actions;
  assert.deepEqual([rule.title, rule.policy, rule.site, rule.sub, rule.chats], ['Upload', UPLOAD, 'upload.example', undefined, ['Chat A']]);
  assert.deepEqual(grown(settingsWith(), apply(settingsWith(), plan), ACTION_PROBES), [
    `Upload/${POLICY}@upload.example|Chat A`, `Upload/${POLICY}@www.upload.example|Chat A`,
    `Upload/${UPLOAD}@upload.example|Chat A`, `Upload/${UPLOAD}@www.upload.example|Chat A`,
    'Upload/@upload.example|Chat A', 'Upload/@www.upload.example|Chat A',
    `Post/${UPLOAD}@upload.example|Chat A`, `Post/${UPLOAD}@www.upload.example|Chat A`,
    `Other/${UPLOAD}@upload.example|Chat A`, `Other/${UPLOAD}@www.upload.example|Chat A`,
  ].sort((a, b) => ACTION_PROBES.findIndex(p => p.id === a) - ACTION_PROBES.findIndex(p => p.id === b)));
});

test('finding: a title-only rule for other chats is left alone; the new rule carries title, policy and the picked chat', () => {
  const actions = [action('Post', { chats: ['Chat B'] })];
  const before = settingsWith({ actions });
  const plan = AAT.planTrust(before, actionEntry('Post', 'Chat A'), 'only');
  assert.deepEqual(plan.patch.actions[0], actions[0]);
  assert.deepEqual(plan.patch.actions.slice(1).map(r => [r.title, r.policy, r.site, r.chats, r.on]), [['Post', POLICY, undefined, ['Chat A'], true]]);
  const growth = grown(before, apply(before, plan), ACTION_PROBES);
  assert.ok(growth.every(id => id.endsWith('|Chat A')), growth.join(' '));
  assert.ok(!growth.some(id => id.endsWith('|Chat B')));
});

test('finding: a disabled rule with another policy or scope is left alone and a new rule is appended', () => {
  const actions = [action('Post', { policy: OTHER_POLICY, on: false })];
  const plan = AAT.planTrust(settingsWith({ actions }), actionEntry('Post', 'Chat A'), 'any');
  assert.deepEqual(plan.patch.actions[0], actions[0]);
  assert.deepEqual(plan.patch.actions.slice(1).map(r => [r.policy, r.chats, r.on]), [[POLICY, [], true]]);
  const sites = [site('a.example', { sub: true, on: false }), site('a.example', { id: 's-2', chats: ['Chat B'], on: false })];
  const sitePlan = AAT.planTrust(settingsWith({ sites }), siteEntry('a.example', 'Chat A'), 'only');
  assert.deepEqual(sitePlan.patch.sites.slice(0, 2), sites);
  assert.deepEqual(sitePlan.patch.sites.slice(2).map(r => [r.host, r.sub, r.chats]), [['a.example', false, ['Chat A']]]);
});

test('merge: a disabled rule whose criteria and chats are exactly the pick is turned back on', () => {
  const sites = [site('www.a.example', { chats: ['Chat A'], on: false })];
  const plan = AAT.planTrust(settingsWith({ sites }), siteEntry('a.example', 'Chat A'), 'only');
  assert.deepEqual(plan.patch.sites, [{ ...sites[0], on: true }]);
  assert.deepEqual(plan.change.prev, sites[0]);
  const actions = [action('Upload', { policy: UPLOAD, site: 'upload.example', on: false })];
  assert.deepEqual(AAT.planTrust(settingsWith({ actions }), uploadEntry('upload.example', 'Chat A'), 'any').patch.actions, [{ ...actions[0], on: true }]);
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
  const sites = [site('a.example')];
  assert.equal(AAT.planTrust(settingsWith({ sites }), siteEntry('a.example', 'Chat A'), 'only'), null);
  const disabled = [site('a.example', { on: false })];
  const plan = AAT.planTrust(settingsWith({ sites: disabled }), siteEntry('a.example', 'Chat A'), 'only');
  assert.deepEqual(plan.patch.sites[0], disabled[0]);
  assert.deepEqual(plan.patch.sites[1].chats, ['Chat A']);
});

test('finding: a subdomain rule limited to Chat B stays; Chat A gets an exact-host rule', () => {
  const sites = [site('a.example', { sub: true, chats: ['Chat B'] })];
  const before = settingsWith({ sites });
  const entry = siteEntry('a.example', 'Chat A');
  assert.deepEqual(offered(before, [entry]), [true]);
  const plan = AAT.planTrust(before, entry, 'only');
  assert.deepEqual(plan.patch.sites[0], sites[0]);
  assert.deepEqual(grown(before, apply(before, plan), SITE_PROBES), ['a.example|Chat A', 'www.a.example|Chat A']);
});

test('finding: duplicate ids are never the target, and a new rule gets an id nobody has', () => {
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
  const siteStarts = [
    [], [site('a.example', { on: false })], [site('a.example', { on: false, sub: true })], [site('a.example', { chats: ['Chat B'] })],
    [site('a.example', { chats: ['Chat B'], on: false })], [site('a.example', { sub: true, chats: ['Chat B'] })],
    [site('www.a.example', { on: false, sub: true })], [site('a.example', { on: false, chats: ['Chat A'] })],
    [site('a.example', { id: 'd' }), site('b.example', { id: 'd', on: false })],
  ];
  const sitePick = { 'a.example': 1, 'www.a.example': 1 };
  for (const start of siteStarts) {
    for (const host of ['a.example', 'www.a.example']) {
      for (const scope of ['any', 'only']) {
        const before = settingsWith({ sites: start });
        const plan = AAT.planTrust(before, siteEntry(host, 'Chat A'), scope);
        if (!plan) continue;
        for (const id of grown(before, apply(before, plan), SITE_PROBES)) {
          const [h, chat] = id.split('|');
          assert.ok(sitePick[h] && (scope === 'any' || chat === 'Chat A'), `${JSON.stringify(start)} ${host} ${scope}: ${id}`);
        }
      }
    }
  }
  const actionStarts = [
    [], [action('Post', { chats: ['Chat B'] })], [action('Post', { policy: OTHER_POLICY, on: false })], [action('Post', { policy: POLICY, on: false, chats: ['Chat A'] })],
    [action('Post', { policy: POLICY, chats: ['Chat B'] })], [action('Other', { policy: POLICY, chats: ['Chat B'] })],
    [action('Upload', { policy: UPLOAD, site: 'upload.example', sub: true, chats: ['Chat B'] })], [action('Upload', { policy: UPLOAD, site: 'upload.example', on: false })],
    [action('Upload', { policy: UPLOAD, chats: ['Chat B'] })],
  ];
  // Main's matcher reads an action rule as "same title, or same policy", at the rule's site when it has one
  const actionPick = {
    post: (title, policy) => title === 'Post' || policy === POLICY,
    upload: (title, policy, dest) => (title === 'Upload' || policy === UPLOAD) && (dest === 'upload.example' || dest === 'www.upload.example'),
  };
  for (const start of actionStarts) {
    for (const [kind, entry] of [['post', actionEntry('Post', 'Chat A')], ['upload', uploadEntry('upload.example', 'Chat A')], ['upload', uploadEntry('www.upload.example', 'Chat A')]]) {
      for (const scope of ['any', 'only']) {
        const before = settingsWith({ actions: start });
        const plan = AAT.planTrust(before, entry, scope);
        if (!plan) continue;
        for (const id of grown(before, apply(before, plan), ACTION_PROBES)) {
          const probe = ACTION_PROBES.find(p => p.id === id);
          assert.ok(actionPick[kind](probe.action, probe.policy, probe.site) && (scope === 'any' || probe.chat === 'Chat A'), `${JSON.stringify(start)} ${entry.key} ${scope}: ${id}`);
        }
      }
    }
  }
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

test('finding: undo does nothing once that rule was changed or deleted elsewhere', () => {
  const sites = [site('a.example', { chats: ['Chat B'] })];
  const before = settingsWith({ sites });
  const merged = AAT.planTrust(before, siteEntry('a.example', 'Chat A'), 'only');
  const edited = { sites: [{ ...merged.patch.sites[0], chats: ['Chat A', 'Chat C'] }] };
  assert.equal(AAT.planUndo(edited, merged.change), null);
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

test('finding: trust and undo write over the stored lists, not the page copy, and keep changes made elsewhere', async () => {
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
