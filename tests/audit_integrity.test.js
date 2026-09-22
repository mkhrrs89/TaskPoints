const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const audit = require('../audit_integrity.js');

const options = { todayKey: '2026-07-17', dateKey: value => String(value).slice(0, 10), npcScoreMin: 5, npcScoreMax: 86 };
const npc = (overrides = {}) => ({ players: [{ id: 'npc', active: true, baseline: 30 }], matchups: [], gameHistory: [], opponentDripSchedules: [], ...overrides });
const matchup = (overrides = {}) => ({ id: 'm1', dateKey: options.todayKey, playerAId: 'YOU', playerBId: 'npc', scoreA: 100, scoreB: 30, completedAtISO: `${options.todayKey}T12:00:00Z`, ...overrides });
const history = (overrides = {}) => ({ id: 'g1', dateKey: options.todayKey, playerId: 'npc', score: 30, matchupId: 'm1', ...overrides });
const habitState = (habitOverrides = {}, completionOverrides = {}) => ({
  habits: [{ id: 'h1', category: 'health', pointsPerDay: 4, halfPointEnabled: true, doneKeys: [options.todayKey], failedKeys: [], iceKeys: [], ...habitOverrides }],
  completions: [{ id: 'c1', source: 'habit', habitId: 'h1', dayKey: options.todayKey, points: 4, completionFraction: 1, ...completionOverrides }]
});

test('NPC score health accepts healthy data and ignores YOU range', () => {
  assert.equal(audit.buildNpcScoreHealthAudit(npc({ matchups: [matchup()], gameHistory: [history()] }), options).status, 'PASS');
});
test('NPC score health accepts the new 86 ceiling', () => {
  assert.equal(audit.buildNpcScoreHealthAudit(npc({ gameHistory: [history({ score: 85.2 })] }), options).status, 'PASS');
  assert.equal(audit.buildNpcScoreHealthAudit(npc({ gameHistory: [history({ score: 86 })] }), options).status, 'PASS');
  assert.equal(audit.buildNpcScoreHealthAudit(npc({ gameHistory: [history({ score: 86.1 })] }), options).status, 'FAIL');

  const defaultRange = { todayKey: options.todayKey, dateKey: options.dateKey };
  assert.equal(audit.buildNpcScoreHealthAudit(npc({ gameHistory: [history({ score: 85.2 })] }), defaultRange).status, 'PASS');
});

test('NPC historical out-of-range warns and current out-of-range fails', () => {
  assert.equal(audit.buildNpcScoreHealthAudit(npc({ gameHistory: [history({ dateKey: '2026-07-16', score: -2.2 })] }), options).status, 'WARN');
  assert.equal(audit.buildNpcScoreHealthAudit(npc({ gameHistory: [history({ score: -2.2 })] }), options).status, 'FAIL');
});
test('NPC malformed score and alias conflict fail', () => {
  assert.equal(audit.buildNpcScoreHealthAudit(npc({ gameHistory: [history({ score: 'bad' })] }), options).status, 'FAIL');
  assert.equal(audit.buildNpcScoreHealthAudit(npc({ matchups: [matchup({ playerBScore: 31 })] }), options).status, 'FAIL');
});
test('NPC active baseline is required but zero is accepted', () => {
  assert.equal(audit.buildNpcScoreHealthAudit(npc({ players: [{ id: 'npc', active: true }] }), options).status, 'FAIL');
  assert.equal(audit.buildNpcScoreHealthAudit(npc({ players: [{ id: 'npc', active: true, baseline: '   ' }] }), options).status, 'FAIL');
  assert.equal(audit.buildNpcScoreHealthAudit(npc({ players: [{ id: 'npc', active: true, baseline: 0 }] }), options).status, 'PASS');
});
test('NPC score aliases treat whitespace as missing and preserve numeric zero', () => {
  const npcOnA = overrides => matchup({ playerAId: 'npc', playerBId: 'YOU', scoreB: 100, ...overrides });
  assert.equal(audit.buildNpcScoreHealthAudit(npc({ matchups: [npcOnA({ scoreA: '   ', playerAScore: 30 })] }), options).status, 'PASS');
  assert.equal(audit.buildNpcScoreHealthAudit(npc({ matchups: [npcOnA({ scoreA: '\t\n', playerAScore: 30 })] }), options).status, 'PASS');
  assert.equal(audit.buildNpcScoreHealthAudit(npc({ matchups: [npcOnA({ scoreA: ' ', playerAScore: '\t' })] }), options).status, 'FAIL');
  assert.equal(audit.buildNpcScoreHealthAudit(npc({ matchups: [npcOnA({ scoreA: 0 })] }), { ...options, npcScoreMin: 0 }).status, 'PASS');
});

