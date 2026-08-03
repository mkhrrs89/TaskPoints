const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'habit_completion_source_guard.js'), 'utf8');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function install(previous) {
  let saved = null;
  const context = {
    console,
    JSON,
    Date,
    Set,
    structuredClone: clone,
    localStorage: { getItem() { return JSON.stringify({ packed: true }); } },
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      readTaskPointsStoredState(key, fallback) {
        return key === 'taskpoints_v1' ? clone(previous) : fallback;
      },
      saveStateSnapshot(state, options) {
        saved = { state: clone(state), options: clone(options || {}) };
        return { state };
      }
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'habit_completion_source_guard.js' });
  return { core: context.TaskPointsCore, getSaved: () => saved };
}

test('new completion normalizes source and restores done status without rewriting history', () => {
  const previous = {
    habits: [
      { id: 'vice-1', category: 'vice', doneKeys: [], failedKeys: ['2026-08-03'], iceKeys: [] },
      { id: 'habit-2', category: 'habit', doneKeys: ['2026-08-01'], failedKeys: [], iceKeys: [] }
    ],
    completions: [
      { id: 'existing', source: 'habit', habitId: 'vice-1', dayKey: '2025-12-07', points: 3 }
    ]
  };
  const { core, getSaved } = install(previous);
  const next = clone(previous);
  next.completions.push({
    id: 'new-row', source: 'habit', viceId: 'vice-1', dayKey: '2026-08-03', points: 3
  });

  core.saveStateSnapshot(next, { savePath: 'habit-toggle' });
  const saved = getSaved().state;

  assert.equal(saved.completions[0].source, 'habit', 'existing historical source is untouched');
  assert.equal(saved.completions[1].source, 'vice');
  assert.equal(saved.completions[1].habitId, 'vice-1');
  assert.deepEqual(Array.from(saved.habits[0].doneKeys), ['2026-08-03']);
  assert.deepEqual(Array.from(saved.habits[0].failedKeys), []);
  assert.deepEqual(saved.habits[1], previous.habits[1], 'unrelated habit is untouched');
});

test('guard does not mass-normalize when more than one row is added', () => {
  const previous = {
    habits: [{ id: 'vice-1', category: 'vice', doneKeys: [], failedKeys: [], iceKeys: [] }],
    completions: []
  };
  const { core, getSaved } = install(previous);
  const next = clone(previous);
  next.completions.push(
    { id: 'a', source: 'habit', habitId: 'vice-1', dayKey: '2026-08-03', points: 3 },
    { id: 'b', source: 'habit', habitId: 'vice-1', dayKey: '2026-08-02', points: 3 }
  );

  core.saveStateSnapshot(next, {});
  const saved = getSaved().state;
  assert.equal(saved.completions[0].source, 'habit');
  assert.deepEqual(saved.habits[0].doneKeys, []);
});
