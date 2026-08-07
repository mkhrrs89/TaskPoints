const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'scwm_interaction_fast_path.js'), 'utf8');

function makeStyle() {
  return {
    overflow: '',
    overscrollBehavior: '',
    position: '',
    top: '',
    width: '',
    removeProperty(name) {
      const property = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this[property] = '';
    }
  };
}

function createHarness() {
  const calls = {
    focus: 0,
    select: 0,
    saves: 0,
    fullRenders: 0,
    workRenders: 0,
    liveRefreshes: 0,
    modalVisible: false,
    legacyLocks: 0
  };
  const listeners = new Map();
  const timers = new Map();
  const frames = [];
  let timerId = 0;
  const input = {
    focus() { calls.focus += 1; },
    select() { calls.select += 1; }
  };
  const documentElement = { style: makeStyle() };
  const body = { style: makeStyle() };
  const document = {
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    documentElement,
    body,
    activeElement: { blur() {} },
    getElementById(id) { return id === 'workEditScoreInput' ? input : null; },
    addEventListener(name, callback) { listeners.set(name, callback); }
  };
  const context = {
    console,
    Date,
    Promise,
    Array,
    Object,
    Set,
    Map,
    Number,
    String,
    Math,
    performance: { now: () => 100 },
    document,
    scrollY: 240,
    scrollTo() {},
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    requestIdleCallback(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    cancelIdleCallback(id) { timers.delete(id); },
    addEventListener(name, callback) { listeners.set(name, callback); },
    TaskPointsHomeTargetedRenderControl: {
      refreshLiveScorePanels() { calls.liveRefreshes += 1; return true; },
      scheduleCanonicalStatsRefresh() {}
    },
    save() { calls.saves += 1; },
    scheduleRender(callback) { callback(); },
    renderAll() { calls.fullRenders += 1; },
    renderStats() {},
    renderWorkHistory() { calls.workRenders += 1; },
    lockScrollForModal() {
      calls.legacyLocks += 1;
      body.style.position = 'fixed';
      body.style.top = '-240px';
      body.style.width = '100%';
    },
    unlockScrollForModal() {
      body.style.position = '';
      body.style.top = '';
      body.style.width = '';
    }
  };
  context.window = context;
  context.globalThis = context;
  context.promptEditWorkEntry = function promptEditWorkEntry() {
    calls.modalVisible = true;
    context.lockScrollForModal();
    input.focus();
    input.select();
  };
  context.saveWorkScore = function saveWorkScore() {
    context.save();
    context.scheduleRender(context.renderAll);
  };

  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'scwm_interaction_fast_path.js' });

  function flushOneTimer() {
    const row = timers.entries().next().value;
    if (!row) return false;
    timers.delete(row[0]);
    row[1]();
    return true;
  }
  function flushFrames() {
    while (frames.length) frames.shift()();
  }
  function flushTimers() {
    let guard = 0;
    while (flushOneTimer() && guard++ < 50) {}
  }

  flushOneTimer();
  return { context, calls, body, documentElement, flushFrames, flushTimers };
}

test('opening Work editor paints before keyboard focus and avoids fixed-body relayout', () => {
  const { context, calls, body, documentElement, flushFrames, flushTimers } = createHarness();

  context.promptEditWorkEntry();

  assert.equal(calls.modalVisible, true);
  assert.equal(calls.legacyLocks, 0, 'the expensive fixed-body lock must not run');
  assert.equal(body.style.position, '', 'opening must not change the body containing block');
  assert.equal(documentElement.style.overflow, 'hidden');
  assert.equal(body.style.overflow, 'hidden');
  assert.equal(calls.focus, 0, 'keyboard focus waits until after the modal can paint');
  assert.equal(calls.select, 0);

  flushFrames();
  flushTimers();
  assert.equal(calls.focus, 1);
  assert.equal(calls.select, 1);

  context.unlockScrollForModal();
  assert.equal(documentElement.style.overflow, '');
  assert.equal(body.style.overflow, '');
});

test('the existing SCWM save fast path remains active', () => {
  const { context, calls } = createHarness();
  context.saveWorkScore();
  assert.equal(calls.saves, 0);
  assert.equal(calls.fullRenders, 0);
  assert.equal(calls.workRenders, 1);
  assert.equal(calls.liveRefreshes, 1);
  context.TaskPointsScwmInteractionFastPath.flush();
  assert.equal(calls.saves, 1);
});
