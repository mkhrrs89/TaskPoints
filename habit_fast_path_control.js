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
          const rowHabitId = habitRow.dataset?.habitRowRowId;
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
