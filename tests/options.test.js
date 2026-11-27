'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AAM = require('../shared.js');
const { optionMarks, marksFor, menuItemMark } = require('../bridge.js');

const OPTION_KINDS = ['allow_once', 'allow_always', 'deny', 'deny_always'];
const LABEL_KINDS = [
  'allow', 'allow_once', 'allow_for_this_task', 'allow_all_web_access_for_this_task', 'allow_for_this_scheduled_task',
  'allow_for_this_artifact', 'allow_for_your_feed', 'allow_always', 'allow_always_scoped', 'deny_for_this_task',
];
const SCOPES = ['destination', 'destination_domain', 'connector_all_actions'];

const opt = (kind, labelKind, scope) => ({ kind, label: scope ? { kind: labelKind, scope } : { kind: labelKind }, labelText: 'label' });
const ONCE = opt('allow_once', 'allow_once');
const DENY = opt('deny', 'deny_for_this_task');
const TEXTS = ['Allow once', 'Always allow uploads to this site', 'Deny'];

// Shape of a pending upload approval as read from muse's approvals data, with fake ids
function approval(id, decisionOptions) {
  return {
    approvalId: id,
    policySubject: 'connector.browser.page.upload',
    payloadPreview: 'Destination: https://upload.example',
    decisionOptions: Array.isArray(decisionOptions) ? decisionOptions.map(o => o.kind) : null,
    serverPresentation: { payloadType: 'connector', paymentProvider: null, purchasePreapproval: null, decisionOptions },
  };
}

const keysFor = (id, options) => options.map((o, i) => `${id}-cta-${i}-${o.kind}`);

function link(parent, children) {
  parent.child = children[0] || null;
  children.forEach((c, i) => { c.return = parent; c.sibling = children[i + 1] || null; });
}

// Fabricated current React tree: root -> card (props.approval) -> two wrappers -> row -> Button (key) -> inner -> <button>,
// so the approval sits six fibers above each <button> and the key two above it. A null key is a keyless button
function cardTree(appr, keys) {
  const fiberRoot = {};
  const root = { stateNode: fiberRoot, memoizedProps: {} };
  fiberRoot.current = root;
  const card = { memoizedProps: { approval: appr } };
  const outer = { memoizedProps: {} };
  const inner = { memoizedProps: {} };
  const row = { memoizedProps: {} };
  link(root, [card]);
  link(card, [outer]);
  link(outer, [inner]);
  link(inner, [row]);
  const buttons = keys.map(key => {
    const button = { key, memoizedProps: { variant: 'primary' } };
    const span = { memoizedProps: {} };
    const host = { memoizedProps: { type: 'button' } };
    link(button, [span]);
    link(span, [host]);
    return { button, host };
  });
  link(row, buttons.map(b => b.button));
  return { hosts: buttons.map(b => b.host), card, row, root };
}

const asButtons = (hosts, primaryAt = -1) => hosts.map((fiber, i) => ({ fiber, primary: i === primaryAt }));
const core = p => p && { always: p.always, once: p.once, data: p.data };

// Mirrors content.js: candidates from the attributes bridge.js would write, data path when any button got one
function pick(result, texts = TEXTS) {
  const candidates = result.marks.map((m, i) => ({ el: `button-${i}`, text: texts[i] || '', primary: i === 0, menu: false, kind: '', labelKind: '', scope: '', ...m }));
  const buttons = AAM.pickAllowButtons(candidates, candidates.some(c => c.kind));
  return buttons && { ...buttons, ...AAM.menuPlan(buttons.data ? result.options : null) };
}

function read(id, options, keys = keysFor(id, options), primaryAt = -1) {
  const appr = approval(id, options);
  const { hosts } = cardTree(appr, keys);
  return optionMarks(appr, asButtons(hosts, primaryAt));
}

