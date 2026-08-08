const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../season_series_upset_notifications.js'), 'utf8');

test('passive bootstrap/pageshow reconciliation skips derived synchronization', () => {
  assert.match(source, /loadAppState\(\{ syncDerived: options\.syncDerived !== false, persistSync: false \}\)/);
  assert.match(source, /const schedule = \(\) => queueReconcile\(delayMs, \{ syncDerived: false \}\);/);
  assert.match(source, /queueReconcileWhenQuiet\('bootstrap', 0\)/);
  assert.match(source, /queueReconcileWhenQuiet\('pageshow', 50\)/);
});

test('live focus and state-revision reconciliation retain full derived synchronization by default', () => {
  assert.match(source, /function queueReconcile\(delayMs = 0, reconcileOptions = \{\}\)/);
  assert.match(source, /reconcileStored\(reconcileOptions\)/);
  assert.match(source, /addEventListener\?\.\('focus', \(\) => queueReconcile\(100\)\)/);
  assert.match(source, /addEventListener\?\.\('taskpoints:state-revision',[\s\S]*queueReconcile\(100\)/);
});
