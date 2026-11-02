const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
require('../scoring_core.js');

const core = global.TaskPointsCore;
const gameSource = fs.readFileSync(path.join(__dirname, '..', 'game.html'), 'utf8');

function makeState() {
  return core.normalizeState({
    youName: 'Miggy',
    players: [
      { id: 'uuid-alpha', name: 'Alpha', active: true },
      { id: 'uuid-beta', name: 'Beta', active: true }
    ]
  });
}

test('P000 is the permanent PID for YOU and PID input normalization is friendly', () => {
  assert.equal(core.YOU_PID, 'P000');
  assert.equal(core.getPlayerPid(makeState(), 'YOU'), 'P000');
  assert.equal(core.resolvePlayerIdFromPid(makeState(), 'P000'), 'YOU');
  assert.equal(core.normalizePlayerPid('1'), 'P001');
  assert.equal(core.normalizePlayerPid('001'), 'P001');
  assert.equal(core.normalizePlayerPid('p27'), 'P027');
  assert.equal(core.normalizePlayerPid('P1000'), 'P1000');
  assert.equal(core.normalizePlayerPid('player27'), '');
});

test('NPC PID assignment is manual, unique, and permanent', () => {
  let state = makeState();

  const assigned = core.assignPlayerPid(state, 'uuid-alpha', '27');
  assert.equal(assigned.ok, true);
  assert.equal(assigned.changed, true);
  assert.equal(assigned.pid, 'P027');
  state = assigned.state;

  assert.equal(core.getPlayerPid(state, 'uuid-alpha'), 'P027');
  assert.equal(core.resolvePlayerIdFromPid(state, 'P027'), 'uuid-alpha');

  const duplicate = core.assignPlayerPid(state, 'uuid-beta', 'P027');
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error, 'pid_in_use');

  const changeLocked = core.assignPlayerPid(state, 'uuid-alpha', 'P028');
  assert.equal(changeLocked.ok, false);
  assert.equal(changeLocked.error, 'pid_locked');
  assert.equal(changeLocked.pid, 'P027');

  const reservedYou = core.assignPlayerPid(state, 'uuid-beta', 'P000');
  assert.equal(reservedYou.ok, false);
  assert.equal(reservedYou.error, 'pid_reserved_for_you');
});

test('saved PIDs remain reserved after the player is deleted', () => {
  let state = makeState();
  state = core.assignPlayerPid(state, 'uuid-alpha', 'P015').state;

  state = core.normalizeState({
    ...state,
    players: state.players.filter((player) => player.id !== 'uuid-alpha')
  });

  assert.ok(state.reservedPlayerPids.includes('P015'));

  const reuse = core.assignPlayerPid(state, 'uuid-beta', 'P015');
  assert.equal(reuse.ok, false);
  assert.equal(reuse.error, 'pid_reserved');
});

test('PID fields and reservations survive packed storage round-trip', () => {
  let state = makeState();
  state = core.assignPlayerPid(state, 'uuid-alpha', 'P042').state;

  const packed = core.packTaskPointsStorageState(state);
  const unpacked = core.unpackTaskPointsStorageState(packed);
  const normalized = core.normalizeState(unpacked);

  assert.equal(core.getPlayerPid(normalized, 'uuid-alpha'), 'P042');
  assert.ok(normalized.reservedPlayerPids.includes('P000'));
  assert.ok(normalized.reservedPlayerPids.includes('P042'));
});

test('Players UI exposes PID assignment without exposing the UUID as the human ID', () => {
  assert.match(gameSource, /PID \$\{escapeHtml\(p\.isYou \? "P000"/);
  assert.match(gameSource, /You can edit this later on the player page\. P000 is reserved for you\./);
  assert.match(gameSource, /data-act="save-pid"/);
  assert.match(gameSource, /TaskPointsCore\?\.assignPlayerPid\?\.\(state, id, input\.value\)/);
  assert.match(gameSource, /pid:\s*""/);
  assert.match(gameSource, /PID: P000/);
});

test('profile-authorized NPC PID changes are unique while earlier IDs remain retired', () => {
  let state = core.normalizeState({
    players: [
      { id: 'npc-a', name: 'A', pid: 'P007' },
      { id: 'npc-b', name: 'B', pid: 'P008' }
    ],
    gameHistory: [{ id: 'game-a', playerId: 'npc-a', score: 42 }],
    matchups: [{ id: 'm-a', playerAId: 'npc-a', playerBId: 'npc-b' }]
  });
  const oldGames = structuredClone(state.gameHistory);
  const oldMatchups = structuredClone(state.matchups);
  const usual = core.assignPlayerPid(state, 'npc-a', '9');
  assert.equal(usual.ok, false);
  assert.equal(usual.error, 'pid_locked');

  const edited = core.assignPlayerPid(state, 'npc-a', '9', { allowReassign: true });
  assert.equal(edited.ok, true);
  assert.equal(edited.pid, 'P009');
  state = edited.state;
  assert.equal(state.players[0].id, 'npc-a');
  assert.equal(state.players[0].pid, 'P009');
  assert.ok(state.reservedPlayerPids.includes('P007'));
  assert.ok(state.reservedPlayerPids.includes('P009'));
  assert.deepEqual(state.gameHistory, oldGames);
  assert.deepEqual(state.matchups, oldMatchups);
  assert.equal(core.resolvePlayerIdFromPid(state, 'P009'), 'npc-a');
  assert.equal(core.resolvePlayerIdFromPid(state, 'P007'), '');

  const used = core.assignPlayerPid(state, 'npc-a', 'P008', { allowReassign: true });
  assert.equal(used.ok, false);
  assert.equal(used.error, 'pid_in_use');
  const retired = core.assignPlayerPid(state, 'npc-b', 'P007', { allowReassign: true });
  assert.equal(retired.ok, false);
  assert.equal(retired.error, 'pid_reserved');
  const you = core.assignPlayerPid(state, 'npc-a', 'P000', { allowReassign: true });
  assert.equal(you.ok, false);
  assert.equal(you.error, 'pid_reserved_for_you');
  const self = core.assignPlayerPid(state, 'YOU', 'P009', { allowReassign: true });
  assert.equal(self.ok, false);
  assert.equal(self.error, 'you_pid_locked');
});
