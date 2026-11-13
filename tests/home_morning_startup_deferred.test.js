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
  const calls = { simulations: 0, sync: 0, renders: 0, matchupRefreshes: 0, dirty: 0, baselines: 0, marks: [] };
  const state = {
    players: [{ id: 'NPC-1', active: true }],
    gameHistory: [{ id: 'from-yesterday', playerId: 'NPC-1', date: '2026-11-10' }],
    matchups: hasTodayMatchup ? [{ id: 'today', date: '2026-11-11', playerAId: 'YOU', playerBId: 'NPC-1', scoreA: 42, scoreB: 50 }] : []
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
    hasRecordedMatchupScore(row) { return Number.isFinite(row?.scoreA) && Number.isFinite(row?.scoreB); },
    setTimeout(fn, delay) { jobs.push({ fn, delay }); },
    requestAnimationFrame(fn) { frames.push(fn); },
    maybeAutoSimToday() {
      calls.simulations++;
      state.matchups.push({ id: 'today', date: '2026-11-11', playerAId: 'YOU', playerBId: 'NPC-1', scoreA: 42, scoreB: 50 });
      return true;
    },
    syncStateWithMatchups(next) { calls.sync++; return next; },
    markCompletionsDirty() { calls.dirty++; },
    renderAll() {},
    scheduleRender() { calls.renders++; },
    refreshHomeMatchupAfterSimulation() { calls.matchupRefreshes++; },
    markHomeLifecycleBaseline() { calls.baselines++; }
  };
  vm.createContext(context);
  vm.runInContext('let homeMorningSimulationScheduled = false;\n'
    + extractFunction('homeDailyMatchupsReady') + '\n' + schedulerSource, context);
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
  assert.equal(h.calls.matchupRefreshes, 1, 'refresh the opponent immediately after generation');
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

test('a recorded NPC game cannot suppress a missing scheduled YOUR matchup', () => {
  const h = setup({ hasTodayMatchup: true });
  h.state.matchups[0].playerAId = 'NPC-1';
  h.state.matchups[0].playerBId = 'NPC-2';
  h.state.schedule = [{ date: '2026-11-11', matchups: [
    { playerAId: 'YOU', playerBId: 'NPC-3' },
    { playerAId: 'NPC-1', playerBId: 'NPC-2' }
  ] }];
  assert.equal(h.schedule(), true, 'partial NPC slate is not equivalent to a completed user game');
  h.reveal();
  h.tick();
  h.frame();
  h.tick();
  assert.equal(h.calls.simulations, 1);
  assert.equal(h.calls.matchupRefreshes, 1);
});

test('a legitimate user bye is not treated as a missing matchup', () => {
  const h = setup({ hasTodayMatchup: true });
  h.state.matchups[0].playerAId = 'NPC-1';
  h.state.matchups[0].playerBId = 'NPC-2';
  h.state.schedule = [{ date: '2026-11-11', byeIds: ['YOU'],
    matchups: [{ playerAId: 'NPC-1', playerBId: 'NPC-2' }] }];
  assert.equal(h.schedule(), false);
  assert.equal(h.calls.simulations, 0);
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

test('a day with no games never needlessly saves unchanged historical data', () => {
  const source = extractFunction('simulateToday');
  assert.match(source, /const scheduleChanged = ensureUpcomingSchedule\(\);/);
  assert.match(source, /const saved = scheduleChanged \? save\(\) : false;/);
  assert.match(source, /markHomeMorningStartupPhase\('simulation-finished', \{ saved \}\);/);
});

test('deferred historical repair uses only fresh authoritative data and does not save if repaired already', () => {
  const source = extractFunction('scheduleHomeHistoricalRepairPersistenceAfterFirstPaint');
  const timers = [];
  const calls = { reads: 0, repairs: 0, saves: 0 };
  let changed = true;
  let userActive = true;
  const core = {
    getStorageMaintenanceIdleStatus() {
      return { pageLeaving: false, activeEditor: false, navigationQuietForMs: 0, lastInteractionAgoMs: userActive ? 1000 : 20000 };
    },
    readTaskPointsStoredState() { calls.reads++; return { revision: calls.reads, tasks: [{ id: 'keep' }] }; },
    repairConfirmedJune2026LifetimeHistory(state) {
      calls.repairs++;
      return { changed, state: { ...state, historicalRepairMarkers: { june2026LifetimeMatchupsV1: true } } };
    },
    mergeAndSaveState(state, options) {
      calls.saves++;
      assert.equal(state.revision, calls.reads, 'latest durable revision, never startup state');
      assert.equal(options.savePath, 'june-2026-lifetime-history-repair');
      return { state };
    }
  };
  const sandbox = {
    TaskPointsCore: core, STORAGE_KEY: 'taskpoints_v1', document: { hidden: false },
    window: {}, console: { warn() {} }, homeMorningSimulationScheduled: false,
    setTimeout(fn, delay) { timers.push({ fn, delay }); }
  };
  vm.createContext(sandbox);
  vm.runInContext('let homeHistoricalRepairPersistenceScheduled = false;\n' + source, sandbox);
  vm.runInContext('scheduleHomeHistoricalRepairPersistenceAfterFirstPaint()', sandbox);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 18000);
  assert.equal(calls.reads, 0);
  timers.shift().fn(); // app still active: do not block input
  assert.equal(calls.saves, 0);
  assert.equal(timers[0].delay, 2500);
  userActive = false;
  timers.shift().fn();
  assert.equal(calls.reads, 1);
  assert.equal(calls.saves, 1);
  changed = false;
  vm.runInContext('homeHistoricalRepairPersistenceScheduled = false; scheduleHomeHistoricalRepairPersistenceAfterFirstPaint()', sandbox);
  timers.shift().fn();
  assert.equal(calls.reads, 2);
  assert.equal(calls.saves, 1, 'daily save already persisted the repair');
});
