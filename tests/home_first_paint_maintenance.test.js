const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const toolbar = fs.readFileSync(path.join(root, 'toolbar.js'), 'utf8');

function blockBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('Home matchup rendering is read-only on every render and ticker call', () => {
  const renderBlock = blockBetween(
    home,
    'function renderTodaysMatchup(todayKeyStr, yourScore)',
    'function getMatchupDateKeyForStats'
  );
  assert.doesNotMatch(renderBlock, /materializeSeasonSlateMatchupsForDate/);
  assert.doesNotMatch(renderBlock, /\bsave\s*\(/);
  assert.match(renderBlock, /chooseUserMatchupForDate/);
});

test('Season persistence is retained once after the first Home paint', () => {
  const scheduler = blockBetween(
    home,
    'function scheduleHomeSeasonMaterializationAfterFirstPaint',
    'function renderTodaysMatchup(todayKeyStr, yourScore)'
  );
  assert.match(scheduler, /materializeSeasonSlateMatchupsForDate/);
  assert.match(scheduler, /save\('home-season-slate-idle-materialization'\)/);
  assert.match(scheduler, /requestAnimationFrame\(\(\) => \{/);
  assert.match(scheduler, /requestIdleCallback\(run, \{ timeout: 4000 \}\)/);
  assert.match(home, /const HOME_SEASON_MATERIALIZATION_SESSION_KEY = 'tp_home_season_materialization_v1';/);
  assert.match(scheduler, /afterRevision && afterRevision !== beforeRevision/);
  assert.match(home, /scheduleRender\(renderAll\);\s*scheduleHomeSeasonMaterializationAfterFirstPaint\(\);/);
});

test('Home toolbar chrome renders before inbox and audit maintenance is deferred', () => {
  const initBlock = blockBetween(toolbar, 'function initToolbarNow()', 'let toolbarInitialized');
  assert.match(initBlock, /renderBottomToolbar\(\)/);
  assert.match(initBlock, /scheduleTaskPointsToolbarMaintenance\(\)/);
  assert.doesNotMatch(initBlock, /^\s*autoPopulateTaskPointsInbox\(\);/m);
  assert.ok(initBlock.indexOf('renderBottomToolbar()') < initBlock.indexOf('scheduleTaskPointsToolbarMaintenance()'));

  const scheduler = blockBetween(
    toolbar,
    'function scheduleTaskPointsToolbarMaintenance()',
    'function initToolbarNow()'
  );
  assert.match(scheduler, /if \(!isMainPagePathname\(window\.location\.pathname\)\) \{\s*run\(\);/);
  assert.match(scheduler, /requestIdleCallback\(run, \{ timeout: 5000 \}\)/);
  assert.match(scheduler, /requestAnimationFrame\(\(\) => \{/);
  assert.match(scheduler, /setTimeout\(queueIdle, 750\)/);

  const maintenance = blockBetween(
    toolbar,
    'function runTaskPointsToolbarMaintenance()',
    'function scheduleTaskPointsToolbarMaintenance()'
  );
  assert.match(maintenance, /autoPopulateTaskPointsInbox\(\)/);
  assert.match(maintenance, /auditDuplicateHabitCompletions\(45\)/);
});
