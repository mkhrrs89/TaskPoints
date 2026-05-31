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

const core = global.TaskPointsCore;

test('computeCalLogBonusPoints handles edge cases', () => {
  assert.equal(core.computeCalLogBonusPoints([]), 0);
  assert.equal(core.computeCalLogBonusPoints([{ calories: 0 }]), 0);
  assert.equal(core.computeCalLogBonusPoints([{ calories: 0 }, { calories: '0' }]), 0);
  assert.equal(core.computeCalLogBonusPoints([{ calories: 10 }]), 2);
  assert.equal(core.computeCalLogBonusPoints([{ calories: 0 }, { calories: 10 }]), 2);
  assert.equal(core.computeCalLogBonusPoints([{ calories: NaN }, { calories: 0 }]), 0);
  assert.equal(core.computeCalLogBonusPoints([{ calories: -10 }]), 0);
});

test('computeCalLogBonusPoints uses configurable calories.logBonus', () => {
  const entries = [{ calories: 120 }];
  assert.equal(core.computeCalLogBonusPoints(entries, { scoringSettings: { calories: { logBonus: 3.5 } } }), 3.5);
  assert.equal(core.computeCalLogBonusPoints(entries, { scoringSettings: { calories: { logBonus: 0 } } }), 0);
});

test('aggregateCompletionsByDate adds/removes cal log bonus idempotently', () => {
  const dateIso = '2026-02-01T12:00:00.000Z';
  const entry = {
    id: 'cal-1',
    title: 'Calories (100)',
    completedAtISO: dateIso,
    calories: 100,
    points: 0,
  };

  let rollup = core.aggregateCompletionsByDate([entry], {});
  assert.equal(rollup.dailyTotals['2026-02-01'], 10 + 2);

  const edited = { ...entry, title: 'Calories (0)', calories: 0 };
  rollup = core.aggregateCompletionsByDate([edited], {});
  assert.equal(rollup.dailyTotals['2026-02-01'], 10);
});


test('saveStateSnapshot preserves existing reminders from stale snapshots', () => {
  storage.clear();
  const existing = core.normalizeState({
    tasks: [],
    reminders: [{ id: 'rem-1', text: 'Do not drop me', createdAtISO: '2026-05-28T12:00:00.000Z' }],
    completions: [],
    players: [],
    habits: [],
    flexActions: [],
    gameHistory: [],
    matchups: [],
    schedule: [],
    opponentDripSchedules: []
  });
  global.localStorage.setItem(core.STORAGE_KEY, JSON.stringify(existing));

  const stale = core.normalizeState({
    tasks: [],
    completions: [],
    players: [],
    habits: [],
    flexActions: [],
    gameHistory: [],
    matchups: [],
    schedule: [],
    opponentDripSchedules: []
  });
  core.saveStateSnapshot(stale, { storageKey: core.STORAGE_KEY });
  const saved = JSON.parse(global.localStorage.getItem(core.STORAGE_KEY));
  assert.equal(saved.reminders.length, 1);
  assert.equal(saved.reminders[0].text, 'Do not drop me');
});

test('saveStateSnapshot allows explicit reminder deletion by id', () => {
  storage.clear();
  const existing = core.normalizeState({
    tasks: [],
    reminders: [
      { id: 'rem-delete', text: 'Delete me', createdAtISO: '2026-05-28T12:00:00.000Z' },
      { id: 'rem-keep', text: 'Keep me', createdAtISO: '2026-05-28T12:01:00.000Z' }
    ],
    completions: [],
    players: [],
    habits: [],
    flexActions: [],
    gameHistory: [],
    matchups: [],
    schedule: [],
    opponentDripSchedules: []
  });
  global.localStorage.setItem(core.STORAGE_KEY, JSON.stringify(existing));

  const next = { ...existing, reminders: existing.reminders.filter((reminder) => reminder.id !== 'rem-delete') };
  core.saveStateSnapshot(next, { storageKey: core.STORAGE_KEY, deletedReminderIds: ['rem-delete'] });
  const saved = JSON.parse(global.localStorage.getItem(core.STORAGE_KEY));
  assert.deepEqual(saved.reminders.map((reminder) => reminder.id), ['rem-keep']);
});

test('normalizeState adds safe season championship defaults', () => {
  const normalized = core.normalizeState({});
  assert.equal(normalized.currentSeason, null);
  assert.equal(normalized.latestSeasonId, '');
  assert.deepEqual(normalized.seasonHistory, []);
});

test('normalizeState preserves existing fields while normalizing malformed season fields', () => {
  const normalized = core.normalizeState({
    tasks: [{ id: 'task-1', title: 'Keep task', status: 'active' }],
    reminders: [{ id: 'rem-1', text: 'Keep reminder' }],
    latestSeasonId: 123,
    seasonHistory: { bad: true },
    currentSeason: 'invalid'
  });

  assert.equal(normalized.tasks.length, 1);
  assert.equal(normalized.tasks[0].title, 'Keep task');
  assert.equal(normalized.reminders.length, 1);
  assert.equal(normalized.latestSeasonId, '');
  assert.deepEqual(normalized.seasonHistory, []);
  assert.equal(normalized.currentSeason, null);
});

test('season helper date windows and empty drafts are safe', () => {
  assert.equal(core.getSeasonRoundForDate('2026-06-02').id, 'play_in');
  assert.equal(core.getSeasonSeriesLength('finals'), 7);
  assert.equal(core.getSeasonDisplayName('round_of_32'), 'Round of 32');
  assert.equal(core.isJuneSeasonDate('2026-06-30'), true);
  assert.equal(core.isSeasonDate('2026-07-01'), false);

  const draft = core.createEmptySeasonDraft({ nowISO: '2026-05-29T00:00:00.000Z' });
  assert.equal(draft.name, 'June 2026 TaskPoints Championship');
  assert.equal(draft.status, 'preview');
  assert.deepEqual(draft.playerPool, []);
});

