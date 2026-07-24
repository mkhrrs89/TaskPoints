from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


# Extend the existing compressed session cache codec to cover the Phase 4 cache.
codec_path = Path('phase3_session_codec.js')
codec = codec_path.read_text(encoding='utf-8')
codec = replace_once(codec,
"""  const SESSION_CACHE_KEY = 'taskpoints_phase3_verified_session_cache_v1';
  const CODEC_ID = 'lz-string-utf16-v1';
""",
"""  const SESSION_CACHE_KEY = 'taskpoints_phase3_verified_session_cache_v1';
  const PHASE4_SESSION_CACHE_KEY = 'taskpoints_phase4_verified_primary_cache_v1';
  const MANAGED_SESSION_CACHE_KEYS = new Set([SESSION_CACHE_KEY, PHASE4_SESSION_CACHE_KEY]);
  const CODEC_ID = 'lz-string-utf16-v1';
""", 'codec constants')
codec = replace_once(codec,
"""  function invalidate(failure) {
    lastEnvelope = null;
    lastDecoded = null;
    try { rawRemove(storage, SESSION_CACHE_KEY); } catch (_) {}
""",
"""  function invalidate(key, failure) {
    lastEnvelope = null;
    lastDecoded = null;
    try { rawRemove(storage, key); } catch (_) {}
""", 'codec invalidate')
codec = replace_once(codec,
"""  function interceptedGet(target, key) {
    if (target !== storage || String(key) !== SESSION_CACHE_KEY) return rawGet(target, key);
    const envelope = rawGet(target, key);
""",
"""  function interceptedGet(target, key) {
    const normalizedKey = String(key);
    if (target !== storage || !MANAGED_SESSION_CACHE_KEYS.has(normalizedKey)) return rawGet(target, key);
    const envelope = rawGet(target, key);
""", 'codec get guard')
codec = replace_once(codec,
"""    } catch (error) {
      invalidate(error?.message || 'decode_failed');
      return null;
    }
  }

  function interceptedSet(target, key, value) {
    if (target !== storage || String(key) !== SESSION_CACHE_KEY) return rawSet(target, key, value);
""",
"""    } catch (error) {
      invalidate(normalizedKey, error?.message || 'decode_failed');
      return null;
    }
  }

  function interceptedSet(target, key, value) {
    const normalizedKey = String(key);
    if (target !== storage || !MANAGED_SESSION_CACHE_KEYS.has(normalizedKey)) return rawSet(target, key, value);
""", 'codec set guard')
codec = replace_once(codec,
"""    } catch (error) {
      invalidate(error?.message || 'compression_failed');
      throw error;
    }
""",
"""    } catch (error) {
      invalidate(normalizedKey, error?.message || 'compression_failed');
      throw error;
    }
""", 'codec encode failure')
codec = replace_once(codec,
"""    } catch (error) {
      invalidate(error?.name === 'QuotaExceededError' ? 'quota_exceeded' : 'storage_write_failed');
      throw error;
    }
""",
"""    } catch (error) {
      invalidate(normalizedKey, error?.name === 'QuotaExceededError' ? 'quota_exceeded' : 'storage_write_failed');
      throw error;
    }
""", 'codec storage failure')
codec = replace_once(codec,
"""    if (target === storage && String(key) === SESSION_CACHE_KEY) {
""",
"""    if (target === storage && MANAGED_SESSION_CACHE_KEYS.has(String(key))) {
""", 'codec remove guard')
codec = replace_once(codec,
"""  core.PHASE3_SESSION_CACHE_CODEC = CODEC_ID;
""",
"""  core.PHASE3_SESSION_CACHE_CODEC = CODEC_ID;
  core.PHASE4_SESSION_CACHE_KEY = PHASE4_SESSION_CACHE_KEY;
""", 'codec export')
codec_path.write_text(codec, encoding='utf-8')


