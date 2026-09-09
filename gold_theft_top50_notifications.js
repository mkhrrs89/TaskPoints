;(function installTaskPointsGoldTheftTop50Notifications(global) {
  'use strict';

  if (global.TaskPointsGoldTheftTop50Notifications?.installed) return;

  const VERSION = 1;
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
    const count = (Array.isArray(state?.inboxMessages) ? state.inboxMessages : [])
      .filter((message) => message && message.archived !== true)
      .length;
    global.dispatchEvent(new global.CustomEvent('taskpoints:inbox-updated', { detail: { count } }));
  }

  function reconcileStored(options = {}) {
    const core = global.TaskPointsCore;
    if (!core?.loadAppState || !core?.mergeAndSaveState || reconciliationRunning) return null;
    reconciliationRunning = true;
    try {
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

  function queueReconcile(delayMs = RECONCILE_DEBOUNCE_MS) {
    if (!global.document || !global.localStorage) return;
    if (reconciliationTimer !== null) global.clearTimeout?.(reconciliationTimer);
    reconciliationTimer = global.setTimeout?.(() => {
      reconciliationTimer = null;
      const run = () => reconcileStored();
      const gate = global.TaskPointsCore?.whenStorageMaintenanceQuiet;
      if (typeof gate === 'function') {
        Promise.resolve(gate(run, { reason: 'gold_theft_top50_inbox' })).catch(() => run());
      } else {
        run();
      }
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
