const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'home_featured_matchup_visibility.js'), 'utf8');

test('Home featured module remains valid JavaScript after storage staggering guard', () => {
  assert.doesNotThrow(() => new vm.Script(source));
});

test('heavy storage verification jobs are serialized with a cooldown instead of disabled', () => {
  assert.match(source, /installTaskPointsHeavyStorageSerialGuard/);
  assert.match(source, /phase2_dual_write_coalesced/);
  assert.match(source, /phase5c_verified_secondary/);
  assert.match(source, /const MIN_GAP_MS = 10000/);
  assert.match(source, /tail\.catch\(\(\) => undefined\)\.then/);
  assert.match(source, /await waitForGap\(\)/);
  assert.match(source, /return await originalWhenQuiet\(serialRun, options\)/);
  assert.doesNotMatch(source, /PHASE5C.*DISABLED|phase2.*disabled/i);
});

test('serial guard safely bypasses its own final-boundary re-entry', () => {
  assert.match(source, /const reentrantRuns = new WeakSet\(\)/);
  assert.match(source, /if \(reentrantRuns\.has\(run\)\)/);
  assert.match(source, /reentrantRuns\.add\(serialRun\)/);
  assert.match(source, /reentrantRuns\.delete\(serialRun\)/);
});

test('serial guard emits timing markers for the next performance trace', () => {
  assert.match(source, /storage\.heavyMaintenanceQueued/);
  assert.match(source, /storage\.heavyMaintenanceStarted/);
  assert.match(source, /storage\.heavyMaintenanceCompleted/);
  assert.match(source, /durationMs:/);
});

test('existing mobile habit tap-spacing adjustment remains present', () => {
  assert.match(source, /row-gap:\s*0\.5rem/);
  assert.match(source, /transform:\s*translateY\(-2px\)/);
});
