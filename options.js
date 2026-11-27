'use strict';

const { t } = I18N;
const $ = sel => document.querySelector(sel);
const URLS = {
  help: `${AAM.REPO_URL}#readme`,
  issue: `${AAM.REPO_URL}/issues`,
  rate: `${AAM.STORE_URL}/reviews`,
  changelog: `${AAM.REPO_URL}/releases`,
};
const PAGES = ['general', 'sites', 'chats', 'actions', 'log', 'backup', 'about'];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RESULT_TEXT = { allowed: 'resultAllowed', pending: 'resultPending', skipped: 'resultSkipped', handled: 'resultHandled' };
const GLOBE = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
const BUBBLE = '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>';
const BOLT = '<svg viewBox="0 0 24 24"><path d="M13 3 5 13h6l-1 8 8-10h-6z"/></svg>';

let settings = { ...AAM.SETTINGS_DEFAULTS };
let local = { ...AAM.LOCAL_DEFAULTS };
let pendingByTab = {};
let selectedSite = null;
let selectedChat = null;
let selectedAction = null;
let logFilter = '';

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
  renderAll();
  return chrome.storage.sync.set(patch);
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c !== null && c !== undefined));
  return node;
}

function glyph(svg) {
  const node = el('span', { className: 'glyph' });
  node.innerHTML = svg;
  return node;
}

function toggle(checked, onChange) {
  const input = el('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { className: 'sw sm' }, input, el('span'));
}

function check(type, checked, text, onChange, name) {
  const input = el('input', { type, checked, name: name || '' });
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { className: 'check' }, input, el('span', { textContent: text }));
}

const sep = () => (I18N.code === 'en' ? ', ' : '、');
const sameHost = (a, b) => AAM.hostMatches({ host: a, sub: false }, b);

// 可挑的聊天室：muse 側邊欄記下的，加上信任清單、網站限定的聊天室、紀錄和等你決定裡的
function knownChats() {
  const names = [
    ...local.museChats,
    ...settings.chats.map(c => c.name),
    ...settings.sites.flatMap(s => s.chats),
    ...settings.actions.flatMap(a => a.chats),
    ...AAM.mergePending(pendingByTab).map(i => i.chat),
    ...local.log.map(e => e.chat),
  ].filter(Boolean);
  return [...new Set(names)];
}

function currentPage() {
  const page = location.hash.slice(1);
  return PAGES.includes(page) ? page : 'general';
}

function renderNav() {
  const page = currentPage();
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.id === `page-${page}`));
  document.querySelectorAll('.nav[href]').forEach(a => a.classList.toggle('on', a.getAttribute('href') === `#${page}`));
  $('#nav-sites-n').textContent = settings.sites.length;
  $('#nav-chats-n').textContent = settings.chats.length;
  $('#nav-actions-n').textContent = settings.actions.length;
}

function renderGeneral() {
  $('#enabled').checked = settings.enabled;
  document.querySelectorAll('input[name=mode]').forEach(r => { r.checked = r.value === settings.mode; });
  $('#prefer-always').checked = settings.preferAlways;
  $('#open-background').checked = settings.openBackground;
  $('#include-actions').checked = settings.includeActions;
  $('#lang').value = settings.lang;
}

function updateSite(id, patch) {
  return saveSettings({ sites: settings.sites.map(s => (s.id === id ? { ...s, ...patch } : s)) });
}

function siteScopeText(site) {
  const scope = site.chats.length ? t('onlyChats', site.chats.join(sep())) : t('anyChat');
  return site.sub ? `${t('subShort')}・${scope}` : scope;
}

function siteEntry(site) {
  const entry = el('div', { className: `entry${site.id === selectedSite ? ' on' : ''}${site.on ? '' : ' off'}` },
    glyph(GLOBE),
    el('div', {}, el('b', { textContent: site.host }), el('small', { textContent: siteScopeText(site) })),
    toggle(site.on, on => updateSite(site.id, { on })));
  entry.addEventListener('click', e => {
    if (e.target.closest('.sw')) return;
    selectedSite = site.id;
    renderSites(true);
  });
  return entry;
}

function siteStats(site) {
  const hits = local.log.filter(e => e.result === 'allowed' && e.host && Date.now() - e.ts < WEEK_MS && AAM.hostMatches(site, e.host));
  return hits.length ? t('siteStats', hits.length, I18N.clock(hits[0].ts)) : t('siteStatsNone');
}

