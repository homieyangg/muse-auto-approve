'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AAM = require('../shared.js');
const { optionMarks, marksFor, markItem } = require('../bridge.js');

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

const asButtons = hosts => hosts.map(fiber => ({ fiber }));
const core = p => p && { always: p.always, once: p.once, data: p.data };

// Mirrors content.js: candidates from the attributes bridge.js would write, picked under the card state it wrote
function pick(result, texts = TEXTS, primaryAt = 0) {
  const candidates = result.marks.map((m, i) => ({ el: `button-${i}`, text: texts[i] || '', primary: i === primaryAt, menu: false, kind: '', labelKind: '', scope: '', ...m }));
  return AAM.pickAllowButtons(candidates, result.state || '');
}
const kinds = result => result.marks.map(m => m?.kind ?? null);

function read(id, options, keys = keysFor(id, options)) {
  const appr = approval(id, options);
  const { hosts } = cardTree(appr, keys);
  return optionMarks(appr, asButtons(hosts));
}


const SCOPED = opt('allow_always', 'allow_always_scoped', 'destination');
const BROAD = opt('allow_always', 'allow_always_scoped', 'connector_all_actions');
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
    assert.deepEqual(kinds(result), ['allow_once', null, 'deny']);
    const p = pick(result);
    assert.deepEqual(core(p), { always: null, once: 'button-0', data: true });
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
  const fresh = pick(result, ['Allow once', 'Always allow all actions', 'Deny']);
  assert.equal(AAM.samePick(p, fresh, 'button-1'), false);
});

