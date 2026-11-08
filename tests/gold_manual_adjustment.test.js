const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'gold_manual_adjustment.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'gold_ledger.html'), 'utf8');
const audit = require('../audit_gold_integrity.js');
const clone = value => JSON.parse(JSON.stringify(value));

function seed() {
  return {
    youName: 'You',
    players: [
      { id: 'A', name: 'Alpha', greed: 35, active: true },
      { id: 'B', name: 'Beta', greed: 65, active: false }
    ],
    tasks: [{ id: 'protected-task' }],
    completions: [{ id: 'protected-completion' }],
    matchups: [{ id: 'protected-game' }],
    gameHistory: [{ id: 'protected-history' }],
    seasonHistory: [{ id: 'protected-season' }],
    goldEconomy: {
      version: 1,
      launchDateKey: '2026-11-01',
      launchedAtISO: '2026-11-01T14:00:00.000Z',
      settledMatchupKeys: [],
      ignoredSameDayMatchupKeys: [],
      settledChampionKeys: [],
      ignoredChampionKeys: []
    },
    goldLedger: [
      { id: 'opening-a', type: 'opening_balance', playerId: 'A', amount: 12.3, balanceAfter: 12.3, dateKey: '2026-11-01' },
      { id: 'opening-b', type: 'opening_balance', playerId: 'B', amount: 5, balanceAfter: 5, dateKey: '2026-11-01' },
      { id: 'opening-you', type: 'opening_balance', playerId: 'YOU', amount: 2, balanceAfter: 2, dateKey: '2026-11-01' }
    ]
  };
}

function harness(initial = seed(), opts = {}) {
  const localStorage = {
    values: new Map(),
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) { this.values.set(key, String(value)); },
    removeItem(key) { this.values.delete(key); }
  };
  if (initial !== null) localStorage.setItem('taskpoints_v1', JSON.stringify(initial));
  const calls = { save: 0, load: 0, attempted: null };
  const core = {
    loadAppState() {
      calls.load++;
      const raw = localStorage.getItem('taskpoints_v1');
      if (raw == null) return { state: null };
      return { state: clone(JSON.parse(raw)) };
    },
    saveValidatedSnapshot(candidate, options) {
      calls.save++;
      calls.attempted = { candidate: clone(candidate), options };
      if (opts.failSave) throw new Error('simulated storage error');
      if (opts.blockSave) return { state: candidate, blocked: true };
      if (opts.skipSave) return { state: candidate, skipped: true };
      if (opts.dropManual) {
        localStorage.setItem('taskpoints_v1', JSON.stringify({
          ...candidate, goldLedger: candidate.goldLedger.filter(row => row.type !== 'manual_adjustment')
        }));
        return { state: candidate };
      }
      localStorage.setItem('taskpoints_v1', JSON.stringify(candidate));
      return { state: candidate };
    },
    parseTaskPointsStorageJson: raw => JSON.parse(raw)
  };
  const context = {
    TaskPointsCore: core, localStorage, console: { warn() {}, error() {} },
    crypto: { randomUUID: () => 'test-unique-' + calls.save },
    Date, JSON, Number, Math, Set, Map, String, Error, Array
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'gold_manual_adjustment.js' });
  return { api: context.TaskPointsManualGoldAdjustment, localStorage, calls, core,
    current: () => JSON.parse(localStorage.getItem('taskpoints_v1')) };
}

const request = (mode, amount, playerId = 'A', note = '') => ({ mode, amount, playerId, note });

test('adding Gold appends a verified manual entry and preserves all other data and history', () => {
  const h = harness();
  const before = h.current();
  const input = request('add', '7.7', 'A', 'Admin award');
  const p = h.api.preview(input);
  assert.equal(p.before, 12.3);
  assert.equal(p.after, 20);
  assert.equal(p.delta, 7.7);
  const result = h.api.commit(input, p);
  const after = h.current();
  assert.equal(result.balance, 20);
  assert.equal(h.calls.save, 1);
  assert.equal(h.calls.attempted.options.immediateWrite, true);
  assert.equal(h.calls.attempted.options.savePath, 'gold-manual-adjustment');
  assert.equal(after.goldLedger.length, before.goldLedger.length + 1);
  assert.deepEqual(after.goldLedger.slice(0, before.goldLedger.length), before.goldLedger);
  for (const field of ['tasks', 'completions', 'players', 'matchups', 'gameHistory', 'seasonHistory', 'goldEconomy']) {
    assert.deepEqual(after[field], before[field], field + ' preserved');
  }
  const entry = after.goldLedger.at(-1);
  assert.equal(entry.type, 'manual_adjustment');
  assert.equal(entry.amount, 7.7);
  assert.equal(entry.balanceAfter, 20);
  assert.equal(entry.meta.note, 'Admin award');
  assert.equal(entry.meta.mode, 'add');
  assert.match(entry.id, /^gold:manual:/);
  assert.equal(entry.opponentId, '');
  assert.equal(audit.buildGoldIntegrityChecks(after, {
    getGoldBalance: (state, id) => state.goldLedger.filter(row => row.playerId === id)
      .reduce((sum, row) => sum + row.amount, 0)
  }).find(check => check.id === 'gold-ledger-balance-integrity').status, 'PASS');
});