test('the live upload card: each button gets its option, label kind and scope', () => {
  const options = [ONCE, opt('allow_always', 'allow_always_scoped', 'destination'), DENY];
  const result = read('appr-test-1', options);
  assert.equal(result.missing, false);
  assert.deepEqual(result.marks, [
    { kind: 'allow_once', labelKind: 'allow_once', scope: '' },
    { kind: 'allow_always', labelKind: 'allow_always_scoped', scope: 'destination' },
    { kind: 'deny', labelKind: 'deny_for_this_task', scope: '' },
  ]);
  assert.deepEqual(pick(result), { always: 'button-1', once: 'button-0', data: true, alwaysInMenu: true, menuTextOk: true });
});

test('every option kind is read; deny kinds are never picked', () => {
  for (const kind of OPTION_KINDS) {
    const options = [opt(kind, kind === 'allow_always' ? 'allow_always' : kind === 'allow_once' ? 'allow_once' : 'deny_for_this_task')];
    const result = read('appr-test-2', options);
    assert.equal(result.marks[0].kind, kind);
    const buttons = pick(result, ['Allow']);
    if (kind === 'allow_once') assert.equal(buttons.once, 'button-0');
    else if (kind === 'allow_always') assert.equal(buttons.always, 'button-0');
    else assert.equal(buttons, null, kind);
  }
});

test('every label kind is read and only the whitelisted ones are picked as always', () => {
  for (const labelKind of LABEL_KINDS) {
    const scope = labelKind === 'allow_always_scoped' ? 'destination' : undefined;
    const result = read('appr-test-3', [ONCE, opt('allow_always', labelKind, scope), DENY]);
    assert.equal(result.marks[1].labelKind, labelKind);
    const always = ['allow_always', 'allow_always_scoped'].includes(labelKind) ? 'button-1' : null;
    assert.deepEqual([pick(result).always, pick(result).once], [always, 'button-0'], labelKind);
  }
});

test('every allow-once label kind except the broad one picks the once button', () => {
  for (const labelKind of LABEL_KINDS.filter(k => k.startsWith('allow') && !k.startsWith('allow_always'))) {
    const buttons = pick(read('appr-test-4', [opt('allow_once', labelKind), DENY]));
    if (labelKind === 'allow_all_web_access_for_this_task') assert.equal(buttons, null, labelKind);
    else assert.equal(buttons.once, 'button-0', labelKind);
  }
});

test('every scope is read; only single-site scopes are picked as always', () => {
  for (const scope of SCOPES) {
    const result = read('appr-test-5', [ONCE, opt('allow_always', 'allow_always_scoped', scope), DENY]);
    assert.equal(result.marks[1].scope, scope);
    assert.equal(pick(result).always, scope === 'connector_all_actions' ? null : 'button-1', scope);
  }
});

test('broad, unknown kind and unknown scope: always is not picked, allow once is', () => {
  const cases = {
    connector_all_actions: opt('allow_always', 'allow_always_scoped', 'connector_all_actions'),
    all_web_access: opt('allow_always', 'allow_all_web_access_for_this_task'),
    unknown_kind: opt('allow_forever', 'allow_always'),
    unknown_label_kind: opt('allow_always', 'allow_everything'),
    unknown_scope: opt('allow_always', 'allow_always_scoped', 'workspace'),
    plain_always_with_scope: opt('allow_always', 'allow_always', 'workspace'),
  };
  for (const [name, broad] of Object.entries(cases)) {
    const result = read('appr-test-6', [ONCE, broad, DENY]);
    assert.equal(result.missing, false, name);
    assert.deepEqual(pick(result), { always: null, once: 'button-0', data: true, alwaysInMenu: false, menuTextOk: false }, name);
  }
});

test('no allow once option and a non-whitelisted always: nothing is picked', () => {
  for (const broad of [opt('allow_always', 'allow_always_scoped', 'connector_all_actions'), opt('allow_always', 'allow_all_web_access_for_this_task'), opt('allow_forever', 'allow_always')]) {
    assert.equal(pick(read('appr-test-7', [broad, DENY]), ['Always allow', 'Deny']), null);
  }
});

