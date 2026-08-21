const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'tournament_dynamic_bracket.js'), 'utf8');

test('active tournament participants prefer current profile images over season snapshots', () => {
  assert.match(source, /const liveImageId = id === 'YOU'/);
  assert.match(source, /\? \(state\?\.youImageId \|\| player\?\.imageId\)/);
  assert.match(source, /: player\?\.imageId;/);
  assert.match(source, /liveImageId\s*\|\| series\?\.\[`player\$\{suffix\}ImageId`\]/);
  assert.match(source, /liveImageId \|\| seedRow\?\.imageId \|\| ''/);
});
