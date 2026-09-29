'use strict';

const choices = [...document.querySelectorAll('.choice')];

for (const choice of choices) {
  choice.querySelector('input').addEventListener('change', () => {
    choices.forEach(c => c.classList.toggle('on', c === choice));
  });
}

document.querySelector('#start').addEventListener('click', async () => {
  const mode = document.querySelector('input[name=mode]:checked').value;
  await chrome.storage.sync.set({ mode });
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id);
});

I18N.load();
