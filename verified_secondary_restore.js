(function installVerifiedSecondaryRestore(global) {
  'use strict';

  const STORAGE_KEY = 'taskpoints_v1';
  const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
  const HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
  const HABIT_JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
  const LEGACY_JOURNAL_KEY = 'taskpoints_phase5b_pending_changes_v1';
  const DB_NAME = 'taskpoints_verified_secondary_v1';
  const STORE_NAME = 'snapshots';
  const preloadJournals = global.__taskPointsVerifiedSecondaryRestorePreload || {};
  let candidate = null;
  let validation = null;

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

  function downloadPackage() {
    if (!candidate || !validation?.verified) return false;
    const current = readCurrent(validation.api);
    const payload = {
      exportType: 'taskpoints_verified_secondary_restore_package',
      exportedAtISO: new Date().toISOString(),
      current,
      capturedBeforeTaskPointsCore: {
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
    const live = verifyRecord(await readLatest(), api);
    if (live.raw !== candidate.raw || live.rawHash !== candidate.rawHash || !sameCounts(live.counts, candidate.counts, api)) {
      throw new Error('The verified secondary changed while you were confirming. Refresh the page and review it again.');
    }
    const journals = currentJournalState();
    if (journals.pendingHabitCount || journals.legacyJournalPresent) {
      throw new Error('A pending journal exists or existed before TaskPointsCore loaded. Open full Emergency Data Recovery so those changes can be preserved.');
    }
    candidate = live;
    validation = { ...validation, ...journals };
  }

  async function restore() {
    if (!candidate || !validation?.verified) return;
    const initialJournals = currentJournalState();
    if (initialJournals.pendingHabitCount || initialJournals.legacyJournalPresent) {
      $('message').className = 'bad mb-4';
      $('message').textContent = 'Restore is blocked because a pending journal exists or existed before TaskPointsCore loaded. Open full Emergency Data Recovery so those changes can be preserved and reconciled.';
      return;
    }

    const first = confirm(`Restore the verified secondary copy with ${candidate.counts.majorTotal.toLocaleString()} major records?\n\nThe current authoritative save will be replaced. Player images are not touched.`);
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
      await revalidateImmediatelyBeforeRestore();
      if (!downloadPackage()) throw new Error('Recovery package could not be prepared.');
      localStorage.setItem(MODE_KEY, 'off');
      localStorage.setItem(HOLD_KEY, JSON.stringify({
        active: true,
        enteredAtISO: new Date().toISOString(),
        reason: 'verified_secondary_restore_in_progress'
      }));

      const core = global.TaskPointsCore;
      if (!core?.safeReplaceTaskPointsStorage) throw new Error('TaskPoints storage API did not load.');
      const replace = () => core.safeReplaceTaskPointsStorage(STORAGE_KEY, candidate.raw);
      if (typeof core.withTaskPointsDestructiveWriteAllowed === 'function') {
        core.withTaskPointsDestructiveWriteAllowed(replace);
      } else replace();

      const readBackRaw = localStorage.getItem(STORAGE_KEY) || '';
      if (readBackRaw !== candidate.raw) throw new Error('Exact raw readback verification failed.');
      if (validation.api.rawHash(readBackRaw) !== candidate.rawHash) throw new Error('Restored raw hash verification failed.');
      const readBack = validation.api.parseStoredRaw(readBackRaw);
      const readBackCounts = validation.api.countsFor(readBack.state);
      if (!sameCounts(readBackCounts, candidate.counts, validation.api)) {
        throw new Error('Restored record-count verification failed.');
      }

      localStorage.setItem(HOLD_KEY, JSON.stringify({
        active: true,
        restored: true,
        restoredAtISO: new Date().toISOString(),
        reason: 'verified_secondary_post_restore_validation'
      }));
      $('message').className = 'good mb-4';
      $('message').textContent = 'Verified secondary copy restored and read back successfully. Reloading TaskPoints with IndexedDB Primary left Off.';
      setTimeout(() => { global.location.href = 'index.html'; }, 1200);
    } catch (error) {
      console.error(error);
      $('message').className = 'bad mb-4';
      $('message').textContent = `Restore failed: ${error?.message || error}. The verified secondary database was preserved.`;
      $('restoreBtn').disabled = false;
      $('restoreBtn').textContent = 'Restore verified copy';
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
        $('message').textContent = 'A pending journal exists or existed before TaskPointsCore loaded. Direct secondary restoration is disabled; use full Emergency Data Recovery to preserve those changes.';
      } else if (exactMatch) {
        $('message').className = 'good mb-4';
        $('message').textContent = 'The verified secondary already matches the current authoritative save exactly. No restore is needed.';
      } else {
        $('message').className = 'warning mb-4';
        $('message').textContent = 'The verified copy is valid and differs from the current authoritative save. Manual restoration is available.';
        $('restoreBtn').disabled = false;
      }
      $('technicalReport').textContent = JSON.stringify({
        checkedAtISO: new Date().toISOString(),
        recoveryHoldActive: true,
        indexedDbPrimaryMode: localStorage.getItem(MODE_KEY),
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
