const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

test('habit tap journals final state before visual acknowledgement and deferred save', () => {
  const handler = sliceBetween('function handleHabitBubbleTap(bubbleEl)', '/* ---------- FLEX ACTIONS ---------- */');
  const toggleIndex = handler.indexOf('statusClass = applyHabitDayToggle(h, dayKey)');
  const journalIndex = handler.indexOf('TaskPointsCore.writePendingHabitDelta(journalDelta');
  const visualIndex = handler.indexOf('applyCanonicalHabitBubbleVisual(bubbleEl, h, dayKey');
  const saveIndex = handler.lastIndexOf('scheduleHabitSave()');

  assert.ok(toggleIndex >= 0, 'habit state mutation exists');
  assert.ok(journalIndex > toggleIndex, 'journal is written after the final desired state is known');
  assert.ok(visualIndex > journalIndex, 'visual acknowledgement waits for the durable journal write');
  assert.ok(saveIndex > visualIndex, 'full save is scheduled only after the immediate visual update');
  assert.equal(handler.slice(toggleIndex, journalIndex).includes('saveStateSnapshot('), false);
});

test('habit burst performs one delayed compaction instead of saving on the input event', () => {
  const scheduler = sliceBetween('function scheduleHabitSave()', '// Keep the interactive path fast');
  assert.match(scheduler, /setTimeout\(\(\) => \{/);
  assert.match(scheduler, /\}, 3000\);/);
  assert.match(scheduler, /savePendingHabitState\(perfStart\)/);
  assert.equal(scheduler.includes('saveStateSnapshot('), false);
});

test('habit compaction retains verification and lifecycle flushing', () => {
  const compaction = sliceBetween('function savePendingHabitState(perfStart = null)', 'function flushPendingHabitSave');
  assert.match(compaction, /saveStateSnapshot\(state/);
  assert.match(compaction, /verifyPersistedHabitDeltas/);
  assert.match(compaction, /clearCompactedHabitDeltas/);
  assert.match(source, /addEventListener\('pagehide', \(\) => flushPendingHabitSave\('pagehide'\)\)/);
  assert.match(source, /visibilitychange/);
});
