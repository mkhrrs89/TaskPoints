const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'habit_fast_path_control.js'), 'utf8');

function makeContext(options = {}) {
  const storage = new Map(Object.entries(options.storage || {}));
  let fastCalls = 0;
  let legacyCalls = 0;

  const localStorage = {
    getItem(key) { return storage.has(String(key)) ? storage.get(String(key)) : null; },
    setItem(key, value) { storage.set(String(key), String(value)); },
    removeItem(key) { storage.delete(String(key)); }
  };

  const document = {
    readyState: 'complete',
    addEventListener() {}
  };

  const window = {
    document,
    localStorage,
    Date,
    setTimeout(callback) { callback(); return 1; },
    addEventListener() {},
    handleHabitBubbleTap() { fastCalls += 1; return 'fast'; }
  };

  if (options.legacyAvailable !== false) {
    window.toggleHabitDay = (habitId, dayKey) => {
      legacyCalls += 1;
      assert.equal(habitId, 'habit-1');
      assert.equal(dayKey, '2026-08-02');
      return 'legacy';
    };
  }

  const context = vm.createContext({
    window,
    document,
    globalThis: window,
    module: { exports: {} },
    console,
    Date
  });
  vm.runInContext(source, context);

  const bubble = {
    getAttribute(name) {
      if (name === 'data-habit') return 'habit-1';
      if (name === 'data-day') return '2026-08-02';
      return '';
    }
  };

  return {
    window,
    bubble,
    storage,
    fastCalls: () => fastCalls,
    legacyCalls: () => legacyCalls
  };
}

test('journal-first habit fast path remains enabled by default', () => {
  const context = makeContext();
  const result = context.window.handleHabitBubbleTap(context.bubble);

  assert.equal(result, 'fast');
  assert.equal(context.fastCalls(), 1);
  assert.equal(context.legacyCalls(), 0);
  assert.equal(context.window.TaskPointsHabitFastPathControl.getStatus().enabled, true);
});

test('persisted kill switch uses the existing synchronous legacy path', () => {
  const context = makeContext({
    storage: { taskpoints_habit_fast_path_disabled_v1: '1' }
  });
  context.window.handleHabitBubbleTap(context.bubble);

  assert.equal(context.fastCalls(), 0);
  assert.equal(context.legacyCalls(), 1);
  const status = context.window.TaskPointsHabitFastPathControl.getStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.lastReason, 'legacy_fallback_used');
});

test('kill switch can be disabled and re-enabled without a reload', () => {
  const context = makeContext();
  const control = context.window.TaskPointsHabitFastPathControl;

  control.disable();
  context.window.handleHabitBubbleTap(context.bubble);
  assert.equal(context.legacyCalls(), 1);
  assert.equal(context.fastCalls(), 0);
  assert.equal(context.storage.get(control.DISABLED_KEY), '1');

  control.enable();
  const result = context.window.handleHabitBubbleTap(context.bubble);
  assert.equal(result, 'fast');
  assert.equal(context.fastCalls(), 1);
  assert.equal(context.legacyCalls(), 1);
  assert.equal(context.storage.has(control.DISABLED_KEY), false);
});

test('missing legacy fallback never makes habit bubbles inert', () => {
  const context = makeContext({
    storage: { taskpoints_habit_fast_path_disabled_v1: '1' },
    legacyAvailable: false
  });
  const result = context.window.handleHabitBubbleTap(context.bubble);

  assert.equal(result, 'fast');
  assert.equal(context.fastCalls(), 1);
  assert.equal(context.legacyCalls(), 0);
  assert.equal(
    context.window.TaskPointsHabitFastPathControl.getStatus().lastReason,
    'legacy_fallback_unavailable_used_fast_path'
  );
});

test('reinstall does not wrap the handler more than once', () => {
  const context = makeContext();
  const control = context.window.TaskPointsHabitFastPathControl;
  const firstHandler = context.window.handleHabitBubbleTap;

  control.install();
  control.install();

  assert.equal(context.window.handleHabitBubbleTap, firstHandler);
  context.window.handleHabitBubbleTap(context.bubble);
  assert.equal(context.fastCalls(), 1);
});
