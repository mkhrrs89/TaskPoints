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
