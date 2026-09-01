(function installTaskPointsStateRuntimeV2(global) {
  'use strict';

  const core = global?.TaskPointsCore;
  if (!global || !core || global.TaskPointsStateRuntimeV2?.__installedModule) return;

  const DB_NAME = 'taskpoints_state_v2';
  const DB_VERSION = 1;
  const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
  const GENERATION_KEY = 'taskpoints_state_v2_generation_v1';
  const RUNTIME_META_ID = 'runtime';
  const SCHEMA_VERSION = 2;
  const STORE_NAMES = Object.freeze(['habits', 'completions', 'mutations', 'meta']);

  let dbPromise = null;
  let seedPromise = null;
  let mirrorTail = Promise.resolve();
  let hookInstalled = false;
  let originalWritePendingHabitDelta = null;
  let opened = false;
  let seeded = false;
  let mirroredMutations = 0;
  let duplicateMutations = 0;
  let mirrorFailures = 0;
  let generationInvalidations = 0;
  let revisionConflicts = 0;
  let lastError = null;
  let lastMutationId = null;
  let lastSeedHash = null;
  let lastResetGeneration = null;
  let lastKnownRevision = null;
  let lastRevisionConflict = null;
  let lastParity = null;

  function nowIso() { return new Date().toISOString(); }

  function mark(name, detail = {}) {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
  }

  function clone(value) {
    if (value == null) return value;
    if (typeof global.structuredClone === 'function') {
      try { return global.structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  }

  function safeGet(key) {
    try { return global.localStorage?.getItem?.(key) ?? null; }
    catch (_) { return null; }
  }

  function safeSet(key, value) {
    try {
      global.localStorage?.setItem?.(key, String(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function safeRemove(key) {
    try {
      global.localStorage?.removeItem?.(key);
      return true;
    } catch (_) {
      return false;
    }
  }

  function isDarkEnabled() {
    return safeGet(DARK_MODE_KEY) === '1';
  }

  function newResetGeneration(prefix = 'seed') {
    const random = global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}:${random}`;
  }

  function generationModule() {
    return global.TaskPointsStateRuntimeV2Generation || null;
  }

  function currentGeneration(options = {}) {
    const existing = generationModule()?.read?.() || safeGet(GENERATION_KEY);
    if (existing) return String(existing);
    if (options.create === false) return null;

    const ensured = generationModule()?.ensure?.();
    if (ensured?.generation) return String(ensured.generation);

    const generation = newResetGeneration('runtime-bootstrap');
    if (!safeSet(GENERATION_KEY, generation)) {
      throw new Error('state_runtime_v2_generation_unavailable');
    }
    return generation;
  }

  function staleGenerationError(expectedGeneration, actualGeneration, phase) {
    const error = new Error(`state_runtime_v2_stale_generation:${phase}:${expectedGeneration || 'missing'}:${actualGeneration || 'missing'}`);
    error.code = 'STATE_RUNTIME_V2_STALE_GENERATION';
    error.expectedGeneration = expectedGeneration || null;
    error.actualGeneration = actualGeneration || null;
    error.phase = phase;
    return error;
  }

  function revisionConflictError(expectedRevision, actualRevision, phase = 'meta') {
    const error = new Error(`state_runtime_v2_revision_conflict:${phase}:${expectedRevision ?? 'missing'}:${actualRevision ?? 'missing'}`);
    error.code = 'STATE_RUNTIME_V2_REVISION_CONFLICT';
    error.expectedRevision = expectedRevision ?? null;
    error.actualRevision = actualRevision ?? null;
    error.phase = phase;
    return error;
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

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('indexeddb_request_failed'));
    });
  }

  function transactionPromise(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onabort = () => reject(tx.error || new Error('indexeddb_transaction_aborted'));
      tx.onerror = () => undefined;
    });
  }

  function ensureStores(db) {
    if (!db.objectStoreNames.contains('habits')) db.createObjectStore('habits', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('completions')) db.createObjectStore('completions', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('mutations')) db.createObjectStore('mutations', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
  }

  function open() {
    if (!isDarkEnabled()) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    if (!global.indexedDB?.open) {
      const error = new Error('state_runtime_v2_indexeddb_unavailable');
      lastError = error.message;
      return Promise.reject(error);
    }

    dbPromise = new Promise((resolve, reject) => {
      const request = global.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => ensureStores(request.result);
      request.onsuccess = () => {
        opened = true;
        mark('stateV2.opened', { database: DB_NAME, version: DB_VERSION });
        resolve(request.result);
      };
      request.onerror = () => {
        const error = request.error || new Error('state_runtime_v2_open_failed');
        lastError = String(error?.message || error);
        dbPromise = null;
        reject(error);
      };
      request.onblocked = () => {
        const error = new Error('state_runtime_v2_open_blocked');
        lastError = error.message;
        dbPromise = null;
        reject(error);
      };
    });
    return dbPromise;
  }

  async function readMeta(db) {
    const tx = db.transaction('meta', 'readonly');
    const row = await requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID));
    return row || null;
  }

  function parseLegacyStateWithPending() {
    const storageKey = core.STORAGE_KEY || 'taskpoints_v1';
    const raw = safeGet(storageKey);
    if (raw === null) return { missing: true, raw: null, state: null };

    let state;
    if (typeof core.parseTaskPointsStorageJson === 'function') state = core.parseTaskPointsStorageJson(raw, {}) || {};
    else state = JSON.parse(raw) || {};
    state = clone(state);

    try {
      const pending = typeof core.readPendingHabitDeltas === 'function'
        ? core.readPendingHabitDeltas()
        : [];
      if (pending?.length && typeof core.applyPendingHabitDeltas === 'function') {
        core.applyPendingHabitDeltas(state, pending);
      }
    } catch (error) {
      throw new Error(`state_runtime_v2_pending_journal_unreadable:${String(error?.message || error)}`);
    }

    state.habits = Array.isArray(state.habits) ? state.habits : [];
    state.completions = Array.isArray(state.completions) ? state.completions : [];
    return { missing: false, raw, state };
  }

  function sourceSubset(state) {
    return {
      habits: Array.isArray(state?.habits) ? state.habits : [],
      completions: Array.isArray(state?.completions) ? state.completions : []
    };
  }

  function subsetHash(state) {
    const text = stableJson(sourceSubset(state));
    return `${fnv1a(text)}:${text.length}`;
  }

  function packLegacyCompletionRows(completions) {
    const rows = new Map();
    (completions || []).forEach((completion, index) => {
      const storageId = completion?.id != null
        ? String(completion.id)
        : `__tp_v2_missing_completion_id__:${index}`;
      const row = rows.get(storageId) || { id: storageId, entries: [] };
      row.entries.push({
        value: clone(completion),
        sequence: completions.length - index
      });
      rows.set(storageId, row);
    });
    return Array.from(rows.values());
  }

  function unpackCompletionRows(rows) {
    return (rows || [])
      .flatMap((row) => {
        if (Array.isArray(row?.entries)) {
          return row.entries.map((entry) => ({
            value: clone(entry?.value),
            sequence: Number(entry?.sequence || 0)
          }));
        }
        if (row && Object.prototype.hasOwnProperty.call(row, 'value')) {
          return [{ value: clone(row.value), sequence: Number(row.sequence || 0) }];
        }
        return [];
      })
      .sort((a, b) => Number(b.sequence || 0) - Number(a.sequence || 0))
      .map((entry) => clone(entry.value));
  }

  async function clearForMissingLegacy(db, previousMeta = null, resetGeneration = currentGeneration()) {
    const revision = Number(previousMeta?.revision || 0) + 1;
    const tx = db.transaction(STORE_NAMES, 'readwrite');
    tx.objectStore('habits').clear();
    tx.objectStore('completions').clear();
    tx.objectStore('mutations').clear();
    tx.objectStore('meta').put({
      id: RUNTIME_META_ID,
      schemaVersion: SCHEMA_VERSION,
      revision,
      completionSequence: 0,
      resetGeneration,
      source: 'legacy-dark-mirror',
      seedHash: null,
      seededAtISO: nowIso(),
      updatedAtISO: nowIso(),
      legacyMissing: true
    });
    await transactionPromise(tx);
    seeded = true;
    lastSeedHash = null;
    lastResetGeneration = resetGeneration;
    lastKnownRevision = revision;
    mark('stateV2.seededEmpty', { reason: 'legacy_missing', resetGeneration, revision });
    return { seeded: true, empty: true, reason: 'legacy_missing', resetGeneration, revision };
  }

  async function seedFromLegacy(options = {}) {
    if (!isDarkEnabled()) return { seeded: false, reason: 'dark_disabled' };
    const requestedGeneration = currentGeneration();
    if (seeded && options.force !== true && lastResetGeneration === requestedGeneration) {
      return {
        seeded: false,
        reason: 'already_seeded_this_page',
        hash: lastSeedHash,
        resetGeneration: lastResetGeneration,
        revision: lastKnownRevision
      };
    }
    if (seedPromise) {
      if (options.force !== true) return seedPromise;
      return seedPromise.then(() => seedFromLegacy({ ...options, force: true }));
    }

    const run = async () => {
      const desiredGeneration = currentGeneration();
      const db = await open();
      if (!db) return { seeded: false, reason: 'dark_disabled' };
      const previousMeta = await readMeta(db);
      const source = parseLegacyStateWithPending();
      if (source.missing) return clearForMissingLegacy(db, previousMeta, desiredGeneration);

      const hash = subsetHash(source.state);
      if (
        options.force !== true
        && previousMeta?.schemaVersion === SCHEMA_VERSION
        && previousMeta?.seedHash === hash
        && previousMeta?.legacyMissing !== true
        && previousMeta?.resetGeneration === desiredGeneration
      ) {
        seeded = true;
        lastSeedHash = hash;
        lastResetGeneration = desiredGeneration;
        lastKnownRevision = Number(previousMeta?.revision || 0);
        return {
          seeded: false,
          reason: 'already_current',
          hash,
          resetGeneration: desiredGeneration,
          revision: lastKnownRevision
        };
      }

      const habits = source.state.habits;
      const completions = source.state.completions;
      const tx = db.transaction(STORE_NAMES, 'readwrite');
      const habitsStore = tx.objectStore('habits');
      const completionsStore = tx.objectStore('completions');
      habitsStore.clear();
      completionsStore.clear();
      tx.objectStore('mutations').clear();

      habits.forEach((habit, index) => {
        if (!habit?.id) return;
        habitsStore.put({ id: String(habit.id), value: clone(habit), legacyIndex: index });
      });
      packLegacyCompletionRows(completions).forEach((row) => completionsStore.put(row));

      const revision = Number(previousMeta?.revision || 0) + 1;
      tx.objectStore('meta').put({
        id: RUNTIME_META_ID,
        schemaVersion: SCHEMA_VERSION,
        revision,
        completionSequence: completions.length,
        resetGeneration: desiredGeneration,
        source: 'legacy-dark-mirror',
        seedHash: hash,
        seededAtISO: nowIso(),
        updatedAtISO: nowIso(),
        legacyMissing: false,
        counts: { habits: habits.length, completions: completions.length }
      });
      await transactionPromise(tx);

      const currentAfterCommit = currentGeneration({ create: false });
      if (currentAfterCommit && currentAfterCommit !== desiredGeneration) {
        generationInvalidations += 1;
        mark('stateV2.seedGenerationSuperseded', { desiredGeneration, currentGeneration: currentAfterCommit });
        return seedFromLegacy({ force: true });
      }

      seeded = true;
      lastSeedHash = hash;
      lastResetGeneration = desiredGeneration;
      lastKnownRevision = revision;
      mark('stateV2.seeded', { habits: habits.length, completions: completions.length, revision, resetGeneration: desiredGeneration });
      return { seeded: true, reason: 'seeded', hash, revision, resetGeneration: desiredGeneration, habits: habits.length, completions: completions.length };
    };

    seedPromise = run().finally(() => { seedPromise = null; });
    return seedPromise;
  }

  function normalizeDelta(delta) {
    if (!delta || !delta.habitId || !delta.dayKey) throw new Error('state_runtime_v2_invalid_habit_delta');
    return {
      ...clone(delta),
      id: delta.id || `${delta.source === 'vice' ? 'vice' : 'habit'}:${delta.habitId}:${delta.dayKey}`,
      habitId: String(delta.habitId),
      dayKey: String(delta.dayKey),
      source: delta.source === 'vice' ? 'vice' : 'habit',
      status: ['full', 'half', 'failed', 'off'].includes(delta.status) ? delta.status : (delta.done ? 'full' : (delta.failed ? 'failed' : 'off')),
      updatedAtISO: delta.updatedAtISO || delta.createdAtISO || nowIso()
    };
  }

  function mutationIdForDelta(delta, generationInput = null) {
    const generation = String(generationInput || currentGeneration());
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

  function patchHabit(habit, delta) {
    const next = clone(habit || {});
    const removeDay = (values) => (Array.isArray(values) ? values : []).filter((key) => key !== delta.dayKey);
    next.doneKeys = removeDay(next.doneKeys);
    next.failedKeys = removeDay(next.failedKeys);
    next.iceKeys = removeDay(next.iceKeys);

    const done = delta.done === true || delta.status === 'full' || delta.status === 'half';
    const failed = delta.failed === true || delta.status === 'failed';
    if (done) next.doneKeys.push(delta.dayKey);
    if (failed) next.failedKeys.push(delta.dayKey);
    if (delta.icy === true) next.iceKeys.push(delta.dayKey);
    next.updatedAtISO = delta.updatedAtISO || next.updatedAtISO;
    return next;
  }

  function completionForDelta(habit, delta) {
    const done = delta.done === true || delta.status === 'full' || delta.status === 'half';
    if (!done) return null;
    const fraction = delta.completionFraction == null ? (delta.status === 'half' ? 0.5 : 1) : Number(delta.completionFraction);
    const points = Number.isFinite(Number(delta.completionPoints))
      ? Number(delta.completionPoints)
      : (Number(habit?.pointsPerDay) || 0) * fraction;
    const completionId = typeof core.habitCompletionId === 'function'
      ? core.habitCompletionId(delta.habitId, delta.dayKey)
      : `habit:${delta.habitId}:${delta.dayKey}`;
    return {
      id: completionId,
      taskId: completionId,
      title: `[${delta.source === 'vice' ? 'Vice' : 'Habit'}] ${habit?.name || ''} (${delta.dayKey})`,
      points,
      completedAtISO: delta.updatedAtISO,
      source: delta.source,
      habitId: delta.habitId,
      dayKey: delta.dayKey,
      completionFraction: fraction
    };
  }

  async function applyHabitDelta(deltaInput, options = {}) {
    if (!isDarkEnabled()) return { committed: false, reason: 'dark_disabled' };
    const delta = normalizeDelta(deltaInput);
    const expectedGeneration = String(options.expectedGeneration || currentGeneration());
    await seedFromLegacy();
    const expectedRevision = options.expectedRevision != null
      ? Number(options.expectedRevision)
      : lastKnownRevision;

    const generationBeforeOpen = currentGeneration({ create: false });
    if (generationBeforeOpen !== expectedGeneration) {
      generationInvalidations += 1;
      throw staleGenerationError(expectedGeneration, generationBeforeOpen, 'before-open');
    }

    const db = await open();
    const mutationId = mutationIdForDelta(delta, expectedGeneration);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAMES, 'readwrite');
      const habitsStore = tx.objectStore('habits');
      const completionsStore = tx.objectStore('completions');
      const mutationsStore = tx.objectStore('mutations');
      const metaStore = tx.objectStore('meta');

      const mutationRequest = mutationsStore.get(mutationId);
      const habitRequest = habitsStore.get(delta.habitId);
      const metaRequest = metaStore.get(RUNTIME_META_ID);
      let existingMutation;
      let habitRow;
      let runtimeMeta;
      let readyCount = 0;
      let duplicate = false;
      let nextRevision = null;
      let prepared = false;
      let settled = false;
      let generationInvalidated = false;
      let unsubscribeGeneration = () => undefined;

      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        unsubscribeGeneration();
        reject(error);
      };

      const fail = (error) => {
        if (settled) return;
        try { tx.abort(); } catch (_) {}
        finishReject(error);
      };

      const generationApi = generationModule();
      if (typeof generationApi?.subscribe === 'function') {
        unsubscribeGeneration = generationApi.subscribe((event) => {
          const nextGeneration = typeof event === 'string' ? event : event?.generation;
          if (!nextGeneration || String(nextGeneration) === expectedGeneration || settled) return;
          generationInvalidated = true;
          generationInvalidations += 1;
          fail(staleGenerationError(expectedGeneration, String(nextGeneration), 'in-flight'));
        });
      }

      const prepare = () => {
        readyCount += 1;
        if (readyCount !== 3 || prepared || settled) return;
        prepared = true;
        try {
          const durableGeneration = currentGeneration({ create: false });
          if (durableGeneration !== expectedGeneration) {
            generationInvalidated = true;
            generationInvalidations += 1;
            throw staleGenerationError(expectedGeneration, durableGeneration, 'prepare');
          }

          runtimeMeta = runtimeMeta || {
            id: RUNTIME_META_ID,
            schemaVersion: SCHEMA_VERSION,
            revision: 0,
            completionSequence: 0,
            resetGeneration: expectedGeneration
          };
          if (runtimeMeta.resetGeneration && runtimeMeta.resetGeneration !== expectedGeneration) {
            generationInvalidated = true;
            generationInvalidations += 1;
            throw staleGenerationError(expectedGeneration, runtimeMeta.resetGeneration, 'meta');
          }

          if (existingMutation) {
            duplicate = true;
            return;
          }

          const actualRevision = Number(runtimeMeta.revision || 0);
          if (expectedRevision != null && actualRevision !== Number(expectedRevision)) {
            revisionConflicts += 1;
            lastKnownRevision = actualRevision;
            lastRevisionConflict = {
              expectedRevision: Number(expectedRevision),
              actualRevision,
              mutationId,
              habitId: delta.habitId,
              dayKey: delta.dayKey,
              detectedAtISO: nowIso()
            };
            mark('stateV2.revisionConflict', lastRevisionConflict);
            throw revisionConflictError(Number(expectedRevision), actualRevision, 'meta');
          }

          if (!habitRow?.value) throw new Error(`state_runtime_v2_habit_missing:${delta.habitId}`);

          nextRevision = actualRevision + 1;
          const nextHabit = patchHabit(habitRow.value, delta);
          habitsStore.put({ ...habitRow, id: delta.habitId, value: nextHabit });

          const completionId = typeof core.habitCompletionId === 'function'
            ? core.habitCompletionId(delta.habitId, delta.dayKey)
            : `habit:${delta.habitId}:${delta.dayKey}`;
          const completion = completionForDelta(nextHabit, delta);
          let completionSequence = Number(runtimeMeta.completionSequence || 0);
          if (completion) {
            completionSequence += 1;
            completionsStore.put({ id: completionId, value: completion, sequence: completionSequence });
          } else {
            completionsStore.delete(completionId);
          }

          mutationsStore.put({
            id: mutationId,
            schemaVersion: SCHEMA_VERSION,
            type: 'habit-completion-set',
            source: 'legacy-habit-journal-dark-mirror',
            status: 'committed',
            previousRevision: actualRevision,
            revision: nextRevision,
            resetGeneration: expectedGeneration,
            createdAtISO: nowIso(),
            delta: clone(delta)
          });
          metaStore.put({
            ...runtimeMeta,
            id: RUNTIME_META_ID,
            schemaVersion: SCHEMA_VERSION,
            revision: nextRevision,
            completionSequence,
            resetGeneration: expectedGeneration,
            source: 'legacy-dark-mirror',
            lastMutationId: mutationId,
            updatedAtISO: nowIso(),
            legacyMissing: false
          });
        } catch (error) {
          fail(error);
        }
      };

      mutationRequest.onsuccess = () => { existingMutation = mutationRequest.result || null; prepare(); };
      habitRequest.onsuccess = () => { habitRow = habitRequest.result || null; prepare(); };
      metaRequest.onsuccess = () => { runtimeMeta = metaRequest.result || null; prepare(); };
      mutationRequest.onerror = () => fail(mutationRequest.error || new Error('state_runtime_v2_mutation_read_failed'));
      habitRequest.onerror = () => fail(habitRequest.error || new Error('state_runtime_v2_habit_read_failed'));
      metaRequest.onerror = () => fail(metaRequest.error || new Error('state_runtime_v2_meta_read_failed'));

      tx.oncomplete = () => {
        if (settled) return;
        const durableGeneration = currentGeneration({ create: false });
        if (durableGeneration !== expectedGeneration || generationInvalidated) {
          settled = true;
          unsubscribeGeneration();
          generationInvalidations += 1;
          const error = staleGenerationError(expectedGeneration, durableGeneration, 'after-commit');
          Promise.resolve(seedFromLegacy({ force: true })).catch((seedError) => {
            lastError = String(seedError?.message || seedError);
            mark('stateV2.generationScrubFailed', { message: lastError });
          });
          reject(error);
          return;
        }

        settled = true;
        unsubscribeGeneration();
        if (duplicate) {
          duplicateMutations += 1;
          lastKnownRevision = Number(runtimeMeta?.revision || lastKnownRevision || 0);
          resolve({
            committed: false,
            duplicate: true,
            mutationId,
            revision: lastKnownRevision,
            resetGeneration: expectedGeneration
          });
          return;
        }
        mirroredMutations += 1;
        lastMutationId = mutationId;
        lastKnownRevision = nextRevision;
        lastRevisionConflict = null;
        mark('stateV2.darkMutationCommitted', { mutationId, revision: nextRevision, resetGeneration: expectedGeneration, habitId: delta.habitId, dayKey: delta.dayKey });
        resolve({ committed: true, duplicate: false, mutationId, revision: nextRevision, resetGeneration: expectedGeneration });
      };
      tx.onabort = () => {
        if (settled) return;
        if (generationInvalidated) {
          finishReject(staleGenerationError(expectedGeneration, currentGeneration({ create: false }), 'abort'));
          return;
        }
        finishReject(tx.error || new Error('state_runtime_v2_mutation_aborted'));
      };
      tx.onerror = () => undefined;
    });
  }

  function enqueueHabitDelta(delta) {
    if (!isDarkEnabled()) return;
    const snapshot = clone(delta);
    const expectedGeneration = currentGeneration();
    mirrorTail = mirrorTail
      .then(() => applyHabitDelta(snapshot, { expectedGeneration }))
      .catch((error) => {
        mirrorFailures += 1;
        lastError = String(error?.message || error);
        mark('stateV2.darkMutationFailed', { message: lastError, resetGeneration: expectedGeneration, habitId: snapshot?.habitId || null, dayKey: snapshot?.dayKey || null });
        console.warn('TaskPoints V2 dark mirror failed; production state remains authoritative.', error);
      });
  }

  function installHabitJournalHook() {
    if (!isDarkEnabled()) return false;
    if (hookInstalled) return true;
    if (typeof core.writePendingHabitDelta !== 'function') return false;

    originalWritePendingHabitDelta = core.writePendingHabitDelta.bind(core);
    core.writePendingHabitDelta = function taskPointsV2DarkWritePendingHabitDelta(delta) {
      const result = originalWritePendingHabitDelta(...arguments);
      enqueueHabitDelta(result || delta);
      return result;
    };
    hookInstalled = true;
    mark('stateV2.darkHookInstalled', { database: DB_NAME });
    return true;
  }

  async function readV2Collections() {
    const db = await open();
    if (!db) return { habits: [], completions: [] };
    const tx = db.transaction(['habits', 'completions'], 'readonly');
    const habitsRequest = tx.objectStore('habits').getAll();
    const completionsRequest = tx.objectStore('completions').getAll();
    const [habitRows, completionRows] = await Promise.all([
      requestPromise(habitsRequest),
      requestPromise(completionsRequest)
    ]);
    const habits = (habitRows || [])
      .slice()
      .sort((a, b) => Number(a.legacyIndex || 0) - Number(b.legacyIndex || 0))
      .map((row) => clone(row.value));
    const completions = unpackCompletionRows(completionRows);
    return { habits, completions };
  }

  async function buildCompatibilitySnapshot() {
    if (!isDarkEnabled()) throw new Error('state_runtime_v2_dark_disabled');
    await seedFromLegacy();
    const source = parseLegacyStateWithPending();
    if (source.missing) return {};
    const collections = await readV2Collections();
    return {
      ...source.state,
      habits: collections.habits,
      completions: collections.completions
    };
  }

  async function verifyParity() {
    if (!isDarkEnabled()) return { checked: false, reason: 'dark_disabled' };
    await seedFromLegacy();
    const source = parseLegacyStateWithPending();
    if (source.missing) {
      lastParity = { checked: true, match: true, legacyMissing: true, checkedAtISO: nowIso() };
      return lastParity;
    }
    const collections = await readV2Collections();
    const expectedText = stableJson(sourceSubset(source.state));
    const actualText = stableJson(collections);
    lastParity = {
      checked: true,
      match: expectedText === actualText,
      expectedHash: `${fnv1a(expectedText)}:${expectedText.length}`,
      actualHash: `${fnv1a(actualText)}:${actualText.length}`,
      expectedCounts: { habits: source.state.habits.length, completions: source.state.completions.length },
      actualCounts: { habits: collections.habits.length, completions: collections.completions.length },
      checkedAtISO: nowIso()
    };
    mark('stateV2.parityChecked', lastParity);
    return lastParity;
  }

  function getStatus() {
    return {
      installed: true,
      darkEnabled: isDarkEnabled(),
      databaseName: DB_NAME,
      databaseVersion: DB_VERSION,
      schemaVersion: SCHEMA_VERSION,
      stores: [...STORE_NAMES],
      opened,
      seeded,
      hookInstalled,
      mirroredMutations,
      duplicateMutations,
      mirrorFailures,
      generationInvalidations,
      revisionConflicts,
      generationKey: GENERATION_KEY,
      currentGeneration: currentGeneration({ create: false }),
      lastResetGeneration,
      lastKnownRevision,
      lastRevisionConflict,
      lastMutationId,
      lastSeedHash,
      lastError,
      lastParity,
      readAuthority: 'legacy_only',
      walMode: 'v2_generation_stamped_wal_with_revision_conflict_guard_and_legacy_authority'
    };
  }

  async function startDarkMirror() {
    if (!isDarkEnabled()) return getStatus();
    currentGeneration();
    installHabitJournalHook();
    try { await seedFromLegacy(); }
    catch (error) {
      mirrorFailures += 1;
      lastError = String(error?.message || error);
      console.warn('TaskPoints V2 dark seed failed; production state remains authoritative.', error);
    }
    return getStatus();
  }

  function enableDarkMirror() {
    safeSet(DARK_MODE_KEY, '1');
    currentGeneration();
    startDarkMirror();
    return getStatus();
  }

  function disableDarkMirror() {
    safeRemove(DARK_MODE_KEY);
    return getStatus();
  }

  const api = {
    __installedModule: true,
    DB_NAME,
    DB_VERSION,
    DARK_MODE_KEY,
    GENERATION_KEY,
    STORE_NAMES,
    isDarkEnabled,
    enableDarkMirror,
    disableDarkMirror,
    startDarkMirror,
    open,
    seedFromLegacy,
    applyMutation(mutation) {
      if (mutation?.type !== 'habit-completion-set' || !mutation?.delta) {
        return Promise.reject(new Error('state_runtime_v2_unsupported_dark_mutation'));
      }
      return applyHabitDelta(mutation.delta, {
        expectedGeneration: mutation.generation || undefined,
        expectedRevision: mutation.expectedRevision ?? undefined
      });
    },
    applyHabitDelta,
    getObservedRevision: () => lastKnownRevision,
    getHabit: async (id) => {
      const db = await open();
      if (!db) return null;
      const tx = db.transaction('habits', 'readonly');
      const row = await requestPromise(tx.objectStore('habits').get(String(id)));
      return row?.value ? clone(row.value) : null;
    },
    getCompletionsForHabit: async (habitId) => {
      const collections = await readV2Collections();
      return collections.completions.filter((completion) => String(completion?.habitId || '') === String(habitId));
    },
    buildCompatibilitySnapshot,
    verifyParity,
    getStatus
  };

  global.TaskPointsStateRuntimeV2 = api;

  if (isDarkEnabled()) {
    if (global.document?.readyState === 'loading') {
      global.document.addEventListener?.('DOMContentLoaded', () => startDarkMirror(), { once: true });
    } else if (typeof global.setTimeout === 'function') {
      global.setTimeout(() => startDarkMirror(), 0);
    } else {
      startDarkMirror();
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
