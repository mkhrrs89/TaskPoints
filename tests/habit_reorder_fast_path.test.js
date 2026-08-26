const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'habit_fast_path_control.js'), 'utf8');

test('habit fast-path module remains valid JavaScript after reorder optimization', () => {
  assert.doesNotThrow(() => new vm.Script(source));
});

test('habit, grouped-habit, and group reorder controls use the deferred persistence path', () => {
  assert.match(source, /installTaskPointsHabitReorderFastPath/);
  assert.match(source, /\['moveHabit', 'moveHabitWithinGroup', 'moveHabitGroup'\]/);
  assert.match(source, /core\.saveStateSnapshot = captureSave/);
  assert.match(source, /encoding:\s*'deferred-habit-reorder'/);
  assert.match(source, /scheduleDeferredSave\(name\)/);
  assert.match(source, /global\.save\('habit-reorder-deferred'/);
});

test('reorder persistence waits for a real interaction quiet window', () => {
  assert.match(source, /const REQUIRED_QUIET_MS = 3000/);
  assert.match(source, /lastInteractionAgoMs/);
  assert.match(source, /navigationQuietForMs/);
  assert.match(source, /activeEditor/);
  assert.match(source, /habit\.reorder\.persistQueued/);
  assert.match(source, /habit\.reorder\.persistCompleted/);
});

test('pending reorder persistence is force-flushed on lifecycle exit instead of discarded', () => {
  assert.match(source, /addEventListener\?\.\('pagehide'/);
  assert.match(source, /persistNow\('pagehide'\)/);
  assert.match(source, /addEventListener\?\.\('beforeunload'/);
  assert.match(source, /persistNow\('beforeunload'\)/);
  assert.match(source, /visibilityState === 'hidden'/);
  assert.match(source, /persistNow\('hidden'\)/);
});

test('existing habit bubble and immediate week-plate fast paths remain present', () => {
  assert.match(source, /installTaskPointsHabitFastPathControl/);
  assert.match(source, /installTaskPointsImmediateHabitWeekPlate/);
  assert.match(source, /global\.handleHabitBubbleTap = controlledHandler/);
  assert.match(source, /global\.refreshHabitRowWeekCompleteVisual = immediateRefresh/);
});
