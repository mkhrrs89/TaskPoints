const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
global.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
require('../scoring_core.js');

const core = global.TaskPointsCore;

test('computeCalLogBonusPoints handles edge cases', () => {
  assert.equal(core.computeCalLogBonusPoints([]), 0);
  assert.equal(core.computeCalLogBonusPoints([{ calories: 0 }]), 0);
  assert.equal(core.computeCalLogBonusPoints([{ calories: 0 }, { calories: '0' }]), 0);
  assert.equal(core.computeCalLogBonusPoints([{ calories: 10 }]), 2);
  assert.equal(core.computeCalLogBonusPoints([{ calories: 0 }, { calories: 10 }]), 2);
  assert.equal(core.computeCalLogBonusPoints([{ calories: NaN }, { calories: 0 }]), 0);
  assert.equal(core.computeCalLogBonusPoints([{ calories: -10 }]), 2);
});

test('aggregateCompletionsByDate adds/removes cal log bonus idempotently', () => {
  const dateIso = '2026-02-01T12:00:00.000Z';
  const entry = {
    id: 'cal-1',
    title: 'Calories (100)',
    completedAtISO: dateIso,
    calories: 100,
    points: 0,
  };

  let rollup = core.aggregateCompletionsByDate([entry], {});
  assert.equal(rollup.dailyTotals['2026-02-01'], 10 + 2);

  const edited = { ...entry, title: 'Calories (0)', calories: 0 };
  rollup = core.aggregateCompletionsByDate([edited], {});
  assert.equal(rollup.dailyTotals['2026-02-01'], 10);
});
