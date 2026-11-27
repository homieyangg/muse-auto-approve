'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AAM = require('../shared.js');

test('Japanese allow labels are recognized', () => {
  assert.match('許可する', AAM.ONCE_RE);
  assert.match('許可', AAM.ONCE_RE);
  assert.match('常に許可', AAM.ALWAYS_RE);
  assert.match('常に許可する', AAM.ALWAYS_RE);
  assert.match('このサイトを常に許可', AAM.ALWAYS_RE);
  assert.match('このタスクを許可', AAM.ALWAYS_RE);
  assert.match('1回だけ許可', AAM.ONCE_RE);
});

test('Japanese deny labels never read as allow', () => {
  assert.match('許可しない', AAM.DENY_RE);
  assert.match('このサイトを許可しない', AAM.DENY_RE);
  assert.match('却下', AAM.DENY_RE);
  assert.match('拒否する', AAM.DENY_RE);

  assert.doesNotMatch('許可しない', AAM.ONCE_RE);
  assert.doesNotMatch('許可しない', AAM.ALWAYS_RE);
  assert.doesNotMatch('常に許可しない', AAM.ALWAYS_RE);
  assert.doesNotMatch('このサイトを常に許可しない', AAM.ALWAYS_RE);
  assert.doesNotMatch('このタスクを許可しない', AAM.ALWAYS_RE);
});

test('English and Chinese labels keep working', () => {
  assert.match('Allow', AAM.ONCE_RE);
  assert.match('Allow once', AAM.ONCE_RE);
  assert.match('Always allow', AAM.ALWAYS_RE);
  assert.match('Allow always', AAM.ALWAYS_RE);
  assert.match("Don't send", AAM.DENY_RE);

  assert.match('允許', AAM.ONCE_RE);
  assert.match('一律允許', AAM.ALWAYS_RE);
  assert.match('拒絕', AAM.DENY_RE);
  assert.match('允许', AAM.ONCE_RE);
  assert.match('拒绝', AAM.DENY_RE);
});

test('Japanese cards pass the website/action context check', () => {
  assert.match('example.com にアクセスしますか？', AAM.CONTEXT_RE);
  assert.match('GitHub の List issues on GitHub を許可しますか？', AAM.CONTEXT_RE);
  assert.match('ブラウザの権限を確認しますか？', AAM.CONTEXT_RE);
  assert.doesNotMatch('このチャットを削除しますか？', AAM.CONTEXT_RE);
});

test('Japanese website card parses host and title', () => {
  const card = AAM.parseCard('example.com にアクセスしますか？', '', '', '');
  assert.equal(card.host, 'example.com');
  assert.equal(card.action, '');
  assert.equal(card.policy, '');
  assert.equal(card.title, 'example.com にアクセスしますか');
});

test('Japanese GitHub action card parses as an action', () => {
  const card = AAM.parseCard('GitHub の List issues on GitHub を実行しますか？', '', 'connector.github.issues.list', '');
  assert.equal(card.host, '');
  assert.equal(card.action, 'GitHub の List issues on GitHub を実行しますか');
  assert.equal(card.policy, 'connector.github.issues.list');
  assert.equal(AAM.isPurchase(card), false);
});

test('Japanese chat source is remembered', () => {
  const card = AAM.parseCard('このタスクは「毎朝の確認」からのものです。example.com にアクセスしますか？', '', '', '');
  assert.equal(card.chat, '毎朝の確認');
});

test('Japanese purchase cards stay manual', () => {
  assert.equal(AAM.isPurchase({ title: 'この注文を確定しますか？' }), true);
  assert.equal(AAM.isPurchase({ title: 'この商品を購入しますか？' }), true);
  assert.equal(AAM.isPurchase({ title: '決済に進みますか？' }), true);
  assert.equal(AAM.isPurchase({ action: '掃除を予約する' }), false);
});

test('Japanese approvals tab and language setting are supported', () => {
  assert.match('承認', AAM.APPROVALS_TAB_RE);
  assert.match('承認待ち', AAM.APPROVALS_TAB_RE);
  assert.equal(AAM.sanitizeSettings({ lang: 'ja' }).lang, 'ja');
});

test('Japanese action rules match by permission type', () => {
  const settings = {
    ...AAM.SETTINGS_DEFAULTS,
    actions: [{ id: 'a1', title: '何かのアクション', policy: 'connector.github.issues.list', chats: [], on: true }],
  };
  const card = AAM.parseCard('GitHub の List issues on GitHub を実行しますか？', '', 'connector.github.issues.list', '');
  assert.equal(AAM.isTrusted(settings, card), true);
});
