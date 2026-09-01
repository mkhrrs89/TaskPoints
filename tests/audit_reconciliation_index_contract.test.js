const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const audit = require('../audit_integrity.js');

const options = {
  todayKey: '2026-07-17',
  dateKey: value => String(value).slice(0, 10),
  npcScoreMin: 5,
  npcScoreMax: 85
};

test('matchup/history reconciliation uses date+player candidate buckets instead of rescanning all unused history', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'audit_integrity.js'), 'utf8');
  assert.match(source, /const historiesByBase = new Map\(\)/);
  assert.match(source, /const candidatesFor = expected => \(historiesByBase\.get\(base\(expected\)\) \|\| \[\]\)\.filter\(found => unused\.has\(found\)\)/);
  assert.doesNotMatch(source, /\[\.\.\.unused\]\.filter\(found => base\(found\) === base\(expected\)\)/);
  assert.doesNotMatch(source, /histories\.filter\(item => base\(item\) === key\)/);
});

test('indexed reconciliation preserves large-scale matching semantics', () => {
  const matchups = [];
  const gameHistory = [];

  for (let i = 0; i < 2606; i += 1) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const playerId = `npc${i % 120}`;
    const matchupId = `m${i}`;
    const score = 20 + (i % 50);
    matchups.push({
      id: matchupId,
      dateKey: `2026-06-${day}`,
      playerAId: 'YOU',
      playerBId: playerId,
      scoreA: 100,
      scoreB: score,
      completedAtISO: `2026-06-${day}T12:00:00Z`
    });
    gameHistory.push({
      id: `g${i}`,
      dateKey: `2026-06-${day}`,
      playerId,
      score,
      matchupId
    });
  }

  for (let i = 2606; i < 5086; i += 1) {
    gameHistory.push({
      id: `g${i}`,
      dateKey: '2026-05-01',
      playerId: `orphan${i}`,
      score: 30,
      matchupId: ''
    });
  }

  const result = audit.buildMatchupHistoryReconciliationAudit({ matchups, gameHistory }, options);
  assert.equal(result.status, 'WARN');
  assert.match(result.details.join(' '), /2480 legacy gameHistory rows have no corresponding finalized matchup/);
});