test('reconciliation matching rows and explicit IDs pass', () => {
  assert.equal(audit.buildMatchupHistoryReconciliationAudit({ matchups: [matchup()], gameHistory: [history()] }, options).status, 'PASS');
});
test('reconciliation treats missing and whitespace matchup IDs as optional', () => {
  const reconcile = (matchupId, historyMatchupId) => audit.buildMatchupHistoryReconciliationAudit({
    matchups: [matchup({ id: matchupId, matchupId: '' })],
    gameHistory: [history({ matchupId: historyMatchupId })]
  }, options);
  assert.equal(reconcile('m1', undefined).status, 'PASS');
  assert.equal(reconcile('', 'm1').status, 'PASS');
  assert.equal(reconcile('', undefined).status, 'PASS');
  assert.equal(reconcile('   ', '\t').status, 'PASS');
});
test('reconciliation missing history and score mismatch fail', () => {
  assert.equal(audit.buildMatchupHistoryReconciliationAudit({ matchups: [matchup()], gameHistory: [] }, options).status, 'FAIL');
  assert.equal(audit.buildMatchupHistoryReconciliationAudit({ matchups: [matchup()], gameHistory: [history({ score: 31 })] }, options).status, 'FAIL');
});
test('reconciliation detects duplicate IDs and date/player keys', () => {
  const rows = [history(), history({ score: 30 })];
  const result = audit.buildMatchupHistoryReconciliationAudit({ matchups: [matchup()], gameHistory: rows }, options);
  assert.equal(result.status, 'FAIL');
  assert.match(result.details.join(' '), /Duplicate gameHistory ID/);
  assert.match(result.details.join(' '), /2 gameHistory rows with explicit matchup ID m1/);
});
test('reconciliation orphan legacy history warns', () => {
  assert.equal(audit.buildMatchupHistoryReconciliationAudit({ matchups: [], gameHistory: [history()] }, options).status, 'WARN');
});
test('reconciliation skips YOU history expectation', () => {
  const onlyYou = matchup({ playerBId: 'YOU' });
  assert.equal(audit.buildMatchupHistoryReconciliationAudit({ matchups: [onlyYou], gameHistory: [] }, options).status, 'PASS');
});
test('reconciliation conflicting explicit IDs fail', () => {
  assert.equal(audit.buildMatchupHistoryReconciliationAudit({ matchups: [matchup()], gameHistory: [history({ matchupId: 'other' })] }, options).status, 'FAIL');
});
test('reconciliation consumed same-day match leaves a definite missing row', () => {
  const m2 = matchup({ id: 'm2', scoreB: 40 });
  const result = audit.buildMatchupHistoryReconciliationAudit({ matchups: [matchup(), m2], gameHistory: [history()] }, options);
  assert.equal(result.status, 'FAIL');
  assert.match(result.details.join(' '), /Matchup m2 side B .* has no matching gameHistory row/);
  assert.doesNotMatch(result.details.join(' '), /Ambiguous historical/);
});
test('reconciliation duplicate explicit matchup IDs fail without orphan summary', () => {
  const result = audit.buildMatchupHistoryReconciliationAudit({ matchups: [matchup()], gameHistory: [history(), history({ id: 'g2', matchupId: 'm1' })] }, options);
  assert.equal(result.status, 'FAIL');
  assert.match(result.details.join(' '), /2 gameHistory rows with explicit matchup ID m1/);
  assert.doesNotMatch(result.details.join(' '), /legacy gameHistory rows have no corresponding finalized matchup/);
});

