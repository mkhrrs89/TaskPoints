const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification.html'), 'utf8');
const loader = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_loader.js'), 'utf8');

test('full storage modules are absent from initial HTML and load only after an explicit action', () => {
  assert.doesNotThrow(() => new vm.Script(loader));
  assert.doesNotMatch(page, /<script src="scoring_core\.js"/);
  assert.doesNotMatch(page, /<script src="indexeddb_requalification\.js"/);
  assert.match(loader, /async function runExplicitAction\(buttonId\)/);
  assert.match(loader, /await loadRuntime\(\)/);
  assert.match(loader, /for \(const src of RUNTIME_SCRIPTS\) await loadScript\(src\)/);
  assert.match(loader, /event\.stopImmediatePropagation\(\)/);
});

test('every Start or Finish attempt revalidates the emergency vault before loading or switching storage', () => {
  assert.match(loader, /const report = await scanReadOnly\(\)/);
  assert.match(loader, /if \(!report\?\.vault\?\.ready\)/);
  assert.match(loader, /const calculatedHash = api\.rawHash\(record\.raw\)/);
  assert.match(loader, /record\.rawHash !== calculatedHash/);
  assert.match(loader, /const vaultCountKeys = \[/);
  assert.match(loader, /!record\.counts \|\| !countsMatch\(counts, record\.counts, vaultCountKeys\)/);
  assert.match(loader, /__TASKPOINTS_REQUALIFICATION_VERIFIED_VAULT_HASH__/);
});