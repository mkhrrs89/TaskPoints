const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../storage_season_image_reference_repair.js');

function fixture() {
  const players = [
    { id: 'p1', name: 'Alpha', imageId: 'new-1' },
    { id: 'p2', name: 'Bravo', imageId: 'new-2' },
    { id: 'p3', name: 'Charlie', imageId: 'new-3' },
    { id: 'p4', name: 'Delta', imageId: 'new-4' },
    { id: 'p5', name: 'Echo', imageId: 'new-5' }
  ];
  const state = {
    players,
    currentSeason: {
      status: 'active',
      playerPool: [{ id: 'p1', name: 'Alpha', imageId: 'old-1', rating: 92 }],
      seeds: [{ id: 'p1', playerId: 'p1', playerName: 'Alpha', imageId: 'old-1', seed: 5 }]
    },
    seasonHistory: [{
      status: 'finalized',
      championId: 'p2',
      playerPool: [
        { id: 'p2', name: 'Bravo', imageId: 'old-2' },
        { id: 'p3', name: 'Charlie', imageId: 'old-3' },
        { id: 'p4', name: 'Delta', imageId: 'old-4' },
        { id: 'p5', name: 'Echo', imageId: 'old-5' }
      ],
      seeds: [
        { playerId: 'p2', playerName: 'Bravo', imageId: 'old-2', seed: 1 },
        { playerId: 'p3', playerName: 'Charlie', imageId: 'old-3', seed: 2 },
        { playerId: 'p4', playerName: 'Delta', imageId: 'old-4', seed: 3 },
        { playerId: 'p5', playerName: 'Echo', imageId: 'old-5', seed: 4 }
      ],
      originalSeeds: [
        { playerId: 'p2', playerName: 'Bravo', imageId: 'old-2', seed: 1 },
        { playerId: 'p3', playerName: 'Charlie', imageId: 'old-3', seed: 2 },
        { playerId: 'p4', playerName: 'Delta', imageId: 'old-4', seed: 3 },
        { playerId: 'p5', playerName: 'Echo', imageId: 'old-5', seed: 4 }
      ]
    }],
    scores: { p1: 100, p2: 95 }
  };
  const missingReferences = ['old-1', 'old-2', 'old-3', 'old-4', 'old-5'];
  const referencePaths = {
    'old-1': ['state.currentSeason.playerPool[0].imageId', 'state.currentSeason.seeds[0].imageId'],
    'old-2': ['state.seasonHistory[0].playerPool[0].imageId', 'state.seasonHistory[0].seeds[0].imageId', 'state.seasonHistory[0].originalSeeds[0].imageId'],
    'old-3': ['state.seasonHistory[0].playerPool[1].imageId', 'state.seasonHistory[0].seeds[1].imageId', 'state.seasonHistory[0].originalSeeds[1].imageId'],
    'old-4': ['state.seasonHistory[0].playerPool[2].imageId', 'state.seasonHistory[0].seeds[2].imageId', 'state.seasonHistory[0].originalSeeds[2].imageId'],
    'old-5': ['state.seasonHistory[0].playerPool[3].imageId', 'state.seasonHistory[0].seeds[3].imageId', 'state.seasonHistory[0].originalSeeds[3].imageId']
  };
  const rows = players.map((player) => ({ key: player.imageId, bytes: 100, type: 'image/jpeg' }));
  return { state, report: { missingReferences, referencePaths, rows } };
}

test('builds a safe dynamic plan for five missing IDs across fourteen Season records', () => {
  const { state, report } = fixture();
  const plan = repair.buildRepairPlan(state, report);
  assert.equal(plan.safe, true);
  assert.equal(plan.missingIds.length, 5);
  assert.equal(plan.replacementGroups.length, 5);
  assert.equal(plan.repairs.length, 14);
  assert.equal(plan.unresolved.length, 0);
  assert.equal(plan.externalPaths.length, 0);
});

test('applies only imageId changes inside current and archived Season copies', () => {
  const { state, report } = fixture();
  const plan = repair.buildRepairPlan(state, report);
  const beforeNonImage = repair.nonImageSnapshot(state);
  const originalPlayers = JSON.stringify(state.players);
  const originalScores = JSON.stringify(state.scores);
  const result = repair.applyRepairPlan(state, plan);

  assert.equal(result.ok, true);
  assert.equal(result.updatedCount, 14);
  assert.equal(repair.nonImageSnapshot(result.state), beforeNonImage);
  assert.equal(JSON.stringify(result.state.players), originalPlayers);
  assert.equal(JSON.stringify(result.state.scores), originalScores);
  assert.equal(result.state.currentSeason.playerPool[0].imageId, 'new-1');
  assert.equal(result.state.seasonHistory[0].originalSeeds[3].imageId, 'new-5');
  assert.equal(state.currentSeason.playerPool[0].imageId, 'old-1', 'source state remains unchanged');
});

test('blocks repair when a missing image is referenced outside Season data', () => {
  const { state, report } = fixture();
  report.referencePaths['old-1'].push('state.players[0].imageId');
  const plan = repair.buildRepairPlan(state, report);
  assert.equal(plan.safe, false);
  assert.deepEqual(plan.externalPaths, [{ imageId: 'old-1', path: 'state.players[0].imageId' }]);
});

test('blocks repair when the current replacement blob is not present', () => {
  const { state, report } = fixture();
  report.rows = report.rows.filter((row) => row.key !== 'new-3');
  const plan = repair.buildRepairPlan(state, report);
  assert.equal(plan.safe, false);
  assert.ok(plan.unresolved.some((entry) => entry.playerId === 'p3' && entry.reason === 'replacement-blob-missing'));
});

test('blocks repair when a missing reference cannot be matched by stable player ID', () => {
  const { state, report } = fixture();
  state.seasonHistory[0].playerPool[0].id = 'unknown-player';
  const plan = repair.buildRepairPlan(state, report);
  assert.equal(plan.safe, false);
  assert.ok(plan.unresolved.some((entry) => entry.reason === 'player-not-found'));
});
