const test = require('node:test');
const assert = require('node:assert/strict');
global.window = global;
require('../scoring_core.js');
const core = global.TaskPointsCore;

function fixture() {
  return {
    completions: [{ id: 'c1', points: 1 }, { id: 'c1', points: 2 }],
    matchups: [{ id: 'm1' }], gameHistory: [{ id: 'g1' }], seasonHistory: [{ id: 's1' }],
    tasks: [{ id: 't1' }], habits: [{ id: 'h1' }], players: [{ id: 'p1', imageId: 'player-image' }],
    youImageId: 'profile-image', settings: { sound: true }, futureFlag: { enabled: true }, futureRows: [{ x: 1 }]
  };
}

test('shadow migration layout preserves all known and future top-level fields', () => {
  const state = fixture(); const layout = core.shadowSourceLayout(state);
  assert.deepEqual(layout.arrays.completions, state.completions);
  assert.deepEqual(layout.values.futureFlag, state.futureFlag);
  assert.deepEqual(layout.collections.futureRows, state.futureRows);
  assert.equal(layout.values.settings.sound, true);
});

test('shadow migration deterministic summary detects record changes and preserves duplicate source rows', () => {
  const state = fixture(); const first = core.shadowSourceSummary(state);
  assert.equal(first.counts.completions, 2);
  assert.equal(first.counts.futureRows, 1);
  const changed = structuredClone(state); changed.completions[1].points = 3;
  assert.notEqual(first.hashes.state, core.shadowSourceSummary(changed).hashes.state);
  assert.equal(core.shadowHash({ b: 1, a: 2 }), core.shadowHash({ a: 2, b: 1 }));
});

test('image verification inputs include profile/player references and can report missing images', () => {
  const refs = core.referencedImageIds(fixture());
  assert.deepEqual(refs, ['player-image', 'profile-image']);
  const available = new Set(['profile-image', 'orphan-image']);
  assert.deepEqual(refs.filter(id => !available.has(id)), ['player-image']);
  assert.deepEqual([...available].filter(id => !refs.includes(id)), ['orphan-image']);
});

test('shadow migration helpers do not mutate legacy source state on planning or verification', () => {
  const state = fixture(); const before = JSON.stringify(state);
  core.shadowSourceLayout(state); core.shadowSourceSummary(state); core.referencedImageIds(state);
  assert.equal(JSON.stringify(state), before);
});

test('shadow migration failure falls back without changing the supplied legacy state', async () => {
  const state = fixture(); const before = JSON.stringify(state);
  const result = await core.runShadowMigration({ state, indexedDB: null });
  assert.equal(result.status, 'failed');
  assert.equal(JSON.stringify(state), before);
});

test('restart planning uses deterministic index keys, preventing duplicate retry records', () => {
  const first = core.shadowSourceLayout(fixture()).arrays.completions.map((value, index) => ({ key: index, value }));
  const retry = core.shadowSourceLayout(fixture()).arrays.completions.map((value, index) => ({ key: index, value }));
  assert.deepEqual(retry, first);
  assert.equal(new Set(retry.map(row => row.key)).size, retry.length);
});
