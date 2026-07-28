(function installTaskPointsRequalificationLoader(global) {
  'use strict';

  const api = global.TaskPointsStorageHealth;
  const document = global.document;
  if (!api || !document || global.__taskPointsRequalificationLoaderInstalled) return;
  global.__taskPointsRequalificationLoaderInstalled = true;

  const STORAGE_KEY = 'taskpoints_v1';
  const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
  const HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
  const GATE_KEY = 'taskpoints_indexeddb_requalification_v1';
  const ATTEMPT_LOCK_KEY = 'taskpoints_recovery_attempt_lock_v1';
  const HABIT_JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
  const LEGACY_JOURNAL_KEY = 'taskpoints_phase5b_pending_changes_v1';
  const SECONDARY_DB = 'taskpoints_verified_secondary_v1';
  const SECONDARY_STORE = 'snapshots';
  const VAULT_DB = 'taskpoints_safety_vault_v1';
  const VAULT_STORE = 'snapshots';
  const RUNTIME_SCRIPTS = [
    'scoring_core.js',
    'indexeddb_requalification_hold_guard.js',
    'indexeddb_requalification_session_compat.js',
    'indexeddb_requalification_guard.js',
    'indexeddb_requalification_vault_gate.js',
    'indexeddb_requalification_readonly_guard.js',
    'indexeddb_requalification.js'
  ];

  const $ = (id) => document.getElementById(id);
  const get = (key) => { try { return global.localStorage?.getItem?.(key) ?? null; } catch (_) { return null; } };
  const parseJson = (raw, fallback = null) => { try { return JSON.parse(raw); } catch (_) { return fallback; } };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const secondaryCountKeys = [...api.COUNT_KEYS, 'total', 'majorTotal'];
  const vaultCountKeys = [
    'tasks', 'completions', 'habits', 'players', 'flexActions',
    'gameHistory', 'matchups', 'schedule', 'seasonHistory', 'reminders',
    'majorTotal'
  ];
  let runtimePromise = null;
  let runtimeLoaded = false;
  let allowedSyntheticButton = '';
  let scanRevision = 0;

  function countsMatch(left, right, keys = secondaryCountKeys) {
    return keys.every((key) => Number(left?.[key] || 0) === Number(right?.[key] || 0));
  }

  function journalCount(raw) {
    if (!raw) return 0;
    const value = parseJson(raw, null);
    if (Array.isArray(value)) return value.length;
    if (Array.isArray(value?.operations)) return value.operations.length;
    return value && typeof value === 'object' ? Object.keys(value).length : 1;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Database check failed.'));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || new Error('Database check was interrupted.'));
      transaction.onerror = () => undefined;
    });
  }

  async function openExistingDatabase(name) {
    if (!global.indexedDB) return null;
    if (typeof global.indexedDB.databases === 'function') {
      try {
        const databases = await global.indexedDB.databases();
        if (!databases.some((entry) => entry?.name === name)) return null;
      } catch (_) {}
    }
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open(name);
      let upgradeAttempted = false;
      request.onupgradeneeded = () => {
        upgradeAttempted = true;
        try { request.transaction?.abort(); } catch (_) {}
      };
      request.onsuccess = () => {
        if (upgradeAttempted) {
          try { request.result?.close?.(); } catch (_) {}
          resolve(null);
        } else resolve(request.result);
      };
      request.onerror = () => {
        if (upgradeAttempted || request.error?.name === 'AbortError') resolve(null);
        else reject(request.error || new Error(`${name} could not be opened.`));
      };
      request.onblocked = () => reject(new Error(`${name} is busy in another TaskPoints window.`));
    });
  }

  async function readRecord(dbName, storeName, id) {
    const db = await openExistingDatabase(dbName);
    if (!db) return null;
    try {
      if (!db.objectStoreNames.contains(storeName)) return null;
      const transaction = db.transaction(storeName, 'readonly');
      const done = transactionDone(transaction);
      const record = await requestResult(transaction.objectStore(storeName).get(id));
      await done;
      return record || null;
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  function inspectCurrentSave() {
    const raw = get(STORAGE_KEY) || '';
    try {
      const parsed = api.parseStoredRaw(raw);
      return {
        ready: true,
        raw,
        rawHash: api.rawHash(raw),
        counts: api.countsFor(parsed.state),
        encoding: parsed.encoding,
        error: ''
      };
    } catch (error) {
      return { ready: false, raw, rawHash: api.rawHash(raw), counts: null, encoding: '', error: String(error?.message || error) };
    }
  }

  async function inspectSecondary(current) {
    try {
      const record = await readRecord(SECONDARY_DB, SECONDARY_STORE, 'latest');
      if (!record?.raw) throw new Error('The separate backup copy is missing.');
      if (record.status !== 'passed_verification') throw new Error('The separate backup has not completed its safety check.');
      if (record.rawHash !== api.rawHash(record.raw)) throw new Error('The separate backup failed its fingerprint check.');
      const parsed = api.parseStoredRaw(record.raw);
      const counts = api.countsFor(parsed.state);
      if (!countsMatch(counts, record.counts)) throw new Error('The separate backup record totals do not match its contents.');
      if (!current.ready || record.raw !== current.raw || !countsMatch(counts, current.counts)) {
        throw new Error('The separate backup has not caught up to the current working copy.');
      }
      return { ready: true, counts, recordHash: record.rawHash, error: '' };
    } catch (error) {
      return { ready: false, counts: null, recordHash: '', error: String(error?.message || error) };
    }
  }

  async function inspectVault() {
    try {
      const record = await readRecord(VAULT_DB, VAULT_STORE, 'latest');
      if (!record?.raw) throw new Error('The emergency backup vault is empty.');
      const calculatedHash = api.rawHash(record.raw);
      if (!record.rawHash || record.rawHash !== calculatedHash) {
        throw new Error('The emergency backup failed its fingerprint check.');
      }
      const parsed = api.parseStoredRaw(record.raw);
      const counts = api.countsFor(parsed.state);
      if (!record.counts || !countsMatch(counts, record.counts, vaultCountKeys)) {
        throw new Error('The emergency backup record totals do not match its contents.');
      }
      if (counts.majorTotal < 30) throw new Error('The emergency backup does not contain enough records to be trusted.');
      return { ready: true, counts, rawHash: calculatedHash, error: '' };
    } catch (error) {
      return { ready: false, counts: null, rawHash: '', error: String(error?.message || error) };
    }
  }

  async function scanReadOnly() {
    const revision = ++scanRevision;
    const current = inspectCurrentSave();
    const [secondary, vault] = await Promise.all([inspectSecondary(current), inspectVault()]);
    if (revision !== scanRevision) return null;
    const mode = get(MODE_KEY) || 'off';
    const gate = parseJson(get(GATE_KEY), {}) || {};
    const hold = Boolean(get(HOLD_KEY));
    const recoveryAttempt = Boolean(get(ATTEMPT_LOCK_KEY));
    const pendingChanges = journalCount(get(HABIT_JOURNAL_KEY));
    const legacyChanges = Boolean(get(LEGACY_JOURNAL_KEY));
    const ready = Boolean(
      current.ready
      && current.counts?.majorTotal >= 30
      && secondary.ready
      && vault.ready
      && !recoveryAttempt
      && pendingChanges === 0
      && !legacyChanges
    );
    const report = {
      scannedAtISO: new Date().toISOString(),
      current, secondary, vault, mode, gate, hold, recoveryAttempt, pendingChanges, legacyChanges, ready
    };
    global.__TASKPOINTS_REQUALIFICATION_READ_ONLY_REPORT__ = report;
    global.__TASKPOINTS_REQUALIFICATION_VERIFIED_VAULT_HASH__ = vault.ready ? vault.rawHash : '';
    return report;
  }

  function checkCard(label, ok, detail, warning = false) {
    const level = ok ? 'good' : (warning ? 'warn' : 'bad');
    const mark = ok ? '✓' : (warning ? '!' : '×');
    return `<div class="check ${level}"><span class="mark">${mark}</span><div><strong>${label}</strong><div class="muted small">${detail}</div></div></div>`;
  }

  function renderReadOnly(report) {
    if (!report || runtimeLoaded) return;
    const checks = [
      checkCard('Your current working copy is readable', report.current.ready, report.current.ready ? `${report.current.counts.majorTotal.toLocaleString()} main records are present.` : report.current.error),
      checkCard('Your separate backup copy matches', report.secondary.ready, report.secondary.ready ? 'Its fingerprint, contents, and record totals match the working copy.' : report.secondary.error),
      checkCard('Your emergency backup vault passes its integrity check', report.vault.ready, report.vault.ready ? `Its fingerprint and all stored record totals match (${report.vault.counts.majorTotal.toLocaleString()} main records).` : report.vault.error),
      checkCard('No changes are waiting to be saved', report.pendingChanges === 0 && !report.legacyChanges, report.pendingChanges === 0 && !report.legacyChanges ? 'No unfinished habit or older save notes remain.' : 'Finish or recover the waiting changes first.'),
      checkCard('No recovery is currently running', !report.recoveryAttempt, report.recoveryAttempt ? 'A recovery attempt is still active.' : 'No recovery attempt is active.'),
      checkCard('iPhone storage protection', false, 'iOS still does not promise permanent website storage, so keep full exports.', true)
    ];
    $('checks').innerHTML = checks.join('');
    $('modeValue').textContent = report.mode === 'indexeddb_primary' ? 'Faster mode' : (report.mode === 'verify_primary_writes' ? 'Short test mode' : 'Safe mode');
    $('recordValue').textContent = Number(report.current.counts?.majorTotal || 0).toLocaleString();
    $('backupValue').textContent = report.secondary.ready ? 'Matches' : 'Check needed';
    $('holdValue').textContent = report.hold ? 'On' : 'Cleared';

    const gateStatus = String(report.gate?.status || 'not_started');
    const activeTest = report.mode === 'verify_primary_writes' && ['awaiting_smoke_test', 'ready_for_fast_mode'].includes(gateStatus);
    const start = $('startTestBtn');
    const finish = $('finishTestBtn');
    start.disabled = !report.ready || activeTest;
    finish.disabled = !report.ready || !activeTest;
    start.dataset.allowed = start.disabled ? 'false' : 'true';
    finish.dataset.allowed = finish.disabled ? 'false' : 'true';

    if (report.ready) {
      $('overallTitle').textContent = activeTest ? 'Ready to check your edit and reopen' : 'Read-only checks passed';
      $('overallDetail').textContent = activeTest
        ? 'Press Finish when you have made the harmless edit and fully closed and reopened the normal TaskPoints app.'
        : 'Nothing has been written or switched. Press Start to load the full two-step safety test.';
      $('actionMessage').textContent = 'This page has only read your saved copies so far.';
    } else {
      $('overallTitle').textContent = 'A safety check needs attention';
      $('overallDetail').textContent = 'Nothing has been written or switched. The full test will remain unavailable until the red check is resolved.';
      $('actionMessage').textContent = 'Read-only check complete.';
    }
    $('technicalReport').textContent = JSON.stringify(report, (key, value) => key === 'raw' ? undefined : value, 2);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`${src} could not be loaded.`));
      document.head.appendChild(script);
    });
  }

  async function loadRuntime() {
    if (runtimeLoaded) return true;
    if (runtimePromise) return runtimePromise;
    runtimePromise = (async () => {
      $('actionMessage').textContent = 'Loading the full safety test after your button press…';
      for (const src of RUNTIME_SCRIPTS) await loadScript(src);
      runtimeLoaded = true;
      global.__TASKPOINTS_REQUALIFICATION_RUNTIME_LOADED__ = true;
      global.dispatchEvent(new Event('load'));
      return true;
    })().catch((error) => {
      runtimePromise = null;
      $('actionMessage').textContent = `The full safety test did not load: ${String(error?.message || error)}`;
      throw error;
    });
    return runtimePromise;
  }

  async function waitForRuntimeButton(buttonId) {
    const button = $(buttonId);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (button?.dataset?.allowed === 'true' && !button.disabled) return true;
      await wait(100);
    }
    return false;
  }

  async function runExplicitAction(buttonId) {
    const report = await scanReadOnly();
    if (!report?.vault?.ready) {
      renderReadOnly(report);
      $('actionMessage').textContent = 'The action was stopped because the emergency backup did not pass its fingerprint and record-total checks.';
      return;
    }
    if (!report.ready) {
      renderReadOnly(report);
      $('actionMessage').textContent = 'The action was stopped because a required read-only safety check did not pass.';
      return;
    }

    await loadRuntime();
    const available = await waitForRuntimeButton(buttonId);
    if (!available) {
      $('actionMessage').textContent = 'The full checklist loaded, but this action is not ready. Review the red or orange check above.';
      return;
    }
    allowedSyntheticButton = buttonId;
    $(buttonId).click();
  }

  ['startTestBtn', 'finishTestBtn'].forEach((buttonId) => {
    $(buttonId)?.addEventListener('click', (event) => {
      if (allowedSyntheticButton === buttonId) {
        allowedSyntheticButton = '';
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      runExplicitAction(buttonId).catch((error) => {
        $('actionMessage').textContent = `The action stopped safely: ${String(error?.message || error)}`;
      });
    }, { capture: true });
  });

  $('refreshBtn')?.addEventListener('click', (event) => {
    if (runtimeLoaded) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    $('actionMessage').textContent = 'Reading all saved copies again…';
    scanReadOnly().then(renderReadOnly).catch((error) => {
      $('actionMessage').textContent = String(error?.message || error);
    });
  }, { capture: true });

  scanReadOnly().then(renderReadOnly).catch((error) => {
    $('overallTitle').textContent = 'The read-only check could not finish';
    $('overallDetail').textContent = String(error?.message || error);
    $('actionMessage').textContent = 'Nothing was written or switched.';
  });
})(typeof window !== 'undefined' ? window : globalThis);
