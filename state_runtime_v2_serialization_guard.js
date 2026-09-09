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
  let failures = 0;
  let maxQueueDepth = 0;
  let lastKind = null;
  let lastError = null;
  const inFlight = new Map();
  const recent = new Map();
  const RECENT_MS = 3000;

  function mark(name, detail = {}) {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
  }

  function stableKey(kind, args) {
    const payload = args?.[0] ?? null;
    const options = args?.[1] ?? null;
    let serialized;
    try {
      serialized = JSON.stringify([
        kind,
        options?.expectedGeneration || null,
        payload
      ]);
    } catch (_) {
      serialized = `${kind}:${String(payload?.id || payload?.habitId || '')}:${String(payload?.dayKey || payload?.updatedAtISO || '')}`;
    }
    return serialized;
  }

  function pruneRecent(now = Date.now()) {
    for (const [key, row] of recent) {
      if (!row || row.expiresAt <= now) recent.delete(key);
    }
  }

  function wrap(name, kind) {
    const original = runtime[name];
    if (typeof original !== 'function' || original.__taskPointsV2Serialized) return false;

    const wrapped = function taskPointsV2SerializedMutation() {
      const args = Array.from(arguments);
      const key = stableKey(kind, args);
      const now = Date.now();
      pruneRecent(now);

      const active = inFlight.get(key);
      if (active) {
        deduped += 1;
        mark('stateV2.serializationDeduped', { kind, phase: 'inflight' });
        return active;
      }

      const cached = recent.get(key);
      if (cached && cached.expiresAt > now) {
        deduped += 1;
        mark('stateV2.serializationDeduped', { kind, phase: 'recent' });
        return Promise.resolve(cached.result);
      }

      queued += 1;
      const queueDepth = inFlight.size + 1;
      maxQueueDepth = Math.max(maxQueueDepth, queueDepth);
      lastKind = kind;

      const run = tail.then(async () => {
        mark('stateV2.serializationStarted', { kind, queued: inFlight.size });
        try {
          const result = await original.apply(this, args);
          completed += 1;
          recent.set(key, { result, expiresAt: Date.now() + RECENT_MS });
          return result;
        } catch (error) {
          failures += 1;
          lastError = String(error?.code || error?.message || error);
          throw error;
        }
      });

      inFlight.set(key, run);
      tail = run.catch(() => undefined);
      run.finally(() => {
        if (inFlight.get(key) === run) inFlight.delete(key);
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
    version: 1,
    getStatus() {
      return {
        installed: true,
        wrappedMethods: wrappedMethods.slice(),
        queued,
        completed,
        deduped,
        failures,
        active: inFlight.size,
        maxQueueDepth,
        lastKind,
        lastError
      };
    }
  };

  global.TaskPointsStateRuntimeV2SerializationGuard = api;
  mark('stateV2.serializationGuardInstalled', { wrappedMethods: wrappedMethods.length });
})(typeof window !== 'undefined' ? window : globalThis);
