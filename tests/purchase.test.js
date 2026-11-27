'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AAM = require('../shared.js');
const { isPurchaseApproval } = require('../bridge.js');

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
  for (const payloadType of ['purchase_preapproval', 'delivery_checkout', 'browser_checkout', 'flight_checkout', 'shopify_checkout']) {
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
