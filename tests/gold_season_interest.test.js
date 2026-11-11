const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'gold_season_interest.js'), 'utf8');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'settings.html'), 'utf8');
const ledgerPage = fs.readFileSync(path.join(root, 'gold_ledger.html'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function seed() {
  return {
    tasks: [{ id: 'task-keep' }],
    completions: [{ id: 'completion-keep' }],
    habits: [{ id: 'habit-keep' }],
    matchups: [{ id: 'matchup-keep' }],
    gameHistory: [{ id: 'history-keep' }],
    seasonHistory: [{ id: 'season-keep' }],
    players: [
      { id: 'A', name: 'Alpha', active: true },
      { id: 'B', name: 'Retired', active: false },
      { id: 'ZERO', name: 'Zero Gold', active: true }
    ],
    goldEconomy: {
      version: 1, launchedAtISO: '2026-10-01T12:00:00.000Z',
      launchDateKey: '2026-10-01',
      interestRatePercent: 3,
      ignoredSameDayMatchupKeys: [],
      settledMatchupKeys: [],
      ignoredChampionKeys: [],
      settledChampionKeys: []
    },
    goldLedger: [
      { id: 'a', playerId: 'A', type: 'opening_balance', amount: 100, balanceAfter: 100 },
      { id: 'b', playerId: 'B', type: 'opening_balance', amount: 20, balanceAfter: 20 },
      { id: 'you', playerId: 'YOU', type: 'opening_balance', amount: 11.1, balanceAfter: 11.1 },
      { id: 'old', playerId: 'DELETED', type: 'opening_balance', amount: 0.5, balanceAfter: 0.5 }
    ]
  };
}

function harness(initial = seed(), flags = {}, fakeNow = '2027-01-01T08:30:00') {
  const store = new Map();
  if (initial !== null) store.set('taskpoints_v1', JSON.stringify(initial));
  let writes = 0;
  const storage = {
    getItem(key) { return store.get(key) || null; },
    setItem(key, value) { writes++; store.set(String(key), String(value)); },
    removeItem(key) { store.delete(key); },
    get length() { return store.size; },
    key(index) { return Array.from(store.keys())[index] || null; }
  };
  const calls = { save: 0, options: [], load: 0 };
  const core = {
    loadAppState() {
      calls.load++;
      const raw = storage.getItem('taskpoints_v1');
      return { state: raw ? clone(JSON.parse(raw)) : null };
    },
    saveValidatedSnapshot(candidate, options) {
      calls.save++;
      calls.options.push(options);
      if (flags.fail) throw new Error('simulated storage quota');
      if (flags.block) return { blocked: true, state: candidate };
      if (flags.skip) return { skipped: true, state: candidate };
      if (flags.dropInterest) {
        const copy = clone(candidate);
        copy.goldLedger = copy.goldLedger.filter(row => row.type !== 'season_interest');
        storage.setItem('taskpoints_v1', JSON.stringify(copy));
        return { state: copy };
      }
      storage.setItem('taskpoints_v1', JSON.stringify(candidate));
      return { state: candidate };
    },
    parseTaskPointsStorageJson: raw => JSON.parse(raw)
  };
  class FixedDate extends Date {
    constructor(...args) {
      if (!args.length) super(fakeNow);
      else super(...args);
    }
  }
  const context = {
    TaskPointsCore: core, localStorage: storage, Date: FixedDate,
    JSON, Math, Map, Set, Number, String, Error,
    console: { error() {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'gold_season_interest.js' });
  return {
    api: context.TaskPointsGoldSeasonInterest, core, calls, storage,
    now: () => new FixedDate(),
    current: () => JSON.parse(storage.getItem('taskpoints_v1')),
    writes: () => writes
  };
}

test('two-month seasons start exactly Jan/Mar/May/Jul/Sep/Nov 1 from 2027 onward', () => {
  const h = harness();
  const dates = [
    '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01',
    '2027-03-01', '2027-04-01', '2027-05-01', '2027-06-01',
    '2027-07-01', '2027-08-01', '2027-09-01', '2027-10-01',
    '2027-11-01', '2027-12-01', '2028-01-01'
  ];
  for (const date of dates) {
    const due = date >= '2027-01-01' && Number(date.slice(5, 7)) % 2 === 1;
    const value = h.api.seasonStartOn(new Date(date + 'T12:00:00'));
    assert.equal(value, due ? date : null, date);
    assert.equal(h.api.seasonStartOn(new Date(date + 'T12:00:00').getTime() + 86400000), null,
      'the next calendar day never triggers a second season prompt');
  }
  assert.equal(h.api.nextSeasonStart(new Date('2026-11-11T12:00:00')), '2027-01-01');
  assert.equal(h.api.nextSeasonStart(new Date('2027-01-01T12:00:00')), '2027-03-01');
  assert.equal(h.api.nextSeasonStart(new Date('2027-03-15T12:00:00')), '2027-05-01');
  assert.equal(h.api.nextSeasonStart(new Date('2027-12-05T12:00:00')), '2028-01-01');
});

test('3 percent of 100 Gold credits exactly 3 Gold; wallets of YOU, inactive and retired players are included', () => {
  const h = harness();
  const before = h.current();
  const preview = h.api.preview('2027-01-01');
  assert.equal(preview.ratePercent, 3);
  assert.equal(preview.walletCount, 5);
  assert.equal(preview.recipientCount, 4);
  assert.equal(preview.totalInterest, 4);
  const actual = h.api.decide('applied', preview);
  const after = h.current();
  assert.equal(actual.status, 'applied');
  assert.equal(actual.recipientCount, 4);
  assert.equal(after.goldLedger.length, before.goldLedger.length + 4);
  assert.deepEqual(after.goldLedger.slice(0, before.goldLedger.length), before.goldLedger);
  assert.deepEqual(after.goldLedger.filter(row => row.type === 'season_interest')
    .map(row => [row.playerId, row.amount, row.balanceAfter]),
  [
    ['YOU', 0.3, 11.4],
    ['A', 3, 103],
    ['B', 0.6, 20.6],
    ['DELETED', 0.1, 0.6]
  ]);
  for (const field of ['tasks', 'completions', 'habits', 'players',
    'matchups', 'gameHistory', 'seasonHistory']) {
    assert.deepEqual(after[field], before[field], field + ' unchanged');
  }
  assert.deepEqual(after.goldEconomy.seasonInterestDecisions[0], {
    seasonStartDateKey: '2027-01-01', status: 'applied',
    interestRatePercent: 3, recordedAtISO: '2027-01-01T08:30:00.000Z',
    recipientCount: 4, goldAdded: 4
  });
  assert.equal(h.calls.save, 1);
  assert.equal(h.calls.options[0].immediateWrite, true);
  assert.equal(h.calls.options[0].savePath, 'gold-season-interest-applied');
  assert.throws(() => h.api.preview('2027-01-01'), /already been decided/);
  assert.equal(h.calls.save, 1);
});

test('No permanently skips only the current season, without changing Gold', () => {
  const h = harness();
  const before = h.current();
  const result = h.api.decide('skipped', h.api.preview('2027-01-01'));
  assert.equal(result.status, 'skipped');
  assert.equal(result.goldAdded, 0);
  assert.deepEqual(h.current().goldLedger, before.goldLedger);
  assert.equal(h.current().goldEconomy.seasonInterestDecisions[0].status, 'skipped');
  assert.throws(() => h.api.preview('2027-01-01'), /already been decided/);
  const future = harness({ ...h.current() }, {}, '2027-03-01T08:30:00');
  assert.equal(future.api.preview('2027-03-01').totalInterest, 4);
});

test('interest rounds each wallet separately to 0.1 Gold and zero-percent approves without a credit', () => {
  const h = harness({
    ...seed(),
    goldEconomy: { ...seed().goldEconomy, interestRatePercent: 1 },
    goldLedger: [
      { id: 'a', playerId: 'A', amount: 10, balanceAfter: 10 },
      { id: 'b', playerId: 'B', amount: 0.1, balanceAfter: 0.1 }
    ]
  });
  const p = h.api.preview('2027-01-01');
  assert.equal(p.totalInterest, 0.1);
  assert.equal(p.recipientCount, 1);
  h.api.decide('applied', p);
  assert.equal(h.current().goldLedger.at(-1).amount, 0.1);

  const zero = harness({ ...seed(), goldEconomy: { ...seed().goldEconomy, interestRatePercent: 0 } });
  const result = zero.api.decide('applied', zero.api.preview('2027-01-01'));
  assert.equal(result.goldAdded, 0);
  assert.equal(zero.current().goldLedger.length, 4);
  assert.equal(zero.current().goldEconomy.seasonInterestDecisions[0].status, 'applied');
});

test('rate is an explicit persistent setting, defaults to 0%, and validates 0–100 percent', () => {
  const h = harness({ ...seed(), goldEconomy: { ...seed().goldEconomy } });
  delete h.current().goldEconomy.unused;
  assert.equal(h.api.saveRate('3.25').ratePercent, 3.25);
  assert.equal(h.current().goldEconomy.interestRatePercent, 3.25);
  assert.equal(h.calls.options[0].allowGoldInterestRateOverwrite, true);
  assert.equal(h.api.saveRate('3.25').unchanged, true);
  assert.equal(h.calls.save, 1);
  for (const bad of ['-1', '100.01', '1.234', 'NaN', '', '1e1', 'Infinity', '  ', '3%']) {
    assert.throws(() => h.api.saveRate(bad), /rate|Enter/, bad);
  }
  assert.equal(h.calls.save, 1);
  const blank = harness({ ...seed(), goldEconomy: { ...seed().goldEconomy, interestRatePercent: undefined } });
  assert.equal(blank.api.preview('2027-01-01').ratePercent, 0);
});

test('a stale confirmation cannot use old Gold or a changed interest rate', () => {
  const h = harness();
  const p = h.api.preview('2027-01-01');
  const changed = h.current();
  changed.goldLedger.push({ id: 'later', playerId: 'A', amount: 10, balanceAfter: 110 });
  h.storage.setItem('taskpoints_v1', JSON.stringify(changed));
  assert.throws(() => h.api.decide('applied', p), /Gold changed since this offer/);
  assert.equal(h.calls.save, 0);
  assert.equal(h.current().goldLedger.length, 5);
});

test('recovery hold, missing, corrupt or inconsistent ledgers fail without applying interest', () => {
  const h = harness();
  h.storage.setItem('taskpoints_emergency_recovery_hold_v1', JSON.stringify({ active: true }));
  assert.throws(() => h.api.preview('2027-01-01'), /Emergency Recovery/);
  assert.equal(h.calls.save, 0);

  const missing = harness(null);
  assert.throws(() => missing.api.preview('2027-01-01'), /No authoritative/);

  const invalid = harness({
    ...seed(), goldLedger: [{ id: 'bad', playerId: 'A', amount: -1, balanceAfter: -1 }]
  });
  assert.throws(() => invalid.api.preview('2027-01-01'), /invalid balance/);

  const damaged = harness({
    ...seed(), goldLedger: [{ id: 'bad', playerId: 'A', amount: 'garbage' }]
  });
  assert.throws(() => damaged.api.preview('2027-01-01'), /invalid transaction/);
});

test('quota failure, blocked save, or omitted credit never reports successful interest', () => {
  for (const flag of ['fail', 'block', 'skip', 'dropInterest']) {
    const h = harness(seed(), { [flag]: true });
    const original = h.storage.getItem('taskpoints_v1');
    assert.throws(() => h.api.decide('applied', h.api.preview('2027-01-01')));
    assert.equal(h.calls.save, 1);
    if (flag !== 'dropInterest') assert.equal(h.storage.getItem('taskpoints_v1'), original);
  }
});

test('a second session, two decisions, and duplicate deterministic IDs never generate double interest', () => {
  const h = harness();
  h.api.decide('applied', h.api.preview('2027-01-01'));
  const restored = harness(h.current());
  assert.throws(() => restored.api.preview('2027-01-01'), /already been decided/);
  const i = restored.current().goldLedger.find(row => row.type === 'season_interest');
  assert.equal(restored.api.interestId('2027-01-01', i.playerId), i.id);
  assert.equal(restored.calls.save, 0);
});

test('Settings and Gold Ledger include seasonal settings and interest transaction details', () => {
  for (const id of ['goldInterestSettingsSection', 'goldInterestRateForm', 'goldInterestRateInput',
    'goldInterestRateSaveBtn', 'goldInterestNextSeasonDate', 'goldInterestRateStatus']) {
    assert.ok(settings.includes('id="' + id + '"'), id);
  }
  assert.ok(settings.includes('gold_season_interest.js'));
  assert.ok(home.includes('gold_season_interest.js'));
  assert.ok(home.includes('TaskPointsGoldSeasonInterest.ensureSeasonDecision()'));
  assert.ok(home.includes('const outcome = await window.TaskPointsGoldSeasonInterest.ensureSeasonDecision()'));
  assert.ok(home.indexOf('ensureSeasonDecision()') < home.indexOf('const generated = maybeAutoSimToday();'));
  assert.ok(ledgerPage.includes('<option value="season_interest">Season Interest</option>'));
  assert.ok(ledgerPage.includes("season_interest: 'Season Interest'"));
  assert.ok(ledgerPage.includes("if (row.type === 'season_interest')"));
});