test('saveStateSnapshot preserves existing season fields from stale snapshots', () => {
  storage.clear();
  const existingSeason = core.createEmptySeasonDraft({
    nowISO: '2026-05-29T00:00:00.000Z',
    id: 'season-1'
  });
  const existing = core.normalizeState({
    tasks: [],
    reminders: [],
    completions: [],
    players: [],
    habits: [],
    flexActions: [],
    gameHistory: [],
    matchups: [],
    schedule: [],
    opponentDripSchedules: [],
    currentSeason: existingSeason,
    latestSeasonId: 'season-1',
    seasonHistory: [existingSeason]
  });
  global.localStorage.setItem(core.STORAGE_KEY, JSON.stringify(existing));

  const stale = core.normalizeState({
    tasks: [],
    reminders: [],
    completions: [],
    players: [],
    habits: [],
    flexActions: [],
    gameHistory: [],
    matchups: [],
    schedule: [],
    opponentDripSchedules: []
  });
  core.saveStateSnapshot(stale, { storageKey: core.STORAGE_KEY });
  const saved = JSON.parse(global.localStorage.getItem(core.STORAGE_KEY));
  assert.equal(saved.currentSeason.id, 'season-1');
  assert.equal(saved.latestSeasonId, 'season-1');
  assert.equal(saved.seasonHistory.length, 1);
});

require('../season.js');
const seasonUi = global.TaskPointsSeason;

test('season UI helpers render safe shell without creating a current season', () => {
  storage.clear();
  const before = storage.get(core.STORAGE_KEY);
  const html = seasonUi.renderSeasonView(core.normalizeState({}));
  const after = storage.get(core.STORAGE_KEY);

  assert.equal(before, after);
  assert.match(html, /Season 1/);
  assert.match(html, /June 2026 TaskPoints Championship/);
  assert.match(html, /Open this tab before June 1, 2026/);
  assert.match(html, /Best-of-7 Finals/);
});

test('season UI helpers render current season and trophy case states defensively', () => {
  const currentSeason = core.createEmptySeasonDraft({
    nowISO: '2026-05-29T00:00:00.000Z',
    status: 'active'
  });
  const currentHtml = seasonUi.renderSeasonView(core.normalizeState({ currentSeason }));
  assert.match(currentHtml, /Current Season/);
  assert.match(currentHtml, /Active/);
  assert.match(currentHtml, /2026-06/);
  assert.match(currentHtml, /Season tools will appear here in the next update/);

  const archivedHtml = seasonUi.renderSeasonView(core.normalizeState({
    seasonHistory: [{ ...currentSeason, currentSeason: null, championSummary: { name: 'Champion Bot' } }]
  }));
  assert.match(archivedHtml, /Trophy Case/);
  assert.match(archivedHtml, /Champion Bot/);
});


test('season preview load auto-creates dormant Season 1 only before June 1 when appropriate', () => {
  storage.clear();
  const originalLoadAppState = core.loadAppState;
  const baseState = core.normalizeState({
    players: Array.from({ length: 33 }, (_, index) => ({ id: `P${index + 1}`, name: `Player ${index + 1}`, active: true })),
    matchups: [{ id: 'normal-matchup', dateKey: '2026-05-20', playerAId: 'YOU', playerBId: 'P1', scoreA: 10, scoreB: 8 }]
  });
  core.loadAppState = () => ({ state: baseState });

  try {
    const loaded = seasonUi.loadSeasonState({ effectiveDateKey: '2026-05-29', nowISO: '2026-05-29T12:00:00.000Z' });
    assert.equal(loaded.currentSeason.status, 'preview');
    assert.equal(loaded.currentSeason.id, seasonUi.SEASON_ONE_ID);
    assert.equal(loaded.currentSeason.name, 'Season 1');
    assert.equal(loaded.currentSeason.label, 'June 2026 TaskPoints Championship');
    assert.equal(loaded.currentSeason.seedMode, 'auto');
    assert.equal(loaded.currentSeason.seeds.length, 34);
    assert.equal(loaded.matchups.length, 1);
    assert.equal(loaded.matchups[0].id, 'normal-matchup');

    const afterStart = seasonUi.prepareSeasonStateForPreview(baseState, { effectiveDateKey: '2026-06-01' });
    assert.equal(afterStart.state.currentSeason, null);
    assert.equal(afterStart.changed, false);

    const finalized = core.createEmptySeasonDraft({ id: seasonUi.SEASON_ONE_ID, status: 'finalized' });
    const withFinalized = seasonUi.prepareSeasonStateForPreview({ ...baseState, seasonHistory: [finalized] }, { effectiveDateKey: '2026-05-29' });
    assert.equal(withFinalized.state.currentSeason, null);
    assert.equal(withFinalized.changed, false);
  } finally {
    core.loadAppState = originalLoadAppState;
  }
});

test('season projected seeds are defensive with missing stats and render warnings', () => {
  const state = core.normalizeState({ players: [{ id: 'P1', name: 'No Stats Bot', active: true }] });
  const projected = seasonUi.generateProjectedSeeds(state);
  assert.equal(projected.seeds.length, 2);
  assert.ok(projected.seeds.every((seed) => Array.isArray(seed.warningFlags)));
  assert.ok(projected.warnings.some((warning) => warning.code === 'incomplete_seeding_data'));

  const season = seasonUi.createSeasonOnePreview(state, { nowISO: '2026-05-29T12:00:00.000Z' });
  const html = seasonUi.renderSeasonView(core.normalizeState({ currentSeason: season }));
  assert.match(html, /Warning: 2 players have incomplete seeding data/);
  assert.match(html, /Affected players/);
});

test('season projected bracket contains expected Play-In and Round of 32 structure', () => {
  const seeds = Array.from({ length: 34 }, (_, index) => ({
    seed: index + 1,
    playerId: `P${index + 1}`,
    playerName: `Player ${index + 1}`,
    wins: 0,
    losses: 0,
    winPct: 0,
    totalPoints: 0,
    averageScore: 0,
    marginOfVictory: null,
    warningFlags: []
  }));
  const bracket = seasonUi.buildProjectedBracket(seeds);
  const playIn = bracket.rounds.find((round) => round.id === 'play_in');
  const roundOf32 = bracket.rounds.find((round) => round.id === 'round_of_32');

  assert.deepEqual(playIn.matches.map((match) => match.competitors.map((competitor) => competitor.seed)), [[31, 34], [32, 33]]);
  assert.equal(roundOf32.matches.length, 16);
  assert.equal(roundOf32.matches[0].competitors[0].seed, 1);
  assert.equal(roundOf32.matches[0].competitors[1].label, 'Play-In Winner Low');
  assert.equal(roundOf32.matches[8].competitors[0].seed, 2);
  assert.equal(roundOf32.matches[8].competitors[1].label, 'Play-In Winner Other');
  assert.deepEqual(roundOf32.matches[1].competitors.map((competitor) => competitor.seed), [16, 17]);
  assert.deepEqual(roundOf32.matches[15].competitors.map((competitor) => competitor.seed), [11, 22]);
});

