'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AAM = require('../shared.js');
const { isPurchaseApproval, marksFor } = require('../bridge.js');
const { canAutoApprove, combinePurchase } = require('../guard.js');

const CHECKOUT_FIELDS = [
  'browserCheckoutApproval', 'shopifyCheckoutApproval', 'stripeLinkCheckoutApproval', 'flightCheckoutApproval',
  'reservationCheckoutApproval', 'deliveryCheckoutApproval', 'connectorCheckoutApproval', 'paymentSetup', 'purchasePaymentSelection',
];

// Shape of an ordinary connector approval as seen on the live site: every purchase field is null
function ordinary(extra = {}) {
  const approval = {
    approvalId: 'a1',
    policySubject: 'connector.browser.page.upload',
    payloadPreview: 'Destination: https://tmpfiles.org',
    serverPresentation: { payloadType: 'connector', paymentProvider: null, purchasePreapproval: null },
    ...extra,
  };
  for (const field of CHECKOUT_FIELDS) if (!(field in extra)) approval[field] = null;
  return approval;
}

test('an ordinary connector approval is not a purchase', () => {
  assert.equal(isPurchaseApproval(ordinary()), false);
  assert.equal(isPurchaseApproval(null), false);
});

test('each known checkout field holding an object is a purchase', () => {
  for (const field of CHECKOUT_FIELDS) assert.equal(isPurchaseApproval(ordinary({ [field]: {} })), true, field);
});

test('each known purchase payload type is a purchase', () => {
  for (const payloadType of ['purchase_preapproval', 'delivery_checkout', 'browser_checkout', 'connector_checkout', 'flight_checkout', 'reservation_checkout', 'shopify_checkout']) {
    const approval = ordinary({ serverPresentation: { payloadType, paymentProvider: null, purchasePreapproval: null } });
    assert.equal(isPurchaseApproval(approval), true, payloadType);
  }
});

test('paymentProvider or purchasePreapproval set in serverPresentation is a purchase', () => {
  assert.equal(isPurchaseApproval(ordinary({ serverPresentation: { payloadType: 'connector', paymentProvider: 'stripe', purchasePreapproval: null } })), true);
  assert.equal(isPurchaseApproval(ordinary({ serverPresentation: { payloadType: 'connector', paymentProvider: null, purchasePreapproval: {} } })), true);
});

test('an unknown future checkout key is a purchase', () => {
  assert.equal(isPurchaseApproval(ordinary({ hotelCheckoutApproval: {} })), true);
});

test('empty values are not a purchase', () => {
  for (const value of [null, undefined, false, [], '']) {
    assert.equal(isPurchaseApproval(ordinary({ browserCheckoutApproval: value, hotelCheckoutApproval: value })), false, String(value));
  }
});

test('isPurchase trusts the data flag whatever the title language', () => {
  const card = AAM.parseCard('Möchtest du die Bestellung bei shop.example abschließen? Ablehnen', '', '', '');
  assert.equal(AAM.isPurchase(card), false);
  assert.equal(AAM.isPurchase({ ...card, purchase: true }), true);
  assert.equal(AAM.isPurchase({ ...card, host: 'shop.example', purchase: true }), true);
});

test('isPurchase falls back to the wording without the flag', () => {
  assert.equal(AAM.isPurchase(AAM.parseCard('Place an order on Amazon? Deny')), true);
  assert.equal(AAM.isPurchase(AAM.parseCard('要在 Gmail 傳送郵件嗎？ 不要傳送')), false);
});

const ALLOW_ALL = { ...AAM.SETTINGS_DEFAULTS, mode: 'all', includeActions: true };
const actionCard = purchase => ({ ...AAM.parseCard('Bestellung bei shop.example abschließen? Ablehnen'), purchase });
const siteCard = purchase => ({ ...AAM.parseCard('Access example.com? Deny'), purchase });

test('a card marked as a purchase is never auto-approved', () => {
  assert.equal(canAutoApprove(ALLOW_ALL, actionCard(true), false), false);
  assert.equal(canAutoApprove(ALLOW_ALL, siteCard(true), false), false);
});

test('an action card with unknown purchase state is refused even when trusted', () => {
  const card = actionCard(null);
  const trusted = { ...ALLOW_ALL, actions: [{ id: 'x', title: card.action, chats: [], on: true }] };
  assert.equal(canAutoApprove(ALLOW_ALL, card, false), false);
  assert.equal(canAutoApprove(trusted, card, false), false);
  assert.equal(canAutoApprove(ALLOW_ALL, actionCard(false), false), true);
});

test('a website card with unknown purchase state follows the usual rules', () => {
  assert.equal(canAutoApprove(ALLOW_ALL, siteCard(null), false), true);
  assert.equal(canAutoApprove(AAM.SETTINGS_DEFAULTS, siteCard(null), false), false);
  const upload = { ...AAM.parseCard('Upload a file? Deny', '', 'connector.browser.page.upload', 'tmpfiles.org'), purchase: null };
  assert.equal(canAutoApprove({ ...AAM.SETTINGS_DEFAULTS, mode: 'all' }, upload, false), true);
});

