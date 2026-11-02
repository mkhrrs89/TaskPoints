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
test('all players normalize Streaky to 1–100; existing zero and missing values become 50', () => {
  const st = global.TaskPointsCore.normalizeState({players:[
    {id:'old'}, {id:'low',streaky:-8}, {id:'high',streaky:999},
    {id:'str',streaky:'45.5'}, {id:'bad',streaky:'invalid'}
  ]});
  assert.deepEqual(st.players.map(p=>p.streaky), [50,1,100,45.5,50]);
});
test('create/edit/profile players support Streaky and retain separate Greed', () => {
  assert.match(game, /id="playerStreaky"[^>]*value="50"/);
  assert.match(game, /data-field="streaky" type="number" min="1" max="100"/);
  assert.match(game, /player\.streaky = Math\.min\(100, Math\.max\(1,/);
  assert.match(game, /streaky: Math\.min\(100, Math\.max\(1,/);
  assert.match(game, /\$\("playerStreaky"\)\.value = "50"/);
  assert.match(game, /<p>Streaky:/);
});
test('ratings table offers Streaky edit, sorting, and CSV export', () => {
  assert.match(ratings, /<th data-sort="streaky">Streaky<\/th>/);
  assert.match(ratings, /makeEditableCell\(p, "streaky"/);
  assert.match(ratings, /case "streaky":\s+return Number\(p\.streaky\) > 0/);
  assert.match(ratings, /"Greed", "Streaky", "Style"/);
  assert.match(ratings, /field === "streaky"/);
});
test('Game Hub and Settings display and use Streaky ratings', () => {
  assert.match(hub, /name="streaky"/);
  assert.match(hub, /player\.streaky = streakyInput/);
  assert.match(hub, /muOppStreaky/);
  assert.match(hub, /key: 'streaky', label: 'Streaky'/);
  assert.match(settings, /label: "Streaky", key: "streaky"/);
  assert.match(settings, /formatNumber\(row\.streaky\)/);
});
test('Streaky affects NPC scores but not OVR, unlike the previous placeholder', () => {
  assert.doesNotMatch(block(game,'getPlayerOverallRating','const '), /streaky/i);
  assert.doesNotMatch(block(ratings,'computePlayerOverall'), /streaky/i);
  assert.match(block(core,'simulateAiScoreForPlayerCore'), /streakyEffect/);
  assert.match(block(settings,'simulateScoreForPlayer'), /computeStreakyEffect/);
  assert.match(settings, /winLossStreakByPlayer/);
  assert.match(game, /streakyBonus/);
  assert.match(hub, /Streaky \(1–100\)/);
});