// 「任何聊天室／只限這些聊天室」加聊天室勾選；chats 是空陣列就代表任何聊天室
function chatScopeFields(selected, onChange) {
  const options = [...new Set([...selected, ...knownChats()])];
  let only = selected.length > 0;
  const pick = el('div', { className: 'chat-pick', hidden: !only });
  if (!options.length) pick.append(el('small', { className: 'muted', textContent: t('chatPickEmpty') }));
  for (const name of options) {
    pick.append(check('checkbox', selected.includes(name), name, on => {
      selected = on ? [...selected, name] : selected.filter(n => n !== name);
      onChange(selected);
    }));
  }
  if (options.length) pick.append(el('small', { className: 'muted', textContent: t('chatPickHint') }));
  const group = `scope-${Math.random().toString(36).slice(2)}`;
  const any = check('radio', !only, t('anyChat'), () => { only = false; pick.hidden = true; onChange([]); }, group);
  const onlyRadio = check('radio', only, t('onlyTheseChats'), () => { only = true; pick.hidden = false; }, group);
  return [el('label', { className: 'field-label', textContent: t('scopeLabel') }), any, onlyRadio, pick];
}

function siteDetail(site) {
  const input = el('input', { className: 'text-input', value: site.host });
  const error = el('p', { className: 'error', textContent: t('siteInvalid'), hidden: true });
  input.addEventListener('change', () => {
    const host = AAM.normalizeHost(input.value);
    error.hidden = !!host;
    if (host && host !== site.host) updateSite(site.id, { host });
  });
  const remove = el('button', { className: 'btn danger', textContent: t('deleteRule') });
  remove.addEventListener('click', () => { saveSettings({ sites: settings.sites.filter(s => s.id !== site.id) }); renderSites(true); });
  return [
    el('div', { className: 'detail-head' }, glyph(GLOBE), el('b', { textContent: site.host })),
    el('label', { className: 'field-label', textContent: t('siteLabel') }), input, error,
    check('checkbox', site.sub, t('includeSub'), sub => updateSite(site.id, { sub })),
    ...chatScopeFields(site.chats, chats => updateSite(site.id, { chats })),
    el('p', { className: 'stats', textContent: siteStats(site) }),
    el('div', { className: 'detail-foot' }, el('span'), remove),
  ];
}

function newSiteForm() {
  let chats = [];
  let sub = false;
  const input = el('input', { className: 'text-input', placeholder: t('sitePlaceholder') });
  const error = el('p', { className: 'error', textContent: t('siteInvalid'), hidden: true });
  const create = el('button', { className: 'btn primary', textContent: t('create') });
  create.addEventListener('click', () => {
    const host = AAM.normalizeHost(input.value);
    error.hidden = !!host;
    if (!host) return;
    const existing = settings.sites.find(s => sameHost(s.host, host));
    selectedSite = existing ? existing.id : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const rule = { id: selectedSite, host, sub: sub || !!existing?.sub, chats, on: true };
    saveSettings({ sites: existing ? settings.sites.map(s => (s.id === existing.id ? rule : s)) : [...settings.sites, rule] });
    renderSites(true);
  });
  return [
    el('div', { className: 'detail-head' }, glyph(GLOBE), el('b', { textContent: t('newSite') })),
    el('label', { className: 'field-label', textContent: t('siteLabel') }), input, error,
    check('checkbox', false, t('includeSub'), v => { sub = v; }),
    ...chatScopeFields([], v => { chats = v; }),
    el('div', { className: 'detail-foot' }, el('span'), create),
  ];
}

function renderSites(force) {
  if (selectedSite !== 'new' && !settings.sites.some(s => s.id === selectedSite)) selectedSite = settings.sites[0]?.id ?? 'new';
  $('#site-new').classList.toggle('on', selectedSite === 'new');
  $('#site-items').replaceChildren(...settings.sites.map(siteEntry));
  if (!force && $('#site-detail').contains(document.activeElement)) return;
  const site = settings.sites.find(s => s.id === selectedSite);
  $('#site-detail').replaceChildren(...(site ? siteDetail(site) : newSiteForm()));
}

function chatEntry(chat) {
  const entry = el('div', { className: `entry${chat.id === selectedChat ? ' on' : ''}${chat.on ? '' : ' off'}` },
    glyph(BUBBLE),
    el('div', {}, el('b', { textContent: chat.name }), el('small', { textContent: t('chatAllSites') })),
    toggle(chat.on, on => saveSettings({ chats: settings.chats.map(c => (c.id === chat.id ? { ...c, on } : c)) })));
  entry.addEventListener('click', e => {
    if (e.target.closest('.sw')) return;
    selectedChat = chat.id;
    renderChats(true);
  });
  return entry;
}

