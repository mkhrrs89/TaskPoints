const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'home_rank_percentile_line.js'), 'utf8');

function extractCleanup() {
  const start = source.indexOf(';(function installTaskPointsUndatedReminderBellCleanup');
  assert.notEqual(start, -1, 'Undated Reminder bell cleanup not found');
  return source.slice(start);
}

test('Undated Reminder bell cleanup targets only the reminder modal bell', () => {
  const cleanup = extractCleanup();
  assert.match(cleanup, /getElementById\?\.\('undatedReminderModal'\)/);
  assert.match(cleanup, /\.text-2xl\[aria-hidden="true"\]/);
  assert.match(cleanup, /=== '🔔'/);
  assert.match(cleanup, /bell\.remove\(\)/);
});

test('bell cleanup does not modify reminder state or persistence', () => {
  const cleanup = extractCleanup();
  assert.doesNotMatch(cleanup, /localStorage|saveAppState|saveStateSnapshot|writeTaskPointsStoredState|reminders\s*=/);
});
