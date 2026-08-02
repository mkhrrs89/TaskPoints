;(function installSeasonMatchupMaterializationGuard(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__seasonMatchupMaterializationGuardInstalled) return;
  core.__seasonMatchupMaterializationGuardInstalled = true;

  const ALLOWED_CONTROL_STATUSES = new Set(['locked', 'active']);
  const originalShouldUseSeasonMatchupControl = typeof core.shouldUseSeasonMatchupControl === 'function'
    ? core.shouldUseSeasonMatchupControl.bind(core)
    : null;
  const originalBuildSeasonDailySlate = typeof core.buildSeasonDailySlate === 'function'
    ? core.buildSeasonDailySlate.bind(core)
    : null;
  const originalMaterializeSeasonSlateMatchupsForDate = typeof core.materializeSeasonSlateMatchupsForDate === 'function'
    ? core.materializeSeasonSlateMatchupsForDate.bind(core)
    : null;
  const originalRepairSeasonControlledScheduleFromSyncedSeason = typeof core.repairSeasonControlledScheduleFromSyncedSeason === 'function'
    ? core.repairSeasonControlledScheduleFromSyncedSeason.bind(core)
    : null;

  function rowDateKey(row) {
    if (!row || typeof row !== 'object') return '';
    const candidates = [row.dateKey, row.date, row.dayKey, row.dateISO, row.completedAtISO, row.createdAtISO];
    for (const candidate of candidates) {
      if (candidate == null || candidate === '') continue;
      const text = String(candidate);
      const direct = text.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
      const parsed = new Date(candidate);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    }
    return '';
  }

  function seasonStatusAllowsControl(state) {
    return ALLOWED_CONTROL_STATUSES.has(String(state?.currentSeason?.status || ''));
  }

  function collectReferencedSeasonMatchupIds(season) {
    const ids = new Set();
    Object.values(season?.series || {}).forEach((series) => {
      (Array.isArray(series?.gameResults) ? series.gameResults : []).forEach((result) => {
        const id = String(result?.matchupId || result?.id || '').trim();
        if (id) ids.add(id);
      });
    });
    return ids;
  }

  function hasExplicitSeasonEvidence(row, season, referencedIds) {
    if (!row || typeof row !== 'object') return false;
    const id = String(row.id || row.matchupId || '').trim();
    if (id && referencedIds.has(id)) return true;

    const type = String(row.matchupType || '').trim().toLowerCase();
    if (type === 'tournament' || type === 'season') return true;

    if (
      row.seriesId
      || row.seasonSeriesId
      || row.roundId
      || row.roundName
      || row.gameNumber != null
      || row.seriesGameNumber != null
      || row.bestOf != null
      || row.winsNeeded != null
    ) return true;

    const seasonId = String(season?.id || '').trim();
    if (seasonId && id.includes(`${seasonId}_`)) return true;
    return false;
  }

  function isLegacyBlankTypeDailyRow(row, dateKey, season, referencedIds) {
    if (!row || rowDateKey(row) !== dateKey) return false;
    if (!row.playerAId || !row.playerBId) return false;
    if (String(row.matchupType || '').trim()) return false;
    if (hasExplicitSeasonEvidence(row, season, referencedIds)) return false;

    const rowSeasonId = String(row.seasonId || '').trim();
    const currentSeasonId = String(season?.id || '').trim();
    if (rowSeasonId && currentSeasonId && rowSeasonId !== currentSeasonId) return false;
    return true;
  }

  function shouldUseGuardedSeasonControl(state, dateKey) {
    if (!seasonStatusAllowsControl(state)) return false;
    if (originalShouldUseSeasonMatchupControl) {
      return originalShouldUseSeasonMatchupControl(state, dateKey) === true;
    }
    return Boolean(
      state?.currentSeason
      && state.currentSeason.meta?.seasonMatchupControlEnabled === true
      && dateKey
    );
  }

  function classifyLegacyRowsForDate(stateInput, dateKey) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const season = state.currentSeason;
    if (!season || !shouldUseGuardedSeasonControl(state, dateKey)) {
      return { state, changed: false, classifiedCount: 0 };
    }

    const referencedIds = collectReferencedSeasonMatchupIds(season);
    let classifiedCount = 0;

    const classify = (row) => {
      if (!isLegacyBlankTypeDailyRow(row, dateKey, season, referencedIds)) return row;
      classifiedCount += 1;
      return {
        ...row,
        matchupType: 'exhibition',
        seasonId: row.seasonId || season.id || '',
        seasonMatchupLabel: row.seasonMatchupLabel || 'Exhibition',
        legacySeasonExhibition: true
      };
    };

    const matchups = (Array.isArray(state.matchups) ? state.matchups : []).map(classify);
    const schedule = (Array.isArray(state.schedule) ? state.schedule : []).map((day) => {
      if (rowDateKey(day) !== dateKey || !Array.isArray(day?.matchups)) return day;
      return { ...day, matchups: day.matchups.map(classify) };
    });

    if (!classifiedCount) return { state, changed: false, classifiedCount: 0 };
    return {
      state: { ...state, matchups, schedule },
      changed: true,
      classifiedCount
    };
  }

  function preflightLegacyClassification(state, dateKey, options) {
    const prepared = classifyLegacyRowsForDate(state, dateKey);
    if (!prepared.changed || !originalBuildSeasonDailySlate) {
      return { ...prepared, safe: true, slate: null };
    }

    const slate = originalBuildSeasonDailySlate(state, dateKey, options || {});
    if (slate?.ok === false) {
      return { ...prepared, state, changed: false, safe: false, slate };
    }
    return { ...prepared, safe: true, slate };
  }

  function blockedMaterializationResult(state, slate = null) {
    return {
      state,
      changed: false,
      materializedCount: 0,
      removedExhibitionCount: 0,
      removedStaleSeasonCount: 0,
      reclassifiedLegacyExhibitionCount: 0,
      warnings: Array.isArray(slate?.warnings) ? slate.warnings : [],
      errors: Array.isArray(slate?.errors) ? slate.errors : []
    };
  }

  if (originalShouldUseSeasonMatchupControl) {
    core.shouldUseSeasonMatchupControl = function guardedShouldUseSeasonMatchupControl(state, dateKey) {
      return seasonStatusAllowsControl(state)
        && originalShouldUseSeasonMatchupControl(state, dateKey) === true;
    };
  }

  if (originalBuildSeasonDailySlate) {
    core.buildSeasonDailySlate = function guardedBuildSeasonDailySlate(state, dateKey, options = {}) {
      if (String(state?.currentSeason?.status || '') === 'champion_crowned') {
        return {
          ok: false,
          dateKey,
          tournamentMatchups: [],
          exhibitionMatchups: [],
          allMatchups: [],
          warnings: [],
          errors: ['Season matchup control is closed after the champion is crowned.'],
          updatedSeason: state?.currentSeason || null
        };
      }
      return originalBuildSeasonDailySlate(state, dateKey, options);
    };
  }

  if (originalMaterializeSeasonSlateMatchupsForDate) {
    core.materializeSeasonSlateMatchupsForDate = function guardedMaterializeSeasonSlateMatchupsForDate(state, dateKey, options = {}) {
      if (String(state?.currentSeason?.status || '') === 'champion_crowned') {
        return blockedMaterializationResult(state);
      }

      const prepared = preflightLegacyClassification(state, dateKey, options);
      if (!prepared.safe) return blockedMaterializationResult(state, prepared.slate);

      const result = originalMaterializeSeasonSlateMatchupsForDate(prepared.state, dateKey, options);
      return {
        ...result,
        changed: Boolean(result?.changed || prepared.changed),
        reclassifiedLegacyExhibitionCount: prepared.classifiedCount || 0
      };
    };
  }

  if (originalRepairSeasonControlledScheduleFromSyncedSeason) {
    core.repairSeasonControlledScheduleFromSyncedSeason = function guardedRepairSeasonControlledScheduleFromSyncedSeason(state, options = {}) {
      const dateKey = String(
        options.todayDateKey
        || options.dateKey
        || (options.nowISO ? rowDateKey({ dateISO: options.nowISO }) : '')
        || rowDateKey({ dateISO: new Date() })
      ).slice(0, 10);

      if (String(state?.currentSeason?.status || '') === 'champion_crowned') {
        return { state, changed: false, repairedDates: [], reclassifiedLegacyExhibitionCount: 0 };
      }

      const prepared = preflightLegacyClassification(state, dateKey, options);
      if (!prepared.safe) {
        return {
          state,
          changed: false,
          repairedDates: [],
          reclassifiedLegacyExhibitionCount: 0,
          warnings: Array.isArray(prepared.slate?.warnings) ? prepared.slate.warnings : [],
          errors: Array.isArray(prepared.slate?.errors) ? prepared.slate.errors : []
        };
      }

      const result = originalRepairSeasonControlledScheduleFromSyncedSeason(prepared.state, options);
      return {
        ...result,
        changed: Boolean(result?.changed || prepared.changed),
        reclassifiedLegacyExhibitionCount: prepared.classifiedCount || 0
      };
    };
  }

  core.classifyLegacySeasonExhibitionsForDate = classifyLegacyRowsForDate;
  core.__seasonMatchupMaterializationGuard = {
    allowedStatuses: Array.from(ALLOWED_CONTROL_STATUSES),
    rowDateKey,
    collectReferencedSeasonMatchupIds,
    isLegacyBlankTypeDailyRow,
    classifyLegacyRowsForDate
  };
})(typeof window !== 'undefined' ? window : globalThis);
