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

  if (typeof options.v2Guard === 'function') {
    window.TaskPointsStateRuntimeV2 = { beforeHabitInteraction: options.v2Guard };
    if (options.v2Status) window.TaskPointsStateRuntimeV2.getStatus = () => options.v2Status;
  }

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

test('V2 external invalidation guard blocks the Habit tap before fast or legacy mutation runs', () => {
  let guardCalls = 0;
  const context = makeContext({
    v2Guard(identity) {
      guardCalls += 1;
      assert.equal(identity.habitId, 'habit-1');
      assert.equal(identity.dayKey, '2026-08-02');
      return { proceed: false, reason: 'external_revision_invalidated', reloadRequested: true };
    }
  });
  const result = context.window.handleHabitBubbleTap(context.bubble);
  assert.equal(result, undefined);
  assert.equal(guardCalls, 1);
  assert.equal(context.fastCalls(), 0);
  assert.equal(context.legacyCalls(), 0);
  assert.equal(context.window.TaskPointsHabitFastPathControl.getStatus().lastReason, 'v2_external_invalidation_reload');
});

test('V2 guard failure never makes the existing Habit path inert', () => {
  const context = makeContext({
    v2Guard() { throw new Error('preview guard failed'); }
  });
  assert.equal(context.window.handleHabitBubbleTap(context.bubble), 'fast');
  assert.equal(context.fastCalls(), 1);
});

test('thrown Habit guard on an active V2 page blocks both fast and legacy mutation paths', () => {
  const context = makeContext({
    v2Guard() { throw new Error('synthetic stale-tab generation check failed'); },
    v2Status: { darkEnabled: true, interactionPageGeneration: 'generation:old',
      currentGeneration: 'generation:new', readAuthority: 'legacy_only' }
  });
  assert.equal(context.window.handleHabitBubbleTap(context.bubble), undefined);
  assert.equal(context.fastCalls(), 0);
  assert.equal(context.legacyCalls(), 0);
  assert.equal(context.window.TaskPointsHabitFastPathControl.getStatus().lastReason,
    'v2_interaction_guard_failed_closed');
});

