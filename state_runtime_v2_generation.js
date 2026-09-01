(function installTaskPointsStateRuntimeV2Generation(global) {
  'use strict';

  if (!global || global.TaskPointsStateRuntimeV2Generation?.__installedModule) return;

  const KEY = 'taskpoints_state_v2_generation_v1';
  const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
  const listeners = new Set();
  let sequence = 0;
  let rotations = 0;
  let externalChanges = 0;
  let lastReason = null;
  let lastError = null;

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

  function isEnabled() {
    return safeGet(DARK_MODE_KEY) === '1';
  }

  function createGeneration(reason = 'generation') {
    sequence += 1;
    const random = global.crypto?.randomUUID?.()
      || `${Date.now()}-${sequence}-${Math.random().toString(36).slice(2)}`;
    return `${String(reason || 'generation').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40)}:${random}`;
  }

  function read() {
    const value = safeGet(KEY);
    return typeof value === 'string' && value ? value : null;
  }

  function notify(event) {
    for (const listener of Array.from(listeners)) {
      try { listener(event); } catch (_) {}
    }
    try { global.TaskPointsPerf?.mark?.('stateV2.generationChanged', event); } catch (_) {}
  }

  function ensure() {
    if (!isEnabled()) return { enabled: false, generation: null, created: false };
    const existing = read();
    if (existing) return { enabled: true, generation: existing, created: false };
    const generation = createGeneration('v2-bootstrap');
    if (!safeSet(KEY, generation)) throw new Error(`state_runtime_v2_generation_write_failed:${lastError || 'unknown'}`);
    lastReason = 'bootstrap';
    notify({ generation, previousGeneration: null, reason: 'bootstrap', source: 'local' });
    return { enabled: true, generation, created: true };
  }

  function rotate(reason = 'epoch-change') {
    if (!isEnabled()) return { rotated: false, reason: 'dark_disabled', generation: read() };
    const previousGeneration = read();
    const generation = createGeneration(reason);
    if (!safeSet(KEY, generation)) throw new Error(`state_runtime_v2_generation_write_failed:${lastError || 'unknown'}`);
    rotations += 1;
    lastReason = String(reason || 'epoch-change');
    const event = { generation, previousGeneration, reason: lastReason, source: 'local' };
    notify(event);
    return { rotated: true, ...event };
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => undefined;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getStatus() {
    return {
      installed: true,
      enabled: isEnabled(),
      key: KEY,
      generation: read(),
      rotations,
      externalChanges,
      lastReason,
      lastError
    };
  }

  if (typeof global.addEventListener === 'function') {
    global.addEventListener('storage', (event) => {
      if (event?.key !== KEY || !event.newValue || event.newValue === event.oldValue) return;
      externalChanges += 1;
      lastReason = 'external-storage-event';
      notify({
        generation: String(event.newValue),
        previousGeneration: event.oldValue ? String(event.oldValue) : null,
        reason: lastReason,
        source: 'storage'
      });
    });
  }

  const api = {
    __installedModule: true,
    KEY,
    DARK_MODE_KEY,
    isEnabled,
    createGeneration,
    read,
    ensure,
    rotate,
    subscribe,
    getStatus
  };

  global.TaskPointsStateRuntimeV2Generation = api;
  if (isEnabled()) {
    try { ensure(); } catch (_) {}
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
