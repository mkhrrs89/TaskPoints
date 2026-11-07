const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('function persistCaloriesEditFast(entry)');
const end = html.indexOf('let sleepEditContext', start);
assert.ok(start >= 0 && end > start, 'Calories fast-save helper and editor must exist');
const editorSource = html.slice(start, end);

function makeEditor({ journal = 'ok', initialEntry = true } = {}) {
  const entry = {
    id: 'calories-1',
    title: 'Calories (2000)',
    calories: 2000,
    points: 4,
    calLogBonusEnabled: true,
    calLogBonusDisabled: false,
    completedAtISO: new Date().toISOString(),
    source: 'metric'
  };
  const state = { completions: initialEntry ? [entry] : [] };
  const calls = { journal: [], saves: 0, renders: 0, writesChecked: 0, warnings: 0 };
  const core = {
    assertTaskMutationJournalWritable() {
      calls.writesChecked++;
      if (journal === 'locked') throw new Error('Recovery lock is active');
    },
    journalTaskMutation(mutation) {
      if (journal === 'failed') throw new Error('Storage write failed');
      calls.journal.push(JSON.parse(JSON.stringify(mutation.completionUpsert)));
    }
  };
  const context = {
    window: { TaskPointsCore: core, TaskPointsPerf: { mark() {} } },
    state,
    Date,
    console: { warn() { calls.warnings++; } },
    getTodayCaloriesEntry() { return entry; },
    openCaloriesEditModal: async () => ({
      calories: '',
      calLogBonusEnabled: false,
      caloriesNotTracked: true
    }),
    caloriesNotTrackedForEntry: (row) => row.caloriesNotTracked === true,
    isCalLogBonusEnabledForEntry: (row) => row.calLogBonusEnabled !== false && row.caloriesNotTracked !== true,
    getCalLogBonusAmount: () => 2,
    caloriesToPoints: (raw) => Math.max(0, (2400 - raw) / 100),
    caloriesTotalImpactPoints: (raw, bonus, skipped) => skipped ? 0 : 4 + (bonus ? 2 : 0),
    dateKey: (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'),
    toastPointsDeltaTodayAware() {},
    markCompletionsDirty() {},
    save() { calls.saves++; return true; },
    scheduleRender() { calls.renders++; },
    renderAll() {},
    alert(message) { throw new Error(message); }
  };
  vm.createContext(context);
  vm.runInContext(editorSource + '\nthis.editCaloriesForTest = editTodayCalories; this.fastSaveForTest = persistCaloriesEditFast;', context);
  return { context, state, entry, calls };
}

test('editing existing calories durably journals the actual updated completion without full-state save', async () => {
  const { context, calls, entry } = makeEditor();
  await context.editCaloriesForTest();
  assert.equal(calls.journal.length, 1);
  assert.equal(calls.saves, 0);
  assert.equal(calls.writesChecked, 1);
  assert.equal(calls.renders, 1);
  assert.equal(calls.journal[0].id, entry.id);
  assert.equal(calls.journal[0].title, 'Calories (Not tracked)');
  assert.equal(calls.journal[0].caloriesNotTracked, true);
  assert.equal(calls.journal[0].points, 0);
  assert.equal(calls.journal[0].calLogBonusEnabled, false);
});

test('when durable journal is locked, existing protected full save remains the fallback', async () => {
  const { context, calls } = makeEditor({ journal: 'locked' });
  await context.editCaloriesForTest();
  assert.equal(calls.journal.length, 0);
  assert.equal(calls.saves, 1);
  assert.equal(calls.renders, 1);
});

test('when journal write fails, no journal success is reported and full save still runs', async () => {
  const { context, calls } = makeEditor({ journal: 'failed' });
  await context.editCaloriesForTest();
  assert.equal(calls.journal.length, 0);
  assert.equal(calls.saves, 1);
  assert.equal(calls.warnings, 1);
});

test('detached row never goes into durable journal', () => {
  const { context, calls, entry } = makeEditor({ initialEntry: false });
  const outcome = context.fastSaveForTest(entry);
  assert.equal(outcome, true);
  assert.equal(calls.journal.length, 0);
  assert.equal(calls.saves, 1);
});

test('every existing calories modal edit entry point uses the same fast-save helper', () => {
  // Four editing routes: Today, recent calorie chip, dashboard, history grid.
  const calls = (html.match(/persistCaloriesEditFast\(/g) || []).length;
  assert.equal(calls, 5, 'one helper declaration plus all four editor callers');
  assert.match(html, /persistCaloriesEditFast\(existing \|\| state\.completions\[0\]\)/);
  // The new-entry form retains its pre-existing independent save and Work fast path.
  assert.match(html, /function saveCalories\(\)\s*\{/);
});
