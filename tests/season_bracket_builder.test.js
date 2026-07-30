const test = require('node:test');
const assert = require('node:assert/strict');

const builder = require('../season_bracket_builder_core.js');

function seeds(count) {
  return Array.from({ length: count }, (_, index) => ({
    seed: index + 1,
    playerId: `P${index + 1}`,
    playerName: `Player ${index + 1}`
  }));
}

test('Season 2 preset fills every August day and ends Finals game 7 on August 31', () => {
  const config = builder.createSeasonTwoPreset();
  assert.equal(config.rounds[0].startDate, '2026-08-01');
  assert.equal(config.rounds.at(-1).endDate, '2026-08-31');
  assert.equal(config.rounds.reduce((sum, round) => sum + builder.daysInclusive(round.startDate, round.endDate), 0), 31);
  assert.deepEqual(config.rounds.map((round) => round.bestOf), [1, 3, 5, 5, 5, 5, 7]);
});

test('Season 2 preset creates twelve 37-60 play-ins with higher seed tie breaker', () => {
  const config = builder.createSeasonTwoPreset();
  const built = builder.buildConfiguredTournament(seeds(60), config, { seasonId: 's2', nowISO: '2026-07-30T12:00:00.000Z' });
  assert.equal(built.ok, true);
  const playIns = Object.values(built.series).filter((series) => series.roundId === 'play_in');
  assert.equal(playIns.length, 12);
  assert.deepEqual(playIns.map((series) => [series.playerASeed, series.playerBSeed]), [
    [37, 60], [38, 59], [39, 58], [40, 57], [41, 56], [42, 55],
    [43, 54], [44, 53], [45, 52], [46, 51], [47, 50], [48, 49]
  ]);
  assert.equal(playIns.every((series) => series.bestOf === 1 && series.winsNeeded === 1 && series.tieBreaker === 'higher_seed'), true);
});

test('Season 2 preset creates 48-to-32 opening round and top sixteen byes', () => {
  const built = builder.buildConfiguredTournament(seeds(60), builder.createSeasonTwoPreset(), { seasonId: 's2' });
  const opening = Object.values(built.series).filter((series) => series.roundId === 'opening_round');
  const round32 = Object.values(built.series).filter((series) => series.roundId === 'round_of_32');
  assert.equal(opening.length, 16);
  assert.equal(round32.length, 16);
  assert.deepEqual(opening.slice(0, 12).map((series) => series.playerASeed), Array.from({ length: 12 }, (_, index) => index + 17));
  assert.deepEqual(opening.slice(12).map((series) => [series.playerASeed, series.playerBSeed]), [[29, 36], [30, 35], [31, 34], [32, 33]]);
  const directRound32Seeds = round32.flatMap((series) => [series.playerASeed, series.playerBSeed]).filter(Number.isFinite).sort((a, b) => a - b);
  assert.deepEqual(directRound32Seeds, Array.from({ length: 16 }, (_, index) => index + 1));
});

test('generic field generation creates a valid preliminary round and main bracket', () => {
  const config = builder.createGenericConfig({ entrantCount: 48, startDate: '2026-08-01', endDate: '2026-08-31' });
  assert.equal(config.mainBracketSize, 32);
  assert.equal(config.preliminarySeries, 16);
  assert.equal(config.directByes, 16);
  const built = builder.buildConfiguredTournament(seeds(48), config, { seasonId: 'generic' });
  assert.equal(built.ok, true);
  assert.equal(Object.values(built.series).filter((series) => series.roundId === 'play_in').length, 16);
  assert.equal(Object.values(built.series).filter((series) => series.roundId === 'round_of_32').length, 16);
});

test('config validation rejects rounds too short for their best-of maximum', () => {
  const config = builder.createSeasonTwoPreset();
  config.rounds[1].endDate = config.rounds[1].startDate;
  const result = builder.validateConfig(config, seeds(60));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /fewer than its best-of-3 maximum/);
});
