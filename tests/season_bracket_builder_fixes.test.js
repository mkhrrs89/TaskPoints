const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
require('../season_bracket_builder_core.js');
require('../season_bracket_builder_fixes.js');

const builder = global.TaskPointsBracketBuilder;

function seeds(count) {
  return Array.from({ length: count }, (_, index) => ({
    seed: index + 1,
    playerId: `P${index + 1}`,
    playerName: `Player ${index + 1}`
  }));
}

test('changing entrant count recomputes all derived bracket fields', () => {
  const original = builder.createGenericConfig({
    entrantCount: 60,
    startDate: '2026-08-01',
    endDate: '2026-08-31'
  });
  const changed = builder.normalizeConfig({ ...original, entrantCount: 48 }, seeds(60));

  assert.equal(changed.entrantCount, 48);
  assert.equal(changed.mainBracketSize, 32);
  assert.equal(changed.preliminarySeries, 16);
  assert.equal(changed.directByes, 16);
});

test('Season 2 preset is rejected outside the August 2026 championship', () => {
  const config = builder.createSeasonTwoPreset({
    startDate: '2026-09-01',
    endDate: '2026-09-30'
  });
  const validation = builder.validateConfig(config, seeds(60));

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join(' '), /only available for the August 1–31, 2026 championship/);
});

test('official locking also refuses a Season 2 preset with mismatched dates', () => {
  const config = builder.createSeasonTwoPreset({
    startDate: '2026-09-01',
    endDate: '2026-09-30'
  });
  const state = {
    currentSeason: {
      id: 'future-season',
      status: 'preview',
      seeds: seeds(60)
    }
  };
  const result = builder.lockConfiguredSeasonBracket(state, config);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_config');
});


test('Season 3 preset is accepted only for the October 2026 championship', () => {
  const valid = builder.validateConfig(builder.createSeasonThreePreset(), seeds(80));
  assert.equal(valid.ok, true);
  assert.equal(valid.config.entrantCount, 60);

  const invalid = builder.validateConfig(builder.createSeasonThreePreset({
    startDate: '2026-11-01',
    endDate: '2026-11-30'
  }), seeds(80));
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(' '), /only available for the October 1–31, 2026 championship/);
});


test('Season 3 official locking refuses a custom field instead of bypassing the top-60 cutoff', () => {
  const state = {
    currentSeason: {
      id: 'season_3_october_2026',
      name: 'Season 3',
      label: 'October 2026 TaskPoints Championship',
      monthKey: '2026-10',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      status: 'preview',
      seeds: seeds(80)
    }
  };
  const custom = builder.createGenericConfig({
    entrantCount: 80,
    startDate: '2026-10-01',
    endDate: '2026-10-31'
  });
  const result = builder.lockConfiguredSeasonBracket(state, custom);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_config');
  assert.match(result.errors.join(' '), /fixed to the top 60 ranked seeds/);
});

test('Season 3 official locking accepts the dedicated preset and enables matchup control', () => {
  const state = {
    currentSeason: {
      id: 'season_3_october_2026',
      name: 'Season 3',
      label: 'October 2026 TaskPoints Championship',
      monthKey: '2026-10',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      status: 'preview',
      seeds: seeds(80)
    }
  };
  const result = builder.lockConfiguredSeasonBracket(state, builder.createSeasonThreePreset());

  assert.equal(result.ok, true);
  assert.equal(result.season.seeds.length, 60);
  assert.equal(result.season.meta.seasonMatchupControlEnabled, true);
});
