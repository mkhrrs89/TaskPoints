(function installTaskPointsStateRuntimeV2(global) {
  'use strict';

  const core = global?.TaskPointsCore;
  if (!global || !core || global.TaskPointsStateRuntimeV2?.__installedModule) return;

  const DB_NAME = 'taskpoints_state_v2';
  const DB_VERSION = 2;
  const COMPLETION_HABIT_INDEX = 'by_habit_ids';
  const EXCLUSIVE_WRITER_REHEARSAL_LOCK = 'taskpoints_v2_writer_handoff_rehearsal_v1';
  const PEER_COORDINATION_CHANNEL = 'taskpoints_v2_preview_writer_peers_v1';
  const PREVIEW_RECOVERY_DB = 'taskpoints_v2_recovery_checkpoints_preview';
  const PREVIEW_RECOVERY_STORE = 'snapshots';
  const PREVIEW_RECOVERY_SCHEMA = 1;
  const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
  const WAL_TEST_ACTIVE_GLOBAL = '__taskpointsStateV2WalKillHoldV1';
  const GENERATION_KEY = 'taskpoints_state_v2_generation_v1';
  const REVISION_SIGNAL_KEY = 'taskpoints_state_v2_revision_signal_v1';
  const REVISION_CHANNEL_NAME = 'taskpoints_state_v2_revision_v1';
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
  const contextId = global.crypto?.randomUUID?.() || `v2-context:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const contextStartedEpochMs = Date.now();
  let revisionChannel = null;
  let peerCoordinationChannel = null;
  let revisionInvalidationListenersInstalled = false;
  let externalRevisionInvalidated = false;
  let externalRevision = null;
  let externalRevisionMutationId = null;
  let externalRevisionAtISO = null;
  let externalRevisionSource = null;
  let externalRevisionReloadRequests = 0;
  // The generation attached to this Home page's in-memory view. A different
  // localStorage generation means an authorized replacement occurred while
  // this page was open, even if no same-generation revision signal was sent.
  let interactionPageGeneration = null;
  let generationInteractionReloadRequests = 0;
  let generationInteractionSafetyBlocks = 0;
  // Ephemeral diagnostic toggle only. This is deliberately NOT persisted,
  // and never routes live Home reads away from the V1 authority.
  let pilotReadProbeEnabled = false;
  let pilotReadProbeEpoch = 0;
  let darkMirrorModeEpoch = 0;
  let pilotReadProbeChecks = 0;
  let pilotReadProbeMatches = 0;
  let pilotReadProbeRefusals = 0;


  function nowIso() { return new Date().toISOString(); }

  function mark(name, detail = {}) {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
  }

  function isWalTestPreviewHost() {
    const hostname = String(global.location?.hostname || '').toLowerCase();
    if (hostname === 'taskpoints.pages.dev' || hostname === 'www.taskpoints.pages.dev') return false;
    return hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname.endsWith('.taskpoints.pages.dev');
  }

  function isPreviewWalTestHoldActive() {
    return isWalTestPreviewHost() && global[WAL_TEST_ACTIVE_GLOBAL] === true;
  }

  function waitForPreviewWalTestRestart(detail = {}) {
    if (!isPreviewWalTestHoldActive()) return Promise.resolve();
    mark('stateV2.walTestHoldApplied', { source: 'runtime_enqueue', holdMode: 'until_restart', ...detail });
    // Deliberately never resolves in this page lifetime. A real reload/restart
    // creates a fresh JS context, removing the preview-only in-memory hold.
    return new Promise(() => undefined);
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

  function parseRevisionSignal(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(String(value)); }
    catch (_) { return null; }
  }

  function acceptRevisionSignal(value, source = 'unknown') {
    if (!isDarkEnabled()) return false;
    const signal = parseRevisionSignal(value);
    if (!signal || String(signal.sourceId || '') === String(contextId)) return false;
    const revision = Number(signal.revision);
    const epochMs = Number(signal.epochMs);
    if (!Number.isFinite(revision) || revision < 0) return false;
    const generation = currentGeneration({ create: false });
    if (!generation || String(signal.generation || '') !== String(generation)) return false;
    if (Number.isFinite(epochMs) && epochMs < contextStartedEpochMs) return false;
    const knownRevision = Number(lastKnownRevision);
    if (Number.isFinite(knownRevision) && revision <= knownRevision) return false;

    externalRevisionInvalidated = true;
    externalRevision = revision;
    externalRevisionMutationId = signal.mutationId != null ? String(signal.mutationId) : null;
    externalRevisionAtISO = signal.atISO != null ? String(signal.atISO) : null;
    externalRevisionSource = String(source || 'unknown');
    mark('stateV2.externalRevisionInvalidated', {
      revision,
      observedRevision: Number.isFinite(knownRevision) ? knownRevision : null,
      mutationId: externalRevisionMutationId,
      source: externalRevisionSource
    });
    return true;
  }

  function checkForExternalRevisionSignal() {
    return acceptRevisionSignal(safeGet(REVISION_SIGNAL_KEY), 'persisted_signal');
  }

  // Unlike the best-effort UI signal listener, storage inspection for a
  // preview-consistency gate is safety-critical. A denied read cannot be
  // interpreted as "no other tab committed anything."
  function inspectDurableRevisionSignal() {
    const storage = global.localStorage;
    if (!storage || typeof storage.getItem !== 'function') return false;
    try {
      acceptRevisionSignal(storage.getItem(REVISION_SIGNAL_KEY), 'persisted_signal');
      return true;
    } catch (_) {
      return false;
    }
  }

  function installRevisionInvalidationListeners() {
    if (!isDarkEnabled() || revisionInvalidationListenersInstalled) return revisionInvalidationListenersInstalled;
    revisionInvalidationListenersInstalled = true;

    if (typeof global.BroadcastChannel === 'function') {
      try {
        revisionChannel = new global.BroadcastChannel(REVISION_CHANNEL_NAME);
        revisionChannel.addEventListener?.('message', (event) => acceptRevisionSignal(event?.data, 'broadcast_channel'));
        if (!revisionChannel.addEventListener) revisionChannel.onmessage = (event) => acceptRevisionSignal(event?.data, 'broadcast_channel');
      } catch (_) {
        revisionChannel = null;
      }
    }

    global.addEventListener?.('storage', (event) => {
      if (String(event?.key || '') !== REVISION_SIGNAL_KEY) return;
      acceptRevisionSignal(event?.newValue, 'storage_event');
    });
    global.addEventListener?.('pageshow', () => checkForExternalRevisionSignal());
    global.document?.addEventListener?.('visibilitychange', () => {
      if (global.document?.visibilityState === 'visible' || global.document?.hidden === false) {
        checkForExternalRevisionSignal();
      }
    });
    return true;
  }

  // Passive preview-only coordination. A participating V2 tab can answer a
  // challenge without writing localStorage, acquiring a production lease, or
  // changing the V1 mutation path. Absence of an answer NEVER proves that a
  // legacy tab is absent: pre-V2 pages, suspended tabs and unsupported browsers
  // may write without participating in this protocol.
  function installPreviewPeerResponder() {
    if (peerCoordinationChannel) return true;
    if (!isDarkEnabled() || typeof global.BroadcastChannel !== 'function')
      return false;
    try {
      const channel = new global.BroadcastChannel(PEER_COORDINATION_CHANNEL);
      const respond = event => {
        const message = event?.data;
        if (message?.type !== 'writer_probe_v1'
          || typeof message.probeId !== 'string' || message.probeId.length > 128
          || !message.probeId || message.sourceId === contextId) return;
        try {
          channel.postMessage({
            type: 'writer_probe_ack_v1', probeId: message.probeId,
            sourceId: contextId,
            previewEnabled: isDarkEnabled(),
            generation: currentGeneration({ create: false }),
            webLocksSupported: typeof global.navigator?.locks?.request === 'function'
          });
        } catch (_) {}
      };
      if (typeof channel.addEventListener === 'function')
        channel.addEventListener('message', respond);
      else channel.onmessage = respond;
      peerCoordinationChannel = channel;
      return true;
    } catch (_) { return false; }
  }

  // Cross-tab discovery is an observational rehearsal, NOT writer fencing.
  // A zero-peer response is not a single-tab guarantee. Even when every
  // responding peer supports Web Locks, normal V1 mutation entry points do
  // not acquire a production lock, so the result is never promotable.
  async function inspectPreviewWriterPeers() {
    const report = (reason, peers = []) => ({
      checked: true, reason,
      observedPeerCount: peers.length,
      peers: peers.map(peer => ({
        previewEnabled: peer.previewEnabled === true,
        sameGeneration: peer.sameGeneration === true,
        webLocksSupported: peer.webLocksSupported === true
      })),
      respondingPreviewTabsOnly: true,
      allLegacyWritersKnown: false,
      productionWritersFenced: false,
      canPromote: false, mutationAuthority: 'legacy_only', readAuthority: 'legacy_only'
    });
    if (!isDarkEnabled()) return report('dark_disabled');
    if (!installPreviewPeerResponder()
      || typeof global.setTimeout !== 'function')
      return report('coordination_channel_unavailable');
    const generation = currentGeneration({ create: false });
    if (!generation) return report('generation_unavailable');
    const startingModeEpoch = darkMirrorModeEpoch;
    let probe = null;
    try {
      probe = new global.BroadcastChannel(PEER_COORDINATION_CHANNEL);
      const probeId = global.crypto?.randomUUID?.()
        || `probe:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const peers = new Map();
      const listen = event => {
        const data = event?.data;
        if (data?.type !== 'writer_probe_ack_v1'
          || data.probeId !== probeId || typeof data.sourceId !== 'string'
          || !data.sourceId || data.sourceId === contextId) return;
        peers.set(data.sourceId, {
          previewEnabled: data.previewEnabled === true,
          sameGeneration: data.generation === generation,
          webLocksSupported: data.webLocksSupported === true
        });
      };
      if (typeof probe.addEventListener === 'function')
        probe.addEventListener('message', listen);
      else probe.onmessage = listen;
      probe.postMessage({ type: 'writer_probe_v1', probeId, sourceId: contextId });
      // Fixed, short, explicit observation window. This is intentionally not
      // a durable membership or heartbeat service and carries no data blobs.
      await new Promise(resolve => global.setTimeout(resolve, 120));
      if (!isDarkEnabled() || startingModeEpoch !== darkMirrorModeEpoch
        || currentGeneration({ create: false }) !== generation)
        return report('probe_window_changed');
      const observed = [...peers.values()];
      return report(observed.some(p => !p.previewEnabled || !p.sameGeneration
        || !p.webLocksSupported) ? 'observed_peer_not_ready'
        : 'observational_probe_only', observed);
    } catch (_) {
      return report('coordination_probe_failed');
    } finally {
      try { probe?.close(); } catch (_) {}
    }
  }

  function publishCommittedRevision(revisionInput, mutationId, generationInput) {
    if (!isDarkEnabled()) return false;
    const revision = Number(revisionInput);
    if (!Number.isFinite(revision)) return false;
    const generation = String(generationInput || currentGeneration({ create: false }) || '');
    if (!generation) return false;
    const payload = {
      version: 1,
      sourceId: contextId,
      revision,
      mutationId: mutationId != null ? String(mutationId) : null,
      generation,
      epochMs: Date.now(),
      atISO: nowIso()
    };
    safeSet(REVISION_SIGNAL_KEY, JSON.stringify(payload));
    try { revisionChannel?.postMessage?.(payload); } catch (_) {}
    mark('stateV2.revisionPublished', {
      revision,
      mutationId: payload.mutationId,
      generation,
      broadcastChannel: Boolean(revisionChannel)
    });
    return true;
  }

  function beforeHabitInteraction(detail = {}) {
    let previewFlag = null;
    try {
      const storage = global.localStorage;
      if (!storage || typeof storage.getItem !== 'function') {
        throw new Error('preview_flag_storage_unavailable');
      }
      previewFlag = storage.getItem(DARK_MODE_KEY);
    } catch (error) {
      // A suspended V2 page must not mistake inaccessible storage for a
      // deliberate disabling of the preview: that would bypass the stale
      // generation guard and apply an old Habit view to newer V1 data.
      if (!interactionPageGeneration) return { proceed: true, reason: 'dark_unavailable_without_v2_page' };
      generationInteractionSafetyBlocks += 1;
      lastError = `state_runtime_v2_interaction_dark_mode_unreadable:${String(error?.message || error)}`;
      mark('stateV2.habitInteractionBlocked', { reason: 'dark_mode_unreadable' });
      return { proceed: false, reason: 'dark_mode_unreadable' };
    }
    if (previewFlag !== '1') return { proceed: true, reason: 'dark_disabled' };
    let durableGeneration = null;
    try {
      installRevisionInvalidationListeners();
      checkForExternalRevisionSignal();
      durableGeneration = currentGeneration({ create: false });
    } catch (error) {
      generationInteractionSafetyBlocks += 1;
      lastError = `state_runtime_v2_interaction_generation_unreadable:${String(error?.message || error)}`;
      mark('stateV2.habitInteractionBlocked', { reason: 'generation_unreadable' });
      // No stale-tap continuation can safely be stamped with an unknown epoch.
      // V1 authority and the existing WAL are left untouched until storage
      // becomes readable again; never run an old Home view against it.
      return { proceed: false, reason: 'generation_unreadable' };
    }
    if (!durableGeneration) {
      generationInteractionSafetyBlocks += 1;
      mark('stateV2.habitInteractionBlocked', { reason: 'generation_missing' });
      return { proceed: false, reason: 'generation_missing' };
    }
    const generationChanged = Boolean(interactionPageGeneration
      && String(interactionPageGeneration) !== String(durableGeneration));
    if (!externalRevisionInvalidated && !generationChanged) {
      return { proceed: true, reason: 'current' };
    }

    externalRevisionReloadRequests += 1;
    if (generationChanged) generationInteractionReloadRequests += 1;
    mark('stateV2.externalRevisionReloadRequested', {
      revision: externalRevision,
      mutationId: externalRevisionMutationId,
      source: externalRevisionSource,
      generationChanged,
      interactionPageGeneration,
      durableGeneration,
      habitId: detail?.habitId != null ? String(detail.habitId) : null,
      dayKey: detail?.dayKey != null ? String(detail.dayKey) : null
    });
    // A protected stale-tab reload must not silently swallow the user's
    // actual Habit tap. Save only its identity (not a stale state snapshot).
    // The Home fast-path controller will replay the normal toggle against
    // freshly loaded V1 authority after the navigation completes.
    const habitId = String(detail?.habitId || '').trim();
    const dayKey = String(detail?.dayKey || '').trim();
    let tapContinuationSaved = false;
    if (habitId && /^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
      try {
        // A resumed tap belongs to the *current* V1 generation: Home will
        // reload first, then run the unchanged toggle against fresh authority.
        // If another import occurs during navigation the continuation's
        // generation check discards it instead of replaying across boundaries.
        const generation = durableGeneration;
        const payload = {
          version: 1, habitId, dayKey, generation,
          pathname: String(global.location?.pathname || ''),
          createdEpochMs: Date.now()
        };
        global.sessionStorage?.setItem?.('taskpoints_v2_stale_habit_tap_v1', JSON.stringify(payload));
        tapContinuationSaved = global.sessionStorage?.getItem?.('taskpoints_v2_stale_habit_tap_v1')
          === JSON.stringify(payload);
      } catch (_) {}
    }
    try { global.location?.reload?.(); } catch (_) {}
    return {
      proceed: false,
      reason: generationChanged ? 'generation_changed' : 'external_revision_invalidated',
      reloadRequested: true,
      tapContinuationSaved,
      revision: externalRevision
    };
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

  function ensureStores(db, upgradeTransaction) {
    if (!db.objectStoreNames.contains('habits')) db.createObjectStore('habits', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('completions')) db.createObjectStore('completions', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('mutations')) db.createObjectStore('mutations', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
    const completions = upgradeTransaction.objectStore('completions');
    if (!completions.indexNames.contains(COMPLETION_HABIT_INDEX)) {
      completions.createIndex(COMPLETION_HABIT_INDEX, 'habitIds', { multiEntry: true });
    }
    // All legacy metadata corrections run inside the same versionchange
    // transaction as index creation. Any read/put error aborts the upgrade;
    // nothing is partially migrated and V1 remains authoritative.
    const rowsRequest = completions.getAll();
    rowsRequest.onsuccess = () => {
      try {
        for (const row of rowsRequest.result || []) {
          const corrected = withCompletionHabitIds(row);
          if (stableJson(row?.habitIds) !== stableJson(corrected.habitIds)) {
            completions.put(corrected);
          }
        }
      } catch (_) {
        try { upgradeTransaction.abort(); } catch (_) {}
      }
    };
    rowsRequest.onerror = () => {
      try { upgradeTransaction.abort(); } catch (_) {}
    };
  }

  function open() {
    if (!isDarkEnabled()) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    if (!global.indexedDB?.open) {
      const error = new Error('state_runtime_v2_indexeddb_unavailable');
      lastError = error.message;
      return Promise.reject(error);
    }

    let attempt = null;
    let abandoned = false;
    attempt = new Promise((resolve, reject) => {
      const request = global.indexedDB.open(DB_NAME, DB_VERSION);
      const fail = (error) => {
        lastError = String(error?.message || error);
        if (dbPromise === attempt) dbPromise = null;
        if (!abandoned) {
          abandoned = true;
          reject(error);
        }
      };
      request.onupgradeneeded = () => {
        // A blocked request cannot be cancelled by IndexedDB. If it later
        // obtains an upgrade transaction, abort it rather than unexpectedly
        // upgrading storage after the caller has already failed closed.
        if (abandoned) {
          try { request.transaction?.abort?.(); } catch (_) {}
          return;
        }
        try { ensureStores(request.result, request.transaction); }
        catch (_) { try { request.transaction?.abort?.(); } catch (_) {} }
      };
      request.onsuccess = () => {
        const connection = request.result;
        // A late success from an abandoned request must neither resurrect a
        // stale connection nor overwrite a newer open attempt.
        if (abandoned) {
          try { connection.close(); } catch (_) {}
          return;
        }
        connection.onversionchange = () => {
          externalRevisionInvalidated = true;
          lastError = 'state_runtime_v2_connection_version_changed';
          mark('stateV2.connectionVersionChanged', { database: DB_NAME });
          try { connection.close(); } catch (_) {}
          if (dbPromise === attempt) dbPromise = null;
        };
        opened = true;
        mark('stateV2.opened', { database: DB_NAME, version: DB_VERSION });
        resolve(connection);
      };
      request.onerror = () => {
        fail(request.error || new Error('state_runtime_v2_open_failed'));
      };
      request.onblocked = () => {
        fail(new Error('state_runtime_v2_open_blocked'));
      };
    });
    dbPromise = attempt;
    return dbPromise;
  }

  async function readMeta(db) {
    const tx = db.transaction('meta', 'readonly');
    const row = await requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID));
    return row || null;
  }

  async function inspectStartupMeta() {
    if (!isDarkEnabled()) return { checked: false, reason: 'dark_disabled', exists: false };
    const db = await open();
    if (!db) return { checked: false, reason: 'dark_disabled', exists: false };
    const meta = await readMeta(db);
    return {
      checked: true,
      exists: Boolean(meta),
      schemaVersion: meta?.schemaVersion ?? null,
      resetGeneration: meta?.resetGeneration ?? null,
      legacyMissing: meta?.legacyMissing === true,
      revision: Number.isFinite(Number(meta?.revision)) ? Number(meta.revision) : null
    };
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

  // An actual V1 Habit checkpoint changes the authoritative completion
  // baseline (completed/failed/icy days or pilot completion rows). Cosmetic
  // Habit edits and unrelated Task saves must not start a new ordering epoch.
  // Keep this separate from seedHash, which includes pending journal overlays.
  function canonicalCompletionCheckpointSignature(state) {
    const habits = (Array.isArray(state?.habits) ? state.habits : [])
      .filter(h => h?.id != null)
      .map(h => ({
        id: String(h.id),
        doneKeys: h.doneKeys || [],
        failedKeys: h.failedKeys || [],
        iceKeys: h.iceKeys || []
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const text = stableJson({ habits, completions: pilotCompletions(state) });
    return `${fnv1a(text)}:${text.length}`;
  }

  function readCanonicalPersistedCompletionSignature() {
    const raw = safeGet(core.STORAGE_KEY || 'taskpoints_v1');
    if (raw == null) return null;
    const saved = typeof core.parseTaskPointsStorageJson === 'function'
      ? core.parseTaskPointsStorageJson(raw, {}) : JSON.parse(raw);
    return canonicalCompletionCheckpointSignature(saved);
  }

  // V1's pending-Habit journal replays timestamps from oldest to newest and
  // unshifts each completion, so newest updatedAtISO comes first regardless of
  // IndexedDB commit timing. Reserve a disjoint numeric sequence range for
  // *new* canonical UTC journal timestamps; seeded/historical sequences remain
  // unchanged. This is an incremental ordering key, not a snapshot rewrite.
  // Equal timestamps remain subject to strict parity (V1's stable insertion
  // order cannot safely be inferred from independently committed V2 events).
  const JOURNAL_COMPLETION_SEQUENCE_BASE = 100000000000000;
  const JOURNAL_COMPLETION_EPOCH_SPAN = 6000000000000;
  function completionSequenceForJournalDelta(delta, fallbackSequence, epoch = 0) {
    const iso = String(delta?.updatedAtISO || '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso)) {
      return fallbackSequence;
    }
    const millis = Date.parse(iso);
    // A V1 compaction freezes the previous journal epoch as the new baseline.
    // Newly pending completions must sit ahead of that entire baseline, even
    // when the next journal event is backdated. Each epoch retains timestamp
    // ordering within itself. An exhausted rank aborts rather than risking an
    // unsafe ordering collision.
    const sequence = JOURNAL_COMPLETION_SEQUENCE_BASE
      + epoch * JOURNAL_COMPLETION_EPOCH_SPAN + millis;
    if (!Number.isSafeInteger(millis) || millis < 0
      || millis >= JOURNAL_COMPLETION_EPOCH_SPAN || !Number.isSafeInteger(epoch)
      || epoch < 0 || !Number.isSafeInteger(sequence)) {
      throw new Error('state_runtime_v2_journal_completion_epoch_exhausted');
    }
    return sequence;
  }

  // IndexedDB can index a multi-entry array on a completion *pack* only
  // when the array names every Habit represented by that pack. Duplicate
  // historical completion IDs can span different Habits; never infer the
  // owner from the pack's storage key or its first entry.
  function completionHabitIdsForRow(row) {
    const entries = Array.isArray(row?.entries)
      ? row.entries
      : (row && Object.prototype.hasOwnProperty.call(row, 'value') ? [row] : []);
    return Array.from(new Set(entries
      .map((entry) => entry?.value)
      .filter(isPilotCompletion)
      .map((completion) => String(completion.habitId).trim()))).sort();
  }

  function withCompletionHabitIds(row) {
    return { ...row, habitIds: completionHabitIdsForRow(row) };
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
    return Array.from(rows.values(), withCompletionHabitIds);
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

  // Protect a full seed and the mutation ledger from another tab advancing the
  // same IndexedDB database after this tab read its startup metadata. The check
  // and all replacement writes share one readwrite transaction, so a newer
  // committed revision cannot be wiped by a late startup continuation.
  async function guardedSeedReplace(db, previousMeta, replaceRows) {
    const tx = db.transaction(STORE_NAMES, 'readwrite');
    const metaStore = tx.objectStore('meta');
    const request = metaStore.get(RUNTIME_META_ID);
    let failure = null;
    request.onsuccess = () => {
      const currentMeta = request.result || null;
      if (stableJson(currentMeta) !== stableJson(previousMeta || null)) {
        failure = revisionConflictError(
          previousMeta?.revision ?? null, currentMeta?.revision ?? null, 'seed-precondition'
        );
        mark('stateV2.concurrentSeedBlocked', {
          expectedRevision: previousMeta?.revision ?? null,
          actualRevision: currentMeta?.revision ?? null
        });
        tx.abort();
        return;
      }
      try { replaceRows(tx); }
      catch (error) { failure = error; tx.abort(); }
    };
    try { await transactionPromise(tx); }
    catch (error) { throw failure || error; }
  }

  async function clearForMissingLegacy(db, previousMeta = null, resetGeneration = currentGeneration()) {
    const revision = Number(previousMeta?.revision || 0) + 1;
    await guardedSeedReplace(db, previousMeta, (tx) => {
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
    });
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
    const completionStore = tx.objectStore('completions');
    const completionIndexPresent = completionStore.indexNames.contains(COMPLETION_HABIT_INDEX);
    const completionsRequest = completionStore.getAll();
    const [habitRows, completionRows] = await Promise.all([
      requestPromise(habitsRequest),
      requestPromise(completionsRequest)
    ]);
    const habits = (habitRows || [])
      .slice()
      .sort((a, b) => Number(a.legacyIndex || 0) - Number(b.legacyIndex || 0))
      .map((row) => clone(row.value));
    const completions = unpackCompletionRows(completionRows);
    const completionIndexReady = completionIndexPresent && (completionRows || []).every(
      row => Array.isArray(row?.habitIds)
        && stableJson(row.habitIds) === stableJson(completionHabitIdsForRow(row))
    );
    return { habits, completions, completionIndexReady };
  }

  // Target only one Habit object rather than materializing every Habit in
  // the candidate read. Completion rows still need an all-row scan: historical
  // duplicate-ID packs can contain entries for different Habits and the
  // existing database has no validated per-Habit completion index. Filtering
  // before cloning keeps the result bounded without changing their order.
  // The outer readiness checks continue verifying the entire pilot scope.
  async function readPilotHabitRowsFromDb(db, habitId, indexed = false) {
    const tx = db.transaction(['habits', 'completions'], 'readonly');
    const habitRequest = tx.objectStore('habits').get(habitId);
    const completionsStore = tx.objectStore('completions');
    // A missing or corrupt index never substitutes a partial result.
    const useIndex = indexed && completionsStore.indexNames.contains(COMPLETION_HABIT_INDEX);
    const completionRequest = useIndex
      ? completionsStore.index(COMPLETION_HABIT_INDEX).getAll(habitId)
      : completionsStore.getAll();
    const [habitRow, completionRows] = await Promise.all([
      requestPromise(habitRequest), requestPromise(completionRequest)
    ]);
    const matching = [];
    for (const row of completionRows || []) {
      if (Array.isArray(row?.entries)) {
        for (const entry of row.entries) {
          if (String(entry?.value?.habitId ?? '') === habitId) {
            matching.push({ sequence: Number(entry?.sequence || 0), value: entry.value });
          }
        }
      } else if (row && Object.prototype.hasOwnProperty.call(row, 'value')
        && String(row.value?.habitId ?? '') === habitId) {
        matching.push({ sequence: Number(row.sequence || 0), value: row.value });
      }
    }
    matching.sort((a, b) => b.sequence - a.sequence);
    return {
      habit: habitRow?.value ? clone(habitRow.value) : null,
      completions: matching.map(entry => clone(entry.value)),
      lookupMode: useIndex ? 'indexed' : 'legacy_scan'
    };
  }

  // A same-generation mismatch is a safety incident, not permission to destroy
  // a potentially newer incremental mirror. Keep a bounded, read-only diff
  // so that post-restart evidence survives investigation.
  function summarizeBlockedSeedMismatch(legacy, mirrored, previousMeta, generation) {
    const expected = paritySubset(sourceSubset(legacy));
    const actual = paritySubset(mirrored);
    const keyed = (rows) => new Map((rows || [])
      .filter((row) => row && row.id != null)
      .map((row) => [String(row.id), row]));
    const expectedCompletions = keyed(expected.completions);
    const actualCompletions = keyed(actual.completions);
    const expectedHabits = keyed(expected.habits);
    const actualHabits = keyed(actual.habits);
    const only = (left, right) => [...left.keys()].filter((id) => !right.has(id));
    const changed = (left, right) => [...left.keys()]
      .filter((id) => right.has(id) && stableJson(left.get(id)) !== stableJson(right.get(id)));
    const sample = (items) => items.slice(0, 16);
    const v2OnlyCompletionIds = only(actualCompletions, expectedCompletions);
    const legacyOnlyCompletionIds = only(expectedCompletions, actualCompletions);
    const changedCompletionIds = changed(expectedCompletions, actualCompletions);
    const v2OnlyHabitIds = only(actualHabits, expectedHabits);
    const legacyOnlyHabitIds = only(expectedHabits, actualHabits);
    const changedHabitIds = changed(expectedHabits, actualHabits);
    // Order is authoritative. Concurrent tabs can commit identical rows in
    // a different transaction order from V1's timestamp-ordered journal.
    // Diagnose the ordering conflict without normalizing it away or reseeding.
    const completionIds = (rows) => rows.map((row, index) =>
      row?.id == null ? `missing:${index}` : String(row.id));
    const expectedCompletionOrder = completionIds(expected.completions);
    const actualCompletionOrder = completionIds(actual.completions);
    const completionOrderDisagreements = Math.max(
      expectedCompletionOrder.length, actualCompletionOrder.length
    ) === 0 ? 0 : Array.from({
      length: Math.max(expectedCompletionOrder.length, actualCompletionOrder.length)
    }, (_, index) => index).filter((index) =>
      expectedCompletionOrder[index] !== actualCompletionOrder[index]).length;
    return {
      resetGeneration: generation,
      existingRevision: Number(previousMeta?.revision || 0),
      expected: { habits: expected.habits.length, completions: expected.completions.length },
      actual: { habits: actual.habits.length, completions: actual.completions.length },
      legacyHash: subsetHash(legacy),
      v2Hash: subsetHash(mirrored),
      v2OnlyCompletions: v2OnlyCompletionIds.length,
      legacyOnlyCompletions: legacyOnlyCompletionIds.length,
      changedCompletions: changedCompletionIds.length,
      completionOrderDisagreements,
      expectedCompletionOrderIds: sample(expectedCompletionOrder),
      actualCompletionOrderIds: sample(actualCompletionOrder),
      changedHabits: changedHabitIds.length,
      v2OnlyHabits: v2OnlyHabitIds.length,
      legacyOnlyHabits: legacyOnlyHabitIds.length,
      v2OnlyCompletionIds: sample(v2OnlyCompletionIds),
      legacyOnlyCompletionIds: sample(legacyOnlyCompletionIds),
      changedCompletionIds: sample(changedCompletionIds),
      changedHabitIds: sample(changedHabitIds),
      v2OnlyHabitIds: sample(v2OnlyHabitIds),
      legacyOnlyHabitIds: sample(legacyOnlyHabitIds),
      evidencePreserved: true,
      destructiveReseedBlocked: true
    };
  }

  async function refreshSeedMarker(db, previousMeta, hash, desiredGeneration, reason, canonicalSignature) {
    if (!previousMeta || (previousMeta.seedHash === hash && previousMeta.canonicalCompletionCheckpointSignature)) return previousMeta;
    const tx = db.transaction('meta', 'readwrite');
    const store = tx.objectStore('meta');
    const request = store.get(RUNTIME_META_ID);
    let nextMeta = null;
    let conflict = null;
    request.onsuccess = () => {
      const currentMeta = request.result || null;
      if (stableJson(currentMeta) !== stableJson(previousMeta)) {
        conflict = revisionConflictError(
          previousMeta.revision ?? null, currentMeta?.revision ?? null, 'seed-marker'
        );
        mark('stateV2.concurrentSeedMarkerBlocked', {
          expectedRevision: previousMeta.revision ?? null,
          actualRevision: currentMeta?.revision ?? null
        });
        tx.abort();
        return;
      }
      nextMeta = {
        ...currentMeta,
        id: RUNTIME_META_ID,
        schemaVersion: SCHEMA_VERSION,
        resetGeneration: desiredGeneration,
        seedHash: hash,
        seedVerifiedAtISO: nowIso(),
        seedVerifiedRevision: Number(currentMeta.revision || 0),
        seedVerifiedReason: String(reason || 'verified-current'),
        canonicalCompletionCheckpointSignature: currentMeta.canonicalCompletionCheckpointSignature
          || canonicalSignature || null
      };
      store.put(nextMeta);
    };
    try { await transactionPromise(tx); }
    catch (error) { throw conflict || error; }
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
    const capturedCanonicalCompletionSignature = source.missing
      ? null : readCanonicalPersistedCompletionSignature();

    const run = async () => {
      const db = await open();
      if (!db) return { seeded: false, reason: 'dark_disabled' };
      let previousMeta = await readMeta(db);
      if (source.missing) {
        // A temporarily missing V1 key is not proof of an authorized reset.
        // A same-generation V2 copy may be the only remaining durable evidence.
        if (previousMeta?.resetGeneration === desiredGeneration && options.force !== true) {
          if (previousMeta.legacyMissing === true) {
            seeded = true;
            lastSeedHash = null;
            lastResetGeneration = desiredGeneration;
            lastKnownRevision = Number(previousMeta.revision || 0);
            return { seeded: false, reason: 'already_missing', revision: lastKnownRevision, resetGeneration: desiredGeneration };
          }
          const error = new Error('state_runtime_v2_legacy_temporarily_missing_preserved');
          error.code = 'STATE_V2_LEGACY_MISSING_PRESERVED';
          error.evidence = {
            resetGeneration: desiredGeneration,
            existingRevision: Number(previousMeta.revision || 0),
            evidencePreserved: true,
            destructiveReseedBlocked: true
          };
          lastError = error.message;
          mark('stateV2.legacyMissingSeedBlocked', error.evidence);
          throw error;
        }
        return clearForMissingLegacy(db, previousMeta, desiredGeneration);
      }

      const hash = capturedHash;
      const seedContext = {
        hadPreviousMeta: Boolean(previousMeta),
        previousSchemaVersion: previousMeta?.schemaVersion ?? null,
        previousResetGeneration: previousMeta?.resetGeneration ?? null,
        desiredGeneration,
        previousLegacyMissing: previousMeta?.legacyMissing === true
      };
      let parityComparedBeforeReseed = false;

      if (
        options.force !== true
        && previousMeta?.schemaVersion === SCHEMA_VERSION
        && previousMeta?.seedHash === hash
        && previousMeta?.canonicalCompletionCheckpointSignature != null
        && previousMeta?.legacyMissing !== true
        && previousMeta?.resetGeneration === desiredGeneration
        // Incremental mutation metadata can retain an old seedHash. Never
        // trust that baseline hash after WAL or edit/order/presence writes.
        // Require a verification marker for the *current* V2 revision.
        && (previousMeta.lastMutationId == null
          || (previousMeta.seedVerifiedRevision != null
            && Number(previousMeta.seedVerifiedRevision) === Number(previousMeta.revision)))
      ) {
        seeded = true;
        lastSeedHash = hash;
        lastResetGeneration = desiredGeneration;
        lastKnownRevision = Number(previousMeta?.revision || 0);
        mark('stateV2.seedAlreadyCurrent', {
          revision: lastKnownRevision,
          resetGeneration: desiredGeneration
        });
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
        parityComparedBeforeReseed = true;
        if (expectedText === actualText) {
          try {
            previousMeta = await refreshSeedMarker(db, previousMeta, hash, desiredGeneration,
              'read-only-reload-verification', capturedCanonicalCompletionSignature);
          } catch (error) {
            if (error?.code === 'STATE_RUNTIME_V2_REVISION_CONFLICT') throw error;
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
        // Never silently clear the only V2 copy of WAL-replayed Habits or
        // completions on an unexplained mismatch with the *same* V1 generation.
        // V1 remains authoritative; V2 goes read/write fail-closed until an
        // explicit, separately authorized repair or legitimate generation reset.
        const evidence = summarizeBlockedSeedMismatch(source.state, collections, previousMeta, desiredGeneration);
        mark('stateV2.seedParityMismatchBlocked', evidence);
        const error = new Error('state_runtime_v2_same_generation_parity_mismatch_preserved');
        error.code = 'STATE_V2_PARITY_MISMATCH_PRESERVED';
        error.evidence = evidence;
        lastError = error.message;
        throw error;
      }

      const habits = source.state.habits;
      const completions = pilotCompletions(source.state);
      const revision = Number(previousMeta?.revision || 0) + 1;
      await guardedSeedReplace(db, previousMeta, (tx) => {
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

        tx.objectStore('meta').put({
          id: RUNTIME_META_ID,
          schemaVersion: SCHEMA_VERSION,
          revision,
          completionSequence: completions.length,
          resetGeneration: desiredGeneration,
          source: 'legacy-dark-mirror',
          seedHash: hash,
          canonicalCompletionCheckpointSignature: capturedCanonicalCompletionSignature,
          seededAtISO: nowIso(),
          updatedAtISO: nowIso(),
          legacyMissing: false,
          counts: { habits: habits.length, completions: completions.length }
        });
      });

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
      const reseedReason = !seedContext.hadPreviousMeta
        ? 'initial_bootstrap'
        : options.force === true
          ? 'forced'
          : seedContext.previousSchemaVersion !== SCHEMA_VERSION
            ? 'schema_changed'
            : seedContext.previousLegacyMissing
              ? 'previous_legacy_missing'
              : seedContext.previousResetGeneration !== desiredGeneration
                ? 'generation_changed'
                : parityComparedBeforeReseed
                  ? 'parity_mismatch'
                  : 'unknown';
      mark('stateV2.seeded', {
        habits: habits.length,
        completions: completions.length,
        revision,
        resetGeneration: desiredGeneration,
        reseedReason,
        hadPreviousMeta: seedContext.hadPreviousMeta,
        previousSchemaVersion: seedContext.previousSchemaVersion,
        previousResetGeneration: seedContext.previousResetGeneration,
        parityComparedBeforeReseed
      });
      return {
        seeded: true,
        reason: 'seeded',
        reseedReason,
        hash,
        revision,
        resetGeneration: desiredGeneration,
        habits: habits.length,
        completions: completions.length
      };
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

  // Keep an incremental journal-day ordering index OUTSIDE Habit.value.
  // V1 replays pending Habit deltas in updatedAtISO order, preserving the
  // relative order of baseline days and appending the affected journal days.
  // IndexedDB transactions across tabs can commit in the opposite order.
  // This row metadata changes only the touched Habit and never rewrites the
  // historical completion ledger or relaxes strict parity verification.
  // A canonical V1 compaction turns formerly pending Habit days into
  // baseline days. Decode only when the V1 snapshot changes; no hot-path
  // decompression is needed between saves.
  let persistedHabitCacheRaw = null;
  let persistedHabitCacheSignature = null;
  let persistedCanonicalCompletionCacheSignature = null;
  let persistedHabitCache = new Map();
  function persistedLegacyHabit(habitId) {
    const raw = safeGet(core.STORAGE_KEY || 'taskpoints_v1');
    if (raw === null) return null;
    if (persistedHabitCacheRaw !== raw) {
      const saved = typeof core.parseTaskPointsStorageJson === 'function'
        ? core.parseTaskPointsStorageJson(raw, {}) : JSON.parse(raw);
      persistedHabitCache = new Map(
        (Array.isArray(saved?.habits) ? saved.habits : [])
          .filter(habit => habit && habit.id != null)
          .map(habit => [String(habit.id), habit])
      );
      persistedHabitCacheRaw = raw;
      // Only the saved V1 pilot state can define a Habit compaction epoch.
      // Unrelated task/notes/game saves change the serialized V1 blob but
      // must not advance completion ranks for still-pending Habit deltas.
      persistedHabitCacheSignature = subsetHash(saved);
      persistedCanonicalCompletionCacheSignature = canonicalCompletionCheckpointSignature(saved);
    }
    return persistedHabitCache.get(String(habitId)) || null;
  }

  function patchHabit(habit, delta, previousJournalDayOrder = {}) {
    const next = clone(habit || {});
    const journalDayOrder = clone(previousJournalDayOrder || {});
    const dayKey = String(delta.dayKey);
    const seen = journalDayOrder[dayKey];
    const done = delta.done === true || delta.status === 'full' || delta.status === 'half';
    const failed = delta.failed === true || delta.status === 'failed';
    const includesDay = (values) => Array.isArray(values) && values.includes(dayKey);
    // Existing completed days keep their position during full/half changes,
    // exactly as the V2 atomic compatibility contract requires. Only a newly
    // entered journal day (or a day already indexed by this journal) can be
    // reordered by timestamps across independent tabs.
    const establishedDayUnchanged = !seen && (
      (done && includesDay(next.doneKeys))
      || (failed && includesDay(next.failedKeys))
      || (delta.icy === true && includesDay(next.iceKeys))
    );
    if (!establishedDayUnchanged) {
      const nextOrdinal = Object.values(journalDayOrder).reduce((max, entry) =>
        Math.max(max, Number(entry?.firstSeen || 0)), 0) + 1;
      journalDayOrder[dayKey] = {
        updatedAtISO: String(delta.updatedAtISO || ''),
        firstSeen: Number.isSafeInteger(Number(seen?.firstSeen)) && Number(seen.firstSeen) > 0
          ? Number(seen.firstSeen) : nextOrdinal
      };
    }

    const sortedDayKeys = (values, shouldContain) => {
      const current = Array.isArray(values) ? values.slice() : [];
      const wasPresent = current.includes(dayKey);
      if (!shouldContain && wasPresent) {
        for (let index = current.length - 1; index >= 0; index--) {
          if (current[index] === dayKey) current.splice(index, 1);
        }
      } else if (shouldContain && !wasPresent) current.push(dayKey);
      const baseline = [];
      const journal = [];
      for (const key of current) {
        if (Object.prototype.hasOwnProperty.call(journalDayOrder, key)) journal.push(key);
        else baseline.push(key);
      }
      journal.sort((left, right) =>
        String(journalDayOrder[left].updatedAtISO).localeCompare(
          String(journalDayOrder[right].updatedAtISO)
        ) || Number(journalDayOrder[left].firstSeen) - Number(journalDayOrder[right].firstSeen));
      return [...baseline, ...journal];
    };

    next.doneKeys = sortedDayKeys(next.doneKeys, done);
    next.failedKeys = sortedDayKeys(next.failedKeys, failed);
    next.iceKeys = sortedDayKeys(next.iceKeys, delta.icy === true);
    const latest = Object.values(journalDayOrder).reduce(
      (value, entry) => String(entry?.updatedAtISO || '').localeCompare(value) > 0
        ? String(entry.updatedAtISO) : value, ''
    );
    next.updatedAtISO = String(delta.updatedAtISO || '').localeCompare(latest) >= 0
      ? (delta.updatedAtISO || next.updatedAtISO)
      : latest;
    return { habit: next, journalDayOrder };
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

  // A WAL confirmation may follow a queued dark mirror of the same delta.
  // Inspect the exact durable mutation without writing or replaying it again.
  // The generation and revision checks prevent an unrelated/stale transaction
  // from being mistaken for successful confirmation.
  async function hasCommittedHabitMutation(mutationId, expectedGeneration) {
    if (!isDarkEnabled() || !mutationId || !expectedGeneration) return false;
    const db = await open();
    if (!db) return false;
    const tx = db.transaction(['mutations', 'meta'], 'readonly');
    const [mutation, meta] = await Promise.all([
      requestPromise(tx.objectStore('mutations').get(String(mutationId))),
      requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID))
    ]);
    return mutation?.status === 'committed'
      && String(mutation?.id || '') === String(mutationId)
      && String(mutation?.resetGeneration || '') === String(expectedGeneration)
      && String(meta?.resetGeneration || '') === String(expectedGeneration)
      && Number.isFinite(Number(mutation?.revision))
      && Number(meta?.revision || 0) >= Number(mutation.revision);
  }

  async function applyHabitDelta(deltaInput, options = {}) {
    if (!isDarkEnabled()) return { committed: false, reason: 'dark_disabled' };
    const delta = normalizeDelta(deltaInput);
    const expectedGeneration = String(options.expectedGeneration || currentGeneration());
    const skipInitialSeedForVerifiedReplay = options.skipInitialSeedForVerifiedReplay === true;
    if (!skipInitialSeedForVerifiedReplay) {
      await seedFromLegacy();
    } else {
      mark('stateV2.walReplaySeedBypass', {
        expectedGeneration,
        expectedRevision: options.expectedRevision != null ? Number(options.expectedRevision) : null
      });
    }
    const expectedRevision = options.expectedRevision != null
      ? Number(options.expectedRevision)
      : lastKnownRevision;

    // Read the saved (pre-journal) V1 Habit before any IndexedDB wait.
    // If V1 compacted concurrently afterward, keep the old hints and fail
    // closed rather than guessing that it was a completed checkpoint.
    const persistedHabitBeforeWrite = persistedLegacyHabit(delta.habitId);
    const checkpointSignature = persistedHabitCacheSignature;
    const canonicalCheckpointSignature = persistedCanonicalCompletionCacheSignature;

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
          if (skipInitialSeedForVerifiedReplay) {
            if (Number(runtimeMeta.schemaVersion) !== Number(SCHEMA_VERSION)) {
              throw new Error(`state_runtime_v2_verified_replay_schema_mismatch:${String(runtimeMeta.schemaVersion)}:${String(SCHEMA_VERSION)}`);
            }
            if (runtimeMeta.legacyMissing === true) {
              throw new Error('state_runtime_v2_verified_replay_legacy_missing');
            }
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
          const oldJournalOrder = habitRow.journalDayOrder || {};
          const compactedIntoV1 = Object.keys(oldJournalOrder).length > 0
            && persistedHabitBeforeWrite
            && stableJson(normalizeHabitForParity(persistedHabitBeforeWrite))
              === stableJson(normalizeHabitForParity(habitRow.value));
          // V1's checkpoint makes all currently saved days the new baseline.
          // Only retire ordering hints, atomically with this new mutation.
          // Completion rows, mutation ledger and V1 data are never modified.
          const { habit: nextHabit, journalDayOrder } = patchHabit(
            habitRow.value, delta, compactedIntoV1 ? {} : oldJournalOrder
          );
          habitsStore.put({
            ...habitRow, id: delta.habitId, value: nextHabit, journalDayOrder
          });
          // A checkpoint can land between delayed mutations from *different*
          // Habits. A per-Habit hint misses the boundary for Habits that did
          // not participate in the checkpoint, placing their completion in the
          // wrong epoch despite both mutations being durable. Compare the
          // canonical V1 completion baseline captured before the IDB wait.
          const hasCanonicalMarker = Boolean(runtimeMeta.canonicalCompletionCheckpointSignature);
          const canonicalCheckpointChanged = hasCanonicalMarker && canonicalCheckpointSignature
            && String(runtimeMeta.canonicalCompletionCheckpointSignature) !== String(canonicalCheckpointSignature);
          // Existing V2 databases may not yet have a global marker. Preserve
          // their original strict per-Habit detector until a trusted marker is
          // established; never infer an epoch from an unknown baseline.
          const legacyCheckpointChanged = !hasCanonicalMarker
            && compactedIntoV1 && checkpointSignature
            && String(runtimeMeta.habitCheckpointSignature || '') !== String(checkpointSignature);
          const newCheckpoint = Boolean(canonicalCheckpointChanged || legacyCheckpointChanged);
          const completionOrderEpoch = Number(runtimeMeta.completionOrderEpoch || 0)
            + (newCheckpoint ? 1 : 0);
          if (newCheckpoint) mark('stateV2.habitCompactionOrderingRetired', {
            habitId: delta.habitId, priorJournalDays: Object.keys(oldJournalOrder).length,
            completionOrderEpoch
          });

          const completionId = typeof core.habitCompletionId === 'function'
            ? core.habitCompletionId(delta.habitId, delta.dayKey)
            : `habit:${delta.habitId}:${delta.dayKey}`;
          const completion = completionForDelta(nextHabit, delta);
          let completionSequence = Number(runtimeMeta.completionSequence || 0);
          if (completion) {
            completionSequence += 1;
            completionsStore.put(withCompletionHabitIds({
              id: completionId, value: completion,
              sequence: completionSequenceForJournalDelta(delta, completionSequence, completionOrderEpoch)
            }));
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
            completionOrderEpoch,
            ...(newCheckpoint ? { habitCheckpointSignature: checkpointSignature } : {}),
            canonicalCompletionCheckpointSignature: canonicalCheckpointSignature
              || runtimeMeta.canonicalCompletionCheckpointSignature || null,
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
        publishCommittedRevision(nextRevision, mutationId, expectedGeneration);
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
        publishCommittedRevision(nextRevision, mutationId, expectedGeneration);
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
              completionsStore.put(withCompletionHabitIds({ id: storageId, entries: combined }));
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
        publishCommittedRevision(nextRevision, mutationId, expectedGeneration);
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
        publishCommittedRevision(nextRevision, mutationId, expectedGeneration);
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
      .then(async () => {
        // Read the preview-only hold on the queued microtask, not synchronously
        // while the journal wrapper stack is still unwinding. The outer WAL
        // wrapper appends its durable row and activates the hold before this runs.
        if (isPreviewWalTestHoldActive()) {
          await waitForPreviewWalTestRestart({
            habitId: snapshot?.habitId || null,
            dayKey: snapshot?.dayKey || null
          });
        }
        return api.applyHabitDelta(snapshot, { expectedGeneration });
      })
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

  // Home normalizeHabit() has defined a missing timeOfDay as the empty string
  // since Time of Day grouping was introduced. Older V2 rows may legitimately
  // predate that field while the legacy Home normalization writes timeOfDay: ''.
  // Treat ONLY absence and the explicit empty string as equivalent for parity.
  // Nonempty labels, whitespace, null and unrelated Habit fields remain strict.
  // This projection is read-only: it never changes either persisted store.
  const HABIT_PARITY_EMPTY_DEFAULT_FIELDS = ['timeOfDay'];
  function normalizeHabitForParity(habit) {
    if (!habit || typeof habit !== 'object') return habit;
    const copy = { ...habit };
    for (const field of DERIVED_HABIT_CACHE_FIELDS) delete copy[field];
    if (!Object.prototype.hasOwnProperty.call(copy, 'timeOfDay')) copy.timeOfDay = '';
    return copy;
  }

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
      habits: scoped.habits.map(normalizeHabitForParity),
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
    const normalizedHabitDefaultDifferences = { records: 0, fields: { timeOfDay: 0 } };
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
          const emptyDefaults = collection === 'habits'
            ? allFields.filter((field) => field === 'timeOfDay' && (
              (!Object.prototype.hasOwnProperty.call(row.value || {}, field) && other.value?.[field] === '')
              || (!Object.prototype.hasOwnProperty.call(other.value || {}, field) && row.value?.[field] === '')
            ))
            : [];
          if (emptyDefaults.length) {
            normalizedHabitDefaultDifferences.records += 1;
            for (const field of emptyDefaults) normalizedHabitDefaultDifferences.fields[field] += 1;
          }
          const fields = allFields.filter((field) => !ignored.includes(field) && !emptyDefaults.includes(field));
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
    return { collections, samples, sampleCounts, truncated: total > samples.length, sampleLimit: limit * 2, sampleLimitPerCollection: limit, ignoredDerivedCacheDifferences, normalizedHabitDefaultDifferences };
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
      normalizedHabitEmptyDefaultFields: [...HABIT_PARITY_EMPTY_DEFAULT_FIELDS],
      ignoredDerivedCacheDifferences: diagnostics?.ignoredDerivedCacheDifferences || null,
      normalizedHabitDefaultDifferences: diagnostics?.normalizedHabitDefaultDifferences || null,
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

  // Stage-B/C preflight only. This is a diagnostic candidate gate, NOT a
  // storage authority flag and not a replacement for the live V1 read path.
  // No mutation, compaction, reseeding, or automatic cutover is performed.
  async function inspectPilotReadiness() {
    const refused = (reason) => ({
      checked: true, eligible: false, reason, readAuthority: 'legacy_only'
    });
    if (!isDarkEnabled()) return refused('dark_disabled');
    const initialModeEpoch = darkMirrorModeEpoch;
    if (!interactionPageGeneration) return refused('page_generation_unbound');
    // Some Safari/PWA lifecycle transitions delay storage or BroadcastChannel
    // events. A denied signal read is not evidence of no new revision.
    if (!inspectDurableRevisionSignal()) return refused('revision_signal_unreadable');
    if (externalRevisionInvalidated) return refused('external_revision_invalidated');
    const wal = global.TaskPointsStateRuntimeV2Wal;
    if (typeof wal?.getPendingRows !== 'function') return refused('wal_unavailable');
    try {
      const initialGeneration = currentGeneration({ create: false });
      if (!initialGeneration) return refused('generation_missing');
      if (initialGeneration !== interactionPageGeneration) return refused('generation_changed');
      const firstPending = wal.getPendingRows();
      if (firstPending?.ok !== true) return refused('wal_unreadable');
      if (firstPending.rows.length) return refused('wal_pending');

      // A preview gate must never seed V2 to make itself appear ready.
      const db = await open();
      if (!db) return refused('v2_unavailable');
      const metaBefore = await readMeta(db);
      if (!metaBefore || metaBefore.schemaVersion !== SCHEMA_VERSION
        || metaBefore.legacyMissing === true
        || metaBefore.resetGeneration !== initialGeneration) {
        return refused('meta_not_current');
      }

      // Verify the actual collections directly, without invoking seeding.
      const legacyBefore = parseLegacyStateWithPending();
      if (legacyBefore.missing) return refused('legacy_unavailable');
      const firstText = stableJson(paritySubset(sourceSubset(legacyBefore.state)));
      const actual = await readV2CollectionsFromDb(db);
      // Pilot-scoped parity intentionally excludes Tasks and other completion
      // classes, but those records must also never appear inside V2's pilot
      // store. Reject contaminated candidate reads without deleting evidence.
      if (pilotCompletions(actual).length !== actual.completions.length)
        return refused('unexpected_nonpilot_completions');
      const actualText = stableJson(paritySubset(actual));
      if (firstText !== actualText) return refused('pilot_parity_mismatch');

      // A tab/import or new journal write may race the asynchronous IDB read.
      // Recheck all authorities, the current IDB revision, and effective V1.
      const metaAfter = await readMeta(db);
      if (!inspectDurableRevisionSignal()) return refused('revision_signal_unreadable');
      // Preview opt-out during any asynchronous IDB read is an immediate
      // refusal, even when the underlying mirror data happened to match.
      if (!isDarkEnabled() || initialModeEpoch !== darkMirrorModeEpoch)
        return refused('dark_disabled_during_check');
      const secondGeneration = currentGeneration({ create: false });
      const secondPending = wal.getPendingRows();
      if (!secondGeneration || secondGeneration !== initialGeneration
        || secondGeneration !== interactionPageGeneration
        || externalRevisionInvalidated) return refused('generation_or_revision_changed');
      if (secondPending?.ok !== true) return refused('wal_unreadable');
      if (secondPending.rows.length) return refused('wal_pending');
      if (stableJson(metaBefore) !== stableJson(metaAfter))
        return refused('v2_revision_changed');
      const legacyAfter = parseLegacyStateWithPending();
      if (legacyAfter.missing) return refused('legacy_unavailable');
      if (stableJson(paritySubset(sourceSubset(legacyAfter.state))) !== firstText)
        return refused('legacy_changed_during_check');
      return {
        checked: true, eligible: true, reason: 'pilot_consistent',
        readAuthority: 'legacy_only', generation: initialGeneration,
        revision: Number(metaAfter.revision || 0),
        counts: { habits: actual.habits.length, completions: actual.completions.length },
        completionIndexReady: actual.completionIndexReady === true
      };
    } catch (error) {
      mark('stateV2.pilotReadinessBlocked', { reason: 'storage_unreadable' });
      return refused('storage_unreadable');
    }
  }

  // A read-only migration gate for the future IndexedDB completion index.
  // Existing V2 databases may contain rows from before Habit-ID metadata was
  // introduced. Report those rows for an explicit safe backfill later; never
  // alter them or silently trust an incomplete indexed lookup.
  async function inspectPilotCompletionIndexCoverage() {
    const refuse = (reason) => ({
      checked: true, indexReady: false, reason, readAuthority: 'legacy_only'
    });
    const before = await inspectPilotReadiness();
    if (!before.eligible) return refuse(before.reason);
    try {
      const db = await open();
      if (!db) return refuse('v2_unavailable');
      const tx = db.transaction('completions', 'readonly');
      const rows = await requestPromise(tx.objectStore('completions').getAll());
      let missing = 0;
      let mismatched = 0;
      let complete = 0;
      for (const row of rows || []) {
        const expected = completionHabitIdsForRow(row);
        if (!Array.isArray(row?.habitIds)) missing += 1;
        else if (stableJson(row.habitIds) !== stableJson(expected)) mismatched += 1;
        else complete += 1;
      }
      const after = await inspectPilotReadiness();
      if (!after.eligible) return refuse(after.reason);
      if (before.generation !== after.generation || before.revision !== after.revision)
        return refuse('read_window_changed');
      const indexReady = missing === 0 && mismatched === 0;
      return {
        checked: true, indexReady,
        reason: indexReady ? 'metadata_complete' : 'metadata_backfill_required',
        readAuthority: 'legacy_only',
        generation: after.generation, revision: after.revision,
        counts: { total: (rows || []).length, complete, missing, mismatched }
      };
    } catch (_) {
      return refuse('storage_unreadable');
    }
  }

  // Diagnostic-only targeted projection for Stage C development. No live
  // application caller is routed here: the legacy snapshot remains read
  // authority. Never return a V2 candidate across an asynchronous epoch,
  // revision, WAL, or V1 parity change. A refusal includes no stale records.
  async function readPilotHabitCandidate(habitIdInput) {
    const refuse = (reason) => ({
      checked: true, eligible: false, reason,
      source: 'none', readAuthority: 'legacy_only'
    });
    const habitId = String(habitIdInput ?? '').trim();
    if (!habitId) return refuse('habit_id_required');
    const before = await inspectPilotReadiness();
    if (!before.eligible) return refuse(before.reason);
    try {
      const db = await open();
      if (!db) return refuse('v2_unavailable');
      // Query one Habit by primary key and filter completion packs within
      // one read-only transaction. This avoids a third whole-Habits read.
      const candidate = await readPilotHabitRowsFromDb(db, habitId,
        before.completionIndexReady === true);
      const after = await inspectPilotReadiness();
      if (!after.eligible) return refuse(after.reason);
      if (before.generation !== after.generation || before.revision !== after.revision
        || before.completionIndexReady !== after.completionIndexReady)
        return refuse('read_window_changed');
      return {
        checked: true, eligible: true, reason: 'stable_preview_candidate',
        source: 'v2_preview_only', readAuthority: 'legacy_only',
        generation: after.generation, revision: after.revision,
        habit: candidate.habit,
        completions: candidate.completions,
        lookupMode: candidate.lookupMode
      };
    } catch (error) {
      return refuse('storage_unreadable');
    }
  }

  // Read-only Stage-D prerequisites, NOT an authority promotion API.
  // A full mutation handoff requires a cross-tab exclusive writer lease,
  // durable rollback, and coverage of all app collections. None exists yet.
  // Therefore canPromote is deliberately hard-false regardless of parity.
  async function inspectMutationHandoffPrerequisites() {
    const permanentBlockers = [
      'exclusive_writer_lease_not_implemented',
      'durable_authority_rollback_not_implemented',
      'nonpilot_collections_not_migrated'
    ];
    const output = (checks, extraBlockers = [], reason = 'handoff_prerequisites_incomplete') => ({
      checked: true, canPromote: false, reason,
      mutationAuthority: 'legacy_only', readAuthority: 'legacy_only',
      blockers: [...extraBlockers, ...permanentBlockers],
      checks
    });
    const before = await inspectPilotReadiness();
    if (!before.eligible) {
      return output({ pilotConsistent: false, completionIndexReady: false,
        legacyJournalEmpty: null, mirrorQueueStable: null },
      ['pilot_' + before.reason], 'pilot_not_consistent');
    }
    const observedTail = mirrorTail;
    let pendingCount = null;
    let nonPilotCompletions = null;
    let bridgeFailures = null;
    try {
      if (typeof core.readPendingHabitDeltas !== 'function')
        return output({ pilotConsistent: true, completionIndexReady: before.completionIndexReady,
          legacyJournalEmpty: null, mirrorQueueStable: null },
        ['legacy_journal_unavailable'], 'handoff_prerequisites_incomplete');
      const legacyJournal = core.readPendingHabitDeltas();
      if (!Array.isArray(legacyJournal)) throw Error('invalid_legacy_journal');
      pendingCount = legacyJournal.length;
      const legacyJournalFingerprint = stableJson(legacyJournal);
      const source = parseLegacyStateWithPending();
      if (source.missing) throw Error('legacy_unavailable');
      nonPilotCompletions = source.state.completions.length
        - pilotCompletions(source.state).length;
      const bridge = global.TaskPointsStateRuntimeV2WalBridge;
      const status = bridge?.getStatus?.();
      bridgeFailures = status && Number.isFinite(Number(status.failures))
        ? Number(status.failures) : null;
      const after = await inspectPilotReadiness();
      // Compaction or another tab can change the legacy journal without
      // necessarily changing effective V1 data. Never treat that as a stable
      // mutation-authority boundary.
      const journalAfter = core.readPendingHabitDeltas();
      if (!Array.isArray(journalAfter)
        || stableJson(journalAfter) !== legacyJournalFingerprint) {
        return output({ pilotConsistent: false, completionIndexReady: false,
          legacyJournalEmpty: false, mirrorQueueStable: mirrorTail === observedTail },
        ['legacy_journal_changed_during_preflight'], 'handoff_inventory_changed');
      }
      if (!after.eligible) {
        return output({ pilotConsistent: false, completionIndexReady: false,
          legacyJournalEmpty: pendingCount === 0,
          mirrorQueueStable: mirrorTail === observedTail },
        ['pilot_' + after.reason], 'pilot_changed_during_preflight');
      }
      if (before.generation !== after.generation || before.revision !== after.revision
        || before.completionIndexReady !== after.completionIndexReady) {
        return output({ pilotConsistent: false, completionIndexReady: false,
          legacyJournalEmpty: pendingCount === 0,
          mirrorQueueStable: mirrorTail === observedTail },
        ['pilot_changed_during_preflight'], 'pilot_changed_during_preflight');
      }
      const checks = {
        pilotConsistent: true,
        completionIndexReady: after.completionIndexReady === true,
        legacyJournalEmpty: pendingCount === 0,
        mirrorQueueStable: mirrorTail === observedTail,
        noObservedMirrorFailures: mirrorFailures === 0,
        noObservedBridgeFailures: bridgeFailures === 0
      };
      const blockers = [];
      if (!checks.completionIndexReady) blockers.push('completion_index_incomplete');
      if (!checks.legacyJournalEmpty) blockers.push('legacy_journal_pending');
      if (!checks.mirrorQueueStable) blockers.push('mirror_queue_changed_during_preflight');
      if (!checks.noObservedMirrorFailures) blockers.push('mirror_failures_observed');
      if (!checks.noObservedBridgeFailures) blockers.push('bridge_not_confirmed_healthy');
      return {
        ...output(checks, blockers),
        counts: { legacyJournalPending: pendingCount,
          nonPilotLegacyCompletions: nonPilotCompletions },
        generation: after.generation, revision: after.revision
      };
    } catch (_) {
      return output({ pilotConsistent: false, completionIndexReady: false,
        legacyJournalEmpty: null, mirrorQueueStable: null },
      ['handoff_inventory_unreadable'], 'handoff_inventory_unreadable');
    }
  }

  // Consolidated, read-only cutover inventory. This is a developer
  // diagnostic, NOT an activation switch or proof of production writer
  // fencing. Known writer families are a minimum inventory; discovering
  // more legacy writers can only ADD blockers, never authorize promotion.
  const AUTHORITY_CUTOVER_WRITER_FAMILIES = Object.freeze([
    'scoring_core_snapshot_and_habit_journal',
    'home_direct_keys_and_snapshot_saves',
    'today_snapshot_and_view_state',
    'settings_import_reset_and_direct_storage',
    'notes_content_dirty_and_authority_flags',
    'emergency_recovery_and_restore',
    'task_journal_and_idle_compaction'
  ]);

  async function inspectAuthorityCutoverBarriers() {
    const hardBlockers = [
      'all_legacy_writers_not_fenced',
      'nonpilot_authoritative_collections_not_migrated',
      'independent_off_device_rollback_not_verified',
      'physical_safari_pwa_lifecycle_not_validated',
      'production_multi_context_handoff_not_validated'
    ];
    const snapshot = (reason, pilot, rollback, peers, extra = []) => {
      // Even a completely green Habit pilot and all responsive V2 preview
      // peers say nothing about suspended or pre-V2 legacy-only tabs.
      const checks = {
        pilotConsistent: pilot?.checks?.pilotConsistent === true,
        completionIndexReady: pilot?.checks?.completionIndexReady === true,
        legacyJournalEmpty: pilot?.checks?.legacyJournalEmpty === true,
        mirrorQueueStable: pilot?.checks?.mirrorQueueStable === true,
        noObservedMirrorFailures: pilot?.checks?.noObservedMirrorFailures === true,
        noObservedBridgeFailures: pilot?.checks?.noObservedBridgeFailures === true,
        stableLegacyRollbackSource: rollback?.sourceStable === true,
        observedPeersOnly: peers?.respondingPreviewTabsOnly === true,
        allLegacyWritersFenced: false,
        allAuthoritativeCollectionsMigrated: false,
        independentOffDeviceRollbackVerified: false,
        physicalSafariPwaLifecycleValidated: false,
        productionMultiContextHandoffValidated: false
      };
      return {
        checked: true, reason, canPromote: false,
        mutationAuthority: 'legacy_only', readAuthority: 'legacy_only',
        checks, blockers: [...new Set([
          ...(pilot?.blockers || []),
          ...(!checks.stableLegacyRollbackSource ? ['legacy_rollback_source_unverified'] : []),
          ...extra, ...hardBlockers
        ])],
        knownUnfencedWriterFamilies: [...AUTHORITY_CUTOVER_WRITER_FAMILIES],
        pilot: pilot ? { reason: pilot.reason,
          generation: pilot.generation || null, revision: pilot.revision ?? null } : null,
        rollback: rollback ? { reason: rollback.reason,
          sourceStable: rollback.sourceStable === true,
          checkpointExists: rollback.checkpointExists === true,
          canRestoreFromCheckpoint: rollback.canRestoreFromCheckpoint === true } : null,
        peers: peers ? { reason: peers.reason,
          observedPeerCount: peers.observedPeerCount,
          respondingPreviewTabsOnly: peers.respondingPreviewTabsOnly === true } : null
      };
    };
    const modeEpoch = darkMirrorModeEpoch;
    const initialGeneration = currentGeneration({ create: false });
    if (!isDarkEnabled() || !initialGeneration)
      return snapshot('preview_unavailable', null, null, null,
        ['preview_disabled_or_generation_unavailable']);
    try {
      const pilot = await inspectMutationHandoffPrerequisites();
      const rollback = await inspectLegacyRollbackSource();
      const peers = await inspectPreviewWriterPeers();
      // The asynchronous peer observation is NOT a lock. Detect a new
      // generation or explicit preview switch during the report; never use
      // an earlier green preflight as evidence about a newer generation.
      if (!isDarkEnabled() || modeEpoch !== darkMirrorModeEpoch
        || currentGeneration({ create: false }) !== initialGeneration
        || (pilot.generation && pilot.generation !== initialGeneration)
        || (rollback.generation && rollback.generation !== initialGeneration))
        return snapshot('inventory_changed_during_check', pilot, rollback, peers,
          ['preview_or_generation_changed_during_check']);
      return snapshot('authority_cutover_blocked', pilot, rollback, peers);
    } catch (_) {
      return snapshot('inspection_unreadable', null, null, null,
        ['authority_cutover_inventory_unreadable']);
    }
  }

  // Explicit forensic inspection of an unexplained same-generation V1/V2
  // mismatch. Unlike verifyParity(), this never calls seedFromLegacy(), does
  // not refresh metadata, and cannot clear or reconcile either copy. A V2
  // database must already be open: diagnosing an absent mirror must not
  // create a database as a side effect of inspection.
  async function inspectPreservedParityMismatch() {
    const refuse = reason => ({
      checked: true, stable: false, mismatch: null,
      reason, canRepair: false, evidencePreserved: true,
      mutationAuthority: 'legacy_only', readAuthority: 'legacy_only'
    });
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (!dbPromise) return refuse('v2_not_open');
    const startingModeEpoch = darkMirrorModeEpoch;
    try {
      const firstAudit = await inspectLegacyRollbackSource();
      if (!firstAudit.sourceStable)
        return refuse('legacy_source_' + firstAudit.reason);
      const beforeNamespace = captureLegacyNamespace();
      const beforeSource = parseLegacyStateWithPending();
      if (beforeSource.missing) return refuse('legacy_unavailable');
      const generation = currentGeneration({ create: false });
      if (!generation || generation !== firstAudit.generation)
        return refuse('generation_changed_during_inspection');
      const db = await dbPromise;
      if (!db) return refuse('v2_unavailable');
      const metaBefore = await readMeta(db);
      if (!metaBefore || metaBefore.schemaVersion !== SCHEMA_VERSION
        || metaBefore.legacyMissing === true
        || metaBefore.resetGeneration !== generation)
        return refuse('v2_generation_not_current');
      const collections = await readV2CollectionsFromDb(db);
      const metaAfter = await readMeta(db);
      const afterAudit = await inspectLegacyRollbackSource();
      // A rival tab or direct IndexedDB client could alter pilot rows without
      // advancing V2's revision metadata. Reading the stores twice detects
      // an inconsistent observation rather than mislabeling it as durable
      // disagreement (or a durable match). This is an explicit diagnostic
      // only; no production read path incurs a second full-store scan.
      const collectionsAfter = await readV2CollectionsFromDb(db);
      const metaFinal = await readMeta(db);
      if (!isDarkEnabled() || darkMirrorModeEpoch !== startingModeEpoch)
        return refuse('dark_mode_changed_during_inspection');
      if (stableJson(collectionsAfter) !== stableJson(collections))
        return refuse('v2_collections_changed_during_inspection');
      if (!afterAudit.sourceStable
        || afterAudit.generation !== generation
        || currentGeneration({ create: false }) !== generation
        || stableJson(metaAfter) !== stableJson(metaBefore)
        || stableJson(metaFinal) !== stableJson(metaBefore)
        || stableJson(captureLegacyNamespace()) !== stableJson(beforeNamespace))
        return refuse('inspection_window_changed');
      const expected = stableJson(paritySubset(sourceSubset(beforeSource.state)));
      const actual = stableJson(paritySubset(collections));
      if (expected === actual) {
        return {
          checked: true, stable: true, mismatch: false,
          reason: 'pilot_parity_matched', canRepair: false,
          evidencePreserved: true, resetGeneration: generation,
          revision: Number(metaAfter.revision || 0),
          mutationAuthority: 'legacy_only', readAuthority: 'legacy_only'
        };
      }
      const evidence = summarizeBlockedSeedMismatch(
        beforeSource.state, collections, metaAfter, generation);
      return {
        checked: true, stable: true, mismatch: true,
        reason: 'same_generation_parity_mismatch_preserved',
        canRepair: false, evidencePreserved: true,
        mutationAuthority: 'legacy_only', readAuthority: 'legacy_only',
        evidence
      };
    } catch (_) {
      return refuse('inspection_unreadable');
    }
  }

  // Read-only rollback *source* inventory. It is not a checkpoint or a
  // restore method: the existing V1 record remains the only authority. A
  // future cutover must provide an independently durable rollback checkpoint.
  async function inspectLegacyRollbackSource() {
    const fail = (reason) => ({ checked: true, sourceStable: false,
      checkpointExists: false, canRestoreFromCheckpoint: false, reason,
      mutationAuthority: 'legacy_only', readAuthority: 'legacy_only' });
    try {
      const first = parseLegacyStateWithPending();
      if (first.missing) return fail('legacy_unavailable');
      const firstRaw = first.raw;
      // The Habit order overlay is also V1-authoritative until compaction.
      // Check it through a strict read: an optional safeGet() fallback to
      // null would incorrectly classify denied storage as an empty overlay.
      const legacyStorage = global.localStorage;
      if (typeof legacyStorage?.getItem !== 'function')
        return fail('legacy_inventory_unreadable');
      const firstOrderOverlay = legacyStorage.getItem('taskpoints_habit_order_overlay_v1');
      const firstFingerprint = stableJson(paritySubset(sourceSubset(first.state)));
      const wal = global.TaskPointsStateRuntimeV2Wal;
      const beforeWal = wal?.getPendingRows?.();
      if (beforeWal?.ok !== true) return fail('wal_unreadable');
      const firstGeneration = currentGeneration({ create: false });
      if (!firstGeneration) return fail('generation_missing');
      const journal = core.readPendingHabitDeltas?.();
      if (!Array.isArray(journal)) return fail('journal_unreadable');
      const journalFingerprint = stableJson(journal);
      // Force an actual asynchronous boundary to catch changes caused by
      // other tabs or asynchronous compaction before calling the source stable.
      await Promise.resolve();
      const second = parseLegacyStateWithPending();
      const afterWal = wal?.getPendingRows?.();
      const afterJournal = core.readPendingHabitDeltas?.();
      if (second.missing || second.raw !== firstRaw
        || legacyStorage.getItem('taskpoints_habit_order_overlay_v1') !== firstOrderOverlay
        || stableJson(paritySubset(sourceSubset(second.state))) !== firstFingerprint
        || stableJson(afterJournal) !== journalFingerprint
        || stableJson(afterWal) !== stableJson(beforeWal)
        || currentGeneration({ create: false }) !== firstGeneration)
        return fail('legacy_changed_during_inventory');
      if (afterWal?.ok !== true) return fail('wal_unreadable');
      return {
        checked: true, sourceStable: true, checkpointExists: false,
        canRestoreFromCheckpoint: false, reason: 'legacy_recovery_source_stable',
        mutationAuthority: 'legacy_only', readAuthority: 'legacy_only',
        generation: firstGeneration,
        counts: { habits: first.state.habits.length,
          completions: first.state.completions.length,
          legacyJournal: journal.length, walPending: beforeWal.rows.length }
      };
    } catch (_) { return fail('legacy_inventory_unreadable'); }
  }

  // Explicit, immutable, preview-only copies of the existing V1 namespace.
  // This database is deliberately SEPARATE from V2's live mirror and from
  // V1 localStorage. Nothing writes here during startup, seeding, or ordinary
  // Habit edits. No restore or authority-switch operation is provided.
  function captureLegacyNamespace() {
    const storage = global.localStorage;
    if (!storage || typeof storage.length !== 'number'
      || typeof storage.key !== 'function' || typeof storage.getItem !== 'function')
      throw Error('preview_recovery_storage_not_enumerable');
    const startingLength = storage.length;
    const keys = [];
    const seen = new Set();
    for (let i = 0; i < startingLength; i += 1) {
      const key = storage.key(i);
      if (typeof key !== 'string' || seen.has(key))
        throw Error('preview_recovery_storage_inventory_changed');
      seen.add(key);
      if (key.toLowerCase().startsWith('taskpoints_')) keys.push(key);
    }
    if (storage.length !== startingLength) throw Error('preview_recovery_storage_inventory_changed');
    if (!seen.has(core.STORAGE_KEY || 'taskpoints_v1'))
      throw Error('preview_recovery_legacy_missing');
    keys.sort();
    const entries = keys.map(key => {
      const value = storage.getItem(key);
      if (typeof value !== 'string') throw Error('preview_recovery_key_unreadable');
      return [key, value];
    });
    if (storage.length !== startingLength) throw Error('preview_recovery_storage_inventory_changed');
    return entries;
  }

  async function previewRecoveryFingerprint(entries) {
    // The preview checkpoint must be cryptographically checked against
    // accidental and adversarial content alteration. Never weaken to an
    // unchecked or 32-bit fallback when WebCrypto is unavailable.
    if (typeof global.crypto?.subtle?.digest !== 'function'
      || typeof global.TextEncoder !== 'function')
      throw Error('preview_recovery_sha256_unavailable');
    const bytes = new global.TextEncoder().encode(JSON.stringify(entries));
    const digest = await global.crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest),
      byte => byte.toString(16).padStart(2, '0')).join('');
    return `sha256:${hex}:${bytes.byteLength}`;
  }

  // Seal both data and provenance for new checkpoints. Preserve inspection
  // of earlier payload-only SHA-256 records rather than deleting or silently
  // rewriting historical recovery evidence.
  function previewRecoveryDigestPayload(record) {
    if (record.integrityVersion === 2) {
      return {
        id: record.id,
        schemaVersion: record.schemaVersion,
        capturedAtISO: record.capturedAtISO,
        generation: record.generation,
        entries: record.entries
      };
    }
    if (record.integrityVersion == null || record.integrityVersion === 1)
      return record.entries;
    return null;
  }

  async function validPreviewRecoveryRecord(record) {
    if (!record || record.schemaVersion !== PREVIEW_RECOVERY_SCHEMA
      || !Array.isArray(record.entries) || !record.entries.length
      || typeof record.id !== 'string' || !record.id.startsWith('v1-preview:')
      || typeof record.generation !== 'string' || !record.generation
      || typeof record.fingerprint !== 'string')
      return false;
    let previous = null;
    let hasLegacy = false;
    for (const entry of record.entries) {
      if (!Array.isArray(entry) || entry.length !== 2
        || typeof entry[0] !== 'string' || typeof entry[1] !== 'string'
        || !entry[0].toLowerCase().startsWith('taskpoints_')
        || (previous !== null && previous >= entry[0])) return false;
      if (entry[0] === (core.STORAGE_KEY || 'taskpoints_v1')) hasLegacy = true;
      previous = entry[0];
    }
    const payload = previewRecoveryDigestPayload(record);
    return hasLegacy && payload !== null
      && (await previewRecoveryFingerprint(payload)) === record.fingerprint;
  }

  async function openPreviewRecoveryDb() {
    if (typeof global.indexedDB?.open !== 'function')
      throw Error('preview_recovery_indexeddb_unavailable');
    return new Promise((resolve, reject) => {
      const req = global.indexedDB.open(PREVIEW_RECOVERY_DB, PREVIEW_RECOVERY_SCHEMA);
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        reject(error || Error('preview_recovery_db_open_failed'));
      };
      req.onupgradeneeded = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains(PREVIEW_RECOVERY_STORE))
            db.createObjectStore(PREVIEW_RECOVERY_STORE, { keyPath: 'id' });
        } catch (error) {
          try { req.transaction?.abort(); } catch (_) {}
          fail(error);
        }
      };
      req.onsuccess = () => {
        if (settled) { try { req.result?.close(); } catch (_) {} return; }
        settled = true;
        resolve(req.result);
      };
      req.onerror = () => fail(req.error);
      req.onblocked = () => fail(Error('preview_recovery_db_blocked'));
    });
  }

  // Returns metadata only: never the captured personal data. The SHA-256
  // digest verifies byte integrity, but is not a keyed authenticity proof
  // or evidence sufficient to promote V2 mutation authority.
  async function inspectPreviewRecoveryCheckpoint(idInput) {
    const id = String(idInput || '');
    const refuse = reason => ({
      checked: true, intact: false, reason, checkpointId: id || null,
      canAutoRestore: false, mutationAuthority: 'legacy_only'
    });
    if (!id.startsWith('v1-preview:')) return refuse('checkpoint_id_required');
    let db;
    try {
      db = await openPreviewRecoveryDb();
      const tx = db.transaction(PREVIEW_RECOVERY_STORE, 'readonly');
      const record = await requestPromise(tx.objectStore(PREVIEW_RECOVERY_STORE).get(id));
      if (!record) return refuse('checkpoint_missing');
      if (!await validPreviewRecoveryRecord(record)) return refuse('checkpoint_integrity_failed');
      return {
        checked: true, intact: true, reason: 'checkpoint_intact',
        checkpointId: id, canAutoRestore: false,
        mutationAuthority: 'legacy_only', readAuthority: 'legacy_only',
        capturedGeneration: record.generation, capturedAtISO: record.capturedAtISO,
        keyCount: record.entries.length,
        fingerprint: record.fingerprint,
        integrityCoverage: record.integrityVersion === 2
          ? 'metadata_and_payload' : 'legacy_payload_only'
      };
    } catch (_) { return refuse('checkpoint_unreadable'); }
    finally { try { db?.close(); } catch (_) {} }
  }

  // Non-mutating rollback rehearsal. Counts only; does NOT expose captured
  // values, choose an authority, write any storage key or attempt a restore.
  async function inspectPreviewRollbackPlan(idInput) {
    const id = String(idInput || '');
    const refused = (reason, extra = {}) => ({
      checked: true, planValid: false, canApply: false,
      reason, checkpointId: id || null,
      mutationAuthority: 'legacy_only', readAuthority: 'legacy_only',
      ...extra
    });
    if (!id.startsWith('v1-preview:')) return refused('checkpoint_id_required');
    let db;
    try {
      const verdict = await inspectPreviewRecoveryCheckpoint(id);
      if (!verdict.intact) return refused(verdict.reason);
      // Historical payload-only records remain inspectable, but their
      // capture generation and timestamp were never cryptographically bound
      // to the payload. A mutation-authority rollback rehearsal must never
      // classify that provenance as an authenticated recovery source.
      if (verdict.integrityCoverage !== 'metadata_and_payload')
        return refused('checkpoint_provenance_unverified');
      const before = await inspectLegacyRollbackSource();
      if (!before.sourceStable) return refused('legacy_source_' + before.reason);
      const currentBefore = captureLegacyNamespace();
      db = await openPreviewRecoveryDb();
      const tx = db.transaction(PREVIEW_RECOVERY_STORE, 'readonly');
      const record = await requestPromise(tx.objectStore(PREVIEW_RECOVERY_STORE).get(id));
      if (!await validPreviewRecoveryRecord(record))
        return refused('checkpoint_integrity_failed');
      const savedKeys = new Map(record.entries);
      const currentKeys = new Map(currentBefore);
      let removed = 0;
      let restored = 0;
      let replaced = 0;
      for (const [key, value] of savedKeys) {
        if (!currentKeys.has(key)) restored += 1;
        else if (currentKeys.get(key) !== value) replaced += 1;
      }
      for (const key of currentKeys.keys()) if (!savedKeys.has(key)) removed += 1;
      const after = await inspectLegacyRollbackSource();
      if (!after.sourceStable
        || before.generation !== after.generation
        || (await previewRecoveryFingerprint(currentBefore)) !== (await previewRecoveryFingerprint(captureLegacyNamespace())))
        return refused('legacy_changed_during_plan');
      const generationMatches = before.generation === record.generation;
      return {
        checked: true, planValid: true, canApply: false,
        reason: generationMatches ? 'dry_run_only' : 'checkpoint_generation_differs',
        checkpointId: id, mutationAuthority: 'legacy_only',
        readAuthority: 'legacy_only', capturedGeneration: record.generation,
        generationMatches,
        counts: { restoreMissing: restored, replaceChanged: replaced,
          removeNewer: removed, captured: savedKeys.size, current: currentKeys.size },
        blockers: ['production_writer_fencing_not_implemented',
          'external_checkpoint_backup_unverified',
          'rollback_restore_transaction_not_implemented']
      };
    } catch (_) { return refused('rollback_plan_unreadable'); }
    finally { try { db?.close(); } catch (_) {} }
  }

  // Explicit only. Atomic IndexedDB add keeps any previously saved copy
  // immutable; a failed write cannot replace another checkpoint. Evidence
  // stays separate from the V2 mirror (which may be reseeded), and no copy
  // is automatically restored into V1.
  async function createPreviewRecoveryCheckpoint() {
    const fail = (reason, extras = {}) => ({
      checked: true, saved: false, sourceStable: false,
      canAutoRestore: false, reason,
      mutationAuthority: 'legacy_only', readAuthority: 'legacy_only', ...extras
    });
    const source = await inspectLegacyRollbackSource();
    if (!source.sourceStable) return fail('legacy_source_' + source.reason);
    let db;
    try {
      const entries = captureLegacyNamespace();
      const generation = currentGeneration({ create: false });
      if (!generation || generation !== source.generation)
        return fail('generation_changed_before_capture');
      // localStorage has no multi-key read transaction. A competing tab
      // may modify an earlier key while this snapshot enumerates later keys.
      // Re-read the entire namespace and recheck the legacy journals/WAL
      // before persisting a checkpoint that could be torn across versions.
      // An inconsistent attempt must not become an immutable recovery copy.
      const capturedPayloadFingerprint = await previewRecoveryFingerprint(entries);
      if (await previewRecoveryFingerprint(captureLegacyNamespace())
          !== capturedPayloadFingerprint)
        return fail('legacy_changed_during_capture');
      const captureSource = await inspectLegacyRollbackSource();
      if (!captureSource.sourceStable || captureSource.generation !== generation)
        return fail('legacy_source_changed_during_capture');
      const id = `v1-preview:${global.crypto?.randomUUID?.() || `${Date.now()}:${Math.random().toString(36).slice(2)}`}`;
      const record = {
        id, schemaVersion: PREVIEW_RECOVERY_SCHEMA,
        integrityVersion: 2,
        capturedAtISO: nowIso(), generation, entries
      };
      record.fingerprint = await previewRecoveryFingerprint(previewRecoveryDigestPayload(record));
      db = await openPreviewRecoveryDb();
      const tx = db.transaction(PREVIEW_RECOVERY_STORE, 'readwrite');
      const completion = transactionPromise(tx);
      const writing = requestPromise(tx.objectStore(PREVIEW_RECOVERY_STORE).add(record));
      await Promise.all([writing, completion]);
      db.close();
      db = null;
      const stored = await inspectPreviewRecoveryCheckpoint(id);
      if (!stored.intact || stored.fingerprint !== record.fingerprint)
        return fail('checkpoint_readback_failed', { checkpointId: id });
      const after = await inspectLegacyRollbackSource();
      let sameInventory = false;
      try {
        sameInventory = await previewRecoveryFingerprint(captureLegacyNamespace())
          === capturedPayloadFingerprint;
      } catch (_) {}
      const stillCurrent = after.sourceStable && after.generation === generation && sameInventory;
      return {
        checked: true, saved: true, verified: true,
        sourceStable: stillCurrent,
        reason: stillCurrent ? 'checkpoint_saved_and_current' : 'checkpoint_saved_but_source_changed',
        checkpointId: id, keyCount: entries.length,
        canAutoRestore: false,
        mutationAuthority: 'legacy_only', readAuthority: 'legacy_only'
      };
    } catch (_) { return fail('checkpoint_write_failed'); }
    finally { try { db?.close(); } catch (_) {} }
  }

  // Developer-only cooperative-writer prototype. Real V1 mutation paths do
  // NOT call this method. A participating caller can voluntarily execute one
  // operation while holding a browser shared lock, which conflicts with the
  // existing exclusive handoff rehearsal. It proves only the cooperative
  // protocol mechanics, not global legacy writer fencing or safe cutover.
  //
  // Restrict this experimental callback API to localhost/branch-preview
  // hosts. It must not become a hidden wrapper around production V1 saves.
  async function exercisePreviewCooperativeWriterLease(operation) {
    const refuse = (reason, details = {}) => ({
      checked: true, sharedLockAcquired: false, operationRan: false,
      canPromote: false, reason, productionWritersFenced: false,
      allLegacyWritersKnown: false,
      mutationAuthority: 'legacy_only', readAuthority: 'legacy_only',
      ...details
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof operation !== 'function') return refuse('operation_required');
    const locks = global.navigator?.locks;
    if (typeof locks?.request !== 'function') return refuse('lock_manager_unavailable');
    const initialModeEpoch = darkMirrorModeEpoch;
    const initialGeneration = currentGeneration({ create: false });
    if (!initialGeneration) return refuse('generation_unavailable');
    // A voluntary fixture callback may use this guard just before a test
    // write, including after awaits. This narrows one known TOCTOU window,
    // but is NOT a global fence: unfenced legacy tabs can still write and
    // code that ignores the guard can perform side effects before rejection.
    const assertPreviewGenerationCurrent = () => {
      if (!isDarkEnabled() || initialModeEpoch !== darkMirrorModeEpoch
        || currentGeneration({ create: false }) !== initialGeneration) {
        const error = new Error('state_runtime_v2_preview_generation_changed');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_GENERATION_CHANGED';
        throw error;
      }
      return true;
    };
    const previewGuard = Object.freeze({ assertPreviewGenerationCurrent });
    let result = refuse('shared_lock_unavailable');
    try {
      await locks.request(EXCLUSIVE_WRITER_REHEARSAL_LOCK,
        { mode: 'shared', ifAvailable: true }, async lock => {
          if (!lock) { result = refuse('lock_held_elsewhere'); return; }
          if (!isDarkEnabled() || initialModeEpoch !== darkMirrorModeEpoch
            || currentGeneration({ create: false }) !== initialGeneration) {
            result = refuse('generation_or_preview_changed_under_lock');
            return;
          }
          // This callback is an explicit fixture/developer operation. It may
          // alter V1, but neither this runtime nor the real application
          // installs it as an automatic writer path. Never claim that its
          // outcome proves a production writer fence.
          let ran = false;
          try {
            ran = true;
            await operation(previewGuard);
          } catch (error) {
            result = refuse(error?.code === 'STATE_RUNTIME_V2_PREVIEW_GENERATION_CHANGED'
              ? 'cooperative_operation_generation_invalidated'
              : 'cooperative_operation_failed',
              { sharedLockAcquired: true, operationRan: ran,
                lockHeldAfterReturn: false });
            return;
          }
          if (!isDarkEnabled() || initialModeEpoch !== darkMirrorModeEpoch
            || currentGeneration({ create: false }) !== initialGeneration) {
            result = refuse('generation_or_preview_changed_under_lock',
              { sharedLockAcquired: true, operationRan: ran,
                lockHeldAfterReturn: false });
            return;
          }
          result = {
            checked: true, sharedLockAcquired: true, operationRan: ran,
            reason: 'cooperative_shared_lock_rehearsed',
            lockHeldAfterReturn: false,
            canPromote: false, productionWritersFenced: false,
            allLegacyWritersKnown: false,
            mutationAuthority: 'legacy_only', readAuthority: 'legacy_only'
          };
        });
    } catch (_) {
      return refuse('shared_lock_request_failed',
        { operationMayHaveRun: result.operationRan === true });
    }
    return result;
  }

  // Browser-native exclusive-lock *rehearsal*, never a writer handoff.
  // Browser LockManager is shared by same-origin tabs and serializes callbacks
  // without vulnerable localStorage time-based leases. No fallback assumes
  // exclusivity if navigator.locks is missing or denies the request.
  async function rehearseExclusiveWriterLease() {
    const fail = (reason) => ({
      checked: true, lockAcquired: false, canPromote: false, reason,
      mutationAuthority: 'legacy_only', readAuthority: 'legacy_only'
    });
    const locks = global.navigator?.locks;
    if (typeof locks?.request !== 'function') return fail('lock_manager_unavailable');
    const initialModeEpoch = darkMirrorModeEpoch;
    // Pilot parity alone is insufficient. Pending V1 journals, an incomplete
    // completion index, a changing mirror queue or recorded bridge/mirror
    // failures must all block even a *rehearsal* of the writer handoff.
    const preflightClear = report => [
      'pilotConsistent', 'completionIndexReady', 'legacyJournalEmpty',
      'mirrorQueueStable', 'noObservedMirrorFailures', 'noObservedBridgeFailures'
    ].every(key => report?.checks?.[key] === true);
    const initial = await inspectMutationHandoffPrerequisites();
    if (!preflightClear(initial))
      return fail(initial.checks?.pilotConsistent === true
        ? 'handoff_prerequisites_blocked' : 'pilot_not_consistent');
    // Navigator.locks only coordinates callers that participate in the lock.
    // An existing V1 tab can still write the legacy namespace independently.
    // Inspect the whole namespace on both sides of the lock acquisition,
    // not only the migrated Habits/completion pilot.
    let initialInventoryFingerprint;
    try {
      const initialRollback = await inspectLegacyRollbackSource();
      if (!initialRollback.sourceStable) return fail('rollback_source_unavailable');
      initialInventoryFingerprint = await previewRecoveryFingerprint(captureLegacyNamespace());
    } catch (_) { return fail('legacy_inventory_unreadable'); }
    let result = fail('lock_unavailable');
    try {
      await locks.request(EXCLUSIVE_WRITER_REHEARSAL_LOCK,
        { mode: 'exclusive', ifAvailable: true }, async (lock) => {
          if (!lock) { result = fail('lock_held_elsewhere'); return; }
          const [inside, rollback] = await Promise.all([
            inspectMutationHandoffPrerequisites(),
            inspectLegacyRollbackSource()
          ]);
          const pilotStable = inside.checks?.pilotConsistent === true
            && inside.generation === initial.generation
            && inside.revision === initial.revision;
          if (!pilotStable || rollback.sourceStable !== true) {
            result = fail(rollback.sourceStable ? 'pilot_changed_under_lock'
              : 'rollback_source_unavailable');
            return;
          }
          if (!preflightClear(inside)) {
            result = fail('handoff_prerequisites_changed_under_lock');
            return;
          }
          // A notes/settings change outside the pilot may not change V2
          // revision or pilot parity. It still invalidates the handoff proof.
          let currentFingerprint, currentInventory;
          try {
            currentInventory = captureLegacyNamespace();
            currentFingerprint = await previewRecoveryFingerprint(currentInventory);
            // An opt-out or off/on toggle during hashing invalidates this
            // diagnostic, even if the stored flag ends at its old value.
            if (!isDarkEnabled() || darkMirrorModeEpoch !== initialModeEpoch) {
              result = fail('dark_mode_changed_during_lock_verification');
              return;
            }
            // SHA-256 is asynchronous. A nonparticipating V1 tab may change
            // settings, notes or another collection *while the digest is
            // pending*. Make one final synchronous read in the same turn
            // before reporting a completed rehearsal. This is a diagnostic
            // consistency check, NOT a durable cross-tab writer fence.
            if (stableJson(captureLegacyNamespace()) !== stableJson(currentInventory)) {
              result = fail('legacy_changed_during_lock_verification');
              return;
            }
          } catch (_) { result = fail('legacy_inventory_unreadable'); return; }
          if (currentFingerprint !== initialInventoryFingerprint) {
            result = fail('legacy_changed_under_lock');
            return;
          }
          // A lock proves exclusivity only while this callback is executing.
          // Return a historical rehearsal result, not a durable lease token.
          result = {
            checked: true, lockAcquired: true, canPromote: false,
            reason: 'exclusive_lock_rehearsed', lockHeldAfterReturn: false,
            mutationAuthority: 'legacy_only', readAuthority: 'legacy_only',
            generation: inside.generation, revision: inside.revision,
            rollbackSourceStable: true,
            blockers: inside.blockers
          };
        });
    } catch (_) { return fail('lock_request_failed'); }
    return result;
  }

  // Stage-C *comparison harness*, not a read-authority switch. Enabling
  // this flag only allows an explicit diagnostic comparison. The selected
  // backend is ALWAYS legacy, including on an eligible V2 match.
  function setPilotReadProbeEnabled(enabled) {
    // Every explicit toggle fences off outstanding read comparisons. A
    // rapid off/on cycle cannot revive a candidate started in the older
    // session even if the toggle ends in the enabled state again.
    pilotReadProbeEpoch += 1;
    pilotReadProbeEnabled = enabled === true;
    return {
      enabled: pilotReadProbeEnabled,
      readAuthority: 'legacy_only',
      persisted: false
    };
  }

  async function probePilotHabitRead(habitIdInput) {
    const result = (reason, extras = {}) => ({
      checked: true, selectedSource: 'legacy_only',
      readAuthority: 'legacy_only', reason, ...extras
    });
    if (!pilotReadProbeEnabled) return result('probe_disabled', { checked: false });
    const probeEpoch = pilotReadProbeEpoch;
    const habitId = String(habitIdInput ?? '').trim();
    if (!habitId) return result('habit_id_required', { matched: false });
    pilotReadProbeChecks += 1;
    try {
      // Snapshot effective V1 both before and after V2 comparison. A
      // mid-flight V1 change is a refusal, even if the final values appear
      // equal; a candidate must never be silently selected in that window.
      const sourceBefore = parseLegacyStateWithPending();
      if (sourceBefore.missing) {
        pilotReadProbeRefusals += 1;
        return result('legacy_unavailable', { matched: false });
      }
      const beforeSubset = sourceSubset(sourceBefore.state);
      const beforeFingerprint = stableJson(paritySubset(beforeSubset));
      const legacyHabit = beforeSubset.habits.find(habit =>
        String(habit?.id ?? '') === habitId) || null;
      const legacyCompletions = beforeSubset.completions.filter(row =>
        String(row?.habitId ?? '') === habitId);
      const candidate = await readPilotHabitCandidate(habitId);
      // The explicit diagnostic switch may be turned off while the awaited
      // IDB comparison is in flight. Refuse instead of returning late results.
      if (!pilotReadProbeEnabled || probeEpoch !== pilotReadProbeEpoch) {
        pilotReadProbeRefusals += 1;
        return result('probe_disabled_during_check', { matched: false });
      }
      if (!candidate.eligible) {
        pilotReadProbeRefusals += 1;
        return result(candidate.reason, { matched: false });
      }
      const sourceAfter = parseLegacyStateWithPending();
      if (sourceAfter.missing
        || stableJson(paritySubset(sourceSubset(sourceAfter.state))) !== beforeFingerprint) {
        pilotReadProbeRefusals += 1;
        return result('legacy_changed_during_probe', { matched: false });
      }
      // Habit row plus all duplicate-ID completion instances must match
      // under the exact same narrowly scoped canonicalization as full pilot
      // parity. Do not log, cache, expose, or repair private record payloads.
      const expected = stableJson({
        habit: normalizeHabitForParity(legacyHabit),
        completions: legacyCompletions.map(normalizePilotCompletionForParity)
      });
      const actual = stableJson({
        habit: normalizeHabitForParity(candidate.habit),
        completions: candidate.completions.map(normalizePilotCompletionForParity)
      });
      if (!pilotReadProbeEnabled || probeEpoch !== pilotReadProbeEpoch) {
        pilotReadProbeRefusals += 1;
        return result('probe_disabled_during_check', { matched: false });
      }
      const matched = expected === actual;
      if (matched) pilotReadProbeMatches += 1;
      else pilotReadProbeRefusals += 1;
      return result(matched ? 'preview_matches_legacy' : 'preview_mismatch', {
        matched,
        lookupMode: candidate.lookupMode,
        generation: candidate.generation,
        revision: candidate.revision,
        counts: { legacyCompletions: legacyCompletions.length,
          candidateCompletions: candidate.completions.length }
      });
    } catch (_) {
      pilotReadProbeRefusals += 1;
      return result('probe_unreadable', { matched: false });
    }
  }

  function getStatus() {
    let visibleGeneration = null;
    let generationReadable = true;
    try { visibleGeneration = currentGeneration({ create: false }); }
    catch (_) { generationReadable = false; }
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
      revisionSignalKey: REVISION_SIGNAL_KEY,
      revisionChannelName: REVISION_CHANNEL_NAME,
      contextId,
      revisionInvalidationListenersInstalled,
      externalRevisionInvalidated,
      externalRevision,
      externalRevisionMutationId,
      externalRevisionAtISO,
      externalRevisionSource,
      externalRevisionReloadRequests,
      generationInteractionReloadRequests,
      generationInteractionSafetyBlocks,
      interactionPageGeneration,
      generationKey: GENERATION_KEY,
      currentGeneration: visibleGeneration,
      generationReadable,
      lastResetGeneration,
      lastKnownRevision,
      lastRevisionConflict,
      lastMutationId,
      lastSeedHash,
      lastError,
      lastParity,
      readAuthority: 'legacy_only',
      pilotReadProbeEnabled,
      pilotReadProbeChecks,
      pilotReadProbeMatches,
      pilotReadProbeRefusals,
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

  function startCoordinatedDarkMirror() {
    if (!isDarkEnabled()) return Promise.resolve(getStatus());
    // Bind the Home page's in-memory UI to its *startup* generation once.
    // Never silently adopt a newer imported generation in an old tab:
    // the next Habit touch must refresh V1 before changing anything.
    const startupGeneration = currentGeneration();
    if (!interactionPageGeneration) interactionPageGeneration = startupGeneration;
    // Preserve the ordinary dark-mirror mutation hook. The WAL bridge owns only
    // startup seed/replay ordering; it does not replace the normal mirror path.
    currentGeneration();
    installRevisionInvalidationListeners();
    installPreviewPeerResponder();
    installHabitJournalHook();
    const bridge = global.TaskPointsStateRuntimeV2WalBridge;
    if (bridge?.__installedModule && typeof bridge.start === 'function') {
      return bridge.start();
    }
    return startDarkMirror();
  }

  function enableDarkMirror() {
    darkMirrorModeEpoch += 1;
    safeSet(DARK_MODE_KEY, '1');
    currentGeneration();
    startCoordinatedDarkMirror();
    return getStatus();
  }

  function disableDarkMirror() {
    darkMirrorModeEpoch += 1;
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
    REVISION_SIGNAL_KEY,
    REVISION_CHANNEL_NAME,
    isDarkEnabled,
    installRevisionInvalidationListeners,
    checkForExternalRevisionSignal,
    beforeHabitInteraction,
    enableDarkMirror,
    disableDarkMirror,
    startDarkMirror,
    startCoordinatedDarkMirror,
    open,
    inspectStartupMeta,
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
    // Dark mirrors are already serialized. WAL confirmation can wait for the
    // current queue without adding a second racing mutation transaction.
    waitForHabitMirrorIdle: () => mirrorTail,
    hasCommittedHabitMutation,
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
    inspectPilotReadiness,
    inspectPilotCompletionIndexCoverage,
    inspectMutationHandoffPrerequisites,
    inspectPreviewWriterPeers,
    exercisePreviewCooperativeWriterLease,
    inspectPreservedParityMismatch,
    inspectLegacyRollbackSource,
    createPreviewRecoveryCheckpoint,
    inspectPreviewRecoveryCheckpoint,
    inspectPreviewRollbackPlan,
    rehearseExclusiveWriterLease,
    readPilotHabitCandidate,
    setPilotReadProbeEnabled,
    probePilotHabitRead,
    getStatus
  };

  global.TaskPointsStateRuntimeV2 = api;

  if (isDarkEnabled()) {
    if (global.document?.readyState === 'loading') {
      global.document.addEventListener?.('DOMContentLoaded', () => startCoordinatedDarkMirror(), { once: true });
    } else if (typeof global.setTimeout === 'function') {
      global.setTimeout(() => startCoordinatedDarkMirror(), 0);
    } else {
      startCoordinatedDarkMirror();
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
