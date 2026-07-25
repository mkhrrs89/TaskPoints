from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'missing pattern in {path}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))

# Coordinator: read the committed metadata alongside the rebuilt state.
replace_once('phase4_storage_coordinator.js',
"""    const candidateRequest = requestPromise(tx.objectStore('metadata').get(CANDIDATE_ID));
    const [arrayRows, collectionRows, valuesRows, candidate] = await Promise.all([
      Promise.all(arrayRequests), collectionRequest, valuesRequest, candidateRequest
    ]);""",
"""    const candidateRequest = requestPromise(tx.objectStore('metadata').get(CANDIDATE_ID));
    const primaryCommitRequest = requestPromise(tx.objectStore('metadata').get(PRIMARY_COMMIT_ID));
    const [arrayRows, collectionRows, valuesRows, candidate, primaryCommit] = await Promise.all([
      Promise.all(arrayRequests), collectionRequest, valuesRequest, candidateRequest, primaryCommitRequest
    ]);""")
replace_once('phase4_storage_coordinator.js',
"""    return { state, candidate: candidate || null };
  }

  async function commitPrimary(db, metadata) {""",
"""    return { state, candidate: candidate || null, primaryCommit: primaryCommit || null };
  }

  async function restoreVerifiedPrimaryFromIndexedDb(options = {}) {
    const indexedDb = options.indexedDB || global.indexedDB;
    const rawBefore = safeGet(core.STORAGE_KEY);
    if (rawBefore === null) return { restored: false, reason: 'authoritative_missing' };
    if ((Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0) return { restored: false, reason: 'dual_write_pending' };
    if ((Number(core.getPendingPhase4WriteCount?.()) || 0) > 0) return { restored: false, reason: 'phase4_write_pending' };
    if (journalCount() > 0) return { restored: false, reason: 'pending_habit_journal' };

    let db = null;
    try {
      db = await openShadowDb(indexedDb);
      const rebuilt = await readState(db);
      const commit = rebuilt.primaryCommit;
      if (!commit || commit.status !== 'passed_verification') throw new Error('primary_commit_missing');

      const rawAfter = safeGet(core.STORAGE_KEY);
      if (rawAfter === null) throw new Error('authoritative_missing');
      if (rawAfter !== rawBefore) throw new Error('mirror_changed_during_restore');
      if ((Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0) throw new Error('dual_write_pending');
      if ((Number(core.getPendingPhase4WriteCount?.()) || 0) > 0) throw new Error('phase4_write_pending');
      if (journalCount() > 0) throw new Error('pending_habit_journal');

      const source = core.parseTaskPointsStorageJson(rawBefore, {}) || {};
      const sourceSummary = core.shadowSourceSummary(source);
      const destinationSummary = core.shadowSourceSummary(rebuilt.state);
      const countsMatch = core.shadowCanonicalJson(sourceSummary.counts) === core.shadowCanonicalJson(destinationSummary.counts);
      const hashesMatch = sourceSummary.hashes.state === destinationSummary.hashes.state;
      const canonicalMatch = core.shadowCanonicalJson(layoutFor(source)) === core.shadowCanonicalJson(layoutFor(rebuilt.state));
      const mismatches = core.shadowVerificationMismatches(sourceSummary, destinationSummary) || [];
      if (commit.mirrorHash && commit.mirrorHash !== hashValue(rawBefore)) throw new Error('committed_mirror_mismatch');
      const committedSourceHash = commit.verification?.source?.hashes?.state;
      const committedDestinationHash = commit.verification?.destination?.hashes?.state;
      if (committedSourceHash && committedSourceHash !== sourceSummary.hashes.state) throw new Error('committed_source_hash_mismatch');
      if (committedDestinationHash && committedDestinationHash !== destinationSummary.hashes.state) throw new Error('committed_destination_hash_mismatch');
      if (!countsMatch || !hashesMatch || !canonicalMatch || mismatches.length) throw new Error('committed_primary_mismatch');

      const diagnostics = readDiagnostics();
      const verifiedAt = nowIso();
      const reconciledSequence = Math.max(
        Number(diagnostics.latestQueuedSequence) || 0,
        Number(diagnostics.latestPassedSequence) || 0,
        Number(commit.sequence) || 0,
        1
      );
      verifiedPrimaryCache = {
        schemaVersion: 1,
        sequence: reconciledSequence,
        committedSequence: Number(commit.sequence) || 0,
        state: clone(rebuilt.state),
        serializedState: JSON.stringify(rebuilt.state),
        sourceHash: sourceSummary.hashes.state,
        destinationHash: destinationSummary.hashes.state,
        sourceCounts: sourceSummary.counts,
        destinationCounts: destinationSummary.counts,
        mirrorRaw: rawBefore,
        mirrorHash: hashValue(rawBefore),
        status: 'passed_verification',
        verifiedAt,
        restoredFromIndexedDb: true
      };
      persistVerifiedPrimaryCache(verifiedPrimaryCache);
      writeDiagnostics({
        configuredMode: getMode(),
        effectiveSource: getMode() === 'indexeddb_primary' ? 'indexedDB_ready' : 'localStorage',
        latestQueuedSequence: reconciledSequence,
        latestPassedSequence: reconciledSequence,
        lastVerifiedAt: verifiedAt,
        lastFallbackReason: null,
        cacheRestoredFromIndexedDb: true,
        countsMatch: true,
        hashesMatch: true,
        canonicalMatch: true,
        mismatches: []
      });
      return { restored: true, cache: verifiedPrimaryCache };
    } catch (error) {
      return { restored: false, reason: normalizedErrorReason(error) };
    } finally { db?.close?.(); }
  }

  async function commitPrimary(db, metadata) {""")
