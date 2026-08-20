const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'season_series_upset_notifications.js'), 'utf8');

test('Home state revisions wait for storage-maintenance quiet before upset reconciliation', () => {
  assert.match(source, /function isHomePage\(\)/);
  assert.match(source, /pathname === '\/'/);
  assert.match(source, /upset\.homeStateRevisionQuietQueued/);
  assert.match(source, /queueReconcileWhenQuiet\('home_state_revision', 0\)/);
  assert.match(source, /upset\.homeStateRevisionQuietReleased/);
  assert.match(source, /season_series_upset_\$\{reason\}/);
});

test('non-Home, non-Log state revisions retain the existing 100ms reconciliation behavior', () => {
  assert.match(source, /queueReconcile\(100\);\n  \}\);/);
});
