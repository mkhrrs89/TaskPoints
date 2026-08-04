from pathlib import Path

INDEX = Path('index.html')
TOOLBAR = Path('toolbar.js')
ALIAS = Path('you_score_alias_alignment.js')
TEST = Path('tests/home_first_paint_maintenance.test.js')

index = INDEX.read_text(encoding='utf-8')
toolbar = TOOLBAR.read_text(encoding='utf-8')
alias = ALIAS.read_text(encoding='utf-8')

queue_marker = "let liveDiffCaptureIntervalId = null;\n"
queue_code = r'''

(function installTaskPointsHomeIdleQueue(global) {
  if (global.TaskPointsHomeIdleQueue) return;

  const jobs = [];
  const queuedNames = new Set();
  const quietMs = 3000;
  const gapMs = 2000;
  let timerId = null;
  let running = false;
  let lastInteractionAt = global.performance?.now?.() ?? Date.now();

  const now = () => global.performance?.now?.() ?? Date.now();

  function schedule(delayMs = 250) {
    if (timerId != null) global.clearTimeout(timerId);
    timerId = global.setTimeout(pump, Math.max(0, Number(delayMs) || 0));
  }

  function noteInteraction() {
    lastInteractionAt = now();
    if (jobs.length) schedule(quietMs);
  }

  function finishJob() {
    running = false;
    lastInteractionAt = now();
    schedule(gapMs);
  }

  function execute(job) {
    let result;
    try {
      result = job.task();
    } catch (error) {
      console.warn(`[TP home idle] ${job.name} failed`, error);
      finishJob();
      return;
    }
    Promise.resolve(result).catch((error) => {
      console.warn(`[TP home idle] ${job.name} failed`, error);
    }).finally(finishJob);
  }

  function pump() {
    timerId = null;
    if (running || !jobs.length) return;
    if (document.hidden) {
      schedule(1000);
      return;
    }

    jobs.sort((left, right) => left.notBefore - right.notBefore);
    const job = jobs[0];
    const current = now();
    const waitForDelay = job.notBefore - current;
    const waitForQuiet = quietMs - (current - lastInteractionAt);
    const waitMs = Math.max(waitForDelay, waitForQuiet, 0);
    if (waitMs > 0) {
      schedule(Math.min(Math.max(waitMs, 250), 2000));
      return;
    }

    jobs.shift();
    queuedNames.delete(job.name);
    running = true;

    if (typeof global.requestIdleCallback === 'function') {
      global.requestIdleCallback(() => execute(job));
    } else {
      global.setTimeout(() => execute(job), 0);
    }
  }

  function enqueue(name, task, options = {}) {
    const safeName = String(name || 'maintenance');
    if (typeof task !== 'function' || queuedNames.has(safeName)) return false;
    queuedNames.add(safeName);
    jobs.push({
      name: safeName,
      task,
      notBefore: now() + Math.max(0, Number(options.delayMs) || 0)
    });
    schedule();
    return true;
  }

  ['pointerdown', 'touchstart', 'wheel', 'scroll', 'keydown'].forEach((eventName) => {
    global.addEventListener(eventName, noteInteraction, { capture: true, passive: true });
  });
  document.addEventListener('visibilitychange', noteInteraction, { passive: true });

  global.TaskPointsHomeIdleQueue = {
    enqueue,
    noteInteraction,
    get pendingCount() { return jobs.length + (running ? 1 : 0); }
  };
})(window);
'''
if 'installTaskPointsHomeIdleQueue' not in index:
    if index.count(queue_marker) != 1:
        raise SystemExit(f'Expected one Home queue marker, found {index.count(queue_marker)}')
    index = index.replace(queue_marker, queue_marker + queue_code, 1)