test('a key with another approval id or another kind at its index leaves every button unmarked', () => {
  const options = [ONCE, opt('allow_always', 'allow_always_scoped', 'destination'), DENY];
  const wrongId = keysFor('appr-test-8', options).map((k, i) => (i === 1 ? k.replace('appr-test-8', 'appr-other') : k));
  const wrongKind = ['appr-test-8-cta-0-allow_once', 'appr-test-8-cta-1-deny', 'appr-test-8-cta-2-deny'];
  const wrongIndex = ['appr-test-8-cta-0-allow_once', 'appr-test-8-cta-7-allow_always', 'appr-test-8-cta-2-deny'];
  for (const keys of [wrongId, wrongKind, wrongIndex]) {
    const result = read('appr-test-8', options, keys);
    assert.equal(result.missing, true);
    assert.equal(result.options, null);
    assert.deepEqual(result.marks, [null, null, null]);
    // Falls back to the text rules, unchanged
    assert.deepEqual(pick(result), { always: 'button-1', once: 'button-0', data: false, alwaysInMenu: false, menuTextOk: false });
  }
});

test('decisionOptions null: the card is reported missing and the text rules pick', () => {
  for (const options of [null, undefined]) {
    const appr = approval('appr-test-9', options);
    const { hosts } = cardTree(appr, ['appr-test-9-cta-0-allow_once', 'appr-test-9-cta-1-allow_always']);
    const result = optionMarks(appr, asButtons(hosts));
    assert.equal(result.missing, true);
    assert.deepEqual(pick(result), { always: 'button-1', once: 'button-0', data: false, alwaysInMenu: false, menuTextOk: false });
  }
});

test('buttons without a decision key stay unmarked; no keyed button at all is reported missing', () => {
  const options = [ONCE, DENY];
  const mixed = read('appr-test-10', options, ['appr-test-10-cta-0-allow_once', null, 'appr-test-10-cta-1-deny']);
  assert.deepEqual(mixed.marks.map(m => m?.kind ?? null), ['allow_once', null, 'deny']);
  const none = read('appr-test-10', options, [null, null]);
  assert.equal(none.missing, true);
  assert.deepEqual(none.marks, [null, null]);
});

test('the key is searched upward below the approval component, not at a fixed depth', () => {
  const options = [ONCE];
  const appr = approval('appr-test-11', options);
  const { hosts, row, card } = cardTree(appr, [null]);
  row.key = 'appr-test-11-cta-0-allow_once';
  assert.equal(optionMarks(appr, asButtons(hosts)).marks[0].kind, 'allow_once');
  row.key = null;
  row.return.key = 'appr-test-11-cta-0-allow_once';
  assert.equal(optionMarks(appr, asButtons(hosts)).marks[0].kind, 'allow_once');
  row.return.key = null;
  card.return.key = 'appr-test-11-cta-0-allow_once';
  const above = optionMarks(appr, asButtons(hosts));
  assert.deepEqual([above.missing, above.marks], [true, [null]]);
});

test('a button whose own walk reaches another approval leaves every button unmarked', () => {
  const options = [ONCE, DENY];
  const appr = approval('appr-test-12', options);
  const other = cardTree(approval('appr-test-13', options), keysFor('appr-test-12', options));
  const own = cardTree(appr, keysFor('appr-test-12', options));
  const result = optionMarks(appr, asButtons([own.hosts[0], other.hosts[1]]));
  assert.equal(result.missing, true);
  assert.deepEqual(result.marks, [null, null]);
});

test('a stale fiber gives no attributes and is not reported missing', () => {
  const options = [ONCE, opt('allow_always', 'allow_always_scoped', 'destination'), DENY];
  const appr = approval('appr-test-14', options);
  const { hosts } = cardTree(appr, keysFor('appr-test-14', options));
  // A host fiber from an old render that is neither in the current tree nor the alternate of a current fiber
  const staleHost = { memoizedProps: {}, return: hosts[1].return, sibling: null };
  const result = optionMarks(appr, asButtons([hosts[0], staleHost, hosts[2]]));
  assert.equal(result.missing, false);
  assert.deepEqual(result.marks, [null, null, null]);
  assert.equal(marksFor(staleHost), null);
});