# Persist every successfully verified Phase 4 cache into compressed sessionStorage.
coordinator_path = Path('phase4_storage_coordinator.js')
coordinator = coordinator_path.read_text(encoding='utf-8')
coordinator = replace_once(coordinator,
"""  const DIAGNOSTICS_KEY = 'taskpoints_phase4_diagnostics_v1';
  const MODES = ['off', 'verify_primary_writes', 'indexeddb_primary'];
""",
"""  const DIAGNOSTICS_KEY = 'taskpoints_phase4_diagnostics_v1';
  const SESSION_CACHE_KEY = 'taskpoints_phase4_verified_primary_cache_v1';
  const MODES = ['off', 'verify_primary_writes', 'indexeddb_primary'];
""", 'coordinator session constant')
coordinator = replace_once(coordinator,
"""  function isRetryableWriteReason(reason) {
    return RETRYABLE_WRITE_REASONS.has(String(reason || ''));
  }
  function readDiagnostics() {
""",
"""  function isRetryableWriteReason(reason) {
    return RETRYABLE_WRITE_REASONS.has(String(reason || ''));
  }
  function persistVerifiedPrimaryCache(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = {
      schemaVersion: 1,
      sequence: Number(value.sequence) || 0,
      state: value.state,
      serializedState: value.serializedState || JSON.stringify(value.state || {}),
      sourceHash: value.sourceHash || null,
      destinationHash: value.destinationHash || null,
      sourceCounts: value.sourceCounts || null,
      destinationCounts: value.destinationCounts || null,
      mirrorRaw: value.mirrorRaw ?? null,
      mirrorHash: value.mirrorHash || null,
      status: value.status || null,
      verifiedAt: value.verifiedAt || null
    };
    try {
      global.sessionStorage?.setItem?.(SESSION_CACHE_KEY, JSON.stringify(record));
      return true;
    } catch (_) {
      try { global.sessionStorage?.removeItem?.(SESSION_CACHE_KEY); } catch (_) {}
      return false;
    }
  }
  function readDiagnostics() {
""", 'coordinator persist helper')
coordinator = replace_once(coordinator,
"""    try { global.sessionStorage?.removeItem?.('taskpoints_phase4_verified_primary_cache_v1'); } catch (_) {}
""",
"""    try { global.sessionStorage?.removeItem?.(SESSION_CACHE_KEY); } catch (_) {}
""", 'coordinator clear cache key')
coordinator = replace_once(coordinator,
"""        verifiedAt: completionTime
      };
      return writeDiagnostics({
""",
"""        verifiedAt: completionTime
      };
      persistVerifiedPrimaryCache(verifiedPrimaryCache);
      return writeDiagnostics({
""", 'coordinator persist success')
coordinator = replace_once(coordinator,
"""  core.PHASE4_DIAGNOSTICS_KEY = DIAGNOSTICS_KEY;
  core.PHASE4_STORAGE_MODES = MODES.slice();
""",
"""  core.PHASE4_DIAGNOSTICS_KEY = DIAGNOSTICS_KEY;
  core.PHASE4_SESSION_CACHE_KEY = SESSION_CACHE_KEY;
  core.PHASE4_STORAGE_MODES = MODES.slice();
""", 'coordinator session export')
coordinator = replace_once(coordinator,
"""  core.getPhase4VerifiedPrimaryCache = () => verifiedPrimaryCache;
  core.setPhase4VerifiedPrimaryCache = (value) => { verifiedPrimaryCache = value || null; return verifiedPrimaryCache; };
""",
"""  core.getPhase4VerifiedPrimaryCache = () => verifiedPrimaryCache;
  core.persistPhase4VerifiedPrimaryCache = persistVerifiedPrimaryCache;
  core.setPhase4VerifiedPrimaryCache = (value, options = {}) => {
    verifiedPrimaryCache = value || null;
    if (!verifiedPrimaryCache) {
      if (options.clearSession !== false) {
        try { global.sessionStorage?.removeItem?.(SESSION_CACHE_KEY); } catch (_) {}
      }
    } else if (options.persist !== false) {
      persistVerifiedPrimaryCache(verifiedPrimaryCache);
    }
    return verifiedPrimaryCache;
  };
""", 'coordinator cache setter')
coordinator_path.write_text(coordinator, encoding='utf-8')


