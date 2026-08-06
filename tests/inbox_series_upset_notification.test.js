const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'season_series_upset_notifications.js'), 'utf8');

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
  vm.runInNewContext(source, context, { filename: 'season_series_upset_notifications.js' });
  return context.module.exports;
}

function completedSeries(overrides = {}) {
  const playerAId = overrides.playerAId || 'favorite';
  const playerBId = overrides.playerBId || 'underdog';
  const winners = overrides.winners || [playerBId, playerAId, playerBId, playerBId];
  const gameResults = winners.map((winnerId, index) => ({
    gameNumber: index + 1,
    dateKey: `2026-08-0${index + 4}`,
    winnerId
  }));
  const winsA = winners.filter((id) => id === playerAId).length;
  const winsB = winners.filter((id) => id === playerBId).length;
  return {
    id: 'round_of_32_3',
    roundId: 'round_of_32',
    roundName: 'Round of 32',
    name: 'Match 3',
    seriesIndex: 2,
    playerAId,
    playerAName: 'Favorite Player',
    playerASeed: 5,
    playerBId,
    playerBName: 'Underdog Player',
    playerBSeed: 21,
    bestOf: 5,
    winsNeeded: 3,
    winsA,
    winsB,
    winnerId: winsB >= 3 ? playerBId : playerAId,
    loserId: winsB >= 3 ? playerAId : playerBId,
    status: 'complete',
    gameResults,
    ...overrides
  };
}

function baseState(series, overrides = {}) {
  return {
    youName: 'You',
    players: [
      { id: 'favorite', name: 'Favorite Player' },
      { id: 'underdog', name: 'Underdog Player' }
    ],
    currentSeason: {
      id: 'season_2_august_2026',
      series: { [series.id]: series }
    },
    inboxStartedDateKey: '2026-08-01',
    inboxMessages: [],
    inboxProcessedEventIds: {},
    ...overrides
  };
}

test('a lower-seeded series winner creates an inbox upset notification on the clinch date', () => {
  const api = loadApi();
  const series = completedSeries();
  const result = api.reconcileState(baseState(series), { now: new Date('2026-08-08T06:00:00-04:00') });

  assert.equal(result.changed, true);
  assert.equal(result.addedMessages.length, 1);
  const message = result.addedMessages[0];
  assert.equal(message.type, 'series_upset');
  assert.equal(message.eventDateKey, '2026-08-07');
  assert.equal(message.title, 'Round of 32 upset');
  assert.equal(
    message.body,
    'Round of 32 — Match 3: #21 Underdog Player upset #5 Favorite Player, winning the series 3–1.'
  );
  assert.equal(message.relatedPage, 'season.html');
  assert.equal(message.winnerSeed, 21);
  assert.equal(message.loserSeed, 5);
  assert.equal(
    result.state.inboxProcessedEventIds['season-series-seed-upset:season_2_august_2026:round_of_32_3'],
    true
  );
});

test('the same completed series cannot create a duplicate notification', () => {
  const api = loadApi();
  const series = completedSeries();
  const first = api.reconcileState(baseState(series), { now: new Date('2026-08-08T06:00:00-04:00') });
  const second = api.reconcileState(first.state, { now: new Date('2026-08-08T06:01:00-04:00') });

  assert.equal(second.addedMessages.length, 0);
  assert.equal(second.state.inboxMessages.length, 1);
});

test('a higher seed winning its series is processed without an upset notification', () => {
  const api = loadApi();
  const series = completedSeries({
    winners: ['favorite', 'underdog', 'favorite', 'favorite'],
    winsA: 3,
    winsB: 1,
    winnerId: 'favorite',
    loserId: 'underdog'
  });
  const result = api.reconcileState(baseState(series), { now: new Date('2026-08-08T06:00:00-04:00') });

  assert.equal(result.addedMessages.length, 0);
  assert.equal(result.state.inboxMessages.length, 0);
  assert.equal(
    result.state.inboxProcessedEventIds['season-series-seed-upset:season_2_august_2026:round_of_32_3'],
    true
  );
});

test('the alert waits until the clinching result is revealed after the inbox rollover', () => {
  const api = loadApi();
  const series = completedSeries();
  const result = api.reconcileState(baseState(series), { now: new Date('2026-08-07T23:00:00-04:00') });

  assert.equal(result.addedMessages.length, 0);
  assert.equal(result.state.inboxMessages.length, 0);
  assert.equal(
    result.state.inboxProcessedEventIds['season-series-seed-upset:season_2_august_2026:round_of_32_3'],
    undefined
  );
});

test('an older OVR-based series alert is upgraded instead of duplicated', () => {
  const api = loadApi();
  const series = completedSeries();
  const legacyId = 'series-upset:season_2_august_2026:round_of_32_3';
  const state = baseState(series, {
    inboxMessages: [{
      id: legacyId,
      type: 'series_upset',
      title: 'Tournament-series upset',
      body: 'Old OVR-based copy',
      eventDateKey: '2026-08-07',
      relatedPage: 'tournament.html',
      read: true,
      archived: false,
      createdAtISO: '2026-08-08T10:00:00.000Z'
    }]
  });
  const result = api.reconcileState(state, { now: new Date('2026-08-08T06:00:00-04:00') });

  assert.equal(result.addedMessages.length, 0);
  assert.equal(result.updatedMessages.length, 1);
  assert.equal(result.state.inboxMessages.length, 1);
  assert.equal(result.state.inboxMessages[0].id, legacyId);
  assert.equal(result.state.inboxMessages[0].read, true);
  assert.equal(result.state.inboxMessages[0].relatedPage, 'season.html');
  assert.match(result.state.inboxMessages[0].body, /#21 Underdog Player upset #5 Favorite Player/);
});
