(function installTaskPointsStateRuntimeV2Wal(global) {
  'use strict';

  if (!global || global.TaskPointsStateRuntimeV2Wal?.__installedModule) return;

  const KEY = 'taskpoints_v2_pending_mutations_v1';
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
    }
    const existing = safeGet(GENERATION_KEY);
    if (existing) return String(existing);
    const generation = newFallbackGeneration();
    if (!safeSet(GENERATION_KEY, generation)) {
      throw new Error(`state_runtime_v2_wal_generation_write_failed:${lastError || 'unknown'}`);
    }
    return generation;
  }

  function cloneGeneration() {
    return global.TaskPointsStateRuntimeV2Generation?.read?.() || safeGet(GENERATION_KEY) || null;
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
      updatedAtISO: delta.updatedAtISO || null
    });
    return `habit-delta:${fnv1a(identity)}:${identity.length}`;
  }

  function read() {
    const raw = safeGet(KEY);
    if (raw == null || raw === '') return { ok: true, rows: [], raw: raw ?? null };
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('wal_root_not_array');
      const rows = parsed.filter((row) => row && typeof row === 'object' && typeof row.id === 'string' && row.delta);
      if (rows.length !== parsed.length) throw new Error('wal_contains_invalid_rows');
      return { ok: true, rows: clone(rows), raw };
    } catch (error) {
      malformedReads += 1;
      lastError = `state_runtime_v2_wal_malformed:${String(error?.message || error)}`;
      return { ok: false, rows: [], raw, error: lastError };
    }
  }

  function writeRows(rows) {
    const text = JSON.stringify(rows);
    if (!safeSet(KEY, text)) throw new Error(`state_runtime_v2_wal_write_failed:${lastError || 'unknown'}`);
    return true;
  }

  function appendHabitDelta(deltaInput, options = {}) {
    if (!isEnabled()) return { written: false, reason: 'dark_disabled' };
    const delta = normalizeDelta(deltaInput);
    const generation = String(options.generation || ensureGeneration());
    const mutationId = options.mutationId || mutationIdForDelta(delta, generation);
    const current = read();
    if (!current.ok) throw new Error(current.error || 'state_runtime_v2_wal_unreadable');
    const existing = current.rows.find((row) => row.id === mutationId && row.generation === generation);
    if (existing) return { written: false, duplicate: true, mutationId, generation, row: clone(existing) };

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
    writeRows(next);
    appendCount += 1;
    try { global.TaskPointsPerf?.mark?.('stateV2.walAppended', { mutationId, generation, habitId: delta.habitId, dayKey: delta.dayKey }); } catch (_) {}
    return { written: true, duplicate: false, mutationId, generation, row: clone(row) };
  }

  function removeMutation(mutationId) {
    if (!mutationId) return { removed: false, reason: 'missing_mutation_id' };
    const current = read();
    if (!current.ok) throw new Error(current.error || 'state_runtime_v2_wal_unreadable');
    const next = current.rows.filter((row) => row.id !== String(mutationId));
    if (next.length === current.rows.length) return { removed: false, reason: 'not_found', mutationId: String(mutationId) };
    if (next.length) writeRows(next);
    else if (!safeRemove(KEY)) throw new Error(`state_runtime_v2_wal_remove_failed:${lastError || 'unknown'}`);
    removeCount += 1;
    try { global.TaskPointsPerf?.mark?.('stateV2.walCleared', { mutationId: String(mutationId) }); } catch (_) {}
    return { removed: true, mutationId: String(mutationId), remaining: next.length };
  }

  function getPendingRows() {
    const current = read();
    if (!current.ok) return current;
    return { ok: true, rows: current.rows };
  }

  function getStatus() {
    const current = read();
    return {
      installed: true,
      enabled: isEnabled(),
      key: KEY,
      generationKey: GENERATION_KEY,
      generation: cloneGeneration(),
      pendingCount: current.ok ? current.rows.length : null,
      malformed: !current.ok,
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
