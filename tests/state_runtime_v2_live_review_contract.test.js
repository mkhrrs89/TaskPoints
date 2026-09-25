const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_live_review.js'), 'utf8');
const structureBridge = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_habit_structure_bridge.js'), 'utf8');

function installForHost(hostname, dark = true) {
  const context = {
    location: { hostname },
    localStorage: { getItem(key) { return key === 'taskpoints_state_v2_dark_mode_v1' && dark ? '1' : null; } },
    Promise,
    JSON,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'state_runtime_v2_live_review.js' });
  return context.TaskPointsStateRuntimeV2LiveReview;
}

test('live reviewer is dynamically loaded only from the V2 dark structure bridge', () => {
  assert.match(structureBridge, /function loadLiveTraceReview\(\)/);
  assert.match(structureBridge, /if \(!isEnabled\(\) \|\| global\.TaskPointsStateRuntimeV2LiveReview\?\.installed/);
  assert.match(structureBridge, /state_runtime_v2_live_review\.js\?v=20260925-1/);
  assert.match(structureBridge, /loadPerfInstrumentation\(\);\s*loadLiveTraceReview\(\);/);
  assert.match(source, /state_runtime_v2_trace_review\.js\?v=20260924-1/);
  assert.match(source, /state_runtime_v2_foreground_correlation\.js\?v=20260913-2/);
});

test('live reviewer is read-only with respect to TaskPoints persistence and mutation APIs', () => {
  assert.doesNotMatch(source, /localStorage\?*\.setItem|localStorage\?*\.removeItem/);
  assert.doesNotMatch(source, /indexedDB\.|\.transaction\(/);
  assert.doesNotMatch(source, /applyHabitDelta|applyHabitOrderOverlay|applyHabitEditSnapshot|applyHabitPresenceSnapshot/);
  assert.doesNotMatch(source, /enqueueHabitDelta|enqueueHabitOrderOverlay|enqueueHabitEditFromLegacy|enqueueHabitPresenceFromLegacy/);
  assert.match(source, /TaskPointsPerf\.buildReport\(\)/);
  assert.match(source, /reviewer\.review\(report\)/);
  assert.match(source, /review\.foregroundCorrelation = correlator\.review\(report\)/);
});

test('live reviewer exposes a preview-only one-shot deterministic WAL kill control', () => {
  assert.match(source, /Arm WAL kill test/);
  assert.match(source, /data-v2-wal-arm/);
  assert.match(source, /function armWalKillTest\(\)/);
  assert.match(source, /taskpoints_state_v2_wal_test_armed_v1/);
  assert.match(source, /taskpoints_state_v2_wal_test_hold_until_v1/);
  assert.match(source, /WAL_TEST_HOLD_MS = 8000/);
  assert.match(source, /if \(!isAllowedPreview\(\)\) throw new Error\('WAL kill test is preview-only\.'\)/);
  assert.match(source, /sessionStorage\.setItem\(WAL_TEST_ARM_KEY, '1'\)/);
  assert.match(source, /toggle ONE Habit, then kill TaskPoints within 8 seconds/);
});

test('fresh-start control clears only PERF trace state before reloading', () => {
  assert.match(source, /function startFreshTest\(\)/);
  assert.match(source, /global\.TaskPointsPerf\.clearTrace\(\)/);
  assert.match(source, /global\.location\?\.reload\?\.\(\)/);
  assert.match(source, /Start fresh test/);
  assert.match(source, /clears only PERF trace history and reloads/);
  assert.doesNotMatch(source, /TaskPointsStateRuntimeV2\?*\.disableDarkMirror/);
});

test('live reviewer exposes every Step 4 physical-device evidence check', () => {
  for (const label of [
    'Habit completion / toggle',
    'Habit reorder',
    'Habit edit',
    'Habit add / delete',
    'No direct foreground V2 maintenance',
    'Automatic parity waited for deep idle',
    'Interaction postponed pending maintenance',
    'V2 stores only Habit/Vice pilot completions',
    'V2 data matches legacy data',
    'No V2 failures observed'
  ]) {
    assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(source, /Add a temporary Habit/);
  assert.match(source, /leave the app untouched and visible for at least 20 seconds/);
  assert.match(source, /legacyFullStateCandidates/);
  assert.match(source, /Legacy\/full-state timing candidates/);
  assert.match(source, /pilotOwnership\?\.v2StoreContainsOnlyPilotCompletions/);
});

test('live reviewer records a next-frame foreground boundary for Habit interactions', () => {
  assert.match(source, /PAINT_PROBE_NAME = 'stateV2\.foreground\.nextPaint'/);
  assert.match(source, /function installForegroundPaintProbe\(\)/);
  assert.match(source, /\['pointerdown', 'pointerup', 'click'\]/);
  assert.match(source, /global\.requestAnimationFrame\(\(\) =>/);
  assert.match(source, /TaskPointsPerf\?\.duration\?\.\(PAINT_PROBE_NAME, elapsed/);
  assert.match(source, /paintBoundedMutationWindowCount/);
  assert.match(source, /reached next paint/);
});

test('live reviewer surfaces foreground correlation without making it a Step 4 pass condition', () => {
  assert.match(source, /Foreground correlation:/);
  assert.match(source, /correlatedMutationWindowCount/);
  assert.match(source, /windowsWithLegacyWork/);
  assert.match(source, /maxLegacyForegroundCandidateMs/);
  assert.match(source, /Foreground correlation is diagnostic, not an automatic Step 4 failure/);
  assert.match(source, /through the next paint boundary/);
  assert.match(source, /falls back to the V2 enqueue boundary/);

  const checksStart = source.indexOf('function checkRows(review)');
  const checksEnd = source.indexOf('function progress(review)', checksStart);
  assert.notEqual(checksStart, -1);
  assert.notEqual(checksEnd, -1);
  const step4Checks = source.slice(checksStart, checksEnd);
  assert.doesNotMatch(step4Checks, /foregroundCorrelation|windowsWithLegacyWork|maxLegacyForegroundCandidateMs|paintBoundedMutationWindowCount/);
});

test('live reviewer refuses to mount on the production TaskPoints hostname', () => {
  const api = installForHost('taskpoints.pages.dev', true);
  assert.equal(api.installed, true);
  assert.equal(api.isAllowedPreview(), false);
  assert.equal(api.isDarkEnabled(), true);
  assert.equal(api.getStatus().allowedPreview, false);
});

test('live reviewer allows branch previews but still requires the dark flag', () => {
  const enabled = installForHost('arch-state-runtime-v2-plan.taskpoints.pages.dev', true);
  assert.equal(enabled.isAllowedPreview(), true);
  assert.equal(enabled.isDarkEnabled(), true);

  const disabled = installForHost('arch-state-runtime-v2-plan.taskpoints.pages.dev', false);
  assert.equal(disabled.isAllowedPreview(), true);
  assert.equal(disabled.isDarkEnabled(), false);
});


test('Habit add and edit UI stays above V2 and PERF diagnostic controls', () => {
  assert.match(source, /body:has\(#addHabitModal:not\(\.hidden\)\) #\$\{BUTTON_ID\}/);
  assert.match(source, /body:has\(#addHabitModal:not\(\.hidden\)\) #tpPerfTraceButton/);
  assert.match(source, /body:has\(\[data-act="habit-save"\]\) #\$\{BUTTON_ID\}/);
  assert.match(source, /body:has\(\[data-act="habit-save"\]\) #tpPerfTraceButton/);
  assert.match(source, /#addHabitModal:not\(\.hidden\)\{z-index:2147483646!important\}/);
});


test('live reviewer surfaces reload persistence separately from the ten Step 4 checks', () => {
  assert.match(source, /Startup persistence:/);
  assert.match(source, /already current — reused existing V2 DB/);
  assert.match(source, /verified existing — read-only reload verification/);
  assert.match(source, /full V2 pilot reseed observed/);
  assert.match(source, /Startup persistence is separate from the 10 Step 4 checks/);
});


test('live reviewer explains why a full seed happened instead of treating every seed as suspicious', () => {
  assert.match(source, /initial V2 pilot bootstrap seed — expected for a fresh browser context/);
  assert.match(source, /reset generation changed/);
  assert.match(source, /V2 schema changed/);
  assert.match(source, /persisted V2 did not match legacy/);
  assert.match(source, /startupSeed\.reseedReason/);
});