function chatDetail(chat) {
  const seen = new Map();
  for (const e of local.log) if (e.chat === chat.name && e.host && !seen.has(e.host)) seen.set(e.host, e.ts);
  const recent = [...seen].slice(0, 8).map(([host, ts]) => `${host}・${I18N.clock(ts)}`);
  const remove = el('button', { className: 'btn danger', textContent: t('deleteRule') });
  remove.addEventListener('click', () => { saveSettings({ chats: settings.chats.filter(c => c.id !== chat.id) }); renderChats(true); });
  const list = el('div', { className: 'recent-sites' });
  recent.forEach((line, i) => { if (i) list.append(el('br')); list.append(line); });
  return [
    el('div', { className: 'detail-head' }, glyph(BUBBLE), el('b', { textContent: chat.name })),
    el('p', { className: 'warn', textContent: t('chatDetailWarn') }),
    el('label', { className: 'field-label', textContent: t('chatRecentSites') }),
    recent.length ? list : el('p', { className: 'muted', textContent: t('chatRecentSitesEmpty') }),
    el('div', { className: 'detail-foot' }, el('span'), remove),
  ];
}

function addChat(name) {
  const chats = AAM.addChatRule(settings.chats, name);
  selectedChat = chats.find(c => c.name === name).id;
  saveSettings({ chats });
  renderChats(true);
}

function newChatForm() {
  const input = el('input', { className: 'text-input', placeholder: t('chatNamePlaceholder') });
  const create = el('button', { className: 'btn primary', textContent: t('create') });
  create.addEventListener('click', () => { const name = input.value.trim(); if (name) addChat(name); });
  const addable = knownChats().filter(n => !settings.chats.some(c => c.name === n));
  const links = el('div', { className: 'links' }, ...addable.map(name => {
    const link = el('a', { textContent: `＋ ${name}` });
    link.addEventListener('click', () => addChat(name));
    return link;
  }));
  return [
    el('div', { className: 'detail-head' }, glyph(BUBBLE), el('b', { textContent: t('newChat') })),
    el('label', { className: 'field-label', textContent: t('recentChats') }),
    addable.length ? links : el('p', { className: 'muted', textContent: t('recentChatsEmpty') }),
    el('label', { className: 'field-label', textContent: t('chatNameLabel') }), input,
    el('p', { className: 'warn', textContent: t('chatWarn') }),
    el('div', { className: 'detail-foot' }, el('span'), create),
  ];
}

function renderChats(force) {
  if (selectedChat !== 'new' && !settings.chats.some(c => c.id === selectedChat)) selectedChat = settings.chats[0]?.id ?? 'new';
  $('#chat-new').classList.toggle('on', selectedChat === 'new');
  $('#chat-items').replaceChildren(...settings.chats.map(chatEntry));
  if (!force && $('#chat-detail').contains(document.activeElement)) return;
  const chat = settings.chats.find(c => c.id === selectedChat);
  $('#chat-detail').replaceChildren(...(chat ? chatDetail(chat) : newChatForm()));
}

function updateAction(id, patch) {
  return saveSettings({ actions: settings.actions.map(a => (a.id === id ? { ...a, ...patch } : a)) });
}

function actionEntry(action) {
  const chatScope = action.chats.length ? t('onlyChats', action.chats.join(sep())) : t('anyChat');
  const scope = action.site && action.sub ? `${t('subShort')}・${chatScope}` : chatScope;
  const entry = el('div', { className: `entry${action.id === selectedAction ? ' on' : ''}${action.on ? '' : ' off'}` },
    glyph(BOLT),
    el('div', {}, el('b', { textContent: AAM.cardLabel(action, t) }), el('small', { textContent: scope })),
    toggle(action.on, on => updateAction(action.id, { on })));
  entry.addEventListener('click', e => {
    if (e.target.closest('.sw')) return;
    selectedAction = action.id;
    renderActions(true);
  });
  return entry;
}

