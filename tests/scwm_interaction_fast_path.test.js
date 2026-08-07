const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'scwm_interaction_fast_path.js'), 'utf8');

function classList(initial = []) {
  const set = new Set(initial);
  return {
    add(...xs) { xs.forEach(x => set.add(x)); },
    remove(...xs) { xs.forEach(x => set.delete(x)); },
    contains(x) { return set.has(x); },
    toggle(x, force) {
      if (force === true) set.add(x);
      else if (force === false) set.delete(x);
      else if (set.has(x)) set.delete(x); else set.add(x);
      return set.has(x);
    }
  };
}

function makeHarness({ scwmActive = true, completionCount = 5000 } = {}) {
  const calls = {
    saves: 0, fullRenders: 0, scwmRefreshes: 0, live: 0,
    focus: 0, select: 0, legacyLocks: 0, idle: 0,
    compactSeen: [], originalIntervals: 0
  };
  let time = 100;
  let timerId = 0;
  let intervalId = 0;
  const timers = new Map();
  const intervals = new Map();
  const frames = [];
  const listeners = new Map();

  const panel = {
    id: 'homePanelScwm',
    hidden: !scwmActive,
    classList: classList(scwmActive ? ['is-active'] : []),
    getAttribute() { return null; }
  };
  const modal = {
    id: 'workEditModal',
    hidden: true,
    classList: classList(['hidden']),
    getAttribute(name) { return name === 'aria-hidden' ? (this.hidden ? 'true' : 'false') : null; }
  };
  const input = {
    focus() { calls.focus++; },
    select() { calls.select++; }
  };
  const body = { classList: classList(), style: {} };
  const head = { appendChild() {} };

  const document = {
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    body, head,
    documentElement: { style: {}, appendChild() {} },
    activeElement: { blur() {} },
    getElementById(id) {
      if (id === 'homePanelScwm') return panel;
      if (id === 'workEditModal') return modal;
      if (id === 'workEditScoreInput') return input;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes('workEditModal')) return [modal];
      return [];
    },
    createElement() { return { id: '', textContent: '', setAttribute() {} }; },
    addEventListener(name, cb) { listeners.set(name, cb); }
  };

  const completions = [];
  for (let i = 0; i < completionCount; i++) {
    completions.push({ id: `task-${i}`, title: `Task ${i}`, completedAtISO: '2026-01-01T12:00:00.000Z', points: 1 });
  }
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  const todayKey = `${y}-${m}-${d}`;
  const work = { id: 'work-today', title: 'Work Score (7)', workHours: 1, points: 7.01, dateKey: todayKey, completedAtISO: `${todayKey}T12:00:00.000Z` };
  completions.unshift(work);
  for (let i = 1; i <= 10; i++) {
    const dt = new Date(today); dt.setDate(dt.getDate() - i);
    const ky = dt.getFullYear(), km = String(dt.getMonth()+1).padStart(2,'0'), kd = String(dt.getDate()).padStart(2,'0');
    const k = `${ky}-${km}-${kd}`;
    completions.unshift({ id:`w${i}`, title:`Work Score (${i})`, points:i, dateKey:k, completedAtISO:`${k}T12:00:00.000Z` });
    completions.unshift({ id:`s${i}`, title:`Sleep Score (${80+i})`, points:8, dateKey:k, completedAtISO:`${k}T12:00:00.000Z` });
    completions.unshift({ id:`c${i}`, title:`Calories (${1800+i})`, points:5, dateKey:k, completedAtISO:`${k}T12:00:00.000Z` });
    completions.unshift({ id:`m${i}`, title:`Mood Score (${i%10})`, points:5, dateKey:k, completedAtISO:`${k}T12:00:00.000Z` });
  }
  const state = { completions };

  const context = {
    console, Date, Promise, Array, Object, Set, Map, Number, String, Math, Function,
    __tpScwmStateForTest: state,
    performance: { now: () => time },
    document,
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame(cb) { frames.push(cb); return frames.length; },
    cancelAnimationFrame() {},
    setTimeout(cb) { const id = ++timerId; timers.set(id, cb); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(cb, ms) { calls.originalIntervals++; const id = ++intervalId; intervals.set(id,{cb,ms}); return id; },
    clearInterval(id) { intervals.delete(id); },
    requestIdleCallback(cb) { const id = ++timerId; timers.set(id, cb); return id; },
    cancelIdleCallback(id) { timers.delete(id); },
    addEventListener(name, cb) { listeners.set(`window:${name}`, cb); },
    scrollY: 100,
    scrollTo() {},
    TaskPointsHomeIdleQueue: { noteInteraction() { calls.idle++; } },
    TaskPointsHomeTargetedRenderControl: { refreshLiveScorePanels() { calls.live++; } },
    save() { calls.saves++; },
    renderAll() { calls.fullRenders++; },
    markCompletionsDirty() {},
    resolveCompletionRef(ref) { return state.completions.find(x => x.id === ref?.id) || null; },
    getTodayWorkEntry() { return state.completions.find(x => x.id === 'work-today') || null; },
    getTodaySleepEntry() { return null; },
    getTodayCaloriesEntry() { return null; },
    getTodayMoodEntry() { return null; },
    renderScoreDashboardV2_Skeleton() { calls.compactSeen.push(state.completions.length); },
    renderScoreV2RecentGrid() { calls.compactSeen.push(state.completions.length); },
    refreshScoreV2UI() {
      calls.scwmRefreshes++;
      context.renderScoreDashboardV2_Skeleton();
      context.renderScoreV2RecentGrid();
    },
    lockScrollForModal() { calls.legacyLocks++; body.style.position = 'fixed'; },
    unlockScrollForModal() { body.style.position = ''; }
  };
  context.window = context;
  context.globalThis = context;

  context.promptEditWorkEntry = function() {
    modal.hidden = false;
    modal.classList.remove('hidden');
    context.lockScrollForModal();
    input.focus();
    input.select();
  };
  context.closeWorkEditModal = function() {
    modal.hidden = true;
    modal.classList.add('hidden');
    context.unlockScrollForModal();
  };
  context.submitWorkEditModal = function() {
    state.completions[0].points += 1;
    context.markCompletionsDirty();
    context.save();
    context.renderAll();
    context.closeWorkEditModal();
  };
  context.saveWorkScore = function() {
    context.markCompletionsDirty();
    context.save();
    context.renderAll();
  };

  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'scwm_interaction_fast_path.js' });

  function flushTimer(limit=100) {
    let n=0;
    while (timers.size && n++<limit) {
      const [id, cb] = timers.entries().next().value;
      timers.delete(id); cb();
    }
  }
  function flushFrames(limit=100) {
    let n=0;
    while (frames.length && n++<limit) frames.shift()();
  }

  flushTimer(1);
  return { context, calls, state, panel, modal, input, body, listeners, intervals, timers, frames, flushTimer, flushFrames, setTime(v){time=v;} };
}

