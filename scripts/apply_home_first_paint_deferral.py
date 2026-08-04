from pathlib import Path

INDEX = Path('index.html')
TOOLBAR = Path('toolbar.js')
HOME_TEST = Path('tests/home_matchup_export_regression.test.js')
NEW_TEST = Path('tests/home_first_paint_maintenance.test.js')

index = INDEX.read_text(encoding='utf-8')
toolbar = TOOLBAR.read_text(encoding='utf-8')
home_test = HOME_TEST.read_text(encoding='utf-8')

materialize_in_render = '''  if (window.TaskPointsCore?.materializeSeasonSlateMatchupsForDate) {
    try {
      const materialized = TaskPointsCore.materializeSeasonSlateMatchupsForDate(state, todayKeyStr, {
        nowISO: `${todayKeyStr}T12:00:00.000Z`
      });
      if (materialized?.state) state = materialized.state;
      if (materialized?.changed) save();
    } catch (error) {
      console.warn('Failed to materialize today Season slate for Home matchup selection', error);
    }
  }

'''
if materialize_in_render in index:
    if index.count(materialize_in_render) != 1:
        raise SystemExit(f'Expected one render-time materialization block, found {index.count(materialize_in_render)}')
    index = index.replace(materialize_in_render, '', 1)
elif "save('home-season-slate-idle-materialization')" not in index:
    raise SystemExit('Could not find render-time materialization block')

scheduler_marker = 'function renderTodaysMatchup(todayKeyStr, yourScore){\n'
scheduler_code = '''const HOME_SEASON_MATERIALIZATION_SESSION_KEY = 'tp_home_season_materialization_v1';
let homeSeasonMaterializationScheduled = false;

function getHomeSeasonMaterializationFingerprint(todayKeyStr) {
  const dateKeyStr = String(todayKeyStr || '').slice(0, 10);
  const seasonId = String(state?.currentSeason?.id || '');
  const revision = typeof readHomeStateRevision === 'function'
    ? readHomeStateRevision()
    : '';
  if (!dateKeyStr || !seasonId || !revision) return '';
  return `${dateKeyStr}|${seasonId}|${revision}`;
}

function readHomeSeasonMaterializationFingerprint() {
  try { return sessionStorage.getItem(HOME_SEASON_MATERIALIZATION_SESSION_KEY) || ''; }
  catch (_) { return ''; }
}

function rememberHomeSeasonMaterializationFingerprint(fingerprint) {
  if (!fingerprint) return;
  try { sessionStorage.setItem(HOME_SEASON_MATERIALIZATION_SESSION_KEY, fingerprint); }
  catch (_) {}
}

function scheduleHomeSeasonMaterializationAfterFirstPaint(todayKeyStr = getGameDayKey(new Date())) {
  if (homeSeasonMaterializationScheduled) return false;
  if (!window.TaskPointsCore?.materializeSeasonSlateMatchupsForDate) return false;

  const seasonStatus = String(state?.currentSeason?.status || '');
  if (!['locked', 'active'].includes(seasonStatus)) return false;

  const safeDateKey = String(todayKeyStr || '').slice(0, 10);
  const currentFingerprint = getHomeSeasonMaterializationFingerprint(safeDateKey);
  if (currentFingerprint && readHomeSeasonMaterializationFingerprint() === currentFingerprint) {
    return false;
  }

  homeSeasonMaterializationScheduled = true;

  const run = () => {
    let shouldRefreshStats = false;
    let shouldRemember = false;
    try {
      const beforeRevision = typeof readHomeStateRevision === 'function'
        ? readHomeStateRevision()
        : '';
      const materialized = TaskPointsCore.materializeSeasonSlateMatchupsForDate(state, safeDateKey, {
        nowISO: `${safeDateKey}T12:00:00.000Z`
      });
      if (materialized?.state) state = materialized.state;

      if (materialized?.changed) {
        save('home-season-slate-idle-materialization');
        const afterRevision = typeof readHomeStateRevision === 'function'
          ? readHomeStateRevision()
          : '';
        shouldRemember = Boolean(afterRevision && afterRevision !== beforeRevision);
        shouldRefreshStats = true;
      } else {
        shouldRemember = true;
      }

      if (shouldRemember) {
        rememberHomeSeasonMaterializationFingerprint(
          getHomeSeasonMaterializationFingerprint(safeDateKey)
        );
      }
    } catch (error) {
      console.warn('Failed to materialize today Season slate after Home first paint', error);
    }

    if (shouldRefreshStats) {
      scheduleRender(() => {
        try { renderStats(); }
        catch (error) { console.error('renderStats after Season materialization failed', error); }
      });
    }
  };

  const queueIdle = () => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 4000 });
    } else {
      window.setTimeout(run, 250);
    }
  };

  // Two frames guarantee that the initial Home render can commit before any
  // full-state Season save begins.
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(queueIdle);
  });
  return true;
}

'''
if 'function scheduleHomeSeasonMaterializationAfterFirstPaint' not in index:
    if index.count(scheduler_marker) != 1:
        raise SystemExit(f'Expected one renderTodaysMatchup marker, found {index.count(scheduler_marker)}')
    index = index.replace(scheduler_marker, scheduler_code + scheduler_marker, 1)

