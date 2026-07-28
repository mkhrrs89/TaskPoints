const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification.html'), 'utf8');
const loader = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_loader.js'), 'utf8');
const compat = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_session_compat.js'), 'utf8');

test('the read-only page does not load the restart checker until an explicit action', () => {
  assert.doesNotMatch(page, /<script src="scoring_core\.js"/);
  assert.doesNotMatch(page, /<script src="indexeddb_requalification_session_compat\.js"/);
  assert.match(page, /indexeddb_requalification_loader\.js/);
});

test('the explicit-action runtime recognizes the stronger exclusive-lock restart checker', () => {
  assert.doesNotThrow(() => new vm.Script(compat));
  assert.match(loader, /'scoring_core\.js'/);
  assert.match(loader, /'indexeddb_requalification_session_compat\.js'/);
  assert.match(loader, /'indexeddb_requalification\.js'/);
  assert.ok(loader.indexOf("'scoring_core.js'") < loader.indexOf("'indexeddb_requalification_session_compat.js'"));
  assert.ok(loader.indexOf("'indexeddb_requalification_session_compat.js'") < loader.indexOf("'indexeddb_requalification.js'"));
  assert.match(compat, /broadcastSupported: status\.lockSupported === true/);
  assert.match(compat, /getIndexedDbBrowserSessionStatus/);
});
