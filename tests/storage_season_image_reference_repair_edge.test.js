const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../storage_season_image_reference_repair.js');

test('blocks duplicate stable player IDs even when the first duplicate has no image', () => {
  const state = {
    players: [
      { id: 'p1', name: 'First copy without a photo' },
      { id: 'p1', name: 'Second copy', imageId: 'new-1' }
    ],
    currentSeason: {
      playerPool: [{ id: 'p1', name: 'Player', imageId: 'old-1' }]
    },
    seasonHistory: []
  };
  const report = {
    missingReferences: ['old-1'],
    referencePaths: {
      'old-1': ['state.currentSeason.playerPool[0].imageId']
    },
    rows: [{ key: 'new-1', bytes: 100, type: 'image/jpeg' }]
  };

  const plan = repair.buildRepairPlan(state, report);
  assert.equal(plan.safe, false);
  assert.ok(plan.duplicatePlayerIds.includes('p1'));
  assert.ok(plan.unresolved.some((entry) => entry.reason === 'duplicate-current-player-id'));
});

test('uses the verified current YOU profile image for matching Season copies', () => {
  const state = {
    youName: 'You',
    youImageId: 'new-you',
    players: [],
    currentSeason: {
      seeds: [{ id: 'YOU', playerId: 'YOU', playerName: 'You', imageId: 'old-you' }]
    },
    seasonHistory: []
  };
  const report = {
    missingReferences: ['old-you'],
    referencePaths: {
      'old-you': ['state.currentSeason.seeds[0].imageId']
    },
    rows: [{ key: 'new-you', bytes: 100, type: 'image/jpeg' }]
  };

  const plan = repair.buildRepairPlan(state, report);
  assert.equal(plan.safe, true);
  assert.equal(plan.repairs.length, 1);
  assert.equal(plan.repairs[0].playerId, 'YOU');
  assert.equal(plan.repairs[0].newImageId, 'new-you');
});

test('treats a player record with stable ID YOU as ambiguous with the profile pseudo-player', () => {
  const state = {
    youName: 'You',
    youImageId: 'new-you',
    players: [{ id: 'YOU', name: 'Invalid duplicate', imageId: 'other-you' }],
    currentSeason: {
      seeds: [{ id: 'YOU', playerId: 'YOU', playerName: 'You', imageId: 'old-you' }]
    },
    seasonHistory: []
  };
  const report = {
    missingReferences: ['old-you'],
    referencePaths: {
      'old-you': ['state.currentSeason.seeds[0].imageId']
    },
    rows: [
      { key: 'new-you', bytes: 100, type: 'image/jpeg' },
      { key: 'other-you', bytes: 100, type: 'image/jpeg' }
    ]
  };

  const plan = repair.buildRepairPlan(state, report);
  assert.equal(plan.safe, false);
  assert.ok(plan.duplicatePlayerIds.includes('YOU'));
});