test('subtract and set operations produce signed deltas, including an inactive NPC and YOU', () => {
  const h = harness();
  let input = request('subtract', '2.2', 'B');
  let result = h.api.commit(input, h.api.preview(input));
  assert.equal(result.balance, 2.8);
  assert.equal(h.current().goldLedger.at(-1).amount, -2.2);
  input = request('set', '50.0', 'A');
  result = h.api.commit(input, h.api.preview(input));
  assert.equal(result.balance, 50);
  assert.equal(h.current().goldLedger.at(-1).amount, 37.7);
  input = request('set', '0', 'YOU', 'Reset my Gold manually');
  result = h.api.commit(input, h.api.preview(input));
  assert.equal(result.balance, 0);
  assert.equal(h.current().goldLedger.at(-1).amount, -2);
  assert.equal(h.current().goldLedger.at(-1).meta.mode, 'set');
});

test('invalid and unsafe requests cannot change Gold or write anything', () => {
  const h = harness();
  const invalid = [
    request('add', '0'), request('subtract', '0'), request('set', '12.3'),
    request('subtract', '12.4'), request('set', '-1'),
    request('add', '-3'), request('add', '0.01'),
    request('add', 'Infinity'), request('add', '1e4'),
    request('add', '1000001'), request('set', '1000001'),
    request('add', '1', 'unknown'), request('mystery', '1'),
    request('add', '1', 'A', 'x'.repeat(201))
  ];
  for (const input of invalid) {
    assert.throws(() => h.api.preview(input), Error, JSON.stringify(input));
  }
  assert.equal(h.calls.save, 0);
  assert.equal(h.current().goldLedger.length, 3);
});

test('Gold edits fail closed if the economy is missing or uninitialized', () => {
  const h = harness({ ...seed(), goldEconomy: undefined });
  assert.throws(() => h.api.preview(request('add', '1')), /not fully initialized/);
  assert.equal(h.calls.save, 0);
});

test('recovery hold disables all Gold edits, including malformed recovery lock', () => {
  const h = harness();
  h.localStorage.setItem('taskpoints_emergency_recovery_hold_v1', JSON.stringify({ active: true }));
  assert.throws(() => h.api.preview(request('add', '1')), /Recovery is active/);
  h.localStorage.setItem('taskpoints_emergency_recovery_hold_v1', '{broken-json');
  assert.throws(() => h.api.preview(request('add', '1')), /Recovery is active/);
  assert.equal(h.calls.save, 0);
});

test('confirmations expire if any authoritative saved byte changed', () => {
  const h = harness();
  const input = request('add', '1');
  const planned = h.api.preview(input);
  const next = h.current();
  next.tasks.push({ id: 'new-task-in-other-tab' });
  h.localStorage.setItem('taskpoints_v1', JSON.stringify(next));
  assert.throws(() => h.api.commit(input, planned), /changed since the confirmation/);
  assert.equal(h.calls.save, 0);
  assert.equal(h.current().goldLedger.length, 3);
});

test('changed amount, note or mode after confirmation is rejected', () => {
  const h = harness();
  const planned = h.api.preview(request('add', '1'));
  assert.throws(() => h.api.commit(request('add', '2'), planned), /changed since confirmation/);
  assert.throws(() => h.api.commit(request('add', '1', 'A', 'new note'), planned), /changed since confirmation/);
  assert.equal(h.calls.save, 0);
});

test('failed, blocked or skipped protected saves never report a successful adjustment', () => {
  for (const flag of ['failSave', 'blockSave', 'skipSave']) {
    const h = harness(seed(), { [flag]: true });
    const original = h.localStorage.getItem('taskpoints_v1');
    const input = request('add', '2');
    assert.throws(() => h.api.commit(input, h.api.preview(input)));
    assert.equal(h.localStorage.getItem('taskpoints_v1'), original);
    assert.equal(h.calls.save, 1);
  }
});

test('readback must include the exact new transaction or commit fails', () => {
  const h = harness(seed(), { dropManual: true });
  const input = request('add', '2');
  assert.throws(() => h.api.commit(input, h.api.preview(input)), /not fully verified/);
});

test('a committed request cannot be replayed from the same stale confirmation', () => {
  const h = harness();
  const input = request('add', '1');
  const planned = h.api.preview(input);
  h.api.commit(input, planned);
  assert.throws(() => h.api.commit(input, planned), /changed since the confirmation/);
  assert.equal(h.calls.save, 1);
});

test('Gold Ledger page exposes all controls and displays manual transactions', () => {
  for (const id of ['goldManualForm', 'goldManualPlayer', 'goldManualMode', 'goldManualAmount',
    'goldManualNote', 'goldManualPreview', 'goldManualStatus', 'goldManualSubmit']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing ' + id);
  }
  assert.match(html, /<option value="manual_adjustment">Manual Adjustment<\/option>/);
  assert.match(html, /gold_manual_adjustment\.js/);
  assert.match(html, /taskpoints:gold-manual-adjusted/);
});
