const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'work_entry_fast_path.js'), 'utf8');
const guardSource = fs.readFileSync(path.join(ROOT, 'habit_completion_source_guard.js'), 'utf8');

function makeHarness({ journalFails = false, batchFails = false, batchEnabled = false,
  twoRowWorkSave = false, preflightFails = false, targetedUi = true } = {}) {
  const calls = {
    fullSaves: 0,
    renders: 0,
    journal: [],
    batches: [],
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

  if (batchEnabled) {
    core.journalTaskCompletionBatch = function journalTaskCompletionBatch(rows) {
      if (journalFails || batchFails) throw new Error('quota');
      calls.batches.push(JSON.parse(JSON.stringify(rows)));
    };
  }

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
    // The authoritative full-save stub must explicitly acknowledge durability.
    // An undefined return is an unconfirmed save, not a successful fallback.
    save(savePath) { calls.fullSaves += 1; calls.lastSavePath = savePath || ''; return true; },
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
    if (twoRowWorkSave) {
      state.completions.unshift({id:'work-side-effect',
        source:'work',title:'Companion Work completion',workHours:8,
        points:8,completedAtISO:'2026-08-15T12:05:00.000Z'});
    }
    context.save();
    context.renderAll();
  };

  // These real Home commit entrypoints all use the shared completion journal.
  // The Mood form opens earlier; submitMoodEditModal executes its onSave callback.
  context.saveSleepScore = function saveSleepScore() {
    state.completions.unshift({
      id: 'sleep-new', title: 'Sleep Score (84) — Rest 6',
      points: 8.4, sleepRested: 6, source: 'metric',
      completedAtISO: '2026-08-15T12:00:00.000Z'
    });
    context.save(); context.renderAll();
  };
  context.submitSleepEditModal = function submitSleepEditModal() {
    const row = state.completions.find(x => x.id === 'sleep-new');
    if (row) { row.title = 'Sleep Score (90) — Rest 7'; row.points = 9; row.sleepRested = 7; }
    context.save(); context.renderAll();
  };
  context.saveCalories = function saveCalories() {
    state.completions.unshift({
      id: 'cal-new', title: 'Calories (1810)',
      points: 8, calories: 1810, calLogBonusEnabled: false,
      source: 'metric', completedAtISO: '2026-08-15T12:00:00.000Z'
    });
    context.save(); context.renderAll();
  };
  context.submitMoodEditModal = function submitMoodEditModal() {
    state.completions.unshift({
      id: 'mood-new', title: 'Mood Score (3.8)',
      points: 3.8, moodNotes: 'kept privately and completely',
      source: 'metric', completedAtISO: '2026-08-15T12:00:00.000Z'
    });
    context.save(); context.renderAll();
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
  assert.match(guardSource, /work_entry_fast_path\.js\?v=20261102-2/);
  assert.match(guardSource, /data-taskpoints-work-entry-fast-path/);
});

