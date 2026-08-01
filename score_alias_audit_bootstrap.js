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

  function filterVariableSeedAudits(checks, state) {
    if (!Array.isArray(checks)) return checks;
    return checks
      .filter((check) => !OMITTED_VARIABLE_SEED_AUDIT_IDS.has(String(check?.id || '')))
      .map((check) => String(check?.id || '') === SEASON_SCORE_ALIAS_AUDIT_ID
        ? buildNarrowSeasonScoreAliasAudit(state, check)
        : check);
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
