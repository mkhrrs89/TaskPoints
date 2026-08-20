(function installTaskPointsFlexActionFastPath(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const storage = global.localStorage;
  if (!core || !storage || global.__taskPointsFlexActionFastPathInstalled) return;
  global.__taskPointsFlexActionFastPathInstalled = true;

  const criticalTaskStyleId = 'tp-critical-task-opaque-preview';
  if (global.document && !global.document.getElementById?.(criticalTaskStyleId)) {
    const criticalTaskStyle = global.document.createElement?.('style');
    if (criticalTaskStyle) {
      criticalTaskStyle.id = criticalTaskStyleId;
      criticalTaskStyle.textContent = `
.critical-card {
  background: linear-gradient(180deg, #991b1b, #581c1c) !important;
}
`;
      (global.document.head || global.document.documentElement)?.appendChild?.(criticalTaskStyle);
    }
  }

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const JOURNAL_KEY = 'taskpoints_pending_flex_completions_v1';
  const ORDER_JOURNAL_KEY = 'taskpoints_pending_flex_order_v1';
  const SAVE_PATH = 'flex-completion-fast-path';
  const MAX_INSTALL_ATTEMPTS = 120;
  const RETRY_BASE_DELAY_MS = 1000;
  const RETRY_MAX_DELAY_MS = 30000;
  const MAX_AUTOMATIC_RETRIES = 5;
  const REQUIRED_QUIET_MS = 8000;
  const QUIET_POLL_MS = 250;
  const originalLoadAppState = typeof core.loadAppState === 'function' ? core.loadAppState.bind(core) : null;
  const originalSaveStateSnapshot = typeof core.saveStateSnapshot === 'function' ? core.saveStateSnapshot.bind(core) : null;

  let installAttempts = 0;
  let uiInstalled = false;
  let savePending = false;
  let saveRunning = false;
  let saveRaf = 0;
  let saveTimer = 0;
  let retryTimer = 0;
  let retryAttempt = 0;
  let retryPaused = false;
  let malformedWarningShown = false;
  let malformedOrderWarningShown = false;
  let renderPending = false;
  let pendingRenderSatisfied = false;
  let quietDeferred = false;
  let quietDeferrals = 0;
  let quietRuns = 0;
  let originalLogFlexCompletion = null;
  let originalHomeSave = null;
  let originalAddCompletion = null;
  let originalRenderAll = null;
  let originalRenderFlexActions = null;
  let originalMoveFlexAction = null;
  let originalResetAll = null;

  function parse(raw, fallback = null) {
    try { return JSON.parse(raw); } catch (_) { return fallback; }
  }

  function normalizeEntry(entry) {
    if (!entry || entry.source !== 'flex' || !entry.id || !entry.flexId || !entry.completedAtISO) return null;
    return {
      ...entry,
      id: String(entry.id),
      flexId: String(entry.flexId),
      taskId: entry.taskId == null ? null : entry.taskId,
      title: String(entry.title || '[Flex]'),
      points: Number(entry.points) || 0,
      completedAtISO: String(entry.completedAtISO),
      source: 'flex'
    };
  }

  function readJournalRecord() {
    const raw = storage.getItem(JOURNAL_KEY);
    if (!raw) return { raw: '', malformed: false, entries: [] };
    const parsed = parse(raw, null);
    if (!Array.isArray(parsed)) return { raw, malformed: true, entries: [] };
    const byId = new Map();
    parsed.forEach((entry) => {
      const normalized = normalizeEntry(entry);
      if (normalized) byId.set(normalized.id, normalized);
    });
    return { raw, malformed: false, entries: [...byId.values()] };
  }

  function readJournal() {
    return readJournalRecord().entries;
  }

  function warnMalformedJournal() {
    if (malformedWarningShown) return;
    malformedWarningShown = true;
    const message = 'TaskPoints preserved a malformed pending Flex Action journal instead of overwriting it. No new Flex Action was recorded.';
    console.error(message);
    try { global.alert?.(message); } catch (_) {}
  }

  function normalizeOrderRecord(value) {
    if (!value || !Array.isArray(value.orderedIds)) return null;
    const orderedIds = [];
    const seen = new Set();
    value.orderedIds.forEach((rawId) => {
      const id = String(rawId || '').trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      orderedIds.push(id);
    });
    if (!orderedIds.length) return null;
    return {
      version: 1,
      orderedIds,
      updatedAtISO: String(value.updatedAtISO || new Date().toISOString())
    };
  }

  function readOrderJournalRecord() {
    const raw = storage.getItem(ORDER_JOURNAL_KEY);
    if (!raw) return { raw: '', malformed: false, record: null };
    const record = normalizeOrderRecord(parse(raw, null));
    return record
      ? { raw, malformed: false, record }
      : { raw, malformed: true, record: null };
  }

  function readOrderJournal() {
    return readOrderJournalRecord().record;
  }

  function warnMalformedOrderJournal() {
    if (malformedOrderWarningShown) return;
    malformedOrderWarningShown = true;
    const message = 'TaskPoints preserved a malformed pending Flex Action order journal instead of overwriting it. The reorder will use the normal save path.';
    console.error(message);
    try { global.alert?.(message); } catch (_) {}
  }

  function recoveryWriteAllowed() {
    const recoveryGuard = global.TaskPointsRecoveryJournalWriteLockGuard;
    const recoveryLock = recoveryGuard?.readLock?.() || null;
    if (recoveryLock && recoveryGuard?.pageMayWrite?.(recoveryLock) !== true) return false;
    const recoveryAttempt = global.TaskPointsRecoveryAttemptWriteLockGuard?.readAttemptLock?.() || null;
    return !recoveryAttempt;
  }

  function writeJournal(entries) {
    if (!recoveryWriteAllowed()) {
      const error = new Error('TaskPoints paused Flex Action changes while recovery protection is active.');
      error.code = 'TASKPOINTS_FLEX_JOURNAL_WRITE_LOCKED';
      throw error;
    }
    const existing = readJournalRecord();
    if (existing.malformed) {
      warnMalformedJournal();
      const error = new Error('Pending Flex Action journal is malformed and was preserved.');
      error.code = 'TASKPOINTS_FLEX_JOURNAL_MALFORMED';
      throw error;
    }
    const normalized = (entries || []).map(normalizeEntry).filter(Boolean);
    if (!normalized.length) {
      storage.removeItem(JOURNAL_KEY);
      return [];
    }
    storage.setItem(JOURNAL_KEY, JSON.stringify(normalized));
    return normalized;
  }

  function appendJournal(entry) {
    const normalized = normalizeEntry(entry);
    if (!normalized) return null;
    const record = readJournalRecord();
    if (record.malformed) {
      warnMalformedJournal();
      const error = new Error('Pending Flex Action journal is malformed and was preserved.');
      error.code = 'TASKPOINTS_FLEX_JOURNAL_MALFORMED';
      throw error;
    }
    const entries = record.entries;
    const at = entries.findIndex((item) => item.id === normalized.id);
    if (at >= 0) entries[at] = normalized;
    else entries.push(normalized);
    writeJournal(entries);
    return normalized;
  }

  function writeOrderJournal(orderedIds) {
    if (!recoveryWriteAllowed()) {
      const error = new Error('TaskPoints paused Flex Action reordering while recovery protection is active.');
      error.code = 'TASKPOINTS_FLEX_ORDER_JOURNAL_WRITE_LOCKED';
      throw error;
    }
    const existing = readOrderJournalRecord();
    if (existing.malformed) {
      warnMalformedOrderJournal();
      const error = new Error('Pending Flex Action order journal is malformed and was preserved.');
      error.code = 'TASKPOINTS_FLEX_ORDER_JOURNAL_MALFORMED';
      throw error;
    }
    const record = normalizeOrderRecord({ orderedIds, updatedAtISO: new Date().toISOString() });
    if (!record) {
      storage.removeItem(ORDER_JOURNAL_KEY);
      return null;
    }
    storage.setItem(ORDER_JOURNAL_KEY, JSON.stringify(record));
    return record;
  }

  function captureRenderedFlexOrder() {
    const list = global.document?.getElementById?.('flexList');
    const buttons = list?.querySelectorAll?.('[data-act="flex-up"][data-id]') || [];
    const ids = [];
    const seen = new Set();
    for (const button of buttons) {
      const id = String(button.getAttribute?.('data-id') || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }

  function applyJournalToState(sourceState, entries = readJournal()) {
    const state = sourceState && typeof sourceState === 'object' && !Array.isArray(sourceState)
      ? sourceState
      : {};
    const completions = Array.isArray(state.completions) ? state.completions : [];
    const existingIds = new Set(completions.map((entry) => entry?.id).filter(Boolean));
    const additions = entries
      .map(normalizeEntry)
      .filter((entry) => entry && !existingIds.has(entry.id))
      .sort((a, b) => String(b.completedAtISO).localeCompare(String(a.completedAtISO)));
    if (!additions.length && Array.isArray(state.completions)) return state;
    return { ...state, completions: [...additions, ...completions] };
  }

  function applyOrderJournalToState(sourceState, record = readOrderJournal()) {
    const state = sourceState && typeof sourceState === 'object' && !Array.isArray(sourceState)
      ? sourceState
      : {};
    if (!record?.orderedIds?.length || !Array.isArray(state.flexActions)) return state;

    const byId = new Map(state.flexActions.map((entry) => [String(entry?.id || ''), entry]));
    const orderedKnownIds = record.orderedIds.filter((id) => byId.has(id) && !byId.get(id)?.retired);
    const known = new Set(orderedKnownIds);
    const remainingIds = state.flexActions
      .filter((entry) => entry && !entry.retired && !known.has(String(entry.id || '')))
      .slice()
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
      .map((entry) => String(entry.id || ''))
      .filter(Boolean);
    const finalIds = [...orderedKnownIds, ...remainingIds];
    const orderById = new Map(finalIds.map((id, index) => [id, index + 1]));
    let changed = false;
    const flexActions = state.flexActions.map((entry) => {
      const id = String(entry?.id || '');
      if (!entry || entry.retired || !orderById.has(id)) return entry;
      const nextOrder = orderById.get(id);
      if (Number(entry.order || 0) === nextOrder) return entry;
      changed = true;
      return { ...entry, order: nextOrder };
    });
    return changed ? { ...state, flexActions } : state;
  }

  function storedCompletionIds(storageKey = STORAGE_KEY) {
    const raw = storage.getItem(storageKey);
    if (!raw) return new Set();
    try {
      const saved = typeof core.parseTaskPointsStorageJson === 'function'
        ? core.parseTaskPointsStorageJson(raw, {})
        : JSON.parse(raw);
      return new Set((Array.isArray(saved?.completions) ? saved.completions : []).map((entry) => entry?.id).filter(Boolean));
    } catch (_) {
      return new Set();
    }
  }

  function storedFlexOrderMatches(record, storageKey = STORAGE_KEY) {
    if (!record?.orderedIds?.length) return true;
    const raw = storage.getItem(storageKey);
    if (!raw) return false;
    try {
      const saved = typeof core.parseTaskPointsStorageJson === 'function'
        ? core.parseTaskPointsStorageJson(raw, {})
        : JSON.parse(raw);
      const activeIds = (Array.isArray(saved?.flexActions) ? saved.flexActions : [])
        .filter((entry) => entry && !entry.retired)
        .slice()
        .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
        .map((entry) => String(entry.id || ''))
        .filter(Boolean);
      if (activeIds.length < record.orderedIds.length) return false;
      return record.orderedIds.every((id, index) => activeIds[index] === id);
    } catch (_) {
      return false;
    }
  }

  function clearVerifiedJournal(storageKey = STORAGE_KEY) {
    const record = readJournalRecord();
    if (record.malformed || !record.entries.length) return 0;
    const savedIds = storedCompletionIds(storageKey);
    const remaining = record.entries.filter((entry) => !savedIds.has(entry.id));
    if (remaining.length === record.entries.length) return 0;
    try {
      writeJournal(remaining);
      return record.entries.length - remaining.length;
    } catch (error) {
      console.warn('TaskPoints saved the Flex Action completion but retained its journal for a later verification retry.', error);
      return 0;
    }
  }

  function clearVerifiedOrderJournal(storageKey = STORAGE_KEY) {
    const current = readOrderJournalRecord();
    if (current.malformed || !current.record || !storedFlexOrderMatches(current.record, storageKey)) return false;
    try {
      storage.removeItem(ORDER_JOURNAL_KEY);
      return true;
    } catch (error) {
      console.warn('TaskPoints saved the Flex Action order but retained its order journal for a later verification retry.', error);
      return false;
    }
  }

  function readAuthoritativeState(storageKey = STORAGE_KEY, fallbackState = null) {
    if (typeof originalLoadAppState !== 'function') return fallbackState;
    try {
      const loaded = originalLoadAppState({ storageKey });
      return loaded?.state || fallbackState;
    } catch (_) {
      return fallbackState;
    }
  }

  if (originalLoadAppState) {
    core.loadAppState = function loadAppStateWithPendingFlex(...args) {
      const result = originalLoadAppState(...args);
      if (!result?.state) return result;
      const completionRecord = readJournalRecord();
      const orderRecord = readOrderJournalRecord();
      let state = result.state;
      let changed = false;
      if (!completionRecord.malformed && completionRecord.entries.length) {
        state = applyJournalToState(state, completionRecord.entries);
        changed = true;
      }
      if (!orderRecord.malformed && orderRecord.record) {
        state = applyOrderJournalToState(state, orderRecord.record);
        changed = true;
      }
      if (!changed) return result;
      return {
        ...result,
        state,
        pendingFlexCompletions: completionRecord.entries.length,
        pendingFlexOrder: Boolean(orderRecord.record)
      };
    };
  }

  if (originalSaveStateSnapshot) {
    core.saveStateSnapshot = function saveStateSnapshotWithPendingFlex(state, options = {}) {
      const storageKey = options.storageKey || STORAGE_KEY;
      const completionRecord = readJournalRecord();
      const orderRecord = readOrderJournalRecord();
      const completionPending = !completionRecord.malformed && completionRecord.entries.length > 0;
      const orderPending = !orderRecord.malformed && Boolean(orderRecord.record);

      // A different Home tab may already have saved every shared journal entry
      // while this tab's delayed fast save was waiting to run. Never let that
      // drained request write its stale in-memory full snapshot back over the
      // newer authoritative copy. Returning the authoritative state also lets
      // the normal Home save assignment refresh this tab without another write.
      if (options.savePath === SAVE_PATH
        && !completionRecord.malformed
        && !orderRecord.malformed
        && !completionPending
        && !orderPending) {
        return {
          state: readAuthoritativeState(storageKey, state),
          skipped: true,
          skipReason: 'pending_flex_journal_already_drained',
          flexFastPathDrained: true
        };
      }

      let candidate = state;
      if (completionPending) candidate = applyJournalToState(candidate, completionRecord.entries);
      if (orderPending) candidate = applyOrderJournalToState(candidate, orderRecord.record);
      const result = originalSaveStateSnapshot(candidate, options);
      if (!result?.skipped && !result?.blockedByQuotaCircuit && result?.state) {
        if (completionPending) clearVerifiedJournal(storageKey);
        if (orderPending) clearVerifiedOrderJournal(storageKey);
      }
      return result;
    };
  }

  function cancelScheduledSave() {
    if (saveRaf && typeof global.cancelAnimationFrame === 'function') global.cancelAnimationFrame(saveRaf);
    if (saveTimer) global.clearTimeout?.(saveTimer);
    saveRaf = 0;
    saveTimer = 0;
  }

  function cancelRetryTimer() {
    if (retryTimer) global.clearTimeout?.(retryTimer);
    retryTimer = 0;
  }

  function resetRetryBackoff() {
    cancelRetryTimer();
    retryAttempt = 0;
    retryPaused = false;
  }

  function scheduleRetry() {
    const completionRecord = readJournalRecord();
    const orderRecord = readOrderJournalRecord();
    const orderPending = !orderRecord.malformed && Boolean(orderRecord.record);
    if (retryTimer || retryPaused || completionRecord.malformed
      || (!completionRecord.entries.length && !orderPending)) return;
    if (retryAttempt >= MAX_AUTOMATIC_RETRIES) {
      retryPaused = true;
      console.warn('TaskPoints paused automatic Flex Action save retries after repeated failures. The pending journal remains protected and will retry after the next Flex tap, storage update, or app resume.');
      return;
    }
    const delay = Math.min(RETRY_BASE_DELAY_MS * (2 ** retryAttempt), RETRY_MAX_DELAY_MS);
    retryAttempt += 1;
    retryTimer = global.setTimeout?.(() => {
      retryTimer = 0;
      savePending = true;
      persistNow('retry');
    }, delay) || 0;
  }

  function requestFullRender() {
    if (typeof originalRenderAll !== 'function') return;
    if (typeof global.scheduleRender === 'function') global.scheduleRender(originalRenderAll);
    else if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(() => originalRenderAll());
    else global.setTimeout?.(() => originalRenderAll(), 0);
  }

  function storageQuietStatus() {
    try {
      const status = core.getStorageMaintenanceIdleStatus?.();
      return status && typeof status === 'object' ? status : null;
    } catch (_) {
      return null;
    }
  }

  function flexCompactionReady(status = storageQuietStatus()) {
    // Older test/standalone environments do not install the global maintenance
    // tracker. Preserve the legacy after-paint behavior there rather than
    // risking a journal that can never compact.
    if (!status) return true;
    if (status.pageLeaving === true || global.document?.visibilityState === 'hidden') return true;
    if (status.activeEditor === true) return false;
    if (Number(status.navigationQuietForMs || 0) > 0) return false;
    return Number(status.lastInteractionAgoMs || 0) >= REQUIRED_QUIET_MS;
  }

  function markQuietDeferred(status) {
    if (quietDeferred) return;
    quietDeferred = true;
    try {
      global.TaskPointsPerf?.mark?.('flex.compactionDeferred', {
        requiredQuietMs: REQUIRED_QUIET_MS,
        lastInteractionAgoMs: Number(status?.lastInteractionAgoMs || 0),
        navigationQuietForMs: Number(status?.navigationQuietForMs || 0),
        activeEditor: status?.activeEditor === true
      });
    } catch (_) {}
  }

  function markQuietReleased(status) {
    if (!quietDeferred) return;
    quietDeferred = false;
    try {
      global.TaskPointsPerf?.mark?.('flex.compactionReleased', {
        requiredQuietMs: REQUIRED_QUIET_MS,
        lastInteractionAgoMs: Number(status?.lastInteractionAgoMs || 0)
      });
    } catch (_) {}
  }

  function persistNow(reason = 'background') {
    if (saveRunning) {
      savePending = true;
      return false;
    }
    cancelScheduledSave();
    const completionRecord = readJournalRecord();
    const orderRecord = readOrderJournalRecord();
    const orderPending = !orderRecord.malformed && Boolean(orderRecord.record);
    if (completionRecord.malformed) return false;
    if (!savePending && !completionRecord.entries.length && !orderPending) return false;
    if (typeof originalHomeSave !== 'function') return false;

    savePending = false;
    saveRunning = true;
    try {
      originalHomeSave(SAVE_PATH, {
        userInitiated: true,
        interactive: true,
        deferCompression: true,
        flexFastPathReason: reason
      });
    } catch (error) {
      console.warn('TaskPoints Flex Action background save failed; the pending Flex journal was retained.', error);
    } finally {
      saveRunning = false;
    }

    const remainingCompletionRecord = readJournalRecord();
    const remainingOrderRecord = readOrderJournalRecord();
    const remainingOrder = !remainingOrderRecord.malformed && Boolean(remainingOrderRecord.record);
    const remaining = remainingCompletionRecord.malformed
      ? 1
      : remainingCompletionRecord.entries.length + (remainingOrder ? 1 : 0);
    if (!remaining) {
      resetRetryBackoff();
      if (!pendingRenderSatisfied) requestFullRender();
      pendingRenderSatisfied = false;
      renderPending = false;
      quietDeferred = false;
      return true;
    }

    // Do not perform a heavy Home rerender on every failed retry. The visible
    // Flex state is already painted, and the protected journals remain the
    // source of truth until a later retry succeeds.
    scheduleRetry();
    return false;
  }

  function attemptQuietSave(reason = 'quiet-after-paint') {
    saveTimer = 0;
    const completionRecord = readJournalRecord();
    const orderRecord = readOrderJournalRecord();
    const orderPending = !orderRecord.malformed && Boolean(orderRecord.record);
    if (completionRecord.malformed
      || (!savePending && !completionRecord.entries.length && !orderPending)) return false;

    // Preserve the visible behavior of a Flex tap without coupling that UI
    // refresh to the multi-megabyte persistence snapshot. The visible change
    // gets the first paint; the normal Home render can follow later.
    if (renderPending) {
      renderPending = false;
      pendingRenderSatisfied = true;
      requestFullRender();
    }

    const status = storageQuietStatus();
    if (!flexCompactionReady(status)) {
      quietDeferrals += 1;
      markQuietDeferred(status);
      saveTimer = global.setTimeout?.(() => attemptQuietSave(reason), QUIET_POLL_MS) || 0;
      return false;
    }

    markQuietReleased(status);
    quietRuns += 1;
    return persistNow(reason);
  }

  function scheduleSaveAfterPaint(options = {}) {
    if (options.resetRetry === true) resetRetryBackoff();
    savePending = true;
    if (saveRaf || saveTimer || saveRunning) return;
    const queueTimer = () => {
      saveRaf = 0;
      saveTimer = global.setTimeout?.(() => attemptQuietSave('quiet-after-paint'), 0) || 0;
    };
    if (typeof global.requestAnimationFrame === 'function') saveRaf = global.requestAnimationFrame(queueTimer);
    else queueTimer();
  }

  function resumePendingSave(reason = 'resume') {
    const completionRecord = readJournalRecord();
    const orderRecord = readOrderJournalRecord();
    const orderPending = !orderRecord.malformed && Boolean(orderRecord.record);
    resetRetryBackoff();
    if (completionRecord.malformed) return false;
    if (completionRecord.entries.length || orderPending) {
      scheduleSaveAfterPaint();
      return true;
    }
    if (savePending && !saveRunning) return persistNow(reason);
    return false;
  }

  function findFlexRow(id) {
    const buttons = global.document?.querySelectorAll?.('[data-act="flex-do"][data-id]') || [];
    for (const button of buttons) {
      if (button.getAttribute?.('data-id') === id) return button.closest?.('.flex-action-row') || null;
    }
    return null;
  }

  function showInstantDot(id) {
    const row = findFlexRow(id);
    const usage = row?.querySelector?.('.flex-action-usage');
    if (!usage || typeof global.document?.createElement !== 'function') return false;
    let dots = usage.querySelector?.('.flex-action-dots');
    if (!dots) {
      dots = global.document.createElement('span');
      dots.className = 'flex-action-dots';
      usage.appendChild(dots);
    }
    const dot = global.document.createElement('span');
    dot.className = 'flex-action-dot flex-action-dot--pop';
    dots.appendChild(dot);
    const count = dots.querySelectorAll?.('.flex-action-dot')?.length || 1;
    const flexDayLabel = typeof global.isViewingFlexYesterday === 'function' && global.isViewingFlexYesterday()
      ? 'yesterday'
      : 'today';
    dots.setAttribute?.('aria-label', `${count} time${count === 1 ? '' : 's'} used ${flexDayLabel}`);
    return true;
  }

  function applyFlexHeaderPresentation() {
    const doc = global.document;
    const dayButton = doc?.getElementById?.('flexDayToggleBtn');
    if (!dayButton) return false;

    const controls = dayButton.closest?.('.flexControlsRow') || null;
    const hideButton = controls?.querySelector?.('.recent-toggle[data-target="flexWrap"]') || null;
    hideButton?.remove?.();

    if (dayButton.style) dayButton.style.marginLeft = 'auto';

    const referenceButton = doc?.getElementById?.('weekBackBtnHabits') || doc?.getElementById?.('weekBackBtnVices');
    if (referenceButton && dayButton.style && typeof global.getComputedStyle === 'function') {
      const referenceFont = global.getComputedStyle(referenceButton);
      dayButton.style.fontFamily = referenceFont.fontFamily;
      dayButton.style.fontSize = referenceFont.fontSize;
      dayButton.style.fontWeight = referenceFont.fontWeight;
      dayButton.style.fontStyle = referenceFont.fontStyle;
      dayButton.style.lineHeight = referenceFont.lineHeight;
      dayButton.style.letterSpacing = referenceFont.letterSpacing;
      dayButton.style.textTransform = referenceFont.textTransform;
    }

    const applyLabel = () => {
      const viewingYesterday = typeof global.isViewingFlexYesterday === 'function' && global.isViewingFlexYesterday();
      const desiredLabel = viewingYesterday ? 'Today ▶︎' : '◀︎ Week';
      if (dayButton.textContent !== desiredLabel) dayButton.textContent = desiredLabel;
    };
    applyLabel();

    // The legacy Home updater can still write "Yesterday" after this module
    // installs. Keep presentation aligned with Habits/Vices without changing
    // the underlying today/yesterday Flex view behavior.
    if (!dayButton.__taskPointsFlexHeaderLabelObserver && typeof global.MutationObserver === 'function') {
      const observer = new global.MutationObserver(applyLabel);
      observer.observe(dayButton, { childList: true, characterData: true, subtree: true });
      dayButton.__taskPointsFlexHeaderLabelObserver = observer;
    }

    if (!dayButton.__taskPointsFlexHeaderPresentationBound && typeof dayButton.addEventListener === 'function') {
      dayButton.__taskPointsFlexHeaderPresentationBound = true;
      dayButton.addEventListener('click', () => {
        const refresh = () => applyFlexHeaderPresentation();
        if (typeof global.queueMicrotask === 'function') global.queueMicrotask(refresh);
        else global.setTimeout?.(refresh, 0);
      });
    }

    return true;
  }

  function installFlushBridge() {
    const current = core.flushPendingSaves;
    if (typeof current !== 'function') return false;
    if (current.__taskPointsFlexActionFastPath) return true;
    const wrapped = function flushPendingSavesWithFlex(...args) {
      const result = current.apply(this, args);
      resetRetryBackoff();
      persistNow('core-flush');
      return result;
    };
    wrapped.__taskPointsFlexActionFastPath = true;
    wrapped.__taskPointsOriginal = current;
    core.flushPendingSaves = wrapped;
    return true;
  }

  function installUiPatch() {
    if (uiInstalled) {
      installFlushBridge();
      applyFlexHeaderPresentation();
      return true;
    }
    if (typeof global.logFlexCompletion !== 'function'
      || typeof global.save !== 'function'
      || typeof global.addCompletion !== 'function'
      || typeof global.renderFlexActions !== 'function'
      || typeof global.moveFlexAction !== 'function') return false;

    originalLogFlexCompletion = global.logFlexCompletion;
    originalHomeSave = global.save;
    originalAddCompletion = global.addCompletion;
    originalRenderAll = typeof global.renderAll === 'function' ? global.renderAll : null;
    originalRenderFlexActions = global.renderFlexActions;
    originalMoveFlexAction = global.moveFlexAction;
    originalResetAll = typeof global.resetAll === 'function' ? global.resetAll : null;
    applyFlexHeaderPresentation();

    const fastLogFlexCompletion = function taskPointsFastLogFlexCompletion(...args) {
      const id = String(args[0] || '');
      let saveRequested = false;
      let fullRenderRequested = false;
      const priorSave = global.save;
      const priorAddCompletion = global.addCompletion;
      const priorRenderAll = global.renderAll;
      const priorRenderFlexActions = global.renderFlexActions;

      const suppressedSave = function suppressedFlexSave() {
        saveRequested = true;
      };
      const journaledAddCompletion = function journaledFlexAddCompletion(entry) {
        if (entry?.source === 'flex' && entry?.flexId) appendJournal(entry);
        return originalAddCompletion.call(this, entry);
      };
      const deferredRenderAll = function deferredFlexRenderAll() {
        fullRenderRequested = true;
      };
      const instantFlexRender = function instantFlexRender() {
        fullRenderRequested = true;
        if (!showInstantDot(id)) return originalRenderFlexActions.call(this);
        return undefined;
      };

      global.save = suppressedSave;
      global.addCompletion = journaledAddCompletion;
      if (typeof priorRenderAll === 'function') global.renderAll = deferredRenderAll;
      global.renderFlexActions = instantFlexRender;

      let result;
      try {
        result = originalLogFlexCompletion.apply(this, args);
      } finally {
        if (global.save === suppressedSave) global.save = priorSave;
        if (global.addCompletion === journaledAddCompletion) global.addCompletion = priorAddCompletion;
        if (global.renderAll === deferredRenderAll) global.renderAll = priorRenderAll;
        if (global.renderFlexActions === instantFlexRender) global.renderFlexActions = priorRenderFlexActions;
      }

      if (fullRenderRequested) renderPending = true;
      if (saveRequested || readJournal().length) scheduleSaveAfterPaint({ resetRetry: true });
      return result;
    };

    fastLogFlexCompletion.__taskPointsFlexActionFastPath = true;
    fastLogFlexCompletion.__taskPointsOriginal = originalLogFlexCompletion;
    global.logFlexCompletion = fastLogFlexCompletion;

    const fastMoveFlexAction = function taskPointsFastMoveFlexAction(...args) {
      let saveRequested = false;
      const priorSave = global.save;
      const suppressedSave = function suppressedFlexReorderSave() {
        saveRequested = true;
      };
      global.save = suppressedSave;

      let result;
      try {
        result = originalMoveFlexAction.apply(this, args);
      } finally {
        if (global.save === suppressedSave) global.save = priorSave;
      }

      if (!saveRequested) return result;

      const orderedIds = captureRenderedFlexOrder();
      if (!orderedIds.length) {
        // If the rendered order cannot be captured, preserve the legacy durable
        // behavior rather than deferring an unjournaled reorder.
        priorSave();
        return result;
      }

      try {
        writeOrderJournal(orderedIds);
        global.TaskPointsPerf?.mark?.('flex.reorderDeferred', {
          id: String(args[0] || ''),
          delta: Number(args[1] || 0),
          itemCount: orderedIds.length
        });
        scheduleSaveAfterPaint({ resetRetry: true });
      } catch (error) {
        console.warn('TaskPoints could not journal the Flex Action reorder; using the normal durable save path.', error);
        priorSave();
      }
      return result;
    };

    fastMoveFlexAction.__taskPointsFlexActionFastPath = true;
    fastMoveFlexAction.__taskPointsOriginal = originalMoveFlexAction;
    global.moveFlexAction = fastMoveFlexAction;

    if (originalResetAll && !originalResetAll.__taskPointsFlexActionFastPath) {
      const resetWithFlexFlush = function resetAllWithPendingFlex(...args) {
        resetRetryBackoff();
        persistNow('before-reset');
        const priorConfirm = global.confirm;
        let resetConfirmed = false;
        if (typeof priorConfirm === 'function') {
          global.confirm = function flexAwareResetConfirm(...confirmArgs) {
            const accepted = priorConfirm.apply(this, confirmArgs);
            if (accepted) resetConfirmed = true;
            return accepted;
          };
        }
        try {
          return originalResetAll.apply(this, args);
        } finally {
          if (global.confirm !== priorConfirm) global.confirm = priorConfirm;
          if (resetConfirmed) {
            cancelRetryTimer();
            try { storage.removeItem(JOURNAL_KEY); } catch (_) {}
            try { storage.removeItem(ORDER_JOURNAL_KEY); } catch (_) {}
          }
        }
      };
      resetWithFlexFlush.__taskPointsFlexActionFastPath = true;
      resetWithFlexFlush.__taskPointsOriginal = originalResetAll;
      global.resetAll = resetWithFlexFlush;
    }

    installFlushBridge();
    uiInstalled = true;

    const orderRecord = readOrderJournalRecord();
    if (readJournal().length || (!orderRecord.malformed && orderRecord.record)) {
      scheduleSaveAfterPaint({ resetRetry: true });
    }
    return true;
  }

  function installWhenReady() {
    const installed = installUiPatch();
    installAttempts += 1;
    if ((!installed || !installFlushBridge()) && installAttempts < MAX_INSTALL_ATTEMPTS) {
      global.setTimeout?.(installWhenReady, 50);
    }
  }

  global.addEventListener?.('pagehide', () => persistNow('pagehide'));
  global.addEventListener?.('pageshow', () => resumePendingSave('pageshow'));
  global.addEventListener?.('storage', (event) => {
    if (!event || (event.key !== JOURNAL_KEY && event.key !== ORDER_JOURNAL_KEY && event.key !== STORAGE_KEY)) return;
    resumePendingSave('storage-event');
  });
  global.document?.addEventListener?.('visibilitychange', () => {
    if (global.document.visibilityState === 'hidden') persistNow('visibility-hidden');
    else if (global.document.visibilityState === 'visible') resumePendingSave('visibility-visible');
  });

  core.PENDING_FLEX_COMPLETIONS_KEY = JOURNAL_KEY;
  core.PENDING_FLEX_ORDER_KEY = ORDER_JOURNAL_KEY;
  core.readPendingFlexCompletions = readJournal;
  core.applyPendingFlexCompletions = applyJournalToState;
  core.getPendingFlexCompletionCount = () => readJournal().length;
  core.readPendingFlexOrder = readOrderJournal;
  core.applyPendingFlexOrder = applyOrderJournalToState;
  core.flushPendingFlexCompletions = () => {
    resetRetryBackoff();
    return persistNow('explicit-flush');
  };
  global.TaskPointsFlexActionFastPath = {
    journalKey: JOURNAL_KEY,
    orderJournalKey: ORDER_JOURNAL_KEY,
    installUiPatch,
    persistNow,
    scheduleSaveAfterPaint,
    resumePendingSave,
    readJournal,
    readJournalRecord,
    readOrderJournal,
    readOrderJournalRecord,
    writeOrderJournal,
    captureRenderedFlexOrder,
    showInstantDot,
    applyFlexHeaderPresentation,
    getRetryStatus: () => ({ retryAttempt, retryPaused, retryScheduled: Boolean(retryTimer) }),
    getQuietCompactionStatus: () => ({
      requiredQuietMs: REQUIRED_QUIET_MS,
      quietPollMs: QUIET_POLL_MS,
      deferred: quietDeferred,
      deferrals: quietDeferrals,
      runs: quietRuns,
      renderPending,
      pendingRenderSatisfied
    })
  };

  if (global.document?.readyState === 'loading') global.document.addEventListener?.('DOMContentLoaded', installWhenReady, { once: true });
  else installWhenReady();
})(typeof window !== 'undefined' ? window : globalThis);