replace_once('phase4_storage_coordinator.js',
"""        mismatches: []
      });""",
"""        mismatches: [],
        cacheRestoredFromIndexedDb: false
      });""")
replace_once('phase4_storage_coordinator.js',
"""      currentMirrorMatchesCache: Boolean(verifiedPrimaryCache && safeGet(core.STORAGE_KEY) === verifiedPrimaryCache.mirrorRaw)
    };""",
"""      currentMirrorMatchesCache: Boolean(verifiedPrimaryCache && safeGet(core.STORAGE_KEY) === verifiedPrimaryCache.mirrorRaw),
      cacheRestoredFromIndexedDb: diagnostics.cacheRestoredFromIndexedDb === true || Boolean(verifiedPrimaryCache?.restoredFromIndexedDb)
    };""")
replace_once('phase4_storage_coordinator.js',
"""  core.persistPhase4VerifiedPrimaryCache = persistVerifiedPrimaryCache;
  core.setPhase4VerifiedPrimaryCache = (value, options = {}) => {""",
"""  core.persistPhase4VerifiedPrimaryCache = persistVerifiedPrimaryCache;
  core.restorePhase4CommittedPrimary = restoreVerifiedPrimaryFromIndexedDb;
  core.setPhase4VerifiedPrimaryCache = (value, options = {}) => {""")

