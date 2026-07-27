(function installTaskPointsHomeYesterdayResultConsistency(global) {
  'use strict';

  if (!global || global.__taskPointsHomeYesterdayResultConsistencyInstalled) return;
  global.__taskPointsHomeYesterdayResultConsistencyInstalled = true;

  const WINNER_CLASSES = ['yesterdayWinner', 'yesterdayWinnerScore'];
  const LOSER_CLASSES = ['yesterdayLoser', 'yesterdayLoserScore'];
  const PLAYER_PHOTO_FRAME_STYLE_ID = 'taskpoints-player-photo-frame-override';
  const TRENDLINE_COLOR = '#F59E0B';
  const TRENDLINE_PERIOD = 14;
  const TRENDLINE_MAX_POINTS = 400;
  let installAttempts = 0;

  function getElement(id) {
    return global.document?.getElementById?.(id) || null;
  }

  function installPlayerPhotoFrameOverride() {
    const document = global.document;
    if (!document?.head || typeof document.createElement !== 'function') return false;
    if (document.getElementById?.(PLAYER_PHOTO_FRAME_STYLE_ID)) return true;

    const style = document.createElement('style');
    style.id = PLAYER_PHOTO_FRAME_STYLE_ID;
    style.textContent = `
/* Players page: remove the silver gradient frame while retaining the black photo edge. */
.player-img-frame {
  padding: 0 !important;
  background: transparent !important;
}
`;
    document.head.appendChild(style);
    return true;
  }

  function fallbackDateKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function getYesterdayGameKey() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return typeof global.getGameDayKey === 'function'
      ? global.getGameDayKey(yesterday)
      : fallbackDateKey(yesterday);
  }

  function normalizeResult(row, youScore, opponentScore) {
    const saved = String(row?.result || '').toUpperCase();
    if (saved === 'W' || saved === 'L' || saved === 'T') return saved;
    if (youScore > opponentScore) return 'W';
    if (youScore < opponentScore) return 'L';
    return 'T';
  }

  function clearResultClasses(elements) {
    elements.forEach((element) => {
      if (!element?.classList) return;
      element.classList.remove(...WINNER_CLASSES, ...LOSER_CLASSES);
    });
  }

  function applySavedYesterdayResult() {
    if (typeof global.getCompletedYouMatchupsForStats !== 'function') return false;

    const panel = getElement('yesterdayResultsPanel');
    const yesterdayKey = getYesterdayGameKey();
    const completedRows = global.getCompletedYouMatchupsForStats();
    const matchup = (Array.isArray(completedRows) ? completedRows : [])
      .find((row) => row?.dateKey === yesterdayKey);
    if (!matchup) {
      panel?.classList?.remove('yesterday-tie');
      return false;
    }

    const youScore = Number(matchup.youScore);
    const opponentScore = Number(matchup.oppScore);
    if (!Number.isFinite(youScore) || !Number.isFinite(opponentScore)) {
      panel?.classList?.remove('yesterday-tie');
      return false;
    }

    const result = normalizeResult(matchup, youScore, opponentScore);
    const youAreA = matchup.playerAId === 'YOU';
    const opponentId = youAreA ? matchup.playerBId : matchup.playerAId;

    const yourName = getElement('yesterdayYouName');
    const yourScoreElement = getElement('yesterdayYourScore');
    const opponentName = getElement('yesterdayOpponent');
    const opponentScoreElement = getElement('yesterdayOpponentScore');
    const resultElement = getElement('yesterdayResult');
    const yourPrimarySwatch = getElement('yesterdayYourPrimarySwatch');
    const yourSecondarySwatch = getElement('yesterdayYourSecondarySwatch');
    const opponentPrimarySwatch = getElement('yesterdayOpponentPrimarySwatch');
    const opponentSecondarySwatch = getElement('yesterdayOpponentSecondarySwatch');

    if (!yourName || !yourScoreElement || !opponentName || !opponentScoreElement || !resultElement) {
      return false;
    }

    yourName.textContent = typeof global.getYouName === 'function' ? global.getYouName() : 'You';
    opponentName.textContent = typeof global.getPlayerNameById === 'function'
      ? global.getPlayerNameById(opponentId)
      : String(opponentId || 'Opponent');
    yourScoreElement.textContent = youScore.toFixed(1);
    opponentScoreElement.textContent = opponentScore.toFixed(1);
    resultElement.textContent = result;

    if (typeof global.setPlayerColorSwatches === 'function') {
      const yourPlayer = typeof global.getPlayerById === 'function' ? global.getPlayerById('YOU') : {};
      const opponentPlayer = typeof global.getPlayerById === 'function' ? global.getPlayerById(opponentId) : {};
      global.setPlayerColorSwatches(yourPrimarySwatch, yourSecondarySwatch, yourPlayer || {});
      global.setPlayerColorSwatches(opponentPrimarySwatch, opponentSecondarySwatch, opponentPlayer || {});
    }

    panel?.classList?.toggle('yesterday-win', result === 'W');
    panel?.classList?.toggle('yesterday-tie', result === 'T');

    const styledElements = [yourName, yourScoreElement, opponentName, opponentScoreElement];
    clearResultClasses(styledElements);

    if (result === 'W') {
      yourName.classList.add('yesterdayWinner');
      yourScoreElement.classList.add('yesterdayWinnerScore');
      opponentName.classList.add('yesterdayLoser');
      opponentScoreElement.classList.add('yesterdayLoserScore');
    } else if (result === 'L') {
      yourName.classList.add('yesterdayLoser');
      yourScoreElement.classList.add('yesterdayLoserScore');
      opponentName.classList.add('yesterdayWinner');
      opponentScoreElement.classList.add('yesterdayWinnerScore');
    }

    return true;
  }

  function downsampleTrendEntries(entries) {
    if (entries.length <= TRENDLINE_MAX_POINTS) return entries;
    const step = Math.ceil(entries.length / TRENDLINE_MAX_POINTS);
    return entries.filter((_, index) => index % step === 0 || index === entries.length - 1);
  }

  function getDailyTrendEntries(dailyTotals) {
    if (!dailyTotals || typeof dailyTotals !== 'object') return [];
    return downsampleTrendEntries(
      Object.entries(dailyTotals)
        .map(([key, total]) => ({ key, value: Number(total) }))
        .filter((entry) => Number.isFinite(entry.value))
        .sort((a, b) => a.key.localeCompare(b.key))
    );
  }

  function getCaloriesTrendEntries(caloriesHistoryInput) {
    const source = Array.isArray(caloriesHistoryInput)
      ? caloriesHistoryInput.slice()
      : (typeof global.getCaloriesHistorySorted === 'function' ? global.getCaloriesHistorySorted() : []);

    return downsampleTrendEntries(
      source
        .map((entry) => ({ key: String(entry?.key || ''), value: Number(entry?.calories) }))
        .filter((entry) => Number.isFinite(entry.value))
        .sort((a, b) => a.key.localeCompare(b.key))
    );
  }

  function drawMovingAverageAboveDots(canvasId, entries, referenceValue) {
    const canvas = getElement(canvasId);
    if (!canvas?.getContext || entries.length < 2) return false;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    const width = canvas.clientWidth || 320;
    const height = canvas.clientHeight || 80;
    const dpr = global.devicePixelRatio || 1;
    const values = entries.map((entry) => entry.value);
    const rangeValues = Number.isFinite(referenceValue) ? [...values, referenceValue] : values;
    const maxValue = Math.max(...rangeValues);
    const minValue = Math.min(...rangeValues);
    const range = (maxValue - minValue) || 1;
    const paddingX = 6;
    const paddingTop = 22;
    const paddingBottom = 6;
    const chartWidth = width - paddingX * 2;
    const chartHeight = height - paddingTop - paddingBottom;
    const count = entries.length;

    const points = entries.map((entry, index) => ({
      x: paddingX + (count === 1 ? chartWidth / 2 : chartWidth * index / (count - 1)),
      value: entry.value
    }));
    const movingAveragePoints = points.map((point, index) => {
      const start = Math.max(0, index - TRENDLINE_PERIOD + 1);
      const slice = points.slice(start, index + 1);
      const average = slice.reduce((sum, current) => sum + current.value, 0) / slice.length;
      const normalized = (average - minValue) / range;
      return { x: point.x, y: paddingTop + chartHeight - normalized * chartHeight };
    });

    if (typeof ctx.save === 'function') ctx.save();
    if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.strokeStyle = TRENDLINE_COLOR;
    ctx.lineWidth = 0.9;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.moveTo(movingAveragePoints[0].x, movingAveragePoints[0].y);
    for (let index = 1; index < movingAveragePoints.length - 1; index += 1) {
      const current = movingAveragePoints[index];
      const next = movingAveragePoints[index + 1];
      ctx.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
    }
    const last = movingAveragePoints[movingAveragePoints.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    if (typeof ctx.restore === 'function') ctx.restore();
    return true;
  }

  function wrapTrendRenderer(functionName, canvasId, entriesBuilder, referenceValue) {
    const original = global[functionName];
    if (typeof original !== 'function') return false;
    if (original.__taskPointsTrendLineAboveDots) return true;
    const wrapped = function taskPointsTrendLineAboveDots(...args) {
      const result = original.apply(this, args);
      try { drawMovingAverageAboveDots(canvasId, entriesBuilder(args[0]), referenceValue); }
      catch (error) { console.warn(`TaskPoints could not redraw ${functionName} trendline above its dots.`, error); }
      return result;
    };
    wrapped.__taskPointsTrendLineAboveDots = true;
    wrapped.__taskPointsOriginal = original;
    global[functionName] = wrapped;
    return true;
  }

  function installTrendLineLayering() {
    const hasScoreCanvas = Boolean(getElement('dailyTrend'));
    const hasCaloriesCanvas = Boolean(getElement('caloriesTrend'));
    if (!hasScoreCanvas && !hasCaloriesCanvas) return true;
    const scoreReady = !hasScoreCanvas || wrapTrendRenderer('drawDailyTrend', 'dailyTrend', getDailyTrendEntries, null);
    const caloriesReady = !hasCaloriesCanvas || wrapTrendRenderer('drawCaloriesTrend', 'caloriesTrend', getCaloriesTrendEntries, 2600);
    return scoreReady && caloriesReady;
  }

  function installPatch() {
    if (typeof global.renderYesterdaysResult !== 'function' || typeof global.getCompletedYouMatchupsForStats !== 'function') return false;
    if (global.renderYesterdaysResult.__taskPointsUsesSavedCompletedMatchup) return true;
    const originalRenderYesterdaysResult = global.renderYesterdaysResult;
    const wrappedRenderYesterdaysResult = function taskPointsRenderYesterdaysSavedResult(...args) {
      const result = originalRenderYesterdaysResult.apply(this, args);
      applySavedYesterdayResult();
      return result;
    };
    wrappedRenderYesterdaysResult.__taskPointsUsesSavedCompletedMatchup = true;
    wrappedRenderYesterdaysResult.__taskPointsOriginal = originalRenderYesterdaysResult;
    global.renderYesterdaysResult = wrappedRenderYesterdaysResult;
    applySavedYesterdayResult();
    return true;
  }

  function installWhenReady() {
    const resultPatchReady = installPatch();
    const trendLayeringReady = installTrendLineLayering();
    if (resultPatchReady && trendLayeringReady) return;
    installAttempts += 1;
    if (installAttempts < 40) global.setTimeout?.(installWhenReady, 50);
  }

  global.TaskPointsHomeYesterdayResultConsistency = {
    applySavedYesterdayResult,
    installPatch,
    installPlayerPhotoFrameOverride,
    installTrendLineLayering,
    drawMovingAverageAboveDots
  };

  installPlayerPhotoFrameOverride();
  if (global.document?.readyState === 'loading') global.document.addEventListener?.('DOMContentLoaded', installWhenReady, { once: true });
  else installWhenReady();
})(typeof window !== 'undefined' ? window : globalThis);

