'use strict';

const { t } = I18N;
const $ = sel => document.querySelector(sel);
const URLS = {
  help: `${AAM.REPO_URL}#readme`,
  issue: `${AAM.REPO_URL}/issues`,
  rate: `${AAM.STORE_URL}/reviews`,
  source: AAM.REPO_URL,
};
const RATE_MIN_APPROVALS = 20;
const RATE_MIN_MS = 3 * 24 * 60 * 60 * 1000;
const SCOPE_TEXT = { site: 'scopeSite', siteChat: 'scopeSiteChat', chat: 'scopeChat', once: 'scopeOnce' };
const RESULT_TEXT = { allowed: 'resultAllowed', pending: 'resultPending', skipped: 'resultSkipped', handled: 'resultHandled' };

let settings = { ...AAM.SETTINGS_DEFAULTS };
let local = { ...AAM.LOCAL_DEFAULTS };
let pendingByTab = {};
const resolved = new Set();

async function loadState() {
  const [s, l, session] = await Promise.all([
    chrome.storage.sync.get(AAM.SETTINGS_DEFAULTS),
    chrome.storage.local.get(AAM.LOCAL_DEFAULTS),
    chrome.storage.session.get({ pendingByTab: {} }),
  ]);
  settings = s;
  local = l;
  pendingByTab = session.pendingByTab;
}

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  render();
  return chrome.storage.sync.set(patch);
}

const sep = () => (I18N.code === 'zh_TW' ? '、' : ', ');
const label = item => item.host || item.title || t('fromUnknown');
const tracking = () => settings.enabled && settings.mode === 'trusted';

function pendingItems() {
  if (!tracking()) return [];
  return AAM.mergePending(pendingByTab, local.dismissed).filter(i => !resolved.has(i.key));
}

function todayAllowed() {
  const today = new Date().toDateString();
  return local.log.filter(e => e.result === 'allowed' && new Date(e.ts).toDateString() === today).length;
}

function showRate() {
  return !local.ratingDismissed && local.approvals >= RATE_MIN_APPROVALS && local.installedAt > 0 && Date.now() - local.installedAt >= RATE_MIN_MS;
}

function renderHome() {
  const pending = pendingItems();
  const today = todayAllowed();
  $('#enabled').checked = settings.enabled;
  $('#status').textContent = settings.enabled ? t('statusOn', today) : t('statusPaused');
  $('#home-body').classList.toggle('dim', !settings.enabled);
  $('#alert').hidden = !pending.length;
  $('#alert-n').textContent = pending.length;
  $('#alert-title').textContent = t('pendingAlert', pending.length);
  $('#alert-sites').textContent = pending.map(label).join(sep());
  $('#mode').value = settings.mode;
  $('#mode-desc').textContent = t(settings.mode === 'all' ? 'modeAllDesc' : 'modeTrustedDesc');
  $('#lists').classList.toggle('dim', settings.mode === 'all');
  $('#sites-n').textContent = settings.sites.length;
  $('#chats-n').textContent = settings.chats.length;
  $('#today-n').textContent = t('todayN', today);
  $('#prefer-always').checked = settings.preferAlways;
  $('#rate').hidden = !showRate();
}

function scopeOptions(item) {
  const scopes = [];
  if (item.host) scopes.push('site');
  if (item.host && item.chat) scopes.push('siteChat');
  if (item.chat) scopes.push('chat');
  scopes.push('once');
  return scopes;
}

function scopeRadio(name, scope, checked) {
  const wrap = document.createElement('label');
  wrap.className = 'check';
  const input = Object.assign(document.createElement('input'), { type: 'radio', name, value: scope, checked });
  const text = document.createElement('span');
  text.textContent = t(SCOPE_TEXT[scope]);
  if (scope === 'chat') text.append(Object.assign(document.createElement('small'), { textContent: t('scopeChatWarn') }));
  wrap.append(input, text);
  return wrap;
}

function pendingCard(item) {
  const node = $('#tpl-pending').content.firstElementChild.cloneNode(true);
  I18N.apply(node);
  node.querySelector('.req-site').textContent = label(item);
  node.querySelector('.req-meta').textContent = `${item.chat ? t('from', item.chat) : t('fromUnknown')}・${I18N.ago(item.ts)}`;
  const radios = scopeOptions(item).map((scope, i) => scopeRadio(`scope-${item.key}`, scope, i === 0));
  node.querySelector('.scopes').append(...radios);
  node.querySelector('[data-act=allow]').addEventListener('click', () => {
    allowPending(item, node.querySelector('input[type=radio]:checked').value);
  });
  node.querySelector('[data-act=dismiss]').addEventListener('click', () => dismissPending(item));
  return node;
}

function renderPending() {
  const items = pendingItems();
  $('#pending-list').replaceChildren(...items.map(pendingCard));
  $('#pending-empty').hidden = items.length > 0;
}

// 依選的範圍加進信任清單；「只允許這一次」交給 content script 按掉那張卡，但不記住
async function allowPending(item, scope) {
  resolved.add(item.key);
  if (scope === 'once') {
    render();
    await chrome.storage.local.set({ allowOnce: [...new Set([...local.allowOnce, item.key])] });
  } else if (scope === 'chat') {
    await saveSettings({ chats: AAM.addChatRule(settings.chats, item.chat) });
  } else {
    await saveSettings({ sites: AAM.addSiteRule(settings.sites, item.host, { chat: scope === 'siteChat' ? item.chat : '' }) });
  }
}

