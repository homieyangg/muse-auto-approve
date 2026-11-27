'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AAM = require('../shared.js');
const { optionMarks, marksFor } = require('../bridge.js');

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
// so the approval sits six fibers above each <button> and the key two above it
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
  return { hosts: buttons.map(b => b.host), card, row };
}

// Mirrors content.js: candidates from the attributes bridge.js would write, data path when any button got one
function pick(result, texts = TEXTS) {
  const candidates = result.marks.map((m, i) => ({ el: `button-${i}`, text: texts[i] || '', primary: i === 0, menu: false, kind: '', labelKind: '', scope: '', ...m }));
  const buttons = AAM.pickAllowButtons(candidates, candidates.some(c => c.kind));
  return buttons && { ...buttons, menuAlways: buttons.data && AAM.menuAlwaysAllowed(result.options) };
}

function read(id, options, keys = keysFor(id, options)) {
  const appr = approval(id, options);
  const { hosts } = cardTree(appr, keys);
  return optionMarks(appr, hosts);
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
  assert.deepEqual(pick(result), { always: 'button-1', once: 'button-0', data: true, menuAlways: true });
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
    assert.deepEqual(pick(result), { always: null, once: 'button-0', data: true, menuAlways: false }, name);
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
    assert.deepEqual(pick(result), { always: 'button-1', once: 'button-0', data: false, menuAlways: false });
  }
});

test('decisionOptions null: the card is reported missing and the text rules pick', () => {
  for (const options of [null, undefined]) {
    const appr = approval('appr-test-9', options);
    const { hosts } = cardTree(appr, ['appr-test-9-cta-0-allow_once', 'appr-test-9-cta-1-allow_always']);
    const result = optionMarks(appr, hosts);
    assert.equal(result.missing, true);
    assert.deepEqual(pick(result), { always: 'button-1', once: 'button-0', data: false, menuAlways: false });
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

test('a key further up than the bounded walk is not used', () => {
  const options = [ONCE];
  const appr = approval('appr-test-11', options);
  const { hosts, row } = cardTree(appr, [null]);
  row.key = 'appr-test-11-cta-0-allow_once';
  assert.equal(optionMarks(appr, hosts).marks[0].kind, 'allow_once');
  row.key = null;
  row.return.key = 'appr-test-11-cta-0-allow_once';
  assert.deepEqual(optionMarks(appr, hosts).marks, [null]);
});

test('a button whose own walk reaches another approval leaves every button unmarked', () => {
  const options = [ONCE, DENY];
  const appr = approval('appr-test-12', options);
  const other = cardTree(approval('appr-test-13', options), keysFor('appr-test-12', options));
  const own = cardTree(appr, keysFor('appr-test-12', options));
  const result = optionMarks(appr, [own.hosts[0], other.hosts[1]]);
  assert.equal(result.missing, true);
  assert.deepEqual(result.marks, [null, null]);
});

test('a stale fiber gives no attributes and is not reported missing', () => {
  const options = [ONCE, opt('allow_always', 'allow_always_scoped', 'destination'), DENY];
  const appr = approval('appr-test-14', options);
  const { hosts } = cardTree(appr, keysFor('appr-test-14', options));
  // A host fiber from an old render that is neither in the current tree nor the alternate of a current fiber
  const staleHost = { memoizedProps: {}, return: hosts[1].return, sibling: null };
  const result = optionMarks(appr, [hosts[0], staleHost, hosts[2]]);
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
  assert.equal(optionMarks(appr, [hosts[0], alternate, hosts[2]]).marks[1].kind, 'allow_always');
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

test('the pre-click re-check for a menu item needs the menu still allowed on fresh data', () => {
  const scoped = opt('allow_always', 'allow_always_scoped', 'destination');
  const visible = { missing: false, options: [ONCE, scoped, DENY].map(o => ({ kind: o.kind, labelKind: o.label.kind, scope: o.label.scope || '' })), marks: [{ kind: 'allow_once', labelKind: 'allow_once', scope: '' }, { kind: 'deny', labelKind: 'deny_for_this_task', scope: '' }] };
  const before = pick(visible, ['Allow once', 'Deny']);
  assert.deepEqual([before.always, before.once, before.menuAlways], [null, 'button-0', true]);
  assert.equal(AAM.samePick(before, before, AAM.MENU_PICK), true);
  assert.equal(AAM.samePick(before, { ...before, menuAlways: false }, AAM.MENU_PICK), false);
  assert.equal(AAM.samePick(before, { ...before, data: false }, AAM.MENU_PICK), false);
});

test('text fallback is unchanged: always, once, and the primary action button', () => {
  const text = (texts, primaryAt = -1) => AAM.pickAllowButtons(texts.map((t, i) => ({ el: `button-${i}`, text: t, primary: i === primaryAt, menu: false, kind: '' })), false);
  assert.deepEqual(text(['允許', '一律允許上傳到此網站', '拒絕']), { always: 'button-1', once: 'button-0', data: false });
  assert.deepEqual(text(['傳送', '不要傳送'], 0), { always: null, once: 'button-0', data: false });
  assert.equal(text(['拒絕']), null);
});
