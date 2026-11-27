'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LOCALES = ['en', 'zh_TW', 'ja'];
const read = locale => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '_locales', locale, 'messages.json'), 'utf8'));

test('every locale has the same non-empty message keys', () => {
  const messages = Object.fromEntries(LOCALES.map(locale => [locale, read(locale)]));
  const keys = Object.keys(messages.en);

  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(messages[locale]).sort(), [...keys].sort(), `${locale} keys`);
    for (const key of keys) {
      assert.equal(typeof messages[locale][key].message, 'string', `${locale}.${key} is a string`);
      assert.ok(messages[locale][key].message.trim(), `${locale}.${key} is not empty`);
    }
  }
});

test('manifest messages fit Chrome limits', () => {
  for (const locale of LOCALES) {
    const messages = read(locale);
    assert.ok(messages.extName.message.length <= 75, `${locale} extName`);
    assert.ok(messages.extDescription.message.length <= 132, `${locale} extDescription`);
  }
});
