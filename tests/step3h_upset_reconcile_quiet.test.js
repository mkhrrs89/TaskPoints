const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../season_series_upset_notifications.js'), 'utf8');

test('startup and pageshow upset reconciliation wait for the shared quiet gate', () => {
  assert.match(source, /function queueReconcileWhenQuiet\(/);
  assert.match(source, /TaskPointsCore\?\.whenStorageMaintenanceQuiet/);
  assert.match(source, /queueReconcileWhenQuiet\('bootstrap', 0\)/);
  assert.match(source, /queueReconcileWhenQuiet\('pageshow', 50\)/);
});

test('focus and state revisions keep prompt reconciliation', () => {
  assert.match(source, /'focus', \(\) => queueReconcile\(100\)/);
  assert.match(source, /'taskpoints:state-revision',[\s\S]*queueReconcile\(100\)/);
});
