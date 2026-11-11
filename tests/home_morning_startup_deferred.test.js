const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const gate = fs.readFileSync(path.join(root, 'mobile_boot_gate.js'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'settings.html'), 'utf8');

function extractFunction(name) {
  const start = home.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'missing function ' + name);
  const brace = home.indexOf('{', start);
  let depth = 0;
  for (let pos = brace; pos < home.length; pos++) {
    if (home[pos] === '{') depth++;
    if (home[pos] === '}' && --depth === 0) return home.slice(start, pos + 1);
  }
  throw new Error('unterminated function ' + name);
}
const schedulerSource = extractFunction('scheduleHomeDailySimulationAfterReveal');

function setup({ hidden = false, revealed = false, hasTodayMatchup = false, hour = 8 } = {}) {
  const jobs = [];
  const frames = [];
  const calls = { simulations: 0, sync: 0, renders: 0, dirty: 0, baselines: 0, marks: [] };
  const state = {
    players: [{ id: 'NPC-1', active: true }],
    gameHistory: [{ id: 'from-yesterday', playerId: 'NPC-1', date: '2026-11-10' }],
    matchups: hasTodayMatchup ? [{ id: 'today', date: '2026-11-11' }] : []
  };
  let shown = revealed;
  class FixedDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super('2026-11-11T' + String(hour).padStart(2, '0') + ':00:00');
    }
  }
  const context = {
    Date: FixedDate,
    console: { error() {} },
    window: { __tpMobileBootCoordinator: { isRevealed() { return shown; } } },
    document: {
      hidden, documentElement: { classList: { contains() { return true; } } }
    },
    getGameDayKey() { return '2026-11-11'; },
    getMatchupDateKeyLocal(row) { return row?.date || ''; },
    state,
    markHomeMorningStartupPhase(...args) { calls.marks.push(args); },
    setTimeout(fn, delay) { jobs.push({ fn, delay }); },
    requestAnimationFrame(fn) { frames.push(fn); },
    maybeAutoSimToday() {
      calls.simulations++;
      state.matchups.push({ id: 'today', date: '2026-11-11' });
      return true;
    },
    syncStateWithMatchups(next) { calls.sync++; return next; },
    markCompletionsDirty() { calls.dirty++; },
    renderAll() {},
    scheduleRender() { calls.renders++; },
    markHomeLifecycleBaseline() { calls.baselines++; }
  };
  vm.createContext(context);
  vm.runInContext('let homeMorningSimulationScheduled = false;\n' + schedulerSource, context);
  return {
    state, calls, jobs, frames, context,
    schedule: () => vm.runInContext('scheduleHomeDailySimulationAfterReveal()', context),
    reveal: () => { shown = true; },
    resume: () => { context.document.hidden = false; },
    tick: () => { assert.ok(jobs.length); jobs.shift().fn(); },
    frame: () => { assert.ok(frames.length); frames.shift()(); }
  };
}

test('a fresh day queues without invoking NPC scoring or saving inside Home boot', () => {
  const h = setup();
  assert.equal(h.schedule(), true);
  assert.equal(h.calls.simulations, 0);
  assert.equal(h.calls.sync, 0);
  assert.equal(h.calls.renders, 0);
  assert.equal(h.jobs.length, 1);
  h.tick();
  assert.equal(h.calls.simulations, 0);
  assert.ok(h.jobs.some(item => item.delay === 250), 'waits for actual Home reveal');
  h.reveal();
  h.tick();
  assert.equal(h.calls.simulations, 0);
  assert.equal(h.frames.length, 1, 'first frame paints before daily simulation');
  h.frame();
  assert.equal(h.calls.simulations, 0, 'computation is not run within the paint frame');
  h.tick();
  assert.equal(h.calls.simulations, 1);
  assert.equal(h.calls.sync, 1);
  assert.equal(h.calls.dirty, 1);
  assert.equal(h.calls.renders, 1);
  assert.equal(h.calls.baselines, 1);
  assert.equal(h.state.matchups.length, 1);
  assert.equal(h.schedule(), false, 'existing daily results are never regenerated');
});

test('simulated daily work is deferred when the iPhone remains backgrounded', () => {
  const h = setup({ hidden: true, revealed: true });
  h.schedule();
  h.tick();
  assert.equal(h.calls.simulations, 0);
  assert.equal(h.frames.length, 0);
  h.resume();
  h.tick();
  h.frame();
  h.tick();
  assert.equal(h.calls.simulations, 1);
});

test('nothing is queued when the daily slate exists or before the 5 AM game threshold', () => {
  for (const options of [{ hasTodayMatchup: true }, { hour: 4 }]) {
    const h = setup(options);
    assert.equal(h.schedule(), false);
    assert.equal(h.calls.simulations, 0);
    assert.equal(h.jobs.length, 0);
  }
});

test('fresh launches and waking an overnight app both use the same nonblocking scheduler', () => {
  const startup = home.slice(home.indexOf("document.addEventListener('DOMContentLoaded', () => {"),
    home.indexOf("console.log('TaskPoints main state summary:'"));
  assert.ok(startup.includes('scheduleHomeDailySimulationAfterReveal();'));
  assert.ok(!startup.includes('\nmaybeAutoSimToday();'),
    'synchronous simulation must never run inside the boot lifecycle handler');
  const resume = extractFunction('refreshMainPageFromStorage');
  assert.ok(resume.includes('scheduleHomeDailySimulationAfterReveal();'),
    'resuming on a new day must not block the UI with a fresh simulation');
  assert.ok(!resume.includes('const autoSimRan = maybeAutoSimToday();'));
  assert.ok(home.includes('const todayHistoryByPlayer = new Map();'));
  assert.ok(home.includes('todayHistoryByPlayer.get(String(id))'));
  assert.ok(home.includes('todayHistoryByPlayer.set(String(id), historyRow)'));
  assert.ok(home.includes('const saved = save();'),
    'the original protected save must still run');
  assert.ok(home.includes('TaskPointsCore.withGoldNpcScoringBatch(state, scoreNpcParticipants)'),
    'the existing Gold speedup remains');
});

test('mobile boot records stage boundaries without requiring a trace to load data', () => {
  for (const phase of ['coordinator-start', 'runtime-start',
    'scripts-replay-start', 'scripts-replay-finished',
    'ready-listeners-start', 'ready-listeners-finished', 'runtime-ready', 'home-revealed']) {
    assert.ok(gate.includes("'" + phase + "'"), 'missing phase ' + phase);
  }
  assert.ok(gate.includes("window.__tpBootTraceStage?.('scripts-replay-finished')"));
  assert.ok(gate.includes('catch (_) {}'), 'failed diagnostic writes must not affect boot');
});

test('Settings provides a read-only, copyable morning report without touching game data', () => {
  for (const id of ['morningStartupDiagnosticsSection', 'morningStartupReport',
    'showMorningStartupReportBtn', 'copyMorningStartupReportBtn']) {
    assert.ok(settings.includes('id="' + id + '"'));
  }
  assert.ok(settings.includes('tp_home_morning_startup_trace_v1'));
  assert.ok(settings.includes('tp_home_boot_timing_v1'));
  const start = settings.indexOf('(function enableMorningStartupDiagnostics()');
  const end = settings.indexOf('</script>', start);
  assert.ok(start > 0 && end > start);
  const snippet = settings.slice(start, end);
  assert.ok(!snippet.includes('localStorage.setItem'));
  assert.ok(!snippet.includes('saveSettingsState'));
  assert.doesNotThrow(() => new Function(snippet));
});
