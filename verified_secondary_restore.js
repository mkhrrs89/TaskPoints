(function installVerifiedSecondaryRestore(global) {
  'use strict';

  const STORAGE_KEY = 'taskpoints_v1';
  const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
  const HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
  const LOCK_KEY = 'taskpoints_recovery_write_lock_v1';
  const HABIT_JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
  const LEGACY_JOURNAL_KEY = 'taskpoints_phase5b_pending_changes_v1';
  const DB_NAME = 'taskpoints_verified_secondary_v1';
  const STORE_NAME = 'snapshots';
  const preloadJournals = global.__taskPointsVerifiedSecondaryRestorePreload || {};
  let candidate = null;
  let validation = null;
  let recoveryLockToken = '';
  let authoritativeWriteOccurred = false;
  let restoreVerified = false;

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const formatTime = (value) => {
    if (!value) return 'No verification timestamp recorded';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  };
  const parseJournalCount = (raw) => {
    if (!raw) return 0;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.length;
      if (Array.isArray(parsed?.operations)) return parsed.operations.length;
      return parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 1;
    } catch (_) { return 1; }
  };
  const requestResult = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Verified secondary read failed.'));
  });
  const transactionDone = (transaction) => new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error || new Error('Verified secondary transaction aborted.'));
    transaction.onerror = () => undefined;
  });
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function openExistingDatabase() {
    if (!global.indexedDB) return null;
    if (typeof global.indexedDB.databases === 'function') {
      try {
        const databases = await global.indexedDB.databases();
        if (!databases.some((entry) => entry?.name === DB_NAME)) return null;
      } catch (_) {}
    }
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open(DB_NAME);
      let created = false;
      request.onupgradeneeded = () => {
        created = true;
        try { request.transaction?.abort(); } catch (_) {}
      };
      request.onsuccess = () => {
        if (created) { request.result?.close?.(); resolve(null); }
        else resolve(request.result);
      };
      request.onerror = () => created || request.error?.name === 'AbortError'
        ? resolve(null)
        : reject(request.error || new Error('Verified secondary database could not be opened.'));
      request.onblocked = () => reject(new Error('Verified secondary database is blocked by another TaskPoints page.'));
    });
  }

  async function readLatest() {
    const db = await openExistingDatabase();
    if (!db) return null;
    try {
      if (!db.objectStoreNames.contains(STORE_NAME)) return null;
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const finished = transactionDone(transaction);
      const record = await requestResult(transaction.objectStore(STORE_NAME).get('latest'));
      await finished;
      return record || null;
    } finally { db.close(); }
  }

  const sameCounts = (a, b, api) => [...api.COUNT_KEYS, 'total', 'majorTotal']
    .every((key) => Number(a?.[key] || 0) === Number(b?.[key] || 0));

  function verifyRecord(record, api) {
    if (!record) throw new Error('No verified secondary copy exists on this device.');
    if (record.status !== 'passed_verification') throw new Error(`Secondary status is ${record.status || 'missing'}.`);
    if (typeof record.raw !== 'string' || !record.raw) throw new Error('Secondary raw snapshot is missing.');
    if (record.rawHash !== api.rawHash(record.raw)) throw new Error('Secondary raw hash verification failed.');
    const parsed = api.parseStoredRaw(record.raw);
    const decodedCounts = api.countsFor(parsed.state);
    if (!sameCounts(decodedCounts, record.counts || {}, api)) {
      throw new Error('Secondary decoded counts do not match its verification record.');
    }
    return { ...record, counts: decodedCounts };
  }

  function currentJournalState() {
    const liveHabitCount = parseJournalCount(localStorage.getItem(HABIT_JOURNAL_KEY));
    const capturedHabitCount = parseJournalCount(preloadJournals.habitJournalRaw || '');
    const liveLegacyPresent = Boolean(localStorage.getItem(LEGACY_JOURNAL_KEY));
    const capturedLegacyPresent = Boolean(preloadJournals.legacyJournalRaw);
    return {
      pendingHabitCount: Math.max(liveHabitCount, capturedHabitCount),
      legacyJournalPresent: liveLegacyPresent || capturedLegacyPresent,
      liveHabitCount,
      capturedHabitCount,
      liveLegacyPresent,
      capturedLegacyPresent
    };
  }

  function renderCounts(counts) {
    const keys = ['tasks','completions','habits','players','matchups','gameHistory','seasonHistory','reminders'];
    $('candidateCounts').innerHTML = counts
      ? keys.map((key) => `<div class="count-row"><span class="muted">${escapeHtml(key)}</span><strong>${Number(counts[key] || 0).toLocaleString()}</strong></div>`).join('')
      : '<div class="muted">No readable counts.</div>';
  }

  function readCurrent(api) {
    const raw = localStorage.getItem(STORAGE_KEY) || '';
    let readable = false;
    let counts = null;
    try {
      const parsed = api.parseStoredRaw(raw);
      readable = true;
      counts = api.countsFor(parsed.state);
    } catch (_) {}
    return { raw, readable, counts, rawHash: raw ? api.rawHash(raw) : '' };
  }

  function createLockToken() {
    if (global.crypto?.randomUUID) return global.crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  function readRecoveryLock() {
    try {
      const lock = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null');
      return lock && lock.active === true ? lock : null;
    } catch (_) { return null; }
  }

  function acquireRecoveryLock() {
    recoveryLockToken = createLockToken();
    const createdAtMs = String(Date.now()).padStart(13, '0');
    const lock = {
      schemaVersion: 1,
      active: true,
      token: recoveryLockToken,
      reason: 'verified_secondary_manual_restore',
      createdAtMs,
      createdAtISO: new Date(Number(createdAtMs)).toISOString(),
      committedAtMs: '0000000000000',
      committedAtISO: '0000-00-00T00:00:00.000Z',
      targetRawHash: candidate.rawHash
    };
    localStorage.setItem(LOCK_KEY, JSON.stringify(lock));
    const verified = readRecoveryLock();
    if (!verified || verified.token !== recoveryLockToken) throw new Error('The cross-tab recovery lock could not be acquired.');
  }

  function releaseUncommittedRecoveryLock() {
    try {
      const lock = readRecoveryLock();
      if (lock?.token === recoveryLockToken && Number(lock.committedAtMs || 0) === 0) {
        localStorage.removeItem(LOCK_KEY);
      }
    } catch (_) {}
  }

  function finalizeRecoveryLock() {
    try {
      const lock = readRecoveryLock();
      if (!lock || lock.token !== recoveryLockToken) return false;
      const committedAtMs = String(Date.now()).padStart(13, '0');
      const next = {
        ...lock,
        committedAtMs,
        committedAtISO: new Date(Number(committedAtMs)).toISOString()
      };
      localStorage.setItem(LOCK_KEY, JSON.stringify(next));
      const verified = readRecoveryLock();
      return verified?.token === recoveryLockToken && Number(verified.committedAtMs || 0) > 0;
    } catch (_) { return false; }
  }

  function downloadPackage() {
    if (!candidate || !validation?.verified) return false;
    const current = readCurrent(validation.api);
    const payload = {
      exportType: 'taskpoints_verified_secondary_restore_package',
      exportedAtISO: new Date().toISOString(),
      current,
      capturedBeforeRecoveryRuntime: {
        capturedAtISO: preloadJournals.capturedAtISO || '',
        habitJournalRaw: preloadJournals.habitJournalRaw || '',
        legacyJournalRaw: preloadJournals.legacyJournalRaw || ''
      },
      verifiedSecondary: {
        verifiedAtISO: candidate.verifiedAtISO || '',
        raw: candidate.raw,
        rawHash: candidate.rawHash,
        counts: candidate.counts
      }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `taskpoints-before-secondary-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    return true;
  }

  async function validate() {
    const api = global.TaskPointsStorageHealth;
    if (!api) throw new Error('Storage decoder did not load.');
    candidate = verifyRecord(await readLatest(), api);
    const journals = currentJournalState();
    const current = readCurrent(api);
    validation = {
      api,
      verified: true,
      ...journals,
      currentRaw: current.raw,
      currentReadable: current.readable,
      currentCounts: current.counts
    };
    return validation;
  }

  async function revalidateImmediatelyBeforeRestore() {
    const api = validation?.api || global.TaskPointsStorageHealth;
    if (!api || !candidate) throw new Error('Recovery candidate is not initialized.');
    if ((localStorage.getItem(STORAGE_KEY) || '') !== validation.currentRaw) {
      throw new Error('The current authoritative save changed while you were confirming. Refresh the recovery preview and review both copies again.');
    }
    const live = verifyRecord(await readLatest(), api);
    if (live.raw !== candidate.raw || live.rawHash !== candidate.rawHash || !sameCounts(live.counts, candidate.counts, api)) {
      throw new Error('The verified secondary changed while you were confirming. Refresh the page and review it again.');
    }
    const journals = currentJournalState();
    if (journals.pendingHabitCount || journals.legacyJournalPresent) {
      throw new Error('A pending journal exists or existed when the recovery page opened. Open full Emergency Data Recovery so those changes can be preserved.');
    }
    candidate = live;
    validation = { ...validation, ...journals };
  }

  async function restore() {
    if (!candidate || !validation?.verified) return;
    const initialJournals = currentJournalState();
    if (initialJournals.pendingHabitCount || initialJournals.legacyJournalPresent) {
      $('message').className = 'bad mb-4';
      $('message').textContent = 'Restore is blocked because a pending journal exists or existed when the recovery page opened. Open full Emergency Data Recovery so those changes can be preserved and reconciled.';
      return;
    }

    const first = confirm(`Restore the verified secondary copy with ${candidate.counts.majorTotal.toLocaleString()} major records?\n\nClose every other TaskPoints tab or window first. The current authoritative save will be replaced. Player images are not touched.`);
    if (!first) return;
    const typed = prompt('Final confirmation: type RESTORE in all capital letters. A recovery package will download before any write occurs.');
    if (typed !== 'RESTORE') {
      $('message').className = 'warning mb-4';
      $('message').textContent = 'Restore cancelled. The confirmation text did not match.';
      return;
    }

    $('restoreBtn').disabled = true;
    $('restoreBtn').textContent = 'Restoring…';
    try {
      acquireRecoveryLock();
      await delay(150);
      await revalidateImmediatelyBeforeRestore();
      if (!downloadPackage()) throw new Error('Recovery package could not be prepared.');
      const finalJournals = currentJournalState();
      if (finalJournals.pendingHabitCount || finalJournals.legacyJournalPresent) {
        throw new Error('A pending journal appeared after the recovery package was prepared.');
      }
      if ((localStorage.getItem(STORAGE_KEY) || '') !== validation.currentRaw) {
        throw new Error('The current authoritative save changed immediately before replacement.');
      }

      localStorage.setItem(MODE_KEY, 'off');
      localStorage.setItem(HOLD_KEY, JSON.stringify({
        active: true,
        enteredAtISO: new Date().toISOString(),
        reason: 'verified_secondary_restore_in_progress'
      }));
      localStorage.setItem(STORAGE_KEY, candidate.raw);
      authoritativeWriteOccurred = true;

      const readBackRaw = localStorage.getItem(STORAGE_KEY) || '';
      if (readBackRaw !== candidate.raw) throw new Error('Exact raw readback verification failed.');
      if (validation.api.rawHash(readBackRaw) !== candidate.rawHash) throw new Error('Restored raw hash verification failed.');
      const readBack = validation.api.parseStoredRaw(readBackRaw);
      const readBackCounts = validation.api.countsFor(readBack.state);
      if (!sameCounts(readBackCounts, candidate.counts, validation.api)) {
        throw new Error('Restored record-count verification failed.');
      }
      restoreVerified = true;

      const lockFinalized = finalizeRecoveryLock();
      let holdFinalized = true;
      try {
        localStorage.setItem(HOLD_KEY, JSON.stringify({
          active: true,
          restored: true,
          restoredAtISO: new Date().toISOString(),
          reason: 'verified_secondary_post_restore_validation'
        }));
      } catch (_) { holdFinalized = false; }

      $('message').className = lockFinalized ? 'good mb-4' : 'warning mb-4';
      $('message').textContent = lockFinalized
        ? `Verified secondary copy restored and read back successfully.${holdFinalized ? '' : ' Post-restore hold metadata could not be expanded, but the restored save is committed and verified.'} Reloading TaskPoints with IndexedDB Primary left Off.`
        : 'The restored save is committed and verified, but the cross-tab lock could not be finalized. Keep other TaskPoints tabs closed and open full Emergency Data Recovery before making further changes.';
      if (lockFinalized) setTimeout(() => { global.location.href = 'index.html'; }, 1200);
    } catch (error) {
      console.error(error);
      if (!authoritativeWriteOccurred) releaseUncommittedRecoveryLock();
      if (restoreVerified) finalizeRecoveryLock();
      if (restoreVerified) {
        $('message').className = 'warning mb-4';
        $('message').textContent = `The restore is committed and verified, but final bookkeeping reported: ${error?.message || error}. Do not run the restore again.`;
        $('restoreBtn').disabled = true;
      } else if (authoritativeWriteOccurred) {
        $('message').className = 'bad mb-4';
        $('message').textContent = `The authoritative value was replaced, but verification failed: ${error?.message || error}. Keep all other TaskPoints tabs closed and use full Emergency Data Recovery. The verified secondary and safety vault remain preserved.`;
        $('restoreBtn').disabled = true;
      } else {
        $('message').className = 'bad mb-4';
        $('message').textContent = `Restore stopped before replacing the authoritative save: ${error?.message || error}. The verified secondary database and safety vault were preserved.`;
        $('restoreBtn').disabled = false;
        $('restoreBtn').textContent = 'Restore verified copy';
      }
    }
  }

  async function initialize() {
    try {
      const result = await validate();
      renderCounts(candidate.counts);
      $('verifiedAt').textContent = `Verified ${formatTime(candidate.verifiedAtISO)} • exact hash and counts confirmed`;
      $('candidateStatus').textContent = 'Verified';
      $('candidateStatus').className = 'pill good-pill';
      $('downloadBtn').disabled = false;
      const exactMatch = result.currentRaw === candidate.raw;
      if (result.pendingHabitCount || result.legacyJournalPresent) {
        $('message').className = 'bad mb-4';
        $('message').textContent = 'A pending journal exists or existed when the recovery page opened. Direct secondary restoration is disabled; use full Emergency Data Recovery to preserve those changes.';
      } else if (exactMatch) {
        $('message').className = 'good mb-4';
        $('message').textContent = 'The verified secondary already matches the current authoritative save exactly. No restore is needed.';
      } else {
        $('message').className = 'warning mb-4';
        $('message').textContent = 'The verified copy is valid and differs from the current authoritative save. Close every other TaskPoints tab or window before using manual restoration.';
        $('restoreBtn').disabled = false;
      }
      $('technicalReport').textContent = JSON.stringify({
        checkedAtISO: new Date().toISOString(),
        recoveryHoldActive: true,
        indexedDbPrimaryMode: localStorage.getItem(MODE_KEY),
        recoveryWriteLockKey: LOCK_KEY,
        candidate: { verifiedAtISO:candidate.verifiedAtISO || '', rawHash:candidate.rawHash, counts:candidate.counts },
        current: { readable:result.currentReadable, rawHash:result.currentRaw ? result.api.rawHash(result.currentRaw) : '', counts:result.currentCounts },
        exactRawMatch: exactMatch,
        journals: {
          capturedAtISO: preloadJournals.capturedAtISO || '',
          pendingHabitCount: result.pendingHabitCount,
          legacyJournalPresent: result.legacyJournalPresent,
          liveHabitCount: result.liveHabitCount,
          capturedHabitCount: result.capturedHabitCount,
          liveLegacyPresent: result.liveLegacyPresent,
          capturedLegacyPresent: result.capturedLegacyPresent
        }
      }, null, 2);
    } catch (error) {
      $('message').className = 'bad mb-4';
      $('message').textContent = String(error?.message || error);
      $('candidateStatus').textContent = 'Unavailable';
      $('candidateStatus').className = 'pill bad-pill';
      $('technicalReport').textContent = JSON.stringify({ checkedAtISO:new Date().toISOString(), error:String(error?.message || error) }, null, 2);
    }
  }

  $('downloadBtn').addEventListener('click', downloadPackage);
  $('restoreBtn').addEventListener('click', restore);
  global.addEventListener('load', initialize, { once:true });
})(typeof window !== 'undefined' ? window : globalThis);