old_stats_capture = """state = cleanupLiveDiffHistory(state);\n      captureLiveDiffPoint();\n      tpPerfTime('renderStats: drawLiveDiffGraph', () => drawLiveDiffGraph());"""
new_stats_capture = """state = cleanupLiveDiffHistory(state);\n      tpPerfTime('renderStats: drawLiveDiffGraph', () => drawLiveDiffGraph());"""
if old_stats_capture in index:
    index = index.replace(old_stats_capture, new_stats_capture, 1)
elif "state = cleanupLiveDiffHistory(state);\n      tpPerfTime('renderStats: drawLiveDiffGraph'" not in index:
    raise SystemExit('Could not remove synchronous live-diff capture from renderStats')

season_start = index.find('function scheduleHomeSeasonMaterializationAfterFirstPaint')
season_end = index.find('\nfunction renderTodaysMatchup(todayKeyStr, yourScore)', season_start)
if season_start == -1 or season_end == -1:
    raise SystemExit('Could not locate Home Season materialization scheduler')
new_season = r'''function scheduleHomeSeasonMaterializationAfterFirstPaint(todayKeyStr = getGameDayKey(new Date())) {
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
      } else {
        shouldRemember = true;
      }

      if (shouldRemember) {
        rememberHomeSeasonMaterializationFingerprint(
          getHomeSeasonMaterializationFingerprint(safeDateKey)
        );
      }
    } catch (error) {
      console.warn('Failed to materialize today Season slate after Home became idle', error);
    }
  };

  if (window.TaskPointsHomeIdleQueue?.enqueue) {
    window.TaskPointsHomeIdleQueue.enqueue('home-season-materialization', run, { delayMs: 10000 });
  } else {
    window.setTimeout(run, 10000);
  }
  return true;
}
'''
index = index[:season_start] + new_season + index[season_end:]

capture_end_marker = "\nfunction getTodayOpponentPrimaryColor(){"
capture_start = index.find('function captureLiveDiffPoint(){')
capture_end = index.find(capture_end_marker, capture_start)
if capture_start == -1 or capture_end == -1:
    raise SystemExit('Could not locate live-diff capture function')
if 'function scheduleInitialHomeLiveDiffCapture()' not in index:
    scheduler = r'''

function scheduleInitialHomeLiveDiffCapture() {
  const run = () => captureLiveDiffPoint();
  if (window.TaskPointsHomeIdleQueue?.enqueue) {
    window.TaskPointsHomeIdleQueue.enqueue('home-live-diff-initial-capture', run, { delayMs: 18000 });
  } else {
    window.setTimeout(run, 18000);
  }
}
'''
    index = index[:capture_end] + scheduler + index[capture_end:]

paint_call = "scheduleHomeSeasonMaterializationAfterFirstPaint();\n"
paint_replacement = "scheduleHomeSeasonMaterializationAfterFirstPaint();\nscheduleInitialHomeLiveDiffCapture();\n"
if 'scheduleInitialHomeLiveDiffCapture();' not in index:
    if index.count(paint_call) != 1:
        raise SystemExit(f'Expected one Season first-paint call, found {index.count(paint_call)}')
    index = index.replace(paint_call, paint_replacement, 1)

toolbar_start = toolbar.find('function scheduleTaskPointsToolbarMaintenance()')
toolbar_end = toolbar.find('\nfunction initToolbarNow()', toolbar_start)
if toolbar_start == -1 or toolbar_end == -1:
    raise SystemExit('Could not locate toolbar maintenance scheduler')
new_toolbar_scheduler = r'''function scheduleTaskPointsToolbarMaintenance() {
  if (taskPointsToolbarMaintenanceScheduled) return;
  taskPointsToolbarMaintenanceScheduled = true;

  const run = () => runTaskPointsToolbarMaintenance();
  if (!isMainPagePathname(window.location.pathname)) {
    run();
    return;
  }

  if (window.TaskPointsHomeIdleQueue?.enqueue) {
    window.TaskPointsHomeIdleQueue.enqueue('home-toolbar-maintenance', run, { delayMs: 22000 });
  } else {
    window.setTimeout(run, 22000);
  }
}
'''
toolbar = toolbar[:toolbar_start] + new_toolbar_scheduler + toolbar[toolbar_end:]