test('season manual reorder freezes seeds and rebuild from standings returns to auto mode', () => {
  const state = core.normalizeState({
    players: Array.from({ length: 4 }, (_, index) => ({ id: `P${index + 1}`, name: `Player ${index + 1}`, active: true }))
  });
  const season = seasonUi.createSeasonOnePreview(state, { nowISO: '2026-05-29T12:00:00.000Z' });
  const moved = seasonUi.applyManualSeedReorder(season, 0, 2, { nowISO: '2026-05-29T12:05:00.000Z' });
  assert.equal(moved.seedMode, 'manual');
  assert.equal(moved.seeds[2].playerId, season.seeds[0].playerId);
  assert.deepEqual(moved.seeds.map((seed) => seed.seed), [1, 2, 3, 4, 5]);
  assert.equal(moved.bracket.rounds.find((round) => round.id === 'round_of_32').matches.length, 16);

  const rebuiltManual = seasonUi.rebuildPreviewFromManualOrder(moved, { nowISO: '2026-05-29T12:10:00.000Z' });
  assert.equal(rebuiltManual.seedMode, 'manual');
  assert.equal(rebuiltManual.seeds[2].playerId, season.seeds[0].playerId);

  const rebuiltAuto = seasonUi.rebuildPreviewFromStandings(state, moved, { nowISO: '2026-05-29T12:15:00.000Z' });
  assert.equal(rebuiltAuto.seedMode, 'auto');
  assert.equal(rebuiltAuto.seeds.length, season.seeds.length);
});

test('season preview preparation leaves normal matchup generation data unchanged', () => {
  const matchups = [
    { id: 'm1', dateKey: '2026-05-20', playerAId: 'YOU', playerBId: 'P1', scoreA: 12, scoreB: 9 },
    { id: 'm2', dateKey: '2026-05-21', playerAId: 'P2', playerBId: 'P3', scoreA: 7, scoreB: 10 }
  ];
  const state = core.normalizeState({
    players: [
      { id: 'P1', name: 'Player 1', active: true },
      { id: 'P2', name: 'Player 2', active: true },
      { id: 'P3', name: 'Player 3', active: true }
    ],
    matchups
  });
  const before = JSON.stringify(state.matchups);
  const prepared = seasonUi.prepareSeasonStateForPreview(state, { effectiveDateKey: '2026-05-29', nowISO: '2026-05-29T12:00:00.000Z' });
  assert.equal(JSON.stringify(prepared.state.matchups), before);
  assert.equal(prepared.state.currentSeason.status, 'preview');
  assert.equal(prepared.state.currentSeason.series && Object.keys(prepared.state.currentSeason.series).length, 0);
  assert.equal(prepared.state.currentSeason.dailyTournamentResults && Object.keys(prepared.state.currentSeason.dailyTournamentResults).length, 0);
});

test('season load path unwraps loadAppState state wrapper for current season', () => {
  const originalLoadAppState = core.loadAppState;
  const currentSeason = core.createEmptySeasonDraft({
    nowISO: '2026-05-29T00:00:00.000Z',
    status: 'active'
  });

  core.loadAppState = () => ({
    state: core.normalizeState({ currentSeason }),
    storageKeysFound: [core.STORAGE_KEY]
  });

  try {
    const loaded = seasonUi.loadSeasonState();
    assert.equal(loaded.currentSeason.id, currentSeason.id);
    const html = seasonUi.renderSeasonView(loaded);
    assert.match(html, /Current Season/);
    assert.match(html, /Active/);
  } finally {
    core.loadAppState = originalLoadAppState;
  }
});

test('season load path unwraps loadAppState state wrapper for trophy case history', () => {
  const originalLoadAppState = core.loadAppState;
  const archivedSeason = core.createEmptySeasonDraft({
    nowISO: '2026-05-29T00:00:00.000Z',
    status: 'finalized',
    championSummary: { name: 'Archive Champ' }
  });

  core.loadAppState = () => ({
    state: core.normalizeState({ seasonHistory: [archivedSeason] }),
    storageKeysFound: [core.STORAGE_KEY]
  });

  try {
    const loaded = seasonUi.loadSeasonState();
    assert.equal(loaded.seasonHistory.length, 1);
    const html = seasonUi.renderSeasonView(loaded);
    assert.match(html, /Trophy Case/);
    assert.match(html, /Archive Champ/);
  } finally {
    core.loadAppState = originalLoadAppState;
  }
});

test('season load path still accepts raw state objects defensively', () => {
  const originalLoadAppState = core.loadAppState;
  const currentSeason = core.createEmptySeasonDraft({ nowISO: '2026-05-29T00:00:00.000Z' });
  core.loadAppState = () => core.normalizeState({ currentSeason });

  try {
    const loaded = seasonUi.loadSeasonState();
    assert.equal(loaded.currentSeason.id, currentSeason.id);
  } finally {
    core.loadAppState = originalLoadAppState;
  }
});

function makeOfficialSeasonSeedList(count = 34) {
  return Array.from({ length: count }, (_, index) => ({
    seed: index + 1,
    playerId: `P${index + 1}`,
    playerName: `Player ${index + 1}`,
    wins: 0,
    losses: 0,
    winPct: 0,
    totalPoints: 0,
    averageScore: 0,
    marginOfVictory: null,
    warningFlags: []
  }));
}