test('habit ledger accepts full, half, and vice completions', () => {
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState(), options).status, 'PASS');
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState({}, { points: 2, completionFraction: 0.5 }), options).status, 'PASS');
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState({ category: 'vice' }, { source: 'vice' }), options).status, 'PASS');
});
test('habit duplicate done keys warn and done/failed overlap fails', () => {
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState({ doneKeys: [options.todayKey, options.todayKey] }), options).status, 'WARN');
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState({ failedKeys: [options.todayKey] }), options).status, 'FAIL');
});
test('habit missing reference and duplicate habit/date completion fail', () => {
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState({}, { habitId: 'missing' }), options).status, 'FAIL');
  const state = habitState(); state.completions.push({ ...state.completions[0], id: 'c2' });
  assert.equal(audit.buildHabitLedgerConsistencyAudit(state, options).status, 'FAIL');
});
test('habit source mismatch and completion without done key fail', () => {
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState({}, { source: 'vice' }), options).status, 'FAIL');
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState({ doneKeys: [] }), options).status, 'FAIL');
});
test('habit done without completion warns and failed with completion fails', () => {
  assert.equal(audit.buildHabitLedgerConsistencyAudit({ ...habitState(), completions: [] }, options).status, 'WARN');
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState({ failedKeys: [options.todayKey] }), options).status, 'FAIL');
});

test('historical missing doneKey is silent when the stored You game score still matches the canonical ledger', () => {
  const day = '2026-07-16';
  const state = {
    ...habitState({ doneKeys: [day] }),
    completions: [],
    matchups: [matchup({ dateKey: day, completedAtISO: day + 'T12:00:00Z', scoreA: 42.5, scoreB: 30 })]
  };
  const result = audit.buildHabitLedgerConsistencyAudit(state, {
    ...options,
    youDailyTotals: { [day]: 42.5 }
  });
  assert.equal(result.status, 'PASS');
  assert.doesNotMatch(result.details.join(' '), /no completion row|cannot be proven score-neutral/);
});

test('historical missing doneKey still warns when the stored You game score differs from the canonical ledger', () => {
  const day = '2026-07-16';
  const state = {
    ...habitState({ doneKeys: [day] }),
    completions: [],
    matchups: [matchup({ dateKey: day, completedAtISO: day + 'T12:00:00Z', scoreA: 42.5, scoreB: 30 })]
  };
  const result = audit.buildHabitLedgerConsistencyAudit(state, {
    ...options,
    youDailyTotals: { [day]: 40 }
  });
  assert.equal(result.status, 'WARN');
  assert.match(result.details.join(' '), /cannot be proven score-neutral/);
  assert.match(result.details.join(' '), /stored game 42.5, current ledger 40/);
});

