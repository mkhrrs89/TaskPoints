const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const toolbar = fs.readFileSync(path.join(root, 'toolbar.js'), 'utf8');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('shared toolbar stamps a small revision for authoritative Home data writes', () => {
  assert.match(toolbar, /installTaskPointsStateRevision/);
  assert.match(toolbar, /taskpoints_state_revision_v1/);
  assert.match(toolbar, /try \{\s*baseSetItem\(REVISION_KEY, revision\);\s*\} catch/);
  assert.match(toolbar, /taskpoints_v1/);
  assert.match(toolbar, /taskpoints_pending_habit_deltas_v1/);
  assert.match(toolbar, /tp_projects_v1/);
  assert.match(toolbar, /storage\.setItem = wrappedSetItem/);
  assert.match(toolbar, /storage\.removeItem = wrappedRemoveItem/);
  assert.match(toolbar, /storage\.clear = wrappedClear/);
});

test('Home skips lifecycle reloads when its loaded revision is current', () => {
  assert.match(home, /let loadedStateRevision = '';/);
  assert.match(home, /function readHomeStateRevision\(\)/);
  assert.match(home, /function refreshMainPageIfChanged\(reason = 'lifecycle'\)/);
  assert.match(home, /currentRevision === loadedStateRevision/);
  assert.match(home, /refreshMainPageIfChanged\('initial-bfcache-pageshow'\)/);
  assert.match(home, /refreshMainPageIfChanged\('pageshow'\)/);
  assert.match(home, /refreshMainPageIfChanged\('visibilitychange'\)/);
});

test('Home updates its revision after initial load, saves, and real refreshes', () => {
  const marks = home.match(/markHomeStateRevisionCurrent\(\);/g) || [];
  assert.ok(marks.length >= 3, `expected at least 3 revision baseline updates, found ${marks.length}`);
  assert.match(home, /state = syncStateWithMatchups\(state\);\s*markHomeStateRevisionCurrent\(\);\s*renderHabitWeekLabels/);
  assert.match(home, /finally \{\s*markHomeStateRevisionCurrent\(\);\s*\}/);
  assert.match(home, /scheduleRender\(renderAll\);\s*markHomeStateRevisionCurrent\(\);\s*return true;/);
});
