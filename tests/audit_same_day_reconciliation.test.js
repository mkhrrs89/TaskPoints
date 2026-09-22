const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const fix = require('../audit_same_day_reconciliation.js');

const options = {
  todayKey: '2026-07-31',
  dateKey: value => String(value).slice(0, 10),
  detailLimit: 100
};

const playerId = 'inara';
const stateBase = () => ({
  players: [{ id: playerId, name: 'Inara' }],
  matchups: [],
  gameHistory: []
});

function matchup(id, score, overrides = {}) {
  return {
    id,
    dateKey: '2026-06-09',
    playerAId: playerId,
    playerBId: 'YOU',
    scoreA: score,
    scoreB: 40,
    playerAScore: score,
    playerBScore: 40,
    completedAtISO: '2026-06-09T23:59:00Z',
    ...overrides
  };
}

function history(id, score, overrides = {}) {
  return {
    id,
    dateKey: '2026-06-09',
    playerId,
    score,
    ...overrides
  };
}

test('same-day score row is assigned to its unique matchup instead of the first matchup', () => {
  const state = stateBase();
  state.matchups = [
    matchup('inara-brett', 14.5),
    matchup('seraphine-inara', 45, {
      playerAId: 'YOU',
      playerBId: playerId,
      scoreA: 55,
      scoreB: 45,
      playerAScore: 55,
      playerBScore: 45,
      seasonId: 'season_1_june_2026',
      seriesId: 'season_1_june_2026_sweet_16_4',
      roundId: 'sweet_16',
      gameNumber: 1,
      matchupType: 'tournament'
    })
  ];
  state.gameHistory = [history('inara-history', 45)];

  const result = fix.buildMatchupHistoryReconciliationAudit(state, options);
  const details = result.details.join(' ');

  assert.equal(result.actual, '1 failure(s), 0 warning(s)');
  assert.match(details, /Matchup inara-brett side A .* has no matching gameHistory row/);
  assert.doesNotMatch(details, /matchup score 14\.5 differs from history score 45/);
  assert.doesNotMatch(details, /seraphine-inara.*no matching gameHistory row/);
});

test('two same-day rows reconcile by unique scores regardless of matchup order', () => {
  const state = stateBase();
  state.matchups = [
    matchup('second', 45),
    matchup('first', 14.5)
  ];
  state.gameHistory = [
    history('history-first', 14.5),
    history('history-second', 45)
  ];

  const result = fix.buildMatchupHistoryReconciliationAudit(state, options);
  assert.equal(result.status, 'PASS');
});

test('repaired same-day tournament history stays paired while the legacy row matches the other game', () => {
  const state = stateBase();
  state.matchups = [
    matchup('2026-06-09_regular_game', 56.4),
    matchup('season_1_sweet_16_game', 45, {
      seasonId: 'season_1_june_2026',
      seriesId: 'season_1_june_2026_sweet_16_1',
      roundId: 'sweet_16',
      gameNumber: 1,
      matchupType: 'tournament'
    })
  ];
  state.gameHistory = [
    history('legacy-row', 56.4),
    history('repaired-row', 45, {
      matchupId: 'season_1_sweet_16_game',
      opponentId: 'YOU',
      seasonId: 'season_1_june_2026',
      seriesId: 'season_1_june_2026_sweet_16_1',
      seasonSeriesId: 'season_1_june_2026_sweet_16_1',
      roundId: 'sweet_16',
      gameNumber: 1,
      seriesGameNumber: 1,
      matchupType: 'tournament',
      source: 'audit-game-history-repair'
    })
  ];

  const result = fix.buildMatchupHistoryReconciliationAudit(state, options);
  assert.equal(result.status, 'PASS');
  assert.doesNotMatch(result.details.join(' '), /conflicting explicit matchup IDs/);
});

test('same-day duplicate scores remain ambiguous instead of being greedily paired', () => {
  const state = stateBase();
  state.matchups = [
    matchup('', 30, { matchupId: '' }),
    matchup('', 30, { matchupId: '' })
  ];
  state.gameHistory = [
    history('history-one', 30),
    history('history-two', 30)
  ];

  const result = fix.buildMatchupHistoryReconciliationAudit(state, options);
  assert.equal(result.status, 'WARN');
  assert.match(result.details.join(' '), /Ambiguous historical matchup\/history reconciliation/);
});

test('single genuine score mismatch still fails', () => {
  const state = stateBase();
  state.matchups = [matchup('verrick-game', 43.2)];
  state.gameHistory = [history('verrick-history', 62.8)];

  const result = fix.buildMatchupHistoryReconciliationAudit(state, options);
  assert.equal(result.status, 'FAIL');
  assert.match(result.details.join(' '), /matchup score 43\.2 differs from history score 62\.8/);
});