test('thrown optional V2 guard still permits normal V1-only Home Habit interactions', () => {
  const context = makeContext({
    v2Guard() { throw new Error('V2 diagnostics unavailable'); },
    v2Status: { darkEnabled: false, interactionPageGeneration: null, readAuthority: 'legacy_only' }
  });
  assert.equal(context.window.handleHabitBubbleTap(context.bubble), 'fast');
  assert.equal(context.fastCalls(), 1);
  assert.equal(context.legacyCalls(), 0);
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

test('queued stale Habit tap is not consumed before generation storage becomes readable', () => {
  const pendingKey = 'taskpoints_v2_stale_habit_tap_v1';
  const storage = new Map([['taskpoints_state_v2_dark_mode_v1', '1']]);
  const pending = { version: 1, habitId: 'habit-1', dayKey: '2026-08-02',
    generation: 'generation:valid', pathname: '/index.html', createdEpochMs: Date.now() };
  const session = new Map([[pendingKey, JSON.stringify(pending)]]);
  const timers = [];
  let generationReadable = false, handlerCalls = 0;
  const bubble = {
    getAttribute(name) {
      return { 'data-habit': 'habit-1', 'data-day': '2026-08-02' }[name] || '';
    }
  };
  const document = {
    readyState: 'complete', addEventListener() {},
    querySelectorAll() { return [bubble]; }
  };
  const window = {
    document, Date, location: { pathname: '/index.html' },
    localStorage: { getItem(k) { return storage.get(k) ?? null; } },
    sessionStorage: {
      getItem(k) { return session.get(k) ?? null; },
      removeItem(k) { session.delete(k); }
    },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    addEventListener() {},
    handleHabitBubbleTap() { handlerCalls += 1; },
    TaskPointsStateRuntimeV2: {
      getStatus() {
        return { generationReadable, currentGeneration: generationReadable ? 'generation:valid' : null,
          externalRevisionInvalidated: false, readAuthority: 'legacy_only' };
      },
      beforeHabitInteraction() { return { proceed: generationReadable }; }
    }
  };
  vm.runInContext(source, vm.createContext({ window, document, globalThis: window,
    module: { exports: {} }, console, Date }));

  // The initial install schedules a replay, but it must never consume an
  // intercepted user action while its epoch cannot be validated.
  for (let i = 0; i < 8 && timers.length; i += 1) timers.shift()();
  assert.equal(handlerCalls, 0);
  assert.ok(session.has(pendingKey), 'hold the continuation while generation is unreadable');
  assert.equal(window.TaskPointsHabitFastPathControl.getStatus().staleTapReplays, 0);

  generationReadable = true;
  for (let i = 0; i < 20 && timers.length; i += 1) timers.shift()();
  assert.equal(handlerCalls, 1, 'replay the original interaction exactly once after recovery');
  assert.equal(session.has(pendingKey), false);
  assert.equal(window.TaskPointsHabitFastPathControl.getStatus().staleTapReplays, 1);
  for (let i = 0; i < 4 && timers.length; i += 1) timers.shift()();
  assert.equal(handlerCalls, 1, 'subsequent timer passes must not repeat the tap');
});

test('old-generation stale tap is still discarded once the generation becomes readable', () => {
  const sourcePattern = /generationReady && String\(pending\.generation \|\| ''\) !== String\(status\.currentGeneration\)/;
  assert.match(source, sourcePattern,
    'only a verifiably current epoch can authorize a replay; confirmed stale taps must be discarded');
});

function makePendingTapHarness(options = {}) {
  const KEY = 'taskpoints_v2_stale_habit_tap_v1';
  const local = new Map([['taskpoints_state_v2_dark_mode_v1', '1']]);
  const session = new Map([[KEY, JSON.stringify({
    version: 1, habitId: 'habit-1', dayKey: '2026-08-02',
    generation: options.pendingGeneration || 'generation:valid',
    pathname: '/index.html', createdEpochMs: Date.now()
  })]]);
  const timers = [];
  const listeners = new Map();
  let fault = null, calls = 0, failReadbackOnce = false;
  const bubble = {
    getAttribute(k) { return { 'data-habit': 'habit-1', 'data-day': '2026-08-02' }[k] || ''; }
  };
  const document = {
    readyState: 'complete', addEventListener() {},
    querySelectorAll() { return [bubble]; }
  };
  const window = {
    document, Date, location: { pathname: '/index.html' },
    localStorage: {
      getItem(k) {
        if (fault === 'dark') throw Error('synthetic dark-mode read SecurityError');
        return local.get(k) ?? null;
      }
    },
    sessionStorage: {
      getItem(k) {
        if (failReadbackOnce) {
          failReadbackOnce = false;
          throw Error('synthetic readback SecurityError');
        }
        return session.get(k) ?? null;
      },
      setItem(k, value) { session.set(k, String(value)); },
      removeItem(k) {
        if (fault === 'remove') throw Error('synthetic session write SecurityError');
        if (fault === 'silent-remove') return; // storage silently refused the deletion
        session.delete(k);
        if (fault === 'readback') failReadbackOnce = true;
      }
    },
    TaskPointsStateRuntimeV2: {
      getStatus() {
        if (fault === 'status') throw Error('synthetic generation status SecurityError');
        return { generationReadable: true, currentGeneration: 'generation:valid',
          externalRevisionInvalidated: false, readAuthority: 'legacy_only' };
      },
      beforeHabitInteraction() { return { proceed: true }; }
    },
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) || []), fn]);
    },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    handleHabitBubbleTap() { calls += 1; }
  };
  vm.runInContext(source, vm.createContext({
    window, document, globalThis: window, module: { exports: {} }, console, Date
  }));
  return {
    window, session, timers, listeners, KEY,
    setFault(value) { fault = value; },
    pump() { assert.ok(timers.length, 'a replay/retry timer must be queued'); timers.shift()(); },
    calls() { return calls; }
  };
}

