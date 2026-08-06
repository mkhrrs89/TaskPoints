from pathlib import Path

GUARD = Path('season_result_integrity_guard.js')
TEST = Path('tests/season_result_integrity_guard.test.js')

guard = GUARD.read_text(encoding='utf-8')
old_wrapper = '''  if (original.backfillLateBoundSeasonSeriesResults) c.backfillLateBoundSeasonSeriesResults = function backfillFixed(state, seasonArg, options = {}) {
    const season = seasonArg || state?.currentSeason;
    if (season?.monthKey && String(season.monthKey).slice(0, 7) !== '2026-06') return { ok: true, state, season, updatedSeason: season, changed: false, backfilledCount: 0, seriesIds: [], skippedIncompatibleSeason: true };
    return original.backfillLateBoundSeasonSeriesResults(state, seasonArg, options);
  };
'''
new_wrapper = '''  if (original.backfillLateBoundSeasonSeriesResults) c.backfillLateBoundSeasonSeriesResults = function backfillFixed(state, seasonArg, options = {}) {
    return original.backfillLateBoundSeasonSeriesResults(state, seasonArg, options);
  };
'''
if new_wrapper not in guard:
    if old_wrapper not in guard:
        raise SystemExit('Could not locate June-only late-bound backfill wrapper')
    guard = guard.replace(old_wrapper, new_wrapper, 1)
GUARD.write_text(guard, encoding='utf-8')

test = TEST.read_text(encoding='utf-8')
old_test = '''test('June-specific late-bound backfill is skipped for an August season', () => {
  const { core } = createHarness();
  const seasonState = { id: 'season_2_august_2026', monthKey: '2026-08', series: {} };
  const result = core.backfillLateBoundSeasonSeriesResults({ currentSeason: seasonState }, seasonState, {});
  assert.equal(result.changed, false);
  assert.equal(result.backfilledCount, 0);
  assert.equal(result.skippedIncompatibleSeason, true);
});'''
new_test = '''test('late-bound backfill wrapper delegates August seasons to the season-aware core', () => {
  const { core } = createHarness();
  const seasonState = {
    id: 'season_2_august_2026',
    monthKey: '2026-08',
    dateWindows: [{ id: 'round_of_32', startDate: '2026-08-04', endDate: '2026-08-08' }],
    series: {}
  };
  const state = { currentSeason: seasonState };
  const result = core.backfillLateBoundSeasonSeriesResults(state, seasonState, {
    nowISO: '2026-08-06T10:10:00-04:00'
  });
  assert.equal(result.changed, true);
  assert.equal(result.backfilledCount, 3);
  assert.equal(result.state, state);
  assert.equal(result.updatedSeason, seasonState);
  assert.equal(result.skippedIncompatibleSeason, undefined);
});'''
if new_test not in test:
    if old_test not in test:
        raise SystemExit('Could not locate June-only wrapper regression test')
    test = test.replace(old_test, new_test, 1)
TEST.write_text(test, encoding='utf-8')
