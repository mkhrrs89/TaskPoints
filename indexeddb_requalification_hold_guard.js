(function installTaskPointsRequalificationHoldGuard(global) {
  'use strict';

  const storage = global.localStorage;
  const core = global.TaskPointsCore;
  if (!storage || !core || core.__indexedDbRecoveryHoldGuardInstalled) return;

  const HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
  const MODE_KEY = core.PHASE4_STORAGE_MODE_KEY || 'taskpoints_phase4_storage_mode_v1';
  let initialHoldRaw = null;
  try { initialHoldRaw = storage.getItem(HOLD_KEY); } catch (_) { initialHoldRaw = null; }

  function currentHold() {
    try { return storage.getItem(HOLD_KEY); } catch (_) { return null; }
  }

  function protectRemoval(key) {
    if (String(key) !== HOLD_KEY) return;
    const current = currentHold();
    if (current != null && current !== initialHoldRaw) {
      const error = new Error('Recovery protection changed while the faster-storage test was starting.');
      error.code = 'TASKPOINTS_RECOVERY_HOLD_CHANGED';
      throw error;
    }
  }

  function protectRestoration(key, value) {
    if (String(key) !== HOLD_KEY || initialHoldRaw == null || String(value) !== initialHoldRaw) return;
    const current = currentHold();
    if (current != null && current !== initialHoldRaw) {
      const error = new Error('A newer recovery warning is active and cannot be replaced.');
      error.code = 'TASKPOINTS_NEWER_RECOVERY_HOLD_ACTIVE';
      throw error;
    }
  }

  function installOn(target) {
    if (!target?.setItem || !target?.removeItem || target.__taskPointsRequalificationHoldGuardOriginalSetItem) return false;
    const originalSetItem = target.setItem;
    const originalRemoveItem = target.removeItem;
    try {
      Object.defineProperty(target, '__taskPointsRequalificationHoldGuardOriginalSetItem', { value: originalSetItem, configurable: true });
      Object.defineProperty(target, '__taskPointsRequalificationHoldGuardOriginalRemoveItem', { value: originalRemoveItem, configurable: true });
      target.setItem = function taskPointsProtectedSetItem(key, value) {
        protectRestoration(key, value);
        return originalSetItem.call(this, key, value);
      };
      target.removeItem = function taskPointsProtectedRemoveItem(key) {
        protectRemoval(key);
        return originalRemoveItem.call(this, key);
      };
      return target.setItem !== originalSetItem && target.removeItem !== originalRemoveItem;
    } catch (_) {
      return false;
    }
  }

  let installed = installOn(storage);
  if (!installed) installed = installOn(global.Storage?.prototype);
  if (!installed) {
    try { storage.setItem(MODE_KEY, 'off'); } catch (_) {}
    return;
  }

  core.__indexedDbRecoveryHoldGuardInstalled = true;
  core.getIndexedDbRecoveryHoldGuardStatus = () => ({
    installed: true,
    initialHoldPresent: initialHoldRaw != null,
    currentHoldChanged: currentHold() !== initialHoldRaw
  });

  global.addEventListener?.('storage', (event) => {
    if (event?.storageArea && event.storageArea !== storage) return;
    if (event?.key !== HOLD_KEY || event.newValue == null) return;
    try { core.setPhase4StorageMode?.('off'); } catch (_) {
      try { storage.setItem(MODE_KEY, 'off'); } catch (_) {}
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
