const fs = require('fs');
const assert = require('assert');

const standings = fs.readFileSync('standings.html', 'utf8');
const rankings = fs.readFileSync('rankings.html', 'utf8');
const season = fs.readFileSync('season.js', 'utf8');
const seeds = fs.readFileSync('season_seed_sources.js', 'utf8');
const core = fs.readFileSync('scoring_core.js', 'utf8');

for (const scope of ['season3', 'season2', 'season1', 'lifetime']) assert(standings.includes(`data-standings-scope="${scope}"`));
assert(standings.includes('key >= STANDINGS_SEASON_TWO_START && key < STANDINGS_SEASON_THREE_START'));
assert(standings.includes('key >= STANDINGS_SEASON_THREE_START && key < STANDINGS_SEASON_THREE_END_EXCLUSIVE'));
assert(standings.includes('taskpoints_standings_scope_season3_rollover_v1'));

for (const scope of ['season3', 'season2', 'season1', 'overall']) assert(rankings.includes(`data-rankings-scope="${scope}"`));
assert(rankings.includes('key >= RANKINGS_SEASON_TWO_START && key < RANKINGS_SEASON_THREE_START'));
assert(rankings.includes('key >= RANKINGS_SEASON_THREE_START && key < RANKINGS_SEASON_THREE_END_EXCLUSIVE'));
assert(rankings.includes('taskpoints_rankings_scope_season3_rollover_v1'));

assert(seeds.includes("const SCOPE_SEASON_THREE = 'season3'"));
assert(seeds.includes("const SEASON_THREE_START_DATE = '2026-09-01'"));
assert(seeds.includes("const SEASON_THREE_TOURNAMENT_START_DATE = '2026-10-01'"));
assert(seeds.includes('key >= SEASON_THREE_START_DATE && key < SEASON_THREE_TOURNAMENT_START_DATE'));

assert(season.includes("const SEASON_THREE_ID = 'season_3_october_2026'"));
assert(season.includes("const SEASON_THREE_START_DATE = '2026-10-01'"));
assert(season.includes("const SEASON_THREE_END_DATE = '2026-10-31'"));
assert(season.includes("const SEASON_THREE_ENTRANT_COUNT = 60"));
assert(season.includes("startDate: '2026-10-01', endDate: '2026-10-01', displayName: 'Play-In', bestOf: 1"));
assert(season.includes("id: 'opening_round', startDate: '2026-10-02', endDate: '2026-10-04'"));
assert(season.includes("id: 'round_of_32', startDate: '2026-10-05', endDate: '2026-10-09'"));
assert(season.includes("id: 'round_of_16', startDate: '2026-10-10', endDate: '2026-10-14'"));
assert(season.includes("id: 'quarterfinals', startDate: '2026-10-15', endDate: '2026-10-19'"));
assert(season.includes("id: 'semifinals', startDate: '2026-10-20', endDate: '2026-10-24'"));
assert(season.includes("startDate: '2026-10-25', endDate: '2026-10-31', displayName: 'Finals', bestOf: 7"));
assert(season.includes("qualificationRule: isOctoberSeasonThree ? 'top_60_season3_rankings'"));
assert(season.includes("bufferDays: isOctoberSeasonThree ? []"));
assert(season.includes("seedMode: isOctoberSeasonThree ? AUTO_SEED_MODE : MANUAL_SEED_MODE"));
assert(season.includes("usesSeasonThreeRankingScope = mode === AUTO_SEED_MODE && currentSeason.seedRankingScope === 'season3'"));
assert(season.includes("seedRankingScope: isOctoberSeasonThree ? 'season3'"));
assert(season.includes('value="Season 3"'));
assert(season.includes('value="2026-10-01"'));
assert(season.includes('value="2026-10-31"'));
assert(season.includes("this Season's configured tournament dates"));

assert(core.includes('const OCTOBER_2026_SEASON_DATE_WINDOWS = ['));
assert(core.includes("id: 'opening_round', startDate: '2026-10-02', endDate: '2026-10-04'"));
assert(core.includes("id: 'round_of_16', startDate: '2026-10-10', endDate: '2026-10-14'"));
assert(core.includes('return OCTOBER_2026_SEASON_DATE_WINDOWS.map'));
assert(core.includes("seasonId.includes('october_2026')"));

console.log('Season 3 rollover contract OK');
