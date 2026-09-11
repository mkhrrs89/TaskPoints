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
  assert.match(structureBridge, /state_runtime_v2_live_review\.js\?v=20260911-1/);
  assert.match(structureBridge, /loadPerfInstrumentation\(\);\s*loadLiveTraceReview\(\);/);
});

test('live reviewer is read-only with respect to TaskPoints persistence and mutation APIs', () => {
  assert.doesNotMatch(source, /localStorage\?*\.setItem|localStorage\?*\.removeItem/);
  assert.doesNotMatch(source, /indexedDB\.|\.transaction\(/);
  assert.doesNotMatch(source, /applyHabitDelta|applyHabitOrderOverlay|applyHabitEditSnapshot|applyHabitPresenceSnapshot/);
  assert.doesNotMatch(source, /enqueueHabitDelta|enqueueHabitOrderOverlay|enqueueHabitEditFromLegacy|enqueueHabitPresenceFromLegacy/);
  assert.match(source, /TaskPointsPerf\.buildReport\(\)/);
  assert.match(source, /reviewer\.review\(report\)/);
});

test('live reviewer exposes every Step 4 physical-device evidence check', () => {
  for (const label of [
    'Habit completion / toggle',
    'Habit reorder',
    'Habit edit',
    'Habit add / retire',
    'No direct foreground V2 maintenance',
    'Automatic parity waited for deep idle',
    'Interaction postponed pending maintenance',
    'No V2 failures observed'
  ]) {
    assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(source, /leave the app untouched and visible for at least 20 seconds/);
  assert.match(source, /legacyFullStateCandidates/);
  assert.match(source, /Legacy\/full-state timing candidates/);
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
