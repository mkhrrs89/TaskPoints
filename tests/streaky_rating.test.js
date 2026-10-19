const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
global.window = global;
require('../scoring_core.js');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const game = read('game.html'), ratings = read('game_ratings.html');
const hub = read('gamehub.html'), settings = read('settings.html'), core = read('scoring_core.js');
function block(source, name, prefix='function ') {
  const start = source.indexOf(prefix + name);
  assert.notEqual(start, -1, name + ' missing');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i+1); }
  }
  throw new Error('Unclosed ' + name);
}
test('all players normalize Streaky to 0–100; existing players default to zero', () => {
  const st = global.TaskPointsCore.normalizeState({players:[
    {id:'old'}, {id:'low',streaky:-8}, {id:'high',streaky:999},
    {id:'str',streaky:'45.5'}, {id:'bad',streaky:'invalid'}
  ]});
  assert.deepEqual(st.players.map(p=>p.streaky), [0,0,100,45.5,0]);
});
test('create/edit/profile players support Streaky and retain separate Greed', () => {
  assert.match(game, /id="playerStreaky"[^>]*value="0"/);
  assert.match(game, /data-field="streaky" type="number" min="0" max="100"/);
  assert.match(game, /player\.streaky = Math\.min\(100, Math\.max\(0,/);
  assert.match(game, /streaky: Math\.min\(100, Math\.max\(0,/);
  assert.match(game, /\$\("playerStreaky"\)\.value = "0"/);
  assert.match(game, /<p>Streaky:/);
});
test('ratings table offers Streaky edit, sorting, and CSV export', () => {
  assert.match(ratings, /<th data-sort="streaky">Streaky<\/th>/);
  assert.match(ratings, /makeEditableCell\(p, "streaky"/);
  assert.match(ratings, /case "streaky":\s+return Number\(p\.streaky\) \|\| 0/);
  assert.match(ratings, /"Greed", "Streaky", "Style"/);
  assert.match(ratings, /field === "greed" \|\| field === "streaky"/);
});
test('Game Hub and Settings simulation display Streaky without using it as game mechanic', () => {
  assert.match(hub, /name="streaky"/);
  assert.match(hub, /player\.streaky = streakyInput/);
  assert.match(hub, /muOppStreaky/);
  assert.match(hub, /key: 'streaky', label: 'Streaky'/);
  assert.match(settings, /label: "Streaky", key: "streaky"/);
  assert.match(settings, /formatNumber\(row\.streaky\)/);
});
test('Streaky does not influence OVR or score simulators', () => {
  assert.doesNotMatch(block(game,'getPlayerOverallRating','const '), /streaky/i);
  assert.doesNotMatch(block(ratings,'computePlayerOverall'), /streaky/i);
  assert.doesNotMatch(block(core,'simulateAiScoreForPlayerCore'), /streaky/i);
  assert.doesNotMatch(block(settings,'simulateScoreForPlayer'), /streaky/i);
});