'use strict';

// 設定頁可以強制指定介面語言，chrome.i18n 只跟著瀏覽器，所以自己讀 _locales
const I18N = (() => {
  // Single source of truth for supported UI languages; order matches the options selector.
  const LANGUAGES = Object.freeze([
    Object.freeze({ code: 'zh_TW', htmlLang: 'zh-Hant', dateLocale: 'zh-TW', label: '繁體中文', match: /^zh/i }),
    Object.freeze({ code: 'ja', htmlLang: 'ja', dateLocale: 'ja-JP', label: '日本語', match: /^ja/i }),
    Object.freeze({ code: 'en', htmlLang: 'en', dateLocale: 'en', label: 'English', match: /^en/i }),
  ]);
  const DEFAULT_CODE = 'en';
  let messages = {};
  let code = DEFAULT_CODE;

  const findLanguage = target => LANGUAGES.find(l => l.code === target);
  const current = () => findLanguage(code) || findLanguage(DEFAULT_CODE);

  function pickCode(lang, uiLang) {
    if (findLanguage(lang)) return lang;
    const ui = (uiLang ?? chrome.i18n.getUILanguage()).toLowerCase();
    return LANGUAGES.find(l => l.match.test(ui))?.code || DEFAULT_CODE;
  }

  async function load() {
    const { lang } = await chrome.storage.sync.get({ lang: 'auto' });
    code = pickCode(lang);
    const res = await fetch(chrome.runtime.getURL(`_locales/${code}/messages.json`));
    messages = await res.json();
    document.documentElement.lang = current().htmlLang;
    apply(document);
  }

  function t(key, ...subs) {
    let text = messages[key]?.message ?? key;
    subs.forEach((sub, i) => { text = text.split(`$${i + 1}`).join(String(sub)); });
    return text;
  }

  function apply(root) {
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
    for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  }

  // 「剛剛」「5 分鐘前」這種相對時間，超過一天就顯示日期
  function ago(ts) {
    const min = Math.floor((Date.now() - ts) / 60000);
    if (min < 1) return t('justNow');
    if (min < 60) return t('minutesAgo', min);
    if (min < 24 * 60) return t('hoursAgo', Math.floor(min / 60));
    return new Date(ts).toLocaleDateString(current().dateLocale);
  }

  function clock(ts) {
    const dateLocale = current().dateLocale;
    const d = new Date(ts);
    const hm = d.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit', hour12: false });
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return hm;
    today.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return `${t('yesterday')} ${hm}`;
    return d.toLocaleDateString(dateLocale, { month: 'numeric', day: 'numeric' }) + ` ${hm}`;
  }

  return { LANGUAGES, pickCode, load, t, apply, ago, clock, get code() { return code; } };
})();

if (typeof module !== 'undefined') module.exports = I18N;
