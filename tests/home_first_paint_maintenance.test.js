const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const toolbar = fs.readFileSync(path.join(root, 'toolbar.js'), 'utf8');
const alias = fs.readFileSync(path.join(root, 'you_score_alias_alignment.js'), 'utf8');

function blockBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('Home first render does not reload or save live-diff state', () => {
  const renderStats = blockBetween(home, 'function renderStats(){', 'const DEFAULT_MATCHUP_PRIMARY_COLOR');
  assert.doesNotMatch(renderStats, /captureLiveDiffPoint\(\)/);
  assert.match(renderStats, /drawLiveDiffGraph\(\)/);
  assert.match(home, /function scheduleInitialHomeLiveDiffCapture\(\)/);
  assert.match(home, /home-live-diff-initial-capture/);
  assert.match(home, /delayMs: 18000/);
});

test('Home maintenance queue waits for interaction quiet and serializes jobs', () => {
  const queue = blockBetween(
    home,
    '(function installTaskPointsHomeIdleQueue',
    'function getWeightHistorySorted()'
  );
  assert.match(queue, /const quietMs = 3000/);
  assert.match(queue, /const gapMs = 2000/);
  for (const eventName of ['pointerdown', 'touchstart', 'wheel', 'scroll', 'keydown']) {
    assert.match(queue, new RegExp(`'${eventName}'`));
  }
  assert.match(queue, /if \(document\.hidden\)/);
  assert.match(queue, /queuedNames\.has\(safeName\)/);
  assert.match(queue, /requestIdleCallback\(\(\) => execute\(job\)\)/);
});

test('Season persistence waits for idle and does not trigger a second full stats render', () => {
  const scheduler = blockBetween(
    home,
    'function scheduleHomeSeasonMaterializationAfterFirstPaint',
    'function renderTodaysMatchup(todayKeyStr, yourScore)'
  );
  assert.match(scheduler, /home-season-materialization/);
  assert.match(scheduler, /delayMs: 10000/);
  assert.match(scheduler, /save\('home-season-slate-idle-materialization'\)/);
  assert.doesNotMatch(scheduler, /renderStats\(/);
  assert.doesNotMatch(scheduler, /requestIdleCallback\([^)]*timeout/);
});

test('Home toolbar maintenance is postponed through the shared idle queue', () => {
  const scheduler = blockBetween(
    toolbar,
    'function scheduleTaskPointsToolbarMaintenance()',
    'function initToolbarNow()'
  );
  assert.match(scheduler, /if \(!isMainPagePathname\(window\.location\.pathname\)\) \{\s*run\(\);/);
  assert.match(scheduler, /TaskPointsHomeIdleQueue\?\.enqueue/);
  assert.match(scheduler, /home-toolbar-maintenance/);
  assert.match(scheduler, /delayMs: 22000/);
  assert.doesNotMatch(scheduler, /requestIdleCallback/);
});

test('YOU alias startup repair is deferred on every page and keeps the Home idle queue', () => {
  assert.match(alias, /function isTaskPointsHomePage\(\)/);
  assert.match(alias, /home-you-score-alias-repair/);
  assert.match(alias, /delayMs: 14000/);
  assert.match(alias, /function scheduleNonHomeAliasRepair\(/);
  assert.match(alias, /whenStorageMaintenanceQuiet/);
  assert.match(alias, /if \(isTaskPointsHomePage\(\)\) scheduleHomeAliasRepair\(\);\s*else scheduleNonHomeAliasRepair\('load_alignment'\)/);
  assert.match(alias, /if \(isTaskPointsHomePage\(\)\) \{\s*scheduleHomeAliasRepair\(\);\s*\} else \{\s*scheduleNonHomeAliasRepair\('module_install'\);/);
  assert.doesNotMatch(alias, /if \(isTaskPointsHomePage\(\)\) scheduleHomeAliasRepair\(\);\s*else persistRepair/);
});
