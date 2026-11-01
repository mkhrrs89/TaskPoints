const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const integrity = require('../audit_integrity.js');

function clone(value) { return structuredClone(value); }

function diff(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = [];
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      out.push({ type: 'changed', key });
    }
  }
  return out;
}

test('lightweight read-only page visit keeps all diagnoses while halving caller-owned clones', () => {
  const state = {
    habits: [{ id: 'h1', doneKeys: ['2026-09-01'] }],
    workHistory: [{ hours: 8 }],
    reminders: [{ id: 'r1' }],
    notes: 'original'
  };
  const original = clone(state);
  const adapters = [
    {
      page: 'mutating.html',
      run(input) {
        input.habits[0].doneKeys.push('2026-09-02');
        return { state: input, mode: 'mutating' };
      }
    },
    {
      page: 'safe.html',
      run(input) { return { state: input, mode: 'safe' }; }
    },
    {
      page: 'display-only.html',
      run(input) {
        const persistedState = clone(input);
        input.notes = 'private display text';
        return { state: input, persistedState, mode: 'display-only' };
      }
    }
  ];

  let legacyClones = 0;
  const oldPath = integrity.evaluateReadOnlyPageVisits(state, adapters, {
    clone(value) { legacyClones++; return clone(value); },
    diff
  });
  let optimizedClones = 0;
  const lightweight = integrity.evaluateReadOnlyPageVisits(state, adapters, {
    clone(value) { optimizedClones++; return clone(value); },
    diff,
    reuseReadOnlyBaseline: true,
    retainFullResults: false
  });

  assert.equal(legacyClones, adapters.length * 2);
  assert.equal(optimizedClones, adapters.length);
  assert.deepEqual(
    lightweight.results.map(row => ({ page: row.adapter.page, diffs: row.diffs })),
    oldPath.results.map(row => ({ page: row.adapter.page, diffs: row.diffs }))
  );
  assert.deepEqual(lightweight.failed.map(row => row.adapter.page), ['mutating.html']);
  assert.deepEqual(state, original, 'underlying state must stay unchanged');
  assert.equal(oldPath.results[0].runResult.state.habits[0].doneKeys.length, 2,
    'default public helper preserves full original results');
  assert.deepEqual(lightweight.results[0].runResult, { mode: 'mutating' },
    'Audit lightweight path retains the mode used by the UI');
});

test('Main Audit explicitly enables the lightweight option while preserving nine adapters', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'audit.html'), 'utf8');
  assert.match(source, /reuseReadOnlyBaseline:\s*true/);
  assert.match(source, /retainFullResults:\s*false/);
  const start = source.indexOf('const AUDIT_PAGE_ADAPTERS = [');
  const end = source.indexOf('];', start);
  assert.ok(start !== -1 && end > start);
  const adapters = source.slice(start, end);
  assert.equal((adapters.match(/\{ id:/g) || []).length, 9);
  for (const page of ['index', 'log', 'settings', 'week', 'gamehub', 'matchups', 'records', 'achievements', 'notes']) {
    assert.match(adapters, new RegExp("id: '" + page + "'"));
  }
});

test('daily Audit adapter isolates its input before applying migrations', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'audit.html'), 'utf8');
  const start = source.indexOf('function adapterDaily(rawInput) {');
  const end = source.indexOf('function adapterWeek(rawInput) {', start);
  assert.ok(start !== -1 && end > start);
  let clones = 0;
  const adapter = new Function(
    'buildDailyLoadShape', 'cloneAuditState', 'applySleepAndWorkMigrations',
    'buildDailyNormalizeShape', 'runSyncDerived',
    source.slice(start, end) + '\nreturn adapterDaily;'
  )(
    input => ({ ...input, completions: input.completions }),
    input => { clones++; return clone(input); },
    input => {
      input.completions[0].points = 9;
      return { state: input, changed: false };
    },
    input => input,
    input => ({ state: input, changed: false })
  );
  const original = { completions: [{ id: 'c1', points: 1 }], notes: 'preserved' };
  const result = adapter(original);
  assert.equal(result.state.completions[0].points, 9);
  assert.equal(result.state.notes, 'preserved');
  assert.equal(original.completions[0].points, 1, 'caller state must not be mutated');
  assert.equal(clones, 2, 'one private input clone plus one isolated result clone');
});
