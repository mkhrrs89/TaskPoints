const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
require('../scoring_core.js');

const root = path.join(__dirname, '..');
const gameSource = fs.readFileSync(path.join(root, 'game.html'), 'utf8');
const ratingsSource = fs.readFileSync(path.join(root, 'game_ratings.html'), 'utf8');

function extractFunction(source, functionName) {
  const start = source.indexOf(`function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} not found`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${functionName} closing brace not found`);
}

function extractArrowFunction(source, functionName) {
  const start = source.indexOf(`const ${functionName} =`);
  assert.notEqual(start, -1, `${functionName} not found`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${functionName} closing brace not found`);
}

test('player normalization defaults and clamps persisted Greed ratings', () => {
  const normalized = global.TaskPointsCore.normalizeState({
    players: [
      { id: 'missing' },
      { id: 'low', greed: -12 },
      { id: 'high', greed: 125 },
      { id: 'string', greed: '42' },
      { id: 'invalid', greed: 'lots' }
    ]
  });

  assert.deepEqual(normalized.players.map((player) => player.greed), [0, 0, 100, 42, 0]);
});

test('player create and editor surfaces persist Greed with the requested defaults', () => {
  assert.match(gameSource, /id="playerGreed"[^>]*value="25"/);
  assert.match(gameSource, /greed:\s*Math\.min\(100, Math\.max\(0,/);
  assert.match(gameSource, /\$\("playerGreed"\)\.value = "25"/);
  assert.match(gameSource, /data-field="greed"[^>]*min="0" max="100"/);
  assert.match(gameSource, /player\.greed = Math\.min\(100, Math\.max\(0,/);
});

test('ratings table exposes editable, sortable, and CSV-exported Greed', () => {
  assert.match(ratingsSource, /<th data-sort="greed">Greed<\/th>/);
  assert.match(ratingsSource, /makeEditableCell\(p, "greed"/);
  assert.match(ratingsSource, /case "greed":\s+return Number\(p\.greed\) \|\| 0/);
  assert.match(ratingsSource, /"Poise", "Greed", "Style"/);
});

test('Greed remains excluded from player OVR calculations', () => {
  assert.doesNotMatch(extractArrowFunction(gameSource, 'getPlayerOverallRating'), /greed/i);
  assert.doesNotMatch(extractFunction(ratingsSource, 'computePlayerOverall'), /greed/i);
});
