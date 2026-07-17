const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const audit = require('../audit_integrity.js');

const options = { todayKey: '2026-07-17', dateKey: value => String(value).slice(0, 10), npcScoreMin: 5, npcScoreMax: 85 };
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
  assert.equal(audit.buildNpcScoreHealthAudit(npc({ players: [{ id: 'npc', active: true, baseline: 0 }] }), options).status, 'PASS');
});

test('reconciliation matching rows and explicit IDs pass', () => {
  assert.equal(audit.buildMatchupHistoryReconciliationAudit({ matchups: [matchup()], gameHistory: [history()] }, options).status, 'PASS');
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
  assert.match(result.details.join(' '), /More than one gameHistory row/);
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
test('habit invalid fraction, date, and orphan ice key fail', () => {
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState({}, { completionFraction: 0.25 }), options).status, 'FAIL');
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState({ doneKeys: ['2026-02-30'] }, { dayKey: '2026-02-30' }), options).status, 'FAIL');
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState({ iceKeys: ['2026-07-16'] }), options).status, 'FAIL');
});
test('habit current point mismatch fails while historical mismatch warns', () => {
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState({}, { points: 3 }), options).status, 'FAIL');
  const old = '2026-07-16';
  assert.equal(audit.buildHabitLedgerConsistencyAudit(habitState({ doneKeys: [old] }, { dayKey: old, points: 3 }), options).status, 'WARN');
});

test('all audit builders leave input state unchanged', () => {
  const cases = [
    [audit.buildNpcScoreHealthAudit, npc({ matchups: [matchup()], gameHistory: [history()] })],
    [audit.buildMatchupHistoryReconciliationAudit, { matchups: [matchup()], gameHistory: [history()] }],
    [audit.buildHabitLedgerConsistencyAudit, habitState()]
  ];
  cases.forEach(([builder, state]) => { const clone = structuredClone(state); builder(state, options); assert.deepEqual(state, clone); });
});

test('audit page loads and wires read-only integrity builders and centralized limits', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'audit.html'), 'utf8');
  assert.match(html, /<script src="audit_integrity\.js"><\/script>/);
  for (const name of ['buildNpcScoreHealthAudit', 'buildMatchupHistoryReconciliationAudit', 'buildHabitLedgerConsistencyAudit']) assert.match(html, new RegExp(`checks\\.push\\(TaskPointsAuditIntegrity\\.${name}`));
  assert.match(html, /TaskPointsCore\.NPC_SCORE_ABSOLUTE_MIN \?\? 5/);
  assert.match(html, /TaskPointsCore\.NPC_SCORE_ABSOLUTE_MAX \?\? 85/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'audit_integrity.js'), 'utf8');
  assert.doesNotMatch(source, /saveAppState|saveStateSnapshot|mergeAndSaveState|localStorage\.setItem|\bsync[A-Z]/);
});
