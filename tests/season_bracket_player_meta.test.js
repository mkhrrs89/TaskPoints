const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
const storage = new Map();
global.localStorage = {
  getItem: (key) => storage.has(String(key)) ? storage.get(String(key)) : null,
  setItem: (key, value) => { storage.set(String(key), String(value)); },
  removeItem: (key) => { storage.delete(String(key)); },
  key: (index) => Array.from(storage.keys())[index] || null,
  get length() { return storage.size; }
};

require('../scoring_core.js');
require('../season.js');

const seasonUi = global.TaskPointsSeason;

test('Round of 32 player meta returns original seeds and live series wins', () => {
  const series = {
    roundId: 'round_of_32',
    playerAId: 'lily',
    playerAName: 'Lily',
    playerASeed: 1,
    playerBId: 'ruth',
    playerBName: 'Ruth',
    playerBSeed: 34,
    winsA: 2,
    winsB: 0
  };

  assert.deepEqual(seasonUi.getBracketPlayerMeta({ playerId: 'lily', playerName: 'Lily', seed: 1 }, series, 'A'), { seed: '1', wins: 2 });
  assert.deepEqual(seasonUi.getBracketPlayerMeta({ playerId: 'ruth', playerName: 'Ruth', seed: 34 }, series, 'B'), { seed: '34', wins: 0 });
});

test('advanced future-round player meta keeps original seed and starts wins at 0', () => {
  const series = {
    roundId: 'sweet_16',
    playerAId: 'lily',
    playerAName: 'Lily',
    playerASeed: 1,
    placeholderB: 'Awaiting winner'
  };

  assert.deepEqual(seasonUi.getBracketPlayerMeta({ playerId: 'lily', playerName: 'Lily', seed: 1 }, series, 'A'), { seed: '1', wins: 0 });
});

test('completed later-round player meta returns both seed labels and final win counts', () => {
  const series = {
    roundId: 'semifinals',
    playerAId: 'miggy',
    playerAName: 'Miggy',
    playerASeed: 8,
    playerBId: 'rocco',
    playerBName: 'Rocco',
    playerBSeed: 12,
    winsA: 3,
    winsB: 1,
    status: 'complete'
  };

  assert.deepEqual(seasonUi.getBracketPlayerMeta({ playerId: 'miggy', playerName: 'Miggy', seed: 8 }, series, 'A'), { seed: '8', wins: 3 });
  assert.deepEqual(seasonUi.getBracketPlayerMeta({ playerId: 'rocco', playerName: 'Rocco', seed: 12 }, series, 'B'), { seed: '12', wins: 1 });
});

test('empty placeholder slots do not render fake seed or win meta', () => {
  const series = {
    roundId: 'quarterfinals',
    placeholderA: 'Awaiting winner',
    winsA: 0,
    winsB: 0
  };

  assert.equal(seasonUi.getBracketPlayerMeta({ type: 'placeholder', label: 'Awaiting winner' }, series, 'A'), null);
  assert.equal(seasonUi.renderBracketPlayerMeta({ type: 'placeholder', label: 'Awaiting winner' }, series, 'A'), '');
});
