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

(function installTaskPointsHabitReorderJournalFastPath(global) {
  'use strict';

  if (!global || global.TaskPointsHabitReorderJournalFastPath?.__installedModule) return;

  const OVERLAY_KEY = 'taskpoints_habit_order_overlay_v1';
  const REQUIRED_QUIET_MS = 8000;
  const RETRY_MS = 500;
  const REORDER_ACTIONS = new Set([
    'habit-up', 'habit-down',
    'habit-group-item-up', 'habit-group-item-down',
    'habit-group-up', 'habit-group-down'
  ]);

  let installed = false;
  let installAttempts = 0;
  let fastClicks = 0;
  let suppressedSaveCalls = 0;
  let overlayWrites = 0;
  let overlayReplays = 0;
  let compactions = 0;
  let v2MirrorQueues = 0;
  let v2MirrorQueueFailures = 0;
  let compactionTimer = 0;
  let compactionGeneration = 0;
  let lastReorderAt = 0;
  let lastReason = 'not_installed';

  function mark(name, detail = {}) {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
  }

  function queueV2OrderMirror(overlay, reason = 'habit-order-overlay') {
    try {
      const runtime = global.TaskPointsStateRuntimeV2;
      if (typeof runtime?.enqueueHabitOrderOverlay !== 'function') return false;
      runtime.enqueueHabitOrderOverlay(overlay);
      v2MirrorQueues += 1;
      mark('habit.reorder.v2MirrorQueued', {
        reason,
        entries: Object.keys(overlay?.orders || {}).length,
        updatedAtISO: overlay?.updatedAtISO || null
      });
      return true;
    } catch (error) {
      v2MirrorQueueFailures += 1;
      mark('habit.reorder.v2MirrorQueueFailed', {
        reason,
        message: String(error?.message || error)
      });
      return false;
    }
  }

  function getHabits() {
    try {
      return typeof state !== 'undefined' && Array.isArray(state?.habits)
        ? state.habits
        : null;
    } catch (_) {
      return null;
    }
  }

  function getOrderMap(habits = getHabits()) {
    const orders = {};
    if (!Array.isArray(habits)) return orders;
    habits.forEach((habit) => {
      if (!habit?.id) return;
      const order = Number(habit.order);
      if (Number.isFinite(order)) orders[habit.id] = order;
    });
    return orders;
  }

  function orderMapsEqual(a, b) {
    const aKeys = Object.keys(a || {}).sort();
    const bKeys = Object.keys(b || {}).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key, index) => key === bKeys[index] && Number(a[key]) === Number(b[key]));
  }

  function stateMatchesOrders(habits, orders) {
    if (!Array.isArray(habits) || !orders || typeof orders !== 'object') return false;
    const byId = new Map(habits.filter(Boolean).map((habit) => [habit.id, habit]));
    return Object.entries(orders).every(([id, order]) => {
      const habit = byId.get(id);
      return habit && Number(habit.order) === Number(order);
    });
  }

  function readOverlay() {
    try {
      const raw = global.localStorage?.getItem?.(OVERLAY_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && parsed.orders && typeof parsed.orders === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function clearOverlay() {
    try { global.localStorage?.removeItem?.(OVERLAY_KEY); } catch (_) {}
  }

  function writeOverlay() {
    const orders = getOrderMap();
    const payload = {
      version: 1,
      updatedAtISO: new Date().toISOString(),
      orders
    };
    const raw = JSON.stringify(payload);
    global.localStorage?.setItem?.(OVERLAY_KEY, raw);
    overlayWrites += 1;
    mark('habit.reorder.overlayWritten', {
      entries: Object.keys(orders).length,
      bytes: raw.length * 2
    });
    queueV2OrderMirror(payload, 'overlay-written');
    return payload;
  }

  function applyOverlay() {
    const overlay = readOverlay();
    const habits = getHabits();
    if (!overlay || !Array.isArray(habits)) return 0;

    if (stateMatchesOrders(habits, overlay.orders)) {
      queueV2OrderMirror(overlay, 'overlay-already-compacted');
      clearOverlay();
      lastReason = 'overlay_already_compacted';
      return 0;
    }

    let changed = 0;
    habits.forEach((habit) => {
      if (!habit?.id || !Object.prototype.hasOwnProperty.call(overlay.orders, habit.id)) return;
      const nextOrder = Number(overlay.orders[habit.id]);
      if (!Number.isFinite(nextOrder) || Number(habit.order) === nextOrder) return;
      habit.order = nextOrder;
      changed += 1;
    });

    if (changed) {
      overlayReplays += 1;
      lastReason = 'overlay_replayed';
      queueV2OrderMirror(overlay, 'overlay-replayed');
      try { global.renderHabits?.(); } catch (_) {}
      try { global.renderVices?.(); } catch (_) {}
      mark('habit.reorder.overlayReplayed', { changed });
      scheduleCompaction();
    }
    return changed;
  }

  function clearCompactionTimer() {
    if (compactionTimer) global.clearTimeout?.(compactionTimer);
    compactionTimer = 0;
  }

  function idleReady() {
    if (global.document?.visibilityState === 'hidden') return false;
    try {
      const status = global.TaskPointsCore?.getStorageMaintenanceIdleStatus?.();
      if (status && typeof status === 'object') {
        if (status.pageLeaving === true || status.activeEditor === true) return false;
        if (Number(status.navigationQuietForMs || 0) > 0) return false;
        return Number(status.lastInteractionAgoMs || 0) >= REQUIRED_QUIET_MS;
      }
    } catch (_) {}
    return Date.now() - lastReorderAt >= REQUIRED_QUIET_MS;
  }

  function verifyCanonicalOverlay(overlay) {
    try {
      const stored = global.TaskPointsCore?.readTaskPointsStoredState?.('taskpoints_v1', {}) || null;
      return Boolean(stored && stateMatchesOrders(stored.habits, overlay?.orders));
    } catch (_) {
      return false;
    }
  }

  function attemptCompaction(generation) {
    compactionTimer = 0;
    if (generation !== compactionGeneration) return;
    const overlay = readOverlay();
    if (!overlay) return;
    if (!idleReady() || typeof global.save !== 'function') {
      compactionTimer = global.setTimeout?.(() => attemptCompaction(generation), RETRY_MS) || 0;
      return;
    }

    const started = global.performance?.now?.() ?? Date.now();
    mark('habit.reorder.compactionStarted', { entries: Object.keys(overlay.orders || {}).length });
    try {
      global.save('habit-reorder-idle-compaction', {
        immediateWrite: true,
        interactive: false,
        userInitiated: false,
        deferCompression: true
      });
      const verified = verifyCanonicalOverlay(overlay);
      if (verified) {
        clearOverlay();
        compactions += 1;
        lastReason = 'compacted';
      } else {
        lastReason = 'compaction_unverified';
        compactionTimer = global.setTimeout?.(() => attemptCompaction(generation), 2000) || 0;
      }
      mark('habit.reorder.compactionCompleted', {
        verified,
        durationMs: Math.max(0, Math.round((global.performance?.now?.() ?? Date.now()) - started))
      });
    } catch (error) {
      lastReason = 'compaction_failed';
      console.warn('Habit reorder idle compaction failed; durable overlay retained.', error);
      compactionTimer = global.setTimeout?.(() => attemptCompaction(generation), 2000) || 0;
    }
  }

  function scheduleCompaction() {
    clearCompactionTimer();
    compactionGeneration += 1;
    const generation = compactionGeneration;
    compactionTimer = global.setTimeout?.(() => attemptCompaction(generation), RETRY_MS) || 0;
  }

  function invokeExistingMove(action, button) {
    const before = getOrderMap();
    const originalSave = global.save;
    let localSuppressedSaves = 0;
    const started = global.performance?.now?.() ?? Date.now();

    if (typeof originalSave !== 'function') {
      lastReason = 'save_unavailable';
      return false;
    }

    global.save = function taskPointsHabitReorderSuppressedSave() {
      localSuppressedSaves += 1;
      suppressedSaveCalls += 1;
      return undefined;
    };

    try {
      if (action === 'habit-up' || action === 'habit-down') {
        global.moveHabit?.(
          button.getAttribute('data-id'),
          action === 'habit-up' ? -1 : 1
        );
      } else if (action === 'habit-group-item-up' || action === 'habit-group-item-down') {
        global.moveHabitWithinGroup?.(
          button.getAttribute('data-id'),
          button.getAttribute('data-group-tag'),
          action === 'habit-group-item-up' ? -1 : 1
        );
      } else if (action === 'habit-group-up' || action === 'habit-group-down') {
        global.moveHabitGroup?.(
          button.getAttribute('data-tag'),
          action === 'habit-group-up' ? -1 : 1
        );
      }
    } finally {
      global.save = originalSave;
    }

    const after = getOrderMap();
    const changed = !orderMapsEqual(before, after);
    if (changed) {
      writeOverlay();
      lastReorderAt = Date.now();
      fastClicks += 1;
      lastReason = 'fast_reorder';
      scheduleCompaction();
    } else {
      lastReason = 'reorder_no_change';
    }

    mark('habit.reorder.fastClick', {
      action,
      changed,
      suppressedSaveCalls: localSuppressedSaves,
      durationMs: Math.max(0, Math.round((global.performance?.now?.() ?? Date.now()) - started))
    });
    return changed;
  }

  function onCaptureClick(event) {
    const button = event?.target?.closest?.('button[data-act]');
    if (!button) return;
    const action = button.getAttribute('data-act');
    if (!REORDER_ACTIONS.has(action)) return;
    if (button.disabled) return;

    event.preventDefault?.();
    event.stopPropagation?.();
    invokeExistingMove(action, button);
  }

  function getStatus() {
    return {
      installed,
      overlayKey: OVERLAY_KEY,
      requiredQuietMs: REQUIRED_QUIET_MS,
      fastClicks,
      suppressedSaveCalls,
      overlayWrites,
      overlayReplays,
      compactions,
      v2MirrorQueues,
      v2MirrorQueueFailures,
      overlayPending: Boolean(readOverlay()),
      lastReason
    };
  }

  function install() {
    installAttempts += 1;
    if (installed) {
      applyOverlay();
      return getStatus();
    }
    if (!global.document?.addEventListener) {
      lastReason = 'document_unavailable';
      return getStatus();
    }

    global.document.addEventListener('click', onCaptureClick, true);
    installed = true;
    lastReason = 'installed';
    applyOverlay();
    mark('habit.reorder.fastPathInstalled', { requiredQuietMs: REQUIRED_QUIET_MS });
    return getStatus();
  }

  global.TaskPointsHabitReorderJournalFastPath = {
    __installedModule: true,
    OVERLAY_KEY,
    install,
    applyOverlay,
    getStatus
  };

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