(function installTaskPointsRecoveryJournalWriteLockGuard(global) {
  'use strict';

  const storage = global.localStorage;
  if (!storage || global.__taskPointsRecoveryJournalWriteLockGuardInstalled) return;
  global.__taskPointsRecoveryJournalWriteLockGuardInstalled = true;

  const STORAGE_KEY = global.TaskPointsCore?.STORAGE_KEY || 'taskpoints_v1';
  const HABIT_JOURNAL_KEY = global.TaskPointsCore?.PENDING_HABIT_DELTAS_KEY || 'taskpoints_pending_habit_deltas_v1';
  const LEGACY_JOURNAL_KEY = 'taskpoints_phase5b_pending_changes_v1';
  const LOCK_KEY = 'taskpoints_recovery_write_lock_v1';
  const UNCOMMITTED_LOCK_TTL_MS = 2 * 60 * 1000;
  const PAGE_STARTED_AT_MS = global.TaskPointsCore?.getRecoveryWriteLockStatus?.().pageStartedAtMs || Date.now();
  const PROTECTED_KEYS = new Set([STORAGE_KEY, HABIT_JOURNAL_KEY, LEGACY_JOURNAL_KEY]);
  let alertShown = false;

  function readLock() {
    try {
      const lock = JSON.parse(storage.getItem(LOCK_KEY) || 'null');
      if (!lock || lock.active !== true || !lock.token) return null;
      const committedAtMs = Number(lock.committedAtMs || 0);
      const createdAtMs = Number(lock.createdAtMs || 0);
      if (committedAtMs === 0 && createdAtMs > 0 && Date.now() - createdAtMs > UNCOMMITTED_LOCK_TTL_MS) {
        storage.removeItem(LOCK_KEY);
        return null;
      }
      return lock;
    } catch (_) { return null; }
  }

  function pageMayWrite(lock) {
    const committedAtMs = Number(lock?.committedAtMs || 0);
    return committedAtMs > 0 && PAGE_STARTED_AT_MS >= committedAtMs;
  }

  function assertWriteAllowed(key, operation) {
    const normalizedKey = String(key);
    if (!PROTECTED_KEYS.has(normalizedKey)) return;
    const lock = readLock();
    if (!lock || pageMayWrite(lock)) return;
    const error = new Error('TaskPoints blocked data from a tab that was open before a confirmed recovery. Reload this tab before making changes.');
    error.code = 'TASKPOINTS_RECOVERY_WRITE_LOCKED';
    error.key = normalizedKey;
    error.operation = operation;
    error.lock = lock;
    console.error(error.message, { key: normalizedKey, operation, lock });
    if (!alertShown && typeof global.alert === 'function') {
      alertShown = true;
      try { global.alert(`${error.message}\n\nYour recovered save and pending journals remain protected.`); } catch (_) {}
    }
    throw error;
  }

  function installInstanceHooks() {
    try {
      const priorSet = storage.setItem.bind(storage);
      const priorRemove = storage.removeItem.bind(storage);
      const guardedSet = function recoveryJournalLockedSetItem(key, value) {
        assertWriteAllowed(key, 'setItem');
        return priorSet(key, value);
      };
      const guardedRemove = function recoveryJournalLockedRemoveItem(key) {
        assertWriteAllowed(key, 'removeItem');
        return priorRemove(key);
      };
      storage.setItem = guardedSet;
      storage.removeItem = guardedRemove;
      return storage.setItem === guardedSet && storage.removeItem === guardedRemove;
    } catch (_) { return false; }
  }

  function installPrototypeHooks() {
    const prototype = global.Storage?.prototype;
    if (!prototype) return false;
    if (prototype.setItem && !prototype.__taskPointsRecoveryJournalLockOriginalSetItem) {
      const priorSet = prototype.setItem;
      Object.defineProperty(prototype, '__taskPointsRecoveryJournalLockOriginalSetItem', { value: priorSet, configurable: true });
      prototype.setItem = function recoveryJournalLockedSetItem(key, value) {
        if (this === storage) assertWriteAllowed(key, 'setItem');
        return priorSet.call(this, key, value);
      };
    }
    if (prototype.removeItem && !prototype.__taskPointsRecoveryJournalLockOriginalRemoveItem) {
      const priorRemove = prototype.removeItem;
      Object.defineProperty(prototype, '__taskPointsRecoveryJournalLockOriginalRemoveItem', { value: priorRemove, configurable: true });
      prototype.removeItem = function recoveryJournalLockedRemoveItem(key) {
        if (this === storage) assertWriteAllowed(key, 'removeItem');
        return priorRemove.call(this, key);
      };
    }
    return true;
  }

  const installed = installInstanceHooks() || installPrototypeHooks();
  readLock();
  global.TaskPointsRecoveryJournalWriteLockGuard = {
    installed,
    protectedKeys: [...PROTECTED_KEYS],
    pageStartedAtMs: PAGE_STARTED_AT_MS,
    readLock,
    pageMayWrite
  };
})(typeof window !== 'undefined' ? window : globalThis);

