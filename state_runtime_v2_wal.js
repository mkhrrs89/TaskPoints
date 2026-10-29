(function installTaskPointsStateRuntimeV2Wal(global) {
  'use strict';

  if (!global || global.TaskPointsStateRuntimeV2Wal?.__installedModule) return;

  const KEY = 'taskpoints_v2_pending_mutations_v1';
  // Independently durable event keys prevent concurrent tabs from
  // overwriting each other's rows in the legacy shared WAL array.
  const EVENT_PREFIX = 'taskpoints_v2_pending_mutation_event_v1:';
  // A unique, immutable claim is written FIRST on each new WAL admission.
  // The legacy per-ID event and shared WAL remain fully supported.
  const CLAIM_PREFIX = 'taskpoints_v2_pending_mutation_claim_v1:';
  const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
  const GENERATION_KEY = 'taskpoints_state_v2_generation_v1';
  const SCHEMA_VERSION = 1;
  const MAX_ROWS = 250;

  let appendCount = 0;
  let removeCount = 0;
  let malformedReads = 0;
  let lastError = null;

  function nowIso() { return new Date().toISOString(); }

  function safeGet(key) {
    try { return global.localStorage?.getItem?.(key) ?? null; }
    catch (error) { lastError = String(error?.message || error); return null; }
  }

  function safeSet(key, value) {
    try {
      global.localStorage?.setItem?.(key, String(value));
      return true;
    } catch (error) {
      lastError = String(error?.message || error);
      return false;
    }
  }

  function safeRemove(key) {
    try {
      global.localStorage?.removeItem?.(key);
      return true;
    } catch (error) {
      lastError = String(error?.message || error);
      return false;
    }
  }

  // A browser extension, storage shim, or quota transition may report
  // success without applying the write. Do not count a WAL row as durable,
  // or a confirmed row as cleared, until the same key reads back correctly.
  function setWalStorageVerified(key, value, code) {
    const text = String(value);
    if (!safeSet(key, text)) throw new Error(`${code}:${lastError || 'unknown'}`);
    const actual = readWalStorage(key);
    if (actual !== text) throw new Error(`${code}:unverified_write`);
    return true;
  }

  function removeWalStorageVerified(key, code) {
    if (!safeRemove(key)) throw new Error(`${code}:${lastError || 'unknown'}`);
    if (readWalStorage(key) !== null) throw new Error(`${code}:unverified_remove`);
    return true;
  }

  // WAL reads are safety-critical: a denied read is not an empty log. The
  // permissive safeGet helper is only suitable for optional mode/metadata
  // probes; mutation recovery and cleanup must fail closed on read errors.
  function readWalStorage(key) {
    const storage = global.localStorage;
    if (!storage || typeof storage.getItem !== 'function') {
      throw new Error('wal_storage_read_unavailable');
    }
    try { return storage.getItem(key); }
    catch (error) {
      throw new Error(`wal_storage_read_failed:${String(error?.message || error)}`);
    }
  }

  function isEnabled() {
    return safeGet(DARK_MODE_KEY) === '1';
  }

  function clone(value) {
    if (value == null) return value;
    if (typeof global.structuredClone === 'function') {
      try { return global.structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  }

  function newFallbackGeneration() {
    const random = global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `v2-wal:${random}`;
  }

  function ensureGeneration() {
    const generationApi = global.TaskPointsStateRuntimeV2Generation;
    if (typeof generationApi?.ensure === 'function') {
      const result = generationApi.ensure();
      if (result?.generation) return String(result.generation);
      // The generation authority was present but could not provide an epoch.
      // A separate WAL fallback must never manufacture one behind its back.
      throw new Error('state_runtime_v2_wal_generation_unavailable');
    }
    // The older standalone WAL fallback is still supported, but a denied
    // read cannot be treated as an empty generation key. Only a verified null
    // result authorizes creating a fresh fallback epoch.
    const existing = readWalStorage(GENERATION_KEY);
    if (existing) return String(existing);
    const generation = newFallbackGeneration();
    if (!safeSet(GENERATION_KEY, generation)) {
      throw new Error(`state_runtime_v2_wal_generation_write_failed:${lastError || 'unknown'}`);
    }
    return generation;
  }

  function cloneGeneration() {
    const generationApi = global.TaskPointsStateRuntimeV2Generation;
    if (typeof generationApi?.read === 'function') return generationApi.read();
    return readWalStorage(GENERATION_KEY);
  }

  function fnv1a(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function normalizeDelta(delta) {
    if (!delta || !delta.habitId || !delta.dayKey) throw new Error('state_runtime_v2_wal_invalid_habit_delta');
    return {
      ...clone(delta),
      id: delta.id || `${delta.source === 'vice' ? 'vice' : 'habit'}:${delta.habitId}:${delta.dayKey}`,
      habitId: String(delta.habitId),
      dayKey: String(delta.dayKey),
      source: delta.source === 'vice' ? 'vice' : 'habit',
      status: ['full', 'half', 'failed', 'off'].includes(delta.status)
        ? delta.status
        : (delta.done ? 'full' : (delta.failed ? 'failed' : 'off')),
      updatedAtISO: delta.updatedAtISO || delta.createdAtISO || nowIso()
    };
  }

  function mutationIdForDelta(deltaInput, generationInput = null) {
    const delta = normalizeDelta(deltaInput);
    const generation = String(generationInput || cloneGeneration() || ensureGeneration());
    const identity = stableJson({
      generation,
      id: delta.id,
      habitId: delta.habitId,
      dayKey: delta.dayKey,
      source: delta.source,
      status: delta.status,
      completionFraction: delta.completionFraction ?? null,
      completionPoints: delta.completionPoints ?? null,
      done: delta.done === true,
      failed: delta.failed === true,
      icy: delta.icy === true,
      updatedAtISO: delta.updatedAtISO || null,
      ...(delta.completedAtISO ? { completedAtISO: delta.completedAtISO } : {})
    });
    return `habit-delta:${fnv1a(identity)}:${identity.length}`;
  }

  function supportsIndependentRows() {
    return typeof global.localStorage?.key === 'function';
  }

  function independentKey(mutationId) {
    return EVENT_PREFIX + String(mutationId);
  }

  // One read-only pass enumerates BOTH types of independently recoverable
  // keys. Scanning the origin twice for every WAL read becomes expensive on
  // devices with large localStorage. Never cache this inventory across calls:
  // another tab may create a recovery claim between any two operations.
  function recoveryKeys() {
    const events = [];
    const claims = [];
    if (!supportsIndependentRows()) return { events, claims };
    const storage = global.localStorage;
    // A tab can add/remove keys while this tab is scanning the origin.
    // A moving index must not masquerade as a complete recovery inventory:
    // preserve all evidence and retry on the next read instead.
    const expectedLength = storage.length;
    const seen = new Set();
    for (let i = 0; i < expectedLength; i += 1) {
      const key = storage.key(i);
      if (typeof key !== 'string')
        throw new Error('wal_storage_inventory_missing_key');
      if (seen.has(key))
        throw new Error('wal_storage_inventory_duplicate_key');
      seen.add(key);
      if (key.startsWith(EVENT_PREFIX)) events.push(key);
      else if (key.startsWith(CLAIM_PREFIX)) claims.push(key);
    }
    if (storage.length !== expectedLength)
      throw new Error('wal_storage_inventory_changed');
    events.sort();
    claims.sort();
    return { events, claims };
  }

  function independentKeys() { return recoveryKeys().events; }

  function uniqueClaimKey() {
    // Random UUIDs prevent different tabs with colliding short mutation IDs
    // from ever writing to the same admission key.
    return CLAIM_PREFIX + (global.crypto?.randomUUID?.()
      || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  function claimKeys() { return recoveryKeys().claims; }

  function validateRow(row) {
    return row && typeof row === 'object' && typeof row.id === 'string'
      && row.delta && typeof row.generation === 'string';
  }

  function read() {
    let raw = null;
    try {
      raw = readWalStorage(KEY);
      const parsed = raw == null || raw === '' ? [] : JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('wal_root_not_array');
      if (!parsed.every(validateRow)) throw new Error('wal_contains_invalid_rows');

      // Read both the established shared WAL and every independently durable
      // row. An overlapping stale shared-key write must never erase a
      // different tab's mutation from the recoverable WAL.
      const merged = new Map();
      for (const row of parsed) {
        const previous = merged.get(row.id);
        // Older shared-array writes can contain more than one row with the
        // same short FNV mutation ID. Never silently prefer the last entry
        // when its generation or full delta differs.
        if (previous && (previous.generation !== row.generation
          || stableJson(previous.delta) !== stableJson(row.delta)
          || previous.type !== row.type)) {
          throw new Error('wal_shared_duplicate_identity_conflict');
        }
        merged.set(row.id, row);
      }
      // Count UNIQUE shared IDs before merging independent recovery rows.
      // A shared array with duplicate identical entries can otherwise appear
      // complete by length even while a different sidecar is absent.
      const sharedDistinctRowCount = merged.size;
      const inventory = recoveryKeys();
      for (const key of inventory.events) {
        const independentRaw = readWalStorage(key);
        if (independentRaw == null) continue; // concurrently confirmed/removed
        const row = JSON.parse(independentRaw);
        if (!validateRow(row) || independentKey(row.id) !== key) {
          throw new Error('wal_independent_row_invalid');
        }
        const old = merged.get(row.id);
        if (old && (old.generation !== row.generation
          || stableJson(old.delta) !== stableJson(row.delta)
          || old.type !== row.type)) {
          throw new Error('wal_shared_independent_identity_conflict');
        }
        merged.set(row.id, row);
      }
      // Each newly admitted write also has a unique recovery claim. Even if
      // concurrent tabs overwrite the old per-ID event and shared array, the
      // original claim remains independently recoverable and conflicts fail
      // closed instead of accepting a different mutation's acknowledgement.
      for (const key of inventory.claims) {
        const claimRaw = readWalStorage(key);
        if (claimRaw == null) continue; // another tab finished cleanup
        const row = JSON.parse(claimRaw);
        if (!validateRow(row) || row.type !== 'habit-completion-set'
          || mutationIdForDelta(row.delta, row.generation) !== row.id) {
          throw new Error('wal_admission_claim_invalid');
        }
        const existing = merged.get(row.id);
        if (existing && (existing.generation !== row.generation
          || existing.type !== row.type
          || stableJson(existing.delta) !== stableJson(row.delta))) {
          throw new Error('wal_admission_claim_identity_conflict');
        }
        merged.set(row.id, row);
      }
      const rows = [...merged.values()].sort((a, b) =>
        String(a.delta.updatedAtISO || '').localeCompare(String(b.delta.updatedAtISO || ''))
        || String(a.createdAtISO || '').localeCompare(String(b.createdAtISO || ''))
        || a.id.localeCompare(b.id));
      // The validated shared array is complete iff it contains exactly the
      // merged distinct IDs. This enables a cheap append without re-serializing
      // every older row; missing sidecar/claim rows require full reconciliation.
      return { ok: true, rows: clone(rows), raw: raw ?? null,
        sharedComplete: parsed.length === merged.size
          && sharedDistinctRowCount === parsed.length,
        sharedRowCount: parsed.length };
    } catch (error) {
      malformedReads += 1;
      lastError = `state_runtime_v2_wal_malformed:${String(error?.message || error)}`;
      return { ok: false, rows: [], raw: raw ?? null, error: lastError };
    }
  }

  function writeRows(rows) {
    const text = JSON.stringify(rows);
    setWalStorageVerified(KEY, text, 'state_runtime_v2_wal_write_failed');
    return true;
  }

  function appendHabitDelta(deltaInput, options = {}) {
    if (!isEnabled()) return { written: false, reason: 'dark_disabled' };
    const delta = normalizeDelta(deltaInput);
    const generation = String(options.generation || ensureGeneration());
    const computedMutationId = mutationIdForDelta(delta, generation);
    const mutationId = options.mutationId == null
      ? computedMutationId : String(options.mutationId);
    // An explicit ID override must not pretend that changed identity fields
    // represent an earlier durable Habit action.
    if (mutationId !== computedMutationId)
      throw new Error('state_runtime_v2_wal_mutation_id_mismatch');
    const current = read();
    if (!current.ok) throw new Error(current.error || 'state_runtime_v2_wal_unreadable');
    const existing = current.rows.find(row => row.id === mutationId);
    if (existing) {
      // IDs are short hashes. Metadata outside the ID calculation can differ
      // even for an identical hash: never count that as a durable duplicate
      // or rewrite either the shared log or the independent recovery row.
      if (existing.generation !== generation
        || existing.type !== 'habit-completion-set'
        || stableJson(existing.delta) !== stableJson(delta)) {
        throw new Error('state_runtime_v2_wal_duplicate_payload_conflict');
      }
      // Upgrade a pending row written before independent WAL keys existed.
      if (supportsIndependentRows() && readWalStorage(independentKey(mutationId)) == null) {
        setWalStorageVerified(independentKey(mutationId), JSON.stringify(existing),
          'state_runtime_v2_wal_independent_write_failed');
      }
      return { written: false, duplicate: true, mutationId, generation, row: clone(existing) };
    }

    const row = {
      id: mutationId,
      schemaVersion: SCHEMA_VERSION,
      type: 'habit-completion-set',
      generation,
      createdAtISO: nowIso(),
      delta: clone(delta)
    };
    const next = [...current.rows, row];
    if (next.length > MAX_ROWS) throw new Error('state_runtime_v2_wal_capacity_exceeded');
    // Unique claim FIRST. Old tabs and parallel new tabs can still overwrite
    // the legacy per-ID event; they cannot overwrite this UUID-addressed row.
    // If a later step fails, keep the claim for safe startup recovery.
    if (supportsIndependentRows()) {
      setWalStorageVerified(uniqueClaimKey(), JSON.stringify(row),
        'state_runtime_v2_wal_claim_write_failed');
      const existingSidecar = readWalStorage(independentKey(mutationId));
      if (existingSidecar !== null) {
        let prior;
        try { prior = JSON.parse(existingSidecar); } catch (_) {}
        if (!validateRow(prior) || prior.generation !== generation
          || prior.type !== row.type
          || stableJson(prior.delta) !== stableJson(delta)) {
          throw new Error('state_runtime_v2_wal_admission_sidecar_conflict');
        }
      } else {
        setWalStorageVerified(independentKey(mutationId), JSON.stringify(row),
          'state_runtime_v2_wal_independent_write_failed');
      }
    }
    // A concurrent tab may have updated the shared array since admission
    // began. The claim and sidecar are already independently durable; refuse
    // an obsolete shared write rather than overwrite that newer evidence.
    if (readWalStorage(KEY) !== current.raw)
      throw new Error('state_runtime_v2_wal_append_shared_changed');
    if (current.sharedComplete && current.raw !== null && current.raw !== '') {
      // The JSON parser validated the raw array. Insert only the new row
      // before its final closing bracket, preserving every older byte/order.
      // localStorage still persists the complete value; this avoids a second
      // JSON.stringify over the entire pending WAL on each admission.
      const closing = current.raw.lastIndexOf(']');
      const text = current.raw.slice(0, closing)
        + (current.sharedRowCount > 0 ? ',' : '')
        + JSON.stringify(row) + current.raw.slice(closing);
      setWalStorageVerified(KEY, text, 'state_runtime_v2_wal_write_failed');
    } else {
      // Legacy shared data can lag the independently recoverable entries.
      // Rebuild from the verified union so no older sidecar/claim disappears.
      writeRows(next);
    }
    appendCount += 1;
    try { global.TaskPointsPerf?.mark?.('stateV2.walAppended', { mutationId, generation, habitId: delta.habitId, dayKey: delta.dayKey }); } catch (_) {}
    return { written: true, duplicate: false, mutationId, generation, row: clone(row) };
  }

  function removeMutation(mutationId, expected = null) {
    if (!mutationId) return { removed: false, reason: 'missing_mutation_id' };
    const id = String(mutationId);
    // The WAL recovery bridge always supplies the exact payload it verified
    // in the actual V2 ledger. Keep the older one-argument helper available
    // for existing diagnostic and manual recovery callers.
    let verifiedIdentity = null;
    if (expected !== null) {
      if (!expected || !expected.delta || !expected.generation)
        throw new Error('state_runtime_v2_wal_cleanup_identity_required');
      verifiedIdentity = {
        generation: String(expected.generation),
        delta: normalizeDelta(expected.delta)
      };
      if (mutationIdForDelta(verifiedIdentity.delta, verifiedIdentity.generation) !== id)
        throw new Error('state_runtime_v2_wal_cleanup_identity_mismatch');
    }
    const current = read();
    if (!current.ok) throw new Error(current.error || 'state_runtime_v2_wal_unreadable');
    const target = current.rows.find(row => row.id === id);
    if (target && verifiedIdentity
      && (target.generation !== verifiedIdentity.generation
        || target.type !== 'habit-completion-set'
        || stableJson(target.delta) !== stableJson(verifiedIdentity.delta))) {
      throw new Error('state_runtime_v2_wal_cleanup_payload_changed');
    }

    // A second read detects another tab changing the shared array after the
    // inventory snapshot. Never rewrite that newer array from a stale copy.
    if (readWalStorage(KEY) !== current.raw)
      throw new Error('state_runtime_v2_wal_cleanup_shared_changed');
    const sidecarKey = independentKey(id);
    const hasSidecars = supportsIndependentRows();
    const originalSidecar = hasSidecars ? readWalStorage(sidecarKey) : null;
    if (originalSidecar !== null) {
      let sidecar;
      try { sidecar = JSON.parse(originalSidecar); }
      catch (_) { throw new Error('state_runtime_v2_wal_cleanup_sidecar_changed'); }
      if (!target || !validateRow(sidecar) || sidecar.id !== id
        || sidecar.generation !== target.generation
        || sidecar.type !== target.type
        || stableJson(sidecar.delta) !== stableJson(target.delta)) {
        throw new Error('state_runtime_v2_wal_cleanup_sidecar_changed');
      }
    }
    if (!target) return { removed: false, reason: 'not_found', mutationId: id };

    const next = current.rows.filter(row => row.id !== id);
    // Collect immutable matching claims before any destructive mutation.
    // A concurrently added claim after enumeration will remain recoverable.
    const claimsToClear = [];
    for (const key of claimKeys()) {
      const raw = readWalStorage(key);
      if (raw == null) continue;
      let claim;
      try { claim = JSON.parse(raw); }
      catch (_) { throw new Error('state_runtime_v2_wal_cleanup_claim_changed'); }
      if (claim?.id !== id) continue;
      if (claim.generation !== target.generation
        || claim.type !== target.type
        || stableJson(claim.delta) !== stableJson(target.delta)) {
        throw new Error('state_runtime_v2_wal_cleanup_claim_changed');
      }
      claimsToClear.push({ key, raw });
    }
    // Another tab could update the shared key while the sidecar was being
    // inspected. Recheck it immediately before the destructive shared write.
    if (readWalStorage(KEY) !== current.raw)
      throw new Error('state_runtime_v2_wal_cleanup_shared_changed');
    if (next.length) writeRows(next);
    else removeWalStorageVerified(KEY, 'state_runtime_v2_wal_remove_failed');
    // The shared cleanup may run concurrently with an independent append.
    // Refuse to delete a replaced sidecar; it remains independently durable
    // even if the old shared entry was already removed.
    if (hasSidecars) {
      if (readWalStorage(sidecarKey) !== originalSidecar)
        throw new Error('state_runtime_v2_wal_cleanup_sidecar_changed');
      removeWalStorageVerified(sidecarKey,
        'state_runtime_v2_wal_independent_remove_failed');
      // Remove only claims whose bytes still match the verified snapshot.
      // A failed removal leaves independently recoverable evidence behind.
      for (const claim of claimsToClear) {
        if (readWalStorage(claim.key) !== claim.raw)
          throw new Error('state_runtime_v2_wal_cleanup_claim_changed');
        removeWalStorageVerified(claim.key,
          'state_runtime_v2_wal_claim_remove_failed');
      }
    }
    removeCount += 1;
    try { global.TaskPointsPerf?.mark?.('stateV2.walCleared', { mutationId: id }); } catch (_) {}
    return { removed: true, mutationId: id, remaining: next.length };
  }

  function getPendingRows() {
    const current = read();
    if (!current.ok) return current;
    return { ok: true, rows: current.rows };
  }

  function getStatus() {
    const current = read();
    let independentEventCount = null;
    let admissionClaimCount = null;
    let enumerationError = null;
    // Diagnostics must remain readable even when the browser denies access
    // to localStorage.length/key during a storage-security transition. Never
    // treat an incomplete WAL inventory as an empty healthy queue.
    try {
      if (supportsIndependentRows()) {
        const inventory = recoveryKeys();
        independentEventCount = inventory.events.length;
        admissionClaimCount = inventory.claims.length;
      }
    } catch (error) {
      enumerationError = `state_runtime_v2_wal_inventory_unreadable:${String(error?.message || error)}`;
      lastError = enumerationError;
    }
    let generation = null;
    let generationReadable = true;
    try { generation = cloneGeneration(); }
    catch (error) {
      generationReadable = false;
      lastError = String(error?.message || error);
    }
    // A pending mutation cannot be declared safely recoverable against an
    // unknown generation. Preserve every WAL row and report unknown counts.
    const readable = current.ok && !enumerationError && generationReadable;
    return {
      installed: true,
      enabled: isEnabled(),
      key: KEY,
      independentEventPrefix: EVENT_PREFIX,
      independentEventCount,
      admissionClaimCount,
      generationKey: GENERATION_KEY,
      generation,
      generationReadable,
      pendingCount: readable ? current.rows.length : null,
      malformed: !readable,
      appendCount,
      removeCount,
      malformedReads,
      lastError
    };
  }

  const api = {
    __installedModule: true,
    KEY,
    DARK_MODE_KEY,
    GENERATION_KEY,
    CLAIM_PREFIX,
    SCHEMA_VERSION,
    isEnabled,
    ensureGeneration,
    mutationIdForDelta,
    appendHabitDelta,
    removeMutation,
    getPendingRows,
    getStatus
  };

  global.TaskPointsStateRuntimeV2Wal = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