// Upload rules can change their site and cover its subdomains, e.g. one myworkdayjobs.com rule for every company's Workday host.
// Compares against the stored rule, not the one the panel was built from, because the panel isn't rebuilt while it has focus
function uploadSiteFields(action, current) {
  const input = el('input', { className: 'text-input', value: action.site });
  const error = el('p', { className: 'error', textContent: t('siteInvalid'), hidden: true });
  input.addEventListener('change', () => {
    // The site was removed elsewhere and the rebuild that drops this field fires change on blur; don't write the draft back
    if (!current().site) return;
    const site = AAM.normalizeHost(input.value);
    error.hidden = !!site;
    if (!site) return;
    input.value = site;
    if (site !== current().site) updateAction(action.id, { site });
  });
  const sub = check('checkbox', !!action.sub, t('includeSub'), on => updateAction(action.id, { sub: on }));
  // Only an unsaved edit in the focused input is kept; otherwise the input follows the stored site
  let shown = action.site;
  const refresh = rule => {
    if (document.activeElement !== input || input.value === shown) {
      input.value = rule.site;
      error.hidden = true;
    }
    shown = rule.site;
    sub.querySelector('input').checked = !!rule.sub;
  };
  return { nodes: [el('label', { className: 'field-label', textContent: t('siteLabel') }), input, error, sub], refresh };
}

function actionStatsText(action) {
  const sameSite = e => !action.site || AAM.hostMatches({ host: action.site, sub: !!action.sub }, e.site || '');
  const hits = local.log.filter(e => e.result === 'allowed' && e.action === action.title && sameSite(e) && Date.now() - e.ts < WEEK_MS);
  return hits.length ? t('siteStats', hits.length, I18N.clock(hits[0].ts)) : t('siteStatsNone');
}

// The rule shown in the detail panel; renderActions updates it in place so the panel never shows a stale site, scope or heading
let actionPanel = null;

// What the chat checkboxes were built from: the rule's chats and every chat that can be picked
const chatPickKey = action => JSON.stringify([action.chats, [...new Set([...action.chats, ...knownChats()])].sort()]);

function actionDetail(action) {
  const current = () => settings.actions.find(a => a.id === action.id) || action;
  const heading = el('b', { textContent: AAM.cardLabel(action, t) });
  const stats = el('p', { className: 'stats', textContent: actionStatsText(action) });
  const site = action.site ? uploadSiteFields(action, current) : null;
  const remove = el('button', { className: 'btn danger', textContent: t('deleteRule') });
  remove.addEventListener('click', () => { saveSettings({ actions: settings.actions.filter(a => a.id !== action.id) }); renderActions(true); });
  actionPanel = {
    id: action.id,
    upload: !!action.site,
    chatKey: chatPickKey(action),
    refresh: rule => {
      heading.textContent = AAM.cardLabel(rule, t);
      stats.textContent = actionStatsText(rule);
      site?.refresh(rule);
    },
  };
  return [
    el('div', { className: 'detail-head' }, glyph(BOLT), heading),
    ...(site ? site.nodes : []),
    ...chatScopeFields(action.chats, chats => updateAction(action.id, { chats })),
    stats,
    el('div', { className: 'detail-foot' }, el('span'), remove),
  ];
}

// Typing a site and then clicking "Include subdomains" saves the site on mousedown. Redrawing then can shorten the
// heading and move the checkbox before mouseup, so the click is lost; wait until the button is released
// Dragging a link ends with pointercancel instead of pointerup
let pointerHeld = false;
let renderOnRelease = false;
const releasePointer = () => {
  pointerHeld = false;
  if (renderOnRelease) {
    renderOnRelease = false;
    setTimeout(() => renderActions());
  }
};
document.addEventListener('pointerdown', () => { pointerHeld = true; }, true);
document.addEventListener('pointerup', releasePointer, true);
document.addEventListener('pointercancel', releasePointer, true);

// 動作只能從審批卡加入，這裡沒有新增表單
// The same rule is updated in place instead of rebuilt, so the checkbox being clicked survives. The chat checkboxes
// can't be updated in place, so they are rebuilt when they changed, but not while focus is inside the panel
function renderActions(force) {
  if (!force && pointerHeld) {
    renderOnRelease = true;
    return;
  }
  if (!settings.actions.some(a => a.id === selectedAction)) selectedAction = settings.actions[0]?.id ?? null;
  $('#action-items').replaceChildren(...settings.actions.map(actionEntry));
  $('#actions-empty').hidden = settings.actions.length > 0;
  $('#action-detail').hidden = !settings.actions.length;
  const action = settings.actions.find(a => a.id === selectedAction);
  const focused = $('#action-detail').contains(document.activeElement);
  const sameRule = !force && action && actionPanel?.id === action.id;
  // A rule that gained or lost its site (import, sync) needs the Site field added or removed, so it's always rebuilt
  if (sameRule && actionPanel.upload === !!action.site && (focused || actionPanel.chatKey === chatPickKey(action))) {
    actionPanel.refresh(action);
    return;
  }
  if (!force && focused && !sameRule) return;
  actionPanel = null;
  $('#action-detail').replaceChildren(...(action ? actionDetail(action) : []));
}