# Primary read path: restore the committed snapshot before attempting a full rewrite.
replace_once('phase4_primary_read_path.js',
"""  async function warmPrimaryCache(reason = 'primary_cache_warmup') {
    if ((core.getPhase4StorageMode?.() || 'off') !== 'indexeddb_primary') return false;
    const mirrorRaw = safeGet(core.STORAGE_KEY);
    if (cacheMatchesMirror(cache(), mirrorRaw)) {
      writeDiagnostics({ effectiveSource: 'indexedDB_ready', lastFallbackReason: null });
      return true;
    }
    if (warmupPromise) return warmupPromise;
    warmupPromise = Promise.resolve()
      .then(() => core.queuePhase4PrimaryWrite?.({ reason }))
      .then(() => core.flushPhase4PrimaryWrites?.())
      .then(() => {
        const ready = cacheMatchesMirror(cache(), safeGet(core.STORAGE_KEY));
        writeDiagnostics({
          effectiveSource: ready ? 'indexedDB_ready' : 'localStorage',
          lastFallbackReason: ready ? null : 'cache_warmup_failed'
        });
        return ready;
      })
      .catch(() => {
        writeDiagnostics({ effectiveSource: 'localStorage', lastFallbackReason: 'cache_warmup_failed' });
        return false;
      })
      .finally(() => { warmupPromise = null; });
    return warmupPromise;
  }
  function schedulePrimaryWarmup(reason = 'cache_not_ready') {
    if ((core.getPhase4StorageMode?.() || 'off') !== 'indexeddb_primary' || warmupScheduled || warmupPromise) return;""",
"""  async function warmPrimaryCache(reason = 'primary_cache_warmup') {
    if ((core.getPhase4StorageMode?.() || 'off') !== 'indexeddb_primary') return false;
    const mirrorRaw = safeGet(core.STORAGE_KEY);
    if (cacheMatchesMirror(cache(), mirrorRaw)) {
      writeDiagnostics({ effectiveSource: 'indexedDB_ready', lastFallbackReason: null });
      return true;
    }
    if (restoreSessionCache() && cacheMatchesMirror(cache(), safeGet(core.STORAGE_KEY))) return true;
    if (warmupPromise) return warmupPromise;

    let restoreFailureReason = null;
    warmupPromise = Promise.resolve()
      .then(() => core.restorePhase4CommittedPrimary?.({ reason }))
      .then((outcome) => {
        if (outcome?.restored === true && cacheMatchesMirror(cache(), safeGet(core.STORAGE_KEY))) return true;
        restoreFailureReason = outcome?.reason || null;
        return Promise.resolve(core.queuePhase4PrimaryWrite?.({ reason }))
          .then(() => core.flushPhase4PrimaryWrites?.())
          .then(() => cacheMatchesMirror(cache(), safeGet(core.STORAGE_KEY)));
      })
      .then((ready) => {
        const currentStatus = core.getPhase4StorageStatus?.() || {};
        const specificFailure = currentStatus.lastFallbackReason && currentStatus.lastFallbackReason !== 'cache_not_ready'
          ? currentStatus.lastFallbackReason
          : restoreFailureReason;
        writeDiagnostics({
          effectiveSource: ready ? 'indexedDB_ready' : 'localStorage',
          lastFallbackReason: ready ? null : (specificFailure || 'cache_warmup_failed'),
          cacheWarmupFailureDetail: ready ? null : (specificFailure || 'cache_warmup_failed')
        });
        return ready;
      })
      .catch((error) => {
        const currentStatus = core.getPhase4StorageStatus?.() || {};
        const specificFailure = currentStatus.lastFallbackReason || restoreFailureReason || error?.message || 'cache_warmup_failed';
        writeDiagnostics({
          effectiveSource: 'localStorage',
          lastFallbackReason: specificFailure,
          cacheWarmupFailureDetail: specificFailure
        });
        return false;
      })
      .finally(() => { warmupPromise = null; });
    return warmupPromise;
  }
  function schedulePrimaryWarmup(reason = 'cache_not_ready') {
    if ((core.getPhase4StorageMode?.() || 'off') !== 'indexeddb_primary' || warmupScheduled || warmupPromise) return;
    if (global.document?.visibilityState === 'hidden') return;""")
replace_once('phase4_primary_read_path.js',
"""  global.addEventListener?.('pageshow', () => {
    if ((core.getPhase4StorageMode?.() || 'off') !== 'indexeddb_primary') return;
    if (!cacheMatchesMirror(cache(), safeGet(core.STORAGE_KEY)) && !restoreSessionCache()) {
      schedulePrimaryWarmup('pageshow');
    }
  });

  if ((core.getPhase4StorageMode?.() || 'off') === 'indexeddb_primary') {""",
"""  global.addEventListener?.('pageshow', () => {
    if ((core.getPhase4StorageMode?.() || 'off') !== 'indexeddb_primary') return;
    if (!cacheMatchesMirror(cache(), safeGet(core.STORAGE_KEY)) && !restoreSessionCache()) {
      schedulePrimaryWarmup('pageshow');
    }
  });
  global.document?.addEventListener?.('visibilitychange', () => {
    if (global.document.visibilityState !== 'visible') return;
    if ((core.getPhase4StorageMode?.() || 'off') !== 'indexeddb_primary') return;
    if (!cacheMatchesMirror(cache(), safeGet(core.STORAGE_KEY)) && !restoreSessionCache()) {
      schedulePrimaryWarmup('visibility_restored');
    }
  });

  if ((core.getPhase4StorageMode?.() || 'off') === 'indexeddb_primary') {""")