# Replace the read path with one that restores the verified cache synchronously
# and schedules a verified warmup when a cold page has no restorable session cache.
read_path = r'''(function installTaskPointsPhase4PrimaryReadPath(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__phase4PrimaryReadPathInstalled || typeof core.loadAppState !== 'function') return;
  core.__phase4PrimaryReadPathInstalled = true;

  const ORIGINAL_LOAD = core.loadAppState;
  const ORIGINAL_SET_MODE = core.setPhase4StorageMode;
  const ORIGINAL_GET_STATUS = core.getPhase4StorageStatus;
  const DIAGNOSTICS_KEY = core.PHASE4_DIAGNOSTICS_KEY || 'taskpoints_phase4_diagnostics_v1';
  const SESSION_CACHE_KEY = core.PHASE4_SESSION_CACHE_KEY || 'taskpoints_phase4_verified_primary_cache_v1';
  let servingPrimary = false;
  let warmupPromise = null;
  let warmupScheduled = false;

  function nowIso() { return new Date().toISOString(); }
  function safeGet(key) {
    try { return global.localStorage?.getItem?.(key) ?? null; } catch (_) { return null; }
  }
  function safeSessionGet() {
    try { return global.sessionStorage?.getItem?.(SESSION_CACHE_KEY) ?? null; } catch (_) { return null; }
  }
  function clearSessionCache() {
    try { global.sessionStorage?.removeItem?.(SESSION_CACHE_KEY); } catch (_) {}
  }
  function readDiagnostics() {
    try {
      const value = JSON.parse(safeGet(DIAGNOSTICS_KEY) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) { return {}; }
  }
  function writeDiagnostics(patch = {}) {
    const previous = readDiagnostics();
    const next = {
      schemaVersion: 1,
      phase: 'indexeddb_primary',
      configuredMode: core.getPhase4StorageMode?.() || 'off',
      effectiveSource: previous.effectiveSource || 'localStorage',
      indexedDbReadsTotal: Number(previous.indexedDbReadsTotal) || 0,
      fallbackReadsTotal: Number(previous.fallbackReadsTotal) || 0,
      ...previous,
      ...patch
    };
    try { global.localStorage?.setItem?.(DIAGNOSTICS_KEY, JSON.stringify(next)); } catch (_) {}
    return next;
  }
  function cache() { return core.getPhase4VerifiedPrimaryCache?.() || null; }
  function clearCache() {
    warmupScheduled = false;
    try { return core.clearPhase4Caches?.() ?? true; } catch (_) { clearSessionCache(); return true; }
  }
  function journalCount() {
    try { return Number(core.readPendingHabitDeltas?.().length) || 0; } catch (_) { return 1; }
  }
  function summariesMatch(mirrorState, primaryState, primaryCache) {
    try {
      const mirrorSummary = core.shadowSourceSummary(mirrorState);
      const primarySummary = core.shadowSourceSummary(primaryState);
      const mismatch = core.shadowVerificationMismatches(mirrorSummary, primarySummary) || [];
      return primaryCache?.status === 'passed_verification'
        && mirrorSummary.hashes.state === primarySummary.hashes.state
        && primaryCache.sourceHash === mirrorSummary.hashes.state
        && primaryCache.destinationHash === primarySummary.hashes.state
        && core.shadowCanonicalJson(primaryCache.sourceCounts) === core.shadowCanonicalJson(mirrorSummary.counts)
        && core.shadowCanonicalJson(primaryCache.destinationCounts) === core.shadowCanonicalJson(primarySummary.counts)
        && mismatch.length === 0
        && core.shadowCanonicalJson(mirrorState) === core.shadowCanonicalJson(primaryState);
    } catch (_) { return false; }
  }
  function cacheMatchesMirror(primaryCache, mirrorRaw) {
    if (!primaryCache || mirrorRaw === null || primaryCache.mirrorRaw !== mirrorRaw) return false;
    if ((Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0) return false;
    if ((Number(core.getPendingPhase4WriteCount?.()) || 0) > 0) return false;
    if (journalCount() > 0) return false;
    let mirrorState;
    try { mirrorState = core.parseTaskPointsStorageJson(mirrorRaw, {}) || {}; } catch (_) { return false; }
    return summariesMatch(mirrorState, primaryCache.state || {}, primaryCache);
  }
  function validateSessionRecord(record, mirrorRaw) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    if (record.schemaVersion !== 1 || record.status !== 'passed_verification') return null;
    if (!record.state || typeof record.state !== 'object' || Array.isArray(record.state)) return null;
    if (!Number.isFinite(Number(record.sequence)) || Number(record.sequence) < 1) return null;
    const candidate = {
      ...record,
      sequence: Number(record.sequence),
      serializedState: typeof record.serializedState === 'string'
        ? record.serializedState
        : JSON.stringify(record.state),
      restoredFromSession: true
    };
    return cacheMatchesMirror(candidate, mirrorRaw) ? candidate : null;
  }
  function restoreSessionCache() {
    if ((core.getPhase4StorageMode?.() || 'off') !== 'indexeddb_primary') return false;
    const raw = safeSessionGet();
    if (raw === null) return false;
    let record = null;
    try { record = JSON.parse(raw); } catch (_) { record = null; }
    const restored = validateSessionRecord(record, safeGet(core.STORAGE_KEY));
    if (!restored) {
      clearCache();
      return false;
    }
    core.setPhase4VerifiedPrimaryCache?.(restored, { persist: false });
    writeDiagnostics({
      configuredMode: 'indexeddb_primary',
      effectiveSource: 'indexedDB_ready',
      lastFallbackReason: null,
      cacheRestoredFromSession: true
    });
    return true;
  }
  function recordFallback(reason) {
    const previous = readDiagnostics();
    writeDiagnostics({
      configuredMode: core.getPhase4StorageMode?.() || 'off',
      effectiveSource: 'localStorage',
      lastFallbackAt: nowIso(),
      lastFallbackReason: reason,
      fallbackReadsTotal: (Number(previous.fallbackReadsTotal) || 0) + 1
    });
  }

  async function warmPrimaryCache(reason = 'primary_cache_warmup') {
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
    if ((core.getPhase4StorageMode?.() || 'off') !== 'indexeddb_primary' || warmupScheduled || warmupPromise) return;
    warmupScheduled = true;
    const schedule = typeof global.queueMicrotask === 'function'
      ? global.queueMicrotask.bind(global)
      : (callback) => Promise.resolve().then(callback);
    schedule(() => {
      warmupScheduled = false;
      warmPrimaryCache(reason);
    });
  }

  function withTemporaryPrimary(expectedMirrorRaw, expectedJournalRaw, serializedState, callback) {
    const storage = global.localStorage;
    if (!storage || typeof storage.getItem !== 'function') {
      return { result: callback(), usedPrimary: false, mirrorChanged: true, journalChanged: true };
    }
    let usedPrimary = false;
    let mirrorChanged = false;
    let journalChanged = false;
    const substitute = (readLive, key) => {
      const normalized = String(key);
      if (normalized === core.STORAGE_KEY) {
        const live = readLive();
        if (live === expectedMirrorRaw) { usedPrimary = true; return serializedState; }
        mirrorChanged = true;
        return live;
      }
      if (normalized === core.PENDING_HABIT_DELTAS_KEY) {
        const live = readLive();
        if (live === expectedJournalRaw) return expectedJournalRaw;
        journalChanged = true;
        return null;
      }
      return readLive();
    };

    const StorageCtor = global.Storage;
    if (StorageCtor?.prototype?.getItem) {
      const prototype = StorageCtor.prototype;
      const original = prototype.getItem;
      prototype.getItem = function phase4PrimaryGetItem(key) {
        if (this !== global.localStorage) return original.call(this, key);
        return substitute(() => original.call(this, key), key);
      };
      try {
        const result = callback();
        return { result, usedPrimary, mirrorChanged, journalChanged };
      } finally { prototype.getItem = original; }
    }

    const original = storage.getItem;
    storage.getItem = function phase4PrimaryGetItem(key) {
      return substitute(() => original.call(storage, key), key);
    };
    try {
      const result = callback();
      return { result, usedPrimary, mirrorChanged, journalChanged };
    } finally { storage.getItem = original; }
  }

  function loadWithPolicy(args) {
    const mode = core.getPhase4StorageMode?.() || 'off';
    if (servingPrimary || mode !== 'indexeddb_primary') return ORIGINAL_LOAD.apply(core, args);

    const mirrorRaw = safeGet(core.STORAGE_KEY);
    if (mirrorRaw === null) {
      clearCache();
      recordFallback('authoritative_missing');
      return ORIGINAL_LOAD.apply(core, args);
    }
    if ((Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0) {
      recordFallback('dual_write_pending');
      return ORIGINAL_LOAD.apply(core, args);
    }
    if ((Number(core.getPendingPhase4WriteCount?.()) || 0) > 0) {
      recordFallback('phase4_write_pending');
      return ORIGINAL_LOAD.apply(core, args);
    }
    if (journalCount() > 0) {
      recordFallback('pending_habit_journal');
      return ORIGINAL_LOAD.apply(core, args);
    }

    const primaryCache = cache();
    if (!primaryCache) {
      recordFallback('cache_not_ready');
      schedulePrimaryWarmup('cache_not_ready');
      return ORIGINAL_LOAD.apply(core, args);
    }
    let mirrorState;
    try { mirrorState = core.parseTaskPointsStorageJson(mirrorRaw, {}) || {}; }
    catch (_) {
      clearCache();
      recordFallback('mirror_parse_failed');
      return ORIGINAL_LOAD.apply(core, args);
    }
    if (primaryCache.mirrorRaw !== mirrorRaw || !summariesMatch(mirrorState, primaryCache.state, primaryCache)) {
      clearCache();
      recordFallback('mirror_mismatch');
      schedulePrimaryWarmup('mirror_mismatch');
      return ORIGINAL_LOAD.apply(core, args);
    }

    const journalRaw = safeGet(core.PENDING_HABIT_DELTAS_KEY);
    servingPrimary = true;
    try {
      const originalOptions = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : null;
      const primaryOptions = originalOptions ? { ...originalOptions, persistSync: false } : { persistSync: false };
      const attempt = withTemporaryPrimary(
        mirrorRaw,
        journalRaw,
        primaryCache.serializedState || JSON.stringify(primaryCache.state || {}),
        () => ORIGINAL_LOAD.call(core, primaryOptions)
      );
      const mirrorAfter = safeGet(core.STORAGE_KEY);
      const journalAfter = safeGet(core.PENDING_HABIT_DELTAS_KEY);
      if (attempt.journalChanged || journalAfter !== journalRaw) {
        clearCache();
        recordFallback('journal_changed_during_primary_read');
        schedulePrimaryWarmup('journal_changed_during_primary_read');
        return ORIGINAL_LOAD.apply(core, args);
      }
      if (attempt.mirrorChanged || !attempt.usedPrimary || mirrorAfter !== mirrorRaw) {
        clearCache();
        recordFallback('mirror_changed_during_primary_read');
        schedulePrimaryWarmup('mirror_changed_during_primary_read');
        return ORIGINAL_LOAD.apply(core, args);
      }
      const previous = readDiagnostics();
      writeDiagnostics({
        configuredMode: mode,
        effectiveSource: 'indexedDB',
        lastIndexedDbReadAt: nowIso(),
        lastFallbackReason: null,
        indexedDbReadsTotal: (Number(previous.indexedDbReadsTotal) || 0) + 1
      });
      return attempt.result;
    } catch (_) {
      clearCache();
      recordFallback('primary_read_exception');
      schedulePrimaryWarmup('primary_read_exception');
      return ORIGINAL_LOAD.apply(core, args);
    } finally { servingPrimary = false; }
  }

  core.loadAppState = function phase4LoadAppState(...args) { return loadWithPolicy(args); };
  if (typeof ORIGINAL_GET_STATUS === 'function') {
    core.getPhase4StorageStatus = function phase4PrimaryGetStatus(...args) {
      const value = ORIGINAL_GET_STATUS.apply(core, args) || {};
      return {
        ...value,
        sessionCachePresent: safeSessionGet() !== null,
        cacheRestoredFromSession: Boolean(cache()?.restoredFromSession),
        cacheWarmupPending: Boolean(warmupPromise || warmupScheduled)
      };
    };
  }
  if (typeof ORIGINAL_SET_MODE === 'function') {
    core.setPhase4StorageMode = function phase4SetStorageMode(mode) {
      const next = ORIGINAL_SET_MODE.call(core, mode);
      if (next === 'off') {
        clearCache();
      } else if (next === 'indexeddb_primary') {
        const mirrorRaw = safeGet(core.STORAGE_KEY);
        if (cacheMatchesMirror(cache(), mirrorRaw)) {
          writeDiagnostics({ effectiveSource: 'indexedDB_ready', lastFallbackReason: null });
        } else if (!restoreSessionCache()) {
          schedulePrimaryWarmup('mode_changed');
        }
      }
      return next;
    };
  }

  core.restorePhase4PrimaryCache = restoreSessionCache;
  core.warmPhase4PrimaryCache = warmPrimaryCache;

  global.addEventListener?.('storage', (event) => {
    if (event?.storageArea && event.storageArea !== global.localStorage) return;
    if (![core.STORAGE_KEY, core.PENDING_HABIT_DELTAS_KEY, core.PHASE4_STORAGE_MODE_KEY].includes(event?.key)) return;
    clearCache();
    if ((core.getPhase4StorageMode?.() || 'off') === 'indexeddb_primary') schedulePrimaryWarmup('storage_changed');
  });
  global.addEventListener?.('pageshow', () => {
    if ((core.getPhase4StorageMode?.() || 'off') !== 'indexeddb_primary') return;
    if (!cacheMatchesMirror(cache(), safeGet(core.STORAGE_KEY)) && !restoreSessionCache()) {
      schedulePrimaryWarmup('pageshow');
    }
  });

  if ((core.getPhase4StorageMode?.() || 'off') === 'indexeddb_primary') {
    if (!restoreSessionCache()) schedulePrimaryWarmup('module_install');
  }
})(typeof window !== 'undefined' ? window : globalThis);
'''
Path('phase4_primary_read_path.js').write_text(read_path, encoding='utf-8')


