const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('home_season_slate_long_quiet.js', 'utf8');

test('recurring task done-today UI preserves duplicate-completion protection and communicates the state', () => {
  assert.match(source, /function isRecurringTask\(task\)/);
  assert.match(source, /completedToday\.has\(taskId\) && isRecurringTask\(task\)/);
  assert.match(source, /button\.disabled = true;/);
  assert.match(source, /button\.textContent = '✓ Today';/);
  assert.match(source, /button\.setAttribute\('aria-label', 'Already completed today'\);/);
});

test('done-today UI reads journal-aware state without derived-state persistence', () => {
  assert.match(source, /core\.loadAppState\?\.\(\{ syncDerived: false, persistSync: false \}\)/);
});

test('done-today UI refreshes after task-list rerenders and across midnight', () => {
  assert.match(source, /observer\.observe\(list, \{ childList: true, subtree: true \}\);/);
  assert.match(source, /setHours\(24, 0, 1, 0\)/);
  assert.match(source, /taskAction\.doneTodayUiRefreshed/);
});