# Cache guard: one recovery write per page instead of a retry storm.
replace_once('phase4_cache_guard.js',
"""      const queued = core.queuePhase4PrimaryWrite?.({ reason: 'cross_page_habit_journal_recovery' });
      Promise.resolve(queued).finally(() => {
        if (recoveryChecks < RECOVERY_MAX_CHECKS && hasDeferredGap()) scheduleRecovery(RECOVERY_SETTLE_MS);
      });""",
"""      const queued = core.queuePhase4PrimaryWrite?.({ reason: 'cross_page_habit_journal_recovery' });
      Promise.resolve(queued).finally(() => stopRecovery());""")

# Status page: visible confirmation even when verification finishes instantly.
replace_once('phase4_storage_status.html',
"""    function render(){
      const status = getStatus();""",
"""    function wait(ms){ return new Promise((resolve) => setTimeout(resolve, ms)); }
    function isHealthy(status){
      if (status.configuredMode === 'off') return Number(status.pendingWrites || 0) === 0;
      const sequencesMatch = Number(status.latestQueuedSequence || 0) === Number(status.latestPassedSequence || 0);
      if (status.configuredMode === 'verify_primary_writes') return sequencesMatch && Number(status.pendingWrites || 0) === 0 && !status.lastFallbackReason;
      return sequencesMatch
        && Number(status.pendingWrites || 0) === 0
        && !status.lastFallbackReason
        && status.cacheReadyThisPage === true
        && status.currentMirrorMatchesCache === true
        && ['indexedDB_ready','indexedDB'].includes(status.effectiveSource);
    }
    function render(){
      const status = getStatus();""")
replace_once('phase4_storage_status.html',
"""      try { await recoverStatus('manual_status_refresh'); }
      finally { button.disabled = false; button.textContent = originalText; }""",
"""      const startedAt = Date.now();
      try {
        const status = await recoverStatus('manual_status_refresh');
        await wait(Math.max(0, 350 - (Date.now() - startedAt)));
        button.textContent = isHealthy(status) ? 'Verified ✓' : 'Needs attention';
        await wait(900);
      } finally { button.disabled = false; button.textContent = originalText; }""")

# Warmup harness: committed restore must run before a rewrite.
replace_once('tests/phase4_primary_cache_warmup_contract.test.js',
"""async function install({ mode = 'indexeddb_primary', sessionRecord = null } = {}) {""",
"""async function install({ mode = 'indexeddb_primary', sessionRecord = null, committedRecord = null, restoreFailure = null } = {}) {""")
replace_once('tests/phase4_primary_cache_warmup_contract.test.js',
"""  let currentCache = null;
  let queueCalls = 0;""",
"""  let currentCache = null;
  let queueCalls = 0;
  let restoreCalls = 0;""")
replace_once('tests/phase4_primary_cache_warmup_contract.test.js',
"""    clearPhase4Caches() { currentCache = null; sessionStorage.removeItem(SESSION_KEY); return true; },
    queuePhase4PrimaryWrite() {""",
"""    clearPhase4Caches() { currentCache = null; sessionStorage.removeItem(SESSION_KEY); return true; },
    async restorePhase4CommittedPrimary() {
      restoreCalls += 1;
      if (!committedRecord) return { restored: false, reason: restoreFailure || 'primary_commit_missing' };
      currentCache = committedRecord;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(currentCache));
      return { restored: true, cache: currentCache };
    },
    queuePhase4PrimaryWrite() {""")
