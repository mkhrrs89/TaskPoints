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

test('Log focus and state revisions wait for quiet while other pages stay prompt', () => {
  assert.match(source, /function isLogPage\(\)[\s\S]*pathname === '\/log'[\s\S]*pathname\.endsWith\('\/log\.html'\)/);
  assert.match(source, /'focus',[\s\S]*isLogPage\(\)[\s\S]*queueReconcileWhenQuiet\('focus', 0\)[\s\S]*else queueReconcile\(100\)/);
  assert.match(source, /'taskpoints:state-revision',[\s\S]*isLogPage\(\)[\s\S]*queueReconcileWhenQuiet\('state_revision', 0\)[\s\S]*else queueReconcile\(100\)/);
});
