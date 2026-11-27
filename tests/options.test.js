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

// Mirrors content.js: candidates from the attributes bridge.js would write, picked under the card state it wrote
function pick(result, texts = TEXTS, primaryAt = 0) {
  const candidates = result.marks.map((m, i) => ({ el: `button-${i}`, text: texts[i] || '', primary: i === primaryAt, menu: false, kind: '', labelKind: '', scope: '', ...m }));
  return AAM.pickAllowButtons(candidates, result.state || '', result.options);
}
const kinds = result => result.marks.map(m => m?.kind ?? null);

function read(id, options, keys = keysFor(id, options), primaryAt = -1) {
  const appr = approval(id, options);
  const { hosts } = cardTree(appr, keys);
  return optionMarks(appr, asButtons(hosts, primaryAt));
}


const SCOPED = opt('allow_always', 'allow_always_scoped', 'destination');
const BROAD = opt('allow_always', 'allow_always_scoped', 'connector_all_actions');
const PANEL_TEXTS = ['允許一次', '更多允許選項', '拒絕'];
const markList = options => options.map(o => ({ kind: o.kind, labelKind: o.label.kind, scope: o.label.scope || '' }));

test('the live upload card: each button gets its option, label kind and scope', () => {
  const result = read('appr-test-1', [ONCE, SCOPED, DENY]);
  assert.equal(result.missing, false);
  assert.deepEqual(result.marks, [
    { kind: 'allow_once', labelKind: 'allow_once', scope: '' },
    { kind: 'allow_always', labelKind: 'allow_always_scoped', scope: 'destination' },
    { kind: 'deny', labelKind: 'deny_for_this_task', scope: '' },
  ]);
  const p = pick(result);
  assert.deepEqual(core(p), { always: 'button-1', once: 'button-0', data: true });
  assert.equal(result.state, 'clean');
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
    connector_all_actions: BROAD,
    all_web_access: opt('allow_always', 'allow_all_web_access_for_this_task'),
    unknown_kind: opt('allow_forever', 'allow_always'),
    unknown_label_kind: opt('allow_always', 'allow_everything'),
    unknown_scope: opt('allow_always', 'allow_always_scoped', 'workspace'),
    plain_always_with_scope: opt('allow_always', 'allow_always', 'workspace'),
  };
  for (const [name, broad] of Object.entries(cases)) {
    const result = read('appr-test-6', [ONCE, broad, DENY]);
    assert.equal(result.missing, false, name);
    const p = pick(result);
    assert.deepEqual(core(p), { always: null, once: 'button-0', data: true }, name);
    assert.equal(p.alwaysInMenu, false, name);
  }
});

// Review P2
test('a scope or label kind that is not a string is unknown, never "no scope"', () => {
  for (const scope of [{ type: 'destination' }, ['destination'], 1, true]) {
    const options = [ONCE, { kind: 'allow_always', label: { kind: 'allow_always', scope } }, DENY];
    const result = read('appr-test-40', options);
    assert.equal(result.marks[1].scope, '?');
    assert.equal(pick(result).always, null, JSON.stringify(scope));
  }
  const objectLabel = read('appr-test-40', [ONCE, { kind: 'allow_always', label: { kind: { name: 'allow_always' } } }, DENY]);
  assert.equal(pick(objectLabel).always, null);
});

test('no allow once option and a non-whitelisted always: nothing is picked', () => {
  for (const broad of [BROAD, opt('allow_always', 'allow_all_web_access_for_this_task'), opt('allow_forever', 'allow_always')]) {
    assert.equal(pick(read('appr-test-7', [broad, DENY]), ['Always allow', 'Deny']), null);
  }
});

