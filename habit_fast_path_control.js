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
        // Never make habit bubbles inert merely because the emergency fallback
        // is unavailable. The already-reviewed journal-first handler remains the
        // safer choice in that case.
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