# Make mode changes and Refresh explicitly warm a missing primary cache.
status_html = r'''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>TaskPoints — Phase 4 Storage</title>
  <link rel="stylesheet" href="assets/tailwind.css">
  <link rel="stylesheet" href="styles.css">
  <script src="scoring_core.js" defer></script>
  <style>
    body{background:#0a0a0a;color:#fafafa}.status-card{background:#18181b;border:1px solid #27272a;border-radius:18px;padding:18px}.status-row{display:flex;justify-content:space-between;gap:18px;padding:9px 0;border-bottom:1px solid #27272a}.status-row:last-child{border-bottom:0}.status-value{font-weight:800;text-align:right;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#101214;border-radius:14px;padding:14px;font-size:12px}
  </style>
</head>
<body class="min-h-screen">
  <main class="mx-auto max-w-3xl px-4 py-6">
    <div class="flex items-center justify-between gap-3 mb-5">
      <div><h1 class="text-2xl font-extrabold">Phase 4 Storage</h1><p class="text-sm opacity-70">IndexedDB-primary capability and rollback status</p></div>
      <a href="settings.html" class="btn btn-teal btn-toolbar">Settings</a>
    </div>

    <section class="status-card mb-4">
      <h2 class="text-lg font-bold mb-2">Mode</h2>
      <p class="text-sm opacity-75 mb-3">Phase 4 defaults to Off. Changing modes never deletes localStorage or images.</p>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn btn-teal btn-toolbar" data-mode="off">Off</button>
        <button type="button" class="btn btn-teal btn-toolbar" data-mode="verify_primary_writes">Verify Primary Writes</button>
        <button type="button" class="btn btn-teal btn-toolbar" data-mode="indexeddb_primary">IndexedDB Primary</button>
      </div>
    </section>

    <section class="status-card mb-4">
      <h2 class="text-lg font-bold mb-2">Current status</h2>
      <div id="summary"></div>
    </section>

    <section class="status-card">
      <div class="flex items-center justify-between gap-3 mb-3"><h2 class="text-lg font-bold">Diagnostics</h2><button id="refresh" type="button" class="btn btn-teal btn-toolbar">Refresh</button></div>
      <pre id="raw">Loading…</pre>
    </section>
  </main>
  <script>
    const summary = document.getElementById('summary');
    const raw = document.getElementById('raw');
    const fields = [
      ['Configured mode','configuredMode'],['Effective source','effectiveSource'],['Latest queued sequence','latestQueuedSequence'],['Latest passed sequence','latestPassedSequence'],['Pending writes','pendingWrites'],['Last verified','lastVerifiedAt'],['Last fallback','lastFallbackAt'],['Fallback reason','lastFallbackReason'],['Verification failures','verificationFailuresTotal'],['Deferred writes','deferredWritesTotal'],['Cache ready','cacheReadyThisPage'],['Mirror matches cache','currentMirrorMatchesCache'],['Session cache present','sessionCachePresent'],['Restored from session','cacheRestoredFromSession'],['Cache warmup pending','cacheWarmupPending'],['Reset tombstone','resetTombstone']
    ];
    function getStatus(){
      const core = window.TaskPointsCore;
      return core?.getPhase4StorageStatus?.() || { configuredMode:'off', effectiveSource:'localStorage', unavailable:true };
    }
    function render(){
      const status = getStatus();
      summary.innerHTML = fields.map(([label,key]) => `<div class="status-row"><span class="opacity-70">${label}</span><span class="status-value">${status[key] ?? '—'}</span></div>`).join('');
      raw.textContent = JSON.stringify(status,null,2);
      return status;
    }
    async function recoverStatus(reason){
      const core = window.TaskPointsCore;
      const status = getStatus();
      const primaryNeedsWarmup = status.configuredMode === 'indexeddb_primary' && (
        status.cacheReadyThisPage !== true
        || status.currentMirrorMatchesCache !== true
        || !['indexedDB_ready','indexedDB'].includes(status.effectiveSource)
      );
      const writeNeedsRecovery = status.configuredMode !== 'off' && (
        status.lastFallbackReason
        || Number(status.latestQueuedSequence || 0) > Number(status.latestPassedSequence || 0)
      );
      if (primaryNeedsWarmup && typeof core?.warmPhase4PrimaryCache === 'function') {
        await core.warmPhase4PrimaryCache(reason || 'manual_status_refresh');
      } else if (writeNeedsRecovery) {
        core?.resumePhase4DeferredWrite?.();
        core?.queuePhase4PrimaryWrite?.({ reason: reason || 'manual_status_refresh' });
        await core?.flushPhase4PrimaryWrites?.();
      }
      return render();
    }
    document.getElementById('refresh').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = 'Checking…';
      try { await recoverStatus('manual_status_refresh'); }
      finally { button.disabled = false; button.textContent = originalText; }
    });
    document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', async () => {
      const buttons = [...document.querySelectorAll('[data-mode]')];
      buttons.forEach((item) => { item.disabled = true; });
      const originalText = button.textContent;
      button.textContent = 'Switching…';
      try {
        window.TaskPointsCore?.setPhase4StorageMode?.(button.dataset.mode);
        if (button.dataset.mode === 'indexeddb_primary') await recoverStatus('indexeddb_primary_mode_enabled');
        else render();
      } finally {
        button.textContent = originalText;
        buttons.forEach((item) => { item.disabled = false; });
      }
    }));
    window.addEventListener('load', render);
  </script>
</body>
</html>
'''
Path('phase4_storage_status.html').write_text(status_html, encoding='utf-8')