// A read with any anomaly allows only this approval's confirmed once button: never always, never the menu, never text
test('a key that does not map makes the card anomalous: only the confirmed once is picked', () => {
  const options = [ONCE, SCOPED, DENY];
  const wrongKind = ['appr-test-8-cta-0-allow_once', 'appr-test-8-cta-1-deny', 'appr-test-8-cta-2-deny'];
  const wrongIndex = ['appr-test-8-cta-0-allow_once', 'appr-test-8-cta-7-allow_always', 'appr-test-8-cta-2-deny'];
  for (const keys of [wrongKind, wrongIndex]) {
    const result = read('appr-test-8', options, keys);
    assert.deepEqual([result.state, result.missing], ['anomalous', true]);
    assert.deepEqual(result.options, markList(options));
    assert.deepEqual(kinds(result), ['allow_once', null, 'deny']);
    const p = pick(result);
    assert.deepEqual(core(p), { always: null, once: 'button-0', data: true });
    assert.equal(p.alwaysInMenu, false);
  }
  // Nothing of this approval confirmed: nothing is picked, the always text included
  const unconfirmed = read('appr-test-8', options, ['appr-test-8-cta-0-deny', 'appr-test-8-cta-7-allow_always']);
  assert.equal(pick(unconfirmed), null);
});

// Review P1-a, second case, original input: a foreign deny next to a broad always
test('a key mismatch never hands a broad option to the text rules', () => {
  const options = [ONCE, BROAD, DENY];
  const keys = ['appr-test-41-cta-0-allow_once', 'appr-test-41-cta-1-allow_always', 'appr-other-cta-2-deny'];
  const result = read('appr-test-41', options, keys);
  assert.deepEqual([result.state, result.missing], ['anomalous', true]);
  assert.deepEqual(kinds(result), ['allow_once', 'allow_always', null]);
  const p = pick(result, ['Allow once', 'Always allow all actions', 'Deny']);
  assert.deepEqual(core(p), { always: null, once: 'button-0', data: true });
  assert.equal(p.alwaysInMenu, false);
  const fresh = pick(result, ['Allow once', 'Always allow all actions', 'Deny']);
  assert.equal(AAM.samePick(p, fresh, 'button-1'), false);
});

test('a mismatched own key next to a broad always never picks always', () => {
  const options = [ONCE, BROAD, DENY];
  const keys = ['appr-test-41-cta-0-allow_once', 'appr-test-41-cta-1-allow_always', 'appr-test-41-cta-2-allow_once'];
  const p = pick(read('appr-test-41', options, keys), ['Allow once', 'Always allow all actions', 'Deny']);
  assert.deepEqual(core(p), { always: null, once: 'button-0', data: true });
  assert.equal(p.alwaysInMenu, false);
});

// Codex re-review 2, P1: this card's safe options must never authorise another approval's button
test('a button keyed to another approval makes the card anomalous: never clicked, only a confirmed once is picked', () => {
  const options = [ONCE, SCOPED, DENY];
  const texts = ['Allow once', 'Always allow uploads to this site', 'Deny'];
  const foreignAlways = ['appr-test-46-cta-0-allow_once', 'appr-other-cta-1-allow_always', 'appr-test-46-cta-2-deny'];
  const result = read('appr-test-46', options, foreignAlways);
  // Codex re-review 3, P2: a valid own once next to the foreign key keeps the mismatch flag
  assert.deepEqual([result.state, result.missing], ['anomalous', true]);
  assert.deepEqual(kinds(result), ['allow_once', null, 'deny']);
  const p = pick(result, texts);
  assert.deepEqual(core(p), { always: null, once: 'button-0', data: true });
  assert.equal(p.alwaysInMenu, false);
  // This card's own buttons are not confirmed (keyless once, bad own key): nothing is picked, not even by text
  for (const keys of [[null, 'appr-other-cta-1-allow_always', 'appr-test-46-cta-2-deny'], ['appr-test-46-cta-0-deny', 'appr-other-cta-1-allow_always', 'appr-test-46-cta-2-deny']]) {
    assert.equal(pick(read('appr-test-46', options, keys), texts), null, JSON.stringify(keys));
  }
  // A fresh read in the other state does not back the earlier pick
  const clean = pick(read('appr-test-46', options), texts);
  assert.equal(AAM.samePick(p, clean, 'button-0'), false);
  assert.equal(AAM.samePick(clean, p, 'button-0'), false);
});

// Codex re-review 3, P1: an anomaly is never reset by a later sibling, whatever the order
test('once a read finds an anomaly, no sibling result downgrades it', () => {
  const options = [ONCE, SCOPED, DENY];
  const appr = approval('appr-test-47', options);
  const { hosts } = cardTree(appr, ['appr-test-47-cta-0-allow_once', 'appr-other-cta-1-allow_always', 'appr-test-47-cta-2-deny']);
  const stale = { memoizedProps: {}, return: hosts[2].return, sibling: null };
  for (const order of [[hosts[0], hosts[1], stale], [stale, hosts[1], hosts[0]], [hosts[1], hosts[0], hosts[2]]]) {
    const result = optionMarks(appr, asButtons(order));
    assert.deepEqual([result.state, result.missing], ['anomalous', true]);
    assert.equal(pick(result, ['Allow once', 'Always allow uploads to this site', 'Deny']).always, null);
  }
});

