;(function installTaskPointsSeasonSeriesUpsetNotifications(global) {
  'use strict';

  if (global.TaskPointsSeasonSeriesUpsetNotifications?.installed) return;

  const VERSION = 1;
  const EVENT_PREFIX = 'season-series-seed-upset';
  const LEGACY_EVENT_PREFIX = 'series-upset';
  const INSTALL_RETRY_MS = 50;
  const MAX_INSTALL_ATTEMPTS = 240;
  const LOG_RECONCILE_QUIET_MS = 8000;
  let installAttempts = 0;
  let reconciliationTimer = null;
  let reconciliationRunning = false;
  let suppressRevisionQueue = false;
  let executionQuietDeferred = false;

  function dateKey(value) {
    if (value == null || value === '') return '';
    if (typeof global.TaskPointsCore?.dateKey === 'function') {
      try { return String(global.TaskPointsCore.dateKey(value) || '').slice(0, 10); } catch (_) {}
    }
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function addDays(dateKeyValue, amount) {
    if (typeof global.TaskPointsCore?.addDaysToDateKey === 'function') {
      try { return global.TaskPointsCore.addDaysToDateKey(dateKeyValue, amount); } catch (_) {}
    }
    const match = String(dateKeyValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return '';
    const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    parsed.setDate(parsed.getDate() + Number(amount || 0));
    return dateKey(parsed);
  }

  function revealDayKey(now = new Date()) {
    const shifted = new Date(now);
    if (Number.isNaN(shifted.getTime())) return '';
    if (shifted.getHours() < 5) shifted.setDate(shifted.getDate() - 1);
    shifted.setHours(0, 0, 0, 0);
    return dateKey(shifted);
  }

  function seriesWinnerId(series) {
    if (typeof global.TaskPointsCore?.getSeasonSeriesWinner === 'function') {
      try {
        const winner = global.TaskPointsCore.getSeasonSeriesWinner(series);
        if (winner) return String(winner);
      } catch (_) {}
    }
    if (series?.winnerId) return String(series.winnerId);
    const winsNeeded = Number(series?.winsNeeded) || Math.floor((Number(series?.bestOf) || 1) / 2) + 1;
    const winsA = Number(series?.winsA) || 0;
    const winsB = Number(series?.winsB) || 0;
    if (winsA >= winsNeeded && winsA > winsB) return String(series?.playerAId || '');
    if (winsB >= winsNeeded && winsB > winsA) return String(series?.playerBId || '');
    return '';
  }

  function seriesClinchDateKey(series) {
    const winnerId = seriesWinnerId(series);
    if (!winnerId) return '';
    const playerAId = String(series?.playerAId || '');
    const playerBId = String(series?.playerBId || '');
    const winsNeeded = Number(series?.winsNeeded) || Math.floor((Number(series?.bestOf) || 1) / 2) + 1;
    const results = (Array.isArray(series?.gameResults) ? series.gameResults : []).slice();

    results.sort((left, right) => {
      const leftGame = Number(left?.gameNumber ?? left?.seriesGameNumber ?? left?.game ?? 0);
      const rightGame = Number(right?.gameNumber ?? right?.seriesGameNumber ?? right?.game ?? 0);
      if (leftGame !== rightGame) return leftGame - rightGame;
      return dateKey(left?.dateKey || left?.date || left?.completedAtISO || left?.recordedAtISO)
        .localeCompare(dateKey(right?.dateKey || right?.date || right?.completedAtISO || right?.recordedAtISO));
    });

    let winsA = 0;
    let winsB = 0;
    for (const result of results) {
      const resultWinnerId = String(result?.winnerId || '');
      if (resultWinnerId === playerAId) winsA += 1;
      if (resultWinnerId === playerBId) winsB += 1;
      const resultDateKey = dateKey(
        result?.dateKey
        || result?.date
        || result?.completedAtISO
        || result?.recordedAtISO
      );
      if (winnerId === playerAId && winsA >= winsNeeded && winsA > winsB) return resultDateKey;
      if (winnerId === playerBId && winsB >= winsNeeded && winsB > winsA) return resultDateKey;
    }

    return dateKey(
      series?.completedDateKey
      || series?.winnerDateKey
      || series?.completedAtISO
      || series?.finalizedAtISO
    );
  }

  function seriesSeedForPlayer(series, playerId) {
    const normalizedPlayerId = String(playerId || '');
    const playerAId = String(series?.playerAId || '');
    const playerBId = String(series?.playerBId || '');
    const rawSeed = normalizedPlayerId === playerAId
      ? series?.playerASeed
      : (normalizedPlayerId === playerBId ? series?.playerBSeed : null);
    const seed = Number(rawSeed);
    return Number.isInteger(seed) && seed > 0 ? seed : null;
  }

  function roundName(series) {
    const roundId = series?.roundId || series?.round || '';
    let displayName = '';
    if (typeof global.TaskPointsCore?.getSeasonDisplayName === 'function') {
      try { displayName = global.TaskPointsCore.getSeasonDisplayName(roundId) || ''; } catch (_) {}
    }
    return String(series?.roundName || displayName || roundId || 'Tournament series')
      .replaceAll('_', ' ')
      .trim();
  }

  function seriesLabel(series) {
    const round = roundName(series);
    const explicit = String(
      series?.name
      || series?.seriesName
      || series?.matchupName
      || series?.displayName
      || series?.label
      || ''
    ).replaceAll('_', ' ').trim();
    const seriesIndex = Number(series?.seriesIndex);
    const detail = explicit || (
      Number.isInteger(seriesIndex) && seriesIndex >= 0
        ? `Series ${seriesIndex + 1}`
        : ''
    );
    if (!detail || detail.toLowerCase() === round.toLowerCase()) return round;
    return `${round} — ${detail}`;
  }

  function playerName(state, playerId, fallback = '') {
    const normalizedPlayerId = String(playerId || '');
    if (normalizedPlayerId === 'YOU') return String(state?.youName || '').trim() || 'You';
    const player = (Array.isArray(state?.players) ? state.players : [])
      .find((row) => String(row?.id || row?.playerId || '') === normalizedPlayerId);
    return String(player?.name || player?.playerName || fallback || normalizedPlayerId || 'Unknown Player');
  }

  function collectSeries(state) {
    const seasons = [];
    if (state?.currentSeason) seasons.push(state.currentSeason);
    (Array.isArray(state?.seasonHistory) ? state.seasonHistory : []).forEach((season) => {
      if (season) seasons.push(season);
    });

    const rows = [];
    const seen = new Set();
    seasons.forEach((season) => {
      const seasonId = String(season?.id || season?.seasonId || 'season');
      const seriesRows = [
        ...Object.values(season?.series && typeof season.series === 'object' ? season.series : {}),
        ...(Array.isArray(season?.seriesResults) ? season.seriesResults : [])
      ];
      seriesRows.forEach((series) => {
        if (!series) return;
        const seriesId = String(series?.id || series?.seriesId || series?.seasonSeriesId || '');
        if (!seriesId) return;
        const key = `${seasonId}:${seriesId}`;
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({ seasonId, seriesId, series });
      });
    });
    return rows;
  }

  function notificationForSeries(state, seasonId, seriesId, series, nowISO) {
    const winnerId = seriesWinnerId(series);
    if (!winnerId) return null;
    const playerAId = String(series?.playerAId || '');
    const playerBId = String(series?.playerBId || '');
    const loserId = winnerId === playerAId ? playerBId : (winnerId === playerBId ? playerAId : '');
    if (!loserId) return null;

    const winnerSeed = seriesSeedForPlayer(series, winnerId);
    const loserSeed = seriesSeedForPlayer(series, loserId);
    if (winnerSeed === null || loserSeed === null) return null;

    const eventDateKey = seriesClinchDateKey(series);
    const winnerIsA = winnerId === playerAId;
    const winnerWins = Number(winnerIsA ? series?.winsA : series?.winsB) || 0;
    const loserWins = Number(winnerIsA ? series?.winsB : series?.winsA) || 0;
    const winnerName = playerName(state, winnerId, winnerIsA ? series?.playerAName : series?.playerBName);
    const loserName = playerName(state, loserId, winnerIsA ? series?.playerBName : series?.playerAName);
    const displayRoundName = roundName(series);
    const displaySeriesLabel = seriesLabel(series);

    return {
      isUpset: winnerSeed > loserSeed,
      eventId: `${EVENT_PREFIX}:${seasonId}:${seriesId}`,
      legacyEventId: `${LEGACY_EVENT_PREFIX}:${seasonId}:${seriesId}`,
      message: {
        id: `${EVENT_PREFIX}:${seasonId}:${seriesId}`,
        type: 'series_upset',
        eventDateKey,
        title: `${displayRoundName} upset`,
        body: `${displaySeriesLabel}: #${winnerSeed} ${winnerName} upset #${loserSeed} ${loserName}, winning the series ${winnerWins}–${loserWins}.`,
        relatedPage: 'season.html',
        seasonId,
        seriesId,
        winnerId,
        loserId,
        winnerSeed,
        loserSeed,
        read: false,
        archived: false,
        createdAtISO: nowISO
      }
    };
  }

  function messageEquivalent(left, right) {
    const keys = [
      'type', 'eventDateKey', 'title', 'body', 'relatedPage',
      'seasonId', 'seriesId', 'winnerId', 'loserId', 'winnerSeed', 'loserSeed'
    ];
    return keys.every((key) => left?.[key] === right?.[key]);
  }

  function reconcileState(sourceState, options = {}) {
    const state = sourceState && typeof sourceState === 'object' ? sourceState : {};
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const nowISO = Number.isNaN(now.getTime()) ? new Date().toISOString() : now.toISOString();
    const latestRevealableDateKey = addDays(revealDayKey(now), -1);
    const messages = Array.isArray(state.inboxMessages) ? state.inboxMessages.slice() : [];
    const processed = state.inboxProcessedEventIds && typeof state.inboxProcessedEventIds === 'object' && !Array.isArray(state.inboxProcessedEventIds)
      ? { ...state.inboxProcessedEventIds }
      : {};
    let startedDateKey = String(state.inboxStartedDateKey || '').slice(0, 10);
    let changed = false;
    const addedMessages = [];
    const updatedMessages = [];

    if (!/^\d{4}-\d{2}-\d{2}$/.test(startedDateKey)) {
      startedDateKey = latestRevealableDateKey;
      changed = true;
    }

    const eligible = (value) => (
      /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
      && value >= startedDateKey
      && value <= latestRevealableDateKey
    );

    collectSeries(state).forEach(({ seasonId, seriesId, series }) => {
      const notification = notificationForSeries(state, seasonId, seriesId, series, nowISO);
      if (!notification || !eligible(notification.message.eventDateKey)) return;
      if (processed[notification.eventId]) return;

      processed[notification.eventId] = true;
      changed = true;
      if (!notification.isUpset) return;

      const currentIndex = messages.findIndex((message) => message?.id === notification.eventId);
      const legacyIndex = messages.findIndex((message) => message?.id === notification.legacyEventId);
      const targetIndex = currentIndex >= 0 ? currentIndex : legacyIndex;

      if (targetIndex >= 0) {
        const existing = messages[targetIndex];
        const next = {
          ...existing,
          ...notification.message,
          id: existing?.id || notification.message.id,
          read: existing?.read === true,
          archived: existing?.archived === true,
          createdAtISO: existing?.createdAtISO || notification.message.createdAtISO
        };
        if (!messageEquivalent(existing, next)) {
          messages[targetIndex] = next;
          updatedMessages.push(next);
          changed = true;
        }
        return;
      }

      messages.push(notification.message);
      addedMessages.push(notification.message);
      changed = true;
    });

    return {
      changed,
      addedMessages,
      updatedMessages,
      state: {
        ...state,
        inboxMessages: messages,
        inboxProcessedEventIds: processed,
        inboxStartedDateKey: startedDateKey
      }
    };
  }

  function emitInboxUpdated(state) {
    if (typeof global.dispatchEvent !== 'function' || typeof global.CustomEvent !== 'function') return;
    const count = (Array.isArray(state?.inboxMessages) ? state.inboxMessages : [])
      .filter((message) => message && message.archived !== true)
      .length;
    global.dispatchEvent(new global.CustomEvent('taskpoints:inbox-updated', { detail: { count } }));
  }

  function isLogPage() {
    const pathname = String(global.location?.pathname || '');
    return pathname === '/log' || pathname.endsWith('/log.html');
  }

  function logReconcileReadyAtExecution() {
    if (!isLogPage()) return true;
    const status = global.TaskPointsCore?.getStorageMaintenanceIdleStatus?.();
    if (!status || typeof status !== 'object') return true;
    if (global.document?.visibilityState === 'hidden') return false;
    if (status.pageLeaving === true || status.activeEditor === true) return false;
    if (Number(status.navigationQuietForMs || 0) > 0) return false;
    return Number(status.lastInteractionAgoMs || 0) >= LOG_RECONCILE_QUIET_MS;
  }

  function deferLogReconcileAtExecution() {
    if (!isLogPage() || logReconcileReadyAtExecution()) {
      if (executionQuietDeferred) {
        const status = global.TaskPointsCore?.getStorageMaintenanceIdleStatus?.();
        executionQuietDeferred = false;
        try {
          global.TaskPointsPerf?.mark?.('upset.logExecutionGuardReleased', {
            requiredQuietMs: LOG_RECONCILE_QUIET_MS,
            lastInteractionAgoMs: Number(status?.lastInteractionAgoMs || 0)
          });
        } catch (_) {}
      }
      return false;
    }

    if (!executionQuietDeferred) {
      executionQuietDeferred = true;
      const status = global.TaskPointsCore?.getStorageMaintenanceIdleStatus?.();
      try {
        global.TaskPointsPerf?.mark?.('upset.logExecutionGuardDeferred', {
          requiredQuietMs: LOG_RECONCILE_QUIET_MS,
          lastInteractionAgoMs: Number(status?.lastInteractionAgoMs || 0),
          navigationQuietForMs: Number(status?.navigationQuietForMs || 0)
        });
      } catch (_) {}
    }
    queueReconcile(250);
    return true;
  }

  function reconcileStored(options = {}) {
    const core = global.TaskPointsCore;
    if (!core?.loadAppState || !core?.mergeAndSaveState || reconciliationRunning) return null;
    if (deferLogReconcileAtExecution()) return null;
    reconciliationRunning = true;
    try {
      // Reconciliation is observational unless this module actually has an inbox
      // change to persist. Derived-state sync is still computed for correctness,
      // but must never write the full TaskPoints snapshot just because we checked.
      const loaded = core.loadAppState({ syncDerived: true, persistSync: false });
      const state = loaded?.state || loaded;
      if (!state || typeof state !== 'object') return null;
      const result = reconcileState(state, options);
      if (!result.changed) return result;

      let saved;
      suppressRevisionQueue = true;
      try {
        saved = core.mergeAndSaveState({
          inboxMessages: result.state.inboxMessages,
          inboxProcessedEventIds: result.state.inboxProcessedEventIds,
          inboxStartedDateKey: result.state.inboxStartedDateKey
        }, {
          savePath: 'season-series-upset-inbox',
          immediateWrite: true,
          assumeNormalized: true
        });
      } finally {
        suppressRevisionQueue = false;
      }
      const savedState = saved?.state || saved || result.state;
      result.state = savedState;
      emitInboxUpdated(savedState);
      return result;
    } catch (error) {
      console.warn('TaskPoints season-series upset notifications could not be reconciled.', error);
      return null;
    } finally {
      reconciliationRunning = false;
    }
  }

  function queueReconcile(delayMs = 0) {
    if (!global.document || !global.localStorage) return;
    if (reconciliationTimer !== null) global.clearTimeout?.(reconciliationTimer);
    reconciliationTimer = global.setTimeout?.(() => {
      reconciliationTimer = null;
      reconcileStored();
    }, Math.max(0, Number(delayMs) || 0));
  }

  function queueReconcileWhenQuiet(reason = 'startup', delayMs = 0) {
    if (!global.document || !global.localStorage) return;
    const schedule = () => queueReconcile(delayMs);
    const tryGate = () => {
      const gate = global.TaskPointsCore?.whenStorageMaintenanceQuiet;
      if (typeof gate !== 'function') return false;
      Promise.resolve(gate(schedule, { reason: `season_series_upset_${reason}` }))
        .catch(() => global.setTimeout?.(schedule, 3000));
      return true;
    };
    if (tryGate()) return;
    global.setTimeout?.(() => {
      if (!tryGate()) schedule();
    }, 0);
  }

  function mergePopulateResults(originalResult, upsetResult) {
    if (!upsetResult?.changed) return originalResult;
    return {
      ...(originalResult || {}),
      changed: true,
      state: upsetResult.state || originalResult?.state,
      addedMessages: [
        ...(Array.isArray(originalResult?.addedMessages) ? originalResult.addedMessages : []),
        ...(Array.isArray(upsetResult.addedMessages) ? upsetResult.addedMessages : [])
      ],
      updatedMessages: [
        ...(Array.isArray(originalResult?.updatedMessages) ? originalResult.updatedMessages : []),
        ...(Array.isArray(upsetResult.updatedMessages) ? upsetResult.updatedMessages : [])
      ]
    };
  }

  function installPopulateWrapper() {
    const inbox = global.TaskPointsInbox;
    const originalPopulate = inbox?.populate;
    if (typeof originalPopulate !== 'function') {
      installAttempts += 1;
      if (installAttempts < MAX_INSTALL_ATTEMPTS) global.setTimeout?.(installPopulateWrapper, INSTALL_RETRY_MS);
      return false;
    }
    if (originalPopulate.__taskPointsSeasonSeriesSeedUpsets) return true;

    function populateWithSeasonSeriesUpsets(options = {}) {
      const originalResult = originalPopulate.call(this, options);
      const finish = (resolvedOriginalResult) => {
        const upsetResult = reconcileStored({ now: options?.now });
        return mergePopulateResults(resolvedOriginalResult, upsetResult);
      };
      return originalResult && typeof originalResult.then === 'function'
        ? originalResult.then(finish)
        : finish(originalResult);
    }

    Object.defineProperty(populateWithSeasonSeriesUpsets, '__taskPointsSeasonSeriesSeedUpsets', {
      value: true,
      configurable: true
    });
    populateWithSeasonSeriesUpsets.__taskPointsOriginal = originalPopulate;
    inbox.populate = populateWithSeasonSeriesUpsets;
    queueReconcileWhenQuiet('bootstrap', 0);
    return true;
  }

  const api = {
    installed: true,
    version: VERSION,
    eventPrefix: EVENT_PREFIX,
    revealDayKey,
    seriesWinnerId,
    seriesClinchDateKey,
    seriesSeedForPlayer,
    seriesLabel,
    notificationForSeries,
    reconcileState,
    reconcileStored,
    installPopulateWrapper
  };

  global.TaskPointsSeasonSeriesUpsetNotifications = api;
  installPopulateWrapper();

  global.addEventListener?.('pageshow', () => {
    installPopulateWrapper();
    queueReconcileWhenQuiet('pageshow', 50);
  });
  global.addEventListener?.('focus', () => {
    if (isLogPage()) queueReconcileWhenQuiet('focus', 0);
    else queueReconcile(100);
  });
  global.addEventListener?.('taskpoints:state-revision', () => {
    if (suppressRevisionQueue) return;
    if (isLogPage()) queueReconcileWhenQuiet('state_revision', 0);
    else queueReconcile(100);
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);