test('explicit mismatched IDs cannot be overridden by unique score matches', () => {
  const state = stateBase();
  state.matchups = [matchup('m1', 10), matchup('m2', 30)];
  state.gameHistory = [
    history('history-one', 10, { matchupId: 'unrelated-x' }),
    history('history-two', 30, { matchupId: 'unrelated-y' })
  ];

  const result = fix.buildMatchupHistoryReconciliationAudit(state, options);
  assert.equal(result.status, 'FAIL');
  assert.match(result.details.join(' '), /conflicting explicit matchup IDs/);
});


test('reviewed legacy-only orphan passes while remaining visible as informational evidence', () => {
  const state = {
    players: [],
    matchups: [],
    gameHistory: [{
      id: '1455656d-4aff-4571-acce-37133586187d',
      dateKey: '2026-04-24',
      playerId: '8f91402d-9649-46c1-b006-294ddcd595db',
      score: 64.9
    }]
  };

  const result = fix.buildMatchupHistoryReconciliationAudit(state, options);
  assert.equal(fix.REVIEWED_LEGACY_HISTORY.length, 25);
  assert.equal(result.status, 'PASS');
  assert.match(result.actual, /1 reviewed legacy-only history row\(s\) preserved/);
  assert.match(result.details.join(' '), /INFO — Reviewed legacy-only: 2026-04-24/);
  assert.match(result.details.join(' '), /1455656d-4aff-4571-acce-37133586187d/);
  assert.equal(result.reviewedLegacyHistory.length, 1);
  assert.equal(result.reviewedLegacyHistory[0].historyId, '1455656d-4aff-4571-acce-37133586187d');
});

test('reviewed legacy suppression fails closed when reviewed identity or safety conditions change', () => {
  const base = {
    id: '1455656d-4aff-4571-acce-37133586187d',
    dateKey: '2026-04-24',
    playerId: '8f91402d-9649-46c1-b006-294ddcd595db',
    score: 64.9
  };
  const cases = [
    { name: 'score changed', rows: [{ ...base, score: 65.9 }] },
    { name: 'explicit matchup link appeared', rows: [{ ...base, matchupId: 'unexpected-matchup' }] },
    { name: 'same-player same-day duplicate appeared', rows: [base, { ...base, id: 'new-duplicate' }] }
  ];

  cases.forEach(({ name, rows }) => {
    const result = fix.buildMatchupHistoryReconciliationAudit({
      players: [],
      matchups: [],
      gameHistory: rows
    }, options);
    assert.equal(result.status, 'WARN', name);
    assert.match(result.details.join(' '), /legacy gameHistory rows have no corresponding finalized matchup/, name);
    assert.equal(result.reviewedLegacyHistory.length, 0, name);
  });
});

test('unreviewed orphan continues to warn', () => {
  const result = fix.buildMatchupHistoryReconciliationAudit({
    players: [],
    matchups: [],
    gameHistory: [{
      id: 'brand-new-orphan',
      dateKey: '2026-04-24',
      playerId: 'new-player',
      score: 64.9
    }]
  }, options);

  assert.equal(result.status, 'WARN');
  assert.match(result.details.join(' '), /1 legacy gameHistory rows have no corresponding finalized matchup/);
  assert.equal(result.reviewedLegacyHistory.length, 0);
});

test('same-day reconciliation is read-only', () => {
  const state = stateBase();
  state.matchups = [matchup('one', 14.5), matchup('two', 45)];
  state.gameHistory = [history('history-two', 45)];
  const before = structuredClone(state);

  fix.buildMatchupHistoryReconciliationAudit(state, options);
  assert.deepEqual(state, before);
});

test('Audit loads the same-day matcher through both the bundle and a versioned direct fallback', () => {
  const worker = fs.readFileSync('_worker.js', 'utf8');
  assert.match(worker, /readAssetSource\(env, request, '\/audit_same_day_reconciliation\.js'\)/);
  assert.match(
    worker,
    /\[\s*auditSource,\s*sameDaySource,\s*historyRepairSource,\s*historyAliasSyncSource,\s*aliasSource,\s*bootstrapSource\s*\]/
  );
  assert.match(worker, /x-taskpoints-audit-same-day-reconciliation/);
  assert.match(worker, /audit_same_day_reconciliation\.js\?v=20260731-3/);
  assert.match(worker, /data-taskpoints-audit-same-day-direct="true"/);
  assert.ok(
    worker.indexOf('/audit_same_day_reconciliation.js?v=20260922-1')
      < worker.indexOf('/game_history_reconciliation_repair.js?v=20260731-1'),
    'direct matcher must load before the repair panel'
  );
});
