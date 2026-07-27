(function installTaskPointsIndexedDbSafetyCheck(global) {
  'use strict';

  const api = global.TaskPointsStorageHealth;
  const core = global.TaskPointsCore;
  if (!api || !core) return;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const MODE_KEY = core.PHASE4_STORAGE_MODE_KEY || 'taskpoints_phase4_storage_mode_v1';
  const HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
  const GATE_KEY = 'taskpoints_indexeddb_requalification_v1';
  const GUARD_DIAG_KEY = 'taskpoints_storage_data_loss_guard_v1';
  const ATTEMPT_LOCK_KEY = 'taskpoints_recovery_attempt_lock_v1';
  const HABIT_JOURNAL_KEY = core.PENDING_HABIT_DELTAS_KEY || 'taskpoints_pending_habit_deltas_v1';
  const LEGACY_JOURNAL_KEY = 'taskpoints_phase5b_pending_changes_v1';
  const SECONDARY_DB = 'taskpoints_verified_secondary_v1';
  const SECONDARY_STORE = 'snapshots';
  const VAULT_DB = 'taskpoints_safety_vault_v1';
  const VAULT_STORE = 'snapshots';
  const FAST_DB = core.SHADOW_MIGRATION_DB_NAME || 'taskpoints_shadow_state_v1';
  const FAST_STORE = 'metadata';
  const FAST_SNAPSHOT_ID = core.PHASE4_PRIMARY_SNAPSHOT_METADATA_ID || 'phase4_primary_snapshot';
  const FAST_COMMIT_ID = core.PHASE4_PRIMARY_COMMIT_METADATA_ID || 'phase4_primary_commit';
  const NATIVE_ID = core.PHASE5A_NATIVE_SNAPSHOT_METADATA_ID || 'phase5a_native_snapshot';
  const $ = (id) => document.getElementById(id);
  let latestReport = null;
  let busy = false;

  const get = (key) => { try { return localStorage.getItem(key); } catch (_) { return null; } };
  const set = (key, value) => localStorage.setItem(key, value);
  const remove = (key) => localStorage.removeItem(key);
  const json = (raw, fallback = null) => { try { return JSON.parse(raw); } catch (_) { return fallback; } };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const sameCounts = (a, b) => [...api.COUNT_KEYS, 'total', 'majorTotal']
    .every((key) => Number(a?.[key] || 0) === Number(b?.[key] || 0));
  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  const habitJournalCount = () => {
    const value = json(get(HABIT_JOURNAL_KEY), null);
    if (!value) return 0;
    if (Array.isArray(value)) return value.length;
    if (Array.isArray(value.operations)) return value.operations.length;
    return typeof value === 'object' ? Object.keys(value).length : 1;
  };

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
        : reject(request.error || new Error(`${name} could not be opened.`));
      request.onblocked = () => reject(new Error(`${name} is busy in another TaskPoints window.`));
    });
  }

  async function readOne(dbName, storeName, id) {
    const db = await openExistingDatabase(dbName);
    if (!db) return null;
    try {
      if (!db.objectStoreNames.contains(storeName)) return null;
      const transaction = db.transaction(storeName, 'readonly');
      const done = transactionDone(transaction);
      const result = await requestResult(transaction.objectStore(storeName).get(id));
      await done;
      return result || null;
    } finally { db.close(); }
  }

  async function readFastRows() {
    const db = await openExistingDatabase(FAST_DB);
    if (!db) return { snapshot: null, commit: null, native: null };
    try {
      if (!db.objectStoreNames.contains(FAST_STORE)) return { snapshot: null, commit: null, native: null };
      const transaction = db.transaction(FAST_STORE, 'readonly');
      const done = transactionDone(transaction);
      const store = transaction.objectStore(FAST_STORE);
      const [snapshot, commit, native] = await Promise.all([
        requestResult(store.get(FAST_SNAPSHOT_ID)),
        requestResult(store.get(FAST_COMMIT_ID)),
        requestResult(store.get(NATIVE_ID))
      ]);
      await done;
      return { snapshot: snapshot || null, commit: commit || null, native: native || null };
    } finally { db.close(); }
  }

  function currentSave() {
    const raw = get(STORAGE_KEY) || '';
    try {
      const parsed = api.parseStoredRaw(raw);
      return {
        readable: true,
        raw,
        rawHash: api.rawHash(raw),
        state: parsed.state,
        stateCanonical: canonical(parsed.state),
        counts: api.countsFor(parsed.state),
        encoding: parsed.encoding,
        error: ''
      };
    } catch (error) {
      return { readable: false, raw, rawHash: api.rawHash(raw), state: null, stateCanonical: '', counts: null, encoding: '', error: String(error?.message || error) };
    }
  }

  async function secondaryCopy(current) {
    try {
      const record = await readOne(SECONDARY_DB, SECONDARY_STORE, 'latest');
      if (!record) throw new Error('The backup copy is missing.');
      if (record.status !== 'passed_verification') throw new Error('The backup copy has not finished its safety check.');
      if (!record.raw || record.rawHash !== api.rawHash(record.raw)) throw new Error('The backup copy failed its fingerprint check.');
      const parsed = api.parseStoredRaw(record.raw);
      const counts = api.countsFor(parsed.state);
      if (!sameCounts(counts, record.counts || {})) throw new Error('The backup copy record totals do not match.');
      return {
        ready: true,
        exact: Boolean(current.readable && record.raw === current.raw && sameCounts(counts, current.counts)),
        record,
        counts,
        error: ''
      };
    } catch (error) {
      return { ready: false, exact: false, record: null, counts: null, error: String(error?.message || error) };
    }
  }

  async function vaultCopy() {
    try {
      const record = await readOne(VAULT_DB, VAULT_STORE, 'latest');
      if (!record?.raw) throw new Error('The emergency backup vault is empty.');
      const parsed = api.parseStoredRaw(record.raw);
      const counts = api.countsFor(parsed.state);
      return { ready: counts.majorTotal >= 30, record, counts, error: '' };
    } catch (error) {
      return { ready: false, record: null, counts: null, error: String(error?.message || error) };
    }
  }

  async function fastCopies(current) {
    try {
      const rows = await readFastRows();
      const snapshot = rows.snapshot;
      const commit = rows.commit;
      const native = rows.native;
      let snapshotCounts = null;
      let snapshotCanonical = '';
      if (snapshot?.serializedState) {
        const parsed = api.parseStoredRaw(snapshot.serializedState);
        snapshotCounts = api.countsFor(parsed.state);
        snapshotCanonical = canonical(parsed.state);
      }
      const phase4Current = Boolean(
        current.readable
        && commit?.status === 'passed_verification'
        && snapshot?.serializedState === current.raw
        && Number(snapshot?.sequence || 0) > 0
        && Number(snapshot?.sequence || 0) === Number(commit?.sequence || 0)
        && snapshot?.mirrorHash
        && snapshot.mirrorHash === commit.mirrorHash
        && sameCounts(snapshotCounts, current.counts)
        && snapshotCanonical === current.stateCanonical
      );
      const nativeCounts = native?.state ? api.countsFor(native.state) : null;
      const nativeCurrent = Boolean(
        phase4Current
        && native?.status === 'passed_verification'
        && native?.snapshotFormat === 'metadata_structured_clone_v1'
        && Number(native?.sequence || 0) === Number(commit?.sequence || 0)
        && native?.mirrorHash === snapshot?.mirrorHash
        && sameCounts(nativeCounts, current.counts)
        && canonical(native.state) === current.stateCanonical
      );
      return { ready: phase4Current && nativeCurrent, phase4Current, nativeCurrent, rows, error: '' };
    } catch (error) {
      return { ready: false, phase4Current: false, nativeCurrent: false, rows: {}, error: String(error?.message || error) };
    }
  }

  function phase4Healthy(status, baselineFailures) {
    return Boolean(
      status
      && Number(status.latestQueuedSequence || 0) > 0
      && Number(status.latestQueuedSequence || 0) === Number(status.latestPassedSequence || 0)
      && Number(status.pendingWrites || 0) === 0
      && !status.lastFallbackReason
      && status.countsMatch === true
      && status.hashesMatch === true
      && status.canonicalMatch === true
      && (!Array.isArray(status.mismatches) || status.mismatches.length === 0)
      && Number(status.verificationFailuresTotal || 0) <= Number(baselineFailures || 0)
    );
  }

  async function collect() {
    const current = currentSave();
    const [secondary, vault, fast] = await Promise.all([
      secondaryCopy(current), vaultCopy(), fastCopies(current)
    ]);
    const guard = json(get(GUARD_DIAG_KEY), {}) || {};
    const gate = json(get(GATE_KEY), {}) || {};
    const phase4 = core.getPhase4StorageStatus?.() || {};
    const mode = core.getPhase4StorageMode?.() || get(MODE_KEY) || 'off';
    const recoveryHold = get(HOLD_KEY);
    const attemptLock = get(ATTEMPT_LOCK_KEY);
    const habitPending = habitJournalCount();
    const legacyPending = Boolean(get(LEGACY_JOURNAL_KEY));
    const guardReady = core.__storageDataLossGuardInstalled === true && guard.enabled === true && guard.phase5bLiveBundleDisabled === true;
    const blockedWrites = Number(guard.blockedWritesTotal || 0);
    const baseReady = Boolean(
      current.readable && current.counts?.majorTotal >= 30
      && secondary.exact
      && vault.ready
      && guardReady
      && blockedWrites === 0
      && !attemptLock
      && habitPending === 0
      && !legacyPending
      && core.__indexedDbRequalificationGuardInstalled === true
    );
    const editDetected = Boolean(gate.baselineRawHash && current.rawHash !== gate.baselineRawHash);
    const testHealthy = Boolean(
      gate.status === 'awaiting_smoke_test'
      && mode === 'verify_primary_writes'
      && editDetected
      && secondary.exact
      && fast.ready
      && phase4Healthy(phase4, gate.baselineVerificationFailures)
    );
    return {
      scannedAtISO: new Date().toISOString(), current, secondary, vault, fast, guard, gate, phase4,
      mode, recoveryHold: Boolean(recoveryHold), recoveryHoldRaw: recoveryHold,
      attemptLock: Boolean(attemptLock), habitPending, legacyPending, guardReady,
      blockedWrites, baseReady, editDetected, testHealthy
    };
  }

  function checkCard(label, ok, detail, warning = false) {
    const level = ok ? 'good' : (warning ? 'warn' : 'bad');
    const mark = ok ? '✓' : (warning ? '!' : '×');
    return `<div class="check ${level}"><span class="mark">${mark}</span><div><strong>${label}</strong><div class="muted small">${detail}</div></div></div>`;
  }

  function setBusy(value, text = '') {
    busy = value;
    ['startTestBtn', 'finishTestBtn', 'refreshBtn'].forEach((id) => { const button = $(id); if (button) button.disabled = value || button.dataset.allowed !== 'true'; });
    if (text) $('actionMessage').textContent = text;
  }

  function render(report) {
    latestReport = report;
    const checks = [
      checkCard('Your current working copy is readable', report.current.readable, report.current.readable ? `${report.current.counts.majorTotal.toLocaleString()} main records are present.` : report.current.error),
      checkCard('Your separate backup copy matches', report.secondary.exact, report.secondary.exact ? 'The working copy and backup copy are identical.' : report.secondary.error || 'The two copies do not match.'),
      checkCard('Your emergency backup vault has a copy', report.vault.ready, report.vault.ready ? `${report.vault.counts.majorTotal.toLocaleString()} main records are protected there.` : report.vault.error),
      checkCard('The data-loss safety net is on', report.guardReady && report.blockedWrites === 0, report.guardReady ? `${report.blockedWrites} dangerous replacement attempts have been blocked.` : 'The safety net is not fully installed.'),
      checkCard('No changes are waiting to be saved', report.habitPending === 0 && !report.legacyPending, report.habitPending === 0 && !report.legacyPending ? 'No unfinished habit or older save notes remain.' : 'Finish or recover the waiting changes first.'),
      checkCard('No recovery is currently running', !report.attemptLock, report.attemptLock ? 'A recovery attempt is still active.' : 'No recovery attempt is active.'),
      checkCard('The faster database copy is current', report.fast.ready, report.fast.ready ? 'Both faster copies match your working copy.' : 'This will be rebuilt during the short test.', !report.fast.ready),
      checkCard('iPhone storage protection', false, 'iOS still does not promise permanent website storage, so keep full exports.', true)
    ];
    $('checks').innerHTML = checks.join('');

    const gateStatus = String(report.gate.status || 'not_started');
    let title = 'Ready to prepare the faster mode';
    let detail = 'This first step keeps your current working copy in charge while rebuilding and checking the faster database copy.';
    if (!report.baseReady) {
      title = 'A safety check needs attention';
      detail = 'Nothing will be switched until every required safety check passes.';
    } else if (gateStatus === 'awaiting_smoke_test') {
      title = report.testHealthy ? 'Short test passed' : 'Make one harmless edit, then close and reopen';
      detail = report.testHealthy
        ? 'All copies match after your edit. Faster mode can now be turned on.'
        : (report.editDetected ? 'Your edit was detected. Wait a few seconds and tap Refresh so the other copies can catch up.' : 'Edit something harmless, fully close TaskPoints, reopen it, then return here.');
    } else if (gateStatus === 'fast_mode_enabled' && report.mode === 'indexeddb_primary') {
      title = 'Faster mode is on';
      detail = 'TaskPoints can now read from the faster database copy, with your working copy and backups still kept for safety.';
    } else if (gateStatus === 'failed') {
      title = 'The test stopped safely';
      detail = report.gate.lastError || 'TaskPoints stayed in the safe storage mode.';
    }
    $('overallTitle').textContent = title;
    $('overallDetail').textContent = detail;
    $('modeValue').textContent = report.mode === 'indexeddb_primary' ? 'Faster mode' : (report.mode === 'verify_primary_writes' ? 'Short test mode' : 'Safe mode');
    $('recordValue').textContent = Number(report.current.counts?.majorTotal || 0).toLocaleString();
    $('backupValue').textContent = report.secondary.exact ? 'Matches' : 'Check needed';
    $('holdValue').textContent = report.recoveryHold ? 'On' : 'Cleared';

    const start = $('startTestBtn');
    const finish = $('finishTestBtn');
    start.dataset.allowed = report.baseReady && ['not_started', '', 'failed'].includes(gateStatus) && report.mode === 'off' ? 'true' : 'false';
    finish.dataset.allowed = report.testHealthy ? 'true' : 'false';
    start.disabled = busy || start.dataset.allowed !== 'true';
    finish.disabled = busy || finish.dataset.allowed !== 'true';
    start.textContent = gateStatus === 'failed' ? 'Try the short test again' : 'Start short test';
    finish.textContent = 'Finish test and turn on faster mode';
    $('technicalReport').textContent = JSON.stringify(report, (key, value) => ['raw','state','stateCanonical','recoveryHoldRaw','record','rows'].includes(key) ? undefined : value, 2);
  }

  async function refresh() {
    if (busy) return;
    setBusy(true, 'Checking all copies…');
    try {
      await core.flushPhase5CVerifiedSecondaryWrites?.();
      await core.flushPhase4PrimaryWrites?.();
      await core.flushPhase5ANativeSnapshotWrites?.();
      render(await collect());
      $('actionMessage').textContent = 'Check complete.';
    } catch (error) {
      $('actionMessage').textContent = String(error?.message || error);
    } finally { setBusy(false); }
  }

  async function startTest() {
    if (busy) return;
    setBusy(true, 'Starting the short test…');
    let previousHoldRaw = null;
    try {
      const before = await collect();
      if (!before.baseReady || before.mode !== 'off') throw new Error('The safety checklist is not ready yet.');
      previousHoldRaw = before.recoveryHoldRaw;
      const authorization = {
        schemaVersion: 1,
        status: 'authorizing_test_mode',
        authorizedAtISO: new Date().toISOString(),
        authorizedRawHash: before.current.rawHash,
        baselineRawHash: before.current.rawHash,
        baselineCounts: before.current.counts,
        baselineVerificationFailures: Number(before.phase4.verificationFailuresTotal || 0)
      };
      set(GATE_KEY, JSON.stringify(authorization));
      remove(HOLD_KEY);
      const selected = core.setPhase4StorageMode?.('verify_primary_writes');
      if (selected !== 'verify_primary_writes') throw new Error('TaskPoints could not enter the short test mode.');
      core.queuePhase4PrimaryWrite?.({ reason: 'indexeddb_requalification_start', force: true });
      await core.flushPhase4PrimaryWrites?.();
      await core.flushPhase5ANativeSnapshotWrites?.();
      await core.flushPhase5CVerifiedSecondaryWrites?.();
      await wait(250);
      const after = await collect();
      if (!after.fast.ready || !after.secondary.exact || !phase4Healthy(after.phase4, authorization.baselineVerificationFailures)) {
        throw new Error('The faster copy did not finish all of its checks.');
      }
      set(GATE_KEY, JSON.stringify({
        ...authorization,
        status: 'awaiting_smoke_test',
        testPreparedAtISO: new Date().toISOString(),
        preparedSequence: Number(after.phase4.latestPassedSequence || 0),
        lastVerifiedRawHash: after.current.rawHash,
        lastError: null
      }));
      $('actionMessage').textContent = 'Short test is ready. Make one harmless edit, fully close TaskPoints, reopen it, then return here.';
      render(await collect());
    } catch (error) {
      try { core.setPhase4StorageMode?.('off'); } catch (_) { try { set(MODE_KEY, 'off'); } catch (_) {} }
      try {
        if (previousHoldRaw != null) set(HOLD_KEY, previousHoldRaw);
        else set(HOLD_KEY, JSON.stringify({ schemaVersion: 1, active: true, restoredAfterFailedTestAtISO: new Date().toISOString() }));
      } catch (_) {}
      try {
        const existing = json(get(GATE_KEY), {}) || {};
        set(GATE_KEY, JSON.stringify({ ...existing, status: 'failed', failedAtISO: new Date().toISOString(), lastError: String(error?.message || error) }));
      } catch (_) {}
      $('actionMessage').textContent = `The test stopped safely: ${String(error?.message || error)}`;
      render(await collect());
    } finally { setBusy(false); }
  }

  async function finishTest() {
    if (busy) return;
    setBusy(true, 'Checking your edit and turning on faster mode…');
    try {
      await core.flushPhase4PrimaryWrites?.();
      await core.flushPhase5ANativeSnapshotWrites?.();
      await core.flushPhase5CVerifiedSecondaryWrites?.();
      await wait(250);
      const before = await collect();
      if (!before.testHealthy) throw new Error('The short test is not fully caught up yet. Tap Refresh and check again.');
      const readyRecord = {
        ...before.gate,
        status: 'ready_for_fast_mode',
        finalCheckAtISO: new Date().toISOString(),
        lastVerifiedRawHash: before.current.rawHash,
        finalCounts: before.current.counts,
        finalSequence: Number(before.phase4.latestPassedSequence || 0),
        lastError: null
      };
      set(GATE_KEY, JSON.stringify(readyRecord));
      const selected = core.setPhase4StorageMode?.('indexeddb_primary');
      if (selected !== 'indexeddb_primary') throw new Error('TaskPoints did not allow faster mode to turn on.');
      const warm = await core.warmPhase4PrimaryCache?.('indexeddb_requalification_finish');
      await core.restorePhase5ANativeSnapshot?.();
      await wait(150);
      const status = core.getPhase4StorageStatus?.() || {};
      const native = core.getPhase5ANativeSnapshotStatus?.() || {};
      const ready = warm !== false
        && status.configuredMode === 'indexeddb_primary'
        && status.cacheReadyThisPage === true
        && status.currentMirrorMatchesCache === true
        && !status.lastFallbackReason
        && native.cacheReady === true;
      if (!ready) throw new Error('The faster copy could not be opened cleanly.');
      set(GATE_KEY, JSON.stringify({
        ...readyRecord,
        status: 'fast_mode_enabled',
        enabledAtISO: new Date().toISOString(),
        lastError: null
      }));
      $('actionMessage').textContent = 'Faster mode is on. Fully close and reopen TaskPoints once, then use it normally.';
      render(await collect());
    } catch (error) {
      try { core.setPhase4StorageMode?.('verify_primary_writes'); } catch (_) {}
      try {
        const existing = json(get(GATE_KEY), {}) || {};
        set(GATE_KEY, JSON.stringify({ ...existing, status: 'awaiting_smoke_test', lastError: String(error?.message || error) }));
      } catch (_) {}
      $('actionMessage').textContent = `Faster mode stayed off: ${String(error?.message || error)}`;
      render(await collect());
    } finally { setBusy(false); }
  }

  $('refreshBtn').addEventListener('click', refresh);
  $('startTestBtn').addEventListener('click', startTest);
  $('finishTestBtn').addEventListener('click', finishTest);
  global.addEventListener('load', refresh, { once: true });
})(typeof window !== 'undefined' ? window : globalThis);