test('a mismatched own key next to a broad always never picks always', () => {
  const options = [ONCE, BROAD, DENY];
  const keys = ['appr-test-41-cta-0-allow_once', 'appr-test-41-cta-1-allow_always', 'appr-test-41-cta-2-allow_once'];
  const p = pick(read('appr-test-41', options, keys), ['Allow once', 'Always allow all actions', 'Deny']);
  assert.deepEqual(core(p), { always: null, once: 'button-0', data: true });
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

test('decisionOptions null: the card is reported missing and main\'s text rules pick', () => {
  for (const options of [null, undefined]) {
    const appr = approval('appr-test-9', options);
    const { hosts } = cardTree(appr, ['appr-test-9-cta-0-allow_once', 'appr-test-9-cta-1-allow_always']);
    const result = optionMarks(appr, asButtons(hosts));
    assert.equal(result.missing, true);
    const p = pick(result);
    assert.deepEqual(core(p), { always: 'button-1', once: 'button-0', data: false });
    assert.equal(result.state, '');
  }
});

test('buttons without a cta key stay unmarked; no cta key at all is not the chat layout and keeps main\'s text rules', () => {
  const options = [ONCE, DENY];
  const mixed = read('appr-test-10', options, ['appr-test-10-cta-0-allow_once', null, 'appr-test-10-cta-1-deny']);
  assert.deepEqual(mixed.marks.map(m => m?.kind ?? null), ['allow_once', null, 'deny']);
  assert.equal(mixed.state, 'clean');
  // Keyless, or keyed in a form this path does not read (the panel's compact keys): no state, main's text rules
  for (const keys of [[null, null], ['appr-test-10-compact-deny-0-deny', null]]) {
    const none = read('appr-test-10', options, keys);
    assert.deepEqual([none.state, none.missing, none.marks], ['', true, [null, null]], JSON.stringify(keys));
    assert.deepEqual(core(pick(none, ['Allow once', 'Deny'])), { always: null, once: 'button-0', data: false });
  }
  // A stale button next to keyless ones can't be confirmed: anomalous, never text
  const appr = approval('appr-test-10', options);
  const { hosts } = cardTree(appr, [null, null]);
  const stale = optionMarks(appr, asButtons([hosts[0], { memoizedProps: {}, return: hosts[1].return, sibling: null }]));
  assert.deepEqual([stale.state, stale.marks], ['anomalous', [null, null]]);
  assert.equal(pick(stale), null);
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
  const foreignOnly = optionMarks(appr, asButtons([other.hosts[0]]));
  assert.deepEqual([foreignOnly.state, foreignOnly.marks], ['anomalous', [null]]);
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

const pendingOf = (...approvals) => id => approvals.find(a => a.approvalId === id);


// Review round 2, item 1: the marked buttons are filtered out as not clickable, leaving only an unmarked primary
test('an unclickable marked deny or primary never lets the primary fall back to text', () => {
  const candidates = (texts, mark = {}) => texts.map((text, i) => ({ el: `button-${i}`, text, primary: i === 0, menu: false, kind: '', labelKind: '', scope: '', ...mark }));
  for (const state of ['clean', 'anomalous']) {
    assert.equal(AAM.pickAllowButtons(candidates(['Always allow all actions']), state), null, state);
    assert.equal(AAM.pickAllowButtons(candidates(['Allow']), state), null, state);
    // The data confirmed the primary as the once option
    assert.equal(AAM.pickAllowButtons(candidates(['Allow once'], markList([ONCE])[0]), state).once, 'button-0', state);
  }
});

// Codex re-review P1-3
test('an empty option list that was read is anomalous and picks nothing', () => {
  const result = read('appr-test-48', [], ['appr-test-48-cta-0-allow_once', 'appr-test-48-cta-1-allow_always']);
  assert.deepEqual([result.state, result.marks], ['anomalous', [null, null]]);
  assert.equal(pick(result), null);
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
});

// Codex re-review 5: a source without decisionOptions is skipped, [] or different options veto, and only when no source
// has data does main's text path apply
test('a card without options is still read from the pending entry or the button ancestor: they veto the text always', () => {
  const texts = ['Allow once', 'Always allow uploads to this site', 'Deny'];
  const keys = keysFor('appr-test-64', [ONCE, SCOPED, DENY]);
  const card = approval('appr-test-64', null);
  const read = (tree, pending) => optionMarks(card, asButtons(cardTree(tree, keys).hosts), undefined, pending);
  // Pending broad, [] or safe: data exists, so no text pick; the cache alone never authorises always
  const cases = {
    broad: [[ONCE, BROAD, DENY], { always: null, once: 'button-0', data: true }],
    empty: [[], null],
    safe: [[ONCE, SCOPED, DENY], { always: null, once: 'button-0', data: true }],
  };
  for (const [name, [options, expected]] of Object.entries(cases)) {
    const result = read(card, pendingOf(approval('appr-test-64', options)));
    assert.deepEqual([result.state, result.missing], ['anomalous', true], name);
    const p = pick(result, texts);
    assert.deepEqual(core(p), expected, name);
  }
  // The button's own approval carries the options the card node lacks: it is card-side data and decides
  const ancestorBroad = read(approval('appr-test-64', [ONCE, BROAD, DENY]), () => null);
  assert.equal(ancestorBroad.state, 'clean');
  assert.deepEqual(core(pick(ancestorBroad, texts)), { always: null, once: 'button-0', data: true });
  // No source has data: main's text rules
  const none = read(card, () => null);
  assert.equal(none.state, '');
  assert.deepEqual(core(pick(none, texts)), { always: 'button-1', once: 'button-0', data: false });
  const nonePending = read(card, pendingOf(approval('appr-test-64', null)));
  assert.equal(nonePending.state, '');
});

test('a pending entry without options is skipped: a clean card stays clean', () => {
  const options = [ONCE, SCOPED, DENY];
  const appr = approval('appr-test-65', options);
  const result = optionMarks(appr, asButtons(cardTree(appr, keysFor('appr-test-65', options)).hosts), undefined, pendingOf(approval('appr-test-65', null)));
  assert.deepEqual([result.state, result.missing], ['clean', false]);
  assert.deepEqual(core(pick(result)), { always: 'button-1', once: 'button-0', data: true });
  // The same with only a keyed once button
  const onlyOnce = approval('appr-test-65', [ONCE, DENY]);
  const once = optionMarks(onlyOnce, asButtons(cardTree(onlyOnce, ['appr-test-65-cta-0-allow_once']).hosts), undefined, pendingOf(approval('appr-test-65', null)));
  assert.deepEqual([once.state, kinds(once)], ['clean', ['allow_once']]);
});

// Codex re-review 6: the cache alone only backs a button with its own key, and a veto read anywhere on the card applies to
// every button of the card
test('with the cache as the only data, only a button with its own cta key is marked, and never as a clean always', () => {
  const card = approval('appr-test-67', null);
  const pending = pendingOf(approval('appr-test-67', [ONCE, SCOPED, DENY]));
  const keyless = optionMarks(card, asButtons(cardTree(card, [null, 'appr-test-67-cta-2-deny']).hosts), undefined, pending);
  assert.deepEqual([keyless.state, kinds(keyless)], ['anomalous', [null, 'deny']]);
  assert.equal(pick(keyless, ['Allow once', 'Deny']), null);
  const chat = optionMarks(card, asButtons(cardTree(card, keysFor('appr-test-67', [ONCE, SCOPED, DENY])).hosts), undefined, pending);
  assert.deepEqual([chat.state, kinds(chat)], ['anomalous', ['allow_once', 'allow_always', 'deny']]);
  assert.deepEqual(core(pick(chat)), { always: null, once: 'button-0', data: true });
});

test('a veto read from a sibling button\'s own approval applies to the whole card', () => {
  const id = 'appr-test-68';
  const keys = keysFor(id, [ONCE, SCOPED, DENY]);
  const pending = pendingOf(approval(id, [ONCE, SCOPED, DENY]));
  // Buttons 0 and 1 sit under the card's approval; button 2's nearest approval is another node of the same id
  const mixed = (cardOptions, siblingOptions) => {
    const card = approval(id, cardOptions);
    const own = cardTree(card, keys).hosts;
    const sibling = cardTree(approval(id, siblingOptions), [keys[2]]).hosts;
    return optionMarks(card, asButtons([own[0], own[1], sibling[0]]), undefined, pending);
  };
  for (const cardOptions of [null, [ONCE, SCOPED, DENY]]) {
    const name = cardOptions ? 'card with options' : 'card without options';
    const vetoed = mixed(cardOptions, []);
    assert.deepEqual([vetoed.state, kinds(vetoed)], ['anomalous', [null, null, null]], name);
    assert.equal(pick(vetoed), null, name);
    // A sibling listing another always vetoes the always; the once every source agrees on is the only pick
    const other = mixed(cardOptions, [ONCE, DOMAIN, DENY]);
    assert.deepEqual([other.state, kinds(other)], ['anomalous', ['allow_once', null, 'deny']], name);
    assert.deepEqual(core(pick(other)), { always: null, once: 'button-0', data: true }, name);
  }
});

// Minimal element for markItem: attributes, a React fiber and the buttons under it
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
    matches: () => false,
    attrs,
  };
}

test('an option read that throws leaves the card anomalous, never on main\'s text rules', () => {
  const options = [ONCE, SCOPED, DENY];
  const appr = approval('appr-test-69', options);
  const { hosts, row } = cardTree(appr, keysFor('appr-test-69', options));
  const buttons = hosts.map(host => {
    const b = fakeEl(host);
    b.matches = sel => { if (sel.includes('haspopup')) throw new Error('boom'); return false; };
    return b;
  });
  const el = fakeEl(row, { buttons });
  const warn = console.warn;
  console.warn = () => {};
  try { markItem(el, undefined, () => null); } finally { console.warn = warn; }
  assert.equal(el.attrs['data-maa-approval-id'], 'appr-test-69');
  assert.equal(el.attrs['data-maa-state'], 'anomalous');
  assert.equal(el.attrs['data-maa-data-path'], 'missing');
  for (const b of buttons) assert.equal(b.attrs['data-maa-option-kind'], undefined);
  // The same card read without the fault is clean
  for (const b of buttons) b.matches = () => false;
  markItem(el, undefined, () => null);
  assert.equal(el.attrs['data-maa-state'], 'clean');
  assert.deepEqual(buttons.map(b => b.attrs['data-maa-option-kind']), ['allow_once', 'allow_always', 'deny']);
});

// Scope cut: the approvals panel is never read from data, so it keeps main's text rules whatever its buttons carry
test('a panel-surface card gets no state and no option marks, even with data, cta keys or a failed read', () => {
  const options = [ONCE, BROAD, DENY];
  const appr = approval('appr-test-70', options);
  for (const keys of [keysFor('appr-test-70', options), [null, 'appr-test-70-compact-deny-0-deny']]) {
    const { hosts, row } = cardTree(appr, keys);
    const buttons = hosts.map(host => fakeEl(host));
    const el = fakeEl(row, { buttons, surface: 'panel' });
    markItem(el, undefined, pendingOf(appr));
    assert.equal(el.attrs['data-maa-approval-id'], 'appr-test-70');
    assert.deepEqual([el.attrs['data-maa-state'], el.attrs['data-maa-data-path']], [undefined, undefined], JSON.stringify(keys));
    for (const b of buttons) assert.equal(b.attrs['data-maa-option-kind'], undefined);
    for (const b of buttons) b.matches = sel => { if (sel.includes('haspopup')) throw new Error('boom'); return false; };
    const warn = console.warn;
    console.warn = () => {};
    try { markItem(el, undefined, pendingOf(appr)); } finally { console.warn = warn; }
    assert.equal(el.attrs['data-maa-state'], undefined);
  }
});
