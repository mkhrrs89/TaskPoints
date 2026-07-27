(function installVerifiedSecondaryRestoreLockGuard(global) {
  'use strict';

  const storage = global.localStorage;
  if (!storage || global.__taskPointsVerifiedSecondaryRestoreLockGuardInstalled) return;
  global.__taskPointsVerifiedSecondaryRestoreLockGuardInstalled = true;

  const STORAGE_KEY = 'taskpoints_v1';
  const LOCK_KEY = 'taskpoints_recovery_write_lock_v1';
  let ownedToken = '';

  function readLock() {
    try {
      const lock = JSON.parse(storage.getItem(LOCK_KEY) || 'null');
      return lock && lock.active === true ? lock : null;
    } catch (_) { return null; }
  }

  function rememberLockValue(key, value) {
    if (String(key) !== LOCK_KEY) return;
    try {
      const lock = JSON.parse(String(value));
      if (lock?.active === true && lock.token && Number(lock.committedAtMs || 0) === 0) {
        ownedToken = String(lock.token);
      }
    } catch (_) {}
  }

  function assertLockOwnership() {
    const lock = readLock();
    if (!ownedToken || !lock || String(lock.token) !== ownedToken || Number(lock.committedAtMs || 0) !== 0) {
      const error = new Error('This recovery page no longer owns the cross-tab recovery lock. Refresh and review the recovery copies again.');
      error.code = 'TASKPOINTS_RECOVERY_LOCK_OWNERSHIP_LOST';
      throw error;
    }
  }

  function installInstanceHook() {
    try {
      const priorSet = storage.setItem.bind(storage);
      const wrapped = function verifiedSecondaryRestoreSetItem(key, value) {
        const normalizedKey = String(key);
        if (normalizedKey === STORAGE_KEY) assertLockOwnership();
        const result = priorSet(key, value);
        rememberLockValue(normalizedKey, value);
        return result;
      };
      storage.setItem = wrapped;
      return storage.setItem === wrapped;
    } catch (_) { return false; }
  }

  function installPrototypeHook() {
    const prototype = global.Storage?.prototype;
    if (!prototype?.setItem || prototype.__taskPointsVerifiedSecondaryRestoreOriginalSetItem) return false;
    const priorSet = prototype.setItem;
    Object.defineProperty(prototype, '__taskPointsVerifiedSecondaryRestoreOriginalSetItem', {
      value: priorSet,
      configurable: true
    });
    prototype.setItem = function verifiedSecondaryRestoreSetItem(key, value) {
      const normalizedKey = String(key);
      if (this === storage && normalizedKey === STORAGE_KEY) assertLockOwnership();
      const result = priorSet.call(this, key, value);
      if (this === storage) rememberLockValue(normalizedKey, value);
      return result;
    };
    return true;
  }

  const installed = installInstanceHook() || installPrototypeHook();
  global.TaskPointsVerifiedSecondaryRestoreLockGuard = {
    installed,
    readLock,
    assertLockOwnership,
    getOwnedToken: () => ownedToken
  };
})(typeof window !== 'undefined' ? window : globalThis);