alias_marker = '  let persistingRepair = false;\n'
alias_helpers = r'''
  let homeAliasRepairFallbackTimer = null;

  function isTaskPointsHomePage() {
    const pathname = String(global.location?.pathname || '');
    return pathname === '/' || pathname.endsWith('/index.html');
  }

  function scheduleHomeAliasRepair() {
    const enqueue = global.TaskPointsHomeIdleQueue?.enqueue;
    if (typeof enqueue === 'function') {
      enqueue('home-you-score-alias-repair', () => repairPersistedState(), { delayMs: 14000 });
      return true;
    }
    if (homeAliasRepairFallbackTimer != null) return true;
    homeAliasRepairFallbackTimer = global.setTimeout?.(() => {
      homeAliasRepairFallbackTimer = null;
      const lateEnqueue = global.TaskPointsHomeIdleQueue?.enqueue;
      if (typeof lateEnqueue === 'function') {
        lateEnqueue('home-you-score-alias-repair', () => repairPersistedState(), { delayMs: 14000 });
      } else {
        global.setTimeout?.(() => repairPersistedState(), 14000);
      }
    }, 0);
    return true;
  }
'''
if 'function isTaskPointsHomePage()' not in alias:
    if alias.count(alias_marker) != 1:
        raise SystemExit(f'Expected one alias persisting marker, found {alias.count(alias_marker)}')
    alias = alias.replace(alias_marker, alias_marker + alias_helpers, 1)

old_load_persist = """      if (!aligned.changed) return loaded;\n      persistRepair(aligned.state, aligned, options);\n      return loaded?.state"""
new_load_persist = """      if (!aligned.changed) return loaded;\n      if (isTaskPointsHomePage()) scheduleHomeAliasRepair();\n      else persistRepair(aligned.state, aligned, options);\n      return loaded?.state"""
if old_load_persist in alias:
    alias = alias.replace(old_load_persist, new_load_persist, 1)
elif 'if (isTaskPointsHomePage()) scheduleHomeAliasRepair();' not in alias:
    raise SystemExit('Could not defer Home alias repair from loadAppState')

old_alias_boot = """  repairPersistedState();\n  global.setTimeout?.(repairPersistedState, 0);\n  global.addEventListener?.('pageshow', repairPersistedState);"""
new_alias_boot = """  if (isTaskPointsHomePage()) {\n    scheduleHomeAliasRepair();\n  } else {\n    repairPersistedState();\n    global.setTimeout?.(repairPersistedState, 0);\n  }\n  global.addEventListener?.('pageshow', () => {\n    if (isTaskPointsHomePage()) scheduleHomeAliasRepair();\n    else repairPersistedState();\n  });"""
if old_alias_boot in alias:
    alias = alias.replace(old_alias_boot, new_alias_boot, 1)
elif "if (isTaskPointsHomePage()) {\n    scheduleHomeAliasRepair();" not in alias:
    raise SystemExit('Could not defer startup alias repair on Home')

test_content = r'''const test = require('node:test');
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

test('YOU alias startup repair remains immediate off Home but is idle-queued on Home', () => {
  assert.match(alias, /function isTaskPointsHomePage\(\)/);
  assert.match(alias, /home-you-score-alias-repair/);
  assert.match(alias, /delayMs: 14000/);
  assert.match(alias, /if \(isTaskPointsHomePage\(\)\) scheduleHomeAliasRepair\(\);\s*else persistRepair/);
  assert.match(alias, /if \(isTaskPointsHomePage\(\)\) \{\s*scheduleHomeAliasRepair\(\);\s*\} else \{\s*repairPersistedState\(\);/);
});
'''

INDEX.write_text(index, encoding='utf-8')
TOOLBAR.write_text(toolbar, encoding='utf-8')
ALIAS.write_text(alias, encoding='utf-8')
TEST.write_text(test_content, encoding='utf-8')
