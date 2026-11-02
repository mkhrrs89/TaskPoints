const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const fastPath = fs.readFileSync(path.join(root, 'work_entry_fast_path.js'), 'utf8');

function extract(name, nextName) {
  const start = home.indexOf('function ' + name + '(');
  const end = home.indexOf('function ' + nextName + '(', start);
  assert.ok(start >= 0 && end > start, name + ' source exists');
  return home.slice(start, end);
}

function makeHome({ journalFails = false, fullSaveOutcome = true, preflightFails = false } = {}) {
  const events = { journal: [], fullSaves: 0, alerts: [], renders: 0, closed: 0 };
  const timers = [];
  const original = {
    id: 'work-2026-11-01',
    title: 'Work Score (8) — Hours 8',
    source: 'work',
    workHours: 8,
    points: 8,
    completedAtISO: '2026-11-01T12:00:00.000Z'
  };
  const state = { completions: [original] };
  const fields = {
    workEditScoreInput: { value: '8.3' },
    workEditHoursInput: { value: '8.5' },
    workScoreInput: { value: '7.8' },
    workHoursInput: { value: '7.75' }
  };
  const ctx = {
    window: null, globalThis: null,
    console: { log() {}, warn() {}, error() {} },
    document: { readyState: 'complete', hidden: false, addEventListener() {} },
    state, __tpWorkEntryStateForTest: state, workEditContext: original,
    workEditOptions: { pinToToday: false },
    $: key => fields[key],
    crypto: { randomUUID: () => 'new-work-id' },
    dateKey: value => new Date(value).toISOString().slice(0, 10),
    workPoints: (score, hours) => score + hours / 100,
    resolveCompletionRef: () => original,
    toastPointsDeltaTodayAware() {},
    markCompletionsDirty() {},
    scheduleRender() { events.renders++; },
    renderAll() { events.renders++; },
    closeWorkEditModal() { events.closed++; },
    alert(text) { events.alerts.push(text); },
    save() { events.fullSaves++; return fullSaveOutcome; },
    TaskPointsCore: {
      assertTaskMutationJournalWritable() { if (preflightFails) throw new Error('journal preflight failed'); },
      journalTaskMutation(payload) {
        if (journalFails) throw new Error('journal write failed');
        events.journal.push(JSON.parse(JSON.stringify(payload)));
        return { completionUpserts: [payload.completionUpsert] };
      },
      noteStorageUserInteraction() {},
      isStorageMaintenanceQuiet() { return true; }
    },
    performance: { now: () => 100 },
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    addEventListener() {},
    TaskPointsHomeTargetedRenderControl: {
      refreshLiveScorePanels() { return true; }, reconcileNow() { return true; }
    },
    refreshScoreV2UI() {}
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(extract('submitWorkEditModal', 'logHomeBootReadOnlySkip'), ctx);
  vm.runInContext(extract('saveWorkScore', 'renderWorkHistory'), ctx);
  vm.runInContext(fastPath, ctx);
  if (timers.length) timers.shift()(); // installation only
  return { ctx, fields, events, state };
}

test('real Work edit closes on durable journal success without showing the false failure alert', () => {
  const { ctx, events, state } = makeHome({ fullSaveOutcome: false });
  ctx.submitWorkEditModal();
  assert.equal(events.alerts.length, 0);
  assert.equal(events.closed, 1);
  assert.equal(events.journal.length, 1);
  assert.equal(events.journal[0].completionUpsert.workHours, 8.5);
  assert.equal(state.completions[0].workHours, 8.5);
  assert.equal(events.fullSaves, 0);
});

test('real Work edit reports failure and stays open when journal and full-save fallback both fail', () => {
  const { ctx, fields, events } = makeHome({ journalFails: true, fullSaveOutcome: false });
  ctx.submitWorkEditModal();
  assert.equal(events.closed, 0);
  assert.equal(events.alerts.length, 1);
  assert.match(events.alerts[0], /could not be confirmed saved/);
  assert.equal(fields.workEditHoursInput.value, '8.5');
  assert.equal(events.fullSaves, 1);
});

test('real Work edit accepts a confirmed full save when the journal is unavailable', () => {
  const { ctx, events } = makeHome({ journalFails: true, fullSaveOutcome: true });
  ctx.submitWorkEditModal();
  assert.equal(events.closed, 1);
  assert.equal(events.alerts.length, 0);
  assert.equal(events.fullSaves, 1);
});

test('Work creation clears inputs only after a confirmed journal write', () => {
  const { ctx, fields, events, state } = makeHome({ fullSaveOutcome: false });
  const originalDate = ctx.Date;
  try {
    // Original test entry is dated today in the fixture; the real function
    // updates it rather than creating a duplicate.
    ctx.saveWorkScore();
    assert.equal(events.alerts.length, 0);
    assert.equal(fields.workScoreInput.value, '');
    assert.equal(fields.workHoursInput.value, '');
    assert.equal(events.journal.length, 1);
    assert.ok(state.completions.some(row => row.title.includes('7.8')));
    assert.equal(events.fullSaves, 0);
  } finally {
    ctx.Date = originalDate;
  }
});

test('Work creation retains typed values if neither journal nor full save confirms persistence', () => {
  const { ctx, fields, events } = makeHome({ journalFails: true, fullSaveOutcome: false });
  ctx.saveWorkScore();
  assert.equal(events.alerts.length, 1);
  assert.equal(fields.workScoreInput.value, '7.8');
  assert.equal(fields.workHoursInput.value, '7.75');
  assert.equal(events.fullSaves, 1);
});

test('Work preflight failure keeps the original Home save path and its failure alert', () => {
  const { ctx, events } = makeHome({ preflightFails: true, fullSaveOutcome: false });
  ctx.submitWorkEditModal();
  assert.equal(events.closed, 0);
  assert.equal(events.alerts.length, 1);
  assert.equal(events.journal.length, 0);
  assert.equal(events.fullSaves, 1);
});


test('real Home exposes its live state and current Work row to the separate fast-path script', () => {
  assert.match(home, /window\.TaskPointsWorkEntryAccess\s*=\s*\{/);
  assert.match(home, /getState:\s*\(\)\s*=>\s*state/);
  assert.match(home, /getEditedRow:\s*\(name\)\s*=>/);
  assert.match(home, /state\.completions\.find\(\(row\)\s*=>\s*row\s*===\s*entry\)/);
});

test('unchanged Work score and hours can still be confirmed by the durable journal', () => {
  const { ctx, fields, events, state } = makeHome({ fullSaveOutcome: false });
  // Match exactly what the real Home Work handler will assign on Save.
  const existing = state.completions[0];
  existing.points = 8.08;
  fields.workEditScoreInput.value = '8';
  fields.workEditHoursInput.value = '8';
  ctx.TaskPointsWorkEntryAccess = {
    getState: () => state,
    getEditedRow: () => state.completions.find(row => row.id === existing.id)
  };
  ctx.submitWorkEditModal();
  assert.equal(events.alerts.length, 0);
  assert.equal(events.closed, 1);
  assert.equal(events.journal.length, 1);
  assert.equal(events.journal[0].completionUpsert.id, existing.id);
  assert.equal(events.fullSaves, 0, 'unchanged Work edits must not trigger a 2-second compressed snapshot save');
});
