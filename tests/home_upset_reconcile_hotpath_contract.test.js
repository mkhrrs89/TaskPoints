const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('season_series_upset_notifications.js', 'utf8');

function between(startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `missing ${endNeedle}`);
  return source.slice(start, end);
}

test('Home season upset reconciliation requires sustained quiet again at execution time', () => {
  assert.match(source, /const HOME_RECONCILE_QUIET_MS = 8000;/);
  const ready = between('function homeReconcileReadyAtExecution', 'function deferHomeReconcileAtExecution');
  assert.match(ready, /lastInteractionAgoMs/);
  assert.match(ready, /HOME_RECONCILE_QUIET_MS/);
  assert.match(ready, /pageLeaving/);
  assert.match(ready, /activeEditor/);
  assert.match(ready, /visibilityState === 'hidden'/);
  assert.match(ready, /if \(!status \|\| typeof status !== 'object'\) return true/);

  const deferred = between('function deferHomeReconcileAtExecution', 'function reconcileStored');
  assert.match(deferred, /upset\.homeExecutionGuardDeferred/);
  assert.match(deferred, /upset\.homeExecutionGuardReleased/);
  assert.match(deferred, /queueReconcile\(500\)/);
});

test('Home season upset reconciliation skips heavyweight derived sync without changing non-Home behavior', () => {
  const body = between('function reconcileStored', 'function queueReconcile');
  assert.match(body, /deferLogReconcileAtExecution\(\) \|\| deferHomeReconcileAtExecution\(\)/);
  assert.match(body, /const loadOptions = \{ syncDerived: !isHomePage\(\), persistSync: false \}/);
  assert.match(body, /TaskPointsHomeLiveState\?\.getState\?\.\(\)/);
  assert.match(body, /loadOptions\.preloadedState = liveState/);
  assert.match(body, /savePath: 'season-series-upset-inbox'/);
});