test('official season bracket creation from 34 seeds creates Play-In, Round of 32, and later placeholders', () => {
  const seeds = makeOfficialSeasonSeedList();
  const bracket = core.buildOfficialSeasonBracketFromSeeds(seeds, { seasonId: 'season_1_june_2026', nowISO: '2026-05-31T12:00:00.000Z' });
  const series = core.createOfficialSeasonSeriesFromSeeds(seeds, { seasonId: 'season_1_june_2026', nowISO: '2026-05-31T12:00:00.000Z' });
  const byRound = (roundId) => Object.values(series).filter((item) => item.roundId === roundId);

  assert.equal(bracket.type, 'official_34_player_championship');
  assert.equal(byRound('play_in').length, 2);
  assert.equal(byRound('round_of_32').length, 16);
  assert.equal(byRound('sweet_16').length, 8);
  assert.equal(byRound('quarterfinals').length, 4);
  assert.equal(byRound('semifinals').length, 2);
  assert.equal(byRound('finals').length, 1);
  assert.equal(byRound('round_of_32').sort((a, b) => a.seriesIndex - b.seriesIndex)[0].placeholderB, 'Lowest Play-In winner');
  assert.equal(byRound('round_of_32').sort((a, b) => a.seriesIndex - b.seriesIndex)[8].placeholderB, 'Other Play-In winner');
  assert.match(byRound('sweet_16')[0].placeholderA, /Winner of Series/);
});

test('locking a season preview creates official series while preserving normal matchups', () => {
  const matchups = [{ id: 'normal-matchup', dateKey: '2026-05-20', playerAId: 'P1', playerBId: 'P2' }];
  const preview = core.createEmptySeasonDraft({
    id: 'season_1_june_2026',
    status: 'preview',
    seedMode: 'manual',
    seeds: makeOfficialSeasonSeedList(),
    warnings: [{ code: 'keep_me', message: 'Preserve warning' }],
    meta: { seedSource: 'test' }
  });
  const lockedState = core.lockSeasonPreviewToOfficialBracket(core.normalizeState({ currentSeason: preview, matchups }), { nowISO: '2026-05-31T12:00:00.000Z' });

  assert.equal(lockedState.currentSeason.status, 'locked');
  assert.equal(lockedState.currentSeason.seedMode, 'manual');
  assert.equal(lockedState.currentSeason.warnings[0].code, 'keep_me');
  assert.equal(lockedState.currentSeason.meta.seedSource, 'test');
  assert.equal(lockedState.currentSeason.meta.seedsLocked, true);
  assert.equal(Object.keys(lockedState.currentSeason.series).length, 33);
  assert.deepEqual(lockedState.matchups, matchups);
});

test('Play-In winner resolution uses NBA-style protection for seeds 31 and 33', () => {
  let season = core.createEmptySeasonDraft({
    id: 'season_1_june_2026',
    status: 'locked',
    seeds: makeOfficialSeasonSeedList(),
    series: core.createOfficialSeasonSeriesFromSeeds(makeOfficialSeasonSeedList(), { seasonId: 'season_1_june_2026' })
  });
  const playIn = Object.values(season.series).filter((item) => item.roundId === 'play_in').sort((a, b) => a.seriesIndex - b.seriesIndex);
  for (let i = 0; i < 2; i += 1) {
    const result = core.recordSeasonSeriesGameResult(season, playIn[0].id, { dateKey: `2026-06-0${i + 1}`, matchupId: `pi1-${i}`, winnerId: 'P31', loserId: 'P34', source: 'manual' });
    assert.equal(result.ok, true);
    season = result.season;
  }
  for (let i = 0; i < 2; i += 1) {
    const result = core.recordSeasonSeriesGameResult(season, playIn[1].id, { dateKey: `2026-06-0${i + 1}`, matchupId: `pi2-${i}`, winnerId: 'P33', loserId: 'P32', source: 'manual' });
    assert.equal(result.ok, true);
    season = result.season;
  }
  const resolved = core.resolvePlayInWinnersIntoRoundOf32(season, { nowISO: '2026-06-03T12:00:00.000Z' });
  assert.equal(resolved.ok, true);
  const roundOf32 = Object.values(resolved.season.series).filter((item) => item.roundId === 'round_of_32').sort((a, b) => a.seriesIndex - b.seriesIndex);
  assert.equal(roundOf32[0].playerASeed, 1);
  assert.equal(roundOf32[0].playerBSeed, 33);
  assert.equal(roundOf32[8].playerASeed, 2);
  assert.equal(roundOf32[8].playerBSeed, 31);
});

test('season series game recording increments wins, rejects duplicates, and completes best-of lengths', () => {
  let season = core.createEmptySeasonDraft({
    id: 'season_1_june_2026',
    status: 'locked',
    seeds: makeOfficialSeasonSeedList(),
    series: core.createOfficialSeasonSeriesFromSeeds(makeOfficialSeasonSeedList(), { seasonId: 'season_1_june_2026' })
  });
  const playIn = Object.values(season.series).find((item) => item.roundId === 'play_in' && item.seriesIndex === 1);
  let result = core.recordSeasonSeriesGameResult(season, playIn.id, { dateKey: '2026-06-01', matchupId: 'dupe', winnerId: 'P31', loserId: 'P34', playerAScore: 90, playerBScore: 80, source: 'manual' });
  assert.equal(result.ok, true);
  assert.equal(result.series.winsA, 1);
  assert.equal(result.series.winsB, 0);
  const duplicate = core.recordSeasonSeriesGameResult(result.season, playIn.id, { dateKey: '2026-06-01', matchupId: 'dupe', winnerId: 'P31', loserId: 'P34', source: 'manual' });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error, 'duplicate_game_result');
  result = core.recordSeasonSeriesGameResult(result.season, playIn.id, { dateKey: '2026-06-02', matchupId: 'g2', winnerId: 'P31', loserId: 'P34', source: 'manual' });
  assert.equal(result.ok, true);
  assert.equal(result.series.status, 'complete');
  assert.equal(result.series.winnerId, 'P31');
  assert.equal(result.series.loserId, 'P34');
  assert.equal(core.isSeasonSeriesComplete(result.series), true);

  season = result.season;
  const bestOfFive = Object.values(season.series).find((item) => item.roundId === 'round_of_32' && item.seriesIndex === 2);
  for (let i = 0; i < 2; i += 1) {
    result = core.recordSeasonSeriesGameResult(season, bestOfFive.id, { dateKey: `2026-06-0${i + 4}`, matchupId: `r32-${i}`, winnerId: 'P16', loserId: 'P17', source: 'manual' });
    assert.equal(result.ok, true);
    season = result.season;
    assert.notEqual(result.series.status, 'complete');
  }
  result = core.recordSeasonSeriesGameResult(season, bestOfFive.id, { dateKey: '2026-06-06', matchupId: 'r32-2', winnerId: 'P16', loserId: 'P17', source: 'manual' });
  assert.equal(result.series.status, 'complete');
  assert.equal(result.series.winnerId, 'P16');
});

