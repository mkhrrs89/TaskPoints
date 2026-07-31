const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.TaskPointsCore = { STORAGE_KEY: 'taskpoints_v1' };
const repair = require('../game_history_reconciliation_repair.js');

const VERRICK = '358b982e-c494-4c58-815a-d59953742997';
const SLOANE = '05354bdf-f433-4824-981f-45f0d21b0d80';
const INARA = '250ec440-6a9b-40dc-a456-07aeee77ebab';
const RICK = '3228e55f-1111-4222-8333-444455556666';

function player(id, name) {
  return { id, name, active: true, baseline: 40 };
}

function matchup({
  id,
  dateKey,
  playerAId,
  playerBId = 'YOU',
  scoreA,
  scoreB = 50,
  extra = {}
}) {
  return {
    id,
    matchupId: id,
    date: dateKey,
    dateKey,
    playerAId,
    playerBId,
    scoreA,
    scoreB,
    playerAScore: scoreA,
    playerBScore: scoreB,
    completedAtISO: `${dateKey}T23:59:00.000Z`,
    ...extra
  };
}

function history({
  id,
  dateKey,
  playerId,
  score,
  matchupId = '',
  opponentId = ''
}) {
  return {
    ...(id ? { id } : {}),
    date: dateKey,
    dateKey,
    playerId,
    score,
    opponentId,
    ...(matchupId ? { matchupId } : {})
  };
}

function fixture() {
  return {
    youName: 'Miggy',
    players: [
      player(VERRICK, 'Verrick'),
      player(SLOANE, 'Sloane'),
      player(INARA, 'Inara'),
      player(RICK, 'Rick')
    ],
    matchups: [
      matchup({
        id: 'verrick-game',
        dateKey: '2026-06-14',
        playerAId: VERRICK,
        scoreA: 43.2,
        scoreB: 64.85,
        extra: {
          seasonId: 'season_1_june_2026',
          seriesId: 'season_1_june_2026_quarterfinals_3',
          roundId: 'quarterfinals',
          gameNumber: 1,
          matchupType: 'tournament'
        }
      }),
      matchup({
        id: 'sloane-game',
        dateKey: '2026-06-24',
        playerAId: SLOANE,
        scoreA: 27.56,
        scoreB: 52.4,
        extra: {
          seasonId: 'season_1_june_2026',
          seriesId: 'season_1_june_2026_finals_1',
          roundId: 'finals',
          gameNumber: 1,
          matchupType: 'tournament'
        }
      }),
      matchup({
        id: 'inara-first',
        dateKey: '2026-06-09',
        playerAId: INARA,
        scoreA: 14.5,
        scoreB: 38.7
      }),
      matchup({
        id: 'inara-second',
        dateKey: '2026-06-09',
        playerAId: INARA,
        scoreA: 45,
        scoreB: 55,
        extra: {
          seasonId: 'season_1_june_2026',
          seriesId: 'season_1_june_2026_sweet_16_4',
          roundId: 'sweet_16',
          gameNumber: 1,
          matchupType: 'tournament'
        }
      }),
      matchup({
        id: 'rick-game',
        dateKey: '2026-04-24',
        playerAId: RICK,
        scoreA: 64.9,
        scoreB: 42.1
      })
    ],
    gameHistory: [
      history({
        id: 'verrick-history',
        dateKey: '2026-06-14',
        playerId: VERRICK,
        score: 62.8
      }),
      history({
        dateKey: '2026-06-24',
        playerId: SLOANE,
        score: 41
      }),
      history({
        id: 'inara-history',
        dateKey: '2026-06-09',
        playerId: INARA,
        score: 45
      }),
      ...Array.from({ length: 25 }, (_, index) => history({
        id: `orphan-${index}`,
        dateKey: `2026-03-${String((index % 25) + 1).padStart(2, '0')}`,
        playerId: RICK,
        score: 30 + index / 10
      }))
    ],
    currentSeason: { id: 'season_2_august_2026', status: 'preview' },
    goldLedger: [{ id: 'gold-safe' }],
    reminders: [{ id: 'reminder-safe' }]
  };
}

test('preview confirms only the two approved stale scores and confidently missing rows', () => {
  const plan = repair.buildGameHistoryRepairPlan(fixture());

  assert.deepEqual(
    plan.confirmedScoreUpdates.map((item) => [item.playerName, item.storedScore, item.matchupScore]),
    [
      ['Verrick', 62.8, 43.2],
      ['Sloane', 41, 27.56]
    ]
  );
  assert.deepEqual(
    plan.missingRows.map((item) => [item.playerName, item.score]),
    [
      ['Rick', 64.9],
      ['Inara', 14.5]
    ]
  );
  assert.equal(plan.uncertain.length, 0);
  assert.equal(plan.orphanCount, 25);
});