test('pre-game-era missing doneKeys are treated as legacy markers but later unverified dates still warn', () => {
  const firstGameDay = '2026-07-10';
  const firstGame = matchup({ dateKey: firstGameDay, completedAtISO: firstGameDay + 'T12:00:00Z', scoreA: 50, scoreB: 30 });

  const preGameDay = '2026-07-01';
  const preGame = audit.buildHabitLedgerConsistencyAudit({
    ...habitState({ doneKeys: [preGameDay] }),
    completions: [],
    matchups: [firstGame]
  }, {
    ...options,
    youDailyTotals: { [preGameDay]: 35, [firstGameDay]: 50 }
  });
  assert.equal(preGame.status, 'PASS');

  const postGameDay = '2026-07-16';
  const postGame = audit.buildHabitLedgerConsistencyAudit({
    ...habitState({ doneKeys: [postGameDay] }),
    completions: [],
    matchups: [firstGame]
  }, {
    ...options,
    youDailyTotals: { [postGameDay]: 35, [firstGameDay]: 50 }
  });
  assert.equal(postGame.status, 'WARN');
  assert.match(postGame.details.join(' '), /no stored You matchup is available to verify score impact/);
});
test('habit invalid fraction, date, and orphan ice key fail', () => {
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState({}, { completionFraction: 0.25 }), options).status, 'FAIL');
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState({ doneKeys: ['2026-02-30'] }, { dayKey: '2026-02-30' }), options).status, 'FAIL');
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState({ iceKeys: ['2026-07-16'] }), options).status, 'FAIL');
});
test('habit current point mismatch fails while historical point values are preserved', () => {
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState({}, { points: 3 }), options).status, 'FAIL');
  const old = '2026-07-16';
  const result = audit.buildHabitLedgerConsistencyAudit(
    habitState({ doneKeys: [old] }, { dayKey: old, points: 3 }),
    options
  );
  assert.equal(result.status, 'PASS');
  assert.doesNotMatch(result.details.join(' '), /historical point mismatches/);
});


test('NPC historical range warnings are grouped and do not hide current failures', () => {
  const oldRows = Array.from({ length: 90 }, (_, i) => history({ id: `long-history-${i}`, dateKey: '2026-07-16', score: -i - 1 }));
  const result = audit.buildNpcScoreHealthAudit(npc({ players: [{ id: 'npc', name: 'Chester', active: true, baseline: 30 }], gameHistory: [...oldRows, history({ id: 'today', score: 99 })] }), { ...options, detailLimit: 3 });
  assert.equal(result.status, 'FAIL'); assert.match(result.details[0], /Chester/); assert.match(result.details.join(' '), /90 historical NPC scores/); assert.equal(result.details.filter(detail => /historical NPC scores/.test(detail)).length, 1);
});
test('reconciliation distinguishes same-day matchups by ID, context, and score', () => {
  const m2 = matchup({ id: 'm2', scoreB: 40 });
  assert.equal(audit.buildMatchupHistoryReconciliationAudit({ matchups: [matchup(), m2], gameHistory: [history(), history({ id: 'g2', matchupId: 'm2', score: 40 })] }, options).status, 'PASS');
  const contextM2 = matchup({ id: '', matchupId: '', scoreB: 40, seriesId: 'series', gameNumber: 2 });
  const contextM1 = matchup({ id: '', matchupId: '', seriesId: 'series', gameNumber: 1 });
  assert.equal(audit.buildMatchupHistoryReconciliationAudit({ matchups: [contextM1, contextM2], gameHistory: [history({ matchupId: '', seriesId: 'series', gameNumber: 1 }), history({ id: 'g2', matchupId: '', score: 40, seriesId: 'series', gameNumber: 2 })] }, options).status, 'PASS');
  assert.equal(audit.buildMatchupHistoryReconciliationAudit({ matchups: [matchup({ id: '', matchupId: '' }), matchup({ id: '', matchupId: '', scoreB: 40 })], gameHistory: [history({ matchupId: '' }), history({ id: 'g2', matchupId: '', score: 40 })] }, options).status, 'PASS');
});
test('reconciliation ambiguous duplicates warn and groups orphan history', () => {
  const result = audit.buildMatchupHistoryReconciliationAudit({ matchups: [matchup({ id: '', matchupId: '' }), matchup({ id: '', matchupId: '' })], gameHistory: [history({ matchupId: '' }), history({ id: 'g2', matchupId: '' }), history({ id: 'orphan-1', dateKey: '2026-07-16', matchupId: '' }), history({ id: 'orphan-2', dateKey: '2026-07-15', matchupId: '' })] }, options);
  assert.equal(result.status, 'WARN'); assert.match(result.details.join(' '), /Ambiguous historical/); assert.match(result.details.join(' '), /2 legacy gameHistory rows/);
});
test('habit historical point drift stays silent while current structural contradictions still fail', () => {
  const old = ['2026-07-16', '2026-07-15'];
  const state = habitState({
    title: 'Morning Dishes',
    doneKeys: [options.todayKey, ...old],
    failedKeys: [options.todayKey]
  });
  state.completions.push(...old.map((day, i) => ({
    id: `very-long-completion-id-${i}`,
    source: 'habit',
    habitId: 'h1',
    dayKey: day,
    points: 3,
    completionFraction: 1
  })));
  const result = audit.buildHabitLedgerConsistencyAudit(state, options);
  assert.equal(result.status, 'FAIL');
  assert.match(result.details.join(' '), /Morning Dishes \(h1\) on 2026-07-17/);
  assert.doesNotMatch(result.details.join(' '), /historical point mismatches/);
});

