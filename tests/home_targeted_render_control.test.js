const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'home_targeted_render_control.js'), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeContext(overrides = {}) {
  const storage = new Map();
  const elements = new Map();
  const calls = {
    originalHandle: 0,
    originalRestack: 0,
    originalStatsScheduler: 0,
    renderHabits: 0,
    renderVices: 0,
    renderTasks: 0,
    renderStats: 0,
    renderAll: 0,
    renderToday: 0,
    renderMatchup: 0,
    renderYesterday: 0,
    renderBreakdown: 0,
    renderStreakBonus: 0,
    criticalIsland: 0
  };

  const context = {
    console,
    Date,
    Map,
    Set,
    Object,
    Number,
    String,
    Array,
    Math,
    JSON,
    RegExp,
    Error,
    Promise,
    module: { exports: {} },
    exports: {},
    location: { pathname: '/' },
    __TP_HOME_TARGETED_RENDER_TIMING: {
      liveRefreshDelayMs: 4,
      habitRestackDelayMs: 4,
      canonicalStatsDelayMs: 35,
      canonicalStatsIdleTimeoutMs: 50
    },
    localStorage: {
      getItem: (key) => storage.has(String(key)) ? storage.get(String(key)) : null,
      setItem: (key, value) => storage.set(String(key), String(value)),
      removeItem: (key) => storage.delete(String(key))
    },
    document: {
      readyState: 'loading',
      hidden: false,
      addEventListener: () => undefined,
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, { textContent: '' });
        return elements.get(id);
      }
    },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    requestIdleCallback: (callback) => setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 0),
    cancelIdleCallback: clearTimeout,
    handleHabitBubbleTap: () => { calls.originalHandle += 1; },
    scheduleHabitFullRestackRerender: () => { calls.originalRestack += 1; },
    scheduleHabitStatsRefresh: () => { calls.originalStatsScheduler += 1; },
    animateTaskCompletion: (_taskId, onDone) => onDone?.(),
    scheduleRender: (callback) => callback?.(),
    renderAll: () => { calls.renderAll += 1; },
    renderStats: () => { calls.renderStats += 1; },
    renderHabits: () => { calls.renderHabits += 1; },
    renderVices: () => { calls.renderVices += 1; },
    renderTasks: () => { calls.renderTasks += 1; },
    updateCriticalTasksIsland: () => { calls.criticalIsland += 1; },
    getDerived: () => ({
      lifetimePoints: 22,
      agg: { dailyTotals: { '2026-08-02': 5 } },
      byDay: new Map([['2026-08-02', [{ id: 'today' }]]])
    }),
    todayKey: () => '2026-08-02',
    dateKey: () => '2026-08-02',
    getGameDayKey: () => '2026-08-02',
    deriveTodayWithInertia: () => ({ todayPoints: 5, inertia: 1, average: 4 }),
    renderTodayPointsSummary: () => { calls.renderToday += 1; },
    renderTodaysMatchup: () => { calls.renderMatchup += 1; },
    renderYesterdaysResult: () => { calls.renderYesterday += 1; },
    updateTodayBreakdown: () => { calls.renderBreakdown += 1; },
    renderHomeStreakBonusSidecar: () => { calls.renderStreakBonus += 1; },
    ...overrides
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'home_targeted_render_control.js' });
  const api = context.TaskPointsHomeTargetedRenderControl;
  assert.equal(api.install(), true);
  return { context, api, calls, storage, elements };
}

function bubble(category = 'habit', dayKey = '2026-08-02') {
  return {
    dataset: { day: dayKey },
    getAttribute(name) {
      if (name === 'data-habit') return `${category}-1`;
      if (name === 'data-day') return dayKey;
      return '';
    },
    classList: { contains: (name) => category === 'vice' && name === 'viceDay' },
    closest: () => ({ dataset: { habitRowCategory: category } })
  };
}

test('habit restack rebuilds only the affected category', async () => {
  const { context, calls } = makeContext();
  context.handleHabitBubbleTap(bubble('habit'));
  context.scheduleHabitFullRestackRerender();
  await sleep(20);

  assert.equal(calls.originalHandle, 1);
  assert.equal(calls.renderHabits, 1);
  assert.equal(calls.renderVices, 0);
  assert.equal(calls.originalRestack, 0);
});

test('habit and vice taps in one burst each receive one canonical category render', async () => {
  const { context, calls } = makeContext();
  context.handleHabitBubbleTap(bubble('habit'));
  context.scheduleHabitFullRestackRerender();
  context.handleHabitBubbleTap(bubble('vice'));
  context.scheduleHabitFullRestackRerender();
  await sleep(20);

  assert.equal(calls.renderHabits, 1);
  assert.equal(calls.renderVices, 1);
  assert.equal(calls.originalRestack, 0);
});

test('unknown habit restack reason falls back to the original canonical scheduler', () => {
  const { context, calls } = makeContext();
  context.scheduleHabitFullRestackRerender();
  assert.equal(calls.originalRestack, 1);
});

test('habit stats use lightweight panels first and one delayed canonical stats render', async () => {
  const { context, calls, elements } = makeContext();
  context.handleHabitBubbleTap(bubble('habit'));
  context.scheduleHabitStatsRefresh();
  await sleep(20);

  assert.equal(calls.renderToday, 1);
  assert.equal(calls.renderMatchup, 1);
  assert.equal(calls.renderBreakdown, 1);
  assert.equal(calls.renderStats, 0);
  assert.equal(elements.get('lifetimePoints').textContent, '22');
  assert.equal(elements.get('dailyAvg').textContent, '5.0');

  await sleep(50);
  assert.equal(calls.renderStats, 1);
});

test('task completion intercepts only renderAll scheduled inside its completion callback', () => {
  const { context, calls } = makeContext();
  context.animateTaskCompletion('task-1', () => {
    context.scheduleRender(context.renderAll);
  });

  assert.equal(calls.renderTasks, 1);
  assert.equal(calls.renderToday, 1);
  assert.equal(calls.renderAll, 0);
  assert.equal(calls.criticalIsland, 1);

  context.scheduleRender(context.renderAll);
  assert.equal(calls.renderAll, 1, 'unrelated renderAll must remain untouched');
});

test('task targeted refresh falls back to renderAll when a required live renderer fails', () => {
  const { context, calls } = makeContext({ getDerived: undefined });
  context.animateTaskCompletion('task-1', () => {
    context.scheduleRender(context.renderAll);
  });

  assert.equal(calls.renderTasks, 1);
  assert.equal(calls.renderAll, 1);
});

test('persistent kill switch routes all work through original rendering', () => {
  const { context, api, calls, storage } = makeContext();
  api.disable();
  assert.equal(storage.get(api.DISABLED_KEY), '1');

  const restacksBefore = calls.originalRestack;
  const statsBefore = calls.originalStatsScheduler;
  context.handleHabitBubbleTap(bubble('habit'));
  context.scheduleHabitFullRestackRerender();
  context.scheduleHabitStatsRefresh();
  context.animateTaskCompletion('task-1', () => context.scheduleRender(context.renderAll));

  assert.equal(calls.originalRestack, restacksBefore + 1);
  assert.equal(calls.originalStatsScheduler, statsBefore + 1);
  assert.equal(calls.renderAll, 1);
  assert.equal(api.getStatus().enabled, false);

  api.enable();
  assert.equal(storage.has(api.DISABLED_KEY), false);
  assert.equal(api.getStatus().enabled, true);
});
