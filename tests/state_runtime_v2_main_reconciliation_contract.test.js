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
    'const latest = normalizeState(state);',
    "save('home-live-diff-capture');",
    'requiredQuietMs = Math.max(quietMs, Number(job.quietMs) || 0)',
    "home-live-diff-periodic-capture', run, { quietMs: 8000 }",
    'storageCache.parsed = state;',
    'completedAtISO: finalCompletion?.completedAtISO || null'
  ]) assert.ok(home.includes(guard), `V2 safeguard missing: ${guard}`);
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
    'completedAtISO: delta.completedAtISO || delta.updatedAtISO'
  ]) assert.ok(core.includes(feature), `Core integration missing: ${feature}`);
});

test('Main audit and Today-page persistence fix are present on V2', () => {
  assert.match(source('audit.html'), /Habit weekly completion targets/);
  assert.match(source('today.html'), /const parsed = JSON\.parse\(raw\)/);
});
