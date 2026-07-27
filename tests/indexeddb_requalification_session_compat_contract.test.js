const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification.html'), 'utf8');
const compat = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_session_compat.js'), 'utf8');

test('setup page recognizes the stronger exclusive-lock restart checker', () => {
  assert.doesNotThrow(() => new vm.Script(compat));
  assert.ok(page.indexOf('phase4_cache_guard.js') < page.indexOf('indexeddb_requalification_session_compat.js'));
  assert.ok(page.indexOf('indexeddb_requalification_session_compat.js') < page.indexOf('indexeddb_requalification.js'));
  assert.match(compat, /broadcastSupported: status\.lockSupported === true/);
  assert.match(compat, /getIndexedDbBrowserSessionStatus/);
});