test('the button walk reads the current side when the DOM points at the alternate', () => {
  const options = [ONCE, opt('allow_always', 'allow_always', undefined), DENY];
  const appr = approval('appr-test-15', options);
  const { hosts } = cardTree(appr, keysFor('appr-test-15', options));
  const alternate = { memoizedProps: {}, alternate: hosts[1], return: hosts[1].return };
  hosts[1].alternate = alternate;
  assert.equal(optionMarks(appr, asButtons([hosts[0], alternate, hosts[2]])).marks[1].kind, 'allow_always');
});

test('the menu is only opened when every option of the approval is known and one is a single-site always', () => {
  const scoped = opt('allow_always', 'allow_always_scoped', 'destination_domain');
  const toList = options => options.map(o => ({ kind: o.kind, labelKind: o.label.kind, scope: o.label.scope || '' }));
  assert.equal(AAM.menuAlwaysAllowed(toList([ONCE, scoped, DENY])), true);
  assert.equal(AAM.menuAlwaysAllowed(toList([ONCE, scoped, opt('allow_always', 'allow_always_scoped', 'connector_all_actions'), DENY])), false);
  assert.equal(AAM.menuAlwaysAllowed(toList([ONCE, scoped, opt('allow_once', 'allow_all_web_access_for_this_task')])), false);
  assert.equal(AAM.menuAlwaysAllowed(toList([ONCE, DENY])), false);
  assert.equal(AAM.menuAlwaysAllowed(null), false);
});

test('the pre-click re-check refuses when fresh attributes no longer back the target', () => {
  const options = [ONCE, opt('allow_always', 'allow_always_scoped', 'destination'), DENY];
  const before = pick(read('appr-test-16', options));
  assert.equal(AAM.samePick(before, pick(read('appr-test-16', options)), 'button-1'), true);
  // Fresh walk failed: the stale attribute must not authorize the click, even though the text would match
  const stale = { missing: false, options: null, marks: [null, null, null] };
  assert.equal(AAM.samePick(before, pick(stale), 'button-1'), false);
  // The option at that button became a broad one
  const broader = read('appr-test-16', [ONCE, opt('allow_always', 'allow_always_scoped', 'connector_all_actions'), DENY]);
  assert.equal(AAM.samePick(before, pick(broader), 'button-1'), false);
  assert.equal(AAM.samePick(before, pick(broader), 'button-0'), true);
  assert.equal(AAM.samePick(before, null, 'button-0'), false);
});

test('text fallback is unchanged: always, once, and the primary action button', () => {
  const text = (texts, primaryAt = -1) => AAM.pickAllowButtons(texts.map((t, i) => ({ el: `button-${i}`, text: t, primary: i === primaryAt, menu: false, kind: '' })), false);
  assert.deepEqual(text(['允許', '一律允許上傳到此網站', '拒絕']), { always: 'button-1', once: 'button-0', data: false });
  assert.deepEqual(text(['傳送', '不要傳送'], 0), { always: null, once: 'button-0', data: false });
  assert.equal(text(['拒絕']), null);
});

// Approvals panel (compact layout): keyless primary button, `<id>-compact-deny-<i>-<kind>` on deny
const SCOPED = opt('allow_always', 'allow_always_scoped', 'destination');
const PANEL_TEXTS = ['允許一次', '更多允許選項', '拒絕'];

test('panel surface: the keyless primary is allow once when it is the first allow option, deny is read from its compact key', () => {
  const result = read('appr-test-20', [ONCE, SCOPED, DENY], [null, 'appr-test-20-compact-deny-0-deny'], 0);
  assert.equal(result.missing, false);
  assert.deepEqual(result.marks, [
    { kind: 'allow_once', labelKind: 'allow_once', scope: '' },
    { kind: 'deny', labelKind: 'deny_for_this_task', scope: '' },
  ]);
  assert.deepEqual(pick(result, PANEL_TEXTS), { always: null, once: 'button-0', data: true, alwaysInMenu: true, menuTextOk: true });
});

