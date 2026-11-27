'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I18N = require('../i18n.js');
const AAM = require('../shared.js');

const LOCALES_DIR = path.join(__dirname, '..', '_locales');
const LOCALES = I18N.LANGUAGES.map(l => l.code);
const read = locale => JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'messages.json'), 'utf8'));

test('language list matches _locales folders', () => {
  const dirs = fs.readdirSync(LOCALES_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  assert.deepEqual([...LOCALES].sort(), [...dirs].sort());
  for (const lang of I18N.LANGUAGES) {
    assert.ok(fs.existsSync(path.join(LOCALES_DIR, lang.code, 'messages.json')), `${lang.code} messages.json`);
    assert.ok(lang.htmlLang && lang.dateLocale && lang.label, `${lang.code} metadata`);
    assert.ok(lang.match instanceof RegExp, `${lang.code} match`);
  }
});

test('pickCode and sanitizeSettings follow the language list', () => {
  for (const code of LOCALES) {
    assert.equal(I18N.pickCode(code, 'en-US'), code);
    assert.equal(AAM.sanitizeSettings({ lang: code }).lang, code);
  }
  assert.equal(AAM.sanitizeSettings({ lang: 'auto' }).lang, 'auto');
  assert.equal(AAM.sanitizeSettings({ lang: 'unknown' }).lang, 'auto');
  for (const ui of ['zh', 'zh-TW', 'zh_TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-TW', 'zh-MY', 'zh-yue']) assert.equal(I18N.pickCode('auto', ui), 'zh_TW');
  for (const ui of ['zh-CN', 'zh-cn', 'zh_CN', 'zh-Hans', 'zh-Hans-CN', 'zh-SG']) assert.equal(I18N.pickCode('auto', ui), 'zh_CN');
  for (const ui of ['ja', 'ja-JP']) assert.equal(I18N.pickCode('auto', ui), 'ja');
  for (const ui of ['en', 'en-US', 'fr', 'fr-FR', '']) assert.equal(I18N.pickCode('auto', ui), 'en');
});

test('every locale has the same non-empty message keys', () => {
  const messages = Object.fromEntries(LOCALES.map(locale => [locale, read(locale)]));
  const keys = Object.keys(messages[LOCALES[0]]);

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