paint_marker = '''// paint ASAP
scheduleRender(renderAll);
'''
paint_replacement = '''// paint ASAP
scheduleRender(renderAll);
scheduleHomeSeasonMaterializationAfterFirstPaint();
'''
if 'scheduleHomeSeasonMaterializationAfterFirstPaint();' not in index:
    if index.count(paint_marker) != 1:
        raise SystemExit(f'Expected one first-paint marker, found {index.count(paint_marker)}')
    index = index.replace(paint_marker, paint_replacement, 1)

old_toolbar_init = '''function initToolbarNow() {
  autoPopulateTaskPointsInbox();
  renderBottomToolbar();
  setupMobileTasksMenu();
  setupPopupMenuPressAnimation();
  try {
    const k = 'tp_audit_dupe_habits_last_run';
    const today = new Date().toISOString().slice(0,10);
    if (localStorage.getItem(k) !== today) {
      localStorage.setItem(k, today);
      auditDuplicateHabitCompletions(45);
    }
  } catch (_) {}
}
'''
new_toolbar_init = '''let taskPointsToolbarMaintenanceScheduled = false;

function runTaskPointsToolbarMaintenance() {
  autoPopulateTaskPointsInbox();
  try {
    const k = 'tp_audit_dupe_habits_last_run';
    const today = new Date().toISOString().slice(0,10);
    if (localStorage.getItem(k) !== today) {
      localStorage.setItem(k, today);
      auditDuplicateHabitCompletions(45);
    }
  } catch (_) {}
}

function scheduleTaskPointsToolbarMaintenance() {
  if (taskPointsToolbarMaintenanceScheduled) return;
  taskPointsToolbarMaintenanceScheduled = true;

  const run = () => runTaskPointsToolbarMaintenance();
  if (!isMainPagePathname(window.location.pathname)) {
    run();
    return;
  }

  const queueIdle = () => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 5000 });
    } else {
      window.setTimeout(run, 250);
    }
  };

  // Keep Home's first visible and interactive frame clear of the full inbox
  // scan and compressed save. Non-Home pages retain the existing immediate run.
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => window.setTimeout(queueIdle, 750));
  });
}

function initToolbarNow() {
  renderBottomToolbar();
  setupMobileTasksMenu();
  setupPopupMenuPressAnimation();
  scheduleTaskPointsToolbarMaintenance();
}
'''
if old_toolbar_init in toolbar:
    if toolbar.count(old_toolbar_init) != 1:
        raise SystemExit(f'Expected one toolbar init block, found {toolbar.count(old_toolbar_init)}')
    toolbar = toolbar.replace(old_toolbar_init, new_toolbar_init, 1)
