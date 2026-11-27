'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I18N = require('../i18n.js');

const ROOT = path.join(__dirname, '..');
const LOCALES = I18N.LANGUAGES.map(l => l.code);
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const messages = Object.fromEntries(LOCALES.map(locale => [locale, JSON.parse(read(`_locales/${locale}/messages.json`))]));

// HTML の data-i18n と、JS の t('literal') が参照するキーを集める
function usedKeys() {
  const keys = new Set();
  for (const file of ['options.html', 'popup.html', 'welcome.html']) {
    for (const match of read(file).matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)) keys.add(match[1]);
  }
  for (const file of ['options.js', 'popup.js', 'welcome.js', 'i18n.js', 'trust.js']) {
    for (const match of read(file).matchAll(/\bt\('([^']+)'/g)) keys.add(match[1]);
  }
  return keys;
}

test('every key referenced by the UI exists in every locale', () => {
  for (const key of usedKeys()) {
    for (const locale of LOCALES) {
      assert.ok(messages[locale][key], `${locale} is missing ${key}`);
    }
  }
});