test('just this once passes whatever the purchase state', () => {
  for (const purchase of [true, false, null]) assert.equal(canAutoApprove(AAM.SETTINGS_DEFAULTS, actionCard(purchase), true), true);
});

// Fabricated React trees: root -> card (props.approval at cardProps) -> host node, each with an optional stale alternate
function link(parent, children) {
  parent.child = children[0] || null;
  children.forEach((c, i) => { c.return = parent; c.sibling = children[i + 1] || null; });
}

function tree({ current, stale, upper }) {
  const fiberRoot = {};
  const root = { stateNode: fiberRoot, memoizedProps: {} };
  const oldRoot = { stateNode: fiberRoot, memoizedProps: {}, alternate: root };
  root.alternate = oldRoot;
  fiberRoot.current = root;
  const panel = { memoizedProps: upper ? { approval: upper } : {} };
  const card = { memoizedProps: current ? { approval: current } : { className: 'card' } };
  const node = { memoizedProps: { className: 'item' } };
  link(root, [{ memoizedProps: {} }, panel]);
  link(panel, [card]);
  link(card, [node]);
  // Previous render: the same structure with old props, linked to its own old parents
  const oldPanel = { memoizedProps: panel.memoizedProps, alternate: panel };
  const oldCard = { memoizedProps: stale ? { approval: stale } : card.memoizedProps, alternate: card };
  const oldNode = { memoizedProps: node.memoizedProps, alternate: node };
  panel.alternate = oldPanel; card.alternate = oldCard; node.alternate = oldNode;
  link(oldRoot, [oldPanel]);
  link(oldPanel, [oldCard]);
  link(oldCard, [oldNode]);
  return { node, oldNode, card };
}

// Upload approvals hold the connector name in their own host field
const upload = (id, site) => ordinary({ approvalId: id, host: 'browser', payloadPreview: `Destination: https://${site}` });

test('steady state: the DOM node points at the current fiber', () => {
  const { node } = tree({ current: upload('a1', 'tmpfiles.org') });
  assert.deepEqual(marksFor(node), { approvalId: 'a1', policy: 'connector.browser.page.upload', site: 'tmpfiles.org', host: 'browser', purchase: false, found: true });
});

test('an approval host that is not a string is not read', () => {
  for (const host of [null, 7, { name: 'a.example' }]) {
    const { node } = tree({ current: ordinary({ host }) });
    assert.equal(marksFor(node).host, '', String(host));
  }
});

test('the DOM node points at the alternate: answer comes from the current tree', () => {
  const { oldNode } = tree({ current: upload('a1', 'tmpfiles.org'), stale: upload('a1', 'tmpfiles.org') });
  assert.equal(marksFor(oldNode).approvalId, 'a1');
});

test('purchase one level up on the current side wins over an ordinary stale approval', () => {
  const { oldNode } = tree({ current: null, stale: ordinary({ approvalId: 'old' }), upper: ordinary({ approvalId: 'new', shopifyCheckoutApproval: {} }) });
  const marks = marksFor(oldNode);
  assert.deepEqual([marks.approvalId, marks.purchase, marks.found], ['new', true, true]);
});

test('different ordinary ids on the two sides: the current one, with its site and policy', () => {
  const current = ordinary({ approvalId: 'new', policySubject: 'connector.gmail.users.messages.send', payloadPreview: '' });
  const { oldNode, node } = tree({ current, stale: upload('old', 'tmpfiles.org') });
  for (const start of [node, oldNode]) {
    assert.deepEqual(marksFor(start), { approvalId: 'new', policy: 'connector.gmail.users.messages.send', site: '', host: '', purchase: false, found: true });
  }
});

test('a broken tree is unknown', () => {
  const { node, card } = tree({ current: ordinary() });
  card.return.child = null;
  card.alternate.return.child = null;
  assert.equal(marksFor(node), null);
  const orphan = { memoizedProps: { approval: ordinary() }, return: { memoizedProps: {} } };
  assert.equal(marksFor(orphan), null);
  assert.equal(marksFor(null), null);
});

test('combinePurchase: purchase wins, then unknown, no only when every side said no', () => {
  assert.equal(combinePurchase([true, null]), true);
  assert.equal(combinePurchase([null, true]), true);
  assert.equal(combinePurchase([false, true]), true);
  assert.equal(combinePurchase([null, false]), null);
  assert.equal(combinePurchase([false, null]), null);
  assert.equal(combinePurchase([false, false]), false);
  assert.equal(combinePurchase([false]), false);
  assert.equal(combinePurchase([null]), null);
});
