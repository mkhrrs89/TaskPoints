const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const boot = fs.readFileSync(path.join(root, 'mobile_boot_gate.js'), 'utf8');

function slice(start, end) {
  const i = html.indexOf(start);
  const j = html.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, 'Home function boundary missing: ' + start);
  return html.slice(i, j);
}

function harness() {
  let historyFinds = 0;
  const completions = [
    { source: 'metric', habitId: 'a', dayKey: '2026-10-18', completionFraction: 1 },
    { source: 'habit', habitId: 'a', dayKey: '2026-10-18', completionFraction: 0.5 },
    { source: 'habit', habitId: 'a', dayKey: '2026-10-18', completionFraction: 1 },
    { source: 'habit', habitId: 'a', dayKey: '2026-10-17', completionFraction: 1 },
    { source: 'habit', habitId: 'b', dayKey: '2026-10-18', completionFraction: 1 },
    ...Array.from({ length: 5000 }, (_, i) => ({
      source: 'metric', title: 'Historical #' + i, dayKey: '2025-01-01'
    }))
  ];
  const nativeFind = completions.find.bind(completions);
  completions.find = (predicate) => { historyFinds += 1; return nativeFind(predicate); };
  const state = { completions };
  const context = {
    state,
    Map,
    Set,
    isShowerHabit() { return false; },
    getHabitCompletionFraction(entry) { return entry?.completionFraction === 0.5 ? 0.5 : 1; }
  };
  vm.createContext(context);
  vm.runInContext(
    slice('function buildVisibleHabitCompletionLookup(', '// Silver weeks count only after')
      + '\n' + slice('function getHabitBubbleStatusClass(', 'function applyCanonicalHabitBubbleVisual('),
    context
  );
  const days = [
    { key: '2026-10-17' }, { key: '2026-10-18' }
  ];
  const habits = [
    { id: 'a', doneKeys: ['2026-10-17', '2026-10-18'], daysPerCompleteWeek: 2 },
    { id: 'b', doneKeys: ['2026-10-18'], daysPerCompleteWeek: 1 },
    { id: 'c', doneKeys: ['2026-10-18'], daysPerCompleteWeek: 1 }
  ];
  return {
    context,
    habits,
    days,
    completions,
    historyFinds: () => historyFinds
  };
}

test('initial Home Habit render builds one bounded index instead of scanning history per day', () => {
  const h = harness();
  const lookup = h.context.buildVisibleHabitCompletionLookup(h.habits, h.days, h.completions);
  assert.equal(lookup.size, 3, 'only visible completed Habit/day pairs are indexed');
  assert.equal(h.historyFinds(), 0, 'lookup uses one ordered scan, not a .find per bubble');
  const halfStatus = h.context.getHabitBubbleStatusClass(h.habits[0], '2026-10-18', lookup);
  assert.equal(halfStatus, 'half', 'first matching half completion wins, not later duplicate');
  assert.equal(h.context.getHabitBubbleStatusClass(h.habits[0], '2026-10-17', lookup), 'on');
  assert.equal(h.context.getHabitBubbleStatusClass(h.habits[2], '2026-10-18', lookup), 'on',
    'legacy doneKeys without a completion stay fully complete');
  assert.equal(h.context.getHabitBubbleStatusClass(h.habits[0], '2026-10-16', lookup), 'off');
  assert.equal(h.historyFinds(), 0);
});

test('silver-week threshold uses indexed full/half days with identical results', () => {
  const h = harness();
  const lookup = h.context.buildVisibleHabitCompletionLookup(h.habits, h.days, h.completions);
  assert.equal(h.context.isHabitWeeklyCompleteForDays(h.habits[0], h.days, lookup), false);
  assert.equal(h.context.isHabitWeeklyCompleteForDays(h.habits[1], h.days, lookup), true);
  assert.equal(h.context.isHabitWeeklyCompleteForDays(h.habits[2], h.days, lookup), true);
  assert.equal(h.historyFinds(), 0);
  assert.equal(h.context.isHabitWeeklyCompleteForDays(h.habits[0], h.days), false,
    'fallback remains compatible without the lookup');
  assert.ok(h.historyFinds() > 0, 'fallback still checks canonical completion records');
});

test('immediate Habit taps continue to use the authoritative live completion fallback', () => {
  const h = harness();
  assert.equal(h.context.getHabitBubbleStatusClass(h.habits[0], '2026-10-18'), 'half');
  h.completions[1].completionFraction = 1;
  assert.equal(h.context.getHabitBubbleStatusClass(h.habits[0], '2026-10-18'), 'on');
  assert.match(html, /const visibleCompletionLookup = buildVisibleHabitCompletionLookup\(habits, days, state\.completions\)/);
  assert.match(html, /getHabitBubbleStatusClass\(h, d\.key, options\.visibleCompletionLookup\)/);
  assert.match(html, /isHabitWeeklyCompleteForDays\(h, days, visibleCompletionLookup\)/);
});

test('mobile launch retains the animation, runtime readiness guard and skip control while reducing extra hold', () => {
  assert.match(boot, /const FINAL_HOLD_MS = 160;/);
  assert.match(boot, /if \(revealed \|\| !revealOptions \|\| !runtimeReady\) return;/);
  assert.match(boot, /shouldGate && !skipRequested/);
  assert.match(boot, /function requestReveal\(options = \{\}\)/);
  assert.match(boot, /function captureSkip\(event\)/);
  assert.match(boot, /await replayDeferredRuntime\(\)/);
  assert.match(boot, /coordinator\.flushLateReadyListeners\(\)/);
});
