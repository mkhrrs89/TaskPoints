(function installVerifiedSecondaryRecoveryLockSplit(global) {
  'use strict';

  const storage = global.localStorage;
  if (!storage || global.__taskPointsVerifiedSecondaryRecoveryLockSplitInstalled) return;
  global.__taskPointsVerifiedSecondaryRecoveryLockSplitInstalled = true;

  const COMMITTED_LOCK_KEY = 'taskpoints_recovery_write_lock_v1';
  const ATTEMPT_LOCK_KEY = 'taskpoints_recovery_attempt_lock_v1';

  function parseLock(value) {
    try {
      const lock = JSON.parse(String(value || 'null'));
      return lock && lock.active === true && lock.token ? lock : null;
    } catch (_) { return null; }
  }

  function assertAttemptMayBeWritten(existing, next) {
    if (!existing || String(existing.token) === String(next?.token || '')) return;
    const retained = existing.retainUntilManualRecovery === true;
    const error = new Error(retained
      ? 'A prior recovery attempt entered the authoritative write boundary and remains quarantined. Use full Emergency Data Recovery; do not start another manual restore.'
      : 'Another manual recovery attempt is already active. Close or finish that recovery page before trying again.');
    error.code = retained
      ? 'TASKPOINTS_RETAINED_RECOVERY_ATTEMPT_EXISTS'
      : 'TASKPOINTS_RECOVERY_ATTEMPT_ALREADY_ACTIVE';
    error.existingAttempt = existing;
    throw error;
  }

  function installInstanceHooks() {
    try {
      const priorGet = storage.getItem.bind(storage);
      const priorSet = storage.setItem.bind(storage);
      const priorRemove = storage.removeItem.bind(storage);

      const wrappedGet = function splitRecoveryLockGetItem(key) {
        if (String(key) !== COMMITTED_LOCK_KEY) return priorGet(key);
        const attemptRaw = priorGet(ATTEMPT_LOCK_KEY);
        return parseLock(attemptRaw) ? attemptRaw : priorGet(COMMITTED_LOCK_KEY);
      };
      const wrappedSet = function splitRecoveryLockSetItem(key, value) {
        if (String(key) !== COMMITTED_LOCK_KEY) return priorSet(key, value);
        const lock = parseLock(value);
        if (lock && Number(lock.committedAtMs || 0) === 0) {
          assertAttemptMayBeWritten(parseLock(priorGet(ATTEMPT_LOCK_KEY)), lock);
          return priorSet(ATTEMPT_LOCK_KEY, value);
        }
        const result = priorSet(COMMITTED_LOCK_KEY, value);
        if (lock && Number(lock.committedAtMs || 0) > 0) priorRemove(ATTEMPT_LOCK_KEY);
        return result;
      };
      const wrappedRemove = function splitRecoveryLockRemoveItem(key) {
        if (String(key) === COMMITTED_LOCK_KEY) return priorRemove(ATTEMPT_LOCK_KEY);
        return priorRemove(key);
      };

      storage.getItem = wrappedGet;
      storage.setItem = wrappedSet;
      storage.removeItem = wrappedRemove;
      return storage.getItem === wrappedGet && storage.setItem === wrappedSet && storage.removeItem === wrappedRemove;
    } catch (_) { return false; }
  }

  function installPrototypeHooks() {
    const prototype = global.Storage?.prototype;
    if (!prototype) return false;
    if (prototype.getItem && !prototype.__taskPointsRecoveryLockSplitOriginalGetItem) {
      const priorGet = prototype.getItem;
      Object.defineProperty(prototype, '__taskPointsRecoveryLockSplitOriginalGetItem', { value: priorGet, configurable: true });
      prototype.getItem = function splitRecoveryLockGetItem(key) {
        if (this !== storage || String(key) !== COMMITTED_LOCK_KEY) return priorGet.call(this, key);
        const attemptRaw = priorGet.call(this, ATTEMPT_LOCK_KEY);
        return parseLock(attemptRaw) ? attemptRaw : priorGet.call(this, COMMITTED_LOCK_KEY);
      };
    }
    if (prototype.setItem && !prototype.__taskPointsRecoveryLockSplitOriginalSetItem) {
      const priorSet = prototype.setItem;
      const priorGet = prototype.getItem;
      const priorRemove = prototype.removeItem;
      Object.defineProperty(prototype, '__taskPointsRecoveryLockSplitOriginalSetItem', { value: priorSet, configurable: true });
      prototype.setItem = function splitRecoveryLockSetItem(key, value) {
        if (this !== storage || String(key) !== COMMITTED_LOCK_KEY) return priorSet.call(this, key, value);
        const lock = parseLock(value);
        if (lock && Number(lock.committedAtMs || 0) === 0) {
          assertAttemptMayBeWritten(parseLock(priorGet.call(this, ATTEMPT_LOCK_KEY)), lock);
          return priorSet.call(this, ATTEMPT_LOCK_KEY, value);
        }
        const result = priorSet.call(this, COMMITTED_LOCK_KEY, value);
        if (lock && Number(lock.committedAtMs || 0) > 0) priorRemove?.call(this, ATTEMPT_LOCK_KEY);
        return result;
      };
    }
    if (prototype.removeItem && !prototype.__taskPointsRecoveryLockSplitOriginalRemoveItem) {
      const priorRemove = prototype.removeItem;
      Object.defineProperty(prototype, '__taskPointsRecoveryLockSplitOriginalRemoveItem', { value: priorRemove, configurable: true });
      prototype.removeItem = function splitRecoveryLockRemoveItem(key) {
        if (this === storage && String(key) === COMMITTED_LOCK_KEY) return priorRemove.call(this, ATTEMPT_LOCK_KEY);
        return priorRemove.call(this, key);
      };
    }
    return true;
  }

  const installed = installInstanceHooks() || installPrototypeHooks();
  global.TaskPointsVerifiedSecondaryRecoveryLockSplit = {
    installed,
    committedLockKey: COMMITTED_LOCK_KEY,
    attemptLockKey: ATTEMPT_LOCK_KEY
  };
})(typeof window !== 'undefined' ? window : globalThis);
