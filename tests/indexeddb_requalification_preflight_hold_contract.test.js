const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification.html'), 'utf8');
const capture = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_preflight_hold.js'), 'utf8');
const guard = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_hold_guard.js'), 'utf8');

test('Recovery Hold is captured before the read-only scan or full runtime can load', () => {
  assert.doesNotThrow(() => new vm.Script(capture));
  assert.ok(page.indexOf('indexeddb_requalification_preflight_hold.js') < page.indexOf('storage_health_codec.js'));
  assert.ok(page.indexOf('indexeddb_requalification_preflight_hold.js') < page.indexOf('indexeddb_requalification_loader.js'));
  assert.match(capture, /__TASKPOINTS_REQUALIFICATION_PREFLIGHT_HOLD_CAPTURE__/);
  assert.match(capture, /localStorage\?\.getItem/);
});

test('runtime removal compares against the preflight hold rather than the later runtime value', () => {
  assert.match(guard, /const preflight = global\.__TASKPOINTS_REQUALIFICATION_PREFLIGHT_HOLD_CAPTURE__/);
  assert.match(guard, /preflight\?\.available !== true/);
  assert.match(guard, /core\.__indexedDbRequalificationGuardInstalled = false/);
  assert.match(guard, /core\.setPhase4StorageMode\?\.\('off'\)/);
  assert.match(guard, /const initialHoldRaw = preflight\.raw \?\? null/);
  assert.match(guard, /current !== initialHoldRaw/);
  assert.match(guard, /runtimeLoadHoldChanged/);
});
