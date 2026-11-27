'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// Files the zip command in scripts/pack.sh puts in the store build
function packed() {
  const zip = read('scripts/pack.sh').replace(/\\\n/g, ' ').split('\n').find(line => /^\s*zip\b/.test(line));
  return new Set(zip.trim().split(/\s+/).slice(3));
}

function scriptsInManifest() {
  const manifest = JSON.parse(read('manifest.json'));
  const files = manifest.content_scripts.flatMap(c => c.js);
  files.push(manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page);
  return files;
}

test('every script the extension loads is in the store zip', () => {
  const zip = packed();
  const pages = [...zip].filter(f => f.endsWith('.html'));
  const scripts = pages.flatMap(page => [...read(page).matchAll(/<script src="([^"]+)"/g)].map(m => m[1]));
  for (const file of [...scriptsInManifest(), ...scripts]) assert.ok(zip.has(file), `${file} missing from scripts/pack.sh`);
});
