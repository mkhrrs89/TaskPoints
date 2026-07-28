const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification.html'), 'utf8');
const loader = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_loader.js'), 'utf8');

test('opening the faster-storage page loads only the read-only scanner', () => {
  assert.doesNotThrow(() => new vm.Script(loader));
  assert.match(page, /Nothing will switch or write while this page is opening/);
  assert.match(page, /storage_health_codec\.js/);
  assert.match(page, /indexeddb_requalification_loader\.js/);
  assert.doesNotMatch(page, /<script src="scoring_core\.js"/);
  assert.doesNotMatch(page, /<script src="indexeddb_requalification\.js"/);
  assert.doesNotMatch(page, /<script src="phase4_cache_guard\.js"/);
  assert.match(loader, /scanReadOnly\(\)\.then\(renderReadOnly\)/);
  assert.match(loader, /for \(const src of RUNTIME_SCRIPTS\) await loadScript\(src\)/);
  assert.match(loader, /async function runExplicitAction\(buttonId\)/);
  assert.match(loader, /event\.stopImmediatePropagation\(\)/);
  assert.match(loader, /await loadRuntime\(\)/);
  assert.doesNotMatch(page, /player images?[^<]*(?:delete|remove)/i);
});