test('panel surface: a keyless primary the data does not confirm leaves the item to the text rules', () => {
  const firstAlways = read('appr-test-21', [SCOPED, ONCE, DENY], [null, 'appr-test-21-compact-deny-0-deny'], 0);
  assert.deepEqual([firstAlways.missing, firstAlways.marks], [true, [null, null]]);
  assert.deepEqual(core(pick(firstAlways, PANEL_TEXTS)), { always: null, once: 'button-0', data: false });
  // Without a keyed button next to it, the keyless primary alone is not trusted either
  const alone = read('appr-test-21', [ONCE, DENY], [null], 0);
  assert.deepEqual([alone.missing, alone.marks], [true, [null]]);
  // A keyless button that is not the primary stays unmarked
  const plain = read('appr-test-21', [ONCE, DENY], [null, 'appr-test-21-compact-deny-0-deny']);
  assert.deepEqual(plain.marks, [null, { kind: 'deny', labelKind: 'deny_for_this_task', scope: '' }]);
});

test('panel surface: a compact key that does not match the data leaves every button unmarked', () => {
  for (const key of ['appr-test-22-compact-deny-0-allow_once', 'appr-test-22-compact-deny-1-deny', 'appr-other-compact-deny-0-deny']) {
    const result = read('appr-test-22', [ONCE, SCOPED, DENY], [null, key], 0);
    assert.deepEqual([result.missing, result.marks], [true, [null, null]], key);
  }
});

// Menu items are drawn in a portal: root -> portal -> twelve wrappers -> keyed item component -> wrappers -> menuitem
function menuTree(key, { depth = 12, approvalAbove = null } = {}) {
  const fiberRoot = {};
  const root = { stateNode: fiberRoot, memoizedProps: {} };
  fiberRoot.current = root;
  const portal = { memoizedProps: approvalAbove ? { approval: approvalAbove } : {} };
  link(root, [portal]);
  const keyed = { key, memoizedProps: { label: 'label', disabled: false } };
  link(portal, [keyed]);
  let f = keyed;
  for (let i = 0; i < depth; i++) {
    const next = { memoizedProps: {} };
    link(f, [next]);
    f = next;
  }
  return f;
}

const pendingOf = (...approvals) => id => approvals.find(a => a.approvalId === id);

test('a menu item maps to its option through the compact-allow key and the pending list', () => {
  const appr = approval('appr-test-23', [ONCE, SCOPED, DENY]);
  const mark = menuItemMark(menuTree('appr-test-23-compact-allow-0-allow_always'), undefined, pendingOf(appr));
  assert.deepEqual(mark, { approvalId: 'appr-test-23', kind: 'allow_always', labelKind: 'allow_always_scoped', scope: 'destination' });
  assert.equal(AAM.menuItemAlways(mark, 'appr-test-23'), true);
  assert.equal(AAM.menuItemAlways(mark, 'appr-other'), false);
  // The approval reached by walking up is used when present
  const above = menuItemMark(menuTree('appr-test-23-compact-allow-0-allow_always', { approvalAbove: appr }), undefined, () => null);
  assert.equal(above.scope, 'destination');
});

test('menu items for broad or unknown options are marked but never picked as always', () => {
  for (const broad of [opt('allow_always', 'allow_always_scoped', 'connector_all_actions'), opt('allow_always', 'allow_all_web_access_for_this_task'), opt('allow_always', 'allow_always_scoped', 'workspace')]) {
    const appr = approval('appr-test-24', [ONCE, broad, DENY]);
    const mark = menuItemMark(menuTree('appr-test-24-compact-allow-0-allow_always'), undefined, pendingOf(appr));
    assert.equal(mark.kind, 'allow_always');
    assert.equal(AAM.menuItemAlways(mark, 'appr-test-24'), false);
  }
});