test('all audit builders leave input state unchanged', () => {
  const cases = [
    [audit.buildNpcScoreHealthAudit, npc({ matchups: [matchup()], gameHistory: [history()] })],
    [audit.buildMatchupHistoryReconciliationAudit, { matchups: [matchup()], gameHistory: [history()] }],
    [audit.buildHabitLedgerConsistencyAudit, habitState()]
  ];
  cases.forEach(([builder, state]) => { const clone = structuredClone(state); builder(state, options); assert.deepEqual(state, clone); });
});

test('read-only page audit ignores display-clone normalization but catches persistent mutation', () => {
  const state = { matchups: [{ scoreA: 33.7 }], habits: [] };
  const clone = structuredClone;
  const diff = (before, after) => assert.deepEqual(before, after) || [];
  const harmless = audit.evaluateReadOnlyPageVisits(state, [{
    page: 'display.html',
    run(input) {
      const persistedState = structuredClone(input);
      input.matchups[0].scoreA = 34.2;
      return { state: input, persistedState };
    }
  }], { clone, diff });
  assert.equal(harmless.failed.length, 0);

  const persistent = audit.evaluateReadOnlyPageVisits(state, [{
    page: 'writer.html',
    run(input) {
      input.matchups[0].scoreA = 34.2;
      return { state: input, persistedState: input };
    }
  }], { clone, diff: (before, after) => before.matchups[0].scoreA === after.matchups[0].scoreA ? [] : [{ key: 'matchups' }] });
  assert.equal(persistent.failed.length, 1);
});

test('audit page loads and wires read-only integrity builders and centralized limits', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'audit.html'), 'utf8');
  assert.match(html, /<script src="audit_integrity\.js"><\/script>/);
  for (const name of ['buildNpcScoreHealthAudit', 'buildMatchupHistoryReconciliationAudit', 'buildHabitLedgerConsistencyAudit']) assert.match(html, new RegExp(`checks\\.push\\(TaskPointsAuditIntegrity\\.${name}`));
  assert.match(html, /TaskPointsCore\.NPC_SCORE_ABSOLUTE_MIN \?\? 5/);
  assert.match(html, /TaskPointsCore\.youDailyTotalsWithInertia\(state\)/);
  assert.match(html, /if \(key !== 'reminders'\) emptyWarnings\.push/);
  assert.match(html, /!value\.length && key !== 'reminders'/);
  assert.match(html, /empty reminders list is valid/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'audit_integrity.js'), 'utf8');
  assert.match(source, /Historical stored points are preserved because Habit\/Vice values may change over time/);
  assert.match(source, /stored You game score still matches the canonical completion ledger/);
  assert.match(source, /predates the first stored You matchup/);
  assert.doesNotMatch(source, /historical point mismatches for/);
  assert.doesNotMatch(source, /saveAppState|saveStateSnapshot|mergeAndSaveState|localStorage\.setItem|\bsync[A-Z]/);
});
