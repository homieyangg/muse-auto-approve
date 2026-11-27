'use strict';

// Strict action rules saved from recent-activity rows: the matcher, import, which rows offer Trust, the merge and undo
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const AAM = require('../shared.js');
const AAT = require('../trust.js');

const POST = 'connector.example.post.create';
const SEND = 'connector.example.message.send';
const UPLOAD = 'connector.browser.page.upload';
const GOTO = 'connector.browser.page.goto';
const DOWNLOAD = 'connector.browser.page.download';

// main before this change (PR #18 merged), for the parity checks
const MAIN_COMMIT = '51ace01';
function mainShared() {
  try {
    const source = execFileSync('git', ['show', `${MAIN_COMMIT}:shared.js`], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return runSource(source);
  } catch {
    return null;
  }
}
// Loads a source file in its own context, so nothing another test pushed into a shared module is seen
function runSource(source) {
  const ctx = { module: { exports: {} }, require: m => require(path.join(__dirname, '..', m)), URL };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return ctx.module.exports;
}
const MAIN = mainShared();
// Objects from another vm context have other prototypes; compare their JSON
const plain = value => JSON.parse(JSON.stringify(value));
const needsMain = { skip: !MAIN && `${MAIN_COMMIT} is not in this clone` };

const settingsWith = (patch = {}) => ({ ...structuredClone(AAM.SETTINGS_DEFAULTS), ...structuredClone(patch) });
const withStrict = (rules, patch = {}) => settingsWith({ ...patch, strictActions: rules });
const apply = (settings, plan) => ({ ...settings, ...plan.patch });
const strict = (policy, extra = {}) => ({ id: `r-${policy}-${extra.site || ''}`, title: 'Saved title', policy, ...(policy === UPLOAD && { site: 'a.example' }), chats: [], on: true, ...extra });
const legacy = (title, extra = {}) => ({ id: `l-${title}`, title, chats: [], on: true, ...extra });
// A card as content.js builds it: approvalId only when bridge.js answered the fresh mark, purchase false only when every
// fresh answer for the card said so, tainted when an earlier read of the approval saw a purchase or a mix
const card = (policy, { title = 'Post to Example', site = '', chat = 'Chat A', approvalId = 'appr-1', purchase = false, tainted = false } = {}) =>
  ({ host: '', chat, title, action: title, policy, site: policy === UPLOAD ? site : '', approvalId, purchase, tainted });

// Log rows shaped like the ones content.js writes
let tsSeq = 1000;
function actionRow(policy, chat = 'Chat A', extra = {}) {
  const e = { ts: tsSeq++, host: '', chat, title: 'Post to Example', action: 'Post to Example', policy, approvalHost: '', approvalId: `appr-${tsSeq}`, purchase: false, mixed: false, evidenceVersion: AAM.EVIDENCE_VERSION, site: '', result: 'pending', ...extra };
  return { ...e, key: AAM.cardKey(e) };
}
const uploadRow = (site, chat = 'Chat A', extra = {}) =>
  actionRow(UPLOAD, chat, { title: 'Upload this file', action: 'Upload this file', approvalHost: 'browser', site, ...extra });
const offered = (settings, log) => log.map(e => AAT.offers(settings, log).has(e));
const LONG_POLICY = `connector.example.${'x'.repeat(182)}`;

test('the shipped SITE_POLICIES is empty, so no website row offers Trust', () => {
  const shipped = runSource(fs.readFileSync(path.join(__dirname, '..', 'trust.js'), 'utf8'));
  assert.equal(JSON.stringify(shipped.SITE_POLICIES), '[]');
});

test('strict: the same policy with another title matches; the same title with another policy does not', () => {
  const s = withStrict([strict(POST, { title: 'Post to Example' })]);
  assert.equal(AAM.isTrusted(s, card(POST, { title: 'Publish a post' })), true);
  assert.equal(AAM.isTrusted(s, card(SEND, { title: 'Post to Example' })), false);
  assert.equal(AAM.isTrusted(s, card('', { title: 'Post to Example' })), false);
});

test('strict: a card not freshly read from muse\'s data never matches', () => {
  const s = withStrict([strict(POST)]);
  assert.equal(AAM.isTrusted(s, card(POST, { approvalId: '' })), false);
  assert.equal(AAM.isTrusted(withStrict([strict('')]), card('')), false);
});

// Codex round 1, item 5: an upload item of a combined card whose parent card got no fresh reply reads purchase null
test('strict: only a card known not to be a purchase matches; null or missing purchase matches nothing', () => {
  for (const [policy, extra] of [[POST, {}], [UPLOAD, { site: 'a.example', title: 'Upload this file' }]]) {
    const s = withStrict([strict(policy)]);
    assert.equal(AAM.isTrusted(s, card(policy, extra)), true, policy);
    for (const purchase of [null, undefined, true, 0, '']) assert.equal(AAM.isTrusted(s, { ...card(policy, extra), purchase }), false, `${policy} ${purchase}`);
  }
});

// Codex round 1, item 1: a read that refused a click, a waiting item or a log row of this approval saw a purchase or a mix
test('strict: a card whose approval was ever seen as a purchase or a mix matches nothing', () => {
  const s = withStrict([strict(POST)]);
  assert.equal(AAM.isTrusted(s, card(POST, { tainted: true })), false);
  assert.equal(AAM.isTrusted(s, { ...card(POST), mixed: true }), false);
  // Rules under actions don't look at it, as on main
  assert.equal(AAM.isTrusted(settingsWith({ actions: [legacy('Post to Example')] }), card(POST, { tainted: true })), true);
});

test('strict upload: only the exact destination as normalizeHost gives it', () => {
  const s = withStrict([strict(UPLOAD, { site: 'a.example' })]);
  const at = site => AAM.isTrusted(s, card(UPLOAD, { title: 'Upload this file', site }));
  assert.deepEqual(['a.example', 'b.example', 'sub.a.example', 'www.a.example', ''].map(at), [true, false, false, false, false]);
  const www = withStrict([strict(UPLOAD, { site: 'www.a.example' })]);
  assert.equal(AAM.isTrusted(www, card(UPLOAD, { site: 'a.example' })), false);
  assert.equal(AAM.isTrusted(www, card(UPLOAD, { site: 'www.a.example' })), true);
  // A sub flag on a strict rule is ignored rather than widening it
  assert.equal(AAM.isTrusted(withStrict([strict(UPLOAD, { site: 'a.example', sub: true })]), card(UPLOAD, { site: 'sub.a.example' })), false);
});

test('strict: chat scope compares whole names', () => {
  const only = withStrict([strict(POST, { chats: ['Chat A', 'Chat B'] })]);
  assert.deepEqual(['Chat A', 'Chat B', 'Chat C', 'Chat', ''].map(chat => AAM.isTrusted(only, card(POST, { chat }))), [true, true, false, false, false]);
  const any = withStrict([strict(POST)]);
  assert.deepEqual(['Chat A', ''].map(chat => AAM.isTrusted(any, card(POST, { chat }))), [true, true]);
  assert.equal(AAM.isTrusted(withStrict([strict(POST, { on: false })]), card(POST)), false);
});

// Codex round 1, items 3, 4 and 6: a stored or imported strict rule that isn't exactly in its final form matches nothing
const INVALID = {
  'chats as a string': { chats: 'Chat A, Chat B' },
  'chats with an empty name': { chats: ['Chat A', ''] },
  'chats with a number': { chats: ['Chat A', 3] },
  'chats missing': { chats: undefined },
  'policy over 200 characters': { policy: `${LONG_POLICY}y` },
  'policy with an empty last segment': { policy: 'connector.example.' },
  'policy with an empty middle segment': { policy: 'connector.example..send' },
  'policy with a space': { policy: 'connector.example.post create' },
  'policy without a method': { policy: 'connector.example' },
  'policy not a string': { policy: ['connector.example.post.create'] },
  'title over 120 characters': { title: 'x'.repeat(121) },
  'title empty': { title: '' },
  'on not a boolean': { on: 'yes' },
  'id missing': { id: undefined },
  'site on a non-upload rule': { site: 'a.example' },
  'empty site on a non-upload rule': { site: '' },
};
const INVALID_UPLOAD = {
  'upload without a site': { site: undefined },
  'upload site not normalized': { site: 'A.example' },
  'upload site as a url': { site: 'https://a.example/x' },
  'upload site over the host length': { site: `${'a'.repeat(300)}.example` },
};
const invalidRules = () => [
  ...Object.entries(INVALID).map(([name, extra]) => [name, { ...strict(POST), ...extra }]),
  ...Object.entries(INVALID_UPLOAD).map(([name, extra]) => [name, { ...strict(UPLOAD), ...extra }]),
].map(([name, rule]) => [name, JSON.parse(JSON.stringify(rule))]);

test('an invalid strict rule matches nothing, even stored directly', () => {
  for (const [name, rule] of invalidRules()) {
    assert.equal(AAM.validStrictRule(rule), false, name);
    const s = withStrict([rule]);
    for (const policy of [POST, rule.policy]) {
      for (const site of ['a.example', 'A.example', '']) {
        for (const chat of ['Chat A', 'Chat B', '']) assert.equal(AAM.isTrusted(s, card(typeof policy === 'string' ? policy : POST, { site, chat })), false, `${name} ${site} ${chat}`);
      }
    }
  }
  assert.equal(AAM.validStrictRule(strict(LONG_POLICY)), true);
  assert.equal(AAM.isTrusted(withStrict([strict(LONG_POLICY)]), card(LONG_POLICY)), true);
});

test('a strict rule for a policy Trust never offers matches nothing, even imported or edited by hand', () => {
  for (const policy of ['tool.web_fetch', GOTO, DOWNLOAD, 'connector.browser.page.credential_fill', 'example.post', 'connector.example', 'connector.example.']) {
    const s = withStrict([strict(policy)]);
    assert.equal(AAM.isTrusted(s, card(policy)), false, policy);
    assert.equal(AAM.strictPolicy(policy), false, policy);
  }
});

test('a strict rule matches a subset of what the same rule matches as an old action rule', () => {
  const rules = [strict(POST), strict(POST, { title: 'Post to Example' }), strict(UPLOAD, { site: 'a.example' }), strict(UPLOAD, { site: 'www.a.example', chats: ['Chat A'] })];
  const cards = [POST, SEND, UPLOAD, ''].flatMap(policy => ['a.example', 'www.a.example', 'sub.a.example', ''].flatMap(site =>
    ['Post to Example', 'Other'].flatMap(title => ['Chat A', 'Chat B'].flatMap(chat => ['appr-1', ''].flatMap(approvalId => [false, null].map(purchase => card(policy, { title, site, chat, approvalId, purchase })))))));
  let hits = 0;
  for (const rule of rules) {
    for (const c of cards) {
      if (!AAM.isTrusted(withStrict([rule]), c)) continue;
      hits++;
      assert.ok(AAM.isTrusted(settingsWith({ actions: [rule] }), c), `${JSON.stringify(rule)} ${JSON.stringify(c)}`);
    }
  }
  assert.ok(hits > 10);
});

// Rules and cards that main's matcher sees; a strict rule must not change how they are judged
const OLD_RULES = [
  legacy('Post to Example'), legacy('Post to Example', { policy: POST }), legacy('Other', { policy: POST, chats: ['Chat B'] }),
  legacy('Upload this file', { policy: UPLOAD, site: 'a.example' }), legacy('Upload this file', { policy: UPLOAD, site: 'a.example', sub: true }),
  legacy('Upload this file', { site: 'www.a.example' }), legacy('Post to Example', { on: false }),
].map((rule, i) => ({ ...rule, id: `old-${i}` }));
const OLD_CARDS = [POST, SEND, UPLOAD, ''].flatMap(policy => ['a.example', 'www.a.example', 'sub.a.example', 'b.example', ''].flatMap(site =>
  ['Post to Example', 'Upload this file', 'Other'].flatMap(title => ['Chat A', 'Chat B', ''].flatMap(chat => ['appr-1', ''].map(approvalId => card(policy, { title, site, chat, approvalId }))))));

test('rules under actions match exactly as on main', needsMain, () => {
  for (const rule of OLD_RULES) {
    const s = settingsWith({ actions: [rule], sites: [{ id: 's', host: 'a.example', sub: true, chats: [], on: true }] });
    for (const c of [...OLD_CARDS, { ...OLD_CARDS[0], host: 'a.example' }, { ...OLD_CARDS[0], host: 'c.example' }]) {
      assert.equal(AAM.isTrusted(s, c), MAIN.isTrusted(s, c), `${JSON.stringify(rule)} ${JSON.stringify(c)}`);
    }
  }
});

// Codex round 1, item 2: versions without strict matching never read strictActions
test('main ignores strictActions in settings and in an export', needsMain, () => {
  const rules = [strict(POST), strict(UPLOAD, { site: 'a.example' })];
  for (const c of [card(POST), card(UPLOAD, { site: 'a.example' })]) assert.equal(MAIN.isTrusted(withStrict(rules), c), false);
  const exported = JSON.parse(JSON.stringify({ app: 'auto-approve-for-muse', settings: withStrict(rules, { actions: [legacy('Other')] }) }));
  const imported = plain(MAIN.sanitizeSettings(exported.settings));
  assert.equal('strictActions' in imported, false);
  assert.deepEqual(imported.actions.map(a => a.title), ['Other']);
});

test('a strict rule next to old rules changes nothing about what the old rules match', () => {
  const extra = [strict(SEND), strict(UPLOAD, { site: 'b.example' })];
  const trustedByExtra = c => AAM.isTrusted(withStrict(extra), c);
  for (const rule of OLD_RULES) {
    for (const c of OLD_CARDS) {
      const both = AAM.isTrusted(withStrict(extra, { actions: [rule] }), c);
      assert.equal(both, AAM.isTrusted(settingsWith({ actions: [rule] }), c) || trustedByExtra(c));
    }
  }
});

test('the Waiting list\'s Always trust writes what main writes', needsMain, () => {
  const picks = [['Post to Example', {}], ['Post to Example', { policy: POST, chat: 'Chat A' }], ['Saved title', { policy: POST }], ['Upload this file', { policy: UPLOAD, site: 'a.example' }], ['New', { policy: SEND }]];
  const newIds = list => list.map(r => (OLD_RULES.some(o => o.id === r.id) ? r : { ...r, id: '' }));
  for (const [title, opts] of picks) {
    assert.deepEqual(newIds(AAM.addActionRule(OLD_RULES, title, opts)), newIds(plain(MAIN.addActionRule(OLD_RULES, title, opts))), title);
  }
});

test('import keeps valid strict rules as they are, drops invalid ones, and imports old exports as main does', needsMain, () => {
  const valid = [strict(POST, { title: 'Saved' }), strict(UPLOAD, { site: 'www.a.example', chats: ['Chat A'] }), strict(LONG_POLICY, { id: 'long', on: false })];
  const raw = {
    actions: [legacy('Post to Example', { policy: POST }), legacy('Upload this file', { policy: UPLOAD, site: 'https://A.example/x', sub: true })],
    strictActions: [...valid, ...invalidRules().map(([, rule]) => rule), { ...strict(SEND), sub: true, match: 'strict', extra: 1 }, null, 'rule'],
  };
  const clean = AAM.sanitizeSettings(raw);
  assert.deepEqual(clean.strictActions, [...valid, strict(SEND)]);
  assert.deepEqual(clean.actions, plain(MAIN.sanitizeSettings(raw).actions));
  // A strict rule is dropped, never cut or normalized into another one
  for (const [name, rule] of invalidRules()) {
    assert.deepEqual(AAM.sanitizeSettings({ strictActions: [rule] }).strictActions, [], name);
  }
  const old = { ...raw, strictActions: undefined, sites: [{ id: 's', host: 'www.a.example', sub: true }], chats: [{ id: 'c', name: 'Chat A' }], mode: 'all' };
  assert.deepEqual(AAM.sanitizeSettings(old), { ...plain(MAIN.sanitizeSettings(old)), strictActions: [] });
  // Export writes the settings as stored; importing that file gives the same rules back
  const roundTrip = AAM.sanitizeSettings(JSON.parse(JSON.stringify({ app: 'auto-approve-for-muse', settings: clean })).settings);
  assert.deepEqual(roundTrip, clean);
});

test('offers: an action row with fresh data for one approval and no purchase', () => {
  const row = actionRow(POST);
  assert.deepEqual(offered(settingsWith(), [row]), [true]);
  assert.deepEqual(AAT.scopes(row), ['any', 'only']);
  // "include actions" off: Allow everything still stops at actions
  assert.deepEqual(offered(settingsWith({ mode: 'all' }), [row]), [true]);
  assert.deepEqual(offered(settingsWith({ mode: 'all', includeActions: true }), [row]), [false]);
});

test('offers: an upload row with its destination, never in Allow everything', () => {
  const row = uploadRow('a.example');
  assert.deepEqual(offered(settingsWith(), [row]), [true]);
  assert.deepEqual(offered(settingsWith({ mode: 'all' }), [row]), [false]);
  assert.deepEqual(offered(settingsWith({ mode: 'all', includeActions: true }), [row]), [false]);
});

test('offers: none without positive evidence', () => {
  const cases = {
    purchase: actionRow(POST, 'Chat A', { purchase: true }),
    'purchase unknown': actionRow(POST, 'Chat A', { purchase: null }),
    'purchase missing': (() => { const r = actionRow(POST); delete r.purchase; return r; })(),
    'purchase wording': actionRow(POST, 'Chat A', { action: 'Place an order', title: 'Place an order' }),
    mixed: actionRow(POST, 'Chat A', { mixed: true }),
    'no approval id': actionRow(POST, 'Chat A', { approvalId: '' }),
    'no policy': actionRow(''),
    'no title': actionRow(POST, 'Chat A', { action: '', title: '' }),
    'upload without destination': uploadRow(''),
    'upload destination not normalized': uploadRow('A.example'),
    'upload destination as url': uploadRow('https://a.example'),
    'non-upload with a site': actionRow(POST, 'Chat A', { site: 'a.example' }),
    goto: actionRow(GOTO),
    download: actionRow(DOWNLOAD),
    'credential fill': actionRow('connector.browser.page.credential_fill'),
    'web fetch grant': actionRow('tool.web_fetch'),
    'not a connector': actionRow('example.post'),
    'policy with an empty segment': actionRow('connector.example.'),
    'policy over 200 characters': actionRow(`${LONG_POLICY}y`),
    // Codex round 1, item 7: rows logged by versions that kept stale evidence
    'no evidence version': (() => { const r = actionRow(POST); delete r.evidenceVersion; return r; })(),
    'older evidence version': actionRow(POST, 'Chat A', { evidenceVersion: AAM.EVIDENCE_VERSION - 1 }),
    'evidence version as a string': actionRow(POST, 'Chat A', { evidenceVersion: String(AAM.EVIDENCE_VERSION) }),
    'upload with no evidence version': (() => { const r = uploadRow('a.example'); delete r.evidenceVersion; return r; })(),
    'upload titled like a site': uploadRow('a.example', 'Chat A', { host: 'a.example', action: '', title: 'Open a.example to upload a file' }),
  };
  for (const [name, row] of Object.entries(cases)) {
    for (const s of [settingsWith(), settingsWith({ mode: 'all' })]) {
      assert.deepEqual(offered(s, [row]), [false], name);
      for (const scope of ['any', 'only']) assert.equal(AAT.planTrust(s, row, scope), null, name);
    }
  }
});

test('offers: none when a rule already covers the row, and only on the newest row of a card', () => {
  const row = actionRow(POST);
  assert.deepEqual(offered(settingsWith({ actions: [legacy('Post to Example')] }), [row]), [false]);
  assert.deepEqual(offered(settingsWith({ actions: [legacy('Other', { policy: POST })] }), [row]), [false]);
  assert.deepEqual(offered(withStrict([strict(POST, { chats: ['Chat A'] })]), [row]), [false]);
  assert.deepEqual(offered(settingsWith({ chats: [{ id: 'c', name: 'Chat A', on: true }] }), [row]), [false]);
  assert.deepEqual(offered(withStrict([strict(POST, { chats: ['Chat B'] })]), [row]), [true]);
  // An invalid strict rule covers nothing, so the row still offers Trust
  assert.deepEqual(offered(withStrict([strict(POST, { chats: 'Chat A' })]), [row]), [true]);
  const log = [actionRow(POST, 'Chat A', { result: 'handled' }), actionRow(POST, 'Chat A', { result: 'allowed' }), uploadRow('a.example'), uploadRow('b.example'), uploadRow('a.example')];
  assert.deepEqual(offered(settingsWith(), log), [true, false, true, true, false]);
});

test('an unknown chat offers Any chat only', () => {
  const row = actionRow(POST, '');
  assert.deepEqual(AAT.scopes(row), ['any']);
  assert.equal(AAT.planTrust(settingsWith(), row, 'only'), null);
  assert.ok(AAT.planTrust(settingsWith(), row, 'any'));
});

test('a pick saves a strict rule with the row\'s policy, destination and chat', () => {
  const plan = AAT.planTrust(settingsWith({ actions: [legacy('Other')] }), uploadRow('a.example'), 'only');
  assert.deepEqual(Object.keys(plan.patch), ['strictActions']);
  const [rule] = plan.patch.strictActions;
  assert.deepEqual({ ...rule, id: '' }, { id: '', title: 'Upload this file', policy: UPLOAD, site: 'a.example', chats: ['Chat A'], on: true });
  const action = AAT.planTrust(settingsWith(), actionRow(POST), 'any').patch.strictActions[0];
  assert.deepEqual({ ...action, id: '' }, { id: '', title: 'Post to Example', policy: POST, chats: [], on: true });
  const long = AAT.planTrust(settingsWith(), actionRow(POST, 'Chat A', { action: 'x'.repeat(130), title: 'x'.repeat(130) }), 'any').patch.strictActions[0];
  for (const saved of [rule, action, long]) assert.equal(AAM.validStrictRule(saved), true);
  assert.deepEqual(AAM.sanitizeSettings(plan.patch).strictActions, plan.patch.strictActions);
});

test('merge: only a valid strict rule with the same policy and site is reused; old rules are never touched', () => {
  const row = uploadRow('a.example');
  const old = [legacy('Upload this file', { policy: UPLOAD, site: 'a.example', chats: ['Chat B'] }), legacy('Upload this file', { policy: UPLOAD, site: 'a.example', on: false })];
  const off = strict(UPLOAD, { site: 'a.example', chats: ['Chat A'], on: false });
  assert.deepEqual(AAT.planTrust(withStrict([off], { actions: old }), row, 'only').patch, { strictActions: [{ ...off, on: true }] });
  const limited = strict(UPLOAD, { site: 'a.example', chats: ['Chat B'] });
  assert.deepEqual(AAT.planTrust(withStrict([limited]), row, 'only').patch.strictActions, [{ ...limited, chats: ['Chat B', 'Chat A'] }]);
  const appended = [
    [limited, 'any'], [off, 'any'],
    [strict(UPLOAD, { site: 'www.a.example', chats: ['Chat B'] }), 'only'],
    [strict(UPLOAD, { site: 'a.example', chats: 'Chat B' }), 'only'],
    [strict(UPLOAD, { site: 'a.example', chats: ['Chat B'], on: 'true' }), 'only'],
  ];
  for (const [rule, scope] of appended) {
    const plan = AAT.planTrust(withStrict([rule], { actions: old }), row, scope);
    assert.deepEqual(Object.keys(plan.patch), ['strictActions']);
    assert.deepEqual(plan.patch.strictActions[0], rule, JSON.stringify(rule));
    assert.equal(plan.patch.strictActions.length, 2);
    assert.equal(AAM.validStrictRule(plan.patch.strictActions[1]), true);
    assert.equal(plan.change.prev, null);
  }
});

test('merge: duplicate ids are never the target and a new rule gets an unused id', () => {
  const dup = [strict(POST, { id: 'd', chats: ['Chat B'] }), strict(SEND, { id: 'd' })];
  const plan = AAT.planTrust(withStrict(dup), actionRow(POST), 'only');
  assert.deepEqual(plan.patch.strictActions.slice(0, 2), dup);
  assert.notEqual(plan.patch.strictActions[2].id, 'd');
  assert.deepEqual(AAT.planUndo(apply(withStrict(dup), plan), plan.change).strictActions, dup);
});

// Probes: every card the matcher could see; the pick may newly trust only the row's policy and exact site in the picked chats
test('never wider than the pick, for every starting rule', () => {
  const sites = ['a.example', 'www.a.example', 'sub.a.example', 'b.example', ''];
  const probes = [POST, SEND, UPLOAD].flatMap(policy => sites.flatMap(site => ['Post to Example', 'Upload this file', 'Other'].flatMap(title =>
    ['Chat A', 'Chat B', 'Chat C', ''].flatMap(chat => ['appr-1', ''].map(approvalId => card(policy, { title, site, chat, approvalId }))))))
    .map(c => ({ ...c, id: [c.policy, c.site, c.title, c.chat, c.approvalId].join('|') }));
  const trusted = s => new Set(probes.filter(p => AAM.isTrusted(s, p)).map(p => p.id));
  const starts = [
    [], [strict(POST, { on: false })], [strict(POST, { chats: ['Chat B'] })], [strict(POST, { chats: ['Chat A'], on: false })],
    [strict(UPLOAD, { site: 'a.example', chats: ['Chat B'] })], [strict(UPLOAD, { site: 'www.a.example', on: false })],
    [legacy('Other', { chats: ['Chat B'] })], [legacy('Upload this file', { policy: UPLOAD, site: 'a.example', sub: true, on: false })],
    [strict(POST, { id: 'x', chats: ['Chat B'] }), strict(SEND, { id: 'x', on: false })],
    [strict(POST, { chats: 'Chat AB' })], [strict(UPLOAD, { site: 'a.example', chats: ['Chat B'], on: 'false' })],
  ];
  let checked = 0;
  for (const start of starts) {
    for (const row of [actionRow(POST), uploadRow('a.example'), uploadRow('www.a.example')]) {
      for (const scope of ['any', 'only']) {
        const before = withStrict(start.filter(r => !r.id.startsWith('l-')), { actions: start.filter(r => r.id.startsWith('l-')) });
        const plan = AAT.planTrust(before, row, scope);
        if (!plan) continue;
        checked++;
        const old = trusted(before);
        const after = apply(before, plan);
        assert.ok(AAM.isTrusted(after, row));
        for (const id of trusted(after)) {
          if (old.has(id)) continue;
          const [policy, site, , chat, approvalId] = id.split('|');
          const ok = policy === row.policy && site === row.site && approvalId && (scope === 'any' || chat === 'Chat A');
          assert.ok(ok, `${JSON.stringify(start)} ${row.policy}@${row.site} ${scope}: ${id}`);
        }
      }
    }
  }
  assert.ok(checked > 45);
});

test('undo removes a created strict rule or puts back a reused one, only while untouched', () => {
  const before = withStrict([strict(SEND)], { actions: [legacy('Other')] });
  const created = AAT.planTrust(before, actionRow(POST), 'only');
  assert.equal(created.change.list, 'strictActions');
  assert.deepEqual(AAT.planUndo(apply(before, created), created.change), { strictActions: before.strictActions });
  const limited = withStrict([strict(POST, { chats: ['Chat B'] })]);
  const merged = AAT.planTrust(limited, actionRow(POST), 'only');
  assert.deepEqual(AAT.planUndo(apply(limited, merged), merged.change).strictActions, limited.strictActions);
  const edited = { strictActions: [{ ...merged.patch.strictActions[0], chats: ['Chat B'] }] };
  assert.equal(AAT.planUndo(edited, merged.change), null);
  // A rule with the same id under actions is not the one the click wrote
  assert.equal(AAT.planUndo({ actions: created.patch.strictActions }, created.change), null);
});

test('a strict upload rule never covers a card read as a website, and that row offers nothing', () => {
  const s = withStrict([strict(UPLOAD, { site: 'a.example' })]);
  const asSite = AAM.parseCard('Open a.example to upload a file? This task is from Chat A.', '', UPLOAD, 'a.example');
  assert.equal(asSite.host, 'a.example');
  assert.equal(AAM.isTrusted(s, { ...asSite, approvalId: 'appr-1' }), false);
  assert.equal(AAM.isTrusted(s, { host: 'a.example', chat: 'Chat A', action: '', policy: '', site: '', approvalId: 'appr-1' }), false);
  const row = uploadRow('a.example', 'Chat A', { host: 'a.example', action: '', title: 'Open a.example to upload a file' });
  assert.deepEqual(offered(settingsWith(), [row]), [false]);
});

function fakeStorage(initial) {
  const data = structuredClone(initial);
  return {
    data,
    async get(defaults) { return structuredClone(Object.fromEntries(Object.keys(defaults).map(k => [k, k in data ? data[k] : defaults[k]]))); },
    async set(values) { Object.assign(data, structuredClone(values)); },
  };
}

// #15 follow-up, item 2: the scope buttons stay open while the log changes underneath
test('the scope pick re-reads the log: a row turned purchase or mixed, or replaced by a newer row, saves nothing', async () => {
  const row = actionRow(POST);
  const updates = {
    purchase: [{ ...row, purchase: true }],
    mixed: [{ ...row, mixed: true }],
    'newer row': [actionRow(POST, 'Chat A', { result: 'allowed' }), row],
    'another approval': [{ ...row, approvalId: 'appr-other' }],
    cleared: [],
  };
  for (const [name, log] of Object.entries(updates)) {
    const storage = fakeStorage(settingsWith());
    assert.equal(await AAT.trust(storage, fakeStorage({ log }), row, 'only'), null, name);
    assert.deepEqual([storage.data.actions, storage.data.strictActions], [[], []], name);
  }
  const storage = fakeStorage(settingsWith({ actions: [legacy('Other')] }));
  const change = await AAT.trust(storage, fakeStorage({ log: [{ ...row, result: 'handled' }] }), row, 'only');
  assert.ok(change);
  assert.deepEqual(storage.data.strictActions.map(a => [a.policy, a.chats]), [[POST, ['Chat A']]]);
  assert.deepEqual(storage.data.actions, [legacy('Other')]);
  assert.equal(await AAT.undo(storage, change), true);
  assert.deepEqual([storage.data.actions, storage.data.strictActions], [[legacy('Other')], []]);
});

test('Trusted and Undo show on the picked card\'s rows after a pick', () => {
  const older = actionRow(POST, 'Chat A', { result: 'handled' });
  const newest = actionRow(POST, 'Chat A', { result: 'pending' });
  const log = [newest, older];
  const plan = AAT.planTrust(settingsWith(), newest, 'only');
  const states = AAT.rowStates(apply(settingsWith(), plan), log, log, { last: plan.change });
  assert.deepEqual(log.map(e => states.get(e)), [{ state: 'trusted', undo: true }, { state: 'trusted', undo: false }]);
});
