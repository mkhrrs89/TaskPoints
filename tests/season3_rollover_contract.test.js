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
assert(season.includes("startDate: '2026-10-01', endDate: '2026-10-03'"));
assert(season.includes("startDate: '2026-10-25', endDate: '2026-10-31'"));
assert(season.includes("bufferDays: isOctoberSeasonThree ? ['2026-10-24']"));
assert(season.includes("seedRankingScope: isOctoberSeasonThree ? 'season3'"));
assert(season.includes('value="Season 3"'));
assert(season.includes('value="2026-10-01"'));
assert(season.includes('value="2026-10-31"'));
assert(season.includes("this Season's configured tournament dates"));

assert(core.includes('const OCTOBER_2026_SEASON_DATE_WINDOWS = ['));
assert(core.includes('return OCTOBER_2026_SEASON_DATE_WINDOWS.map'));
assert(core.includes("seasonId.includes('october_2026')"));

console.log('Season 3 rollover contract OK');
