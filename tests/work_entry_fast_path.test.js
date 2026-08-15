const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'work_entry_fast_path.js'), 'utf8');
const guardSource = fs.readFileSync(path.join(ROOT, 'habit_completion_source_guard.js'), 'utf8');

function makeHarness({ journalFails = false, preflightFails = false, targetedUi = true } = {}) {
  const calls = {
    fullSaves: 0,
    renders: 0,
    journal: [],
    storageTouches: 0,
    idleTouches: 0,
    scwmRefreshes: 0,
    liveRefreshes: 0,
    canonicalReconciles: 0,
    perf: []
  };
  const timers = [];
  const listeners = new Map();
  let time = 100;

  const work = {
    id: 'work-today',
    title: 'Work Score (7) — Hours 8',
    points: 7.08,
    completedAtISO: '2026-08-15T12:00:00.000Z',
    workHours: 8,
    source: 'work'
  };
  const state = {
    completions: [
      work,
      { id: 'task-1', title: 'Something else', points: 2, completedAtISO: '2026-08-15T12:00:00.000Z' }
    ]
  };

  const core = {
    assertTaskMutationJournalWritable() {
      if (preflightFails) throw new Error('blocked');
      return true;
    },
    journalTaskMutation(mutation) {
      if (journalFails) throw new Error('quota');
      calls.journal.push(JSON.parse(JSON.stringify(mutation)));
    },
    noteStorageUserInteraction() { calls.storageTouches += 1; },
    isStorageMaintenanceQuiet() { return true; }
  };

  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    hidden: false,
    addEventListener(name, fn) { listeners.set(`document:${name}`, fn); },
    getElementById() { return null; }
  };

  const context = {
    console,
    Date,
    Promise,
    Array,
    Object,
    Map,
    Set,
    Number,
    String,
    Math,
    JSON,
    Error,
    structuredClone,
    performance: { now: () => time },
    TaskPointsCore: core,
    TaskPointsPerf: { mark(name, detail) { calls.perf.push({ name, detail }); } },
    TaskPointsHomeIdleQueue: { noteInteraction() { calls.idleTouches += 1; } },
    __tpWorkEntryStateForTest: state,
    document,
    addEventListener(name, fn) { listeners.set(`window:${name}`, fn); },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
    requestIdleCallback(fn) { timers.push(fn); return timers.length; },
    cancelIdleCallback() {},
    save(savePath) { calls.fullSaves += 1; calls.lastSavePath = savePath || ''; },
    renderAll() { calls.renders += 1; }
  };

  if (targetedUi) {
    context.refreshScoreV2UI = function refreshScoreV2UI() { calls.scwmRefreshes += 1; };
    context.TaskPointsHomeTargetedRenderControl = {
      refreshLiveScorePanels() { calls.liveRefreshes += 1; return true; },
      reconcileNow() { calls.canonicalReconciles += 1; return true; }
    };
  }

  context.window = context;
  context.globalThis = context;

  context.submitWorkEditModal = function submitWorkEditModal() {
    work.title = 'Work Score (8) — Hours 8.25';
    work.points = 8.0825;
    work.workHours = 8.25;
    context.save();
    context.renderAll();
  };
  context.saveWorkScore = function saveWorkScore() {
    const entry = {
      id: 'work-new',
      title: 'Work Score (9) — Hours 9',
      points: 9.09,
      completedAtISO: '2026-08-15T12:00:00.000Z',
      workHours: 9,
      source: 'work'
    };
    state.completions.unshift(entry);
    context.save();
    context.renderAll();
  };

  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'work_entry_fast_path.js' });
  if (timers.length) timers.shift()(); // install only

  return {
    context,
    calls,
    state,
    work,
    timers,
    flushOneTimer() { if (timers.length) timers.shift()(); },
    setTime(value) { time = value; }
  };
}

test('loader keeps the Work fast path outside the core worker while loading the current Home version', () => {
  assert.match(guardSource, /work_entry_fast_path\.js\?v=20260815-2/);
  assert.match(guardSource, /data-taskpoints-work-entry-fast-path/);
});

test('editing a Work entry journals the completion and uses targeted score rendering', () => {
  const h = makeHarness();
  h.context.submitWorkEditModal();

  assert.equal(h.calls.fullSaves, 0);
  assert.equal(h.calls.renders, 0);
  assert.equal(h.calls.scwmRefreshes, 1);
  assert.equal(h.calls.liveRefreshes, 1);
  assert.equal(h.calls.journal.length, 1);
  assert.equal(h.calls.journal[0].completionUpsert.id, 'work-today');
  assert.equal(h.calls.journal[0].completionUpsert.workHours, 8.25);
  assert.ok(h.calls.storageTouches > 0);
  assert.ok(h.calls.idleTouches > 0);

  const status = h.context.TaskPointsWorkEntryFastPath.getStatus();
  assert.equal(status.version, 2);
  assert.equal(status.counters.fastCommits, 1);
  assert.equal(status.counters.suppressedFullSaves, 1);
  assert.equal(status.counters.targetedRenders, 1);
  assert.equal(status.canonicalReconcilePending, true);
});

test('adding a Work entry journals the new completion and keeps the full renderer off the interaction', () => {
  const h = makeHarness();
  h.context.saveWorkScore();

  assert.equal(h.calls.fullSaves, 0);
  assert.equal(h.calls.renders, 0);
  assert.equal(h.calls.scwmRefreshes, 1);
  assert.equal(h.calls.liveRefreshes, 1);
  assert.equal(h.calls.journal.length, 1);
  assert.equal(h.calls.journal[0].completionUpsert.id, 'work-new');
});

test('targeted-render unavailability preserves the old full Home render', () => {
  const h = makeHarness({ targetedUi: false });
  h.context.submitWorkEditModal();

  assert.equal(h.calls.fullSaves, 0);
  assert.equal(h.calls.renders, 1);
  assert.equal(h.calls.journal.length, 1);
  assert.equal(h.context.TaskPointsWorkEntryFastPath.getStatus().counters.renderFallbacks, 1);
});

test('a journal write failure falls back to the original authoritative full save and render', () => {
  const h = makeHarness({ journalFails: true });
  h.context.submitWorkEditModal();

  assert.equal(h.calls.fullSaves, 1);
  assert.equal(h.calls.lastSavePath, 'work-entry-fast-path-fallback');
  assert.equal(h.calls.renders, 1);
  assert.equal(h.context.TaskPointsWorkEntryFastPath.getStatus().counters.fallbackFullSaves, 1);
});

test('recovery/journal preflight failures leave the original Work save and render untouched', () => {
  const h = makeHarness({ preflightFails: true });
  h.context.submitWorkEditModal();

  assert.equal(h.calls.fullSaves, 1);
  assert.equal(h.calls.renders, 1);
  assert.equal(h.calls.journal.length, 0);
});