replace_once('tests/phase4_primary_cache_warmup_contract.test.js',
"""  return { core, localStorage, sessionStorage, mirrorRaw, state, drain, queueCalls: () => queueCalls };
}""",
"""  return { core, localStorage, sessionStorage, mirrorRaw, state, drain, queueCalls: () => queueCalls, restoreCalls: () => restoreCalls };
}""")
replace_once('tests/phase4_primary_cache_warmup_contract.test.js',
"""test('a cold IndexedDB Primary page schedules one verified cache warmup', async () => {""",
"""test('a cold IndexedDB Primary page restores the committed primary before rewriting', async () => {
  const state = fixture(1);
  const mirrorRaw = JSON.stringify(state);
  const harness = await install({ committedRecord: cacheRecord(state, mirrorRaw, 9) });
  await harness.drain();
  assert.equal(harness.restoreCalls(), 1);
  assert.equal(harness.queueCalls(), 0);
  assert.equal(harness.core.getPhase4StorageStatus().cacheReadyThisPage, true);
  assert.equal(harness.core.getPhase4StorageStatus().effectiveSource, 'indexedDB_ready');
});

test('a cold IndexedDB Primary page schedules one verified cache warmup when no committed primary can be restored', async () => {""")
replace_once('tests/phase4_primary_cache_warmup_contract.test.js',
"""  assert.match(html, /Checking…/);
});""",
"""  assert.match(html, /Checking…/);
  assert.match(html, /Verified ✓/);
});""")

# Storage coordinator contract for actual read-only committed restore.
replace_once('tests/phase4_storage_contract.test.js',
"""    'getPhase4StorageStatus', 'clearPhase4Caches'
  ]) {""",
"""    'getPhase4StorageStatus', 'clearPhase4Caches', 'restorePhase4CommittedPrimary'
  ]) {""")
replace_once('tests/phase4_storage_contract.test.js',
"""test('rapid saves commit only the newest valid sequence as primary', async () => {""",
"""test('a cold page restores and re-verifies the committed primary without rewriting it', async () => {
  const harness = await install({ mode: 'indexeddb_primary' });
  const state = fixture(16);
  harness.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  await harness.core.flushPhase4PrimaryWrites();
  const commitBefore = await getRow(harness.db, 'metadata', 'phase4_primary_commit');
  harness.core.clearPhase4Caches();
  assert.equal(harness.core.getPhase4StorageStatus().cacheReadyThisPage, false);

  const restored = await harness.core.restorePhase4CommittedPrimary({ indexedDB: harness.indexedDB });
  const commitAfter = await getRow(harness.db, 'metadata', 'phase4_primary_commit');
  const status = harness.core.getPhase4StorageStatus();
  assert.equal(restored.restored, true, JSON.stringify(restored));
  assert.equal(status.cacheReadyThisPage, true);
  assert.equal(status.currentMirrorMatchesCache, true);
  assert.equal(status.latestQueuedSequence, status.latestPassedSequence);
  assert.deepEqual(commitAfter, commitBefore);
});

test('rapid saves commit only the newest valid sequence as primary', async () => {""")

# Cache guard contract: failed recovery must not loop dozens of times.
replace_once('tests/phase4_journal_recovery_contract.test.js',
"""function install({ mode = 'verify_primary_writes', journal = [{}], gap = true, autoCompact = true } = {}) {""",
"""function install({ mode = 'verify_primary_writes', journal = [{}], gap = true, autoCompact = true, recoverySucceeds = true } = {}) {""")
replace_once('tests/phase4_journal_recovery_contract.test.js',
"""    queuePhase4PrimaryWrite() {
      queueCalls += 1;
      status.latestQueuedSequence = 23;
      status.latestPassedSequence = 23;
      status.lastFallbackReason = null;
      return Promise.resolve();
    }""",
"""    queuePhase4PrimaryWrite() {
      queueCalls += 1;
      status.latestQueuedSequence = 23;
      if (recoverySucceeds) {
        status.latestPassedSequence = 23;
        status.lastFallbackReason = null;
      }
      return Promise.resolve();
    }""")
replace_once('tests/phase4_journal_recovery_contract.test.js',
"""test('off mode performs no recovery work', async () => {""",
"""test('a failed recovery attempt does not create a retry storm', async () => {
  const harness = install({ journal: [], recoverySucceeds: false });
  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.equal(harness.queueCalls(), 1);
});

test('off mode performs no recovery work', async () => {""")
