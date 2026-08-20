const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'storage_maintenance_idle.js'), 'utf8');

test('Home habit journal compaction waits for sustained user quiet', () => {
  assert.match(source, /installTaskPointsHomeHabitCompactionQuietGuard/);
  assert.match(source, /const REQUIRED_QUIET_MS = 8000;/);
  assert.match(source, /const POLL_MS = 250;/);
  assert.match(source, /core\.getStorageMaintenanceIdleStatus\?\.\(\)/);
  assert.match(source, /status\.activeEditor === true/);
  assert.match(source, /status\.lastInteractionAgoMs/);
  assert.match(source, /habit\.compactionDeferred/);
  assert.match(source, /habit\.compactionReleased/);
  assert.match(source, /originalSavePendingHabitState\(\)/, 'the existing verified Habit compaction implementation remains the writer');
});

test('Home habit flush preserves journal-first navigation behavior', () => {
  assert.match(source, /const guardedFlush = function taskPointsHomeHabitCompactionQuietFlush/);
  assert.match(source, /cancelTimer\(\);/);
  assert.match(source, /pending = false;/);
  assert.match(source, /originalFlushPendingHabitSave\.apply\(this, args\)/);
  assert.doesNotMatch(source, /taskPointsHomeHabitCompactionQuietFlush[\s\S]{0,900}originalSavePendingHabitState\(\)/,
    'navigation/background flush must not introduce a synchronous whole-state Habit save');
});

test('guard falls back to the legacy Habit scheduler if the maintenance tracker is unavailable', () => {
  assert.match(source, /if \(ready === null\) \{[\s\S]*originalScheduleHabitSave\?\.\(\);/);
});
