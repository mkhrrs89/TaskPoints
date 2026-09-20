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
  let mirroredOrderMutations = 0;
  let mirroredEditMutations = 0;
  let mirroredPresenceMutations = 0;
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

    // Production Habit reorder durability lives in a tiny localStorage overlay
    // until its idle full-state compaction succeeds. Treat that overlay as part
    // of the effective legacy authority for V2 seed/parity/compatibility reads,
    // just as pending Habit completion deltas already are above.
    try {
      const rawOrderOverlay = safeGet('taskpoints_habit_order_overlay_v1');
      if (rawOrderOverlay) {
        const orderOverlay = JSON.parse(rawOrderOverlay);
        if (orderOverlay?.orders && typeof orderOverlay.orders === 'object') {
          const habitsById = new Map(state.habits.filter(Boolean).map((habit) => [String(habit.id || ''), habit]));
          Object.entries(orderOverlay.orders).forEach(([habitId, orderValue]) => {
            const habit = habitsById.get(String(habitId));
            const nextOrder = Number(orderValue);
            if (!habit || !Number.isFinite(nextOrder)) return;
            habit.order = nextOrder;
            const timestamp = orderOverlay.habitUpdatedAtISO?.[habitId];
            if (typeof timestamp === 'string' && timestamp > String(habit.updatedAtISO || '')) {
              habit.updatedAtISO = timestamp;
            }
          });
        }
      }
    } catch (error) {
      throw new Error(`state_runtime_v2_pending_order_overlay_unreadable:${String(error?.message || error)}`);
    }

    return { missing: false, raw, state };
  }

  // V2's first proving ground owns Habit/Vice completion records only. Keep
  // unrelated task/manual/scoring completion classes in the legacy authority
  // until their own migration phases exist.
  function isPilotCompletion(completion) {
    const source = String(completion?.source || '');
    const habitId = String(completion?.habitId || '').trim();
    return Boolean(habitId) && (source === 'habit' || source === 'vice');
  }

  function pilotCompletions(state) {
    return (Array.isArray(state?.completions) ? state.completions : []).filter(isPilotCompletion);
  }

  function sourceSubset(state) {
    return {
      habits: Array.isArray(state?.habits) ? state.habits : [],
      completions: pilotCompletions(state)
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

  async function readV2CollectionsFromDb(db) {
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

  async function refreshSeedMarker(db, previousMeta, hash, desiredGeneration, reason) {
    if (!previousMeta || previousMeta.seedHash === hash) return previousMeta;
    const nextMeta = {
      ...previousMeta,
      id: RUNTIME_META_ID,
      schemaVersion: SCHEMA_VERSION,
      resetGeneration: desiredGeneration,
      seedHash: hash,
      seedVerifiedAtISO: nowIso(),
      seedVerifiedReason: String(reason || 'verified-current')
    };
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(nextMeta);
    await transactionPromise(tx);
    return nextMeta;
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

    // Capture the legacy authority before the first async IndexedDB wait. On a
    // physical device, opening/reading IndexedDB can take long enough for the
    // user to perform a new mutation. Seeding from a later snapshot would fold
    // that new mutation into the baseline before its incremental V2 mirror runs.
    const desiredGeneration = currentGeneration();
    const source = parseLegacyStateWithPending();
    const capturedHash = source.missing ? null : subsetHash(source.state);

    const run = async () => {
      const db = await open();
      if (!db) return { seeded: false, reason: 'dark_disabled' };
      let previousMeta = await readMeta(db);
      if (source.missing) return clearForMissingLegacy(db, previousMeta, desiredGeneration);

      const hash = capturedHash;

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

      // A stale seedHash does not necessarily mean the V2 data is stale. Every
      // successful incremental mirror advances V2 without recomputing a full
      // legacy hash, so after a reload the old implementation could clear and
      // rewrite thousands of already-correct rows. Verify the persisted V2
      // pilot data read-only first; only a real parity mismatch may fall back to
      // the destructive full reseed below.
      if (
        options.force !== true
        && previousMeta?.schemaVersion === SCHEMA_VERSION
        && previousMeta?.legacyMissing !== true
        && previousMeta?.resetGeneration === desiredGeneration
      ) {
        const collections = await readV2CollectionsFromDb(db);
        const expectedText = stableJson(paritySubset(sourceSubset(source.state)));
        const actualText = stableJson(paritySubset(collections));
        if (expectedText === actualText) {
          try {
            previousMeta = await refreshSeedMarker(db, previousMeta, hash, desiredGeneration, 'read-only-reload-verification');
          } catch (error) {
            mark('stateV2.seedMarkerRefreshFailed', { message: String(error?.message || error) });
          }
          seeded = true;
          lastSeedHash = hash;
          lastResetGeneration = desiredGeneration;
          lastKnownRevision = Number(previousMeta?.revision || 0);
          mark('stateV2.seedAdoptedExisting', {
            habits: collections.habits.length,
            completions: collections.completions.length,
            revision: lastKnownRevision,
            resetGeneration: desiredGeneration
          });
          return {
            seeded: false,
            reason: 'verified_current',
            verifiedExisting: true,
            hash,
            resetGeneration: desiredGeneration,
            revision: lastKnownRevision
          };
        }
      }

      const habits = source.state.habits;
      const completions = pilotCompletions(source.state);
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
      updatedAtISO: delta.updatedAtISO || null,
      ...(delta.completedAtISO ? { completedAtISO: delta.completedAtISO } : {})
    });
    return `habit-delta:${fnv1a(identity)}:${identity.length}`;
  }

  function patchHabit(habit, delta) {
    const next = clone(habit || {});
    const preserveOrRemoveDay = (values, shouldContain) => {
      const current = Array.isArray(values) ? values.slice() : [];
      const alreadyContains = current.includes(delta.dayKey);
      if (shouldContain) {
        // Match the legacy foreground mutation exactly: when a day stays in
        // the same set (for example full -> half or normal -> icy), its array
        // position does not change. Only a newly-added day is appended.
        if (!alreadyContains) current.push(delta.dayKey);
        return current;
      }
      return current.filter((key) => key !== delta.dayKey);
    };

    const done = delta.done === true || delta.status === 'full' || delta.status === 'half';
    const failed = delta.failed === true || delta.status === 'failed';
    next.doneKeys = preserveOrRemoveDay(next.doneKeys, done);
    next.failedKeys = preserveOrRemoveDay(next.failedKeys, failed);
    next.iceKeys = preserveOrRemoveDay(next.iceKeys, delta.icy === true);
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
      completedAtISO: delta.completedAtISO || delta.updatedAtISO,
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

  function normalizeHabitOrderOverlay(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const orders = {};
    Object.keys(source.orders || {}).sort().forEach((habitId) => {
      const order = Number(source.orders[habitId]);
      if (!habitId || !Number.isFinite(order)) return;
      orders[String(habitId)] = order;
    });
    if (!Object.keys(orders).length) throw new Error('state_runtime_v2_invalid_habit_order_overlay');
    return {
      version: Number(source.version || 1),
      updatedAtISO: source.updatedAtISO || nowIso(),
      orders,
      ...(source.habitUpdatedAtISO && typeof source.habitUpdatedAtISO === 'object'
        ? { habitUpdatedAtISO: Object.fromEntries(Object.keys(orders).filter((id) => typeof source.habitUpdatedAtISO[id] === 'string').map((id) => [id, source.habitUpdatedAtISO[id]])) }
        : {})
    };
  }

  function mutationIdForHabitOrderOverlay(overlay, generationInput = null) {
    const generation = String(generationInput || currentGeneration());
    const identity = stableJson({
      generation,
      updatedAtISO: overlay.updatedAtISO,
      orders: overlay.orders,
      ...(overlay.habitUpdatedAtISO ? { habitUpdatedAtISO: overlay.habitUpdatedAtISO } : {})
    });
    return `habit-order:${fnv1a(identity)}:${identity.length}`;
  }

  async function applyHabitOrderOverlay(payloadInput, options = {}) {
    if (!isDarkEnabled()) return { committed: false, reason: 'dark_disabled' };
    const overlay = normalizeHabitOrderOverlay(payloadInput);
    const expectedGeneration = String(options.expectedGeneration || currentGeneration());
    await seedFromLegacy();
    const expectedRevision = options.expectedRevision != null
      ? Number(options.expectedRevision)
      : lastKnownRevision;

    const generationBeforeOpen = currentGeneration({ create: false });
    if (generationBeforeOpen !== expectedGeneration) {
      generationInvalidations += 1;
      throw staleGenerationError(expectedGeneration, generationBeforeOpen, 'order-before-open');
    }

    const db = await open();
    const mutationId = mutationIdForHabitOrderOverlay(overlay, expectedGeneration);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAMES, 'readwrite');
      const habitsStore = tx.objectStore('habits');
      const mutationsStore = tx.objectStore('mutations');
      const metaStore = tx.objectStore('meta');

      const mutationRequest = mutationsStore.get(mutationId);
      const habitsRequest = habitsStore.getAll();
      const metaRequest = metaStore.get(RUNTIME_META_ID);
      let existingMutation;
      let habitRows = [];
      let runtimeMeta;
      let readyCount = 0;
      let duplicate = false;
      let noChange = false;
      let changedHabitIds = [];
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
          fail(staleGenerationError(expectedGeneration, String(nextGeneration), 'order-in-flight'));
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
            throw staleGenerationError(expectedGeneration, durableGeneration, 'order-prepare');
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
            throw staleGenerationError(expectedGeneration, runtimeMeta.resetGeneration, 'order-meta');
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
              mutationType: 'habit-order-set',
              detectedAtISO: nowIso()
            };
            mark('stateV2.revisionConflict', lastRevisionConflict);
            throw revisionConflictError(Number(expectedRevision), actualRevision, 'order-meta');
          }

          changedHabitIds = [];
          habitRows.forEach((row) => {
            const habitId = String(row?.id || '');
            if (!habitId || !Object.prototype.hasOwnProperty.call(overlay.orders, habitId) || !row?.value) return;
            const nextOrder = Number(overlay.orders[habitId]);
            const timestamp = overlay.habitUpdatedAtISO?.[habitId];
            const newerTimestamp = typeof timestamp === 'string' && timestamp > String(row.value.updatedAtISO || '');
            if (!Number.isFinite(nextOrder) || (Number(row.value.order) === nextOrder && !newerTimestamp)) return;
            const nextHabit = { ...clone(row.value), order: nextOrder };
            if (newerTimestamp) nextHabit.updatedAtISO = timestamp;
            habitsStore.put({ ...row, id: habitId, value: nextHabit });
            changedHabitIds.push(habitId);
          });

          if (!changedHabitIds.length) {
            noChange = true;
            return;
          }

          nextRevision = actualRevision + 1;
          mutationsStore.put({
            id: mutationId,
            schemaVersion: SCHEMA_VERSION,
            type: 'habit-order-set',
            source: 'habit-order-overlay-dark-mirror',
            status: 'committed',
            previousRevision: actualRevision,
            revision: nextRevision,
            resetGeneration: expectedGeneration,
            createdAtISO: nowIso(),
            overlay: clone(overlay),
            changedHabitIds: [...changedHabitIds]
          });
          metaStore.put({
            ...runtimeMeta,
            id: RUNTIME_META_ID,
            schemaVersion: SCHEMA_VERSION,
            revision: nextRevision,
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
      habitsRequest.onsuccess = () => { habitRows = habitsRequest.result || []; prepare(); };
      metaRequest.onsuccess = () => { runtimeMeta = metaRequest.result || null; prepare(); };
      mutationRequest.onerror = () => fail(mutationRequest.error || new Error('state_runtime_v2_order_mutation_read_failed'));
      habitsRequest.onerror = () => fail(habitsRequest.error || new Error('state_runtime_v2_order_habits_read_failed'));
      metaRequest.onerror = () => fail(metaRequest.error || new Error('state_runtime_v2_order_meta_read_failed'));

      tx.oncomplete = () => {
        if (settled) return;
        const durableGeneration = currentGeneration({ create: false });
        if (durableGeneration !== expectedGeneration || generationInvalidated) {
          settled = true;
          unsubscribeGeneration();
          generationInvalidations += 1;
          const error = staleGenerationError(expectedGeneration, durableGeneration, 'order-after-commit');
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
        if (noChange) {
          lastKnownRevision = Number(runtimeMeta?.revision || lastKnownRevision || 0);
          resolve({
            committed: false,
            duplicate: false,
            noChange: true,
            mutationId,
            revision: lastKnownRevision,
            resetGeneration: expectedGeneration,
            changedHabitIds: []
          });
          return;
        }

        mirroredMutations += 1;
        mirroredOrderMutations += 1;
        lastMutationId = mutationId;
        lastKnownRevision = nextRevision;
        lastRevisionConflict = null;
        mark('stateV2.darkOrderMutationCommitted', {
          mutationId,
          revision: nextRevision,
          resetGeneration: expectedGeneration,
          changedHabitIds: [...changedHabitIds]
        });
        resolve({
          committed: true,
          duplicate: false,
          mutationId,
          revision: nextRevision,
          resetGeneration: expectedGeneration,
          changedHabitIds: [...changedHabitIds]
        });
      };
      tx.onabort = () => {
        if (settled) return;
        if (generationInvalidated) {
          finishReject(staleGenerationError(expectedGeneration, currentGeneration({ create: false }), 'order-abort'));
          return;
        }
        finishReject(tx.error || new Error('state_runtime_v2_order_mutation_aborted'));
      };
      tx.onerror = () => undefined;
    });
  }

  function completionEntriesForRow(row) {
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
  }

  function captureHabitEditSnapshotFromLegacy(habitIdInput, options = {}) {
    const habitId = String(habitIdInput || '').trim();
    if (!habitId) throw new Error('state_runtime_v2_invalid_habit_edit_id');
    const source = parseLegacyStateWithPending();
    if (source.missing) throw new Error('state_runtime_v2_habit_edit_legacy_missing');
    const habitIndex = source.state.habits.findIndex((habit) => String(habit?.id || '') === habitId);
    if (habitIndex < 0) throw new Error(`state_runtime_v2_habit_edit_missing:${habitId}`);

    const completionEntries = [];
    // V2 sequences are defined inside the pilot-owned Habit/Vice completion set.
    // Using the full legacy completion array here lets unrelated task/manual rows
    // shift sequence numbers and makes a future-only Habit edit look like it must
    // rewrite unchanged historical Habit completions.
    const completions = pilotCompletions(source.state);
    completions.forEach((completion, index) => {
      if (String(completion?.habitId || '') !== habitId) return;
      const storageId = completion?.id != null
        ? String(completion.id)
        : `__tp_v2_missing_completion_id__:${index}`;
      completionEntries.push({
        storageId,
        sequence: completions.length - index,
        value: clone(completion)
      });
    });

    return {
      version: 1,
      habitId,
      source: String(options.source || 'legacy-habit-edit'),
      capturedAtISO: nowIso(),
      habitIndex,
      habit: clone(source.state.habits[habitIndex]),
      completionEntries
    };
  }

  function normalizeHabitEditSnapshot(snapshotInput) {
    const source = snapshotInput && typeof snapshotInput === 'object' ? snapshotInput : {};
    const habit = clone(source.habit || null);
    const habitId = String(source.habitId || habit?.id || '').trim();
    if (!habitId || !habit || String(habit.id || '') !== habitId) {
      throw new Error('state_runtime_v2_invalid_habit_edit_snapshot');
    }
    const completionEntries = (Array.isArray(source.completionEntries) ? source.completionEntries : [])
      .map((entry) => {
        const value = clone(entry?.value || null);
        const storageId = String(entry?.storageId || '').trim();
        const sequence = Number(entry?.sequence || 0);
        if (!value || !storageId || String(value?.habitId || '') !== habitId || !Number.isFinite(sequence)) return null;
        return { storageId, sequence, value };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const byStorage = String(a.storageId).localeCompare(String(b.storageId));
        if (byStorage !== 0) return byStorage;
        return Number(b.sequence || 0) - Number(a.sequence || 0);
      });
    return {
      version: Number(source.version || 1),
      habitId,
      source: String(source.source || 'legacy-habit-edit'),
      capturedAtISO: source.capturedAtISO || nowIso(),
      habitIndex: Number.isFinite(Number(source.habitIndex)) ? Number(source.habitIndex) : null,
      habit,
      completionEntries
    };
  }

  function habitEditMutationId(snapshot, generationInput = null) {
    const generation = String(generationInput || currentGeneration());
    const identity = stableJson({
      generation,
      habitId: snapshot.habitId,
      habit: snapshot.habit,
      completionEntries: snapshot.completionEntries.map((entry) => ({
        storageId: entry.storageId,
        sequence: entry.sequence,
        value: entry.value
      }))
    });
    return `habit-edit:${fnv1a(identity)}:${identity.length}`;
  }

  function targetCompletionEntriesFromRows(rows, habitId) {
    const entries = [];
    (rows || []).forEach((row) => {
      completionEntriesForRow(row).forEach((entry) => {
        if (String(entry?.value?.habitId || '') !== String(habitId)) return;
        entries.push({
          storageId: String(row.id),
          sequence: Number(entry.sequence || 0),
          value: clone(entry.value)
        });
      });
    });
    return entries.sort((a, b) => {
      const byStorage = String(a.storageId).localeCompare(String(b.storageId));
      if (byStorage !== 0) return byStorage;
      return Number(b.sequence || 0) - Number(a.sequence || 0);
    });
  }

  async function applyHabitEditSnapshot(snapshotInput, options = {}) {
    if (!isDarkEnabled()) return { committed: false, reason: 'dark_disabled' };
    const snapshot = normalizeHabitEditSnapshot(snapshotInput);
    const expectedGeneration = String(options.expectedGeneration || currentGeneration());
    await seedFromLegacy();
    const expectedRevision = options.expectedRevision != null
      ? Number(options.expectedRevision)
      : lastKnownRevision;

    const generationBeforeOpen = currentGeneration({ create: false });
    if (generationBeforeOpen !== expectedGeneration) {
      generationInvalidations += 1;
      throw staleGenerationError(expectedGeneration, generationBeforeOpen, 'edit-before-open');
    }

    const db = await open();
    const mutationId = habitEditMutationId(snapshot, expectedGeneration);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAMES, 'readwrite');
      const habitsStore = tx.objectStore('habits');
      const completionsStore = tx.objectStore('completions');
      const mutationsStore = tx.objectStore('mutations');
      const metaStore = tx.objectStore('meta');

      const mutationRequest = mutationsStore.get(mutationId);
      const habitRequest = habitsStore.get(snapshot.habitId);
      const completionsRequest = completionsStore.getAll();
      const metaRequest = metaStore.get(RUNTIME_META_ID);
      let existingMutation;
      let habitRow;
      let completionRows = [];
      let runtimeMeta;
      let readyCount = 0;
      let duplicate = false;
      let noChange = false;
      let nextRevision = null;
      let completionRowsTouched = 0;
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
          fail(staleGenerationError(expectedGeneration, String(nextGeneration), 'edit-in-flight'));
        });
      }

      const prepare = () => {
        readyCount += 1;
        if (readyCount !== 4 || prepared || settled) return;
        prepared = true;
        try {
          const durableGeneration = currentGeneration({ create: false });
          if (durableGeneration !== expectedGeneration) {
            generationInvalidated = true;
            generationInvalidations += 1;
            throw staleGenerationError(expectedGeneration, durableGeneration, 'edit-prepare');
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
            throw staleGenerationError(expectedGeneration, runtimeMeta.resetGeneration, 'edit-meta');
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
              mutationType: 'habit-edit-sync',
              habitId: snapshot.habitId,
              detectedAtISO: nowIso()
            };
            mark('stateV2.revisionConflict', lastRevisionConflict);
            throw revisionConflictError(Number(expectedRevision), actualRevision, 'edit-meta');
          }

          if (!habitRow?.value) throw new Error(`state_runtime_v2_habit_missing:${snapshot.habitId}`);

          const existingTargetEntries = targetCompletionEntriesFromRows(completionRows, snapshot.habitId);
          const completionPayloadsEqual = (left, right) => stableJson(
            (left || []).map((entry) => ({ storageId: entry.storageId, value: entry.value }))
          ) === stableJson(
            (right || []).map((entry) => ({ storageId: entry.storageId, value: entry.value }))
          );
          if (
            stableJson(habitRow.value) === stableJson(snapshot.habit)
            && completionPayloadsEqual(existingTargetEntries, snapshot.completionEntries)
          ) {
            noChange = true;
            return;
          }

          const existingRowsById = new Map((completionRows || []).map((row) => [String(row?.id || ''), row]));
          const desiredById = new Map();
          snapshot.completionEntries.forEach((entry) => {
            const list = desiredById.get(entry.storageId) || [];
            list.push({ value: clone(entry.value), sequence: Number(entry.sequence || 0) });
            desiredById.set(entry.storageId, list);
          });

          const affectedIds = new Set(desiredById.keys());
          completionRows.forEach((row) => {
            if (completionEntriesForRow(row).some((entry) => String(entry?.value?.habitId || '') === snapshot.habitId)) {
              affectedIds.add(String(row.id));
            }
          });

          affectedIds.forEach((storageId) => {
            const existingRow = existingRowsById.get(storageId);
            const existingEntries = completionEntriesForRow(existingRow);
            const existingTargetEntriesForRow = existingEntries
              .filter((entry) => String(entry?.value?.habitId || '') === snapshot.habitId)
              .sort((a, b) => Number(b.sequence || 0) - Number(a.sequence || 0));
            const desiredEntries = (desiredById.get(storageId) || [])
              .slice()
              .sort((a, b) => Number(b.sequence || 0) - Number(a.sequence || 0));
            const existingValues = existingTargetEntriesForRow.map((entry) => clone(entry.value));
            const desiredValues = desiredEntries.map((entry) => clone(entry.value));
            if (stableJson(existingValues) === stableJson(desiredValues)) return;

            const retainedEntries = existingEntries
              .filter((entry) => String(entry?.value?.habitId || '') !== snapshot.habitId);
            // Habit edits may change historical completion payloads (for
            // example a retroactive points edit), but they do not reorder those
            // completions. Preserve each existing V2 sequence while replacing
            // its value. Snapshot sequence numbers describe legacy positions
            // and can collide with the runtime's monotonic mutation sequence.
            const rewrittenDesiredEntries = desiredEntries.map((entry, index) => ({
              value: clone(entry.value),
              sequence: Number(existingTargetEntriesForRow[index]?.sequence ?? entry.sequence ?? 0)
            }));
            const combined = [...retainedEntries, ...rewrittenDesiredEntries]
              .sort((a, b) => Number(b.sequence || 0) - Number(a.sequence || 0));
            if (combined.length) {
              completionsStore.put({ id: storageId, entries: combined });
            } else {
              completionsStore.delete(storageId);
            }
            completionRowsTouched += 1;
          });

          const legacyIndex = Number.isFinite(Number(habitRow.legacyIndex))
            ? Number(habitRow.legacyIndex)
            : (snapshot.habitIndex ?? 0);
          habitsStore.put({
            ...habitRow,
            id: snapshot.habitId,
            legacyIndex,
            value: clone(snapshot.habit)
          });

          nextRevision = actualRevision + 1;
          mutationsStore.put({
            id: mutationId,
            schemaVersion: SCHEMA_VERSION,
            type: 'habit-edit-sync',
            source: snapshot.source || 'legacy-habit-edit-dark-mirror',
            status: 'committed',
            previousRevision: actualRevision,
            revision: nextRevision,
            resetGeneration: expectedGeneration,
            createdAtISO: nowIso(),
            habitId: snapshot.habitId,
            completionRowsTouched,
            snapshotHash: `${fnv1a(stableJson(snapshot))}:${stableJson(snapshot).length}`
          });
          metaStore.put({
            ...runtimeMeta,
            id: RUNTIME_META_ID,
            schemaVersion: SCHEMA_VERSION,
            revision: nextRevision,
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
      completionsRequest.onsuccess = () => { completionRows = completionsRequest.result || []; prepare(); };
      metaRequest.onsuccess = () => { runtimeMeta = metaRequest.result || null; prepare(); };
      mutationRequest.onerror = () => fail(mutationRequest.error || new Error('state_runtime_v2_edit_mutation_read_failed'));
      habitRequest.onerror = () => fail(habitRequest.error || new Error('state_runtime_v2_edit_habit_read_failed'));
      completionsRequest.onerror = () => fail(completionsRequest.error || new Error('state_runtime_v2_edit_completions_read_failed'));
      metaRequest.onerror = () => fail(metaRequest.error || new Error('state_runtime_v2_edit_meta_read_failed'));

      tx.oncomplete = () => {
        if (settled) return;
        const durableGeneration = currentGeneration({ create: false });
        if (durableGeneration !== expectedGeneration || generationInvalidated) {
          settled = true;
          unsubscribeGeneration();
          generationInvalidations += 1;
          const error = staleGenerationError(expectedGeneration, durableGeneration, 'edit-after-commit');
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
        if (noChange) {
          lastKnownRevision = Number(runtimeMeta?.revision || lastKnownRevision || 0);
          resolve({
            committed: false,
            duplicate: false,
            noChange: true,
            mutationId,
            revision: lastKnownRevision,
            resetGeneration: expectedGeneration,
            habitId: snapshot.habitId,
            completionRowsTouched: 0
          });
          return;
        }

        mirroredMutations += 1;
        mirroredEditMutations += 1;
        lastMutationId = mutationId;
        lastKnownRevision = nextRevision;
        lastRevisionConflict = null;
        mark('stateV2.darkHabitEditCommitted', {
          mutationId,
          revision: nextRevision,
          resetGeneration: expectedGeneration,
          habitId: snapshot.habitId,
          completionRowsTouched
        });
        resolve({
          committed: true,
          duplicate: false,
          mutationId,
          revision: nextRevision,
          resetGeneration: expectedGeneration,
          habitId: snapshot.habitId,
          completionRowsTouched
        });
      };
      tx.onabort = () => {
        if (settled) return;
        if (generationInvalidated) {
          finishReject(staleGenerationError(expectedGeneration, currentGeneration({ create: false }), 'edit-abort'));
          return;
        }
        finishReject(tx.error || new Error('state_runtime_v2_edit_mutation_aborted'));
      };
      tx.onerror = () => undefined;
    });
  }

  function captureHabitPresenceSnapshotFromLegacy(habitIdInput, options = {}) {
    const habitId = String(habitIdInput || '').trim();
    if (!habitId) throw new Error('state_runtime_v2_invalid_habit_presence_id');
    const source = parseLegacyStateWithPending();
    const habits = source.missing ? [] : source.state.habits;
    const habitIndex = habits.findIndex((habit) => String(habit?.id || '') === habitId);
    const exists = habitIndex >= 0;
    return {
      version: 1,
      habitId,
      exists,
      source: String(options.source || 'legacy-habit-presence'),
      capturedAtISO: nowIso(),
      habitIndex: exists ? habitIndex : null,
      habit: exists ? clone(habits[habitIndex]) : null
    };
  }

  function normalizeHabitPresenceSnapshot(snapshotInput) {
    const source = snapshotInput && typeof snapshotInput === 'object' ? snapshotInput : {};
    const habitId = String(source.habitId || source.habit?.id || '').trim();
    const exists = source.exists === true;
    const habit = exists ? clone(source.habit || null) : null;
    if (!habitId || (exists && (!habit || String(habit.id || '') !== habitId))) {
      throw new Error('state_runtime_v2_invalid_habit_presence_snapshot');
    }
    return {
      version: Number(source.version || 1),
      habitId,
      exists,
      source: String(source.source || 'legacy-habit-presence'),
      capturedAtISO: source.capturedAtISO || nowIso(),
      habitIndex: Number.isFinite(Number(source.habitIndex)) ? Number(source.habitIndex) : null,
      habit
    };
  }

  function habitPresenceMutationId(snapshot, generationInput = null) {
    const generation = String(generationInput || currentGeneration());
    const identity = stableJson({
      generation,
      habitId: snapshot.habitId,
      exists: snapshot.exists,
      habit: snapshot.habit
    });
    return `habit-presence:${fnv1a(identity)}:${identity.length}`;
  }

  async function applyHabitPresenceSnapshot(snapshotInput, options = {}) {
    if (!isDarkEnabled()) return { committed: false, reason: 'dark_disabled' };
    const snapshot = normalizeHabitPresenceSnapshot(snapshotInput);
    const expectedGeneration = String(options.expectedGeneration || currentGeneration());
    await seedFromLegacy();
    const expectedRevision = options.expectedRevision != null
      ? Number(options.expectedRevision)
      : lastKnownRevision;

    const generationBeforeOpen = currentGeneration({ create: false });
    if (generationBeforeOpen !== expectedGeneration) {
      generationInvalidations += 1;
      throw staleGenerationError(expectedGeneration, generationBeforeOpen, 'presence-before-open');
    }

    const db = await open();
    const mutationId = habitPresenceMutationId(snapshot, expectedGeneration);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAMES, 'readwrite');
      const habitsStore = tx.objectStore('habits');
      const mutationsStore = tx.objectStore('mutations');
      const metaStore = tx.objectStore('meta');

      const mutationRequest = mutationsStore.get(mutationId);
      const habitRequest = habitsStore.get(snapshot.habitId);
      const habitsRequest = habitsStore.getAll();
      const metaRequest = metaStore.get(RUNTIME_META_ID);
      let existingMutation;
      let habitRow;
      let habitRows = [];
      let runtimeMeta;
      let readyCount = 0;
      let duplicate = false;
      let noChange = false;
      let nextRevision = null;
      let assignedLegacyIndex = null;
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
          fail(staleGenerationError(expectedGeneration, String(nextGeneration), 'presence-in-flight'));
        });
      }

      const prepare = () => {
        readyCount += 1;
        if (readyCount !== 4 || prepared || settled) return;
        prepared = true;
        try {
          const durableGeneration = currentGeneration({ create: false });
          if (durableGeneration !== expectedGeneration) {
            generationInvalidated = true;
            generationInvalidations += 1;
            throw staleGenerationError(expectedGeneration, durableGeneration, 'presence-prepare');
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
            throw staleGenerationError(expectedGeneration, runtimeMeta.resetGeneration, 'presence-meta');
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
              mutationType: 'habit-presence-sync',
              habitId: snapshot.habitId,
              detectedAtISO: nowIso()
            };
            mark('stateV2.revisionConflict', lastRevisionConflict);
            throw revisionConflictError(Number(expectedRevision), actualRevision, 'presence-meta');
          }

          if (snapshot.exists) {
            if (habitRow?.value && stableJson(habitRow.value) === stableJson(snapshot.habit)) {
              noChange = true;
              return;
            }
            if (habitRow && Number.isFinite(Number(habitRow.legacyIndex))) {
              assignedLegacyIndex = Number(habitRow.legacyIndex);
            } else {
              assignedLegacyIndex = habitRows.reduce((max, row) => {
                const value = Number(row?.legacyIndex);
                return Number.isFinite(value) && value > max ? value : max;
              }, -1) + 1;
            }
            habitsStore.put({
              ...(habitRow || {}),
              id: snapshot.habitId,
              legacyIndex: assignedLegacyIndex,
              value: clone(snapshot.habit)
            });
          } else {
            if (!habitRow?.value) {
              noChange = true;
              return;
            }
            assignedLegacyIndex = Number.isFinite(Number(habitRow.legacyIndex)) ? Number(habitRow.legacyIndex) : null;
            habitsStore.delete(snapshot.habitId);
          }

          nextRevision = actualRevision + 1;
          mutationsStore.put({
            id: mutationId,
            schemaVersion: SCHEMA_VERSION,
            type: 'habit-presence-sync',
            source: snapshot.source || 'legacy-habit-presence-dark-mirror',
            status: 'committed',
            action: snapshot.exists ? 'upsert' : 'delete',
            previousRevision: actualRevision,
            revision: nextRevision,
            resetGeneration: expectedGeneration,
            createdAtISO: nowIso(),
            habitId: snapshot.habitId,
            assignedLegacyIndex
          });
          metaStore.put({
            ...runtimeMeta,
            id: RUNTIME_META_ID,
            schemaVersion: SCHEMA_VERSION,
            revision: nextRevision,
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
      habitsRequest.onsuccess = () => { habitRows = habitsRequest.result || []; prepare(); };
      metaRequest.onsuccess = () => { runtimeMeta = metaRequest.result || null; prepare(); };
      mutationRequest.onerror = () => fail(mutationRequest.error || new Error('state_runtime_v2_presence_mutation_read_failed'));
      habitRequest.onerror = () => fail(habitRequest.error || new Error('state_runtime_v2_presence_habit_read_failed'));
      habitsRequest.onerror = () => fail(habitsRequest.error || new Error('state_runtime_v2_presence_habits_read_failed'));
      metaRequest.onerror = () => fail(metaRequest.error || new Error('state_runtime_v2_presence_meta_read_failed'));

      tx.oncomplete = () => {
        if (settled) return;
        const durableGeneration = currentGeneration({ create: false });
        if (durableGeneration !== expectedGeneration || generationInvalidated) {
          settled = true;
          unsubscribeGeneration();
          generationInvalidations += 1;
          const error = staleGenerationError(expectedGeneration, durableGeneration, 'presence-after-commit');
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
        if (noChange) {
          lastKnownRevision = Number(runtimeMeta?.revision || lastKnownRevision || 0);
          resolve({
            committed: false,
            duplicate: false,
            noChange: true,
            mutationId,
            revision: lastKnownRevision,
            resetGeneration: expectedGeneration,
            habitId: snapshot.habitId,
            exists: snapshot.exists
          });
          return;
        }

        mirroredMutations += 1;
        mirroredPresenceMutations += 1;
        lastMutationId = mutationId;
        lastKnownRevision = nextRevision;
        lastRevisionConflict = null;
        mark('stateV2.darkHabitPresenceCommitted', {
          mutationId,
          revision: nextRevision,
          resetGeneration: expectedGeneration,
          habitId: snapshot.habitId,
          exists: snapshot.exists,
          assignedLegacyIndex
        });
        resolve({
          committed: true,
          duplicate: false,
          mutationId,
          revision: nextRevision,
          resetGeneration: expectedGeneration,
          habitId: snapshot.habitId,
          exists: snapshot.exists,
          assignedLegacyIndex
        });
      };
      tx.onabort = () => {
        if (settled) return;
        if (generationInvalidated) {
          finishReject(staleGenerationError(expectedGeneration, currentGeneration({ create: false }), 'presence-abort'));
          return;
        }
        finishReject(tx.error || new Error('state_runtime_v2_presence_mutation_aborted'));
      };
      tx.onerror = () => undefined;
    });
  }

  function enqueueHabitDelta(delta) {
    if (!isDarkEnabled()) return mirrorTail;
    const snapshot = clone(delta);
    const expectedGeneration = currentGeneration();
    mirrorTail = mirrorTail
      .then(() => api.applyHabitDelta(snapshot, { expectedGeneration }))
      .catch((error) => {
        mirrorFailures += 1;
        lastError = String(error?.message || error);
        mark('stateV2.darkMutationFailed', { message: lastError, resetGeneration: expectedGeneration, habitId: snapshot?.habitId || null, dayKey: snapshot?.dayKey || null });
        console.warn('TaskPoints V2 dark mirror failed; production state remains authoritative.', error);
      });
    return mirrorTail;
  }

  function enqueueHabitOrderOverlay(payload) {
    if (!isDarkEnabled()) return mirrorTail;
    const snapshot = clone(payload);
    const expectedGeneration = currentGeneration();
    mirrorTail = mirrorTail
      .then(async () => {
        try {
          return await api.applyHabitOrderOverlay(snapshot, { expectedGeneration });
        } catch (error) {
          if (error?.code === 'STATE_RUNTIME_V2_REVISION_CONFLICT') {
            return api.applyHabitOrderOverlay(snapshot, { expectedGeneration });
          }
          throw error;
        }
      })
      .catch((error) => {
        mirrorFailures += 1;
        lastError = String(error?.message || error);
        mark('stateV2.darkOrderMutationFailed', {
          message: lastError,
          resetGeneration: expectedGeneration,
          entries: Object.keys(snapshot?.orders || {}).length
        });
        console.warn('TaskPoints V2 dark reorder mirror failed; production state remains authoritative.', error);
      });
    return mirrorTail;
  }

  function enqueueHabitEditFromLegacy(habitIdInput, options = {}) {
    if (!isDarkEnabled()) return mirrorTail;
    const habitId = String(habitIdInput || '').trim();
    if (!habitId) return mirrorTail;
    let snapshot;
    try {
      snapshot = captureHabitEditSnapshotFromLegacy(habitId, options);
    } catch (error) {
      mirrorFailures += 1;
      lastError = String(error?.message || error);
      mark('stateV2.darkHabitEditCaptureFailed', { habitId, message: lastError });
      return Promise.resolve({ committed: false, reason: 'capture_failed', error: lastError });
    }
    const expectedGeneration = currentGeneration();
    mirrorTail = mirrorTail
      .then(async () => {
        try {
          return await api.applyHabitEditSnapshot(snapshot, { expectedGeneration });
        } catch (error) {
          if (error?.code === 'STATE_RUNTIME_V2_REVISION_CONFLICT') {
            const refreshed = captureHabitEditSnapshotFromLegacy(habitId, options);
            return api.applyHabitEditSnapshot(refreshed, { expectedGeneration });
          }
          throw error;
        }
      })
      .catch((error) => {
        mirrorFailures += 1;
        lastError = String(error?.message || error);
        mark('stateV2.darkHabitEditFailed', {
          message: lastError,
          resetGeneration: expectedGeneration,
          habitId
        });
        console.warn('TaskPoints V2 dark Habit edit mirror failed; production state remains authoritative.', error);
      });
    return mirrorTail;
  }

  function enqueueHabitPresenceFromLegacy(habitIdInput, options = {}) {
    if (!isDarkEnabled()) return mirrorTail;
    const habitId = String(habitIdInput || '').trim();
    if (!habitId) return mirrorTail;
    let snapshot;
    try {
      snapshot = captureHabitPresenceSnapshotFromLegacy(habitId, options);
    } catch (error) {
      mirrorFailures += 1;
      lastError = String(error?.message || error);
      mark('stateV2.darkHabitPresenceCaptureFailed', { habitId, message: lastError });
      return Promise.resolve({ committed: false, reason: 'capture_failed', error: lastError });
    }
    const expectedGeneration = currentGeneration();
    mirrorTail = mirrorTail
      .then(async () => {
        try {
          return await api.applyHabitPresenceSnapshot(snapshot, { expectedGeneration });
        } catch (error) {
          if (error?.code === 'STATE_RUNTIME_V2_REVISION_CONFLICT') {
            const refreshed = captureHabitPresenceSnapshotFromLegacy(habitId, options);
            return api.applyHabitPresenceSnapshot(refreshed, { expectedGeneration });
          }
          throw error;
        }
      })
      .catch((error) => {
        mirrorFailures += 1;
        lastError = String(error?.message || error);
        mark('stateV2.darkHabitPresenceFailed', {
          message: lastError,
          resetGeneration: expectedGeneration,
          habitId
        });
        console.warn('TaskPoints V2 dark Habit presence mirror failed; production state remains authoritative.', error);
      });
    return mirrorTail;
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

  function completionCompatibilityBase(completion) {
    if (completion?.id != null && String(completion.id) !== '') return `id:${String(completion.id)}`;
    return `pilot:${String(completion?.source || '')}:${String(completion?.habitId || '')}:${String(completion?.dayKey || '')}`;
  }

  function indexPilotCompletionOccurrences(completions) {
    const occurrences = new Map();
    return (Array.isArray(completions) ? completions : [])
      .filter(isPilotCompletion)
      .map((value) => {
        const base = completionCompatibilityBase(value);
        const occurrence = occurrences.get(base) || 0;
        occurrences.set(base, occurrence + 1);
        return { key: `${base}:${occurrence}`, value: clone(value) };
      });
  }

  function mergeCompatibilityCompletions(legacyCompletions, v2Completions) {
    const legacy = Array.isArray(legacyCompletions) ? legacyCompletions : [];
    const v2Indexed = indexPilotCompletionOccurrences(v2Completions);
    const v2ByKey = new Map(v2Indexed.map((row) => [row.key, row.value]));
    const consumed = new Set();
    const legacyOccurrences = new Map();
    const merged = [];

    legacy.forEach((completion) => {
      if (!isPilotCompletion(completion)) {
        merged.push(clone(completion));
        return;
      }
      const base = completionCompatibilityBase(completion);
      const occurrence = legacyOccurrences.get(base) || 0;
      legacyOccurrences.set(base, occurrence + 1);
      const key = `${base}:${occurrence}`;
      if (!v2ByKey.has(key)) return;
      consumed.add(key);
      merged.push(clone(v2ByKey.get(key)));
    });

    // A V2-only pilot completion has no legacy slot yet. Its V2 sequence/order is
    // already newest-first, so prepend it without disturbing the exact relative
    // order of every legacy-only completion class.
    const v2Only = v2Indexed
      .filter((row) => !consumed.has(row.key))
      .map((row) => clone(row.value));
    return clone([...v2Only, ...merged]);
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
      completions: mergeCompatibilityCompletions(source.state.completions, collections.completions)
    };
  }

  // Home renderHabits recomputes exactly these fields for display/sorting.
  // Exclude them only from parity; stored records and compatibility exports stay intact.
  const DERIVED_HABIT_CACHE_FIELDS = ['__streak', '__completion', '__failedStreak'];

  // Legacy full Habit completions historically may omit completionFraction.
  // Production verification already treats that omission as canonical 1. Keep
  // parity strict for half/custom fractions while honoring the same full-row
  // compatibility semantic. This projection never mutates either data source.
  function normalizePilotCompletionForParity(completion) {
    if (!completion || typeof completion !== 'object') return completion;
    const copy = { ...completion };
    if (copy.completionFraction == null) copy.completionFraction = 1;
    return copy;
  }

  function parityInput(state) {
    return {
      habits: Array.isArray(state?.habits) ? state.habits : [],
      completions: pilotCompletions(state)
    };
  }

  function paritySubset(state) {
    const scoped = parityInput(state);
    return {
      habits: scoped.habits.map((habit) => {
        if (!habit || typeof habit !== 'object') return habit;
        const copy = { ...habit };
        for (const field of DERIVED_HABIT_CACHE_FIELDS) delete copy[field];
        return copy;
      }),
      completions: scoped.completions.map(normalizePilotCompletionForParity)
    };
  }

  // Diagnostic only: run alongside idle/explicit parity, never on mutation capture.
  // Preserve ordering and duplicate IDs; expose bounded field diagnostics, not full records.
  function parityDifferences(expected, actual) {
    const samples = [];
    const collections = {};
    const limit = 20;
    const sampleCounts = { habits: 0, completions: 0 };
    const ignoredDerivedCacheDifferences = { records: 0, fields: Object.fromEntries(DERIVED_HABIT_CACHE_FIELDS.map((field) => [field, 0])) };
    for (const collection of ['habits', 'completions']) {
      const left = expected[collection] || [];
      const right = actual[collection] || [];
      const index = (rows) => {
        const occurrences = new Map();
        return rows.map((value, position) => {
          const normalizedValue = collection === 'completions'
            ? normalizePilotCompletionForParity(value)
            : value;
          const id = normalizedValue?.id == null ? null : String(normalizedValue.id);
          const base = id === null ? `missing:${position}` : `id:${id}`;
          const occurrence = occurrences.get(base) || 0;
          occurrences.set(base, occurrence + 1);
          return { key: `${base}:${occurrence}`, id, occurrence, position, value: normalizedValue };
        });
      };
      const leftRows = index(left);
      const rightRows = index(right);
      const rightMap = new Map(rightRows.map((row) => [row.key, row]));
      const counts = { missing: 0, extra: 0, changed: 0, moved: 0 };
      const sampleBuckets = { missing: [], extra: [], changed: [], moved: [] };
      const add = (row, kind, other, fields = []) => {
        counts[kind] += 1;
        if (sampleBuckets[kind].length >= limit) return;
        sampleBuckets[kind].push({
          collection, kind, id: row.id, occurrence: row.occurrence,
          expectedIndex: kind === 'extra' ? null : row.position,
          actualIndex: kind === 'missing' ? null : (other || row).position,
          fields: fields.slice(0, 20), fieldsTruncated: fields.length > 20,
          fieldDetails: fields.slice(0, 20).map((field) => {
            const describe = (record) => {
              if (!Object.prototype.hasOwnProperty.call(record || {}, field)) return { present: false };
              const value = record[field];
              const text = stableJson(value) ?? 'undefined';
              const summary = { present: true, type: value === null ? 'null' : typeof value, hash: fnv1a(text), length: text.length };
              // Bounded timing/scoring evidence; names, titles and arbitrary text stay out.
              if (['updatedAtISO', 'completedAtISO', 'dayKey', 'points', 'completionFraction'].includes(field)
                && (value === null || typeof value === 'number' || (typeof value === 'string' && value.length <= 40))) summary.value = value;
              return summary;
            };
            return { field, expected: describe(row.value), actual: describe(other?.value) };
          })
        });
      };
      for (const row of leftRows) {
        const other = rightMap.get(row.key);
        if (!other) { add(row, 'missing'); continue; }
        rightMap.delete(row.key);
        if (row.position !== other.position) add(row, 'moved', other);
        if (stableJson(row.value) !== stableJson(other.value)) {
          const allFields = [...new Set([...Object.keys(row.value || {}), ...Object.keys(other.value || {})])]
            .filter((field) => Object.prototype.hasOwnProperty.call(row.value || {}, field) !== Object.prototype.hasOwnProperty.call(other.value || {}, field)
              || stableJson(row.value?.[field]) !== stableJson(other.value?.[field]));
          const ignored = collection === 'habits' ? allFields.filter((field) => DERIVED_HABIT_CACHE_FIELDS.includes(field)) : [];
          if (ignored.length) {
            ignoredDerivedCacheDifferences.records += 1;
            for (const field of ignored) ignoredDerivedCacheDifferences.fields[field] += 1;
          }
          const fields = allFields.filter((field) => !ignored.includes(field));
          if (fields.length) add(row, 'changed', other, fields);
        }
      }
      for (const row of rightMap.values()) add(row, 'extra');

      // A single insertion/removal can make thousands of otherwise-equal rows
      // appear "moved". Preserve the scarce sample budget for actionable
      // membership/content mismatches first so the trace never hides the real
      // missing/extra IDs behind that positional cascade.
      for (const kind of ['missing', 'extra', 'changed', 'moved']) {
        for (const sample of sampleBuckets[kind]) {
          if (sampleCounts[collection] >= limit) break;
          samples.push(sample);
          sampleCounts[collection] += 1;
        }
        if (sampleCounts[collection] >= limit) break;
      }
      collections[collection] = counts;
    }
    const total = Object.values(collections).reduce((sum, counts) => sum + Object.values(counts).reduce((a, b) => a + b, 0), 0);
    return { collections, samples, sampleCounts, truncated: total > samples.length, sampleLimit: limit * 2, sampleLimitPerCollection: limit, ignoredDerivedCacheDifferences };
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
    const expected = sourceSubset(source.state);
    const expectedScoped = parityInput(expected);
    const actualScoped = parityInput(collections);
    const expectedText = stableJson(paritySubset(expectedScoped));
    const actualText = stableJson(paritySubset(actualScoped));
    const hasRawDifferences = expectedText !== actualText || stableJson(expectedScoped.habits) !== stableJson(actualScoped.habits);
    const diagnostics = hasRawDifferences ? parityDifferences(expectedScoped, actualScoped) : null;
    lastParity = {
      checked: true,
      match: expectedText === actualText,
      expectedHash: `${fnv1a(expectedText)}:${expectedText.length}`,
      actualHash: `${fnv1a(actualText)}:${actualText.length}`,
      comparisonScope: 'habit_records_plus_habit_vice_completions_normalizing_full_fraction',
      ignoredHabitCacheFields: [...DERIVED_HABIT_CACHE_FIELDS],
      ignoredDerivedCacheDifferences: diagnostics?.ignoredDerivedCacheDifferences || null,
      differences: expectedText === actualText ? null : diagnostics,
      expectedCounts: { habits: expectedScoped.habits.length, completions: expectedScoped.completions.length },
      actualCounts: { habits: actualScoped.habits.length, completions: actualScoped.completions.length },
      scopeExcludedCounts: {
        expectedCompletions: Math.max(0, source.state.completions.length - expectedScoped.completions.length),
        actualCompletions: Math.max(0, collections.completions.length - actualScoped.completions.length)
      },
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
      mirroredOrderMutations,
      mirroredEditMutations,
      mirroredPresenceMutations,
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
      walMode: 'v2_generation_stamped_wal_with_revision_conflict_guard_and_legacy_authority',
      habitOrderDurability: 'production_habit_order_overlay',
      habitEditDurability: 'persisted_legacy_habit_subset_after_home_save',
      habitPresenceDurability: 'persisted_legacy_habit_presence_after_home_save'
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
      if (mutation?.type === 'habit-completion-set' && mutation?.delta) {
        return api.applyHabitDelta(mutation.delta, {
          expectedGeneration: mutation.generation || undefined,
          expectedRevision: mutation.expectedRevision ?? undefined
        });
      }
      if (mutation?.type === 'habit-order-set' && mutation?.overlay) {
        return api.applyHabitOrderOverlay(mutation.overlay, {
          expectedGeneration: mutation.generation || undefined,
          expectedRevision: mutation.expectedRevision ?? undefined
        });
      }
      if (mutation?.type === 'habit-edit-sync' && mutation?.snapshot) {
        return api.applyHabitEditSnapshot(mutation.snapshot, {
          expectedGeneration: mutation.generation || undefined,
          expectedRevision: mutation.expectedRevision ?? undefined
        });
      }
      if (mutation?.type === 'habit-presence-sync' && mutation?.snapshot) {
        return api.applyHabitPresenceSnapshot(mutation.snapshot, {
          expectedGeneration: mutation.generation || undefined,
          expectedRevision: mutation.expectedRevision ?? undefined
        });
      }
      return Promise.reject(new Error('state_runtime_v2_unsupported_dark_mutation'));
    },
    applyHabitDelta,
    applyHabitOrderOverlay,
    enqueueHabitOrderOverlay,
    captureHabitEditSnapshotFromLegacy,
    applyHabitEditSnapshot,
    enqueueHabitEditFromLegacy,
    captureHabitPresenceSnapshotFromLegacy,
    applyHabitPresenceSnapshot,
    enqueueHabitPresenceFromLegacy,
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
