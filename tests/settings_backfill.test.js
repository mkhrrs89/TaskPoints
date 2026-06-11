const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

global.window = global;
require('../scoring_core.js');
const core = global.TaskPointsCore;

function extractFunction(source, functionName) {
  const signature = `function ${functionName}`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${functionName} not found`);
  const braceStart = source.indexOf('{', start);
  assert.notEqual(braceStart, -1, `${functionName} opening brace not found`);

  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }

  throw new Error(`${functionName} closing brace not found`);
}

function makeSettingsBackfillHarness(initialState) {
  const settingsHtml = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
  const elements = new Map();
  const statusClasses = new Set();
  let state = initialState;
  let nextUuid = 1;

  const getElement = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '',
        textContent: '',
        classList: {
          add: (...names) => names.forEach((name) => statusClasses.add(name)),
          remove: (...names) => names.forEach((name) => statusClasses.delete(name)),
        },
      });
    }
    return elements.get(id);
  };

  const context = {
    window: null,
    TaskPointsCore: {
      sleepPoints: core.sleepPoints,
      workPoints: core.workPoints,
      caloriesToPoints: core.caloriesToPoints,
      moodPoints: core.moodPoints,
      syncDerivedPoints: (nextState) => ({ state: nextState, changed: false }),
      syncYouMatchups: (nextState) => ({ state: nextState, changed: false }),
    },
    crypto: {
      randomUUID: () => `uuid-${nextUuid++}`,
    },
    document: {
      getElementById: getElement,
    },
    parseDateInputValue: (value) => new Date(`${value}T12:00:00.000Z`),
    dateKey: (value) => {
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      return new Date(value).toISOString().slice(0, 10);
    },
    loadSettingsState: () => state,
    saveSettingsState: (nextState) => {
      state = nextState;
      return state;
    },
    setMissingScoreStatus: null,
    readNumberInput: null,
  };
  context.window = context;
  context.setMissingScoreStatus = (message, tone = 'muted') => {
    const status = getElement('missingScoreStatus');
    status.textContent = message || '';
    status.tone = tone;
  };
  context.readNumberInput = (id) => {
    const trimmed = String(getElement(id).value || '').trim();
    if (!trimmed) return null;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : null;
  };

  vm.createContext(context);
  vm.runInContext(
    `${extractFunction(settingsHtml, 'applyMissingScoreEntry')}; this.applyMissingScoreEntry = applyMissingScoreEntry;`,
    context,
    { filename: 'settings.html:applyMissingScoreEntry' }
  );

  return {
    apply: () => context.applyMissingScoreEntry(),
    field: getElement,
    getState: () => state,
  };
}

function setBaseFields(harness, type, dateKey = '2026-06-01') {
  harness.field('missingScoreDate').value = dateKey;
  harness.field('missingScoreType').value = type;
}

test('Settings Flex backfill appends repeat completions for the same flex item and date', () => {
  const flexId = 'flex-2-point';
  const harness = makeSettingsBackfillHarness(core.normalizeState({
    flexActions: [{ id: flexId, name: 'Stretch break', points: 2, retired: false }],
    completions: [],
  }));

  setBaseFields(harness, 'flex');
  harness.field('missingFlexAction').value = flexId;
  harness.apply();

  setBaseFields(harness, 'flex');
  harness.field('missingFlexAction').value = flexId;
  harness.apply();

  const saved = harness.getState();
  const flexCompletions = saved.completions.filter((entry) => entry.source === 'flex' && entry.flexId === flexId);
  assert.equal(flexCompletions.length, 2);
  assert.notEqual(flexCompletions[0].id, flexCompletions[1].id);
  assert.equal(flexCompletions.every((entry) => entry.taskId === null), true);
  assert.equal(flexCompletions.every((entry) => entry.completedAtISO && entry.backfilled === true && entry.backfilledAtISO), true);
  assert.equal(harness.field('missingScoreStatus').textContent, 'Flex completion added for 2026-06-01.');

  const totals = core.computeDayTotals(core.buildDaySnapshot('2026-06-01', saved));
  assert.equal(totals.byCategory.flex, 4);
});

test('Settings daily metric backfill still updates same-date entries instead of duplicating', () => {
  const harness = makeSettingsBackfillHarness(core.normalizeState({ completions: [], flexActions: [] }));

  const scenarios = [
    {
      type: 'sleep',
      prefix: 'Sleep Score',
      first: () => {
        harness.field('missingSleepScore').value = '80';
        harness.field('missingSleepRested').value = '1';
      },
      second: () => {
        harness.field('missingSleepScore').value = '90';
        harness.field('missingSleepRested').value = '2';
      },
      assertUpdated: (entry) => {
        assert.equal(entry.title, 'Sleep Score (90) — Rest 2');
        assert.equal(entry.sleepRested, 2);
      },
    },
    {
      type: 'calories',
      prefix: 'Calories',
      first: () => { harness.field('missingCaloriesValue').value = '1200'; },
      second: () => { harness.field('missingCaloriesValue').value = '1400'; },
      assertUpdated: (entry) => assert.equal(entry.title, 'Calories (1400)'),
    },
    {
      type: 'work',
      prefix: 'Work Score',
      first: () => {
        harness.field('missingWorkScore').value = '5';
        harness.field('missingWorkHours').value = '1';
      },
      second: () => {
        harness.field('missingWorkScore').value = '7';
        harness.field('missingWorkHours').value = '2';
      },
      assertUpdated: (entry) => {
        assert.equal(entry.title, 'Work Score (7) — Hours 2');
        assert.equal(entry.workHours, 2);
      },
    },
    {
      type: 'mood',
      prefix: 'Mood Score',
      first: () => { harness.field('missingMoodScore').value = '4'; },
      second: () => { harness.field('missingMoodScore').value = '8'; },
      assertUpdated: (entry) => assert.equal(entry.title, 'Mood Score (8)'),
    },
  ];

  for (const scenario of scenarios) {
    setBaseFields(harness, scenario.type);
    scenario.first();
    harness.apply();

    setBaseFields(harness, scenario.type);
    scenario.second();
    harness.apply();

    const matches = harness.getState().completions.filter((entry) => entry.title.startsWith(scenario.prefix));
    assert.equal(matches.length, 1, `${scenario.type} should update one entry`);
    scenario.assertUpdated(matches[0]);
    assert.equal(harness.field('missingScoreStatus').textContent, `${scenario.prefix === 'Calories' ? 'Calories' : scenario.prefix === 'Work Score' ? 'Work score' : scenario.prefix === 'Mood Score' ? 'Mood score' : 'Sleep score'} saved for 2026-06-01.`);
  }
});
