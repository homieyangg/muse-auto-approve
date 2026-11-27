'use strict';

// 設定頁可以強制指定介面語言，chrome.i18n 只跟著瀏覽器，所以自己讀 _locales
const I18N = (() => {
  const HTML_LANG = { zh_TW: 'zh-Hant', ja: 'ja', en: 'en' };
  const DATE_LOCALE = { zh_TW: 'zh-TW', ja: 'ja-JP', en: 'en' };
  let messages = {};
  let code = 'en';

  function pickCode(lang) {
    if (['zh_TW', 'ja', 'en'].includes(lang)) return lang;
    const ui = chrome.i18n.getUILanguage().toLowerCase();
    if (ui.startsWith('zh')) return 'zh_TW';
    return ui.startsWith('ja') ? 'ja' : 'en';
  }

  async function load() {
    const { lang } = await chrome.storage.sync.get({ lang: 'auto' });
    code = pickCode(lang);
    const res = await fetch(chrome.runtime.getURL(`_locales/${code}/messages.json`));
    messages = await res.json();
    document.documentElement.lang = HTML_LANG[code];
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
    return new Date(ts).toLocaleDateString(DATE_LOCALE[code]);
  }

  function clock(ts) {
    const d = new Date(ts);
    const hm = d.toLocaleTimeString(DATE_LOCALE[code], { hour: '2-digit', minute: '2-digit', hour12: false });
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return hm;
    today.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return `${t('yesterday')} ${hm}`;
    return d.toLocaleDateString(DATE_LOCALE[code], { month: 'numeric', day: 'numeric' }) + ` ${hm}`;
  }

  return { load, t, apply, ago, clock, get code() { return code; } };
})();
