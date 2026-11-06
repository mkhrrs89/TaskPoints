const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = (filename) => fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');

test('V2 worker retains its generation, WAL, and Habit bridges alongside Main delivery fixes', () => {
  const worker = source('_worker.js');
  for (const name of [
    'state_runtime_v2_generation.js',
    'state_runtime_v2_wal.js',
    'state_runtime_v2.js',
    'state_runtime_v2_wal_bridge.js',
    'state_runtime_v2_habit_edit_bridge.js',
    'state_runtime_v2_habit_structure_bridge.js',
    'save_pipeline_shared_work.js'
  ]) assert.ok(worker.includes(name), `Missing bundled ${name}`);
  assert.match(worker, /url\.pathname === '\/toolbar\.js'/);
  assert.match(worker, /noCacheHeaders\(toolbarResponse\.headers\)/);
});

test('Main Home capabilities coexist with V2 foreground-write and idle protections', () => {
  const home = source('index.html');
  for (const feature of [
    'HOME_SCOREBOARD_SEASON_THREE_END = "2026-11-01"',
    'function getViceSortMode()',
    'function initViceSortControl()',
    'id="habitTimeOfDay"',
    'id="viceTimeOfDay"',
    'data-field="time-of-day"',
    'timeOfDayColors',
    'timeOfDayGroups',
    'SCORE_TREND_START_DATE',
    'persistConfirmedHistoricalRepairs: true'
  ]) assert.ok(home.includes(feature), `Main capability missing: ${feature}`);
  for (const guard of [
    "save('home-live-diff-capture');",
    'requiredQuietMs = Math.max(quietMs, Number(job.quietMs) || 0)',
    "home-live-diff-periodic-capture', run, { quietMs: 8000 }",
    'storageCache.parsed = state;',
    'completedAtISO: finalCompletion?.completedAtISO || null'
  ]) assert.ok(home.includes(guard), `V2 safeguard missing: ${guard}`);
  // Main's perf improvement uses the same in-memory source directly rather
  // than re-normalizing it. V2's safety property is avoiding load() (which
  // can overwrite unflushed Habit/Task intents) and retaining explicit
  // cross-tab revision rejection before saving an optional graph sample.
  const liveDiffStart = home.indexOf('function captureLiveDiffPoint(){');
  const liveDiffEnd = home.indexOf('function scheduleInitialHomeLiveDiffCapture()',liveDiffStart);
  assert.ok(liveDiffStart >= 0 && liveDiffEnd > liveDiffStart);
  const liveDiff = home.slice(liveDiffStart,liveDiffEnd);
  assert.match(liveDiff, /const latest = (?:state|normalizeState\(state\));/);
  assert.doesNotMatch(liveDiff, /normalizeState\(load\(\)\)/);
  assert.match(liveDiff, /const storedRevision = readHomeStateRevision\(\)/);
  assert.match(liveDiff, /storedRevision !== loadedStateRevision/);
  assert.match(liveDiff, /save\('home-live-diff-capture'\)/);
    assert.match(home, /const enteredLiveDiffPanel = nextIndex === 3 && homeGraphPanelIndex !== 3/);
  assert.match(home, /id="habitPts" class="input" style="width:100%;min-width:0"/);
});

test('V2 core retains historical repair, taper, prepared serialization, and journal timestamps', () => {
  const core = source('scoring_core.js');
  for (const feature of [
    'function repairConfirmedJune2026LifetimeHistory(',
    'june2026LifetimeMatchupsV1',
    'persistConfirmedHistoricalRepairs === true',
    'HABIT_STREAK_TAPER_START_DATE_KEY',
    'prepared ? prepared.packedState',
    'buildOptimizedTaskPointsStorageRaw(candidateWithSticky, { packedState, packedRawJson })',
    'completedAtISO: delta.completedAtISO || selectedHabitDayCompletedAtISO(delta.dayKey) || delta.updatedAtISO'
  ]) assert.ok(core.includes(feature), `Core integration missing: ${feature}`);
});

test('Main audit and Today-page persistence fix are present on V2', () => {
  assert.match(source('audit.html'), /Habit weekly completion targets/);
  assert.match(source('today.html'), /const parsed = JSON\.parse\(raw\)/);
});


test('Main calorie tracking opt-out remains represented through V2 compatibility and Task row retention', () => {
  const main = source('index.html');
  const core = source('scoring_core.js');
  const v2 = source('state_runtime_v2.js');
  const browser = source('tests/browser/run-v2-browser.mjs');
  assert.match(main, /caloriesNotTrackedToggle/);
  assert.match(main, /caloriesNotTrackedForEntry\(entry\)/);
  assert.match(core, /caloriesNotTracked/);
  assert.match(v2, /caloriesNotTrackedCount: original\.filter/);
  assert.match(v2, /caloriesNotTrackedCount: effective\.completions\.filter/);
  assert.match(v2, /mergeCompatibilityCompletions\(effective\.completions, completions\)/);
  assert.match(browser, /Main calorie skip stays zero-point in V2 batch, export, and reload/);
  assert.match(browser, /Main calorie skip correction remains authoritative over stale V2 preview evidence/);
});
