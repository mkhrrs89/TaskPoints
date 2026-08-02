const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'tournament_dynamic_bracket.js'), 'utf8');
const loader = fs.readFileSync(path.join(__dirname, '..', 'inbox_count_badge.js'), 'utf8');

function makeSeason() {
  const rounds = [
    ['play_in', 12, 1],
    ['opening_round', 16, 3],
    ['round_of_32', 16, 5],
    ['round_of_16', 8, 5],
    ['quarterfinals', 4, 5],
    ['semifinals', 2, 5],
    ['finals', 1, 7]
  ];
  const series = {};
  rounds.forEach(([roundId, count, bestOf], roundIndex) => {
    for (let index = 1; index <= count; index += 1) {
      const id = `season_2_${roundId}_${index}`;
      series[id] = {
        id,
        roundId,
        roundName: roundId.replace(/_/g, ' '),
        roundIndex,
        seriesIndex: index,
        bestOf,
        playerAId: roundIndex < 2 ? `P${index}` : '',
        playerBId: roundIndex < 2 ? `P${60 - index}` : '',
        playerASeed: roundIndex < 2 ? index : null,
        playerBSeed: roundIndex < 2 ? 60 - index : null,
        winsA: 0,
        winsB: 0
      };
    }
  });
  return {
    id: 'season_2_august_2026',
    bracketConfig: { presetId: 'season2_60_august_2026', entrantCount: 60 },
    bracket: {
      roundOrder: rounds.map(([id]) => id),
      rounds: rounds.map(([id, count, bestOf], roundIndex) => ({
        id,
        displayName: id.replace(/_/g, ' '),
        roundIndex,
        bestOf,
        seriesIds: Array.from({ length: count }, (_, index) => `season_2_${id}_${index + 1}`)
      }))
    },
    dateWindows: rounds.map(([id, , bestOf]) => ({ id, displayName: id.replace(/_/g, ' '), bestOf })),
    seeds: Array.from({ length: 60 }, (_, index) => ({ seed: index + 1, playerId: `P${index + 1}`, playerName: `Player ${index + 1}` })),
    series
  };
}

test('dynamic bracket orders all seven August rounds and all 59 series', () => {
  const document = { readyState: 'loading', addEventListener() {} };
  const window = { document, addEventListener() {}, setTimeout() {} };
  const context = vm.createContext({ window, document, globalThis: window, console, module: { exports: {} }, Map, Set, Object, Array, Number, String, Date, URL });
  vm.runInContext(source, context);
  const rounds = window.TaskPointsDynamicTournamentBracket.orderedRounds(makeSeason());
  assert.deepEqual(Array.from(rounds, (round) => round.id), [
    'play_in', 'opening_round', 'round_of_32', 'round_of_16', 'quarterfinals', 'semifinals', 'finals'
  ]);
  assert.deepEqual(Array.from(rounds, (round) => round.series.length), [12, 16, 16, 8, 4, 2, 1]);
  assert.equal(rounds.reduce((sum, round) => sum + round.series.length, 0), 59);
});

test('renderer is data-driven and no longer hardcodes the June 34-player format', () => {
  assert.doesNotMatch(source, /official_34_player_championship/);
  assert.doesNotMatch(source, /\[31,\s*34\]/);
  assert.match(source, /season\?\.bracket\?\.roundOrder/);
  assert.match(source, /season\?\.bracketConfig\?\.entrantCount/);
});

test('shared bundle loader loads the dynamic bracket only when the Tourney mount exists', () => {
  assert.match(loader, /getElementById\?\.\('tournamentBracket'\)/);
  assert.match(loader, /tournament_dynamic_bracket\.js\?v=20260802-1/);
  assert.match(loader, /TaskPointsDynamicTournamentBracket\?\.render/);
});
