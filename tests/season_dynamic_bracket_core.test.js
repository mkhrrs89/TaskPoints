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
const builder = require('../season_bracket_builder_core.js');
const core = global.TaskPointsCore;

function seeds(count) {
  return Array.from({ length: count }, (_, index) => ({
    seed: index + 1,
    playerId: `P${index + 1}`,
    playerName: `Player ${index + 1}`
  }));
}

function previewState() {
  const seasonSeeds = seeds(60);
  return {
    youName: 'You',
    players: seasonSeeds.map((seed) => ({ id: seed.playerId, name: seed.playerName, active: true })),
    currentSeason: {
      id: 'season_2_august_2026',
      name: 'Season 2',
      label: 'August 2026 TaskPoints Championship',
      monthKey: '2026-08',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      startDateKey: '2026-08-01',
      endDateKey: '2026-08-31',
      status: 'preview',
      seedMode: 'manual',
      seeds: seasonSeeds,
      playerPool: seasonSeeds.map((seed) => ({ id: seed.playerId, name: seed.playerName })),
      bracket: {},
      series: {},
      meta: { seasonMatchupControlEnabled: true }
    }
  };
}

test('dynamic Season 2 round order includes Play-In, Opening Round, and all later rounds', () => {
  const locked = builder.lockConfiguredSeasonBracket(previewState(), builder.createSeasonTwoPreset(), { nowISO: '2026-07-30T12:00:00.000Z' });
  assert.equal(locked.ok, true);
  assert.deepEqual(core.getSeasonRoundOrder(locked.season), [
    'play_in', 'opening_round', 'round_of_32', 'round_of_16', 'quarterfinals', 'semifinals', 'finals'
  ]);
});

test('all tied August 1 Play-Ins advance the higher seeds into the correct Opening Round slots', () => {
  const locked = builder.lockConfiguredSeasonBracket(previewState(), builder.createSeasonTwoPreset(), { nowISO: '2026-07-30T12:00:00.000Z' });
  let season = locked.season;

  const preparedPlayIn = core.prepareSeasonForDailySlate(season, '2026-08-01');
  season = preparedPlayIn.season;
  assert.equal(preparedPlayIn.activatedSeriesIds.length, 12);

  const playIns = Object.values(season.series)
    .filter((series) => series.roundId === 'play_in')
    .sort((a, b) => a.seriesIndex - b.seriesIndex);

  for (const series of playIns) {
    const recorded = core.recordSeasonSeriesGameResult(season, series.id, {
      matchupId: `tie-${series.id}`,
      dateKey: '2026-08-01',
      playerAId: series.playerAId,
      playerBId: series.playerBId,
      scoreA: 10,
      scoreB: 10,
      matchupType: 'tournament'
    }, { nowISO: '2026-08-01T23:00:00.000Z' });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.complete, true);
    assert.equal(recorded.series.winnerId, series.playerAId);
    const advanced = core.advanceSeasonSeriesWinner(recorded.season, series.id, { nowISO: '2026-08-01T23:01:00.000Z' });
    assert.equal(advanced.ok, true);
    assert.equal(advanced.advanced, true);
    season = advanced.season;
  }

  const opening = Object.values(season.series)
    .filter((series) => series.roundId === 'opening_round')
    .sort((a, b) => a.seriesIndex - b.seriesIndex);
  assert.equal(opening.length, 16);
  assert.equal(opening.every((series) => series.playerAId && series.playerBId), true);
  assert.deepEqual([opening[0].playerASeed, opening[0].playerBSeed], [17, 48]);
  assert.deepEqual([opening[11].playerASeed, opening[11].playerBSeed], [28, 37]);

  const preparedOpening = core.prepareSeasonForDailySlate(season, '2026-08-02');
  assert.equal(preparedOpening.activatedSeriesIds.length, 16);
  assert.equal(Object.values(preparedOpening.season.series).filter((series) => series.roundId === 'opening_round' && series.status === 'active').length, 16);
});