elif 'function scheduleTaskPointsToolbarMaintenance()' not in toolbar:
    raise SystemExit('Could not locate toolbar initialization block')

old_test = '''test('Home render materializes Season slate before choosing stored matchup row', () => {
  const fs = require('node:fs');
  const indexHtml = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(indexHtml, /function getTodaySeasonMatchupsForHome\\(todayKeyStr\\)/);
  assert.match(indexHtml, /TaskPointsCore\\.buildSeasonDailySlate\\(state, todayKeyStr, \\{\\s*nowISO: `\\$\\{todayKeyStr\\}T12:00:00\\.000Z`/);
  assert.match(indexHtml, /function getHomeUserMatchupCandidatesForDate\\(storedMatchups, todayKeyStr\\)/);
  assert.match(indexHtml, /todaySeasonMatchups\\.concat\\(filteredStoredMatchups\\)/);
  assert.match(indexHtml, /TaskPointsCore\\.materializeSeasonSlateMatchupsForDate\\(state, todayKeyStr, \\{/);
  assert.match(indexHtml, /if \\(materialized\\?\\.changed\\) save\\(\\);/);
  assert.match(indexHtml, /TaskPointsCore\\.chooseUserMatchupForDate\\(state, todayKeyStr, 'YOU'\\)/);
});'''
new_test = '''test('Home selects the live Season slate without saving during render', () => {
  const fs = require('node:fs');
  const indexHtml = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(indexHtml, /function getTodaySeasonMatchupsForHome\\(todayKeyStr\\)/);
  assert.match(indexHtml, /TaskPointsCore\\.buildSeasonDailySlate\\(state, todayKeyStr, \\{\\s*nowISO: `\\$\\{todayKeyStr\\}T12:00:00\\.000Z`/);
  assert.match(indexHtml, /function getHomeUserMatchupCandidatesForDate\\(storedMatchups, todayKeyStr\\)/);
  assert.match(indexHtml, /todaySeasonMatchups\\.concat\\(filteredStoredMatchups\\)/);
  assert.match(indexHtml, /function scheduleHomeSeasonMaterializationAfterFirstPaint/);
  assert.match(indexHtml, /save\\('home-season-slate-idle-materialization'\\)/);
  assert.match(indexHtml, /scheduleRender\\(renderAll\\);\\s*scheduleHomeSeasonMaterializationAfterFirstPaint\\(\\);/);
  assert.match(indexHtml, /TaskPointsCore\\.chooseUserMatchupForDate\\(state, todayKeyStr, 'YOU'\\)/);

  const renderStart = indexHtml.indexOf('function renderTodaysMatchup(todayKeyStr, yourScore)');
  const renderEnd = indexHtml.indexOf('function getMatchupDateKeyForStats', renderStart);
  assert.notEqual(renderStart, -1);
  assert.notEqual(renderEnd, -1);
  const renderBlock = indexHtml.slice(renderStart, renderEnd);
  assert.doesNotMatch(renderBlock, /materializeSeasonSlateMatchupsForDate/);
  assert.doesNotMatch(renderBlock, /\\bsave\\(/);
});'''
if old_test in home_test:
    home_test = home_test.replace(old_test, new_test, 1)
elif "Home selects the live Season slate without saving during render" not in home_test:
    raise SystemExit('Could not locate Home materialization regression test')

new_test_content = r'''const test = require('node:test');
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
  assert.match(scheduler, /HOME_SEASON_MATERIALIZATION_SESSION_KEY/);
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
'''

INDEX.write_text(index, encoding='utf-8')
TOOLBAR.write_text(toolbar, encoding='utf-8')
HOME_TEST.write_text(home_test, encoding='utf-8')
NEW_TEST.write_text(new_test_content, encoding='utf-8')