test('Round of 32 advancement fills Sweet 16 placeholders', () => {
  let season = core.createEmptySeasonDraft({
    id: 'season_1_june_2026',
    status: 'locked',
    seeds: makeOfficialSeasonSeedList(),
    series: core.createOfficialSeasonSeriesFromSeeds(makeOfficialSeasonSeedList(), { seasonId: 'season_1_june_2026' })
  });
  const r32 = Object.values(season.series).find((item) => item.roundId === 'round_of_32' && item.seriesIndex === 2);
  for (let i = 0; i < 3; i += 1) {
    const result = core.recordSeasonSeriesGameResult(season, r32.id, { dateKey: `2026-06-0${i + 4}`, matchupId: `advance-${i}`, winnerId: 'P16', loserId: 'P17', source: 'manual' });
    assert.equal(result.ok, true);
    season = result.season;
  }
  const advanced = core.advanceSeasonSeriesWinner(season, r32.id, { nowISO: '2026-06-08T12:00:00.000Z' });
  assert.equal(advanced.ok, true);
  assert.equal(advanced.nextSeries.roundId, 'sweet_16');
  assert.equal(advanced.nextSeries.playerBId, 'P16');
  assert.equal(advanced.nextSeries.placeholderB, '');
});

test('official season helpers remain dormant and do not generate daily tournament matchups', () => {
  const state = core.normalizeState({
    matchups: [{ id: 'normal-matchup', dateKey: '2026-06-04', playerAId: 'P1', playerBId: 'P2' }],
    currentSeason: core.createEmptySeasonDraft({ id: 'season_1_june_2026', status: 'preview', seeds: makeOfficialSeasonSeedList() })
  });
  const beforeMatchups = JSON.stringify(state.matchups);
  const lockedState = core.lockSeasonPreviewToOfficialBracket(state, { nowISO: '2026-05-31T12:00:00.000Z' });

  assert.equal(JSON.stringify(lockedState.matchups), beforeMatchups);
  assert.equal(Object.keys(lockedState.currentSeason.dailyTournamentResults).length, 0);
  assert.equal(lockedState.currentSeason.series[Object.keys(lockedState.currentSeason.series)[0]].gameResults.length, 0);
  assert.equal(core.getActiveSeasonSeriesForDate(lockedState.currentSeason, '2026-06-04').length, 0);
});

function makeSeasonPlayers(count = 33) {
  return Array.from({ length: count }, (_, index) => ({
    id: `P${index + 1}`,
    name: `Player ${index + 1}`,
    active: true
  }));
}

function makeLockedSeasonWithControl(enabled = true) {
  const seeds = [{ seed: 1, playerId: 'YOU', playerName: 'You' }].concat(makeOfficialSeasonSeedList(33).map((seed, index) => ({ ...seed, seed: index + 2 })));
  return core.createEmptySeasonDraft({
    id: 'season_1_june_2026',
    status: 'locked',
    seeds,
    series: core.createOfficialSeasonSeriesFromSeeds(seeds, { seasonId: 'season_1_june_2026' }),
    meta: { seasonMatchupControlEnabled: enabled }
  });
}

test('Season matchup control gate requires feature flag, June 2026, valid status, official series, and players', () => {
  const baseState = core.normalizeState({ players: makeSeasonPlayers(), currentSeason: makeLockedSeasonWithControl(false) });
  assert.equal(core.shouldUseSeasonMatchupControl(baseState, '2026-06-01'), false);
  assert.equal(core.shouldUseSeasonMatchupControl({ ...baseState, currentSeason: makeLockedSeasonWithControl(true) }, '2026-07-01'), false);
  assert.equal(core.shouldUseSeasonMatchupControl({ ...baseState, players: [], currentSeason: makeLockedSeasonWithControl(true) }, '2026-06-01'), false);
  assert.equal(core.shouldUseSeasonMatchupControl({ ...baseState, currentSeason: { ...makeLockedSeasonWithControl(true), status: 'preview' } }, '2026-06-01'), false);
  assert.equal(core.shouldUseSeasonMatchupControl({ ...baseState, currentSeason: makeLockedSeasonWithControl(true) }, '2026-06-01'), true);
});

test('Season daily slate creates tournament games first and exhibitions without duplicate players', () => {
  const state = core.normalizeState({ players: makeSeasonPlayers(), currentSeason: makeLockedSeasonWithControl(true) });
  const slate = core.buildSeasonDailySlate(state, '2026-06-01', { random: () => 0.42 });
  assert.equal(slate.ok, true);
  assert.equal(slate.tournamentMatchups.length, 2);
  assert.equal(slate.exhibitionMatchups.length, 15);
  assert.equal(slate.allMatchups.length, 17);
  assert.ok(slate.allMatchups.slice(0, 2).every((matchup) => matchup.matchupType === 'tournament'));
  const participants = slate.allMatchups.flatMap((matchup) => [matchup.playerAId, matchup.playerBId]);
  assert.equal(new Set(participants).size, participants.length);
});

