;(function installTaskPointsGoldTheftTop50Notifications(global) {
  'use strict';

  if (global.TaskPointsGoldTheftTop50Notifications?.installed) return;

  const VERSION = 2;
  const EVENT_PREFIX = 'gold-theft-top50';
  const STARTED_DATE_KEY = 'goldTheftTop50InboxStartedDateKey';
  const INSTALL_RETRY_MS = 50;
  const MAX_INSTALL_ATTEMPTS = 240;
  const RECONCILE_DEBOUNCE_MS = 150;
  let installAttempts = 0;
  let reconciliationTimer = null;
  let reconciliationRunning = false;
  let suppressRevisionQueue = false;

  const roundGold = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 10) / 10;

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

  function isInboxPage() {
    const path = String(global.location?.pathname || '').replace(/\/+$/, '');
    return path === '/inbox' || path.endsWith('/inbox.html');
  }

  function playerName(state, playerId) {
    const id = String(playerId || '');
    if (id === 'YOU') return String(state?.youName || '').trim() || 'You';
    const player = (Array.isArray(state?.players) ? state.players : [])
      .find((row) => String(row?.id || row?.playerId || '') === id);
    return String(player?.name || player?.playerName || id || 'Unknown Player');
  }

  function ordinal(value) {
    const n = Math.max(0, Math.trunc(Number(value) || 0));
    if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
    if (n % 10 === 1) return `${n}st`;
    if (n % 10 === 2) return `${n}nd`;
    if (n % 10 === 3) return `${n}rd`;
    return `${n}th`;
  }

  function ledgerIdentity(row) {
    const explicit = String(row?.id || '').trim();
    if (explicit) return explicit;
    return [
      String(row?.transferId || ''),
      String(row?.matchupId || ''),
      String(row?.playerId || ''),
      String(row?.opponentId || ''),
      dateKey(row?.dateKey || row?.createdAtISO),
      roundGold(row?.amount)
    ].join('|');
  }

  function buildRows(state) {
    return (Array.isArray(state?.goldLedger) ? state.goldLedger : [])
      .filter((row) => row?.type === 'matchup_theft' && Number(row.amount) > 0)
      .map((row) => {
        const playerId = String(row.playerId || '');
        const opponentId = String(row.opponentId || '');
        return {
          identity: ledgerIdentity(row),
          ledgerId: String(row.id || ''),
          transferId: String(row.transferId || ''),
          matchupId: String(row.matchupId || ''),
          playerId,
          opponentId,
          playerName: playerName(state, playerId),
          opponentName: playerName(state, opponentId),
          date: dateKey(row.dateKey || row.createdAtISO),
          amount: roundGold(row.amount)
        };
      })
      .filter((row) => row.identity && row.date && Number.isFinite(row.amount) && row.amount > 0)
      .sort((a, b) => (
        b.amount - a.amount
        || String(b.date).localeCompare(String(a.date))
        || a.playerName.localeCompare(b.playerName)
      ));
  }

  function eventIdForRow(row) {
    return `${EVENT_PREFIX}:${row.identity}`;
  }

  function notificationForRow(row, rank, nowISO) {
    const amount = roundGold(row.amount);
    return {
      id: eventIdForRow(row),
      type: 'record',
      eventDateKey: row.date,
      title: 'Top-50 Gold Theft',
      body: `${row.playerName} stole ${amount.toFixed(1)} Gold from ${row.opponentName}, the ${ordinal(rank)}-largest single-game Gold theft ever and No. ${rank} on the Gold Theft Records tab.`,
      relatedPage: 'records.html',
      rank,
      goldAmount: amount,
      playerId: row.playerId,
      opponentId: row.opponentId,
      matchupId: row.matchupId,
      read: false,
      archived: false,
      createdAtISO: nowISO
    };
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
    let startedDateKey = String(state?.[STARTED_DATE_KEY] || '').slice(0, 10);
    let changed = false;
    const addedMessages = [];

    // Gold Theft alerts have their own rollout boundary so enabling this feature
    // never backfills months of older theft records into the existing inbox.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startedDateKey)) {
      startedDateKey = latestRevealableDateKey;
      changed = true;
    }

    const eligible = (value) => (
      /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
      && value >= startedDateKey
      && value <= latestRevealableDateKey
    );

    const rows = buildRows(state);
    const rankByIdentity = new Map(rows.slice(0, 50).map((row, index) => [row.identity, index + 1]));

    rows.forEach((row) => {
      if (!eligible(row.date)) return;
      const eventId = eventIdForRow(row);
      if (processed[eventId]) return;

      // Match the existing Top-50 score behavior: once a revealed daily result
      // has been evaluated, it is processed even when it misses the Top 50.
      processed[eventId] = true;
      changed = true;

      const rank = rankByIdentity.get(row.identity) || 0;
      if (rank < 1 || rank > 50) return;
      if (messages.some((message) => message?.id === eventId)) return;

      const message = notificationForRow(row, rank, nowISO);
      messages.push(message);
      addedMessages.push(message);
    });

    return {
      changed,
      addedMessages,
      state: {
        ...state,
        inboxMessages: messages,
        inboxProcessedEventIds: processed,
        [STARTED_DATE_KEY]: startedDateKey
      }
    };
  }

  function emitInboxUpdated(state) {
    if (typeof global.dispatchEvent !== 'function' || typeof global.CustomEvent !== 'function') return;
    const messages = Array.isArray(state?.inboxMessages) ? state.inboxMessages : [];
    const count = messages.filter((message) => message && message.archived !== true).length;
    const detail = { count, inboxMessages: messages };
    global.dispatchEvent(new global.CustomEvent('taskpoints:inbox-updated', { detail }));
    // The inbox page renders its stored snapshot before this late-loaded module
    // usually reconciles. Emit the snapshot event too so a same-tab save paints
    // the new message immediately instead of waiting for focus/pageshow.
    global.dispatchEvent(new global.CustomEvent('taskpoints:inbox-state-snapshot', { detail }));
  }

  function readStateForReconcile(core) {
    const storageKey = core?.STORAGE_KEY || 'taskpoints_v1';
    if (typeof core?.readTaskPointsStoredState === 'function') {
      try {
        const state = core.readTaskPointsStoredState(storageKey, {});
        if (state && typeof state === 'object') return state;
      } catch (_) {}
    }
    if (typeof core?.loadAppState === 'function') {
      const loaded = core.loadAppState({ syncDerived: false, persistSync: false });
      const state = loaded?.state || loaded;
      if (state && typeof state === 'object') return state;
    }
    return null;
  }

  function reconcileStored(options = {}) {
    const core = global.TaskPointsCore;
    if (!core?.mergeAndSaveState || reconciliationRunning) return null;
    reconciliationRunning = true;
    try {
      const state = readStateForReconcile(core);
      if (!state || typeof state !== 'object') return null;
      const result = reconcileState(state, options);
      if (!result.changed) return result;

      let saved;
      suppressRevisionQueue = true;
      try {
        saved = core.mergeAndSaveState({
          inboxMessages: result.state.inboxMessages,
          inboxProcessedEventIds: result.state.inboxProcessedEventIds,
          [STARTED_DATE_KEY]: result.state[STARTED_DATE_KEY]
        }, {
          savePath: 'gold-theft-top50-inbox',
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
      console.warn('TaskPoints Gold Theft Top-50 notifications could not be reconciled.', error);
      return null;
    } finally {
      reconciliationRunning = false;
    }
  }

  function runQueuedReconcile(run) {
    // Gold notifications are user-facing Inbox content, not background storage
    // maintenance. On the Inbox page, let first paint happen and then reconcile
    // promptly instead of waiting through the 3.5s startup maintenance grace.
    if (isInboxPage()) {
      if (typeof global.requestIdleCallback === 'function') {
        global.requestIdleCallback(run, { timeout: 250 });
      } else {
        global.setTimeout?.(run, 0);
      }
      return;
    }

    const gate = global.TaskPointsCore?.whenStorageMaintenanceQuiet;
    if (typeof gate === 'function') {
      Promise.resolve(gate(run, { reason: 'gold_theft_top50_inbox' })).catch(() => run());
    } else {
      run();
    }
  }

  function queueReconcile(delayMs = RECONCILE_DEBOUNCE_MS) {
    if (!global.document || !global.localStorage) return;
    if (reconciliationTimer !== null) global.clearTimeout?.(reconciliationTimer);
    reconciliationTimer = global.setTimeout?.(() => {
      reconciliationTimer = null;
      runQueuedReconcile(() => reconcileStored());
    }, Math.max(0, Number(delayMs) || 0));
  }

  function mergePopulateResults(originalResult, goldResult) {
    if (!goldResult?.changed) return originalResult;
    return {
      ...(originalResult || {}),
      changed: true,
      state: goldResult.state || originalResult?.state,
      addedMessages: [
        ...(Array.isArray(originalResult?.addedMessages) ? originalResult.addedMessages : []),
        ...(Array.isArray(goldResult.addedMessages) ? goldResult.addedMessages : [])
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
    if (originalPopulate.__taskPointsGoldTheftTop50Notifications) return true;

    function populateWithGoldTheftTop50(options = {}) {
      const originalResult = originalPopulate.call(this, options);
      const finish = (resolvedOriginalResult) => {
        const goldResult = reconcileStored({ now: options?.now });
        return mergePopulateResults(resolvedOriginalResult, goldResult);
      };
      return originalResult && typeof originalResult.then === 'function'
        ? originalResult.then(finish)
        : finish(originalResult);
    }

    Object.defineProperty(populateWithGoldTheftTop50, '__taskPointsGoldTheftTop50Notifications', {
      value: true,
      configurable: true
    });
    populateWithGoldTheftTop50.__taskPointsOriginal = originalPopulate;
    inbox.populate = populateWithGoldTheftTop50;
    queueReconcile(0);
    return true;
  }

  const api = {
    installed: true,
    version: VERSION,
    eventPrefix: EVENT_PREFIX,
    startedDateKey: STARTED_DATE_KEY,
    revealDayKey,
    buildRows,
    eventIdForRow,
    notificationForRow,
    reconcileState,
    reconcileStored,
    installPopulateWrapper
  };

  global.TaskPointsGoldTheftTop50Notifications = api;
  installPopulateWrapper();

  global.addEventListener?.('pageshow', () => {
    installPopulateWrapper();
    queueReconcile(50);
  });
  global.addEventListener?.('focus', () => queueReconcile(100));
  global.addEventListener?.('taskpoints:state-revision', () => {
    if (suppressRevisionQueue) return;
    queueReconcile(RECONCILE_DEBOUNCE_MS);
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

;(function installTaskPointsRetroactiveGoldScoreAdjustments(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__retroactiveGoldScoreAdjustmentsInstalled) return;
  const originalSaveStateSnapshot = typeof core.saveStateSnapshot === 'function'
    ? core.saveStateSnapshot.bind(core)
    : null;
  if (!originalSaveStateSnapshot) return;
  core.__retroactiveGoldScoreAdjustmentsInstalled = true;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const ECONOMY_VERSION = 1;
  const THEFT_MAX_RATE = 0.10;
  const YOU_THEFT_GREED = 50;
  const roundGold = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 10) / 10;
  const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const safeId = (value) => encodeURIComponent(String(value || '').trim()).replace(/%/g, '_');

  function rowDateKey(row) {
    const candidates = [row?.dateKey, row?.date, row?.completedAtISO, row?.finalizedAtISO, row?.recordedAtISO, row?.createdAtISO];
    for (const candidate of candidates) {
      if (candidate == null || candidate === '') continue;
      const direct = String(candidate).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
      const parsed = new Date(candidate);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    }
    return '';
  }

  function sideScore(matchup, side) {
    const primary = matchup?.[side === 'B' ? 'scoreB' : 'scoreA'];
    const alias = matchup?.[side === 'B' ? 'playerBScore' : 'playerAScore'];
    if (finite(primary)) return Number(primary);
    return finite(alias) ? Number(alias) : null;
  }

  function matchupKey(matchup, index = -1) {
    const explicit = String(matchup?.id || matchup?.matchupId || '').trim();
    if (explicit) return `id:${explicit}`;
    const a = String(matchup?.playerAId || '').trim();
    const b = String(matchup?.playerBId || '').trim();
    const date = rowDateKey(matchup);
    if (a && b && date) {
      const context = [
        matchup?.seasonId,
        matchup?.seriesId || matchup?.seasonSeriesId,
        matchup?.roundId,
        matchup?.gameNumber || matchup?.seriesGameNumber,
        matchup?.matchupType || matchup?.type
      ].map((value) => value == null ? '' : String(value)).join('|');
      return `fallback:${date}|${[a, b].sort().join('|')}|${context}`;
    }
    return index >= 0 ? `index:${index}` : '';
  }

  function readPersistedState() {
    try {
      const raw = global.localStorage?.getItem?.(STORAGE_KEY);
      if (!raw) return null;
      return core.parseTaskPointsStorageJson?.(raw, null) || JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function goldBalance(state, playerId) {
    const id = String(playerId || '').trim();
    if (!id) return 0;
    return roundGold((Array.isArray(state?.goldLedger) ? state.goldLedger : []).reduce((sum, row) => (
      String(row?.playerId || '') === id ? sum + (Number(row?.amount) || 0) : sum
    ), 0));
  }

  function appendAdjustment(state, entry) {
    if (!Array.isArray(state.goldLedger)) state.goldLedger = [];
    if (state.goldLedger.some((row) => String(row?.id || '') === String(entry.id || ''))) return false;
    const before = goldBalance(state, entry.playerId);
    const amount = roundGold(entry.amount);
    state.goldLedger.push({ ...entry, amount, balanceAfter: roundGold(before + amount) });
    return true;
  }

  function winnerFor(matchup) {
    const scoreA = sideScore(matchup, 'A');
    const scoreB = sideScore(matchup, 'B');
    if (scoreA === null || scoreB === null) return null;
    if (scoreA === scoreB) return { tie: true, scoreA, scoreB, winnerId: '', loserId: '' };
    return scoreA > scoreB
      ? { tie: false, scoreA, scoreB, winnerId: String(matchup?.playerAId || ''), loserId: String(matchup?.playerBId || '') }
      : { tie: false, scoreA, scoreB, winnerId: String(matchup?.playerBId || ''), loserId: String(matchup?.playerAId || '') };
  }

  function transactionTimestamp(matchup) {
    return String(matchup?.completedAtISO || matchup?.finalizedAtISO || matchup?.recordedAtISO || matchup?.createdAtISO || `${rowDateKey(matchup) || '1970-01-01'}T12:00:00.000Z`);
  }

  function historicalPregameGold(previousState, priorMatchup, playerId, priorOutcome) {
    const id = String(playerId || '').trim();
    if (!id) return 0;
    if (String(priorOutcome?.winnerId || '') === id && finite(priorOutcome?.winnerPregameGold)) {
      return Math.max(0, roundGold(priorOutcome.winnerPregameGold));
    }
    if (String(priorOutcome?.loserId || '') === id && finite(priorOutcome?.loserPregameGold)) {
      return Math.max(0, roundGold(priorOutcome.loserPregameGold));
    }

    const ledger = Array.isArray(previousState?.goldLedger) ? previousState.goldLedger : [];
    const matchupId = String(priorMatchup?.id || priorMatchup?.matchupId || '').trim();
    if (matchupId) {
      const firstTargetIndex = ledger.findIndex((row) => String(row?.matchupId || '') === matchupId);
      if (firstTargetIndex >= 0) {
        return Math.max(0, roundGold(ledger.slice(0, firstTargetIndex).reduce((sum, row) => (
          String(row?.playerId || '') === id ? sum + (Number(row?.amount) || 0) : sum
        ), 0)));
      }
    }

    const targetDate = rowDateKey(priorMatchup);
    const targetStamp = transactionTimestamp(priorMatchup);
    return Math.max(0, roundGold(ledger.reduce((sum, row) => {
      if (String(row?.playerId || '') !== id) return sum;
      const rowDate = rowDateKey(row);
      const rowStamp = String(row?.createdAtISO || '');
      const before = rowDate < targetDate || (rowDate === targetDate && rowStamp && rowStamp < targetStamp);
      return before ? sum + (Number(row?.amount) || 0) : sum;
    }, 0)));
  }

  function winnerGreed(state, matchup, winnerId, priorOutcome) {
    const id = String(winnerId || '').trim();
    if (!id) return 0;
    if (id === 'YOU') return YOU_THEFT_GREED;
    if (String(priorOutcome?.winnerId || '') === id && finite(priorOutcome?.winnerEffectiveGreed)) {
      return Math.max(0, Math.min(100, Number(priorOutcome.winnerEffectiveGreed)));
    }
    const side = String(matchup?.playerAId || '') === id ? 'A' : String(matchup?.playerBId || '') === id ? 'B' : '';
    const captured = side ? Number(matchup?.[`player${side}Effects`]?.greedRating) : NaN;
    if (Number.isFinite(captured)) return Math.max(0, Math.min(100, captured));
    const player = (Array.isArray(state?.players) ? state.players : []).find((row) => String(row?.id || row?.playerId || '') === id);
    return Math.max(0, Math.min(100, Number(player?.greed) || 0));
  }

  function desiredOutcome(state, previousState, matchup, priorMatchup, priorOutcome) {
    const result = winnerFor(matchup);
    if (!result) return null;
    const oldRevision = Math.max(0, Math.trunc(Number(priorOutcome?.adjustmentRevision) || 0));
    const settledAtISO = String(priorOutcome?.settledAtISO || transactionTimestamp(priorMatchup || matchup));

    if (result.tie) {
      return {
        settled: true,
        tie: true,
        winnerId: '',
        loserId: '',
        marginGoldAwarded: 0,
        theftGoldStolen: 0,
        scoreA: result.scoreA,
        scoreB: result.scoreB,
        settledAtISO,
        adjustmentRevision: oldRevision
      };
    }

    const marginGold = roundGold(Math.abs(result.scoreA - result.scoreB) / 10);
    const sameWinner = priorOutcome?.tie !== true && String(priorOutcome?.winnerId || '') === result.winnerId;
    const winnerPregameGold = sameWinner && finite(priorOutcome?.winnerPregameGold)
      ? roundGold(priorOutcome.winnerPregameGold)
      : historicalPregameGold(previousState, priorMatchup || matchup, result.winnerId, priorOutcome);
    const loserPregameGold = sameWinner && finite(priorOutcome?.loserPregameGold)
      ? roundGold(priorOutcome.loserPregameGold)
      : historicalPregameGold(previousState, priorMatchup || matchup, result.loserId, priorOutcome);
    const greed = sameWinner && finite(priorOutcome?.winnerEffectiveGreed)
      ? Number(priorOutcome.winnerEffectiveGreed)
      : winnerGreed(state, matchup, result.winnerId, priorOutcome);
    const theftRate = sameWinner && finite(priorOutcome?.theftRate)
      ? Number(priorOutcome.theftRate)
      : (Math.max(0, Math.min(100, greed)) / 100) * THEFT_MAX_RATE;
    const theftGold = sameWinner
      ? roundGold(Number(priorOutcome?.theftGoldStolen) || 0)
      : Math.min(Math.max(0, loserPregameGold), roundGold(Math.max(0, loserPregameGold) * theftRate));

    return {
      settled: true,
      tie: false,
      winnerId: result.winnerId,
      loserId: result.loserId,
      winnerPregameGold: roundGold(winnerPregameGold),
      loserPregameGold: roundGold(loserPregameGold),
      winnerEffectiveGreed: Math.max(0, Math.min(100, Number(greed) || 0)),
      theftRate,
      marginGoldAwarded: marginGold,
      theftGoldStolen: roundGold(theftGold),
      scoreA: result.scoreA,
      scoreB: result.scoreB,
      settledAtISO,
      adjustmentRevision: oldRevision
    };
  }

  function addOutcomeFlow(map, outcome, multiplier) {
    if (!outcome || outcome.settled !== true || outcome.tie === true) return;
    const winnerId = String(outcome.winnerId || '');
    const loserId = String(outcome.loserId || '');
    const margin = roundGold(Number(outcome.marginGoldAwarded) || 0);
    const theft = roundGold(Number(outcome.theftGoldStolen) || 0);
    if (winnerId) map.set(winnerId, roundGold((map.get(winnerId) || 0) + multiplier * (margin + theft)));
    if (loserId) map.set(loserId, roundGold((map.get(loserId) || 0) - multiplier * theft));
  }

  function applyOutcomeToCopies(state, sourceMatchup, outcome) {
    const key = matchupKey(sourceMatchup);
    if (!key) return;
    const copy = (row, index = -1) => {
      if (matchupKey(row, index) === key) row.goldOutcome = { ...outcome };
    };
    (Array.isArray(state?.matchups) ? state.matchups : []).forEach(copy);
    (Array.isArray(state?.schedule) ? state.schedule : []).forEach((day) => {
      (Array.isArray(day?.matchups) ? day.matchups : []).forEach(copy);
    });
    (Array.isArray(state?.currentSeason?.tournamentMatchupResults) ? state.currentSeason.tournamentMatchupResults : []).forEach(copy);
    (Array.isArray(state?.seasonHistory) ? state.seasonHistory : []).forEach((season) => {
      (Array.isArray(season?.tournamentMatchupResults) ? season.tournamentMatchupResults : []).forEach(copy);
    });
  }

  function reconcileOne(state, previousState, matchup, priorMatchup) {
    const priorOutcome = priorMatchup?.goldOutcome;
    if (!priorOutcome || priorOutcome.settled !== true) return false;
    const desired = desiredOutcome(state, previousState, matchup, priorMatchup, priorOutcome);
    if (!desired) return false;

    const deltas = new Map();
    addOutcomeFlow(deltas, priorOutcome, -1);
    addOutcomeFlow(deltas, desired, 1);
    const nonzero = [...deltas.entries()].filter(([, amount]) => Math.abs(roundGold(amount)) >= 0.05);
    const oldScoreA = sideScore(priorMatchup, 'A');
    const oldScoreB = sideScore(priorMatchup, 'B');
    const newScoreA = sideScore(matchup, 'A');
    const newScoreB = sideScore(matchup, 'B');
    const financialChanged = nonzero.length > 0;
    const outcomeChanged = financialChanged
      || Boolean(priorOutcome.tie) !== Boolean(desired.tie)
      || String(priorOutcome.winnerId || '') !== String(desired.winnerId || '')
      || roundGold(priorOutcome.marginGoldAwarded) !== roundGold(desired.marginGoldAwarded)
      || roundGold(priorOutcome.theftGoldStolen) !== roundGold(desired.theftGoldStolen)
      || Number(oldScoreA) !== Number(newScoreA)
      || Number(oldScoreB) !== Number(newScoreB);
    if (!outcomeChanged) return false;

    const revision = Math.max(0, Math.trunc(Number(priorOutcome.adjustmentRevision) || 0)) + (financialChanged ? 1 : 0);
    const adjustedAtISO = new Date().toISOString();
    const matchupId = String(matchup?.id || matchup?.matchupId || matchupKey(matchup));
    const date = rowDateKey(matchup) || rowDateKey(priorMatchup);
    const seasonId = String(matchup?.seasonId || priorMatchup?.seasonId || '');

    if (financialChanged) {
      nonzero.forEach(([playerId, rawAmount]) => {
        const amount = roundGold(rawAmount);
        appendAdjustment(state, {
          id: `gold:${safeId(matchupKey(matchup))}:adjust:${revision}:${safeId(playerId)}`,
          type: 'matchup_adjustment',
          playerId,
          opponentId: playerId === String(desired.winnerId || '') ? String(desired.loserId || '') : String(desired.winnerId || ''),
          matchupId,
          seasonId,
          dateKey: date,
          createdAtISO: adjustedAtISO,
          amount,
          meta: {
            reason: 'retroactive_score_edit',
            adjustmentRevision: revision,
            oldScoreA,
            oldScoreB,
            newScoreA,
            newScoreB,
            oldWinnerId: String(priorOutcome.winnerId || ''),
            newWinnerId: String(desired.winnerId || ''),
            oldMarginGold: roundGold(priorOutcome.marginGoldAwarded),
            newMarginGold: roundGold(desired.marginGoldAwarded),
            oldTheftGold: roundGold(priorOutcome.theftGoldStolen),
            newTheftGold: roundGold(desired.theftGoldStolen)
          }
        });
      });
    }

    const updatedOutcome = {
      ...desired,
      adjustmentRevision: revision,
      ...(financialChanged ? { adjustedAtISO } : {}),
      adjustmentReason: financialChanged ? 'retroactive_score_edit' : String(priorOutcome.adjustmentReason || '')
    };
    applyOutcomeToCopies(state, matchup, updatedOutcome);
    return true;
  }

  function reconcileEditedGold(stateInput, previousStateInput) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const previous = previousStateInput && typeof previousStateInput === 'object' ? previousStateInput : {};
    if (Number(state?.goldEconomy?.version) !== ECONOMY_VERSION || !Array.isArray(state?.goldLedger)) {
      return { state, changed: false, adjustedMatchups: 0, adjustmentEntries: 0 };
    }
    const previousRows = Array.isArray(previous?.matchups) ? previous.matchups : [];
    const previousByKey = new Map(previousRows.map((row, index) => [matchupKey(row, index), row]));
    const beforeEntries = state.goldLedger.length;
    let adjustedMatchups = 0;

    (Array.isArray(state?.matchups) ? state.matchups : []).forEach((matchup, index) => {
      if (!matchup) return;
      const prior = previousByKey.get(matchupKey(matchup, index));
      if (!prior) return;
      if (reconcileOne(state, previous, matchup, prior)) adjustedMatchups += 1;
    });

    return {
      state,
      changed: adjustedMatchups > 0,
      adjustedMatchups,
      adjustmentEntries: Math.max(0, state.goldLedger.length - beforeEntries)
    };
  }

  core.saveStateSnapshot = function saveStateSnapshotWithRetroactiveGoldAdjustments(state, options = {}) {
    if (String(options?.savePath || '') === 'matchups-edit-result' && state && typeof state === 'object') {
      const previous = readPersistedState();
      if (previous) reconcileEditedGold(state, previous);
    }
    return originalSaveStateSnapshot(state, options);
  };
  core.saveStateSnapshot.__taskPointsRetroactiveGoldAdjustments = true;
  core.saveStateSnapshot.__taskPointsOriginal = originalSaveStateSnapshot;

  global.TaskPointsRetroactiveGoldScoreAdjustments = {
    installed: true,
    reconcileEditedGold,
    desiredOutcome,
    goldBalance
  };
})(typeof window !== 'undefined' ? window : globalThis);
