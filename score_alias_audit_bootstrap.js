;(function installTaskPointsScoreAliasAuditBootstrap(global) {
  'use strict';

  const document = global.document;
  const location = global.location;
  if (!document || !location) return;

  const OMITTED_VARIABLE_SEED_AUDIT_IDS = new Set([
    'season-seed-count-34',
    'season-seeds-continuous',
    'season-play-in-pairings'
  ]);
  const SEASON_SCORE_ALIAS_AUDIT_ID = 'season-matchup-score-fields-aligned';
  const SEASON_ADVANCEMENT_AUDIT_ID = 'season-winners-advanced-correctly';
  let variableSeedFilterAttempts = 0;

  function populated(value) {
    return value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
  }

  function finiteScore(value) {
    if (!populated(value)) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function currentSeasonForAudit(state) {
    if (typeof global.getCurrentSeasonForAudit === 'function') {
      try { return global.getCurrentSeasonForAudit(state); } catch (_) {}
    }
    return state?.currentSeason || null;
  }

  function seasonSeriesListForAudit(season) {
    if (typeof global.getSeasonSeriesListForAudit === 'function') {
      try {
        const series = global.getSeasonSeriesListForAudit(season);
        if (Array.isArray(series)) return series;
      } catch (_) {}
    }
    if (Array.isArray(season?.series)) return season.series;
    if (season?.series && typeof season.series === 'object') return Object.values(season.series);
    return [];
  }

  function recordedSeriesId(matchup) {
    const helper = global.TaskPointsCore?.getRecordedSeriesId;
    if (typeof helper === 'function') {
      try {
        const value = helper(matchup);
        if (populated(value)) return String(value).trim();
      } catch (_) {}
    }
    const value = matchup?.seriesId || matchup?.seasonSeriesId || '';
    return populated(value) ? String(value).trim() : '';
  }

  function seriesIdSetForSeason(season) {
    const ids = new Set();
    seasonSeriesListForAudit(season).forEach((series) => {
      [series?.id, series?.seriesId, series?.seasonSeriesId].forEach((value) => {
        if (populated(value)) ids.add(String(value).trim());
      });
    });
    return ids;
  }

  function isExplicitCurrentSeasonTournamentMatchup(matchup, season, currentSeriesIds) {
    if (!matchup || typeof matchup !== 'object') return false;

    const type = String(matchup.matchupType || '').trim().toLowerCase();
    if (type && type !== 'tournament' && type !== 'season') return false;

    const seasonId = populated(season?.id || season?.seasonId)
      ? String(season.id || season.seasonId).trim()
      : '';
    const matchupSeasonId = populated(matchup.seasonId)
      ? String(matchup.seasonId).trim()
      : '';
    if (seasonId && matchupSeasonId && seasonId !== matchupSeasonId) return false;

    const seriesId = recordedSeriesId(matchup);
    if (seriesId && currentSeriesIds.size && !currentSeriesIds.has(seriesId)) return false;

    if (type === 'tournament' || type === 'season') return true;
    return Boolean(seriesId && (!currentSeriesIds.size || currentSeriesIds.has(seriesId)));
  }

  function buildNarrowSeasonScoreAliasAudit(state, previousCheck) {
    const season = currentSeasonForAudit(state);
    const currentSeriesIds = seriesIdSetForSeason(season);
    const issues = [];

    (Array.isArray(state?.matchups) ? state.matchups : []).forEach((matchup) => {
      if (!isExplicitCurrentSeasonTournamentMatchup(matchup, season, currentSeriesIds)) return;

      const scoreA = finiteScore(matchup?.scoreA);
      const scoreB = finiteScore(matchup?.scoreB);
      const playerAScore = finiteScore(matchup?.playerAScore);
      const playerBScore = finiteScore(matchup?.playerBScore);
      if (scoreA == null || scoreB == null || playerAScore == null || playerBScore == null) return;
      if (scoreA === playerAScore && scoreB === playerBScore) return;

      const date = matchup?.dateKey || matchup?.date || 'undated';
      const id = matchup?.id || matchup?.matchupId || 'matchup';
      issues.push(`${date} ${id}: scoreA/scoreB ${scoreA}–${scoreB} disagree with playerAScore/playerBScore ${playerAScore}–${playerBScore}.`);
    });

    return {
      ...previousCheck,
      status: !season ? 'WARN' : (issues.length ? 'FAIL' : 'PASS'),
      expected: 'Explicit current-season tournament matchups keep scoreA/scoreB and playerAScore/playerBScore aligned when both pairs are present',
      actual: !season
        ? 'No current season found'
        : (issues.length
            ? `${issues.length} explicit tournament matchup score field divergence(s)`
            : 'No explicit current-season tournament matchup score field divergence found'),
      details: issues,
      trace: 'state.matchups[] with tournament/season type or current-season series link'
    };
  }

  function seasonSeriesId(series) {
    return String(series?.id || series?.seriesId || series?.seasonSeriesId || '').trim();
  }

  function seasonRoundId(series) {
    return String(series?.roundId || series?.round || '').trim().toLowerCase();
  }

  function seasonSeriesName(series) {
    if (typeof global.getSeriesDisplayNameForAudit === 'function') {
      try {
        const value = global.getSeriesDisplayNameForAudit(series);
        if (populated(value)) return String(value);
      } catch (_) {}
    }
    return String(series?.roundName || series?.displayName || seasonSeriesId(series) || 'Series');
  }

  function seasonPlayerName(state, playerId) {
    if (!playerId) return 'missing winner';
    if (String(playerId).toUpperCase() === 'YOU') return state?.youName || 'You';
    const player = (Array.isArray(state?.players) ? state.players : [])
      .find((row) => row && String(row.id || row.playerId || '') === String(playerId));
    return player?.name || player?.playerName || String(playerId);
  }

  function seasonSeriesWinnerId(series) {
    if (typeof global.getSeriesWinnerIdForAudit === 'function') {
      try {
        const value = global.getSeriesWinnerIdForAudit(series);
        if (populated(value)) return String(value).trim();
      } catch (_) {}
    }
    return String(series?.winnerId || '').trim();
  }

  function seasonSeriesLoserId(series, winnerId = seasonSeriesWinnerId(series)) {
    if (typeof global.getSeriesLoserIdForAudit === 'function') {
      try {
        const value = global.getSeriesLoserIdForAudit(series);
        if (populated(value)) return String(value).trim();
      } catch (_) {}
    }
    if (populated(series?.loserId)) return String(series.loserId).trim();
    const playerAId = String(series?.playerAId || '').trim();
    const playerBId = String(series?.playerBId || '').trim();
    if (winnerId && winnerId === playerAId) return playerBId;
    if (winnerId && winnerId === playerBId) return playerAId;
    return '';
  }

  function seasonSeriesIsComplete(series) {
    if (typeof global.isSeriesCompleteForAudit === 'function') {
      try { return global.isSeriesCompleteForAudit(series) === true; } catch (_) {}
    }
    const status = String(series?.status || series?.state || '').trim().toLowerCase();
    if (['complete', 'completed', 'final', 'finalized', 'finished'].includes(status)) return true;
    const winnerId = seasonSeriesWinnerId(series);
    if (!winnerId) return false;
    const winsNeeded = Number(series?.winsNeeded) || Math.floor((Number(series?.bestOf) || 1) / 2) + 1;
    const winsA = Number(series?.winsA) || 0;
    const winsB = Number(series?.winsB) || 0;
    return winsA >= winsNeeded || winsB >= winsNeeded;
  }

  function seasonAdvancementTarget(series) {
    const nextSeriesId = String(
      series?.nextSeriesId
      || series?.advancesTo?.seriesId
      || series?.advancesToSeriesId
      || ''
    ).trim();
    const nextSlot = String(
      series?.nextSlot
      || series?.advancesTo?.slot
      || series?.advancesToSlot
      || ''
    ).trim().toUpperCase();
    return { nextSeriesId, nextSlot };
  }

  function usesDynamicPlayInAdvancement(season, seriesList) {
    const playInSeries = seriesList.filter((series) => seasonRoundId(series) === 'play_in');
    if (!playInSeries.length) return false;

    const presetId = String(
      season?.bracket?.presetId
      || season?.bracketConfig?.presetId
      || season?.meta?.bracketBuilderPresetId
      || ''
    ).trim();
    if (presetId && presetId !== 'legacy_34_player') return true;

    const roundOrder = Array.isArray(season?.bracket?.roundOrder)
      ? season.bracket.roundOrder.map((value) => String(value).toLowerCase())
      : [];
    if (roundOrder.includes('opening_round')) return true;
    if (playInSeries.length !== 2) return true;

    const byId = new Map(seriesList.map((series) => [seasonSeriesId(series), series]));
    return playInSeries.some((series) => {
      const { nextSeriesId } = seasonAdvancementTarget(series);
      const target = byId.get(nextSeriesId);
      return target && seasonRoundId(target) !== 'round_of_32';
    });
  }

  function buildDynamicSeasonAdvancementAudit(state, previousCheck) {
    const season = currentSeasonForAudit(state);
    const seriesList = seasonSeriesListForAudit(season);
    if (!season || !usesDynamicPlayInAdvancement(season, seriesList)) return previousCheck;

    const seriesById = new Map();
    seriesList.forEach((series) => {
      [series?.id, series?.seriesId, series?.seasonSeriesId].forEach((value) => {
        if (populated(value)) seriesById.set(String(value).trim(), series);
      });
    });

    const issues = [];
    const checked = [];
    const checkedByRound = new Map();

    seriesList.filter(seasonSeriesIsComplete).forEach((series) => {
      const { nextSeriesId, nextSlot } = seasonAdvancementTarget(series);
      if (!nextSeriesId && !nextSlot) return;

      const label = seasonSeriesName(series);
      const winnerId = seasonSeriesWinnerId(series);
      const loserId = seasonSeriesLoserId(series, winnerId);
      const target = seriesById.get(nextSeriesId) || null;
      checked.push(series);
      const roundName = String(series?.roundName || seasonRoundId(series) || 'Round');
      checkedByRound.set(roundName, (checkedByRound.get(roundName) || 0) + 1);

      if (!winnerId) {
        issues.push(`${label}: completed series has no winner to advance.`);
        return;
      }
      if (!nextSeriesId || !['A', 'B'].includes(nextSlot)) {
        issues.push(`${label}: advancement metadata is incomplete (${nextSeriesId || 'missing target'}, slot ${nextSlot || 'missing'}).`);
        return;
      }
      if (!target) {
        issues.push(`${label}: target ${nextSeriesId} slot ${nextSlot} does not exist.`);
        return;
      }

      const actualId = String(nextSlot === 'B' ? target.playerBId || '' : target.playerAId || '').trim();
      if (actualId !== winnerId) {
        const actualLabel = actualId ? `${seasonPlayerName(state, actualId)} (${actualId})` : 'empty';
        const loserNote = loserId && actualId === loserId ? ' — the loser advanced' : '';
        issues.push(`${label}: expected winner ${seasonPlayerName(state, winnerId)} (${winnerId}) in ${seasonSeriesName(target)} slot ${nextSlot}; found ${actualLabel}${loserNote}.`);
      }
    });

    const summaries = Array.from(checkedByRound.entries()).map(([roundName, count]) => (
      `${roundName}: ${count} completed series winner${count === 1 ? '' : 's'} checked against declared next-round destination${count === 1 ? '' : 's'}.`
    ));
    const status = issues.length ? 'FAIL' : (checked.length ? 'PASS' : 'WARN');

    return {
      ...previousCheck,
      status,
      expected: 'Every completed series winner appears in the next series and slot declared by that series’ advancement metadata',
      actual: issues.length
        ? `${issues.length} advancement issue(s) across ${checked.length} checked completed series`
        : (checked.length
            ? `${checked.length} completed-series advancement target(s) checked; all correct`
            : 'No completed series with declared advancement metadata are available to check'),
      details: issues.length ? issues : summaries,
      trace: 'currentSeason.series nextSeriesId/nextSlot/advancesTo resolved against the configured dynamic bracket'
    };
  }

  function filterVariableSeedAudits(checks, state) {
    if (!Array.isArray(checks)) return checks;
    return checks
      .filter((check) => !OMITTED_VARIABLE_SEED_AUDIT_IDS.has(String(check?.id || '')))
      .map((check) => {
        const id = String(check?.id || '');
        if (id === SEASON_SCORE_ALIAS_AUDIT_ID) return buildNarrowSeasonScoreAliasAudit(state, check);
        if (id === SEASON_ADVANCEMENT_AUDIT_ID) return buildDynamicSeasonAdvancementAudit(state, check);
        return check;
      });
  }

  function installVariableSeedAuditFilter() {
    if (global.__taskpointsVariableSeedAuditFilterInstalled) return true;
    const original = global.buildSeasonChampionshipAuditChecks;
    if (typeof original !== 'function') {
      variableSeedFilterAttempts += 1;
      if (variableSeedFilterAttempts < 120) global.setTimeout?.(installVariableSeedAuditFilter, 50);
      return false;
    }

    function buildVariableSeedSeasonChampionshipAuditChecks(...args) {
      return filterVariableSeedAudits(original.apply(this, args), args[0]);
    }
    Object.defineProperty(buildVariableSeedSeasonChampionshipAuditChecks, '__taskpointsVariableSeedAuditFilterInstalled', {
      value: true,
      configurable: true
    });
    global.buildSeasonChampionshipAuditChecks = buildVariableSeedSeasonChampionshipAuditChecks;
    global.__taskpointsVariableSeedAuditFilterInstalled = true;
    return true;
  }

  installVariableSeedAuditFilter();

  let attempts = 0;
  function install() {
    if (!document.getElementById('auditChecks')) return;
    if (document.getElementById('scoreAliasRepairPanel')) return;
    const api = global.TaskPointsScoreAliasConsistency;
    if (!api?.installAuditRepairPanel) {
      attempts += 1;
      if (attempts < 120) global.setTimeout?.(install, 50);
      return;
    }

    const originalUrl = `${location.pathname}${location.search}${location.hash}`;
    const pathAlreadyCompatible = String(location.pathname || '').endsWith('/audit.html') || location.pathname === 'audit.html';

    try {
      if (!pathAlreadyCompatible && global.history?.replaceState) {
        global.history.replaceState(global.history.state, '', `/audit.html${location.search}${location.hash}`);
      }
      api.installAuditRepairPanel();
    } finally {
      if (!pathAlreadyCompatible && global.history?.replaceState) {
        global.history.replaceState(global.history.state, '', originalUrl);
      }
    }
  }

  function installOnReady() {
    installVariableSeedAuditFilter();
    install();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installOnReady, { once: true });
  } else {
    installOnReady();
  }
})(typeof window !== 'undefined' ? window : globalThis);