test('SCWM renderAll suppresses the expensive full Home renderer', () => {
  const h = makeHarness();
  h.context.renderAll();
  assert.equal(h.calls.fullRenders, 0);
  assert.equal(h.calls.scwmRefreshes, 1);
  assert.equal(h.context.TaskPointsScwmInteractionFastPath.getStatus().pendingFullRender, true);

  h.panel.classList.remove('is-active'); h.panel.hidden = true;
  h.setTime(9999);
  h.context.TaskPointsScwmInteractionFastPath.flushPendingFullRender();
  assert.equal(h.calls.fullRenders, 1);
});

test('SCWM renderers receive a compact completion slice and restore the full state', () => {
  const h = makeHarness({ completionCount: 8000 });
  const fullLength = h.state.completions.length;
  h.context.renderScoreV2RecentGrid();
  assert.ok(h.calls.compactSeen.at(-1) < 100, `compact length was ${h.calls.compactSeen.at(-1)}`);
  assert.equal(h.state.completions.length, fullLength);
  assert.ok(h.context.TaskPointsScwmInteractionFastPath.getStatus().counters.indexBuilds >= 1);
});

test('today Work lookup uses indexed history', () => {
  const h = makeHarness({ completionCount: 12000 });
  const entry = h.context.getTodayWorkEntry();
  assert.equal(entry.id, 'work-today');
});

test('opening Work editor bypasses page relayout, paints before focus, and suppresses V2 polling', () => {
  const h = makeHarness();
  h.context.promptEditWorkEntry();
  assert.equal(h.calls.legacyLocks, 0);
  assert.equal(h.body.style.position, undefined);
  assert.equal(h.calls.focus, 0);
  assert.equal(h.calls.select, 0);

  const poll = function(){ const beforeTitle=''; const beforePts=0; const nowTitle=''; const nowPts=0; renderScoreDashboardV2_Skeleton(); return [beforeTitle,beforePts,nowTitle,nowPts]; };
  const id = h.context.setInterval(poll, 100);
  assert.ok(id < 0);
  assert.equal(h.calls.originalIntervals, 0);
  assert.equal(h.context.TaskPointsScwmInteractionFastPath.getStatus().counters.pollsSuppressed, 1);

  h.flushFrames();
  h.flushTimer(5);
  assert.equal(h.calls.focus, 1);
  assert.equal(h.calls.select, 1);
});

test('virtual-keyboard input keeps Home idle work postponed', () => {
  const h = makeHarness();
  const target = { closest(sel) { return sel.includes('homePanelScwm') ? {} : null; } };
  const inputListener = h.listeners.get('input');
  assert.equal(typeof inputListener, 'function');
  const before = h.calls.idle;
  inputListener({ target });
  assert.ok(h.calls.idle > before);
});

test('SCWM save is deferred and does not force full Home render', () => {
  const h = makeHarness();
  h.context.saveWorkScore();
  assert.equal(h.calls.saves, 0);
  assert.equal(h.calls.fullRenders, 0);
  h.context.TaskPointsScwmInteractionFastPath.flush();
  assert.equal(h.calls.saves, 1);
});