test('apply changes gameHistory only and is idempotent', () => {
  const state = fixture();
  const before = structuredClone(state);
  const plan = repair.buildGameHistoryRepairPlan(state);
  const result = repair.applyGameHistoryRepair(state, plan);

  assert.equal(result.updatedScores, 2);
  assert.equal(result.createdRows, 2);
  assert.equal(result.skippedStale, 0);
  assert.equal(result.remainingPlan.confirmedScoreUpdates.length, 0);
  assert.equal(result.remainingPlan.missingRows.length, 0);
  assert.equal(result.remainingPlan.uncertain.length, 0);
  assert.equal(result.remainingPlan.orphanCount, 25);

  assert.deepEqual(result.state.matchups, before.matchups);
  assert.deepEqual(result.state.currentSeason, before.currentSeason);
  assert.deepEqual(result.state.goldLedger, before.goldLedger);
  assert.deepEqual(result.state.reminders, before.reminders);
  assert.deepEqual(state, before);

  const verrick = result.state.gameHistory.find((row) => row.id === 'verrick-history');
  const sloane = result.state.gameHistory.find((row) => row.playerId === SLOANE);
  assert.equal(verrick.score, 43.2);
  assert.equal(sloane.score, 27.56);

  const second = repair.applyGameHistoryRepair(result.state);
  assert.equal(second.changed, false);
  assert.equal(second.updatedScores, 0);
  assert.equal(second.createdRows, 0);
});

test('unapproved score mismatch is manual review and cannot become a confirmed update', () => {
  const otherId = 'other-player';
  const state = {
    players: [player(otherId, 'Other')],
    matchups: [matchup({
      id: 'other-game',
      dateKey: '2026-06-20',
      playerAId: otherId,
      scoreA: 20
    })],
    gameHistory: [history({
      id: 'other-history',
      dateKey: '2026-06-20',
      playerId: otherId,
      score: 30
    })]
  };

  const plan = repair.buildGameHistoryRepairPlan(state);
  assert.equal(plan.confirmedScoreUpdates.length, 0);
  assert.equal(plan.missingRows.length, 0);
  assert.equal(plan.uncertain.length, 1);
  assert.equal(plan.uncertain[0].type, 'unconfirmed-score-mismatch');
});

test('same-day explicit ID conflicts are never overridden by score matching', () => {
  const state = {
    players: [player(INARA, 'Inara')],
    matchups: [
      matchup({ id: 'm1', dateKey: '2026-06-09', playerAId: INARA, scoreA: 14.5 }),
      matchup({ id: 'm2', dateKey: '2026-06-09', playerAId: INARA, scoreA: 45 })
    ],
    gameHistory: [
      history({ id: 'h1', matchupId: 'wrong-1', dateKey: '2026-06-09', playerId: INARA, score: 14.5 }),
      history({ id: 'h2', matchupId: 'wrong-2', dateKey: '2026-06-09', playerId: INARA, score: 45 })
    ]
  };

  const plan = repair.buildGameHistoryRepairPlan(state);
  assert.equal(plan.confirmedScoreUpdates.length, 0);
  assert.equal(plan.missingRows.length, 0);
  assert.ok(plan.uncertain.some((item) => item.type === 'explicit-id-conflict'));
});

test('panel requires preview and fresh backup confirmation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'game_history_reconciliation_repair.js'), 'utf8');
  assert.match(source, /Preview Game-History Repair/);
  assert.match(source, /I exported a fresh full backup of the current phone data/);
  assert.match(source, /audit-game-history-reconciliation-repair/);
  assert.match(source, /freshPlan\.uncertain\.length/);
  assert.match(source, /planFingerprint\(freshPlan\) !== previewFingerprint/);
  assert.doesNotMatch(source, /splice\(|filter\([^)]*orphan|delete\s+.*gameHistory/);
});

test('Audit worker loads repair directly and in the audit integrity bundle', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
  assert.match(worker, /game_history_reconciliation_repair\.js\?v=20260731-1/);
  assert.match(worker, /readAssetSource\(env, request, '\/game_history_reconciliation_repair\.js'\)/);
  assert.match(worker, /\[sameDaySource, historyRepairSource, aliasSource, bootstrapSource\]/);
  assert.match(worker, /x-taskpoints-game-history-repair/);
});
