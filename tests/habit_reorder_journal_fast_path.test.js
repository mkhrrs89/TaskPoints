const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'habit_fast_path_control.js'), 'utf8');

test('habit fast-path module remains valid JavaScript with reorder journal path', () => {
  assert.doesNotThrow(() => new vm.Script(source));
});

test('reorder clicks are intercepted before the legacy full-save handlers run', () => {
  assert.match(source, /installTaskPointsHabitReorderJournalFastPath/);
  assert.match(source, /document\.addEventListener\('click', onCaptureClick, true\)/);
  assert.match(source, /event\.stopPropagation\?\.\(\)/);
  assert.match(source, /global\.save = function taskPointsHabitReorderSuppressedSave/);
  assert.match(source, /global\.moveHabit\?\./);
  assert.match(source, /global\.moveHabitWithinGroup\?\./);
  assert.match(source, /global\.moveHabitGroup\?\./);
});

test('reorder state is persisted immediately as a small durable overlay', () => {
  assert.match(source, /taskpoints_habit_order_overlay_v1/);
  assert.match(source, /localStorage\?\.setItem\?\.\(OVERLAY_KEY, raw\)/);
  assert.match(source, /habit\.reorder\.overlayWritten/);
  assert.match(source, /applyOverlay\(\)/);
  assert.match(source, /habit\.reorder\.overlayReplayed/);
});

test('full reorder compaction waits for a long quiet window and is verified', () => {
  assert.match(source, /const REQUIRED_QUIET_MS = 8000/);
  assert.match(source, /getStorageMaintenanceIdleStatus/);
  assert.match(source, /lastInteractionAgoMs/);
  assert.match(source, /global\.save\('habit-reorder-idle-compaction'/);
  assert.match(source, /verifyCanonicalOverlay\(overlay\)/);
  assert.match(source, /habit\.reorder\.compactionCompleted/);
});

test('reorder overlay is not force-flushed during navigation or pagehide', () => {
  const reorderSource = source.slice(source.indexOf('(function installTaskPointsHabitReorderJournalFastPath'));
  assert.doesNotMatch(reorderSource, /pagehide/);
  assert.doesNotMatch(reorderSource, /beforeunload/);
  assert.doesNotMatch(reorderSource, /visibilitychange/);
});
