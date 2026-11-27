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
const SCOPE_TEXT = { site: 'scopeSite', siteChat: 'scopeSiteChat', action: 'scopeAction', actionChat: 'scopeActionChat', chat: 'scopeChat', once: 'scopeOnce' };
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

const saveChats = list => saveSettings(AAM.splitChats(list));

const sep = () => (I18N.code === 'en' ? ', ' : '、');
const label = item => AAM.cardLabel(item, t) || t('fromUnknown');
const tracking = () => settings.enabled;
const hasIds = item => AAM.hasIds(AAM.cardPair(item));
// Display only: rules always store the name read from the card, never the sidebar's
const sidebarName = threadId => (threadId && local.museChatNames?.[threadId]) || '';
const chatName = item => item.chat || sidebarName(AAM.cardPair(item).threadId);
const chatLabel = entry => entry.name || sidebarName(entry.threadId) || t('fromUnknown');

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
  $('#sites-n').textContent = settings.sites.length;
  $('#chats-n').textContent = AAM.trustedChats(settings).length;
  $('#actions-n').textContent = settings.actions.length;
  $('#today-n').textContent = t('todayN', today);
  $('#prefer-always').checked = settings.preferAlways;
  $('#rate').hidden = !showRate();
}

// 說明這張卡為什麼沒有自動按：購買卡永遠要人工決定；「全部允許」預設不含發文這類動作
function pendingReason(item) {
  if (AAM.isPurchase(item)) return 'reasonPurchase';
  if (settings.mode === 'all' && !item.host && !item.site && !settings.includeActions) return 'reasonAction';
  return '';
}

// 結帳、購買的卡插件不會自動按，只給「只允許這一次」
function scopeOptions(item) {
  if (AAM.isPurchase(item)) return ['once'];
  const scopes = [];
  if (item.host) scopes.push('site');
  // A card whose ids couldn't be read is never trusted by its name: the name might be another chat's
  const named = item.chat && !item.badIds;
  if (item.host && named) scopes.push('siteChat');
  if (!item.host && item.action) scopes.push('action');
  if (!item.host && item.action && named) scopes.push('actionChat');
  if (named || hasIds(item)) scopes.push('chat');
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
  node.querySelector('.req-meta').textContent = `${chatName(item) ? t('from', chatName(item)) : t('fromUnknown')}・${I18N.ago(item.ts)}`;
  const reason = pendingReason(item);
  const note = node.querySelector('.req-reason');
  note.hidden = !reason;
  note.textContent = reason ? t(reason) : '';
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
// Only the chat rule stores ids; site and action limits are main's names. Every scope here is one scopeOptions offered
async function allowPending(item, scope) {
  if (!scopeOptions(item).includes(scope)) return;
  resolved.add(item.key);
  const ids = AAM.cardPair(item);
  if (scope === 'once') {
    render();
    await chrome.storage.local.set({ allowOnce: [...new Set([...local.allowOnce, item.key])] });
  } else if (scope === 'chat') {
    await saveChats(AAM.addChatRule(AAM.trustedChats(settings), item.chat || '', ids));
  } else if (scope === 'action' || scope === 'actionChat') {
    await saveSettings({ actions: AAM.addActionRule(settings.actions, item.action, { chat: scope === 'actionChat' ? item.chat : '', policy: item.policy, site: item.site }) });
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

function renderActions() {
  const rows = settings.actions.map(action => row(
    label(action),
    action.chats.length ? t('onlyChats', action.chats.join(sep())) : t('anyChat'),
    !action.on,
    () => saveSettings({ actions: settings.actions.filter(a => a.id !== action.id) }),
  ));
  $('#action-list').replaceChildren(...rows);
  $('#action-list').hidden = !rows.length;
  $('#actions-empty').hidden = rows.length > 0;
}

// Chats seen with ids are offered by their pair (see AAM.chatChoices)
function recentChats() {
  const items = [...pendingItems(), ...local.log];
  return AAM.chatChoices({ names: local.museChats, museChatNames: local.museChatNames, chats: AAM.trustedChats(settings), items }).slice(0, 20);
}

function renderChats() {
  const chats = AAM.trustedChats(settings);
  const labels = AAM.chatLabels(chats, chatLabel);
  const rows = chats.map((chat, i) => row(labels[i], t('chatAllSites'), !chat.on,
    () => saveChats(chats.filter(c => c.id !== chat.id))));
  $('#chat-list').replaceChildren(...rows);
  $('#chat-list').hidden = !rows.length;
  $('#chats-empty').hidden = rows.length > 0;
  const recent = recentChats();
  const addable = recent.filter(choice => !AAM.listsChat(chats, choice));
  const addLabels = AAM.chatLabels([...chats, ...addable], chatLabel).slice(chats.length);
  $('#recent-chats').replaceChildren(...addable.map((choice, i) => {
    const link = Object.assign(document.createElement('a'), { textContent: `＋ ${addLabels[i]}` });
    link.addEventListener('click', () => saveChats(AAM.addChatRule(chats, choice.name, choice)));
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
  text.append(Object.assign(document.createElement('small'), { textContent: chatName(entry) || t('fromUnknown') }));
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
  renderActions();
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