const trustControls = AAT.controls({ t, storage: chrome.storage.sync, render: () => renderLog() });

function trustCell({ state, undo, open }, entry) {
  if (state === 'offer') return trustControls.trustButton(entry, open);
  if (state !== 'trusted') return null;
  return el('span', { className: 'ok', textContent: t('trusted') }, undo ? trustControls.undoButton('') : null);
}

function logRows(entry, row) {
  const tr = el('tr', { className: row.open ? 'open' : '' },
    el('td', { textContent: I18N.clock(entry.ts) }),
    el('td', { textContent: AAT.rowLabel(entry, t) }),
    el('td', { textContent: entry.chat || t('fromUnknown') }),
    el('td', { className: `result ${entry.result}`, textContent: t(RESULT_TEXT[entry.result] || 'resultAllowed') }),
    el('td', { className: 'act' }, trustCell(row, entry)));
  return row.open ? [tr, el('tr', { className: 'pick' }, el('td', { colSpan: 5 }, trustControls.pickButtons(entry)))] : [tr];
}

// Trust is offered on the newest row of each card in the whole log, so a filter can hide it
function renderLog() {
  $('#log-lead').textContent = t('logLead', AAM.LOG_LIMIT);
  document.querySelectorAll('#log-filter [data-filter]').forEach(a => a.classList.toggle('on', a.dataset.filter === logFilter));
  const entries = local.log.filter(e => !logFilter || e.result === logFilter);
  const states = trustControls.states(settings, local.log, entries);
  $('#log-rows').replaceChildren(...entries.flatMap(e => logRows(e, states.get(e))));
  $('#log-empty').hidden = entries.length > 0;
}

function renderAll() {
  renderNav();
  renderGeneral();
  renderSites();
  renderChats();
  renderActions();
  renderLog();
}

function exportSettings() {
  const data = { app: 'auto-approve-for-muse', version: chrome.runtime.getManifest().version, exportedAt: new Date().toISOString(), settings };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  el('a', { href: url, download: `auto-approve-for-muse-${day}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importSettings(file) {
  const result = $('#import-result');
  result.hidden = false;
  try {
    const data = JSON.parse(await file.text());
    const clean = AAM.sanitizeSettings(data.settings || data);
    if (!confirm(t('importConfirm'))) { result.hidden = true; return; }
    await chrome.storage.sync.set(clean);
    result.className = '';
    result.textContent = t('importDone', clean.sites.length, clean.chats.length);
  } catch {
    result.className = 'error';
    result.textContent = t('importFailed');
  }
}

function bind() {
  window.addEventListener('hashchange', renderNav);
  $('#enabled').addEventListener('change', e => saveSettings({ enabled: e.target.checked }));
  document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', () => saveSettings({ mode: r.value })));
  $('#prefer-always').addEventListener('change', e => saveSettings({ preferAlways: e.target.checked }));
  $('#open-background').addEventListener('change', e => saveSettings({ openBackground: e.target.checked }));
  $('#include-actions').addEventListener('change', e => saveSettings({ includeActions: e.target.checked }));
  $('#lang').append(...I18N.LANGUAGES.map(l => el('option', { value: l.code, textContent: l.label })));
  $('#lang').addEventListener('change', async e => { await saveSettings({ lang: e.target.value }); location.reload(); });
  $('#site-new').addEventListener('click', () => { selectedSite = 'new'; renderSites(true); });
  $('#chat-new').addEventListener('click', () => { selectedChat = 'new'; renderChats(true); });
  document.querySelectorAll('#log-filter [data-filter]').forEach(a => a.addEventListener('click', () => { logFilter = a.dataset.filter; renderLog(); }));
  $('#clear-log').addEventListener('click', () => chrome.storage.local.set({ log: [] }));
  $('#export').addEventListener('click', exportSettings);
  $('#import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', e => { if (e.target.files[0]) importSettings(e.target.files[0]); e.target.value = ''; });
  document.querySelectorAll('[data-url]').forEach(a => Object.assign(a, { href: URLS[a.dataset.url], target: '_blank', rel: 'noopener' }));
  Object.assign($('#changelog'), { href: URLS.changelog, rel: 'noopener' });
}

(async () => {
  await I18N.load();
  await loadState();
  $('#version').textContent = `v${chrome.runtime.getManifest().version}`;
  bind();
  renderAll();
  chrome.storage.onChanged.addListener(async () => {
    await loadState();
    renderAll();
  });
})();