test('transient storage exceptions never consume a queued Habit until its one safe replay', () => {
  const h = makePendingTapHarness();
  h.setFault('status');
  // The combined module installs three independent Home helpers first.
  for (let n = 0; n < 3; n += 1) h.pump();
  h.pump(); // Generation status read unavailable.
  assert.equal(h.calls(), 0);
  assert.equal(h.session.has(h.KEY), true);
  h.setFault('dark');
  h.pump(); // Reading the dark-mode flag also fails closed.
  assert.equal(h.calls(), 0);
  assert.equal(h.session.has(h.KEY), true);
  h.setFault('remove');
  h.pump(); // SessionStorage refuses to consume the continuation.
  assert.equal(h.calls(), 0);
  assert.equal(h.session.has(h.KEY), true);
  h.setFault(null);
  h.pump(); // Both stores are available; only now replay.
  assert.equal(h.calls(), 1);
  assert.equal(h.session.has(h.KEY), false);
  assert.equal(h.window.TaskPointsHabitFastPathControl.getStatus().staleTapReplays, 1);
  assert.equal(h.timers.length, 0);
});

test('bounded blocked replay stays in session and rearms when page resumes', () => {
  const h = makePendingTapHarness();
  h.setFault('dark');
  for (let n = 0; n < 3; n += 1) h.pump(); // Install Home helpers.
  for (let n = 0; n < 101; n += 1) h.pump();
  assert.equal(h.timers.length, 0, 'stop retries instead of spinning forever');
  assert.equal(h.calls(), 0);
  assert.equal(h.session.has(h.KEY), true, 'never silently erase the pending touch');
  h.setFault(null);
  assert.ok(h.listeners.get('pageshow')?.length >= 1);
  h.listeners.get('pageshow').forEach(fn => fn());
  h.pump();
  assert.equal(h.calls(), 1, 'resumption replays the original tap once');
  assert.equal(h.session.has(h.KEY), false);
  h.listeners.get('pageshow').forEach(fn => fn());
  assert.equal(h.timers.length, 0, 'an already completed tap cannot be rescheduled');
  assert.equal(h.calls(), 1);
});

test('verified old-generation continuation is discarded rather than replayed after recovery', () => {
  const h = makePendingTapHarness({ pendingGeneration: 'generation:old' });
  for (let n = 0; n < 3; n += 1) h.pump(); // Install Home helpers.
  h.pump();
  assert.equal(h.calls(), 0);
  assert.equal(h.session.has(h.KEY), false);
  assert.equal(h.window.TaskPointsHabitFastPathControl.getStatus().staleTapDiscarded, 1);
});

test('silently ignored sessionStorage removal never permits duplicate Habit replay', () => {
  const h = makePendingTapHarness();
  h.setFault('silent-remove');
  for (let n = 0; n < 3; n += 1) h.pump(); // Install Home helpers.
  h.pump(); // Deletion returns without actually removing the queued tap.
  assert.equal(h.calls(), 0, 'unconfirmed deletion must block execution');
  assert.equal(h.session.has(h.KEY), true, 'the original tap remains recoverable');
  assert.equal(h.window.TaskPointsHabitFastPathControl.getStatus().staleTapReplays, 0);
  h.setFault(null);
  h.pump(); // The next attempt can confirm the deletion.
  assert.equal(h.calls(), 1);
  assert.equal(h.session.has(h.KEY), false);
  assert.equal(h.window.TaskPointsHabitFastPathControl.getStatus().staleTapReplays, 1);
  h.listeners.get('pageshow').forEach(fn => fn());
  assert.equal(h.timers.length, 0);
  assert.equal(h.calls(), 1, 'a page resume cannot replay the same tap again');
});

test('failed session readback after successful removal restores the original pending tap', () => {
  const h = makePendingTapHarness();
  h.setFault('readback');
  for (let n = 0; n < 3; n += 1) h.pump(); // Install Home helpers.
  h.pump(); // Removal happened; its verification read threw.
  assert.equal(h.calls(), 0, 'unverified removal must never execute the action');
  assert.equal(h.session.has(h.KEY), true, 'requeue the intent before retrying');
  assert.equal(h.window.TaskPointsHabitFastPathControl.getStatus().staleTapReplays, 0);
  h.setFault(null);
  h.pump();
  assert.equal(h.calls(), 1);
  assert.equal(h.session.has(h.KEY), false);
  assert.equal(h.window.TaskPointsHabitFastPathControl.getStatus().staleTapReplays, 1);
});
