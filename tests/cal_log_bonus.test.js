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