test('Season daily slate skips completed series and returns early-complete players to exhibitions later', () => {
  let season = makeLockedSeasonWithControl(true);
  const playIn = Object.values(season.series).find((item) => item.roundId === 'play_in' && item.seriesIndex === 1);
  let result = core.recordSeasonSeriesGameResult(season, playIn.id, { dateKey: '2026-06-01', matchupId: 'g1', winnerId: playIn.playerAId, loserId: playIn.playerBId, source: 'manual' });
  season = result.season;
  result = core.recordSeasonSeriesGameResult(season, playIn.id, { dateKey: '2026-06-02', matchupId: 'g2', winnerId: playIn.playerAId, loserId: playIn.playerBId, source: 'manual' });
  season = result.season;
  const state = core.normalizeState({ players: makeSeasonPlayers(), currentSeason: season });
  const slate = core.buildSeasonDailySlate(state, '2026-06-03', { random: () => 0.12 });
  assert.equal(slate.ok, true);
  assert.equal(slate.tournamentMatchups.some((matchup) => matchup.seriesId === playIn.id), false);
  assert.equal(slate.exhibitionMatchups.some((matchup) => matchup.playerAId === playIn.playerAId || matchup.playerBId === playIn.playerAId), true);
  assert.equal(slate.exhibitionMatchups.some((matchup) => matchup.playerAId === playIn.playerBId || matchup.playerBId === playIn.playerBId), true);
});

test('Season exhibition pairing avoids previous June pairings and falls back to least-recent repeat', () => {
  const history = new Map([
    [core.getPairingKey('A', 'B'), { lastDateKey: '2026-06-01' }],
    [core.getPairingKey('A', 'C'), { lastDateKey: '2026-06-03' }],
    [core.getPairingKey('A', 'D'), { lastDateKey: '2026-06-02' }],
    [core.getPairingKey('B', 'C'), { lastDateKey: '2026-06-04' }],
    [core.getPairingKey('B', 'D'), { lastDateKey: '2026-06-05' }],
    [core.getPairingKey('C', 'D'), { lastDateKey: '2026-06-06' }]
  ]);
  const fallback = core.generateRandomNonRepeatPairs(['A', 'B', 'C', 'D'], history, { random: () => 0 });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.relaxedRepeatCount, 2);
  assert.equal(fallback.pairs.some((pair) => core.getPairingKey(pair.playerAId, pair.playerBId) === core.getPairingKey('A', 'B')), true);

  const avoid = core.generateRandomNonRepeatPairs(['A', 'B', 'C', 'D'], new Map([[core.getPairingKey('A', 'B'), { lastDateKey: '2026-06-01' }]]), { random: () => 0.1 });
  assert.equal(avoid.ok, true);
  assert.equal(avoid.pairs.some((pair) => core.getPairingKey(pair.playerAId, pair.playerBId) === core.getPairingKey('A', 'B')), false);
});

test('Season result sync records tournament results once, ignores exhibitions, and advances completed Play-In', () => {
  const season = makeLockedSeasonWithControl(true);
  const playIn = Object.values(season.series).find((item) => item.roundId === 'play_in' && item.seriesIndex === 1);
  let state = core.normalizeState({
    players: makeSeasonPlayers(),
    currentSeason: season,
    matchups: [
      { id: 't1', dateKey: '2026-06-01', seasonId: season.id, seriesId: playIn.id, matchupType: 'tournament', playerAId: playIn.playerAId, playerBId: playIn.playerBId, scoreA: 90, scoreB: 80 },
      { id: 'ex1', dateKey: '2026-06-01', seasonId: season.id, matchupType: 'exhibition', playerAId: 'P1', playerBId: 'P2', scoreA: 1, scoreB: 2 }
    ]
  });
  let synced = core.syncSeasonResultsFromDailyMatchups(state, '2026-06-01');
  assert.equal(synced.changed, true);
  assert.equal(synced.updatedSeason.series[playIn.id].gameResults.length, 1);
  synced = core.syncSeasonResultsFromDailyMatchups(synced.state, '2026-06-01');
  assert.equal(synced.updatedSeason.series[playIn.id].gameResults.length, 1);

  state = core.normalizeState({
    ...synced.state,
    matchups: synced.state.matchups.concat({ id: 't2', dateKey: '2026-06-02', seasonId: season.id, seriesId: playIn.id, matchupType: 'tournament', playerAId: playIn.playerAId, playerBId: playIn.playerBId, scoreA: 95, scoreB: 70 })
  });
  synced = core.syncSeasonResultsFromDailyMatchups(state, '2026-06-02');
  assert.equal(synced.updatedSeason.series[playIn.id].status, 'complete');
  assert.equal(synced.updatedSeason.series[playIn.id].winnerId, playIn.playerAId);
});

test('Round of 32 slate activates all ready fixed series after Play-In resolves', () => {
  let season = makeLockedSeasonWithControl(true);
  const playIn = Object.values(season.series).filter((item) => item.roundId === 'play_in').sort((a, b) => a.seriesIndex - b.seriesIndex);
  playIn.forEach((series, index) => {
    for (let game = 1; game <= 2; game += 1) {
      const result = core.recordSeasonSeriesGameResult(season, series.id, {
        dateKey: `2026-06-0${game}`,
        matchupId: `pi-${index}-${game}`,
        winnerId: series.playerAId,
        loserId: series.playerBId,
        source: 'manual'
      });
      assert.equal(result.ok, true);
      season = result.season;
    }
  });
  const resolved = core.resolvePlayInWinnersIntoRoundOf32(season, { nowISO: '2026-06-03T12:00:00.000Z' });
  assert.equal(resolved.ok, true);
  season = { ...resolved.season, meta: { ...resolved.season.meta, seasonMatchupControlEnabled: true } };
  const state = core.normalizeState({ players: makeSeasonPlayers(), currentSeason: season });
  const slate = core.buildSeasonDailySlate(state, '2026-06-04', { random: () => 0.2 });
  assert.equal(slate.ok, true);
  assert.equal(slate.tournamentMatchups.length, 16);
  assert.equal(slate.exhibitionMatchups.length, 1);
  assert.equal(slate.allMatchups.length, 17);
  assert.equal(slate.updatedSeason.series[slate.tournamentMatchups.find((matchup) => matchup.playerAId === 'P15' && matchup.playerBId === 'P16').seriesId].status, 'active');
});

