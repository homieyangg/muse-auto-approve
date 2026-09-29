'use strict';

const DEFAULTS = { enabled: true, preferAlways: true, count: 0, log: [] };

function render({ enabled, preferAlways, count, log }) {
  document.getElementById('enabled').checked = enabled;
  document.getElementById('preferAlways').checked = preferAlways;
  document.getElementById('count').textContent = count;
  const list = document.getElementById('log');
  list.replaceChildren(...log.map(({ ts, kind, summary }) => {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = new Date(ts).toLocaleTimeString();
    li.append(time, `[${kind === 'always' ? '一律' : '一次'}] ${summary}`);
    return li;
  }));
}

chrome.storage.local.get(DEFAULTS, render);
chrome.storage.onChanged.addListener(() => chrome.storage.local.get(DEFAULTS, render));

for (const key of ['enabled', 'preferAlways']) {
  document.getElementById(key).addEventListener('change', e => chrome.storage.local.set({ [key]: e.target.checked }));
}
document.getElementById('clear').addEventListener('click', () => chrome.storage.local.set({ count: 0, log: [] }));
