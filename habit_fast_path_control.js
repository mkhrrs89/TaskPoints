(function installTaskPointsHabitFastPathControl(global) {
  'use strict';

  if (!global || global.TaskPointsHabitFastPathControl?.__installedModule) return;

  const DISABLED_KEY = 'taskpoints_habit_fast_path_disabled_v1';
  let installed = false;
  let originalHandler = null;
  let controlledHandler = null;
  let installAttempts = 0;
  let fastPathCalls = 0;
  let legacyFallbackCalls = 0;
  let lastReason = 'not_installed';
  let installedAtISO = '';

  function safeGet(key) {
    try { return global.localStorage?.getItem?.(key) ?? null; }
    catch (_) { return null; }
  }

  function safeSet(key, value) {
    try {
      global.localStorage?.setItem?.(key, value);
      return true;
    } catch (_) {
      return false;
    }
  }

  function safeRemove(key) {
    try {
      global.localStorage?.removeItem?.(key);
      return true;
    } catch (_) {
      return false;
    }
  }

  function isDisabled() {
    return global.__TP_DISABLE_HABIT_FAST_PATH === true || safeGet(DISABLED_KEY) === '1';
  }

  function readBubbleIdentity(bubbleEl) {
    const habitId = String(bubbleEl?.getAttribute?.('data-habit') || '').trim();
    const dayKey = String(bubbleEl?.getAttribute?.('data-day') || '').trim();
    return { habitId, dayKey };
  }

  function runLegacyFallback(bubbleEl) {
    const { habitId, dayKey } = readBubbleIdentity(bubbleEl);
    if (!habitId || !dayKey || typeof global.toggleHabitDay !== 'function') return false;
    legacyFallbackCalls += 1;
    global.toggleHabitDay(habitId, dayKey);
    return true;
  }

  function status() {
    return {
      installed,
      enabled: !isDisabled(),
      disabledKey: DISABLED_KEY,
      fastPathCalls,
      legacyFallbackCalls,
      installAttempts,
      lastReason,
      installedAtISO,
      originalHandlerAvailable: typeof originalHandler === 'function',
      legacyFallbackAvailable: typeof global.toggleHabitDay === 'function'
    };
  }

  function install() {
    installAttempts += 1;

    if (controlledHandler && global.handleHabitBubbleTap === controlledHandler) {
      installed = true;
      lastReason = isDisabled() ? 'installed_disabled' : 'installed_enabled';
      return status();
    }

    const candidate = global.handleHabitBubbleTap;
    if (typeof candidate !== 'function') {
      installed = false;
      lastReason = 'fast_handler_unavailable';
      return status();
    }

    if (candidate.__tpHabitFastPathControlled === true && typeof candidate.__tpOriginalHabitFastHandler === 'function') {
      controlledHandler = candidate;
      originalHandler = candidate.__tpOriginalHabitFastHandler;
      installed = true;
      installedAtISO ||= new Date().toISOString();
      lastReason = isDisabled() ? 'installed_disabled' : 'installed_enabled';
      return status();
    }

    originalHandler = candidate;
    controlledHandler = function taskPointsControlledHabitBubbleTap(bubbleEl) {
      if (isDisabled()) {
        if (runLegacyFallback(bubbleEl)) {
          lastReason = 'legacy_fallback_used';
          return undefined;
        }
        lastReason = 'legacy_fallback_unavailable_used_fast_path';
      } else {
        lastReason = 'fast_path_used';
      }

      fastPathCalls += 1;
      return originalHandler.apply(this, arguments);
    };

    Object.defineProperties(controlledHandler, {
      __tpHabitFastPathControlled: { value: true },
      __tpOriginalHabitFastHandler: { value: originalHandler }
    });

    global.handleHabitBubbleTap = controlledHandler;
    installed = global.handleHabitBubbleTap === controlledHandler;
    if (installed) {
      installedAtISO = new Date().toISOString();
      lastReason = isDisabled() ? 'installed_disabled' : 'installed_enabled';
    } else {
      controlledHandler = null;
      originalHandler = null;
      lastReason = 'handler_wrap_failed';
    }
    return status();
  }

  function disable() {
    global.__TP_DISABLE_HABIT_FAST_PATH = true;
    safeSet(DISABLED_KEY, '1');
    lastReason = 'disabled_by_kill_switch';
    return status();
  }

  function enable() {
    global.__TP_DISABLE_HABIT_FAST_PATH = false;
    safeRemove(DISABLED_KEY);
    lastReason = 'enabled';
    return status();
  }

  const api = {
    __installedModule: true,
    DISABLED_KEY,
    install,
    enable,
    disable,
    isEnabled: () => !isDisabled(),
    getStatus: status
  };

  global.TaskPointsHabitFastPathControl = api;

  const installAfterHomeScript = () => install();
  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', installAfterHomeScript, { once: true });
  } else if (typeof global.setTimeout === 'function') {
    global.setTimeout(installAfterHomeScript, 0);
  } else {
    installAfterHomeScript();
  }

  global.addEventListener?.('pageshow', installAfterHomeScript);

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

(function installTaskPointsImmediateHabitWeekPlate(global) {
  'use strict';

  if (!global || global.TaskPointsImmediateHabitWeekPlate?.__installedModule) return;

  let installed = false;
  let originalRefresh = null;
  let immediateRefresh = null;
  let installAttempts = 0;
  let immediateRestacks = 0;
  let fallbackCalls = 0;
  let lastReason = 'not_installed';

  function helpersAvailable() {
    return typeof global.refreshHabitRowWeekCompleteVisual === 'function'
      && typeof isHabitWeeklyCompleteForDays === 'function'
      && typeof addHabitWeeklyCompleteClasses === 'function'
      && typeof habitWeekCompleteRowClasses !== 'undefined'
      && Array.isArray(habitWeekCompleteRowClasses)
      && typeof state !== 'undefined';
  }

  function getStatus() {
    return {
      installed,
      installAttempts,
      immediateRestacks,
      fallbackCalls,
      lastReason,
      originalRefreshAvailable: typeof originalRefresh === 'function'
    };
  }

  function runOriginal(row, habit, days) {
    fallbackCalls += 1;
    lastReason = 'original_refresh_fallback';
    return typeof originalRefresh === 'function'
      ? originalRefresh(row, habit, days)
      : undefined;
  }

  function install() {
    installAttempts += 1;

    if (immediateRefresh && global.refreshHabitRowWeekCompleteVisual === immediateRefresh) {
      installed = true;
      lastReason = 'installed';
      return getStatus();
    }

    if (!helpersAvailable()) {
      installed = false;
      lastReason = 'home_helpers_unavailable';
      return getStatus();
    }

    const candidate = global.refreshHabitRowWeekCompleteVisual;
    if (
      candidate?.__tpImmediateHabitWeekPlate === true
      && typeof candidate.__tpOriginalHabitWeekRefresh === 'function'
    ) {
      immediateRefresh = candidate;
      originalRefresh = candidate.__tpOriginalHabitWeekRefresh;
      installed = true;
      lastReason = 'installed';
      return getStatus();
    }

    originalRefresh = candidate;
    immediateRefresh = function taskPointsImmediateHabitWeekPlateRefresh(row, habit, days) {
      if (!row || !habit || !Array.isArray(days)) {
        return runOriginal(row, habit, days);
      }

      try {
        const currentStack = row.parentElement?.classList?.contains('habitWeekCompleteStack')
          ? row.parentElement
          : null;
        const container = currentStack?.parentElement || row.parentElement;
        const anchor = currentStack || row;
        if (!container || !anchor) return runOriginal(row, habit, days);

        const isRestackNode = (node) =>
          node?.classList?.contains('habitRow')
          || node?.classList?.contains('habitWeekCompleteStack');

        const containerChildren = Array.from(container.children || []);
        const anchorIndex = containerChildren.indexOf(anchor);
        if (anchorIndex === -1) return runOriginal(row, habit, days);

        let segmentStart = anchorIndex;
        let segmentEnd = anchorIndex;
        while (segmentStart > 0 && isRestackNode(containerChildren[segmentStart - 1])) {
          segmentStart -= 1;
        }
        while (
          segmentEnd + 1 < containerChildren.length
          && isRestackNode(containerChildren[segmentEnd + 1])
        ) {
          segmentEnd += 1;
        }

        const segmentNodes = containerChildren.slice(segmentStart, segmentEnd + 1);
        const segmentRows = segmentNodes.flatMap((node) => {
          if (node.classList?.contains('habitRow')) return [node];
          return Array.from(node.children || [])
            .filter((child) => child.classList?.contains('habitRow'));
        });
        if (!segmentRows.includes(row)) return runOriginal(row, habit, days);

        const getRowHabit = (habitRow) => {
          if (habitRow === row) return habit;
          const rowHabitId = habitRow.dataset?.habitRowId;
          return state.habits.find((candidateHabit) => candidateHabit.id === rowHabitId);
        };
        const completionFlags = segmentRows.map((habitRow) => {
          const rowHabit = getRowHabit(habitRow);
          return Boolean(rowHabit && isHabitWeeklyCompleteForDays(rowHabit, days));
        });

        const marker = global.document.createComment('habit-week-restack');
        container.insertBefore(marker, segmentNodes[0]);

        const fragment = global.document.createDocumentFragment();
        let completedStack = null;

        segmentRows.forEach((habitRow, index) => {
          const isWeeklyComplete = completionFlags[index];
          habitRow.classList.remove(...habitWeekCompleteRowClasses);
          habitRow.querySelector('.habitDaysRow')
            ?.classList.toggle('week-complete-row', isWeeklyComplete);
          addHabitWeeklyCompleteClasses(
            habitRow,
            isWeeklyComplete,
            completionFlags[index - 1] === true,
            completionFlags[index + 1] === true
          );

          if (!isWeeklyComplete) {
            completedStack = null;
            fragment.appendChild(habitRow);
            return;
          }

          if (!completedStack) {
            completedStack = global.document.createElement('div');
            completedStack.className = 'habitWeekCompleteStack';
            fragment.appendChild(completedStack);
          }
          completedStack.appendChild(habitRow);
        });

        segmentNodes.forEach((node) => {
          if (node.parentElement === container) node.remove();
        });
        container.insertBefore(fragment, marker);
        marker.remove();

        immediateRestacks += 1;
        lastReason = 'immediate_restack';
        return undefined;
      } catch (error) {
        console.error('Immediate habit week plate refresh failed', error);
        return runOriginal(row, habit, days);
      }
    };

    Object.defineProperties(immediateRefresh, {
      __tpImmediateHabitWeekPlate: { value: true },
      __tpOriginalHabitWeekRefresh: { value: originalRefresh }
    });

    global.refreshHabitRowWeekCompleteVisual = immediateRefresh;
    installed = global.refreshHabitRowWeekCompleteVisual === immediateRefresh;
    lastReason = installed ? 'installed' : 'assignment_failed';
    return getStatus();
  }

  function disable() {
    if (originalRefresh && global.refreshHabitRowWeekCompleteVisual === immediateRefresh) {
      global.refreshHabitRowWeekCompleteVisual = originalRefresh;
    }
    installed = false;
    lastReason = 'disabled';
    return getStatus();
  }

  function enable() {
    return install();
  }

  const api = {
    __installedModule: true,
    install,
    enable,
    disable,
    getStatus
  };
  global.TaskPointsImmediateHabitWeekPlate = api;

  const installAfterHomeScript = () => install();
  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', installAfterHomeScript, { once: true });
  } else if (typeof global.setTimeout === 'function') {
    global.setTimeout(installAfterHomeScript, 0);
  } else {
    installAfterHomeScript();
  }

  global.addEventListener?.('pageshow', installAfterHomeScript);
})(typeof window !== 'undefined' ? window : globalThis);

