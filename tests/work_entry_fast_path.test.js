const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'work_entry_fast_path.js'), 'utf8');
const guardSource = fs.readFileSync(path.join(ROOT, 'habit_completion_source_guard.js'), 'utf8');

function makeHarness({ journalFails = false, preflightFails = false } = {}) {
  const calls = {
    fullSaves: 0,
    renders: 0,
    journal: [],
    storageTouches: 0,
    idleTouches: 0,
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
    noteStorageUserInteraction() { calls.storageTouches += 1; }
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
    document: {
      readyState: 'complete',
      visibilityState: 'visible',
      addEventListener(name, fn) { listeners.set(`document:${name}`, fn); }
    },
    addEventListener(name, fn) { listeners.set(`window:${name}`, fn); },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
    save(savePath) { calls.fullSaves += 1; calls.lastSavePath = savePath || ''; },
    renderAll() { calls.renders += 1; }
  };
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
  while (timers.length) timers.shift()();

  return { context, calls, state, work, setTime(value) { time = value; } };
}

test('loader keeps the Work fast path outside the core worker while loading it on Home', () => {
  assert.match(guardSource, /work_entry_fast_path\.js\?v=20260815-1/);
  assert.match(guardSource, /data-taskpoints-work-entry-fast-path/);
});

test('editing a Work entry journals the changed completion instead of doing a full-state save', () => {
  const h = makeHarness();
  h.context.submitWorkEditModal();

  assert.equal(h.calls.fullSaves, 0);
  assert.equal(h.calls.renders, 1, 'keep the existing full Home render in the first optimization pass');
  assert.equal(h.calls.journal.length, 1);
  assert.equal(h.calls.journal[0].completionUpsert.id, 'work-today');
  assert.equal(h.calls.journal[0].completionUpsert.workHours, 8.25);
  assert.ok(h.calls.storageTouches > 0);
  assert.ok(h.calls.idleTouches > 0);

  const status = h.context.TaskPointsWorkEntryFastPath.getStatus();
  assert.equal(status.counters.fastCommits, 1);
  assert.equal(status.counters.suppressedFullSaves, 1);
});

test('adding a Work entry journals the new completion', () => {
  const h = makeHarness();
  h.context.saveWorkScore();

  assert.equal(h.calls.fullSaves, 0);
  assert.equal(h.calls.journal.length, 1);
  assert.equal(h.calls.journal[0].completionUpsert.id, 'work-new');
});

test('a journal write failure falls back to the original authoritative full save', () => {
  const h = makeHarness({ journalFails: true });
  h.context.submitWorkEditModal();

  assert.equal(h.calls.fullSaves, 1);
  assert.equal(h.calls.lastSavePath, 'work-entry-fast-path-fallback');
  assert.equal(h.context.TaskPointsWorkEntryFastPath.getStatus().counters.fallbackFullSaves, 1);
});

test('recovery/journal preflight failures leave the original Work save untouched', () => {
  const h = makeHarness({ preflightFails: true });
  h.context.submitWorkEditModal();

  assert.equal(h.calls.fullSaves, 1);
  assert.equal(h.calls.journal.length, 0);
});