# Add focused regression coverage for session restore, cold warmup, and controls.
test_source = r'''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const READ_PATH = path.join(__dirname, '..', 'phase4_primary_read_path.js');
const CODEC_PATH = path.join(__dirname, '..', 'phase3_session_codec.js');
const STATUS_PATH = path.join(__dirname, '..', 'phase4_storage_status.html');
const STORAGE_KEY = 'taskpoints_v1';
const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
const DIAGNOSTICS_KEY = 'taskpoints_phase4_diagnostics_v1';
const SESSION_KEY = 'taskpoints_phase4_verified_primary_cache_v1';

class FakeStorage {
  constructor(initial = {}) { this.rows = new Map(Object.entries(initial).map(([k,v]) => [String(k), String(v)])); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value) {
  const text = canonical(value);
  let result = 2166136261;
  for (let index = 0; index < text.length; index += 1) { result ^= text.charCodeAt(index); result = Math.imul(result, 16777619); }
  return `${(result >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}
function fixture(version = 1) {
  return { completions: [], matchups: [], gameHistory: [], seasonHistory: [], tasks: [{ id: `task-${version}` }], habits: [], players: [{ id: 'p1', imageId: 'img-1' }], settings: { version } };
}
function cacheRecord(state, mirrorRaw, sequence = 4) {
  const stateHash = hash(state);
  return {
    schemaVersion: 1, sequence, state, serializedState: JSON.stringify(state), sourceHash: stateHash,
    destinationHash: stateHash, sourceCounts: {}, destinationCounts: {}, mirrorRaw,
    mirrorHash: hash(mirrorRaw), status: 'passed_verification', verifiedAt: '2026-07-24T22:00:00.000Z'
  };
}
async function install({ mode = 'indexeddb_primary', sessionRecord = null } = {}) {
  const state = fixture(1);
  const mirrorRaw = JSON.stringify(state);
  const localStorage = new FakeStorage({ [STORAGE_KEY]: mirrorRaw, [MODE_KEY]: mode });
  const sessionStorage = new FakeStorage(sessionRecord ? { [SESSION_KEY]: JSON.stringify(sessionRecord) } : {});
  const listeners = new Map();
  const microtasks = [];
  let currentCache = null;
  let queueCalls = 0;
  const core = {
    STORAGE_KEY, PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY, PHASE4_STORAGE_MODE_KEY: MODE_KEY,
    PHASE4_DIAGNOSTICS_KEY: DIAGNOSTICS_KEY, PHASE4_SESSION_CACHE_KEY: SESSION_KEY,
    getPhase4StorageMode() { return localStorage.getItem(MODE_KEY) || 'off'; },
    setPhase4StorageMode(value) { localStorage.setItem(MODE_KEY, value); return value; },
    getPendingShadowDualWriteCount: () => 0,
    getPendingPhase4WriteCount: () => 0,
    readPendingHabitDeltas: () => [],
    parseTaskPointsStorageJson: (raw, fallback = {}) => raw ? JSON.parse(raw) : fallback,
    shadowCanonicalJson: canonical,
    shadowSourceSummary(value) { return { counts: {}, hashes: { state: hash(value) } }; },
    shadowVerificationMismatches(left, right) { return left.hashes.state === right.hashes.state ? [] : [{ type: 'state' }]; },
    getPhase4VerifiedPrimaryCache: () => currentCache,
    setPhase4VerifiedPrimaryCache(value) { currentCache = value || null; return currentCache; },
    clearPhase4Caches() { currentCache = null; sessionStorage.removeItem(SESSION_KEY); return true; },
    queuePhase4PrimaryWrite() {
      queueCalls += 1;
      currentCache = cacheRecord(state, mirrorRaw, queueCalls + 10);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(currentCache));
      return Promise.resolve();
    },
    flushPhase4PrimaryWrites: () => Promise.resolve(),
    getPhase4StorageStatus() {
      let diagnostics = {};
      try { diagnostics = JSON.parse(localStorage.getItem(DIAGNOSTICS_KEY) || '{}'); } catch (_) {}
      return { configuredMode: this.getPhase4StorageMode(), effectiveSource: diagnostics.effectiveSource || 'localStorage', cacheReadyThisPage: Boolean(currentCache), currentMirrorMatchesCache: Boolean(currentCache && currentCache.mirrorRaw === mirrorRaw) };
    },
    loadAppState(options = {}) {
      const raw = localStorage.getItem(STORAGE_KEY);
      localStorage.getItem(JOURNAL_KEY);
      return { state: raw ? JSON.parse(raw) : {}, options };
    }
  };
  const context = {
    TaskPointsCore: core, localStorage, sessionStorage, Storage: FakeStorage,
    addEventListener(type, callback) { const rows = listeners.get(type) || []; rows.push(callback); listeners.set(type, rows); },
    queueMicrotask(callback) { microtasks.push(callback); },
    structuredClone, JSON, Date, Math, Object, Array, String, Number, Boolean, Promise, Error, Set, Map, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(READ_PATH, 'utf8'), context, { filename: 'phase4_primary_read_path.js' });
  async function drain() {
    while (microtasks.length) microtasks.shift()();
    await Promise.resolve();
    await Promise.resolve();
  }
  return { core, localStorage, sessionStorage, mirrorRaw, state, drain, queueCalls: () => queueCalls };
}

test('Phase 4 restores a matching verified primary cache from compressed session storage semantics', async () => {
  const state = fixture(1);
  const mirrorRaw = JSON.stringify(state);
  const harness = await install({ sessionRecord: cacheRecord(state, mirrorRaw) });
  assert.equal(harness.core.getPhase4StorageStatus().cacheReadyThisPage, true);
  assert.equal(harness.core.getPhase4StorageStatus().cacheRestoredFromSession, true);
  assert.equal(harness.queueCalls(), 0);
  const result = harness.core.loadAppState({ persistSync: true });
  assert.equal(result.state.tasks[0].id, 'task-1');
  assert.equal(harness.core.getPhase4StorageStatus().effectiveSource, 'indexedDB');
});

test('a cold IndexedDB Primary page schedules one verified cache warmup', async () => {
  const harness = await install();
  assert.equal(harness.core.getPhase4StorageStatus().cacheReadyThisPage, false);
  await harness.drain();
  assert.equal(harness.queueCalls(), 1);
  assert.equal(harness.core.getPhase4StorageStatus().cacheReadyThisPage, true);
  assert.equal(harness.core.getPhase4StorageStatus().effectiveSource, 'indexedDB_ready');
});

test('switching from Off to IndexedDB Primary schedules cache warmup', async () => {
  const harness = await install({ mode: 'off' });
  harness.core.setPhase4StorageMode('indexeddb_primary');
  await harness.drain();
  assert.equal(harness.queueCalls(), 1);
  assert.equal(harness.core.getPhase4StorageStatus().cacheReadyThisPage, true);
});

test('the shared session codec manages the Phase 4 cache key', () => {
  const source = fs.readFileSync(CODEC_PATH, 'utf8');
  assert.match(source, /taskpoints_phase4_verified_primary_cache_v1/);
  assert.match(source, /MANAGED_SESSION_CACHE_KEYS/);
});

test('Phase 4 Refresh and mode selection explicitly warm a missing primary cache', () => {
  const html = fs.readFileSync(STATUS_PATH, 'utf8');
  assert.match(html, /warmPhase4PrimaryCache/);
  assert.match(html, /primaryNeedsWarmup/);
  assert.match(html, /indexeddb_primary_mode_enabled/);
  assert.match(html, /Checking…/);
});
'''
Path('tests/phase4_primary_cache_warmup_contract.test.js').write_text(test_source, encoding='utf-8')