(function installTaskPointsHabitReorderFastPath(global) {
  'use strict';

  if (!global || global.TaskPointsHabitReorderFastPath?.__installedModule) return;

  const REORDER_FUNCTIONS = ['moveHabit', 'moveHabitWithinGroup', 'moveHabitGroup'];
  const REQUIRED_QUIET_MS = 3000;
  const POLL_MS = 180;
  const MAX_INSTALL_ATTEMPTS = 240;
  const originals = new Map();
  let installAttempts = 0;
  let installed = false;
  let pending = false;
  let pendingGeneration = 0;
  let timer = 0;
  let interceptedSaves = 0;
  let deferredFlushes = 0;
  let forcedFlushes = 0;
  let lastReason = 'not_installed';
  let pageLeaving = false;

  function mark(name, detail = {}) {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
  }

  function clearTimer() {
    if (timer) global.clearTimeout?.(timer);
    timer = 0;
  }

  function idleStatus() {
    try {
      const status = global.TaskPointsCore?.getStorageMaintenanceIdleStatus?.();
      return status && typeof status === 'object' ? status : null;
    } catch (_) {
      return null;
    }
  }

  function readyForDeferredSave(status = idleStatus()) {
    if (pageLeaving) return true;
    if (!status) return null;
    if (status.pageLeaving === true || global.document?.visibilityState === 'hidden') return false;
    if (status.activeEditor === true) return false;
    if (Number(status.navigationQuietForMs || 0) > 0) return false;
    return Number(status.lastInteractionAgoMs || 0) >= REQUIRED_QUIET_MS;
  }

  function persistNow(reason = 'deferred') {
    if (!pending || typeof global.save !== 'function') return false;
    clearTimer();
    pending = false;
    pendingGeneration += 1;
    if (reason === 'deferred') deferredFlushes += 1;
    else forcedFlushes += 1;
    const started = global.performance?.now?.() ?? Date.now();
    mark('habit.reorder.persistStarted', { reason });
    try {
      global.save('habit-reorder-deferred', {
        immediateWrite: true,
        userInitiated: true,
        interactive: true,
        deferCompression: true
      });
      mark('habit.reorder.persistCompleted', {
        reason,
        durationMs: Math.max(0, Math.round((global.performance?.now?.() ?? Date.now()) - started))
      });
      lastReason = `persisted_${reason}`;
      return true;
    } catch (error) {
      pending = true;
      lastReason = 'persist_failed';
      console.warn('Deferred habit reorder save failed; will retry.', error);
      return false;
    }
  }

  function attemptDeferredSave(generation) {
    timer = 0;
    if (!pending || generation !== pendingGeneration) return;
    const status = idleStatus();
    const ready = readyForDeferredSave(status);
    if (ready === true || ready === null) {
      persistNow('deferred');
      return;
    }
    timer = global.setTimeout?.(() => attemptDeferredSave(generation), POLL_MS) || 0;
  }

  function scheduleDeferredSave(source) {
    pending = true;
    pendingGeneration += 1;
    const generation = pendingGeneration;
    clearTimer();
    mark('habit.reorder.persistQueued', {
      source,
      requiredQuietMs: REQUIRED_QUIET_MS,
      generation
    });
    timer = global.setTimeout?.(() => attemptDeferredSave(generation), POLL_MS) || 0;
  }

  function wrapReorderFunction(name, candidate) {
    if (candidate?.__tpHabitReorderFastPath === true) return candidate;
    originals.set(name, candidate);
    const wrapped = function taskPointsHabitReorderFastPathWrapper() {
      const core = global.TaskPointsCore;
      if (!core || typeof core.saveStateSnapshot !== 'function') {
        lastReason = 'core_save_unavailable';
        return candidate.apply(this, arguments);
      }

      const originalSaveStateSnapshot = core.saveStateSnapshot;
      let intercepted = false;
      const captureSave = function taskPointsHabitReorderSaveCapture(nextState, options = {}) {
        if (intercepted) return originalSaveStateSnapshot.apply(this, arguments);
        intercepted = true;
        interceptedSaves += 1;
        return {
          state: nextState,
          trimmed: false,
          skipped: false,
          noOp: true,
          storageKey: options.storageKey || core.STORAGE_KEY || 'taskpoints_v1',
          encoding: 'deferred-habit-reorder'
        };
      };
      core.saveStateSnapshot = captureSave;

      const started = global.performance?.now?.() ?? Date.now();
      try {
        const result = candidate.apply(this, arguments);
        if (intercepted) scheduleDeferredSave(name);
        mark('habit.reorder.fastPath', {
          source: name,
          intercepted,
          durationMs: Math.max(0, Math.round((global.performance?.now?.() ?? Date.now()) - started))
        });
        lastReason = intercepted ? 'fast_path_used' : 'save_not_intercepted';
        return result;
      } finally {
        if (core.saveStateSnapshot === captureSave) core.saveStateSnapshot = originalSaveStateSnapshot;
      }
    };

    Object.defineProperties(wrapped, {
      __tpHabitReorderFastPath: { value: true },
      __tpOriginalHabitReorder: { value: candidate },
      __tpHabitReorderName: { value: name }
    });
    return wrapped;
  }

  function install() {
    installAttempts += 1;
    let available = 0;
    let wrappedCount = 0;

    for (const name of REORDER_FUNCTIONS) {
      const candidate = global[name];
      if (typeof candidate !== 'function') continue;
      available += 1;
      if (candidate.__tpHabitReorderFastPath === true) {
        wrappedCount += 1;
        continue;
      }
      global[name] = wrapReorderFunction(name, candidate);
      if (global[name]?.__tpHabitReorderFastPath === true) wrappedCount += 1;
    }

    installed = available > 0 && wrappedCount === available;
    lastReason = installed ? 'installed' : (available ? 'partial_install' : 'reorder_functions_unavailable');
    return getStatus();
  }

  function getStatus() {
    return {
      installed,
      installAttempts,
      requiredQuietMs: REQUIRED_QUIET_MS,
      pending,
      pendingGeneration,
      interceptedSaves,
      deferredFlushes,
      forcedFlushes,
      lastReason,
      wrappedFunctions: REORDER_FUNCTIONS.filter((name) => global[name]?.__tpHabitReorderFastPath === true)
    };
  }

  global.TaskPointsHabitReorderFastPath = {
    __installedModule: true,
    install,
    flush: () => persistNow('manual'),
    getStatus
  };

  const installWhenReady = () => {
    const status = install();
    if (!status.installed && installAttempts < MAX_INSTALL_ATTEMPTS) {
      global.setTimeout?.(installWhenReady, 50);
    }
  };

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', installWhenReady, { once: true });
  } else {
    installWhenReady();
  }

  global.addEventListener?.('pageshow', () => {
    pageLeaving = false;
    installWhenReady();
  });
  global.addEventListener?.('pagehide', () => {
    pageLeaving = true;
    if (pending) persistNow('pagehide');
  });
  global.addEventListener?.('beforeunload', () => {
    pageLeaving = true;
    if (pending) persistNow('beforeunload');
  });
  global.document?.addEventListener?.('visibilitychange', () => {
    if (global.document.visibilityState === 'hidden' && pending) persistNow('hidden');
  });
})(typeof window !== 'undefined' ? window : globalThis);