// Review P1-a, first case
test('a primary the data does not confirm is never clicked through the text rules', () => {
  // Panel card whose only allow option is broad: the keyless primary, then a deny with a bad key
  const options = [BROAD, DENY];
  for (const keys of [[null, 'appr-test-42-compact-deny-0-deny'], [null, 'appr-other-compact-deny-0-deny'], [null]]) {
    const result = read('appr-test-42', options, keys, 0);
    assert.equal(pick(result, ['Always allow all actions', 'Deny']), null, JSON.stringify(keys));
  }
  // Text-only primary label ("Send"): main clicked it by its primary attribute; with data saying the first allow is broad it is vetoed
  const send = read('appr-test-42', [opt('allow_always', 'allow_for_this_task'), DENY], [null], 0);
  assert.equal(pick(send, ['Send']), null);
});

test('decisionOptions null: the card is reported missing and main\'s text rules pick', () => {
  for (const options of [null, undefined]) {
    const appr = approval('appr-test-9', options);
    const { hosts } = cardTree(appr, ['appr-test-9-cta-0-allow_once', 'appr-test-9-cta-1-allow_always']);
    const result = optionMarks(appr, asButtons(hosts));
    assert.equal(result.missing, true);
    assert.equal(result.options, null);
    const p = pick(result);
    assert.deepEqual(core(p), { always: 'button-1', once: 'button-0', data: false });
    assert.equal(result.state, '');
  }
});

test('buttons without a decision key stay unmarked; no keyed button at all is reported missing', () => {
  const options = [ONCE, DENY];
  const mixed = read('appr-test-10', options, ['appr-test-10-cta-0-allow_once', null, 'appr-test-10-cta-1-deny']);
  assert.deepEqual(mixed.marks.map(m => m?.kind ?? null), ['allow_once', null, 'deny']);
  assert.equal(mixed.state, 'clean');
  const none = read('appr-test-10', options, [null, null]);
  assert.deepEqual([none.state, none.missing], ['anomalous', true]);
  assert.deepEqual(none.marks, [null, null]);
});