(function installTaskPointsRecoveryAttemptWriteLockGuard(global) {
  'use strict';

  const storage = global.localStorage;
  if (!storage || global.__taskPointsRecoveryAttemptWriteLockGuardInstalled) return;
  global.__taskPointsRecoveryAttemptWriteLockGuardInstalled = true;

  const STORAGE_KEY = global.TaskPointsCore?.STORAGE_KEY || 'taskpoints_v1';
  const HABIT_JOURNAL_KEY = global.TaskPointsCore?.PENDING_HABIT_DELTAS_KEY || 'taskpoints_pending_habit_deltas_v1';
  const LEGACY_JOURNAL_KEY = 'taskpoints_phase5b_pending_changes_v1';
  const ATTEMPT_LOCK_KEY = 'taskpoints_recovery_attempt_lock_v1';
  const ATTEMPT_TTL_MS = 2 * 60 * 1000;
  const PROTECTED_KEYS = new Set([STORAGE_KEY, HABIT_JOURNAL_KEY, LEGACY_JOURNAL_KEY]);
  let alertShown = false;

  function readAttemptLock() {
    try {
      const lock = JSON.parse(storage.getItem(ATTEMPT_LOCK_KEY) || 'null');
      if (!lock || lock.active !== true || !lock.token) return null;
      const createdAtMs = Number(lock.createdAtMs || 0);
      if (!createdAtMs || Date.now() - createdAtMs > ATTEMPT_TTL_MS) {
        storage.removeItem(ATTEMPT_LOCK_KEY);
        return null;
      }
      return lock;
    } catch (_) { return null; }
  }

  function assertAttemptAllowsWrite(key, operation) {
    const normalizedKey = String(key);
    if (!PROTECTED_KEYS.has(normalizedKey)) return;
    const attempt = readAttemptLock();
    if (!attempt) return;
    const error = new Error('TaskPoints paused saves while a verified recovery attempt is in progress. Finish or cancel that recovery page before making changes.');
    error.code = 'TASKPOINTS_RECOVERY_ATTEMPT_WRITE_LOCKED';
    error.key = normalizedKey;
    error.operation = operation;
    error.attempt = attempt;
    console.error(error.message, { key: normalizedKey, operation, attempt });
    if (!alertShown && typeof global.alert === 'function') {
      alertShown = true;
      try { global.alert(`${error.message}\n\nNo current data was overwritten.`); } catch (_) {}
    }
    throw error;
  }

  function installInstanceHooks() {
    try {
      const priorSet = storage.setItem.bind(storage);
      const priorRemove = storage.removeItem.bind(storage);
      const guardedSet = function recoveryAttemptLockedSetItem(key, value) {
        assertAttemptAllowsWrite(key, 'setItem');
        return priorSet(key, value);
      };
      const guardedRemove = function recoveryAttemptLockedRemoveItem(key) {
        assertAttemptAllowsWrite(key, 'removeItem');
        return priorRemove(key);
      };
      storage.setItem = guardedSet;
      storage.removeItem = guardedRemove;
      return storage.setItem === guardedSet && storage.removeItem === guardedRemove;
    } catch (_) { return false; }
  }

  function installPrototypeHooks() {
    const prototype = global.Storage?.prototype;
    if (!prototype) return false;
    if (prototype.setItem && !prototype.__taskPointsRecoveryAttemptOriginalSetItem) {
      const priorSet = prototype.setItem;
      Object.defineProperty(prototype, '__taskPointsRecoveryAttemptOriginalSetItem', { value: priorSet, configurable: true });
      prototype.setItem = function recoveryAttemptLockedSetItem(key, value) {
        if (this === storage) assertAttemptAllowsWrite(key, 'setItem');
        return priorSet.call(this, key, value);
      };
    }
    if (prototype.removeItem && !prototype.__taskPointsRecoveryAttemptOriginalRemoveItem) {
      const priorRemove = prototype.removeItem;
      Object.defineProperty(prototype, '__taskPointsRecoveryAttemptOriginalRemoveItem', { value: priorRemove, configurable: true });
      prototype.removeItem = function recoveryAttemptLockedRemoveItem(key) {
        if (this === storage) assertAttemptAllowsWrite(key, 'removeItem');
        return priorRemove.call(this, key);
      };
    }
    return true;
  }

  const installed = installInstanceHooks() || installPrototypeHooks();
  readAttemptLock();
  global.TaskPointsRecoveryAttemptWriteLockGuard = {
    installed,
    protectedKeys: [...PROTECTED_KEYS],
    attemptLockKey: ATTEMPT_LOCK_KEY,
    readAttemptLock
  };
})(typeof window !== 'undefined' ? window : globalThis);
