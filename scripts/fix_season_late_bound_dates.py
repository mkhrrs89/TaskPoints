from pathlib import Path

CORE = Path('scoring_core.js')
TEST = Path('tests/season_late_bound_date_windows.test.js')

core = CORE.read_text(encoding='utf-8')

old_helper = '''  function getSeasonRoundPlayedDatesBefore(roundId, todayDateKey) {
    const round = JUNE_2026_SEASON_DATE_WINDOWS.find((item) => item.id === roundId);
    if (!round || !todayDateKey || todayDateKey <= round.startDate) return [];
    const endExclusive = todayDateKey <= round.endDate ? todayDateKey : adjacentLocalDateKey(round.endDate, 1);
    const dates = [];
    let current = round.startDate;
    while (current && current < endExclusive && current <= round.endDate) {
      dates.push(current);
      current = adjacentLocalDateKey(current, 1);
    }
    return dates;
  }
'''
new_helper = '''  function getSeasonRoundPlayedDatesBefore(roundId, todayDateKey, seasonOrState = null) {
    const season = seasonOrState?.currentSeason || seasonOrState || null;
    const round = getSeasonDateWindowsForSeason(season).find((item) => item.id === roundId);
    if (!round || !todayDateKey || todayDateKey <= round.startDate) return [];
    const endExclusive = todayDateKey <= round.endDate ? todayDateKey : adjacentLocalDateKey(round.endDate, 1);
    const dates = [];
    let current = round.startDate;
    while (current && current < endExclusive && current <= round.endDate) {
      dates.push(current);
      current = adjacentLocalDateKey(current, 1);
    }
    return dates;
  }
'''
if new_helper not in core:
    if old_helper not in core:
        raise SystemExit('Could not locate hard-coded Season round date helper')
    core = core.replace(old_helper, new_helper, 1)

old_call = "    const missedDates = getSeasonRoundPlayedDatesBefore('round_of_32', today);"
new_call = "    const missedDates = getSeasonRoundPlayedDatesBefore('round_of_32', today, season);"
if new_call not in core:
    if old_call not in core:
        raise SystemExit('Could not locate late-bound Round of 32 date call')
    core = core.replace(old_call, new_call, 1)

CORE.write_text(core, encoding='utf-8')

TEST.write_text(r'''const test = require('node:test');
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

function lateBoundSeries(index, protectedSeed, opponentId) {
  return {
    id: `season_2_august_2026_round_of_32_${index}`,
    seasonId: 'season_2_august_2026',
    roundId: 'round_of_32',
    roundName: 'Round of 32',
    roundIndex: 1,
    seriesIndex: index,
    playerAId: `seed-${protectedSeed}`,
    playerAName: `Seed ${protectedSeed}`,
    playerASeed: protectedSeed,
    playerBId: opponentId,
    playerBName: opponentId,
    playerBSeed: protectedSeed === 1 ? 34 : 32,
    bestOf: 5,
    winsNeeded: 3,
    winsA: 0,
    winsB: 0,
    winnerId: '',
    loserId: '',
    status: 'active',
    gameResults: []
  };
}

function augustState() {
  const first = lateBoundSeries(1, 1, 'play-in-winner-low');
  const ninth = lateBoundSeries(9, 2, 'play-in-winner-other');
  return core.normalizeState({
    currentSeason: {
      id: 'season_2_august_2026',
      monthKey: '2026-08',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      status: 'active',
      dateWindows: [
        { id: 'play_in', startDate: '2026-08-01', endDate: '2026-08-03', bestOf: 3 },
        { id: 'round_of_32', startDate: '2026-08-04', endDate: '2026-08-08', bestOf: 5 },
        { id: 'sweet_16', startDate: '2026-08-09', endDate: '2026-08-13', bestOf: 5 }
      ],
      bracket: {
        type: 'official_34_player_championship',
        roundOrder: ['play_in', 'round_of_32', 'sweet_16', 'quarterfinals', 'semifinals', 'finals']
      },
      series: {
        [first.id]: first,
        [ninth.id]: ninth
      }
    }
  });
}

test('August late-bound Round of 32 catch-up uses August dates rather than June defaults', () => {
  const state = augustState();
  const repair = core.backfillLateBoundSeasonSeriesResults(state, state.currentSeason, {
    nowISO: '2026-08-06T09:26:00-04:00'
  });

  assert.equal(repair.ok, true);
  assert.equal(repair.backfilledCount, 4);

  for (const seriesId of [
    'season_2_august_2026_round_of_32_1',
    'season_2_august_2026_round_of_32_9'
  ]) {
    const series = repair.updatedSeason.series[seriesId];
    assert.deepEqual(series.gameResults.map((result) => result.dateKey), ['2026-08-04', '2026-08-05']);
    assert.equal(series.gameResults.some((result) => String(result.dateKey).startsWith('2026-06')), false);
    assert.equal((Number(series.winsA) || 0) + (Number(series.winsB) || 0), 2);
    assert.equal(series.winnerId, '');
    assert.equal(series.status, 'active');

    const summary = core.getSeasonSeriesRecordedResultSummary(
      repair.state,
      repair.updatedSeason,
      series,
      { nowISO: '2026-08-06T09:26:00-04:00' }
    );
    assert.equal(summary.winsA, Number(series.winsA) || 0);
    assert.equal(summary.winsB, Number(series.winsB) || 0);
    assert.deepEqual(summary.gameResults.map((result) => result.dateKey), ['2026-08-04', '2026-08-05']);
  }
});

test('August late-bound catch-up remains idempotent and never creates a current-day result', () => {
  const state = augustState();
  const first = core.backfillLateBoundSeasonSeriesResults(state, state.currentSeason, {
    nowISO: '2026-08-06T09:26:00-04:00'
  });
  const second = core.backfillLateBoundSeasonSeriesResults(first.state, first.updatedSeason, {
    nowISO: '2026-08-06T10:00:00-04:00'
  });

  assert.equal(second.changed, false);
  assert.equal(second.backfilledCount, 0);
  const dates = second.updatedSeason.series.season_2_august_2026_round_of_32_1.gameResults
    .map((result) => result.dateKey);
  assert.deepEqual(dates, ['2026-08-04', '2026-08-05']);
  assert.equal(dates.includes('2026-08-06'), false);
});
''', encoding='utf-8')