async function dismissPending(item) {
  resolved.add(item.key);
  render();
  const log = local.log.map(e => (e.key === item.key && e.result === 'pending' ? { ...e, result: 'skipped' } : e));
  await chrome.storage.local.set({ dismissed: [...new Set([...local.dismissed, item.key])], log });
}

function row(title, sub, off, onRemove) {
  const el = document.createElement('div');
  el.className = off ? 'row off' : 'row';
  const text = document.createElement('div');
  text.textContent = title;
  text.append(Object.assign(document.createElement('small'), { textContent: sub }));
  const x = Object.assign(document.createElement('button'), { className: 'x', textContent: '×', title: t('remove') });
  x.addEventListener('click', onRemove);
  el.append(text, x);
  return el;
}

function renderSites() {
  const rows = settings.sites.map(site => row(
    site.sub ? t('withSub', site.host) : site.host,
    site.chats.length ? t('onlyChats', site.chats.join(sep())) : t('anyChat'),
    !site.on,
    () => saveSettings({ sites: settings.sites.filter(s => s.id !== site.id) }),
  ));
  $('#site-list').replaceChildren(...rows);
  $('#site-list').hidden = !rows.length;
  $('#sites-empty').hidden = rows.length > 0;
}

function recentChats() {
  const names = [...pendingItems().map(i => i.chat), ...local.log.map(e => e.chat)].filter(Boolean);
  return [...new Set(names)].slice(0, 8);
}

function renderChats() {
  const rows = settings.chats.map(chat => row(chat.name, t('chatAllSites'), !chat.on,
    () => saveSettings({ chats: settings.chats.filter(c => c.id !== chat.id) })));
  $('#chat-list').replaceChildren(...rows);
  $('#chat-list').hidden = !rows.length;
  $('#chats-empty').hidden = rows.length > 0;
  const recent = recentChats();
  const addable = recent.filter(name => !settings.chats.some(c => c.name === name));
  $('#recent-chats').replaceChildren(...addable.map(name => {
    const link = Object.assign(document.createElement('a'), { textContent: `＋ ${name}` });
    link.addEventListener('click', () => saveSettings({ chats: AAM.addChatRule(settings.chats, name) }));
    return link;
  }));
  $('#recent-empty').hidden = recent.length > 0;
}

function logRow(entry) {
  const el = document.createElement('div');
  el.className = 'row';
  const time = Object.assign(document.createElement('time'), { textContent: I18N.clock(entry.ts) });
  const text = document.createElement('div');
  text.textContent = label(entry);
  text.append(Object.assign(document.createElement('small'), { textContent: entry.chat || t('fromUnknown') }));
  const result = Object.assign(document.createElement('span'), { className: `result ${entry.result}`, textContent: t(RESULT_TEXT[entry.result] || 'resultAllowed') });
  el.append(time, text, result);
  return el;
}

function renderLog() {
  const entries = local.log.slice(0, 30);
  $('#log-list').replaceChildren(...entries.map(logRow));
  $('#log-list').hidden = !entries.length;
  $('#log-empty').hidden = entries.length > 0;
  $('#clear-log').hidden = !entries.length;
}

function render() {
  renderHome();
  renderPending();
  renderSites();
  renderChats();
  renderLog();
}

function go(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === id));
  $('#menu').hidden = true;
}

function openUrl(url) {
  chrome.tabs.create({ url });
  window.close();
}

function bind() {
  document.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
  document.querySelectorAll('.back').forEach(el => el.addEventListener('click', () => go('v-home')));
  $('#enabled').addEventListener('change', e => saveSettings({ enabled: e.target.checked }));
  $('#mode').addEventListener('change', e => saveSettings({ mode: e.target.value }));
  $('#prefer-always').addEventListener('change', e => saveSettings({ preferAlways: e.target.checked }));
  $('#site-form').addEventListener('submit', async e => {
    e.preventDefault();
    const host = AAM.normalizeHost($('#site-input').value);
    $('#site-error').hidden = !!host;
    if (!host) return;
    await saveSettings({ sites: AAM.addSiteRule(settings.sites, host, { sub: $('#site-sub').checked }) });
    $('#site-input').value = '';
    $('#site-sub').checked = false;
  });
  $('#clear-log').addEventListener('click', () => chrome.storage.local.set({ log: [] }));
  $('#open-options').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
  $('#more').addEventListener('click', () => { $('#menu').hidden = !$('#menu').hidden; });
  document.querySelectorAll('#menu [data-url]').forEach(el => el.addEventListener('click', () => openUrl(URLS[el.dataset.url])));
  $('#rate-x').addEventListener('click', () => chrome.storage.local.set({ ratingDismissed: true }));
  $('#rate-go').addEventListener('click', async () => {
    await chrome.storage.local.set({ ratingDismissed: true });
    openUrl(URLS.rate);
  });
}

(async () => {
  await I18N.load();
  await loadState();
  $('#version').textContent = `v${chrome.runtime.getManifest().version}`;
  bind();
  render();
  chrome.storage.onChanged.addListener(async () => {
    await loadState();
    render();
  });
})();
