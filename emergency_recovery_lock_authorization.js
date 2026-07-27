(function installTaskPointsEmergencyRecoveryAuthorization(global) {
  'use strict';

  const storage = global.localStorage;
  if (!storage || global.__taskPointsEmergencyRecoveryAuthorizationInstalled) return;
  global.__taskPointsEmergencyRecoveryAuthorizationInstalled = true;
  global.__taskPointsEmergencyRecoveryAuthorized = true;

  const COMMITTED_LOCK_KEY = 'taskpoints_recovery_write_lock_v1';
  const ATTEMPT_LOCK_KEY = 'taskpoints_recovery_attempt_lock_v1';
  const HIDDEN_KEYS = new Set([COMMITTED_LOCK_KEY, ATTEMPT_LOCK_KEY]);

  function installInstanceGetHook() {
    try {
      const priorGet = storage.getItem.bind(storage);
      const wrapped = function emergencyRecoveryAuthorizedGetItem(key) {
        if (HIDDEN_KEYS.has(String(key))) return null;
        return priorGet(key);
      };
      storage.getItem = wrapped;
      return storage.getItem === wrapped;
    } catch (_) { return false; }
  }

  function installPrototypeGetHook() {
    const prototype = global.Storage?.prototype;
    if (!prototype?.getItem || prototype.__taskPointsEmergencyRecoveryOriginalGetItem) return false;
    const priorGet = prototype.getItem;
    Object.defineProperty(prototype, '__taskPointsEmergencyRecoveryOriginalGetItem', {
      value: priorGet,
      configurable: true
    });
    prototype.getItem = function emergencyRecoveryAuthorizedGetItem(key) {
      if (this === storage && HIDDEN_KEYS.has(String(key))) return null;
      return priorGet.call(this, key);
    };
    return true;
  }

  function createToken() {
    if (global.crypto?.randomUUID) return global.crypto.randomUUID();
    return `emergency-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function finalizeEmergencyRecoveryLock() {
    const nowMs = String(Date.now()).padStart(13, '0');
    const token = createToken();
    const committed = {
      schemaVersion: 1,
      active: true,
      token,
      reason: 'full_emergency_recovery_verified',
      createdAtMs: nowMs,
      createdAtISO: new Date(Number(nowMs)).toISOString(),
      committedAtMs: nowMs,
      committedAtISO: new Date(Number(nowMs)).toISOString()
    };
    storage.setItem(COMMITTED_LOCK_KEY, JSON.stringify(committed));
    storage.removeItem(ATTEMPT_LOCK_KEY);
    return true;
  }

  function wrapRestoreCandidateWhenReady() {
    const original = global.restoreCandidate;
    if (typeof original !== 'function' || original.__taskPointsEmergencyRecoveryLockAuthorized) return false;
    const wrapped = async function emergencyRecoveryAuthorizedRestoreCandidate(...args) {
      const result = await original.apply(this, args);
      let restored = false;
      try {
        const hold = JSON.parse(storage.getItem('taskpoints_emergency_recovery_hold_v1') || 'null');
        restored = hold?.active === true && hold?.restored === true;
      } catch (_) {}
      if (restored) {
        try { finalizeEmergencyRecoveryLock(); }
        catch (error) {
          console.error('Emergency recovery succeeded, but its cross-tab recovery lock could not be finalized.', error);
          const message = global.document?.getElementById?.('message');
          if (message) {
            message.className = 'warning mb-4';
            message.textContent = 'The recovery data was restored, but cross-tab protection could not be finalized. Keep all other TaskPoints tabs closed and reload this page before making changes.';
          }
        }
      }
      return result;
    };
    wrapped.__taskPointsEmergencyRecoveryLockAuthorized = true;
    wrapped.__taskPointsOriginal = original;
    global.restoreCandidate = wrapped;
    return true;
  }

  const installed = installInstanceGetHook() || installPrototypeGetHook();
  const wrap = () => {
    if (wrapRestoreCandidateWhenReady()) return;
    global.setTimeout?.(wrap, 25);
  };
  wrap();

  global.TaskPointsEmergencyRecoveryAuthorization = {
    installed,
    committedLockKey: COMMITTED_LOCK_KEY,
    attemptLockKey: ATTEMPT_LOCK_KEY,
    finalizeEmergencyRecoveryLock
  };
})(typeof window !== 'undefined' ? window : globalThis);
