const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const loader = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_loader.js'), 'utf8');
const gate = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_vault_gate.js'), 'utf8');

test('faster storage modes require a freshly verified emergency-vault proof', () => {
  assert.doesNotThrow(() => new vm.Script(gate));
  assert.match(loader, /'indexeddb_requalification_vault_gate\.js'/);
  assert.ok(loader.indexOf("'indexeddb_requalification_guard.js'") < loader.indexOf("'indexeddb_requalification_vault_gate.js'"));
  assert.ok(loader.indexOf("'indexeddb_requalification_vault_gate.js'") < loader.indexOf("'indexeddb_requalification.js'"));
  assert.match(gate, /requested !== 'off'/);
  assert.match(gate, /__TASKPOINTS_REQUALIFICATION_VERIFIED_VAULT_HASH__/);
  assert.match(gate, /originalSetMode\('off'\)/);
});