test('a menu item that can not be matched gets no mark', () => {
  const appr = approval('appr-test-25', [ONCE, SCOPED, DENY]);
  const cases = {
    'not pending': menuItemMark(menuTree('appr-test-25-compact-allow-0-allow_always'), undefined, () => undefined),
    'kind at index differs': menuItemMark(menuTree('appr-test-25-compact-allow-0-allow_once'), undefined, pendingOf(appr)),
    'index out of range': menuItemMark(menuTree('appr-test-25-compact-allow-1-allow_always'), undefined, pendingOf(appr)),
    'other approval above': menuItemMark(menuTree('appr-test-25-compact-allow-0-allow_always', { approvalAbove: approval('appr-other', [ONCE, SCOPED]) }), undefined, pendingOf(appr)),
    'key too far up': menuItemMark(menuTree('appr-test-25-compact-allow-0-allow_always', { depth: 40 }), undefined, pendingOf(appr)),
    'no decisionOptions': menuItemMark(menuTree('appr-test-25-compact-allow-0-allow_always'), undefined, pendingOf(approval('appr-test-25', null))),
    'cta key': menuItemMark(menuTree('appr-test-25-cta-1-allow_always'), undefined, pendingOf(appr)),
    stale: menuItemMark({ memoizedProps: {}, return: { memoizedProps: {} } }, undefined, pendingOf(appr)),
  };
  for (const [name, mark] of Object.entries(cases)) assert.equal(mark, null, name);
});

test('two options of the same kind that the compact key can not tell apart are not matched', () => {
  const appr = approval('appr-test-26', [ONCE, SCOPED, opt('allow_always', 'allow_always_scoped', 'connector_all_actions'), DENY]);
  for (const index of [0, 1]) assert.equal(menuItemMark(menuTree(`appr-test-26-compact-allow-${index}-allow_always`), undefined, pendingOf(appr)), null);
  const twins = approval('appr-test-27', [ONCE, SCOPED, SCOPED, DENY]);
  assert.equal(menuItemMark(menuTree('appr-test-27-compact-allow-1-allow_always'), undefined, pendingOf(twins)).scope, 'destination');
});

test('menu pick: marked items decide alone, unmarked menus use text only when every option is known', () => {
  const always = { approvalId: 'appr-test-28', kind: 'allow_always', labelKind: 'allow_always_scoped', scope: 'destination' };
  const broad = { ...always, scope: 'connector_all_actions' };
  const item = (el, text, option = null) => ({ el, text, option });
  assert.deepEqual(AAM.pickMenuItem([item('m0', 'Always allow all actions', broad), item('m1', 'x', always)], 'appr-test-28', true, false), { item: 'm1', data: true });
  // The text would match, but the data says the only always item is broad
  assert.equal(AAM.pickMenuItem([item('m0', 'Always allow all actions', broad)], 'appr-test-28', true, true), null);
  assert.equal(AAM.pickMenuItem([item('m0', 'Always allow uploads to this site')], 'appr-test-28', true, false), null);
  assert.deepEqual(AAM.pickMenuItem([item('m0', 'Always allow uploads to this site')], 'appr-test-28', true, true), { item: 'm0', data: false });
  assert.deepEqual(AAM.pickMenuItem([item('m0', '一律允許上傳到此網站')], '', false, false), { item: 'm0', data: false });
});

test('the pre-click re-check for a menu item uses the fresh mark of that item', () => {
  const before = pick(read('appr-test-29', [ONCE, SCOPED, DENY], [null, 'appr-test-29-compact-deny-0-deny'], 0), PANEL_TEXTS);
  const fresh = { approvalId: 'appr-test-29', kind: 'allow_always', labelKind: 'allow_always_scoped', scope: 'destination' };
  const menu = option => ({ menu: true, data: true, approvalId: 'appr-test-29', option });
  assert.equal(AAM.samePick(before, before, menu(fresh)), true);
  assert.equal(AAM.samePick(before, before, menu(null)), false);
  assert.equal(AAM.samePick(before, before, menu({ ...fresh, scope: 'connector_all_actions' })), false);
  assert.equal(AAM.samePick(before, before, menu({ ...fresh, approvalId: 'appr-other' })), false);
  assert.equal(AAM.samePick(before, { ...before, data: false }, menu(fresh)), false);
  // A menu item picked by text needs the menu still allowed for text on fresh data
  const text = { menu: true, data: false, approvalId: 'appr-test-29', option: null };
  assert.equal(AAM.samePick(before, before, text), true);
  assert.equal(AAM.samePick(before, { ...before, menuTextOk: false }, text), false);
});