test('Season schedule cache validity invalidates stale June normal schedules only when control applies', () => {
  const enabledState = core.normalizeState({ players: makeSeasonPlayers(), currentSeason: makeLockedSeasonWithControl(true) });
  const cachedNormalJune = {
    date: '2026-06-01',
    participantSignature: 'unchanged',
    matchups: [{ playerAId: 'YOU', playerBId: 'P1' }]
  };
  assert.equal(core.shouldRegenerateScheduleDayForSeasonControl(enabledState, '2026-06-01', cachedNormalJune), true);

  const slate = core.buildSeasonDailySlate(enabledState, '2026-06-01', { random: () => 0.3 });
  const validSeasonDay = {
    date: '2026-06-01',
    participantSignature: 'unchanged',
    seasonMatchupControl: true,
    seasonScheduleSignature: core.getSeasonScheduleSignature({ ...enabledState, currentSeason: slate.updatedSeason }, '2026-06-01'),
    matchups: slate.allMatchups
  };
  assert.equal(core.isValidSeasonControlledScheduleDay({ ...enabledState, currentSeason: slate.updatedSeason }, '2026-06-01', validSeasonDay), true);
  assert.equal(core.shouldRegenerateScheduleDayForSeasonControl({ ...enabledState, currentSeason: slate.updatedSeason }, '2026-06-01', validSeasonDay), false);

  assert.equal(core.shouldRegenerateScheduleDayForSeasonControl(enabledState, '2026-07-01', { date: '2026-07-01', matchups: [] }), false);
  const disabledState = core.normalizeState({ players: makeSeasonPlayers(), currentSeason: makeLockedSeasonWithControl(false) });
  assert.equal(core.shouldRegenerateScheduleDayForSeasonControl(disabledState, '2026-06-01', cachedNormalJune), false);
});

test('edited tournament result sync updates existing result and recalculates series wins', () => {
  const season = makeLockedSeasonWithControl(true);
  const playIn = Object.values(season.series).find((item) => item.roundId === 'play_in' && item.seriesIndex === 1);
  let state = core.normalizeState({
    players: makeSeasonPlayers(),
    currentSeason: season,
    matchups: [{ id: 'edit-one', dateKey: '2026-06-01', seasonId: season.id, seriesId: playIn.id, matchupType: 'tournament', playerAId: playIn.playerAId, playerBId: playIn.playerBId, scoreA: 90, scoreB: 80 }]
  });
  let synced = core.syncSeasonResultsFromDailyMatchups(state, '2026-06-01');
  assert.equal(synced.changed, true);
  state = core.normalizeState({
    ...synced.state,
    matchups: [{ ...synced.state.matchups[0], scoreA: 70, scoreB: 95 }]
  });
  synced = core.syncSeasonResultsFromDailyMatchups(state, '2026-06-01');
  assert.equal(synced.changed, true);
  const updated = synced.updatedSeason.series[playIn.id];
  assert.equal(updated.gameResults.length, 1);
  assert.equal(updated.gameResults[0].winnerId, playIn.playerBId);
  assert.equal(updated.winsA, 0);
  assert.equal(updated.winsB, 1);
});

test('unchanged duplicate sync is no-op but winner-changing edits warn safely', () => {
  const season = makeLockedSeasonWithControl(true);
  const playIn = Object.values(season.series).find((item) => item.roundId === 'play_in' && item.seriesIndex === 1);
  let state = core.normalizeState({
    players: makeSeasonPlayers(),
    currentSeason: season,
    matchups: [
      { id: 'winner-change-1', dateKey: '2026-06-01', seasonId: season.id, seriesId: playIn.id, matchupType: 'tournament', playerAId: playIn.playerAId, playerBId: playIn.playerBId, scoreA: 90, scoreB: 80 },
      { id: 'winner-change-2', dateKey: '2026-06-02', seasonId: season.id, seriesId: playIn.id, matchupType: 'tournament', playerAId: playIn.playerAId, playerBId: playIn.playerBId, scoreA: 70, scoreB: 85 },
      { id: 'winner-change-3', dateKey: '2026-06-03', seasonId: season.id, seriesId: playIn.id, matchupType: 'tournament', playerAId: playIn.playerAId, playerBId: playIn.playerBId, scoreA: 88, scoreB: 81 }
    ]
  });
  ['2026-06-01', '2026-06-02', '2026-06-03'].forEach((dateKey) => {
    const synced = core.syncSeasonResultsFromDailyMatchups(state, dateKey);
    state = synced.state;
  });
  let series = state.currentSeason.series[playIn.id];
  assert.equal(series.winnerId, playIn.playerAId);
  const duplicate = core.syncSeasonResultsFromDailyMatchups(state, '2026-06-03');
  assert.equal(duplicate.changed, false);

  state = core.normalizeState({
    ...state,
    matchups: state.matchups.map((matchup) => matchup.id === 'winner-change-3' ? { ...matchup, scoreA: 75, scoreB: 92 } : matchup)
  });
  const edited = core.syncSeasonResultsFromDailyMatchups(state, '2026-06-03');
  assert.equal(edited.changed, true);
  assert.equal(edited.warnings.some((warning) => /manual admin repair/.test(warning)), true);
  series = edited.updatedSeason.series[playIn.id];
  assert.equal(series.winnerId, playIn.playerBId);
  assert.equal(series.winsA, 1);
  assert.equal(series.winsB, 2);
});