test('large SCWM histories are fingerprinted only once before a fast save',()=>{
  const h=makeHarness();
  const historySize=800;
  for(let i=0;i<historySize;i++){
    h.state.completions.push({
      id:'scwm-history-'+i,source:'work',title:'Work Score history '+i,
      points:7.5,workHours:8,completedAtISO:'2026-09-01T12:00:00.000Z'
    });
  }
  const initialCount=h.state.completions.filter(row=>row.source==='work').length;
  let fingerprints=0;
  // Count the actual JSON serializations performed inside the wrapped
  // foreground commit. An eligibility check must never fingerprint the
  // entire history a second time.
  h.context.JSON=Object.assign(Object.create(JSON),{
    stringify(value,...args){
      if(value && typeof value==='object' && value.source==='work') fingerprints++;
      return JSON.stringify(value,...args);
    }
  });
  h.context.saveWorkScore();
  assert.equal(fingerprints,initialCount*2,
    'fingerprint existing rows once before and after; newly inserted IDs skip unnecessary fingerprinting');
  assert.equal(h.calls.fullSaves,0);
  assert.equal(h.calls.journal.length,1);
  assert.equal(h.calls.journal[0].completionUpsert.id,'work-new');
  assert.equal(h.context.TaskPointsWorkEntryFastPath.getStatus().counters.fastCommits,1);
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
  assert.equal(h.context.TaskPointsWorkEntryFastPath.version, 5);
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

test('Work journal failure never labels an unconfirmed full-save fallback as durable', () => {
  const h = makeHarness({ journalFails: true });
  h.context.save = function unconfirmedFullSave(savePath) {
    h.calls.fullSaves += 1;
    h.calls.lastSavePath = savePath || '';
    return undefined;
  };
  h.context.submitWorkEditModal();
  assert.equal(h.calls.fullSaves, 1);
  assert.equal(h.calls.lastSavePath, 'work-entry-fast-path-fallback');
  assert.equal(h.calls.journal.length, 0);
  const counters = h.context.TaskPointsWorkEntryFastPath.getStatus().counters;
  assert.equal(counters.fallbackFullSaves, 0);
  assert.equal(counters.fastCommits, 0);
});

test('recovery/journal preflight failures leave the original Work save and render untouched', () => {
  const h = makeHarness({ preflightFails: true });
  h.context.submitWorkEditModal();

  assert.equal(h.calls.fullSaves, 1);
  assert.equal(h.calls.renders, 1);
  assert.equal(h.calls.journal.length, 0);
});


test('Sleep creation and edit preserve score/rested fields in the crash-safe completion journal', () => {
  const h = makeHarness();
  h.context.saveSleepScore();
  assert.equal(h.calls.fullSaves, 0);
  assert.equal(h.calls.journal.length, 1);
  assert.deepEqual(
    { id: h.calls.journal[0].completionUpsert.id, rested: h.calls.journal[0].completionUpsert.sleepRested },
    { id: 'sleep-new', rested: 6 }
  );
  h.context.submitSleepEditModal();
  assert.equal(h.calls.fullSaves, 0);
  assert.equal(h.calls.journal.length, 2);
  assert.equal(h.calls.journal[1].completionUpsert.sleepRested, 7);
  assert.equal(h.calls.journal[1].completionUpsert.title, 'Sleep Score (90) — Rest 7');
});

test('Calories creation journals full bonus metadata instead of a foreground full-state save', () => {
  const h = makeHarness();
  h.context.saveCalories();
  assert.equal(h.calls.fullSaves, 0);
  assert.equal(h.calls.journal.length, 1);
  assert.equal(h.calls.journal[0].completionUpsert.id, 'cal-new');
  assert.equal(h.calls.journal[0].completionUpsert.calLogBonusEnabled, false);
});

test('Mood modal completion journals the entire mood text and score before yielding to the renderer', () => {
  const h = makeHarness();
  h.context.submitMoodEditModal();
  assert.equal(h.calls.fullSaves, 0);
  assert.equal(h.calls.journal.length, 1);
  const saved = h.calls.journal[0].completionUpsert;
  assert.equal(saved.id, 'mood-new');
  assert.equal(saved.moodNotes, 'kept privately and completely');
  assert.equal(saved.points, 3.8);
  assert.equal(h.calls.scwmRefreshes, 1);
});

test('Mood entry journal failure retains authoritative full-save fallback and full render', () => {
  const h = makeHarness({ journalFails: true });
  h.context.submitMoodEditModal();
  assert.equal(h.calls.fullSaves, 1);
  assert.equal(h.calls.renders, 1);
  assert.equal(h.calls.lastSavePath, 'work-entry-fast-path-fallback');
});

test('Mood preflight failure does not suppress its original save or renderer', () => {
  const h = makeHarness({ preflightFails: true });
  h.context.submitMoodEditModal();
  assert.equal(h.calls.fullSaves, 1);
  assert.equal(h.calls.journal.length, 0);
  assert.equal(h.calls.renders, 1);
});

test('when SCWM defers the emergency fallback, flush it before returning after journal failure', () => {
  const h = makeHarness({ journalFails: true });
  let pending = null;
  let flushed = 0;
  h.context.save = function deferredScwmSave() {
    pending = Array.from(arguments);
  };
  h.context.TaskPointsScwmInteractionFastPath = {
    getStatus() { return { pendingSave: Boolean(pending) }; },
    flush() {
      if (!pending) return false;
      h.calls.fullSaves += 1;
      h.calls.lastSavePath = pending[0] || '';
      pending = null;
      flushed += 1;
      return true;
    }
  };
  h.context.submitMoodEditModal();
  assert.equal(flushed, 1, 'durable fallback flush happens before the action returns');
  assert.equal(h.calls.fullSaves, 1);
  assert.equal(h.calls.lastSavePath, 'work-entry-fast-path-fallback');
  assert.equal(pending, null);
});


test('live Home getter overrides stale global/test state and journals the edited row', () => {
  const h = makeHarness();
  h.context.TaskPointsWorkEntryAccess = {
    getState: () => h.state,
    getEditedRow: () => h.work
  };
  h.context.__tpWorkEntryStateForTest = { completions: [] }; // deliberately stale
  h.context.submitWorkEditModal();
  assert.equal(h.calls.journal.length, 1);
  assert.equal(h.calls.journal[0].completionUpsert.workHours, 8.25);
  assert.equal(h.calls.fullSaves, 0);
});

test('saving unchanged Work values re-journals the actual row instead of compressing all history', () => {
  const h = makeHarness();
  h.work.title = 'Work Score (8) — Hours 8.25';
  h.work.points = 8.0825;
  h.work.workHours = 8.25;
  h.context.TaskPointsWorkEntryAccess = {
    getState: () => h.state,
    getEditedRow: () => h.work
  };
  h.context.submitWorkEditModal();
  assert.equal(h.calls.journal.length, 1);
  assert.equal(h.calls.journal[0].completionUpsert.id, 'work-today');
  assert.equal(h.calls.fullSaves, 0);
  assert.equal(h.context.TaskPointsWorkEntryFastPath.getStatus().counters.unchangedCommits, 1);
});

test('an unchanged Work edit with a detached row cannot bypass full-save confirmation', () => {
  const h = makeHarness();
  h.work.title = 'Work Score (8) — Hours 8.25';
  h.work.points = 8.0825;
  h.work.workHours = 8.25;
  h.context.TaskPointsWorkEntryAccess = {
    getState: () => h.state,
    getEditedRow: () => ({ ...h.work, id: 'work-today' })
  };
  h.context.submitWorkEditModal();
  assert.equal(h.calls.journal.length, 0);
  assert.equal(h.calls.fullSaves, 1);
  assert.equal(h.calls.lastSavePath, 'work-entry-fast-path-fallback');


test('two Work completion edits use the atomic batch journal once when available',()=>{
  const h=makeHarness({batchEnabled:true,twoRowWorkSave:true});
  h.context.saveWorkScore();
  assert.equal(h.calls.batches.length,1);
  assert.equal(h.calls.journal.length,0,'no per-row journal append after batch acknowledgement');
  assert.deepEqual(h.calls.batches[0].map(r=>r.id).sort(),
    ['work-new','work-side-effect']);
  assert.equal(h.calls.fullSaves,0);
  assert.equal(h.context.TaskPointsWorkEntryFastPath.getStatus()
    .counters.journaledCompletionUpserts,2);
});

test('atomic Work batch error never writes an individual row and retains full save fallback',()=>{
  const h=makeHarness({batchEnabled:true,batchFails:true,twoRowWorkSave:true});
  // The existing original-save fallback is still allowed to confirm
  // persistence synchronously; it must not fake a journal acknowledgement.
  h.context.save=function savedConfirmed(){h.calls.fullSaves++;return true};
  h.context.saveWorkScore();
  assert.equal(h.calls.batches.length,0);
  assert.equal(h.calls.journal.length,0);
  assert.equal(h.calls.fullSaves,1);
  assert.equal(h.context.TaskPointsWorkEntryFastPath.getStatus()
    .counters.fallbackFullSaves,1);
  assert.equal(h.context.TaskPointsWorkEntryFastPath.getStatus()
    .counters.journaledCompletionUpserts,0);
});

test('older Work integrations still use their existing per-row Task journal',()=>{
  const h=makeHarness({twoRowWorkSave:true});
  h.context.saveWorkScore();
  assert.equal(h.calls.batches.length,0);
  assert.equal(h.calls.journal.length,2);
  assert.equal(h.calls.fullSaves,0);
});
