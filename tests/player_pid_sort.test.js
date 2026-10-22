const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'game.html'), 'utf8');

test('Players page includes persistent ascending and descending PID sort modes', () => {
  assert.match(source, /<option value="pid-asc">PID \(low → high\)<\/option>/);
  assert.match(source, /<option value="pid-desc">PID \(high → low\)<\/option>/);
  const options = source.slice(source.indexOf('const PLAYER_SORT_OPTIONS = ['), source.indexOf('let playerSortMode ='));
  assert.match(options, /"pid-asc"/);
  assert.match(options, /"pid-desc"/);
  assert.match(source, /const stored = localStorage\.getItem\(PLAYER_SORT_STORAGE_KEY\)/);
  assert.match(source, /persistSortMode\(mode\)/);
});

function sortWithMode(mode) {
  const start = source.indexOf('  const comparePlayers = (a, b) => {');
  const end = source.indexOf('  const sortedPlayers = players.slice().sort(comparePlayers);', start);
  assert.ok(start !== -1 && end > start, 'Players comparator missing');
  const context = {
    playerSortMode: mode,
    youName: 'You',
    state: { players: [
      {id: 'two', pid: 'P002'},
      {id: 'ten', pid: 'P010'},
      {id: 'hundred', pid: 'P100'},
      {id: 'missing', pid: ''}
    ] },
    TaskPointsCore: {
      getPlayerPid(state, id) {
        return state.players.find(p => p.id === id)?.pid || '';
      }
    },
    getAverageForPlayer: () => 0,
    getCreatedTs: () => 0
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.comparePlayers = comparePlayers;', context);
  const players = [{id:'missing', name:'Aaron'}, {id:'ten', name:'Dave'},
    {id:'two', name:'Evan'}, {id:'YOU', name:'You', isYou:true},
    {id:'hundred', name:'Zoe'}];
  return players.sort(context.comparePlayers).map(p => p.id);
}

test('ascending PID compares numeric values with P000 first and unassigned last', () => {
  assert.deepEqual(sortWithMode('pid-asc'), ['YOU','two','ten','hundred','missing']);
});

test('descending PID reverses numeric values while keeping unassigned last', () => {
  assert.deepEqual(sortWithMode('pid-desc'), ['hundred','ten','two','YOU','missing']);
});

test('existing player sort controls remain intact', () => {
  for (const mode of ['name-asc','name-desc','avg-desc','overall-desc',
    'ranking-asc','baseline-desc','created-asc','created-desc']) {
    assert.ok(source.includes('value="' + mode + '"'), mode + ' dropdown option missing');
    assert.ok(source.includes('"' + mode + '"'), mode + ' allowed mode missing');
  }
  assert.match(source, /const sortedPlayers = players\.slice\(\)\.sort\(comparePlayers\)/);
  assert.match(source, /if \(groupActivePlayers\)/);
});