test('the key is searched upward below the approval component, not at a fixed depth', () => {
  const appr = approval('appr-test-11', [ONCE]);
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

test('a button whose own walk reaches another approval makes the card anomalous and is left unmarked', () => {
  const options = [ONCE, DENY];
  const appr = approval('appr-test-12', options);
  const other = cardTree(approval('appr-test-13', options), keysFor('appr-test-12', options));
  const own = cardTree(appr, keysFor('appr-test-12', options));
  const result = optionMarks(appr, asButtons([own.hosts[0], other.hosts[1]]));
  assert.equal(result.state, 'anomalous');
  assert.deepEqual(kinds(result), ['allow_once', null]);
  const keyless = optionMarks(appr, asButtons([other.hosts[0]], 0));
  assert.deepEqual([keyless.state, keyless.marks], ['anomalous', [null]]);
});

test('a stale button fiber makes the card anomalous and leaves that button unmarked', () => {
  const options = [ONCE, SCOPED, DENY];
  const appr = approval('appr-test-14', options);
  const { hosts } = cardTree(appr, keysFor('appr-test-14', options));
  const staleHost = { memoizedProps: {}, return: hosts[1].return, sibling: null };
  const result = optionMarks(appr, asButtons([hosts[0], staleHost, hosts[2]]));
  assert.equal(result.state, 'anomalous');
  assert.deepEqual(kinds(result), ['allow_once', null, 'deny']);
  assert.equal(marksFor(staleHost), null);
});

test('the button walk reads the current side when the DOM points at the alternate', () => {
  const options = [ONCE, opt('allow_always', 'allow_always'), DENY];
  const appr = approval('appr-test-15', options);
  const { hosts } = cardTree(appr, keysFor('appr-test-15', options));
  const alternate = { memoizedProps: {}, alternate: hosts[1], return: hosts[1].return };
  hosts[1].alternate = alternate;
  assert.equal(optionMarks(appr, asButtons([hosts[0], alternate, hosts[2]])).marks[1].kind, 'allow_always');
});

test('the pre-click re-check refuses when fresh attributes no longer back the target', () => {
  const options = [ONCE, SCOPED, DENY];
  const before = pick(read('appr-test-16', options));
  assert.equal(AAM.samePick(before, pick(read('appr-test-16', options)), 'button-1'), true);
  const stale = { missing: false, options: null, marks: [null, null, null] };
  assert.equal(AAM.samePick(before, pick(stale), 'button-1'), false);
  const broader = read('appr-test-16', [ONCE, BROAD, DENY]);
  assert.equal(AAM.samePick(before, pick(broader), 'button-1'), false);
  assert.equal(AAM.samePick(before, pick(broader), 'button-0'), true);
  assert.equal(AAM.samePick(before, null, 'button-0'), false);
});

// Review P1-d
test('"just this once" never clicks an always button once data has been read', () => {
  const onlyAlways = pick(read('appr-test-43', [SCOPED, DENY]), ['Always allow uploads to this site', 'Deny']);
  assert.equal(onlyAlways.always, 'button-0');
  assert.equal(AAM.clickTarget(onlyAlways, true), 'button-0');
  assert.equal(AAM.clickTarget(onlyAlways, false), null);
  // Main's text-only fallback is unchanged when no data was read
  const textOnly = AAM.pickAllowButtons([{ el: 'b0', text: 'Always allow', primary: false, menu: false, kind: '' }], false, null);
  assert.equal(AAM.clickTarget(textOnly, false), 'b0');
  assert.equal(AAM.clickTarget(null, true), null);
});

test('text fallback without data is main\'s: always, once, and the primary action button', () => {
  const text = (texts, primaryAt = -1) => core(AAM.pickAllowButtons(texts.map((t, i) => ({ el: `button-${i}`, text: t, primary: i === primaryAt, menu: false, kind: '' })), false));
  assert.deepEqual(text(['允許', '一律允許上傳到此網站', '拒絕']), { always: 'button-1', once: 'button-0', data: false });
  assert.deepEqual(text(['傳送', '不要傳送'], 0), { always: null, once: 'button-0', data: false });
  assert.equal(text(['拒絕']), null);
});

test('panel surface: the keyless primary is allow once when it is the first allow option, deny is read from its compact key', () => {
  const result = read('appr-test-20', [ONCE, SCOPED, DENY], [null, 'appr-test-20-compact-deny-0-deny'], 0);
  assert.equal(result.missing, false);
  assert.deepEqual(result.marks, [
    { kind: 'allow_once', labelKind: 'allow_once', scope: '' },
    { kind: 'deny', labelKind: 'deny_for_this_task', scope: '' },
  ]);
  const p = pick(result, PANEL_TEXTS);
  assert.deepEqual(core(p), { always: null, once: 'button-0', data: true });
  assert.equal(p.alwaysInMenu, true);
});

test('panel surface: a keyless primary the data does not confirm stays unmarked without failing the item', () => {
  const firstAlways = read('appr-test-21', [SCOPED, ONCE, DENY], [null, 'appr-test-21-compact-deny-0-deny'], 0);
  assert.equal(firstAlways.missing, false);
  assert.deepEqual(firstAlways.marks, [null, { kind: 'deny', labelKind: 'deny_for_this_task', scope: '' }]);
  assert.equal(pick(firstAlways, PANEL_TEXTS), null);
  const alone = read('appr-test-21', [ONCE, DENY], [null], 0);
  assert.deepEqual([alone.missing, alone.marks], [true, [null]]);
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
// The approvals read from the card nodes showing an id, as bridge.js's cardApprovals
const cardsOf = (...approvals) => id => approvals.filter(a => a?.approvalId === id);


test('a menu item maps to its option through the compact-allow key and the pending list', () => {
  const appr = approval('appr-test-23', [ONCE, SCOPED, DENY]);
  const mark = menuItemMark(menuTree('appr-test-23-compact-allow-0-allow_always'), undefined, pendingOf(appr), cardsOf(appr));
  assert.deepEqual(mark, { approvalId: 'appr-test-23', kind: 'allow_always', labelKind: 'allow_always_scoped', scope: 'destination' });
  assert.equal(AAM.menuItemAlways(mark, 'appr-test-23'), true);
  assert.equal(AAM.menuItemAlways(mark, 'appr-other'), false);
  // The approval comes from the pending list; an ancestor holding the same approval is only a consistency check
  assert.equal(menuItemMark(menuTree('appr-test-23-compact-allow-0-allow_always', { approvalAbove: appr }), undefined, () => null), null);
  assert.equal(menuItemMark(menuTree('appr-test-23-compact-allow-0-allow_always', { approvalAbove: appr }), undefined, pendingOf(appr), cardsOf(appr)).scope, 'destination');
});

test('menu items for broad or unknown options are marked but never picked as always', () => {
  for (const broad of [BROAD, opt('allow_always', 'allow_all_web_access_for_this_task'), opt('allow_always', 'allow_always_scoped', 'workspace')]) {
    const appr = approval('appr-test-24', [ONCE, broad, DENY]);
    const mark = menuItemMark(menuTree('appr-test-24-compact-allow-0-allow_always'), undefined, pendingOf(appr), cardsOf(appr));
    assert.equal(mark.kind, 'allow_always');
    assert.equal(AAM.menuItemAlways(mark, 'appr-test-24'), false);
  }
});

test('a menu item that can not be matched gets no mark', () => {
  const appr = approval('appr-test-25', [ONCE, SCOPED, DENY]);
  const cases = {
    'not pending': menuItemMark(menuTree('appr-test-25-compact-allow-0-allow_always'), undefined, () => undefined),
    'kind at index differs': menuItemMark(menuTree('appr-test-25-compact-allow-0-allow_once'), undefined, pendingOf(appr), cardsOf(appr)),
    'index out of range': menuItemMark(menuTree('appr-test-25-compact-allow-1-allow_always'), undefined, pendingOf(appr), cardsOf(appr)),
    'other approval above': menuItemMark(menuTree('appr-test-25-compact-allow-0-allow_always', { approvalAbove: approval('appr-other', [ONCE, SCOPED]) }), undefined, pendingOf(appr), cardsOf(appr)),
    'key too far up': menuItemMark(menuTree('appr-test-25-compact-allow-0-allow_always', { depth: 40 }), undefined, pendingOf(appr), cardsOf(appr)),
    'no decisionOptions': menuItemMark(menuTree('appr-test-25-compact-allow-0-allow_always'), undefined, pendingOf(approval('appr-test-25', null)), cardsOf(approval('appr-test-25', null))),
    'cta key': menuItemMark(menuTree('appr-test-25-cta-1-allow_always'), undefined, pendingOf(appr), cardsOf(appr)),
    stale: menuItemMark({ memoizedProps: {}, return: { memoizedProps: {} } }, undefined, pendingOf(appr), cardsOf(appr)),
  };
  for (const [name, mark] of Object.entries(cases)) assert.equal(mark, null, name);
});

test('two options of the same kind that the compact key can not tell apart are not matched', () => {
  const appr = approval('appr-test-26', [ONCE, SCOPED, BROAD, DENY]);
  for (const index of [0, 1]) assert.equal(menuItemMark(menuTree(`appr-test-26-compact-allow-${index}-allow_always`), undefined, pendingOf(appr), cardsOf(appr)), null);
  const twins = approval('appr-test-27', [ONCE, SCOPED, SCOPED, DENY]);
  assert.equal(menuItemMark(menuTree('appr-test-27-compact-allow-1-allow_always'), undefined, pendingOf(twins), cardsOf(twins)).scope, 'destination');
});

// Review P1-c
test('menu pick on the data path needs a fresh whitelisted mark for this approval; text is never used there', () => {
  const always = { approvalId: 'appr-test-28', kind: 'allow_always', labelKind: 'allow_always_scoped', scope: 'destination' };
  const item = (el, text, option = null) => ({ el, text, option });
  assert.deepEqual(AAM.pickMenuItem([item('m0', 'Always allow all actions', { ...always, scope: 'connector_all_actions' }), item('m1', 'x', always)], 'appr-test-28', true), { item: 'm1', data: true });
  assert.equal(AAM.pickMenuItem([item('m0', 'Always allow all actions', { ...always, scope: 'connector_all_actions' })], 'appr-test-28', true), null);
  // Every mark failed, or the item belongs to another approval: no text fallback
  assert.equal(AAM.pickMenuItem([item('m0', 'Always allow uploads to this site')], 'appr-test-28', true), null);
  assert.equal(AAM.pickMenuItem([item('m0', 'Always allow uploads to this site', { ...always, approvalId: 'appr-other' })], 'appr-test-28', true), null);
  // Without data: main's text rule
  assert.deepEqual(AAM.pickMenuItem([item('m0', '一律允許上傳到此網站')], '', false), { item: 'm0', data: false });
});

// Review P1-b
test('the pre-click re-check for a menu item checks the fresh card options and the fresh item mark', () => {
  const panel = options => pick(read('appr-test-29', options, [null, 'appr-test-29-compact-deny-0-deny'], 0), PANEL_TEXTS);
  const before = panel([ONCE, SCOPED, DENY]);
  const fresh = { approvalId: 'appr-test-29', kind: 'allow_always', labelKind: 'allow_always_scoped', scope: 'destination' };
  const menu = option => ({ menu: true, data: true, approvalId: 'appr-test-29', option });
  assert.equal(AAM.samePick(before, before, menu(fresh)), true);
  assert.equal(AAM.samePick(before, before, menu(null)), false);
  assert.equal(AAM.samePick(before, before, menu({ ...fresh, scope: 'connector_all_actions' })), false);
  assert.equal(AAM.samePick(before, before, menu({ ...fresh, approvalId: 'appr-other' })), false);
  // The card turned broad while the menu was open; the item still reports the old single-site option
  assert.equal(AAM.samePick(before, panel([ONCE, BROAD, DENY]), menu(fresh)), false);
  // The card now offers a different single-site option than the item claims
  assert.equal(AAM.samePick(before, panel([ONCE, opt('allow_always', 'allow_always_scoped', 'destination_domain'), DENY]), menu(fresh)), false);
  assert.equal(AAM.samePick(before, { ...before, data: false }, menu(fresh)), false);
});

test('panel surface end to end: keyless primary, compact-deny and a compact-allow menu item', () => {
  const appr = approval('appr-test-30', [ONCE, SCOPED, DENY]);
  const { hosts } = cardTree(appr, [null, 'appr-test-30-compact-deny-0-deny']);
  const picked = pick(optionMarks(appr, asButtons(hosts, 0)), PANEL_TEXTS);
  assert.deepEqual(core(picked), { always: null, once: 'button-0', data: true });
  assert.equal(picked.alwaysInMenu, true);
  const option = menuItemMark(menuTree('appr-test-30-compact-allow-0-allow_always'), undefined, pendingOf(appr), cardsOf(appr));
  assert.deepEqual(AAM.pickMenuItem([{ el: 'm0', text: 'Toujours autoriser', option }], 'appr-test-30', picked.data), { item: 'm0', data: true });
  assert.equal(AAM.samePick(picked, picked, { menu: true, data: true, approvalId: 'appr-test-30', option }), true);
});

test('panel surface: a compact-allow item with a broad scope is never picked, Allow once is clicked instead', () => {
  const appr = approval('appr-test-31', [ONCE, BROAD, DENY]);
  const picked = pick(read('appr-test-31', appr.serverPresentation.decisionOptions, [null, 'appr-test-31-compact-deny-0-deny'], 0), PANEL_TEXTS);
  assert.deepEqual(core(picked), { always: null, once: 'button-0', data: true });
  assert.equal(picked.alwaysInMenu, false);
  const option = menuItemMark(menuTree('appr-test-31-compact-allow-0-allow_always'), undefined, pendingOf(appr), cardsOf(appr));
  assert.equal(AAM.pickMenuItem([{ el: 'm0', text: 'Always allow all actions', option }], 'appr-test-31', true), null);
});

test('an unknown kind in a compact key: matched when the data has it but never picked, refused when it does not', () => {
  const appr = approval('appr-test-32', [ONCE, opt('allow_forever', 'allow_forever'), DENY]);
  const option = menuItemMark(menuTree('appr-test-32-compact-allow-0-allow_forever'), undefined, pendingOf(appr), cardsOf(appr));
  assert.equal(option.kind, 'allow_forever');
  assert.equal(AAM.menuItemAlways(option, 'appr-test-32'), false);
  assert.equal(menuItemMark(menuTree('appr-test-32-compact-allow-0-allow_later'), undefined, pendingOf(appr), cardsOf(appr)), null);
  const deny = read('appr-test-32', [ONCE, DENY], [null, 'appr-test-32-compact-deny-0-deny_later'], 0);
  assert.deepEqual([deny.missing, deny.marks], [true, [null, null]]);
});

// Review round 2, item 1: the marked buttons are filtered out as not clickable, leaving only the keyless primary
test('an unclickable marked deny or primary never lets the primary fall back to text', () => {
  const candidates = (texts, mark = {}) => texts.map((text, i) => ({ el: `button-${i}`, text, primary: i === 0, menu: false, kind: '', labelKind: '', scope: '', ...mark }));
  for (const state of ['clean', 'anomalous']) {
    assert.equal(AAM.pickAllowButtons(candidates(['Always allow all actions']), state, markList([BROAD, DENY])), null, state);
    assert.equal(AAM.pickAllowButtons(candidates(['Allow']), state, markList([BROAD, DENY])), null, state);
    // The data confirmed the primary as the once option
    assert.equal(AAM.pickAllowButtons(candidates(['Allow once'], markList([ONCE])[0]), state, markList([ONCE, BROAD, DENY])).once, 'button-0', state);
  }
});

// Review round 2, item 2: any source saying broad vetoes
test('a menu item whose ancestor approval and pending list disagree is not marked', () => {
  const pendingSafe = approval('appr-test-44', [ONCE, SCOPED, DENY]);
  const ancestorBroad = approval('appr-test-44', [ONCE, BROAD, DENY]);
  const key = 'appr-test-44-compact-allow-0-allow_always';
  assert.equal(menuItemMark(menuTree(key, { approvalAbove: ancestorBroad }), undefined, pendingOf(pendingSafe), cardsOf(pendingSafe)), null);
  assert.equal(menuItemMark(menuTree(key, { approvalAbove: pendingSafe }), undefined, pendingOf(ancestorBroad), cardsOf(ancestorBroad)), null);
  // Fresh card broad, pending cache still single-site: the fresh card's alwaysInMenu=false refuses the click
  const panel = options => pick(read('appr-test-44', options, [null, 'appr-test-44-compact-deny-0-deny'], 0), PANEL_TEXTS);
  const option = menuItemMark(menuTree(key), undefined, pendingOf(pendingSafe), cardsOf(pendingSafe));
  const fresh = panel([ONCE, BROAD, DENY]);
  assert.equal(fresh.alwaysInMenu, false);
  assert.equal(AAM.samePick(panel([ONCE, SCOPED, DENY]), fresh, { menu: true, data: true, approvalId: 'appr-test-44', option }), false);
});

// Codex re-review P1-3
test('an empty option list that was read is anomalous and picks nothing', () => {
  const result = read('appr-test-48', [], ['appr-test-48-cta-0-allow_once', 'appr-test-48-cta-1-allow_always']);
  assert.deepEqual([result.state, result.options, result.marks], ['anomalous', [], [null, null]]);
  assert.equal(pick(result), null);
});

// Codex re-review P1-2
test('an anomalous card never opens the menu; a clean card takes the item only by its fresh mark', () => {
  const always = { approvalId: 'appr-test-45', kind: 'allow_always', labelKind: 'allow_always_scoped', scope: 'destination' };
  const panel = keys => pick(read('appr-test-45', [ONCE, SCOPED, DENY], keys, 0), PANEL_TEXTS);
  const anomalous = panel([null, 'appr-test-45-compact-deny-0-deny', 'appr-other-compact-deny-0-deny']);
  assert.deepEqual([anomalous.state, anomalous.once, anomalous.alwaysInMenu], ['anomalous', 'button-0', false]);
  for (const keys of [[null, 'appr-other-compact-deny-0-deny'], [null, 'appr-test-45-compact-deny-0-allow_once']]) assert.equal(panel(keys), null);
  const clean = panel([null, 'appr-test-45-compact-deny-0-deny']);
  assert.equal(clean.alwaysInMenu, true);
  assert.equal(AAM.pickMenuItem([{ el: 'm0', text: 'Always allow uploads to this site', option: null }], 'appr-test-45', clean.data), null);
  assert.equal(AAM.samePick(clean, clean, { menu: true, data: false, approvalId: 'appr-test-45', option: null }), false);
  assert.equal(AAM.samePick(clean, clean, { menu: true, data: true, approvalId: 'appr-test-45', option: always }), true);
  assert.equal(AAM.samePick(clean, clean, { menu: true, data: true, approvalId: 'appr-test-45', option: { ...always, scope: 'destination_domain' } }), false);
});

const DOMAIN = opt('allow_always', 'allow_always_scoped', 'destination_domain');
const SOURCE_PAIRS = [[SCOPED, DOMAIN], [DOMAIN, SCOPED], [SCOPED, BROAD], [BROAD, SCOPED]];

// Codex re-review 4, P1: every source holding the approval must resolve the button to the same option, not just the same id
test('a button is clean only when the card, its own ancestor and the pending list give the same option', () => {
  const texts = ['Allow once', 'Always allow uploads to this site', 'Deny'];
  for (const [a, b] of SOURCE_PAIRS) {
    const name = `${a.label.scope}/${b.label.scope}`;
    const card = approval('appr-test-60', [ONCE, a, DENY]);
    const other = approval('appr-test-60', [ONCE, b, DENY]);
    // The button's nearest approval is a different object with the same id
    const ancestor = optionMarks(card, asButtons(cardTree(other, keysFor('appr-test-60', [ONCE, b, DENY])).hosts));
    const cached = optionMarks(card, asButtons(cardTree(card, keysFor('appr-test-60', [ONCE, a, DENY])).hosts), undefined, pendingOf(other));
    for (const [source, result] of [['ancestor', ancestor], ['pending', cached]]) {
      assert.deepEqual([result.state, result.missing], ['anomalous', true], `${source} ${name}`);
      assert.deepEqual(core(pick(result, texts)), { always: null, once: 'button-0', data: true }, `${source} ${name}`);
    }
    const agreed = optionMarks(card, asButtons(cardTree(card, keysFor('appr-test-60', [ONCE, a, DENY])).hosts), undefined, pendingOf(approval('appr-test-60', [ONCE, a, DENY])));
    assert.equal(agreed.state, 'clean', name);
  }
  // The keyless primary too: the card says the first allow option is broad, the button's ancestor says allow once
  const panelCard = approval('appr-test-61', [BROAD, ONCE, DENY]);
  const { hosts } = cardTree(approval('appr-test-61', [ONCE, BROAD, DENY]), [null, 'appr-test-61-compact-deny-0-deny']);
  const primary = optionMarks(panelCard, asButtons(hosts, 0));
  assert.deepEqual([primary.state, primary.marks[0]], ['anomalous', null]);
  assert.equal(pick(primary, PANEL_TEXTS), null);
});

// Codex re-review 4, P1: the same compact key is resolved in the pending list and in the card, and must agree
test('a menu item is marked only when the pending list and the card give the same option at its key', () => {
  const key = 'appr-test-62-compact-allow-0-allow_always';
  for (const [a, b] of SOURCE_PAIRS) {
    const name = `${a.label.scope}/${b.label.scope}`;
    const pending = approval('appr-test-62', [ONCE, a, DENY]);
    const card = approval('appr-test-62', [ONCE, b, DENY]);
    assert.equal(menuItemMark(menuTree(key), undefined, pendingOf(pending), cardsOf(card)), null, name);
    assert.equal(menuItemMark(menuTree(key, { approvalAbove: pending }), undefined, pendingOf(pending), cardsOf(card)), null, name);
    assert.equal(menuItemMark(menuTree(key), undefined, pendingOf(pending), cardsOf(pending, card)), null, name);
    assert.equal(menuItemMark(menuTree(key), undefined, pendingOf(pending), cardsOf(pending)).scope, a.label.scope, name);
  }
  // The cache's option still appears in the card, but not at this key
  const cache = approval('appr-test-62', [ONCE, SCOPED, DENY]);
  assert.equal(menuItemMark(menuTree(key), undefined, pendingOf(cache), cardsOf(approval('appr-test-62', [ONCE, DOMAIN, SCOPED, DENY]))), null);
  // No card reached: refused
  assert.equal(menuItemMark(menuTree(key), undefined, pendingOf(cache), () => []), null);
});
