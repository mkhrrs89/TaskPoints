(function installTaskPointsStateRuntimeV2SerializationGuard(global) {
  'use strict';

  const runtime = global?.TaskPointsStateRuntimeV2;
  if (!global || !runtime || global.TaskPointsStateRuntimeV2SerializationGuard?.installed) return;

  const methods = [
    ['applyHabitDelta', 'completion'],
    ['applyHabitOrderOverlay', 'order'],
    ['applyHabitEditSnapshot', 'edit'],
    ['applyHabitPresenceSnapshot', 'presence']
  ];

  let tail = Promise.resolve();
  let queued = 0;
  let completed = 0;
  let deduped = 0;
  let uncacheableRequests = 0;
  let failures = 0;
  let maxQueueDepth = 0;
  let requestSequence = 0;
  let lastKind = null;
  let lastError = null;
  const inFlight = new Map();
  const recent = new Map();
  const RECENT_MS = 3000;

  function mark(name, detail = {}) {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
  }

  // Deduplication is only safe when BOTH the payload and every operation
  // option are identical. In particular, verified WAL replay must never
  // reuse a normal mirror result (or vice versa).
  // Non-JSON-safe inputs cannot be compared reliably: serialize them in
  // order, but never suppress one as a presumed duplicate.
  function stableKey(kind, args) {
    try {
      const serialized = JSON.stringify([
        kind, args?.[0] ?? null, args?.[1] ?? null
      ], (_field, value) => {
        if (typeof value === 'function' || typeof value === 'symbol' ||
            typeof value === 'bigint' || typeof value === 'undefined' ||
            (typeof value === 'number' && !Number.isFinite(value))) {
          throw new Error('state_v2_uncacheable_serialization');
        }
        return value;
      });
      return typeof serialized === 'string' ? serialized : null;
    } catch (_) { return null; }
  }

  function pruneRecent(now = Date.now()) {
    for (const [key, row] of recent) {
      if (!row || row.expiresAt <= now) recent.delete(key);
    }
  }

  function isAdjacent(sequence, currentSequence) {
    return Number(sequence) === Number(currentSequence) - 1;
  }

  function wrap(name, kind) {
    const original = runtime[name];
    if (typeof original !== 'function' || original.__taskPointsV2Serialized) return false;

    const wrapped = function taskPointsV2SerializedMutation() {
      const args = Array.from(arguments);
      const key = stableKey(kind, args);
      const now = Date.now();
      const sequence = ++requestSequence;
      pruneRecent(now);
      if (key === null) {
        uncacheableRequests += 1;
        mark('stateV2.serializationUncacheable', { kind, sequence });
      }

      const active = key === null ? null : inFlight.get(key);
      if (active && isAdjacent(active.sequence, sequence)) {
        active.sequence = sequence;
        deduped += 1;
        mark('stateV2.serializationDeduped', { kind, phase: 'inflight', adjacent: true, sequence });
        return active.promise;
      }

      const cached = key === null ? null : recent.get(key);
      if (cached && cached.expiresAt > now && isAdjacent(cached.sequence, sequence)) {
        cached.sequence = sequence;
        deduped += 1;
        mark('stateV2.serializationDeduped', { kind, phase: 'recent', adjacent: true, sequence });
        return Promise.resolve(cached.result);
      }

      queued += 1;
      const queueDepth = inFlight.size + 1;
      maxQueueDepth = Math.max(maxQueueDepth, queueDepth);
      lastKind = kind;

      const entry = { promise: null, sequence };
      const run = tail.then(async () => {
        mark('stateV2.serializationStarted', { kind, queued: inFlight.size, sequence: entry.sequence });
        try {
          const result = await original.apply(this, args);
          completed += 1;
          // A refusal/no-op is not a durable acknowledgement and must never
          // stop an immediately repeated attempt from reaching the runtime.
          if (key !== null && result?.committed === true) {
            recent.set(key, { result, expiresAt: Date.now() + RECENT_MS, sequence: entry.sequence });
          }
          return result;
        } catch (error) {
          failures += 1;
          lastError = String(error?.code || error?.message || error);
          throw error;
        }
      });

      entry.promise = run;
      if (key !== null) inFlight.set(key, entry);
      tail = run.catch(() => undefined);
      run.finally(() => {
        if (key !== null && inFlight.get(key) === entry) inFlight.delete(key);
      }).catch(() => undefined);
      return run;
    };

    Object.defineProperties(wrapped, {
      __taskPointsV2Serialized: { value: true },
      __taskPointsOriginal: { value: original }
    });
    runtime[name] = wrapped;
    return true;
  }

  const wrappedMethods = methods.filter(([name, kind]) => wrap(name, kind)).map(([name]) => name);

  const api = {
    installed: true,
    version: 2,
    getStatus() {
      return {
        installed: true,
        wrappedMethods: wrappedMethods.slice(),
        queued,
        completed,
        deduped,
        uncacheableRequests,
        failures,
        active: inFlight.size,
        maxQueueDepth,
        requestSequence,
        lastKind,
        lastError
      };
    }
  };

  global.TaskPointsStateRuntimeV2SerializationGuard = api;
  mark('stateV2.serializationGuardInstalled', { wrappedMethods: wrappedMethods.length, version: api.version });
})(typeof window !== 'undefined' ? window : globalThis);
