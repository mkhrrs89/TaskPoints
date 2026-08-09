const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../season_result_integrity_guard.js'), 'utf8');

test('ordinary load repair no longer synchronously persists a full snapshot', () => {
  const match = source.match(/if \(original\.loadAppState\) c\.loadAppState = function loadFixed[\s\S]*?\n  \};/);
  assert.ok(match, 'loadFixed wrapper should exist');
  assert.match(match[0], /scheduleLoadRepairPersist\(options\)/);
  assert.doesNotMatch(match[0], /persist\(fixed\.state/);
});

test('deferred persistence waits 14s, then uses the shared quiet gate', () => {
  assert.match(source, /const LOAD_REPAIR_PERSIST_DELAY_MS = 14000;/);
  assert.match(source, /g\.setTimeout\(enterQuietGate, LOAD_REPAIR_PERSIST_DELAY_MS\)/);
  assert.match(source, /const gate = c\.whenStorageMaintenanceQuiet;/);
  assert.match(source, /gate\(run, \{ reason: 'season_result_integrity_load_persist' \}\)/);
});

test('deferred persistence re-reads current state instead of saving a stale captured snapshot', () => {
  assert.match(source, /original\.loadAppState\(\{ \.\.\.\(options \|\| \{\}\), persistSync: false \}\)/);
  assert.match(source, /const fixed = repair\(state, options\);/);
  assert.match(source, /const saved = persist\(fixed\.state, fixed\.diagnostics, persistOptions\);/);
});

test('persistSync false still suppresses persistence and manual stored repair remains available', () => {
  assert.match(source, /if \(options\.persistSync === false\) return false;/);
  assert.match(source, /function repairStored\(\)/);
  assert.match(source, /repairAuthoritativeStoredState: repairStored/);
});