test('season series presentation helpers render status and placeholders defensively', () => {
  const pending = { roundName: 'Round of 32', bestOf: 5, placeholderA: 'Winner of A', playerBName: 'Rocco', playerBSeed: 29 };
  assert.equal(core.getSeriesStatusText(pending), 'Awaiting opponent');
  assert.match(core.getSeriesCompactTitle(pending), /Winner of A vs #29 Rocco/);

  const active = { playerAId: 'P1', playerAName: 'Miggy', playerASeed: 4, playerBId: 'P2', playerBName: 'Rocco', playerBSeed: 29, winsA: 2, winsB: 1, bestOf: 5, winsNeeded: 3, status: 'active' };
  assert.equal(core.getSeriesStatusText(active), 'Miggy leads series 2–1');
  assert.equal(core.getSeriesGameNumber({ ...active, gameResults: [{ winnerId: 'P1' }, { winnerId: 'P2' }, { winnerId: 'P1' }] }, '2026-06-07'), 4);
  assert.equal(core.isSeasonEliminationGame(active), true);
});

test('expanded season series details render with missing placeholders', () => {
  const season = core.createEmptySeasonDraft({ status: 'active' });
  const html = seasonUi.renderSeasonView(core.normalizeState({ currentSeason: { ...season, series: {
    s1: { id: 's1', roundId: 'round_of_32', roundName: 'Round of 32', roundIndex: 1, seriesIndex: 1, bestOf: 5, winsNeeded: 3, status: 'pending', placeholderA: 'Winner of Play-In', placeholderB: 'Awaiting opponent', gameResults: [] }
  } } }));
  assert.match(html, /Winner of Play-In vs Awaiting opponent/);
  assert.match(html, /No game results recorded yet/);
});

test('eliminated players are derived from completed series', () => {
  const season = { series: {
    s1: { id: 's1', roundId: 'sweet_16', roundName: 'Sweet 16', roundIndex: 2, playerAId: 'P1', playerAName: 'Miggy', playerASeed: 4, playerBId: 'P2', playerBName: 'Rocco', playerBSeed: 29, winsA: 3, winsB: 1, winnerId: 'P1', loserId: 'P2', status: 'complete' }
  } };
  const eliminated = core.getEliminatedPlayers(season);
  assert.equal(eliminated.length, 1);
  assert.equal(eliminated[0].playerName, 'Rocco');
  assert.equal(eliminated[0].eliminatedByName, 'Miggy');
  assert.equal(eliminated[0].roundLost, 'Sweet 16');
});

test('featured matchup priority prefers finals, elimination, tied, then seed quality', () => {
  const season = { series: {
    a: { id: 'a', roundId: 'round_of_32', roundName: 'Round of 32', roundIndex: 1, seriesIndex: 1, playerAId: 'P1', playerAName: 'One', playerASeed: 1, playerBId: 'P32', playerBName: 'Thirty Two', playerBSeed: 32, winsA: 2, winsB: 0, bestOf: 5, winsNeeded: 3, status: 'active' },
    b: { id: 'b', roundId: 'finals', roundName: 'Finals', roundIndex: 5, seriesIndex: 1, playerAId: 'P2', playerAName: 'Two', playerASeed: 2, playerBId: 'P3', playerBName: 'Three', playerBSeed: 3, winsA: 1, winsB: 1, bestOf: 7, winsNeeded: 4, status: 'active' }
  } };
  const featured = core.getFeaturedSeasonMatchup(season, '2026-06-24', { matchups: [{ dateKey: '2026-06-24', matchupType: 'tournament', seriesId: 'b' }] });
  assert.equal(featured.series.id, 'b');
  assert.match(featured.title, /#2 Two vs #3 Three/);
});

test('user season status handles active, eliminated, awaiting fallback, and exhibition', () => {
  const base = core.normalizeState({ youName: 'Miggy', currentSeason: { seeds: [{ playerId: 'YOU', playerName: 'Miggy', seed: 4 }], series: {} } });
  const activeSeason = { seeds: base.currentSeason.seeds, series: { s: { id: 's', roundId: 'quarterfinals', roundName: 'Quarterfinals', playerAId: 'YOU', playerAName: 'Miggy', playerBId: 'R', playerBName: 'Rick', winsA: 2, winsB: 1, bestOf: 5, winsNeeded: 3, status: 'active', gameResults: [{}, {}, {}] } } };
  assert.match(core.getUserSeasonStatus(activeSeason, '2026-06-16', { ...base, currentSeason: activeSeason }).statusText, /Miggy vs Rick — Quarterfinals, Game 4/);

  const eliminatedSeason = { seeds: base.currentSeason.seeds, series: { s: { id: 's', roundId: 'sweet_16', roundName: 'Sweet 16', playerAId: 'YOU', playerAName: 'Miggy', playerBId: 'D', playerBName: 'Delilah', winsA: 1, winsB: 3, winnerId: 'D', loserId: 'YOU', status: 'complete', bestOf: 5, winsNeeded: 3 } } };
  assert.match(core.getUserSeasonStatus(eliminatedSeason, '2026-06-12', { ...base, currentSeason: eliminatedSeason }).statusText, /Miggy is eliminated/);

  const awaitingSeason = { seeds: base.currentSeason.seeds, series: { s: { id: 's', roundId: 'semifinals', roundName: 'Semifinals', playerAId: 'YOU', playerAName: 'Miggy', placeholderB: 'Winner of Jax vs Poppy', bestOf: 5, winsNeeded: 3, status: 'pending' } } };
  assert.match(core.getUserSeasonStatus(awaitingSeason, '2026-06-20', { ...base, currentSeason: awaitingSeason }).statusText, /Miggy is awaiting opponent/);

  const exhibition = core.getUserSeasonStatus({ seeds: base.currentSeason.seeds, series: {} }, '2026-06-10', { ...base, matchups: [{ dateKey: '2026-06-10', matchupType: 'exhibition', playerAId: 'YOU', playerBId: 'C', playerBName: 'Cooper' }], players: [{ id: 'C', name: 'Cooper' }] });
  assert.match(exhibition.statusText, /Today: exhibition matchup vs Cooper/);

  const none = core.getUserSeasonStatus({ seeds: base.currentSeason.seeds, series: {} }, '2026-06-10', base);
  assert.match(none.statusText, /no tournament game today/);
});

test('champion summary helper handles completed Finals', () => {
  const season = { series: {
    f: { id: 'f', roundId: 'finals', roundName: 'Finals', roundIndex: 5, playerAId: 'P1', playerAName: 'Miggy', playerBId: 'P2', playerBName: 'Rick', winsA: 4, winsB: 2, winnerId: 'P1', loserId: 'P2', status: 'complete', gameResults: [{ winnerId: 'P1', loserId: 'P2', playerAScore: 10, playerBScore: 8 }] }
  } };
  const summary = core.getChampionSummary(season, {});
  assert.equal(summary.championName, 'Miggy');
  assert.match(summary.finalsResult, /Miggy defeats Rick, 4–2/);
  assert.equal(summary.record, '1–0');
});

test('matchups grouping helper remains inactive for normal non-Season days', () => {
  const season = core.createEmptySeasonDraft({ status: 'active' });
  const featured = core.getFeaturedSeasonMatchup(season, '2026-07-02', { matchups: [{ dateKey: '2026-07-02', playerAId: 'YOU', playerBId: 'P1' }] });
  assert.equal(featured, null);
});
