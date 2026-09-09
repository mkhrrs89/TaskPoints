const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'gold_theft_top50_notifications.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');

function loadApi() {
  const context = {
    window: null,
    globalThis: null,
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    JSON,
    module: { exports: {} },
    setTimeout() { return 1; },
    clearTimeout() {},
    addEventListener() {}
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'gold_theft_top50_notifications.js' });
  return context.module.exports;
}

function theft({ id, playerId = 'p1', opponentId = 'p2', dateKey = '2026-09-08', amount = 12.3, positive = true } = {}) {
  const signedAmount = positive ? Math.abs(amount) : -Math.abs(amount);
  return {
    id: id || `theft-${playerId}-${opponentId}-${dateKey}-${signedAmount}`,
    transferId: `transfer-${id || playerId}`,
    type: 'matchup_theft',
    playerId,
    opponentId,
    matchupId: `match-${id || playerId}`,
    dateKey,
    createdAtISO: `${dateKey}T12:00:00.000Z`,
    amount: signedAmount,
    meta: { direction: positive ? 'stolen' : 'lost' }
  };
}

function baseState(overrides = {}) {
  return {
    youName: 'Mike',
    players: [
      { id: 'p1', name: 'Alex Stone' },
      { id: 'p2', name: 'Jordan Vale' },
      { id: 'p3', name: 'Casey North' }
    ],
    goldLedger: [],
    inboxMessages: [],
    inboxProcessedEventIds: {},
    goldTheftTop50InboxStartedDateKey: '2026-09-08',
    ...overrides
  };
}

function afterRollover() {
  return new Date(2026, 8, 9, 6, 0, 0);
}

function beforeRollover() {
  return new Date(2026, 8, 9, 4, 0, 0);
}

test('a newly revealed positive theft ranked in the all-time Top 50 creates a record inbox message', () => {
  const api = loadApi();
  const state = baseState({ goldLedger: [theft({ id: 'gold-1', amount: 18.4 })] });
  const result = api.reconcileState(state, { now: afterRollover() });

  assert.equal(result.changed, true);
  assert.equal(result.addedMessages.length, 1);
  const message = result.addedMessages[0];
  assert.equal(message.type, 'record');
  assert.equal(message.eventDateKey, '2026-09-08');
  assert.equal(message.title, 'Top-50 Gold Theft');
  assert.equal(message.rank, 1);
  assert.equal(message.goldAmount, 18.4);
  assert.equal(message.relatedPage, 'records.html');
  assert.match(message.body, /Alex Stone stole 18\.4 Gold from Jordan Vale/);
  assert.match(message.body, /1st-largest single-game Gold theft ever/);
  assert.equal(result.state.inboxProcessedEventIds['gold-theft-top50:gold-1'], true);
});

test('the loser-side negative ledger row is ignored and never creates a theft record notification', () => {
  const api = loadApi();
  const result = api.reconcileState(baseState({
    goldLedger: [theft({ id: 'loss-1', amount: 18.4, positive: false })]
  }), { now: afterRollover() });

  assert.equal(result.addedMessages.length, 0);
  assert.equal(result.state.inboxMessages.length, 0);
  assert.equal(result.state.inboxProcessedEventIds['gold-theft-top50:loss-1'], undefined);
});

test('a newly revealed theft ranked 51st is processed but does not create an inbox message', () => {
  const api = loadApi();
  const olderTop50 = Array.from({ length: 50 }, (_, index) => theft({
    id: `old-${index + 1}`,
    playerId: index % 2 ? 'p1' : 'p3',
    opponentId: 'p2',
    dateKey: '2026-08-20',
    amount: 100 - index
  }));
  const candidate = theft({ id: 'rank-51', amount: 1, dateKey: '2026-09-08' });
  const result = api.reconcileState(baseState({ goldLedger: [...olderTop50, candidate] }), { now: afterRollover() });

  assert.equal(api.buildRows(result.state).findIndex((row) => row.identity === 'rank-51') + 1, 51);
  assert.equal(result.addedMessages.length, 0);
  assert.equal(result.state.inboxProcessedEventIds['gold-theft-top50:rank-51'], true);
});

test('the same theft cannot create a duplicate notification on later inbox population', () => {
  const api = loadApi();
  const state = baseState({ goldLedger: [theft({ id: 'gold-once', amount: 14.2 })] });
  const first = api.reconcileState(state, { now: afterRollover() });
  const second = api.reconcileState(first.state, { now: new Date(2026, 8, 9, 7, 0, 0) });

  assert.equal(first.addedMessages.length, 1);
  assert.equal(second.addedMessages.length, 0);
  assert.equal(second.state.inboxMessages.length, 1);
});

test('two distinct Top-50 thefts by the same player on the same day each create their own notification', () => {
  const api = loadApi();
  const state = baseState({
    goldLedger: [
      theft({ id: 'double-1', amount: 21.1 }),
      theft({ id: 'double-2', amount: 17.7 })
    ]
  });
  const result = api.reconcileState(state, { now: afterRollover() });

  assert.equal(result.addedMessages.length, 2);
  assert.deepEqual(
    Array.from(result.addedMessages, (message) => message.rank).sort((a, b) => a - b),
    [1, 2]
  );
  assert.equal(new Set(Array.from(result.addedMessages, (message) => message.id)).size, 2);
});

test('yesterday thefts wait until the same 5 AM reveal rollover used by the existing inbox records', () => {
  const api = loadApi();
  const state = baseState({ goldLedger: [theft({ id: 'rollover-1', amount: 19.5 })] });

  const early = api.reconcileState(state, { now: beforeRollover() });
  assert.equal(early.addedMessages.length, 0);
  assert.equal(early.state.inboxProcessedEventIds['gold-theft-top50:rollover-1'], undefined);

  const revealed = api.reconcileState(early.state, { now: afterRollover() });
  assert.equal(revealed.addedMessages.length, 1);
});

test('first install establishes a Gold-Theft-specific rollout boundary instead of backfilling old record history', () => {
  const api = loadApi();
  const state = baseState({
    goldTheftTop50InboxStartedDateKey: undefined,
    goldLedger: [
      theft({ id: 'old-history', dateKey: '2026-08-15', amount: 30 }),
      theft({ id: 'current-reveal', dateKey: '2026-09-08', amount: 20 })
    ]
  });
  const result = api.reconcileState(state, { now: afterRollover() });

  assert.equal(result.state.goldTheftTop50InboxStartedDateKey, '2026-09-08');
  assert.equal(result.addedMessages.length, 1);
  assert.equal(result.addedMessages[0].id, 'gold-theft-top50:current-reveal');
  assert.equal(result.state.inboxProcessedEventIds['gold-theft-top50:old-history'], undefined);
});

test('Gold Theft notifications are bundled after the Greed Gold economy source', () => {
  const greedAsset = workerSource.indexOf("'/greed_gold_economy.js'");
  const alertAsset = workerSource.indexOf("'/gold_theft_top50_notifications.js'");
  assert.ok(greedAsset >= 0 && alertAsset > greedAsset);
  assert.match(workerSource, /goldTheftTop50Source/);
  assert.match(workerSource, /x-taskpoints-gold-theft-top50-notifications/);
});
