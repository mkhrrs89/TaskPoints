(function installTaskPointsStateRuntimeV2(global) {
  'use strict';

  const core = global?.TaskPointsCore;
  if (!global || !core || global.TaskPointsStateRuntimeV2?.__installedModule) return;

  const DB_NAME = 'taskpoints_state_v2';
  // V6 adds isolated Gold transaction rows with a preview-only receipt.
  // All legacy Gold authority, storage and recovery remain untouched.
  const DB_VERSION = 6;
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
      // No broadcast response can prove that a suspended or old-version
      // page is absent; even responding V2 tabs still use V1 writers.
      silentLegacyWriterExclusionVerified: false,
      productionWriterAdmissionComplete: false,
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
    if (!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('todayDays')) db.createObjectStore('todayDays', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('goldLedger')) db.createObjectStore('goldLedger', { keyPath: 'id' });
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
    // The V1 snapshot is authoritative until a separately authorized
    // cutover. A denied localStorage read is NOT evidence of an empty app or
    // an approved reset: silently converting it to null could clear or
    // misrepresent durable V2 data during seeding/export.
    let raw;
    try {
      if (typeof global.localStorage?.getItem !== 'function')
        throw new Error('local_storage_unavailable');
      raw = global.localStorage.getItem(storageKey);
    } catch (_) {
      throw new Error('state_runtime_v2_legacy_snapshot_unreadable');
    }
    if (raw !== null && typeof raw !== 'string')
      throw new Error('state_runtime_v2_legacy_snapshot_invalid');
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

  async function clearForMissingLegacy(db, previousMeta = null,
    resetGeneration = currentGeneration(), expectedModeEpoch = darkMirrorModeEpoch) {
    // A V1 key absent at the *start* of an asynchronous seed may reappear
    // before the IndexedDB transaction begins (e.g. another tab restores a
    // snapshot). A reset generation may also rotate while the DB opens.
    // Neither case authorizes clearing the old V2 evidence.
    const assertStillAuthorizedEmpty = () => {
      if (!isDarkEnabled() || darkMirrorModeEpoch !== expectedModeEpoch
        || currentGeneration({ create: false }) !== resetGeneration)
        throw new Error('state_runtime_v2_empty_seed_context_changed');
      let raw;
      try {
        if (typeof global.localStorage?.getItem !== 'function')
          throw new Error('local_storage_unavailable');
        raw = global.localStorage.getItem(core.STORAGE_KEY || 'taskpoints_v1');
      } catch (_) {
        throw new Error('state_runtime_v2_empty_seed_source_unreadable');
      }
      if (raw !== null)
        throw new Error('state_runtime_v2_empty_seed_source_restored');
    };
    assertStillAuthorizedEmpty();
    const revision = Number(previousMeta?.revision || 0) + 1;
    await guardedSeedReplace(db, previousMeta, (tx) => {
      // Repeat inside the synchronous transaction callback, immediately
      // before any clear; this is not a global cross-tab writer fence.
      assertStillAuthorizedEmpty();
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
    const desiredModeEpoch = darkMirrorModeEpoch;
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
        // A "force" reseed is NOT an authorized reset. If V1 disappears
        // without a generation rotation, preserve the existing V2 evidence
        // even when a manual/diagnostic caller requests force:true.
        if (previousMeta?.resetGeneration === desiredGeneration) {
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
        return clearForMissingLegacy(db, previousMeta, desiredGeneration, desiredModeEpoch);
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
  // The real V2 ledger keeps an immutable acknowledgement of the full Habit
  // payload. Its short FNV identifier is only a lookup key, not identity proof.
  function assertCommittedHabitMutationIdentity(row, delta, generation, mutationId, meta) {
    const revision = Number(row?.revision);
    const currentRevision = Number(meta?.revision);
    if (!row || row.id !== mutationId
      || row.type !== 'habit-completion-set'
      || row.status !== 'committed'
      || row.resetGeneration !== generation
      || meta?.resetGeneration !== generation
      || !Number.isSafeInteger(revision) || revision < 1
      || !Number.isSafeInteger(currentRevision) || revision > currentRevision
      || mutationIdForDelta(delta, generation) !== mutationId
      || !row.delta || stableJson(row.delta) !== stableJson(delta)) {
      throw new Error('state_runtime_v2_mutation_identity_mismatch:' + mutationId);
    }
  }

  async function hasCommittedHabitMutation(mutationId, expectedGeneration, expectedDelta = null) {
    // Never clear a durable WAL row based only on the short mutation ID.
    if (!isDarkEnabled() || !mutationId || !expectedGeneration || !expectedDelta) return false;
    const delta = normalizeDelta(expectedDelta);
    const db = await open();
    if (!db) return false;
    const tx = db.transaction(['mutations', 'meta'], 'readonly');
    const [mutation, meta] = await Promise.all([
      requestPromise(tx.objectStore('mutations').get(String(mutationId))),
      requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID))
    ]);
    if (!mutation) return false;
    assertCommittedHabitMutationIdentity(
      mutation, delta, String(expectedGeneration), String(mutationId), meta
    );
    return true;
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
            // Matching a short hash cannot acknowledge a different payload.
            assertCommittedHabitMutationIdentity(
              existingMutation, delta, expectedGeneration, mutationId, runtimeMeta
            );
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

  // Capture the compatibility revision and its Habit/completion records
  // atomically in ONE readonly IndexedDB transaction. A writer cannot
  // interleave a different V2 revision into this transaction. The caller
  // still checks a fresh metadata read afterward to reject a newer commit
  // made immediately after this consistent collection snapshot.
  async function readV2CompatibilityCollections(db) {
    const tx = db.transaction(['habits', 'completions', 'meta'], 'readonly');
    const metaRequest = tx.objectStore('meta').get(RUNTIME_META_ID);
    const habitsRequest = tx.objectStore('habits').getAll();
    const completionsRequest = tx.objectStore('completions').getAll();
    const [meta, habitRows, completionRows] = await Promise.all([
      requestPromise(metaRequest),
      requestPromise(habitsRequest),
      requestPromise(completionsRequest)
    ]);
    return {
      meta,
      habits: (habitRows || [])
        .slice()
        .sort((a, b) => Number(a.legacyIndex || 0) - Number(b.legacyIndex || 0))
        .map(row => clone(row.value)),
      completions: unpackCompletionRows(completionRows)
    };
  }

  // A reset marked empty is not enough to prove the mirror contains no
  // surviving pilot, mutation or preview-only evidence. Count both Task
  // Projects, Today and Gold preview stores; none is authoritative.
  // Count all stores with runtime metadata in ONE readonly transaction.
  async function readV2EmptyResetEvidence(db) {
    const tx = db.transaction(
      ['habits', 'completions', 'mutations', 'tasks', 'projects', 'todayDays', 'goldLedger', 'meta'], 'readonly'
    );
    const [meta, habits, completions, mutations, tasks, projects, todayDays, goldLedger] = await Promise.all([
      requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
      requestPromise(tx.objectStore('habits').count()),
      requestPromise(tx.objectStore('completions').count()),
      requestPromise(tx.objectStore('mutations').count()),
      requestPromise(tx.objectStore('tasks').count()),
      requestPromise(tx.objectStore('projects').count()),
      requestPromise(tx.objectStore('todayDays').count()),
      requestPromise(tx.objectStore('goldLedger').count())
    ]);
    return { meta, habits, completions, mutations, tasks, projects, todayDays, goldLedger };
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

  // V1's synchronous Task journal may not yet be compacted into the V1
  // snapshot. An export candidate built from the Habit-only overlay silently
  // misses those Task/Work/metric changes. Overlay both journals in V1 order,
  // and refuse corrupt Task journal evidence instead of treating it as empty.
  function applyTaskJournalToCompatibilitySource(sourceState) {
    if (typeof core.readPendingTaskMutations !== 'function'
      || typeof core.applyPendingTaskMutations !== 'function') {
      // Older standalone Habit-only harnesses, and pages where the Task
      // journal module was never installed, must retain the original export
      // behavior ONLY when there is provably no pending Task journal.
      // A present but unreadable journal is never equivalent to no changes.
      let raw;
      try { raw = global.localStorage.getItem('taskpoints_pending_task_mutations_v1'); }
      catch (_) {
        throw new Error('state_runtime_v2_compatibility_task_journal_unreadable');
      }
      if (raw === null) return clone(sourceState);
      throw new Error('state_runtime_v2_compatibility_task_journal_unavailable');
    }
    const pending = core.readPendingTaskMutations();
    if (pending?.malformed || !pending?.record
      || !Array.isArray(pending.record.tasks)
      || !Array.isArray(pending.record.completionUpserts)
      || !Array.isArray(pending.record.completionDeletes))
      throw new Error('state_runtime_v2_compatibility_task_journal_malformed');
    // The production journal's own replay function preserves its exact
    // ordering, upsert and deletion rules. Work on an isolated clone only.
    const overlaid = core.applyPendingTaskMutations(clone(sourceState), pending.record);
    if (!overlaid || !Array.isArray(overlaid.tasks)
      || !Array.isArray(overlaid.completions))
      throw new Error('state_runtime_v2_compatibility_task_overlay_invalid');
    return overlaid;
  }

  async function buildCompatibilitySnapshot() {
    if (!isDarkEnabled()) throw new Error('state_runtime_v2_dark_disabled');
    await seedFromLegacy();
    const sourceInventory = captureReadOnlyFullStorageInventory();
    const expectedGeneration = currentGeneration({ create: false });
    const modeEpoch = darkMirrorModeEpoch;
    const source = parseLegacyStateWithPending();
    if (source.missing) {
      // Keep the historical empty-state result ONLY for a verified
      // same-generation V2 reset/empty marker. A temporary key disappearance
      // with retained V2 rows must never produce a deceptively valid {} export.
      if (!isDarkEnabled() || darkMirrorModeEpoch !== modeEpoch
        || currentGeneration({ create: false }) !== expectedGeneration
        || captureReadOnlyFullStorageInventory() !== sourceInventory)
        throw new Error('state_runtime_v2_compatibility_source_changed_during_capture');
      const emptyDb = await open();
      if (!emptyDb) throw new Error('state_runtime_v2_compatibility_db_unavailable');
      // The marker alone cannot hide retained records or a WAL ledger.
      // Shared count-based evidence is also used by verifyParity().
      let evidence;
      try { evidence = await readV2EmptyResetEvidence(emptyDb); }
      catch (_) {
        throw new Error('state_runtime_v2_compatibility_empty_evidence_unreadable');
      }
      const emptyMeta = evidence.meta;
      if (!emptyMeta || emptyMeta.schemaVersion !== SCHEMA_VERSION
        || emptyMeta.resetGeneration !== expectedGeneration
        || emptyMeta.legacyMissing !== true)
        throw new Error('state_runtime_v2_compatibility_legacy_missing_unverified');
      if (evidence.habits !== 0 || evidence.completions !== 0
        || evidence.mutations !== 0 || evidence.tasks !== 0
        || evidence.projects !== 0 || evidence.todayDays !== 0
        || evidence.goldLedger !== 0)
        throw new Error('state_runtime_v2_compatibility_empty_evidence_retained');
      // A separate metadata read rejects a revision committed after the
      // consistent emptiness check. An old noncooperating tab can still write
      // after our final check: this is not a production writer fence.
      if (stableJson(await readMeta(emptyDb)) !== stableJson(emptyMeta))
        throw new Error('state_runtime_v2_compatibility_v2_revision_changed_during_read');
      if (!isDarkEnabled() || darkMirrorModeEpoch !== modeEpoch
        || currentGeneration({ create: false }) !== expectedGeneration
        || captureReadOnlyFullStorageInventory() !== sourceInventory)
        throw new Error('state_runtime_v2_compatibility_source_changed_during_read');
      return {};
    }
    const effective = applyTaskJournalToCompatibilitySource(source.state);
    if (captureReadOnlyFullStorageInventory() !== sourceInventory)
      throw new Error('state_runtime_v2_compatibility_source_changed_during_capture');
    // The metadata and collections must describe the SAME IndexedDB snapshot.
    // An independent post-read metadata check still rejects a newer V2
    // mutation committed while we were assembling this preview export.
    const db = await open();
    if (!db) throw new Error('state_runtime_v2_compatibility_db_unavailable');
    const collections = await readV2CompatibilityCollections(db);
    const metaBefore = collections.meta;
    if (!metaBefore || metaBefore.schemaVersion !== SCHEMA_VERSION
      || metaBefore.resetGeneration !== expectedGeneration
      || metaBefore.legacyMissing === true)
      throw new Error('state_runtime_v2_compatibility_metadata_not_ready');
    const metaAfter = await readMeta(db);
    if (stableJson(metaAfter) !== stableJson(metaBefore))
      throw new Error('state_runtime_v2_compatibility_v2_revision_changed_during_read');
    if (!isDarkEnabled() || darkMirrorModeEpoch !== modeEpoch
      || currentGeneration({ create: false }) !== expectedGeneration
      || captureReadOnlyFullStorageInventory() !== sourceInventory)
      throw new Error('state_runtime_v2_compatibility_source_changed_during_read');
    return {
      ...effective,
      habits: collections.habits,
      completions: mergeCompatibilityCompletions(effective.completions, collections.completions)
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
      const expectedGeneration = currentGeneration({ create: false });
      const modeEpoch = darkMirrorModeEpoch;
      const inventory = captureReadOnlyFullStorageInventory();
      const db = await open();
      if (!db) throw new Error('state_runtime_v2_parity_empty_db_unavailable');
      let evidence;
      try { evidence = await readV2EmptyResetEvidence(db); }
      catch (_) { throw new Error('state_runtime_v2_parity_empty_evidence_unreadable'); }
      const afterMeta = await readMeta(db);
      const sourceStable = isDarkEnabled() && modeEpoch === darkMirrorModeEpoch
        && currentGeneration({ create: false }) === expectedGeneration
        && captureReadOnlyFullStorageInventory() === inventory;
      // A changing source/revision cannot be considered a completed parity
      // check, even if both observed counts happened to be zero.
      const consistent = sourceStable
        && stableJson(afterMeta) === stableJson(evidence.meta);
      const markerValid = evidence.meta?.schemaVersion === SCHEMA_VERSION
        && evidence.meta?.resetGeneration === expectedGeneration
        && evidence.meta?.legacyMissing === true;
      const empty = evidence.habits === 0 && evidence.completions === 0
        && evidence.mutations === 0 && evidence.tasks === 0
        && evidence.projects === 0 && evidence.todayDays === 0
        && evidence.goldLedger === 0;
      lastParity = {
        checked: consistent, match: Boolean(consistent && markerValid && empty),
        legacyMissing: true,
        reason: !consistent ? 'empty_reset_context_changed'
          : !markerValid ? 'empty_reset_marker_unverified'
            : !empty ? 'empty_reset_evidence_retained' : 'verified_empty_reset',
        counts: { habits: evidence.habits,
          completions: evidence.completions, mutations: evidence.mutations,
          tasks: evidence.tasks, projects: evidence.projects,
          todayDays: evidence.todayDays, goldLedger: evidence.goldLedger },
        checkedAtISO: nowIso()
      };
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

  // EXPLICIT PREVIEW ONLY: supply the index metadata missing from older V2
  // completion packs. This is NOT a V1 migration, user action, or live repair.
  // Values, IDs, history order, WAL and V1 authority must remain untouched.
  // Process a small bounded batch so metadata maintenance is never a giant
  // synchronous foreground write. Every existing metadata conflict refuses.
  async function rehearsePreviewCompletionIndexBackfill() {
    const refuse = (reason, extra = {}) => ({
      checked: true, previewOnly: true, applied: false,
      confirmedDurable: false, canPromote: false,
      productionWritersFenced: false, readAuthority: 'legacy_only',
      mutationAuthority: 'legacy_only', reason, ...extra
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    const modeEpoch = darkMirrorModeEpoch;
    const generation = currentGeneration({ create: false });
    if (!generation) return refuse('generation_unavailable');
    // Any maintenance attempt invalidates previously cached index proofs.
    previewHabitIndexProof = null;
    previewHabitIndexAuditEpoch += 1;
    let inventory, source;
    try {
      inventory = captureReadOnlyFullStorageInventory();
      source = parseLegacyStateWithPending();
      if (source.missing) return refuse('legacy_unavailable');
      if (captureReadOnlyFullStorageInventory() !== inventory)
        return refuse('legacy_changed_during_capture');
    } catch (_) { return refuse('legacy_unreadable'); }
    const sourceCurrent = () => isDarkEnabled()
      && darkMirrorModeEpoch === modeEpoch
      && currentGeneration({ create: false }) === generation
      && captureReadOnlyFullStorageInventory() === inventory;
    let db, habitRows, completionRows, meta;
    try {
      db = await open();
      if (!db) return refuse('v2_unavailable');
      const tx = db.transaction(['habits', 'completions', 'meta'], 'readonly');
      [habitRows, completionRows, meta] = await Promise.all([
        requestPromise(tx.objectStore('habits').getAll()),
        requestPromise(tx.objectStore('completions').getAll()),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID))
      ]);
    } catch (_) { return refuse('v2_source_unreadable'); }
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_during_read');
      if (!meta || meta.schemaVersion !== SCHEMA_VERSION
        || meta.resetGeneration !== generation || meta.legacyMissing === true
        || !Number.isSafeInteger(Number(meta.revision))
        || Number(meta.revision) < 0)
        return refuse('pilot_meta_not_ready');
      const seen = new Set(), missing = [];
      for (const row of completionRows) {
        if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id))
          return refuse('completion_pack_invalid');
        seen.add(row.id);
        const entries = Array.isArray(row.entries) ? row.entries
          : Object.prototype.hasOwnProperty.call(row, 'value') ? [row] : [];
        if (!entries.length || entries.some(entry =>
          !entry || !entry.value || typeof entry.value !== 'object'
          || Array.isArray(entry.value) || !Number.isFinite(Number(entry.sequence))
          || (entry.value.id != null && String(entry.value.id) !== row.id)))
          return refuse('completion_pack_invalid');
        const expected = completionHabitIdsForRow(row);
        if (typeof row.habitIds === 'undefined') {
          missing.push({ id: row.id, row: withCompletionHabitIds(row) });
        } else if (!Array.isArray(row.habitIds)
          || stableJson(row.habitIds) !== stableJson(expected)) {
          return refuse('existing_index_metadata_invalid');
        }
      }
      const habits = habitRows.slice().sort((a,b) =>
        Number(a.legacyIndex || 0) - Number(b.legacyIndex || 0)
      ).map(row => clone(row.value));
      const completions = unpackCompletionRows(completionRows);
      if (pilotCompletions({completions}).length !== completions.length)
        return refuse('unexpected_nonpilot_completions');
      if (stableJson(paritySubset({ habits, completions }))
        !== stableJson(paritySubset(sourceSubset(source.state))))
        return refuse('legacy_pilot_parity_mismatch');
      if (!sourceCurrent()) return refuse('legacy_changed_after_parity');
      if (stableJson(await readMeta(db)) !== stableJson(meta))
        return refuse('v2_revision_changed_during_validation');
      if (!missing.length) return {
        ...refuse('already_indexed', { pending: 0 }),
        checked: true, alreadyCurrent: true
      };
      const batch = missing.slice(0, 64);
      const revision = Number(meta.revision) + 1;
      if (!Number.isSafeInteger(revision)) return refuse('revision_exhausted');
      const nextMeta = {
        ...meta, revision, updatedAtISO: nowIso()
      };
      let abortReason = null;
      const tx = db.transaction(['completions', 'meta'], 'readwrite');
      const metaRequest = tx.objectStore('meta').get(RUNTIME_META_ID);
      metaRequest.onsuccess = () => {
        try {
          if (stableJson(metaRequest.result || null) !== stableJson(meta)) {
            abortReason = 'v2_revision_changed_before_write';
            tx.abort(); return;
          }
          if (!sourceCurrent()) {
            abortReason = 'legacy_changed_before_write';
            tx.abort(); return;
          }
          const store = tx.objectStore('completions');
          // Re-read the exact packed rows in this same serialized transaction
          // before overwriting only their missing habitIds metadata.
          let remaining = batch.length;
          for (const item of batch) {
            const request = store.get(item.id);
            request.onsuccess = () => {
              if (stableJson(request.result) !== stableJson(
                completionRows.find(row => row.id === item.id))) {
                abortReason = 'completion_pack_changed_before_write';
                tx.abort(); return;
              }
              remaining -= 1;
              if (remaining === 0) {
                try {
                  if (!sourceCurrent()) {
                    abortReason = 'legacy_changed_before_write';
                    tx.abort(); return;
                  }
                  for (const target of batch) store.put(target.row);
                  tx.objectStore('meta').put(nextMeta);
                } catch (_) {
                  abortReason = 'index_backfill_write_unavailable';
                  tx.abort();
                }
              }
            };
          }
        } catch (_) {
          abortReason = 'index_backfill_guard_unreadable';
          tx.abort();
        }
      };
      try { await transactionPromise(tx); }
      catch (_) { return refuse(abortReason || 'index_backfill_transaction_aborted'); }

      // A committed transaction is not automatically proof of a durable,
      // unchanged source. Read every written row + meta back before success.
      let verifiedRows, verifiedMeta;
      try {
        const check = db.transaction(['completions', 'meta'], 'readonly');
        [verifiedRows, verifiedMeta] = await Promise.all([
          Promise.all(batch.map(item =>
            requestPromise(check.objectStore('completions').get(item.id)))),
          requestPromise(check.objectStore('meta').get(RUNTIME_META_ID))
        ]);
      } catch (_) {
        return refuse('index_backfill_readback_unavailable', {
          applied: true, committedButUnverified: true
        });
      }
      if (!sourceCurrent() || stableJson(verifiedMeta) !== stableJson(nextMeta)
        || verifiedRows.some((row,i) =>
          stableJson(row) !== stableJson(batch[i].row))) {
        return refuse('index_backfill_readback_changed', {
          applied: true, committedButUnverified: true
        });
      }
      lastKnownRevision = revision;
      publishCommittedRevision(revision, 'v2-preview-index-backfill', generation);
      return {
        checked: true, previewOnly: true, applied: true,
        confirmedDurable: true, reason: 'index_metadata_backfilled',
        updatedRows: batch.length, remainingRows: missing.length - batch.length,
        revision, generation, canPromote: false,
        productionWritersFenced: false, readAuthority: 'legacy_only',
        mutationAuthority: 'legacy_only'
      };
    } catch (_) { return refuse('index_backfill_validation_unreadable'); }
  }

  // Keep at most ONE audited index proof: the full-origin snapshot can be
  // several MiB, so never accumulate a per-Habit cache of source inventories.
  // This evidence lives only in this preview tab and is invalidated when an
  // audit is attempted again or its generation/revision/source changes.
  let previewHabitIndexProof = null;
  let previewHabitIndexAuditEpoch = 0;

  // Preview-only evidence for a future fast per-Habit completion index read.
  // An index's mere existence does not prove that historical completion
  // packs were indexed. Compare a full scan and the indexed lookup inside
  // ONE readonly transaction, including duplicate-ID packs and sequence.
  // Never repair source rows, cache this as a production permit or promote.
  async function inspectPreviewHabitCompletionIndexParity(habitIdInput) {
    previewHabitIndexProof = null;
    // Overlapping audits cannot let an older asynchronous attempt replace
    // the newer audit's proof after its IndexedDB read finally resolves.
    const auditEpoch = ++previewHabitIndexAuditEpoch;
    const refuse = (reason, detail = {}) => ({
      checked: true, previewOnly: true, indexVerified: false,
      canPromote: false, readAuthority: 'legacy_only',
      mutationAuthority: 'legacy_only', productionWritersFenced: false,
      reason, ...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof habitIdInput !== 'string' || !habitIdInput.trim()
      || habitIdInput.length > 256) return refuse('habit_id_required');
    const habitId = habitIdInput.trim();
    const generation = currentGeneration({ create: false });
    if (!generation) return refuse('generation_unavailable');
    const modeEpoch = darkMirrorModeEpoch;
    let inventory, legacySource;
    try {
      inventory = captureReadOnlyFullStorageInventory();
      legacySource = parseLegacyStateWithPending();
      if (legacySource.missing) return refuse('legacy_unavailable');
      if (captureReadOnlyFullStorageInventory() !== inventory)
        return refuse('legacy_changed_during_capture');
    } catch (_) { return refuse('legacy_source_unreadable'); }
    const sourceCurrent = () => isDarkEnabled()
      && darkMirrorModeEpoch === modeEpoch
      && currentGeneration({ create: false }) === generation
      && captureReadOnlyFullStorageInventory() === inventory;
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_before_read');
    } catch (_) { return refuse('legacy_unreadable_before_read'); }

    let db, allRows, indexRows, meta;
    try {
      db = await open();
      if (!db) return refuse('v2_unavailable');
      const tx = db.transaction(['completions', 'meta'], 'readonly');
      const store = tx.objectStore('completions');
      if (!store.indexNames.contains(COMPLETION_HABIT_INDEX))
        return refuse('completion_index_missing');
      [allRows, indexRows, meta] = await Promise.all([
        requestPromise(store.getAll()),
        requestPromise(store.index(COMPLETION_HABIT_INDEX).getAll(habitId)),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID))
      ]);
    } catch (_) { return refuse('index_read_unavailable'); }
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_during_read');
      if (!meta || meta.schemaVersion !== SCHEMA_VERSION
        || meta.resetGeneration !== generation || meta.legacyMissing === true)
        return refuse('pilot_meta_not_ready');
      // The entire V2 completion store must have correct metadata, not
      // just the indexed rows returned for this specific Habit.
      const invalidRows = allRows.filter(row => !Array.isArray(row?.habitIds)
        || stableJson(row.habitIds) !== stableJson(completionHabitIdsForRow(row)));
      if (invalidRows.length)
        return refuse('completion_index_metadata_incomplete', {
          scannedRows: allRows.length, invalidRows: invalidRows.length
        });
      const relevant = rows => unpackCompletionRows(rows).filter(
        completion => String(completion?.habitId || '') === habitId
      );
      const expected = relevant(allRows);
      const actual = relevant(indexRows);
      if (stableJson(actual) !== stableJson(expected))
        return refuse('completion_index_result_mismatch', {
          fullScanCompletions: expected.length, indexedCompletions: actual.length
        });
      // A perfect index can faithfully return a corrupted or stale V2 mirror.
      // Require the audited Habit history to agree with effective V1 authority
      // (including pending Habit journal deltas) before issuing reusable proof.
      const legacyCompletions = pilotCompletions(legacySource.state).filter(
        completion => String(completion?.habitId ?? '') === habitId
      );
      const normalized = rows => stableJson(rows.map(normalizePilotCompletionForParity));
      if (normalized(legacyCompletions) !== normalized(expected))
        return refuse('legacy_pilot_completion_parity_mismatch', {
          legacyCompletions: legacyCompletions.length,
          v2Completions: expected.length
        });
      const metaAfter = await readMeta(db);
      if (!sourceCurrent()) return refuse('legacy_changed_after_read');
      if (stableJson(metaAfter) !== stableJson(meta))
        return refuse('v2_revision_changed_during_read');
      if (auditEpoch !== previewHabitIndexAuditEpoch)
        return refuse('index_audit_superseded');
      previewHabitIndexProof = {
        habitId, generation, modeEpoch, inventory,
        metaJson: stableJson(meta)
      };
      return {
        checked: true, previewOnly: true, indexVerified: true,
        reason: 'completion_index_scoped_parity_verified',
        habitId, generation, revision: Number(meta.revision || 0),
        scannedRows: allRows.length, indexedRows: indexRows.length,
        matchingCompletions: expected.length,
        canPromote: false, productionWritersFenced: false,
        readAuthority: 'legacy_only', mutationAuthority: 'legacy_only'
      };
    } catch (_) { return refuse('completion_index_verification_unreadable'); }
  }

  // A successful full-store index audit may be reused for a narrowly
  // targeted preview read, without another getAll scan. It is deliberately
  // NOT used by getCompletionsForHabit or any live screen. An unexpected
  // change in V1 source, V2 revision or generation invalidates the proof.
  // Nonparticipating old tabs remain unfenced; do not authorize cutover.
  async function readPreviewIndexedHabitCompletions(habitIdInput) {
    const refuse = reason => ({
      checked: true, previewOnly: true, eligible: false, reason,
      canPromote: false, productionWritersFenced: false,
      readAuthority: 'legacy_only', mutationAuthority: 'legacy_only'
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof habitIdInput !== 'string' || !habitIdInput.trim()
      || habitIdInput.length > 256) return refuse('habit_id_required');
    const habitId = habitIdInput.trim();
    const proof = previewHabitIndexProof;
    const invalidateOwnProof = () => {
      // Older in-flight lookups must not erase a newer audit's evidence.
      if (previewHabitIndexProof === proof) previewHabitIndexProof = null;
    };
    if (!proof || proof.habitId !== habitId)
      return refuse('fresh_index_audit_required');
    const sourceCurrent = () => isDarkEnabled()
      && darkMirrorModeEpoch === proof.modeEpoch
      && currentGeneration({ create: false }) === proof.generation
      && captureReadOnlyFullStorageInventory() === proof.inventory;
    try {
      if (!sourceCurrent()) {
        invalidateOwnProof();
        return refuse('index_audit_source_stale');
      }
    } catch (_) {
      invalidateOwnProof();
      return refuse('index_audit_source_unreadable');
    }
    let db, rows, meta;
    try {
      db = await open();
      if (!db) return refuse('v2_unavailable');
      const tx = db.transaction(['completions', 'meta'], 'readonly');
      const store = tx.objectStore('completions');
      if (!store.indexNames.contains(COMPLETION_HABIT_INDEX)) {
        invalidateOwnProof();
        return refuse('completion_index_missing');
      }
      [rows, meta] = await Promise.all([
        requestPromise(store.index(COMPLETION_HABIT_INDEX).getAll(habitId)),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID))
      ]);
    } catch (_) {
      invalidateOwnProof();
      return refuse('indexed_read_unavailable');
    }
    try {
      if (!sourceCurrent()) {
        invalidateOwnProof();
        return refuse('index_audit_source_stale');
      }
      if (!meta || meta.schemaVersion !== SCHEMA_VERSION
        || meta.resetGeneration !== proof.generation || meta.legacyMissing === true
        || stableJson(meta) !== proof.metaJson) {
        invalidateOwnProof();
        return refuse('index_audit_revision_stale');
      }
      // Fail closed if any *returned* packed row has changed its index
      // metadata even if a broken writer forgot to bump the revision.
      if (rows.some(row => !Array.isArray(row?.habitIds)
        || stableJson(row.habitIds) !== stableJson(completionHabitIdsForRow(row)))) {
        invalidateOwnProof();
        return refuse('indexed_rows_corrupt');
      }
      const completions = global.Array.from(unpackCompletionRows(rows)
        .filter(row => String(row?.habitId || '') === habitId));
      const after = await readMeta(db);
      if (stableJson(after) !== proof.metaJson) {
        invalidateOwnProof();
        return refuse('index_audit_revision_stale');
      }
      if (!sourceCurrent() || previewHabitIndexProof !== proof) {
        // An older in-flight read must not revoke a *newer* successful audit.
        invalidateOwnProof();
        return refuse('index_audit_source_stale');
      }
      return {
        checked: true, previewOnly: true, eligible: true,
        reason: 'audited_indexed_completion_candidate',
        lookupMode: 'audited_index', habitId,
        generation: proof.generation, revision: Number(meta.revision || 0),
        completions,
        canPromote: false, productionWritersFenced: false,
        readAuthority: 'legacy_only', mutationAuthority: 'legacy_only'
      };
    } catch (_) {
      invalidateOwnProof();
      return refuse('indexed_read_verification_unreadable');
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
    'game_players_schedules_and_preferences',
    'today_snapshot_and_view_state',
    'settings_import_reset_and_direct_storage',
    'notes_content_dirty_and_authority_flags',
    'emergency_recovery_and_restore',
    'task_journal_and_idle_compaction',
    // Main's Work/SCWM fast path can persist through the Task journal or
    // switch to a synchronous full-snapshot fallback. It is a distinct
    // admission route even though its journal sink is already inventoried.
    'work_entry_fast_path_and_editor_fallback'
  ]);

  // Observe EVERY origin-localStorage key, including tp_projects_v1 and
  // other legacy keys outside taskpoints_*. Keep the existing
  // captureLegacyNamespace() and checkpoint format unchanged: this strict
  // full-origin enumeration belongs only to the read-only cutover audit.
  // An equal before/after image is NOT proof of writer fencing (an unfenced
  // tab can write between checks, or change a value and then restore it).
  function captureReadOnlyFullStorageInventory() {
    const storage = global.localStorage;
    if (!storage || typeof storage.key !== 'function'
      || typeof storage.getItem !== 'function'
      || !Number.isSafeInteger(storage.length) || storage.length < 0)
      throw Error('cutover_full_storage_inventory_unavailable');
    const count = storage.length;
    const keys = new Set();
    for (let i = 0; i < count; i += 1) {
      const key = storage.key(i);
      if (typeof key !== 'string' || keys.has(key))
        throw Error('cutover_full_storage_inventory_changed');
      keys.add(key);
    }
    if (storage.length !== count)
      throw Error('cutover_full_storage_inventory_changed');
    const entries = [...keys].sort().map(key => {
      const value = storage.getItem(key);
      if (typeof value !== 'string')
        throw Error('cutover_full_storage_inventory_unreadable');
      return [key, value];
    });
    if (storage.length !== count)
      throw Error('cutover_full_storage_inventory_changed');
    return stableJson(entries);
  }

  // Read-only observation of the *actual* V1 Task mutation journal.
  // Parsing this journal is not replaying it. A malformed row/shape is
  // unresolved evidence, not an empty journal, even if readRecord() on the
  // production path can normalize some legacy entries. No cleanup or writes.
  function inspectReadOnlyTaskJournalForCutover() {
    const raw = global.localStorage.getItem('taskpoints_pending_task_mutations_v1');
    if (raw === null) {
      return { raw: null, reason: 'absent', pendingCount: 0,
        tasks: 0, completionUpserts: 0, completionDeletes: 0 };
    }
    if (typeof raw !== 'string') throw Error('cutover_task_journal_unreadable');
    let record;
    try { record = JSON.parse(raw); }
    catch (_) {
      return { raw, reason: 'malformed', pendingCount: null,
        tasks: null, completionUpserts: null, completionDeletes: null };
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || record.schemaVersion !== 1
      || !Array.isArray(record.tasks)
      || !Array.isArray(record.completionUpserts)
      || !Array.isArray(record.completionDeletes)
      || record.tasks.some(item => !item || typeof item !== 'object'
        || Array.isArray(item) || !item.id)
      || record.completionUpserts.some(item => !item
        || typeof item !== 'object' || Array.isArray(item) || !item.id)
      || record.completionDeletes.some(id => typeof id !== 'string' || !id)) {
      return { raw, reason: 'malformed', pendingCount: null,
        tasks: null, completionUpserts: null, completionDeletes: null };
    }
    const tasks = record.tasks.length;
    const completionUpserts = record.completionUpserts.length;
    const completionDeletes = record.completionDeletes.length;
    const pendingCount = tasks + completionUpserts + completionDeletes;
    return { raw, reason: pendingCount ? 'pending' : 'empty',
      pendingCount, tasks, completionUpserts, completionDeletes };
  }


  // Read-only observation of the distinct Inbox journal used by the three
  // background Inbox producers. Its raw bytes stay private and are compared
  // twice around the asynchronous peer probe. Pending/malformed evidence must
  // NEVER be silently interpreted as an empty canonical Inbox.
  function inspectReadOnlyInboxJournalForCutover() {
    const raw = global.localStorage.getItem('taskpoints_pending_inbox_state_v1');
    const empty = () => ({ raw: null, reason: 'absent', pendingCount: 0,
      messages: 0, processedEventIds: 0, dateMarkers: 0 });
    const malformed = () => ({ raw, reason: 'malformed', pendingCount: null,
      messages: null, processedEventIds: null, dateMarkers: null });
    if (raw === null) return empty();
    if (typeof raw !== 'string' || !raw) return malformed();
    let record;
    try { record = JSON.parse(raw); }
    catch (_) { return malformed(); }
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || ![1, 2].includes(Number(record.schemaVersion || 1))) return malformed();

    const owns = key => Object.prototype.hasOwnProperty.call(record, key);
    const fields = ['inboxMessages', 'inboxProcessedEventIds',
      'inboxStartedDateKey', 'goldTheftTop50InboxStartedDateKey'];
    if (!fields.some(owns)
      || (owns('inboxMessages') && !Array.isArray(record.inboxMessages))
      || (owns('inboxProcessedEventIds')
        && (!record.inboxProcessedEventIds
          || typeof record.inboxProcessedEventIds !== 'object'))
      || (owns('inboxStartedDateKey') && record.inboxStartedDateKey !== null
        && typeof record.inboxStartedDateKey !== 'string')
      || (owns('goldTheftTop50InboxStartedDateKey')
        && record.goldTheftTop50InboxStartedDateKey !== null
        && typeof record.goldTheftTop50InboxStartedDateKey !== 'string')) {
      return malformed();
    }
    const messages = owns('inboxMessages') ? record.inboxMessages.length : 0;
    const events = owns('inboxProcessedEventIds')
      ? (Array.isArray(record.inboxProcessedEventIds)
        ? record.inboxProcessedEventIds.length
        : Object.keys(record.inboxProcessedEventIds).length) : 0;
    const dateMarkers = Number(owns('inboxStartedDateKey'))
      + Number(owns('goldTheftTop50InboxStartedDateKey'));
    // Even a valid record with empty arrays is unresolved writer evidence.
    // Only a physically absent journal can satisfy inboxJournalEmpty.
    return { raw, reason: 'pending', pendingCount: messages + events + dateMarkers,
      messages, processedEventIds: events, dateMarkers };
  }


  // A separate read-only inspection of both V1 Flex Action journals.
  // Absence alone cannot prove a sleeping old tab or deferred save is fenced.
  // Never normalize/write/remove these records here: malformed bytes are
  // deliberately preserved as recovery evidence.
  function inspectReadOnlyFlexJournalsForCutover() {
    const inspect = (key, type) => {
      const raw = global.localStorage.getItem(key);
      if (raw === null) return { raw: null, reason: 'absent', pendingCount: 0 };
      const malformed = () => ({ raw, reason: 'malformed', pendingCount: null });
      if (typeof raw !== 'string' || !raw) return malformed();
      let record;
      try { record = JSON.parse(raw); }
      catch (_) { return malformed(); }
      if (type === 'completions') {
        if (!Array.isArray(record)
          || record.some(entry => !entry || typeof entry !== 'object'
            || Array.isArray(entry) || entry.source !== 'flex'
            || !entry.id || !entry.flexId || !entry.completedAtISO)) return malformed();
        return { raw, reason: 'pending', pendingCount: record.length };
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)
        || !Array.isArray(record.orderedIds) || !record.orderedIds.length
        || record.orderedIds.some(id => typeof id !== 'string' || !id.trim())) {
        return malformed();
      }
      return { raw, reason: 'pending', pendingCount: record.orderedIds.length };
    };
    return {
      completions: inspect('taskpoints_pending_flex_completions_v1', 'completions'),
      order: inspect('taskpoints_pending_flex_order_v1', 'order')
    };
  }

  async function inspectAuthorityCutoverBarriers() {
    const hardBlockers = [
      'all_legacy_writers_not_fenced',
      // An empty observation window cannot exclude old or sleeping tabs.
      'silent_or_suspended_legacy_writers_not_excluded',
      'nonpilot_authoritative_collections_not_migrated',
      'independent_off_device_rollback_not_verified',
      'physical_safari_pwa_lifecycle_not_validated',
      'production_multi_context_handoff_not_validated',
      'task_journal_compaction_handoff_not_validated',
      'inbox_journal_compaction_handoff_not_validated',
      'flex_journal_compaction_handoff_not_validated',
      // Work commit interception can journal several changed rows one by
      // one, or fall back to a full snapshot save. Neither path is fenced
      // by V2 or yet proven as one cross-context atomic logical action.
      'work_entry_multirecord_admission_not_validated'
    ];
    const snapshot = (reason, pilot, rollback, peers, extra = [], taskJournal = null, inboxJournal = null, flexJournals = null) => {
      // Even a completely green Habit pilot and all responsive V2 preview
      // peers say nothing about suspended or pre-V2 legacy-only tabs.
      const checks = {
        pilotConsistent: pilot?.checks?.pilotConsistent === true,
        completionIndexReady: pilot?.checks?.completionIndexReady === true,
        legacyJournalEmpty: pilot?.checks?.legacyJournalEmpty === true,
        // This is a separate V1 Task journal, NOT the Habit/WAL check above.
        taskJournalEmpty: taskJournal?.reason === 'empty'
          || taskJournal?.reason === 'absent',
        // Empty after verified compaction is necessary, NOT an admission
        // guarantee against a paused old tab or an idle callback resuming.
        taskJournalCompactionHandoffValidated: false,
        inboxJournalEmpty: inboxJournal?.reason === 'absent',
        inboxJournalCompactionHandoffValidated: false,
        flexCompletionJournalEmpty: flexJournals?.completions?.reason === 'absent',
        flexOrderJournalEmpty: flexJournals?.order?.reason === 'absent',
        flexJournalCompactionHandoffValidated: false,
        workEntryAtomicAdmissionVerified: false,
        workEntryFallbackPathFenced: false,
        mirrorQueueStable: pilot?.checks?.mirrorQueueStable === true,
        noObservedMirrorFailures: pilot?.checks?.noObservedMirrorFailures === true,
        noObservedBridgeFailures: pilot?.checks?.noObservedBridgeFailures === true,
        stableLegacyRollbackSource: rollback?.sourceStable === true,
        observedPeersOnly: peers?.respondingPreviewTabsOnly === true,
        // A green two-pass V1 inventory is only an instantaneous observation.
        // Nonresponding and pre-V2 pages have no mandatory admission gate.
        silentLegacyWriterExclusionVerified: false,
        productionWriterAdmissionComplete: false,
        legacyWriterQuietWindowProven: false,
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
          ...(taskJournal?.reason === 'pending' ? ['task_mutation_journal_pending'] : []),
          ...(taskJournal?.reason === 'malformed' ? ['task_mutation_journal_malformed'] : []),
          ...(inboxJournal?.reason === 'pending' ? ['inbox_mutation_journal_pending'] : []),
          ...(inboxJournal?.reason === 'malformed' ? ['inbox_mutation_journal_malformed'] : []),
          ...(flexJournals?.completions?.reason === 'pending' ? ['flex_completion_journal_pending'] : []),
          ...(flexJournals?.completions?.reason === 'malformed' ? ['flex_completion_journal_malformed'] : []),
          ...(flexJournals?.order?.reason === 'pending' ? ['flex_order_journal_pending'] : []),
          ...(flexJournals?.order?.reason === 'malformed' ? ['flex_order_journal_malformed'] : []),
          ...extra, ...hardBlockers
        ])],
        knownUnfencedWriterFamilies: [...AUTHORITY_CUTOVER_WRITER_FAMILIES],
        taskJournal: taskJournal ? {
          reason: taskJournal.reason, pendingCount: taskJournal.pendingCount,
          tasks: taskJournal.tasks,
          completionUpserts: taskJournal.completionUpserts,
          completionDeletes: taskJournal.completionDeletes
        } : null,
        inboxJournal: inboxJournal ? {
          reason: inboxJournal.reason, pendingCount: inboxJournal.pendingCount,
          messages: inboxJournal.messages,
          processedEventIds: inboxJournal.processedEventIds,
          dateMarkers: inboxJournal.dateMarkers
        } : null,
        flexJournals: flexJournals ? {
          completions: { reason: flexJournals.completions.reason,
            pendingCount: flexJournals.completions.pendingCount },
          order: { reason: flexJournals.order.reason,
            pendingCount: flexJournals.order.pendingCount }
        } : null,
        pilot: pilot ? { reason: pilot.reason,
          generation: pilot.generation || null, revision: pilot.revision ?? null } : null,
        rollback: rollback ? { reason: rollback.reason,
          sourceStable: rollback.sourceStable === true,
          checkpointExists: rollback.checkpointExists === true,
          canRestoreFromCheckpoint: rollback.canRestoreFromCheckpoint === true } : null,
        peers: peers ? { reason: peers.reason,
          observedPeerCount: peers.observedPeerCount,
          respondingPreviewTabsOnly: peers.respondingPreviewTabsOnly === true,
          silentLegacyWriterExclusionVerified: false,
          productionWriterAdmissionComplete: false } : null
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
      const taskJournalBefore = inspectReadOnlyTaskJournalForCutover();
      const inboxJournalBefore = inspectReadOnlyInboxJournalForCutover();
      const flexJournalsBefore = inspectReadOnlyFlexJournalsForCutover();
      // The preview writer inventory must include ALL current origin storage
      // keys, not merely taskpoints_* checkpoint keys or the Habit pilot.
      const fullStorageBefore = captureReadOnlyFullStorageInventory();
      const peers = await inspectPreviewWriterPeers();
      const pilotAfter = await inspectMutationHandoffPrerequisites();
      const rollbackAfter = await inspectLegacyRollbackSource();
      const taskJournalAfter = inspectReadOnlyTaskJournalForCutover();
      const inboxJournalAfter = inspectReadOnlyInboxJournalForCutover();
      const flexJournalsAfter = inspectReadOnlyFlexJournalsForCutover();
      const fullStorageAfter = captureReadOnlyFullStorageInventory();
      // The asynchronous peer observation is NOT a lock. Detect a new
      // generation or explicit preview switch during the report; never use
      // an earlier green preflight as evidence about a newer generation.
      if (!isDarkEnabled() || modeEpoch !== darkMirrorModeEpoch
        || currentGeneration({ create: false }) !== initialGeneration
        || (pilot.generation && pilot.generation !== initialGeneration)
        || (rollback.generation && rollback.generation !== initialGeneration)
        || stableJson(pilot) !== stableJson(pilotAfter)
        || stableJson(rollback) !== stableJson(rollbackAfter)
        || stableJson(taskJournalBefore) !== stableJson(taskJournalAfter)
        || stableJson(inboxJournalBefore) !== stableJson(inboxJournalAfter)
        || stableJson(flexJournalsBefore) !== stableJson(flexJournalsAfter)
        || fullStorageBefore !== fullStorageAfter)
        return snapshot('inventory_changed_during_check', pilot, rollback, peers,
          ['legacy_or_preview_inventory_changed_during_check'], taskJournalAfter, inboxJournalAfter, flexJournalsAfter);
      return snapshot('authority_cutover_blocked', pilot, rollback, peers,
        [], taskJournalAfter, inboxJournalAfter, flexJournalsAfter);
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
    // Full-origin capture scope is authenticated for new V3 records.
    // Preserve the exact V1/V2 digest formats for existing checkpoints.
    if (record.integrityVersion === 3 && record.captureScope === 'full_origin') {
      return {
        id: record.id, schemaVersion: record.schemaVersion,
        integrityVersion: record.integrityVersion, captureScope: record.captureScope,
        capturedAtISO: record.capturedAtISO, generation: record.generation,
        entries: record.entries
      };
    }
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
    const fullOrigin = record.integrityVersion === 3
      && record.captureScope === 'full_origin';
    if (record.integrityVersion === 3 && !fullOrigin) return false;
    let previous = null;
    let hasLegacy = false;
    for (const entry of record.entries) {
      if (!Array.isArray(entry) || entry.length !== 2
        || typeof entry[0] !== 'string' || typeof entry[1] !== 'string'
        || (!fullOrigin && !entry[0].toLowerCase().startsWith('taskpoints_'))
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
        captureScope: record.integrityVersion === 3
          ? 'full_origin' : 'taskpoints_namespace',
        integrityCoverage: record.integrityVersion === 2 || record.integrityVersion === 3
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
      // Read and authenticate the immutable checkpoint exactly once. A second
      // IDB open/read after the initial verdict can observe a different valid
      // record if external tooling replaces it during this asynchronous plan.
      // One read also avoids duplicate SHA-256 work for large origin captures.
      let record;
      try {
        db = await openPreviewRecoveryDb();
        const tx = db.transaction(PREVIEW_RECOVERY_STORE, 'readonly');
        record = await requestPromise(tx.objectStore(PREVIEW_RECOVERY_STORE).get(id));
        if (!record) return refused('checkpoint_missing');
        if (!await validPreviewRecoveryRecord(record))
          return refused('checkpoint_integrity_failed');
      } catch (_) { return refused('checkpoint_unreadable'); }
      // Historical payload-only records can still be inspected, but their
      // metadata was not authenticated and cannot support a rollback plan.
      if (record.integrityVersion !== 2 && record.integrityVersion !== 3)
        return refused('checkpoint_provenance_unverified');
      const captureScope = record.integrityVersion === 3
        ? 'full_origin' : 'taskpoints_namespace';
      const before = await inspectLegacyRollbackSource();
      if (!before.sourceStable) return refused('legacy_source_' + before.reason);
      const captureForPlan = () => captureScope === 'full_origin'
        ? JSON.parse(captureReadOnlyFullStorageInventory()) : captureLegacyNamespace();
      const currentBefore = captureForPlan();
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
        || (await previewRecoveryFingerprint(currentBefore)) !== (await previewRecoveryFingerprint(captureForPlan())))
        return refused('legacy_changed_during_plan');
      const generationMatches = before.generation === record.generation;
      return {
        checked: true, planValid: true, canApply: false,
        reason: generationMatches ? 'dry_run_only' : 'checkpoint_generation_differs',
        checkpointId: id, mutationAuthority: 'legacy_only',
        readAuthority: 'legacy_only', capturedGeneration: record.generation,
        generationMatches, captureScope: captureScope,
        fullOriginLocalStorageCovered: captureScope === 'full_origin',
        counts: { restoreMissing: restored, replaceChanged: replaced,
          removeNewer: removed, captured: savedKeys.size, current: currentKeys.size },
        blockers: [
          ...(captureScope !== 'full_origin'
            ? ['rollback_checkpoint_excludes_non_taskpoints_keys'] : []),
          // A local checkpoint cannot cover separate IndexedDBs,
          // independent off-device backup or dormant legacy writers.
          'production_writer_fencing_not_implemented',
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
  async function createPreviewRecoveryCheckpoint(options = {}) {
    const fail = (reason, extras = {}) => ({
      checked: true, saved: false, sourceStable: false,
      canAutoRestore: false, reason,
      mutationAuthority: 'legacy_only', readAuthority: 'legacy_only', ...extras
    });
    const captureScope = options?.scope === 'full_origin'
      ? 'full_origin' : 'taskpoints_namespace';
    if (options?.scope != null && !['full_origin', 'taskpoints_namespace'].includes(options.scope))
      return fail('invalid_checkpoint_scope');
    const capture = () => captureScope === 'full_origin'
      ? JSON.parse(captureReadOnlyFullStorageInventory()) : captureLegacyNamespace();
    const source = await inspectLegacyRollbackSource();
    if (!source.sourceStable) return fail('legacy_source_' + source.reason);
    let db;
    try {
      const entries = capture();
      if (!entries.some(([key]) => key === (core.STORAGE_KEY || 'taskpoints_v1')))
        return fail('legacy_missing_during_capture');
      const generation = currentGeneration({ create: false });
      if (!generation || generation !== source.generation)
        return fail('generation_changed_before_capture');
      // localStorage has no multi-key read transaction. A competing tab
      // may modify an earlier key while this snapshot enumerates later keys.
      // Re-read the entire namespace and recheck the legacy journals/WAL
      // before persisting a checkpoint that could be torn across versions.
      // An inconsistent attempt must not become an immutable recovery copy.
      const capturedPayloadFingerprint = await previewRecoveryFingerprint(entries);
      if (await previewRecoveryFingerprint(capture())
          !== capturedPayloadFingerprint)
        return fail('legacy_changed_during_capture');
      const captureSource = await inspectLegacyRollbackSource();
      if (!captureSource.sourceStable || captureSource.generation !== generation)
        return fail('legacy_source_changed_during_capture');
      const id = `v1-preview:${global.crypto?.randomUUID?.() || `${Date.now()}:${Math.random().toString(36).slice(2)}`}`;
      const record = {
        id, schemaVersion: PREVIEW_RECOVERY_SCHEMA,
        integrityVersion: captureScope === 'full_origin' ? 3 : 2,
        ...(captureScope === 'full_origin' ? { captureScope } : {}),
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
        sameInventory = await previewRecoveryFingerprint(capture())
          === capturedPayloadFingerprint;
      } catch (_) {}
      const stillCurrent = after.sourceStable && after.generation === generation && sameInventory;
      return {
        checked: true, saved: true, verified: true,
        sourceStable: stillCurrent,
        reason: stillCurrent ? 'checkpoint_saved_and_current' : 'checkpoint_saved_but_source_changed',
        checkpointId: id, keyCount: entries.length, captureScope,
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

  // Explicit, preview-host-only experiment for a *serialized* legacy
  // snapshot write. Unlike shared cooperative leases, an exclusive Web Lock
  // blocks all other participating shared and exclusive rehearsal callbacks.
  // No real V1 save path calls this; normal saves remain synchronous and
  // unchanged. A caller must still reread/rebase state inside the callback
  // and check the supplied generation guard immediately before its write.
  // Unfenced pre-V2 tabs, crashes and already stale application state remain
  // unsolved. This API is never a production writer fence or cutover token.
  async function exercisePreviewSerializedSnapshotLease(operation) {
    const refuse = (reason, details = {}) => ({
      checked: true, exclusiveLockAcquired: false, operationRan: false,
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
    const assertPreviewGenerationCurrent = () => {
      if (!isDarkEnabled() || initialModeEpoch !== darkMirrorModeEpoch
        || currentGeneration({ create: false }) !== initialGeneration) {
        const error = new Error('state_runtime_v2_preview_generation_changed');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_GENERATION_CHANGED';
        throw error;
      }
      return true;
    };
    // An explicit caller may carry an exact V1 snapshot source token from
    // before its asynchronous work and compare it inside this exclusive lock
    // immediately before a *synchronous* save. This guards one stale Home
    // snapshot case; task/Habit journals and unfenced writes remain outside
    // its scope. No token is stored or transmitted.
    let callbackActive = false;
    const assertPreviewLegacySnapshotUnchanged = expectedRaw => {
      if (!callbackActive) {
        const error = new Error('state_runtime_v2_preview_snapshot_guard_outside_lock');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_SNAPSHOT_GUARD_INACTIVE';
        throw error;
      }
      assertPreviewGenerationCurrent();
      if (typeof expectedRaw !== 'string' || !expectedRaw.length) {
        const error = new Error('state_runtime_v2_preview_snapshot_token_required');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_SNAPSHOT_TOKEN_REQUIRED';
        throw error;
      }
      let actualRaw;
      try {
        const storage = global.localStorage;
        if (!storage || typeof storage.getItem !== 'function')
          throw Error('storage_unavailable');
        actualRaw = storage.getItem(core.STORAGE_KEY || 'taskpoints_v1');
      } catch (_) {
        const error = new Error('state_runtime_v2_preview_snapshot_unreadable');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_SNAPSHOT_UNREADABLE';
        throw error;
      }
      if (typeof actualRaw !== 'string') {
        const error = new Error('state_runtime_v2_preview_snapshot_unreadable');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_SNAPSHOT_UNREADABLE';
        throw error;
      }
      if (actualRaw !== expectedRaw) {
        const error = new Error('state_runtime_v2_preview_snapshot_changed');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_SNAPSHOT_CHANGED';
        throw error;
      }
      return true;
    };
    // Task and Habit edits can be durable in separate V1 journals while
    // taskpoints_v1 remains byte-for-byte unchanged. An explicit fixture
    // caller may compare BOTH raw primary journal values before its sync
    // snapshot save. Real Habit event sidecars and other storage keys are
    // deliberately not claimed as covered by this limited rehearsal.
    const assertPreviewPrimaryJournalsUnchanged = expected => {
      if (!callbackActive) {
        const error = new Error('state_runtime_v2_preview_journal_guard_outside_lock');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_JOURNAL_GUARD_INACTIVE';
        throw error;
      }
      assertPreviewGenerationCurrent();
      const owns = (key) => Object.prototype.hasOwnProperty.call(expected, key);
      if (!expected || typeof expected !== 'object' || Array.isArray(expected)
        || !owns('taskJournalRaw') || !owns('habitJournalRaw')
        || !(expected.taskJournalRaw === null || typeof expected.taskJournalRaw === 'string')
        || !(expected.habitJournalRaw === null || typeof expected.habitJournalRaw === 'string')) {
        const error = new Error('state_runtime_v2_preview_journal_tokens_required');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_JOURNAL_TOKENS_REQUIRED';
        throw error;
      }
      let taskRaw, habitRaw;
      try {
        const storage = global.localStorage;
        if (!storage || typeof storage.getItem !== 'function')
          throw Error('storage_unavailable');
        taskRaw = storage.getItem('taskpoints_pending_task_mutations_v1');
        habitRaw = storage.getItem(core.PENDING_HABIT_DELTAS_KEY || 'taskpoints_pending_habit_deltas_v1');
      } catch (_) {
        const error = new Error('state_runtime_v2_preview_journal_unreadable');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_JOURNAL_UNREADABLE';
        throw error;
      }
      if (taskRaw !== expected.taskJournalRaw || habitRaw !== expected.habitJournalRaw) {
        const error = new Error('state_runtime_v2_preview_primary_journals_changed');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_JOURNALS_CHANGED';
        throw error;
      }
      return true;
    };
    // Independent per-event Habit sidecars can survive a primary journal
    // rewrite or race across legacy tabs. A serialized preview callback may
    // compare their exact key/value inventory against an earlier explicit
    // capture. This is NOT an atomic snapshot or a fence for uncooperative
    // writers and is never called by production V1 save paths.
    const sidecarPrefix = 'taskpoints_v2_habit_journal_event_v1:';
    const readPreviewHabitSidecarInventory = () => {
      const storage = global.localStorage;
      if (!storage || typeof storage.key !== 'function'
        || typeof storage.getItem !== 'function'
        || !Number.isSafeInteger(storage.length) || storage.length < 0)
        throw Error('preview_habit_sidecar_inventory_unavailable');
      const count = storage.length;
      const keys = new Set();
      const sidecarKeys = [];
      for (let index = 0; index < count; index += 1) {
        const key = storage.key(index);
        if (typeof key !== 'string' || keys.has(key))
          throw Error('preview_habit_sidecar_inventory_changed');
        keys.add(key);
        if (key.startsWith(sidecarPrefix)) sidecarKeys.push(key);
      }
      if (storage.length !== count) throw Error('preview_habit_sidecar_inventory_changed');
      const entries = sidecarKeys.sort().map(key => {
        const raw = storage.getItem(key);
        if (typeof raw !== 'string')
          throw Error('preview_habit_sidecar_inventory_unreadable');
        return [key, raw];
      });
      if (storage.length !== count) throw Error('preview_habit_sidecar_inventory_changed');
      return entries;
    };
    const assertPreviewHabitSidecarsUnchanged = expectedEntries => {
      if (!callbackActive) {
        const error = new Error('state_runtime_v2_preview_sidecar_guard_outside_lock');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_SIDECAR_GUARD_INACTIVE';
        throw error;
      }
      assertPreviewGenerationCurrent();
      if (!Array.isArray(expectedEntries)
        || expectedEntries.some((row, index) =>
          !Array.isArray(row) || row.length !== 2
          || typeof row[0] !== 'string' || !row[0].startsWith(sidecarPrefix)
          || typeof row[1] !== 'string'
          || (index > 0 && expectedEntries[index - 1][0] >= row[0]))) {
        const error = new Error('state_runtime_v2_preview_sidecar_token_invalid');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_SIDECAR_TOKEN_INVALID';
        throw error;
      }
      let actualEntries;
      try { actualEntries = readPreviewHabitSidecarInventory(); }
      catch (_) {
        const error = new Error('state_runtime_v2_preview_sidecar_inventory_unreadable');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_SIDECAR_UNREADABLE';
        throw error;
      }
      if (stableJson(actualEntries) !== stableJson(expectedEntries)) {
        const error = new Error('state_runtime_v2_preview_sidecar_inventory_changed');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_SIDECARS_CHANGED';
        throw error;
      }
      return true;
    };
    // One voluntary prewrite check that does not let a test caller silently
    // skip the source snapshot, either primary journal, or Habit sidecars.
    // The second snapshot/journal read narrows a compaction race during
    // sidecar enumeration. This is NOT atomic across tabs or a production
    // fence: an unfenced tab may still write immediately after this returns.
    const assertPreviewCompleteWriterSourcesUnchanged = expected => {
      if (!callbackActive) {
        const error = new Error('state_runtime_v2_preview_complete_guard_outside_lock');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_COMPLETE_GUARD_INACTIVE';
        throw error;
      }
      if (!expected || typeof expected !== 'object' || Array.isArray(expected)
        || expected.schemaVersion !== 1
        || typeof expected.snapshotRaw !== 'string' || !expected.snapshotRaw.length
        || !Array.isArray(expected.sidecarEntries)) {
        const error = new Error('state_runtime_v2_preview_complete_tokens_required');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_COMPLETE_TOKENS_REQUIRED';
        throw error;
      }
      assertPreviewLegacySnapshotUnchanged(expected.snapshotRaw);
      assertPreviewPrimaryJournalsUnchanged(expected);
      assertPreviewHabitSidecarsUnchanged(expected.sidecarEntries);
      assertPreviewLegacySnapshotUnchanged(expected.snapshotRaw);
      assertPreviewPrimaryJournalsUnchanged(expected);
      assertPreviewGenerationCurrent();
      return true;
    };
    // Preview admission must also account for independent V1 keys such as
    // Projects, Today, Notes, game preferences and writer signal sidecars.
    // Earlier snapshot/journal guards do not see these direct localStorage
    // writes. An explicit caller supplies the *exact prior full-origin*
    // inventory string; the comparison happens synchronously under this
    // cooperative exclusive lock immediately before its intended write.
    // An old tab can still write directly AFTER the check, so this is an
    // admission building block, never a production-wide writer fence.
    const assertPreviewFullOriginInventoryUnchanged = expectedSerialized => {
      if (!callbackActive) {
        const error = Error('state_runtime_v2_preview_full_origin_guard_outside_lock');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_FULL_ORIGIN_GUARD_INACTIVE';
        throw error;
      }
      assertPreviewGenerationCurrent();
      if (typeof expectedSerialized !== 'string' || !expectedSerialized.length) {
        const error = Error('state_runtime_v2_preview_full_origin_token_required');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_FULL_ORIGIN_TOKEN_REQUIRED';
        throw error;
      }
      let actual;
      try { actual = captureReadOnlyFullStorageInventory(); }
      catch (_) {
        const error = Error('state_runtime_v2_preview_full_origin_unreadable');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_FULL_ORIGIN_UNREADABLE';
        throw error;
      }
      if (actual !== expectedSerialized) {
        const error = Error('state_runtime_v2_preview_full_origin_changed');
        error.code = 'STATE_RUNTIME_V2_PREVIEW_FULL_ORIGIN_CHANGED';
        throw error;
      }
      return true;
    };
    const previewGuard = Object.freeze({
      assertPreviewGenerationCurrent, assertPreviewLegacySnapshotUnchanged,
      assertPreviewPrimaryJournalsUnchanged, assertPreviewHabitSidecarsUnchanged,
      assertPreviewCompleteWriterSourcesUnchanged,
      assertPreviewFullOriginInventoryUnchanged
    });
    let result = refuse('exclusive_lock_unavailable');
    try {
      await locks.request(EXCLUSIVE_WRITER_REHEARSAL_LOCK,
        { mode: 'exclusive', ifAvailable: true }, async lock => {
          if (!lock) { result = refuse('lock_held_elsewhere'); return; }
          if (!isDarkEnabled() || initialModeEpoch !== darkMirrorModeEpoch
            || currentGeneration({ create: false }) !== initialGeneration) {
            result = refuse('generation_or_preview_changed_under_lock');
            return;
          }
          try {
            callbackActive = true;
            await operation(previewGuard);
          } catch (error) {
            const reason = error?.code === 'STATE_RUNTIME_V2_PREVIEW_GENERATION_CHANGED'
              ? 'serialized_operation_generation_invalidated'
              : error?.code === 'STATE_RUNTIME_V2_PREVIEW_COMPLETE_TOKENS_REQUIRED'
                ? 'serialized_operation_complete_tokens_required'
                : error?.code === 'STATE_RUNTIME_V2_PREVIEW_COMPLETE_GUARD_INACTIVE'
                  ? 'serialized_operation_complete_guard_inactive'
                : error?.code === 'STATE_RUNTIME_V2_PREVIEW_FULL_ORIGIN_CHANGED'
                  ? 'serialized_operation_full_origin_changed'
                : error?.code === 'STATE_RUNTIME_V2_PREVIEW_FULL_ORIGIN_UNREADABLE'
                  ? 'serialized_operation_full_origin_unreadable'
                : error?.code === 'STATE_RUNTIME_V2_PREVIEW_FULL_ORIGIN_TOKEN_REQUIRED'
                  ? 'serialized_operation_full_origin_token_required'
                : error?.code === 'STATE_RUNTIME_V2_PREVIEW_FULL_ORIGIN_GUARD_INACTIVE'
                  ? 'serialized_operation_full_origin_guard_inactive'
                  : error?.code === 'STATE_RUNTIME_V2_PREVIEW_SNAPSHOT_CHANGED'
                    ? 'serialized_operation_snapshot_changed'
                : error?.code === 'STATE_RUNTIME_V2_PREVIEW_SIDECARS_CHANGED'
                  ? 'serialized_operation_habit_sidecars_changed'
                  : error?.code === 'STATE_RUNTIME_V2_PREVIEW_SIDECAR_UNREADABLE'
                    ? 'serialized_operation_habit_sidecars_unreadable'
                    : error?.code === 'STATE_RUNTIME_V2_PREVIEW_SIDECAR_TOKEN_INVALID'
                      ? 'serialized_operation_habit_sidecar_token_invalid'
                      : error?.code === 'STATE_RUNTIME_V2_PREVIEW_SIDECAR_GUARD_INACTIVE'
                        ? 'serialized_operation_habit_sidecar_guard_inactive'
                : error?.code === 'STATE_RUNTIME_V2_PREVIEW_JOURNALS_CHANGED'
                  ? 'serialized_operation_primary_journals_changed'
                  : error?.code === 'STATE_RUNTIME_V2_PREVIEW_JOURNAL_UNREADABLE'
                    ? 'serialized_operation_primary_journal_unreadable'
                    : error?.code === 'STATE_RUNTIME_V2_PREVIEW_JOURNAL_TOKENS_REQUIRED'
                      ? 'serialized_operation_primary_journal_tokens_required'
                      : error?.code === 'STATE_RUNTIME_V2_PREVIEW_JOURNAL_GUARD_INACTIVE'
                        ? 'serialized_operation_primary_journal_guard_inactive'
                        : error?.code === 'STATE_RUNTIME_V2_PREVIEW_SNAPSHOT_UNREADABLE'
                          ? 'serialized_operation_snapshot_unreadable'
                  : error?.code === 'STATE_RUNTIME_V2_PREVIEW_SNAPSHOT_TOKEN_REQUIRED'
                    ? 'serialized_operation_snapshot_token_required'
                    : error?.code === 'STATE_RUNTIME_V2_PREVIEW_SNAPSHOT_GUARD_INACTIVE'
                      ? 'serialized_operation_snapshot_guard_inactive'
                      : 'serialized_operation_failed';
            result = refuse(reason, {
              exclusiveLockAcquired: true, operationRan: true,
              lockHeldAfterReturn: false
            });
            return;
          } finally {
            callbackActive = false;
          }
          if (!isDarkEnabled() || initialModeEpoch !== darkMirrorModeEpoch
            || currentGeneration({ create: false }) !== initialGeneration) {
            result = refuse('generation_or_preview_changed_under_lock', {
              exclusiveLockAcquired: true, operationRan: true,
              lockHeldAfterReturn: false
            });
            return;
          }
          result = {
            checked: true, exclusiveLockAcquired: true, operationRan: true,
            reason: 'serialized_snapshot_rehearsed',
            lockHeldAfterReturn: false,
            canPromote: false, productionWritersFenced: false,
            allLegacyWritersKnown: false,
            mutationAuthority: 'legacy_only', readAuthority: 'legacy_only'
          };
        });
    } catch (_) {
      return refuse('exclusive_lock_request_failed', {
        operationMayHaveRun: result.operationRan === true
      });
    }
    return result;
  }

  // Isolated PREVIEW-ONLY IndexedDB writer fence protocol rehearsal.
  // A single readwrite transaction atomically checks a persisted epoch and
  // records either a participating test writer marker or a freeze decision.
  // It NEVER writes V1 data or gates a production writer. Pre-V2 tabs do not
  // consult this record and remain capable of writing localStorage.
  // First nonpilot record-level collection: Tasks (preview migration ONLY).
  // This does not change V1 reads/writes or completion authority. It does
  // not backfill automatically: an explicit preview-host call must observe
  // a stable V1 snapshot AND its real pending Task journal, then materialize
  // whole Task objects into an isolated V2 records store in one transaction.
  // Neither an interrupted/partial import nor a later stale tab can silently
  // overwrite an existing same-generation Task preview. No auto-repair.
  // PREVIEW-ONLY Notes source preflight. Notes content is stored in TWO
  // independently written V1 locations plus a dirty and authority marker.
  // Never reinterpret a partially synced cache as an empty Notes document.
  // This inspector reads but NEVER synchronizes, normalizes or writes V1.
  async function inspectPreviewNotesSource() {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,sourceVerified:false,
      notesMigrated:false,canPromote:false,
      productionWritersFenced:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    const generation=currentGeneration({create:false});
    if (!generation) return refuse('generation_unavailable');
    if (typeof core.parseTaskPointsStorageJson!=='function')
      return refuse('legacy_notes_state_parser_missing');
    const epoch=darkMirrorModeEpoch;
    const sourceCurrent=inventory=>isDarkEnabled()
      && epoch===darkMirrorModeEpoch
      && currentGeneration({create:false})===generation
      && captureReadOnlyFullStorageInventory()===inventory;
    const keys=[
      core.STORAGE_KEY||'taskpoints_v1',
      'taskpoints_notes_v1',
      'taskpoints_notes_dirty_v1',
      'taskpoints_notes_authoritative_v1'
    ];
    let inventory,original,statePresent,cachePresent;
    let stateNotes='',cacheNotes='',dirtyRaw,authorityRaw;
    let effectiveNotes='',effectiveSource='';
    try {
      inventory=captureReadOnlyFullStorageInventory();
      const raw=keys.map(key=>global.localStorage.getItem(key));
      [original,cacheNotes,dirtyRaw,authorityRaw]=raw;
      statePresent=original!==null;
      cachePresent=cacheNotes!==null;
      if (statePresent) {
        const decoded=core.parseTaskPointsStorageJson(original);
        if (!decoded || typeof decoded!=='object' || Array.isArray(decoded))
          return refuse('legacy_notes_snapshot_invalid');
        if (decoded.notes!==undefined && typeof decoded.notes!=='string')
          return refuse('legacy_notes_snapshot_field_invalid');
        stateNotes=decoded.notes||'';
      }
      if (cachePresent && typeof cacheNotes!=='string')
        return refuse('legacy_notes_cache_unreadable');
      if (!cachePresent) cacheNotes='';
      if ((dirtyRaw!==null && dirtyRaw!=='0' && dirtyRaw!=='1')
        || (authorityRaw!==null && authorityRaw!=='0'
          && authorityRaw!=='1'))
        return refuse('legacy_notes_marker_invalid');
      const dirty=dirtyRaw==='1';
      const authoritative=authorityRaw==='1';
      if (!cachePresent && (dirty || authoritative))
        return refuse('legacy_notes_authoritative_cache_missing');
      if (stateNotes.length>1048576 || cacheNotes.length>1048576)
        return refuse('legacy_notes_preview_size_limit');
      // Match notes.html getBestNotesTextFromStorage() without invoking
      // its synchronizing write side effects. Short/empty cache wins when
      // either marker is active; unmarked bootstrap retains legacy choice.
      if (cachePresent && (dirty||authoritative)) {
        effectiveNotes=cacheNotes;
        effectiveSource='marked_cache';
      } else if (cacheNotes.trim() && !stateNotes.trim()) {
        effectiveNotes=cacheNotes;
        effectiveSource='unmarked_cache_only';
      } else if (stateNotes.trim() && !cacheNotes.trim()) {
        effectiveNotes=stateNotes;
        effectiveSource='unmarked_snapshot_only';
      } else if (cacheNotes===stateNotes) {
        effectiveNotes=cacheNotes;
        effectiveSource='unmarked_equal';
      } else if (cacheNotes.length>=stateNotes.length) {
        effectiveNotes=cacheNotes;
        effectiveSource='unmarked_cache_longer';
      } else {
        effectiveNotes=stateNotes;
        effectiveSource='unmarked_snapshot_longer';
      }
      if (!sourceCurrent(inventory)
        || keys.some((key,index)=>global.localStorage.getItem(key)!==raw[index]))
        return refuse('legacy_notes_changed_during_capture');
    } catch (_) { return refuse('legacy_notes_snapshot_or_cache_unreadable'); }

    let fingerprint;
    try {
      fingerprint=await previewRecoveryFingerprint({
        statePresent,cachePresent,stateNotes,cacheNotes,
        dirtyRaw,authorityRaw,effectiveNotes,effectiveSource
      });
    } catch (_) { return refuse('legacy_notes_digest_unavailable'); }
    try {
      if (!sourceCurrent(inventory))
        return refuse('legacy_notes_changed_after_digest');
    } catch (_) { return refuse('legacy_notes_snapshot_or_cache_unreadable'); }
    // A Notes editing session changes multiple independent V1 keys. Report
    // the observed recovery phase without treating matching copies or a
    // cleared dirty flag as proof of an atomic, durable synchronization.
    // This is a diagnostic ONLY; it does not change Notes selection rules.
    const dirty=dirtyRaw==='1',authoritative=authorityRaw==='1';
    const notesSavePhase=dirty
      ? (authoritative?'dirty_cache_pending_snapshot_sync'
        :'dirty_marker_without_authority')
      : authoritative
        ? (!statePresent?'authoritative_cache_without_snapshot'
          : stateNotes===cacheNotes?'authoritative_cache_matches_snapshot'
          :'authoritative_cache_snapshot_diverged')
        : 'unmarked_legacy_bootstrap';
    return {
      checked:true,previewOnly:true,sourceVerified:true,
      notesMigrated:false,hasSnapshot:statePresent,hasCache:cachePresent,
      cacheDirty:dirty,cacheAuthoritative:authoritative,
      copiesAgree:stateNotes===cacheNotes,
      notesSavePhase,
      markerTransitionMayBeIncomplete:dirty&&!authoritative,
      // Even equal Notes copies cannot exclude a suspended legacy writer,
      // interrupted marker clearing, or a later unsynchronized write.
      notesMultiKeySyncVerified:false,
      readyForNotesAuthorityHandoff:false,
      selectedSource:effectiveSource,
      stateLength:stateNotes.length,cacheLength:cacheNotes.length,
      selectedLength:effectiveNotes.length,sourceFingerprint:fingerprint,
      comparisonScope:'v1_notes_snapshot_cache_and_authority_markers',
      reason:'legacy_notes_source_verified',
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only'
    };
  }


  // Notes have two independent V1 copies plus authority/dirty markers. This
  // source-bundle rehearsal is explicit, preview-host-only, and NEVER a V1
  // reader/writer. A separate DB prevents preview text from inflating hot
  // TaskPoints V2 meta scans or requiring a main V2 schema upgrade.
  const NOTES_PREVIEW_DB = 'taskpoints_v2_notes_preview';
  const NOTES_BUNDLE_ID = 'notes-source';

  function openNotesPreviewDb(generation, epoch) {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB?.open) {
        reject(Error('notes_preview_indexeddb_unavailable'));
        return;
      }
      let request, abandoned = false;
      try { request = global.indexedDB.open(NOTES_PREVIEW_DB, 1); }
      catch (error) { reject(error); return; }
      const fail = error => {
        if (abandoned) return;
        abandoned = true;
        reject(error || Error('notes_preview_open_failed'));
      };
      request.onupgradeneeded = () => {
        if (abandoned || !isWalTestPreviewHost() || !isDarkEnabled()
          || epoch !== darkMirrorModeEpoch
          || currentGeneration({create:false}) !== generation) {
          try { request.transaction?.abort(); } catch (_) {}
          return;
        }
        try {
          const db = request.result;
          for (const name of ['bundles','receipts','meta']) {
            if (!db.objectStoreNames.contains(name))
              db.createObjectStore(name, {keyPath:'id'});
          }
        } catch (_) { try { request.transaction?.abort(); } catch (_) {} }
      };
      request.onsuccess = () => {
        if (abandoned) {
          try { request.result.close(); } catch (_) {}
        } else resolve(request.result);
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(Error('notes_preview_open_blocked'));
    });
  }

  async function capturePreviewNotesBundle(sourceToken, generation, epoch) {
    const current = () => isWalTestPreviewHost() && isDarkEnabled()
      && darkMirrorModeEpoch === epoch
      && currentGeneration({create:false}) === generation
      && captureReadOnlyFullStorageInventory() === sourceToken;
    if (!current()) return {reason:'full_origin_changed'};
    const audit = await inspectPreviewNotesSource();
    if (!audit.sourceVerified)
      return {reason:'notes_source_preflight_required',
        prerequisiteReason:audit.reason};
    if (!current()) return {reason:'legacy_notes_changed_during_capture'};
    const keys = [core.STORAGE_KEY || 'taskpoints_v1',
      'taskpoints_notes_v1', 'taskpoints_notes_dirty_v1',
      'taskpoints_notes_authoritative_v1'];
    let raw, stateNotes = '';
    try {
      raw = keys.map(key => global.localStorage.getItem(key));
      if (raw[0] !== null) {
        const parsed = core.parseTaskPointsStorageJson(raw[0]);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
          || (parsed.notes !== undefined && typeof parsed.notes !== 'string'))
          return {reason:'legacy_notes_snapshot_invalid'};
        stateNotes = parsed.notes || '';
      }
      if (!current() || keys.some((key,i)=>
        global.localStorage.getItem(key) !== raw[i]))
        return {reason:'legacy_notes_changed_during_capture'};
    } catch (_) { return {reason:'legacy_notes_storage_unreadable'}; }
    const [snapshotRaw,cacheRaw,dirtyRaw,authorityRaw] = raw;
    const cacheNotes = cacheRaw === null ? '' : cacheRaw;
    const chosenFromCache = ['marked_cache','unmarked_cache_only',
      'unmarked_cache_longer','unmarked_equal'].includes(audit.selectedSource);
    const effectiveNotes = chosenFromCache ? cacheNotes : stateNotes;
    if (effectiveNotes.length !== audit.selectedLength
      || cacheNotes.length !== audit.cacheLength
      || stateNotes.length !== audit.stateLength
      || (snapshotRaw !== null) !== audit.hasSnapshot
      || (cacheRaw !== null) !== audit.hasCache)
      return {reason:'legacy_notes_changed_during_capture'};
    let originFingerprint, snapshotFingerprint, sourceFingerprint;
    try {
      sourceFingerprint = await previewRecoveryFingerprint({
        statePresent:snapshotRaw !== null,cachePresent:cacheRaw !== null,
        stateNotes,cacheNotes,dirtyRaw,authorityRaw,
        effectiveNotes,effectiveSource:audit.selectedSource
      });
      originFingerprint = await previewRecoveryFingerprint(sourceToken);
      snapshotFingerprint = snapshotRaw === null ? null
        : await previewRecoveryFingerprint(snapshotRaw);
    } catch (_) { return {reason:'notes_preview_digest_unavailable'}; }
    if (sourceFingerprint !== audit.sourceFingerprint)
      return {reason:'legacy_notes_changed_during_capture'};
    try {
      if (!current() || keys.some((key,i)=>
        global.localStorage.getItem(key) !== raw[i]))
        return {reason:'legacy_notes_changed_after_digest'};
    } catch (_) { return {reason:'legacy_notes_storage_unreadable'}; }
    const bundle = {
      id:NOTES_BUNDLE_ID,schemaVersion:1,resetGeneration:generation,
      originFingerprint,snapshotFingerprint,sourceFingerprint,
      snapshotPresent:snapshotRaw !== null,cachePresent:cacheRaw !== null,
      stateNotes,cacheNotes,dirtyRaw,authorityRaw,
      selectedSource:audit.selectedSource
    };
    let bundleFingerprint;
    try { bundleFingerprint = await previewRecoveryFingerprint(bundle); }
    catch (_) { return {reason:'notes_preview_digest_unavailable'}; }
    try { if (!current()) return {reason:'legacy_notes_changed_after_digest'}; }
    catch (_) { return {reason:'legacy_notes_storage_unreadable'}; }
    return {bundle,bundleFingerprint,current};
  }

  async function readNotesPreviewRows(db) {
    const tx = db.transaction(['bundles','receipts','meta'],'readonly');
    const [bundle,evidence,receipts] = await Promise.all([
      requestPromise(tx.objectStore('bundles').get(NOTES_BUNDLE_ID)),
      requestPromise(tx.objectStore('meta').get(NOTES_BUNDLE_ID)),
      requestPromise(tx.objectStore('receipts').getAll())
    ]);
    return {bundle,evidence,receipts};
  }


  // Validate the entire immutable receipt lineage without assuming that V1
  // still matches. A changed V1 source must remain reconcilable, while a
  // damaged V2 predecessor must NEVER be accepted as a starting point.
  async function validateNotesPreviewLineage(rows, generation) {
    const refuse = reason => ({verified:false,reason});
    const {bundle,evidence,receipts} = rows;
    if (!bundle && !evidence && !receipts?.length)
      return refuse('notes_preview_seed_required');
    const sha = value => typeof value === 'string'
      && /^sha256:[a-f0-9]{64}:\d+$/.test(value);
    if (!bundle || !evidence || !Array.isArray(receipts)
      || receipts.length < 1 || receipts.length > 128
      || bundle.id !== NOTES_BUNDLE_ID || bundle.schemaVersion !== 1
      || bundle.resetGeneration !== generation
      || evidence.id !== NOTES_BUNDLE_ID || evidence.schemaVersion !== 1
      || evidence.resetGeneration !== generation
      || !sha(bundle.originFingerprint) || !sha(bundle.sourceFingerprint)
      || !sha(evidence.bundleFingerprint)
      || evidence.originFingerprint !== bundle.originFingerprint
      || evidence.sourceFingerprint !== bundle.sourceFingerprint
      || typeof evidence.receiptId !== 'string')
      return refuse('notes_preview_existing_evidence_preserved');
    const byId = new Map();
    for (const receipt of receipts) {
      if (!receipt || typeof receipt.id !== 'string'
        || !receipt.id || byId.has(receipt.id)
        || receipt.resetGeneration !== generation
        || !sha(receipt.bundleFingerprint)
        || !sha(receipt.originFingerprint)
        || !sha(receipt.sourceFingerprint)
        || !['notes-preview-seed','notes-preview-reconcile'].includes(receipt.type)
        || !receipt.id.startsWith(receipt.type + ':'))
        return refuse('notes_preview_receipt_chain_invalid');
      byId.set(receipt.id,receipt);
    }
    const head = byId.get(evidence.receiptId);
    if (!head || head.bundleFingerprint !== evidence.bundleFingerprint
      || head.originFingerprint !== evidence.originFingerprint
      || head.sourceFingerprint !== evidence.sourceFingerprint)
      return refuse('notes_preview_receipt_chain_invalid');
    const visited = new Set();
    let cursor = head;
    while (cursor) {
      if (visited.has(cursor.id)) return refuse('notes_preview_receipt_chain_invalid');
      visited.add(cursor.id);
      if (cursor.type === 'notes-preview-seed') {
        if ('priorReceiptId' in cursor || 'priorBundleFingerprint' in cursor
          || 'priorReceiptFingerprint' in cursor)
          return refuse('notes_preview_receipt_chain_invalid');
        cursor = null;
      } else {
        if (typeof cursor.priorReceiptId !== 'string'
          || !sha(cursor.priorBundleFingerprint)
          || !sha(cursor.priorReceiptFingerprint))
          return refuse('notes_preview_receipt_chain_invalid');
        const parent = byId.get(cursor.priorReceiptId);
        if (!parent || parent.bundleFingerprint !== cursor.priorBundleFingerprint)
          return refuse('notes_preview_receipt_chain_invalid');
        const parentHash = await previewRecoveryFingerprint(parent);
        if (parentHash !== cursor.priorReceiptFingerprint)
          return refuse('notes_preview_receipt_chain_invalid');
        cursor = parent;
      }
    }
    if (visited.size !== receipts.length)
      return refuse('notes_preview_receipt_chain_invalid');
    const bundleHash = await previewRecoveryFingerprint(bundle);
    if (bundleHash !== evidence.bundleFingerprint)
      return refuse('notes_preview_bundle_digest_mismatch');
    return {verified:true,reason:'notes_preview_lineage_verified',
      headReceipt:head,receiptCount:receipts.length};
  }

  async function verifyNotesPreviewRows(db, captured) {
    const rows = await readNotesPreviewRows(db);
    const lineage = await validateNotesPreviewLineage(
      rows,captured.bundle.resetGeneration);
    if (!lineage.verified) return lineage;
    if (stableJson(rows.bundle) !== stableJson(captured.bundle)
      || lineage.headReceipt.bundleFingerprint !== captured.bundleFingerprint)
      return {verified:false,reason:'notes_preview_existing_evidence_preserved'};
    if (!captured.current())
      return {verified:false,reason:'legacy_notes_changed_during_readback'};
    const again = await readNotesPreviewRows(db);
    if (stableJson(rows) !== stableJson(again) || !captured.current())
      return {verified:false,reason:'notes_preview_changed_during_digest'};
    return {verified:true,reason:'notes_preview_bundle_verified',
      receiptCount:lineage.receiptCount};
  }

  async function rehearsePreviewNotesBundleSeed(sourceToken, actionId) {
    const refuse = (reason,detail={}) => ({
      checked:true,previewOnly:true,committed:false,confirmedDurable:false,
      collectionParityVerified:false,notesMigrated:false,canPromote:false,
      productionWritersFenced:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof sourceToken !== 'string' || !sourceToken)
      return refuse('full_origin_token_required');
    if (typeof actionId !== 'string' || !actionId || actionId.length > 128)
      return refuse('notes_preview_action_id_required');
    const generation = currentGeneration({create:false});
    if (!generation) return refuse('generation_unavailable');
    const epoch = darkMirrorModeEpoch;
    let captured;
    try { captured = await capturePreviewNotesBundle(sourceToken,generation,epoch); }
    catch (_) { return refuse('notes_preview_source_unreadable'); }
    if (captured.reason) return refuse(captured.reason,{
      prerequisiteReason:captured.prerequisiteReason
    });
    let db, committed = false;
    try {
      db = await openNotesPreviewDb(generation,epoch);
      const initial = await readNotesPreviewRows(db);
      if (initial.bundle || initial.evidence || initial.receipts.length) {
        const verified = await verifyNotesPreviewRows(db,captured);
        if (!verified.verified) return refuse(verified.reason);
      } else {
        if (!captured.current()) return refuse('legacy_notes_changed_before_seed');
        const receiptId = 'notes-preview-seed:' + actionId;
        const receipt = {id:receiptId,type:'notes-preview-seed',
          resetGeneration:generation,bundleFingerprint:captured.bundleFingerprint,
          originFingerprint:captured.bundle.originFingerprint,
          sourceFingerprint:captured.bundle.sourceFingerprint};
        const evidence = {id:NOTES_BUNDLE_ID,schemaVersion:1,
          resetGeneration:generation,receiptId,
          bundleFingerprint:captured.bundleFingerprint,
          originFingerprint:captured.bundle.originFingerprint,
          sourceFingerprint:captured.bundle.sourceFingerprint};
        let failure = 'notes_preview_atomic_seed_failed';
        const tx = db.transaction(['bundles','receipts','meta'],'readwrite');
        const bundleStore = tx.objectStore('bundles');
        const receiptStore = tx.objectStore('receipts');
        const metaStore = tx.objectStore('meta');
        const requests = [bundleStore.get(NOTES_BUNDLE_ID),
          metaStore.get(NOTES_BUNDLE_ID),receiptStore.getAll()];
        let pending = requests.length;
        const values = [];
        const abort = reason => {failure=reason;try{tx.abort();}catch(_){}};
        requests.forEach((request,i) => {
          request.onsuccess = () => {
            values[i] = request.result;
            if (--pending !== 0) return;
            try {
              if (!captured.current())
                return abort('legacy_notes_changed_under_transaction');
              if (values[0] || values[1] || values[2]?.length)
                return abort('notes_preview_concurrent_change');
              bundleStore.add(captured.bundle);
              receiptStore.add(receipt);
              metaStore.add(evidence);
            } catch (_) { abort('notes_preview_atomic_seed_failed'); }
          };
        });
        try { await transactionPromise(tx); }
        catch (_) { return refuse(failure); }
        committed = true;
      }
      const proof = await verifyNotesPreviewRows(db,captured);
      if (!proof.verified) return refuse(proof.reason,{
        committed,writeOutcomeUncertain:committed
      });
      return {
        checked:true,previewOnly:true,committed,confirmedDurable:true,
        collectionParityVerified:true,notesMigrated:false,
        reason:committed?'notes_preview_bundle_seed_verified'
          :'notes_preview_bundle_already_verified',
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    } catch (_) { return refuse('notes_preview_seed_or_read_unavailable',{
      committed,writeOutcomeUncertain:committed
    }); }
    finally { try { db?.close(); } catch (_) {} }
  }


  // Advance a previously sealed Notes bundle to a later V1 state. One
  // logical reconciliation replaces the preview bundle, advances metadata
  // and appends a linked immutable receipt in one IndexedDB transaction.
  // Neither V1 Notes location nor its authority flags are ever written.
  async function rehearsePreviewNotesBundleReconcile(sourceToken, actionId) {
    const refuse = (reason,detail={}) => ({
      checked:true,previewOnly:true,committed:false,confirmedDurable:false,
      collectionParityVerified:false,notesMigrated:false,canPromote:false,
      productionWritersFenced:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof sourceToken !== 'string' || !sourceToken)
      return refuse('full_origin_token_required');
    if (typeof actionId !== 'string' || !actionId || actionId.length > 128)
      return refuse('notes_preview_action_id_required');
    const generation = currentGeneration({create:false});
    if (!generation) return refuse('generation_unavailable');
    const epoch = darkMirrorModeEpoch;
    let captured,db,committed = false;
    try {
      captured = await capturePreviewNotesBundle(sourceToken,generation,epoch);
      if (captured.reason) return refuse(captured.reason,{
        prerequisiteReason:captured.prerequisiteReason
      });
      db = await openNotesPreviewDb(generation,epoch);
      const initial = await readNotesPreviewRows(db);
      const proof = await validateNotesPreviewLineage(initial,generation);
      if (!proof.verified) return refuse(proof.reason);
      // Validation includes an async digest. Re-read all old rows and the
      // real V1 full-origin source before allowing a transition.
      if (!captured.current()
        || stableJson(await readNotesPreviewRows(db)) !== stableJson(initial))
        return refuse('notes_preview_changed_during_reconcile_preflight');
      if (stableJson(initial.bundle) === stableJson(captured.bundle)) {
        const same = await verifyNotesPreviewRows(db,captured);
        if (!same.verified) return refuse(same.reason);
        return {
          checked:true,previewOnly:true,committed:false,confirmedDurable:true,
          collectionParityVerified:true,notesMigrated:false,
          reason:'notes_preview_reconcile_no_change',
          receiptCount:same.receiptCount,
          canPromote:false,productionWritersFenced:false,
          readAuthority:'legacy_only',mutationAuthority:'legacy_only'
        };
      }
      if (initial.receipts.length >= 128)
        return refuse('notes_preview_receipt_limit');
      const receiptId = 'notes-preview-reconcile:' + actionId;
      if (initial.receipts.some(x=>x?.id===receiptId))
        return refuse('notes_preview_action_id_reused');
      const parent = proof.headReceipt;
      const parentFingerprint = await previewRecoveryFingerprint(parent);
      if (!captured.current()) return refuse('legacy_notes_changed_before_reconcile');
      const receipt = {
        id:receiptId,type:'notes-preview-reconcile',
        resetGeneration:generation,priorReceiptId:parent.id,
        priorBundleFingerprint:parent.bundleFingerprint,
        priorReceiptFingerprint:parentFingerprint,
        bundleFingerprint:captured.bundleFingerprint,
        originFingerprint:captured.bundle.originFingerprint,
        sourceFingerprint:captured.bundle.sourceFingerprint
      };
      const evidence = {
        id:NOTES_BUNDLE_ID,schemaVersion:1,resetGeneration:generation,
        receiptId,bundleFingerprint:captured.bundleFingerprint,
        originFingerprint:captured.bundle.originFingerprint,
        sourceFingerprint:captured.bundle.sourceFingerprint
      };
      let failure='notes_preview_reconcile_atomic_write_failed';
      const tx=db.transaction(['bundles','receipts','meta'],'readwrite');
      const bundles=tx.objectStore('bundles');
      const receipts=tx.objectStore('receipts');
      const meta=tx.objectStore('meta');
      const reads=[bundles.get(NOTES_BUNDLE_ID),
        meta.get(NOTES_BUNDLE_ID),receipts.getAll(),receipts.get(receiptId)];
      const rows = [];
      let remaining=reads.length;
      const abort=reason=>{failure=reason;try{tx.abort();}catch(_){}};
      reads.forEach((request,index)=>{request.onsuccess=()=>{
        rows[index]=request.result;
        if (--remaining!==0) return;
        try {
          if (!captured.current())
            return abort('legacy_notes_changed_under_reconcile');
          if (stableJson(rows[0])!==stableJson(initial.bundle)
            || stableJson(rows[1])!==stableJson(initial.evidence)
            || stableJson(rows[2])!==stableJson(initial.receipts)
            || rows[3])
            return abort('notes_preview_concurrent_change');
          bundles.put(captured.bundle);
          receipts.add(receipt);
          meta.put(evidence);
        } catch (_) {abort('notes_preview_reconcile_atomic_write_failed');}
      };});
      try {await transactionPromise(tx);}
      catch (_) {return refuse(failure);}
      committed=true;
      const verified=await verifyNotesPreviewRows(db,captured);
      if (!verified.verified) return refuse(verified.reason,{
        committed:true,writeOutcomeUncertain:true
      });
      return {
        checked:true,previewOnly:true,committed:true,confirmedDurable:true,
        collectionParityVerified:true,notesMigrated:false,
        receiptCount:verified.receiptCount,
        reason:'notes_preview_reconcile_verified',
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    } catch (_) {return refuse('notes_preview_reconcile_unavailable',{
      committed,writeOutcomeUncertain:committed
    });}
    finally {try{db?.close();}catch(_){}}
  }

  async function inspectPreviewNotesBundleParity() {
    const refuse = (reason,detail={}) => ({
      checked:true,previewOnly:true,match:false,notesMigrated:false,
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    const generation = currentGeneration({create:false});
    if (!generation) return refuse('generation_unavailable');
    const epoch = darkMirrorModeEpoch;
    let token,captured,db;
    try {
      token = captureReadOnlyFullStorageInventory();
      captured = await capturePreviewNotesBundle(token,generation,epoch);
      if (captured.reason) return refuse(captured.reason,{
        prerequisiteReason:captured.prerequisiteReason
      });
      db = await openNotesPreviewDb(generation,epoch);
      const proof = await verifyNotesPreviewRows(db,captured);
      if (!proof.verified) return refuse(proof.reason);
      return {
        checked:true,previewOnly:true,match:true,
        notesMigrated:false,reason:'notes_preview_bundle_parity_verified',
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    } catch (_) { return refuse('notes_preview_parity_unavailable'); }
    finally { try { db?.close(); } catch (_) {} }
  }



  // Inspect only the isolated V2 Notes evidence. Neither a live V1 reader
  // nor an authorization to repair/recover/restore from this same-device copy.
  async function inspectPreviewNotesRecoveryEvidence(){
    const refuse=reason=>({
      checked:true,previewOnly:true,evidenceVerified:false,
      sourceCompared:false,safeToRestore:false,notesMigrated:false,
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',reason
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    const generation=currentGeneration({create:false}),epoch=darkMirrorModeEpoch;
    if(!generation)return refuse('generation_unavailable');
    const current=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&currentGeneration({create:false})===generation
      &&darkMirrorModeEpoch===epoch;
    let db;
    try{
      db=await openNotesPreviewDb(generation,epoch);
      const saved=await readNotesPreviewRows(db);
      const proof=await validateNotesPreviewLineage(saved,generation);
      if(!proof.verified)return refuse(proof.reason);
      const v=saved.bundle;
      if(typeof v.snapshotPresent!=='boolean'||typeof v.cachePresent!=='boolean'
        ||typeof v.stateNotes!=='string'||typeof v.cacheNotes!=='string'
        ||v.stateNotes.length>1048576||v.cacheNotes.length>1048576
        ||(!v.snapshotPresent&&v.stateNotes!=='')
        ||(!v.cachePresent&&v.cacheNotes!=='')
        ||![null,'0','1'].includes(v.dirtyRaw)
        ||![null,'0','1'].includes(v.authorityRaw)
        ||(!v.cachePresent&&(v.dirtyRaw==='1'||v.authorityRaw==='1'))
        ||(v.snapshotPresent
          ?typeof v.snapshotFingerprint!=='string'
            ||!/^sha256:[a-f0-9]{64}:\d+$/.test(v.snapshotFingerprint)
          :v.snapshotFingerprint!==null))
        return refuse('notes_preview_saved_source_invalid');
      let selected,chosen;
      if(v.cachePresent&&(v.dirtyRaw==='1'||v.authorityRaw==='1')){
        selected='marked_cache';chosen=v.cacheNotes;
      }else if(v.cacheNotes.trim()&&!v.stateNotes.trim()){
        selected='unmarked_cache_only';chosen=v.cacheNotes;
      }else if(v.stateNotes.trim()&&!v.cacheNotes.trim()){
        selected='unmarked_snapshot_only';chosen=v.stateNotes;
      }else if(v.cacheNotes===v.stateNotes){
        selected='unmarked_equal';chosen=v.cacheNotes;
      }else if(v.cacheNotes.length>=v.stateNotes.length){
        selected='unmarked_cache_longer';chosen=v.cacheNotes;
      }else{selected='unmarked_snapshot_longer';chosen=v.stateNotes;}
      if(v.selectedSource!==selected)
        return refuse('notes_preview_saved_source_selection_invalid');
      const fingerprint=await previewRecoveryFingerprint({
        statePresent:v.snapshotPresent,cachePresent:v.cachePresent,
        stateNotes:v.stateNotes,cacheNotes:v.cacheNotes,
        dirtyRaw:v.dirtyRaw,authorityRaw:v.authorityRaw,
        effectiveNotes:chosen,effectiveSource:selected
      });
      if(fingerprint!==v.sourceFingerprint)
        return refuse('notes_preview_saved_source_digest_mismatch');
      const again=await readNotesPreviewRows(db);
      if(!current()||stableJson(again)!==stableJson(saved))
        return refuse('notes_preview_evidence_changed_during_inspection');
      return {...refuse('notes_preview_recovery_evidence_verified'),
        evidenceVerified:true,receiptCount:proof.receiptCount,
        snapshotPresent:v.snapshotPresent,cachePresent:v.cachePresent};
    }catch(_){return refuse('notes_preview_recovery_unavailable');}
    finally{try{db?.close();}catch(_){}}
  }

  // Read-only recovery coverage audit for a particular Notes preview
  // generation. An intact localStorage checkpoint can still be stale or
  // partial; it is NOT an off-device backup and never grants restore rights.
  // This compares cryptographically verified checkpoint source provenance
  // against the separately verified Notes preview without reading either as
  // application authority or revealing the document's contents.
  async function inspectPreviewNotesCheckpointCoverage(checkpointId) {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,checkpointVerified:false,
      notesBundleVerified:false,checkpointMatchesPreviewBundle:false,
      checkpointMatchesCurrentV1:false,fullOriginLocalStorageCovered:false,
      canApply:false,canPromote:false,notesMigrated:false,
      productionWritersFenced:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof checkpointId!=='string'
      || !checkpointId.startsWith('v1-preview:') || checkpointId.length>160)
      return refuse('checkpoint_id_required');
    const generation=currentGeneration({create:false});
    if (!generation) return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    let recoveryDb,notesDb;
    try {
      const startInventory=captureReadOnlyFullStorageInventory();
      recoveryDb=await openPreviewRecoveryDb();
      const tx=recoveryDb.transaction(PREVIEW_RECOVERY_STORE,'readonly');
      const record=await requestPromise(
        tx.objectStore(PREVIEW_RECOVERY_STORE).get(checkpointId));
      if (!record) return refuse('checkpoint_missing');
      if (!await validPreviewRecoveryRecord(record))
        return refuse('checkpoint_integrity_failed');
      if (record.integrityVersion!==3
        || record.captureScope!=='full_origin')
        return refuse('checkpoint_full_origin_required',{
          checkpointVerified:true
        });
      if (record.generation!==generation)
        return refuse('checkpoint_generation_mismatch',{
          checkpointVerified:true,fullOriginLocalStorageCovered:true
        });
      // A full-origin checkpoint authenticates key presence AND absence,
      // including Notes dirty and authority flags. Its full sorted inventory
      // is exactly the canonical token bound into the Notes preview bundle.
      const checkpointToken=JSON.stringify(record.entries);
      const savedOriginFingerprint=await previewRecoveryFingerprint(checkpointToken);
      notesDb=await openNotesPreviewDb(generation,epoch);
      const first=await readNotesPreviewRows(notesDb);
      const proof=await validateNotesPreviewLineage(first,generation);
      if (!proof.verified) return refuse(proof.reason,{
        checkpointVerified:true,fullOriginLocalStorageCovered:true
      });
      const currentBundle=first.bundle;
      const checkpointMatchesPreviewBundle=
        currentBundle.originFingerprint===savedOriginFingerprint;
      // SHA work is async: recheck the exact committed V2 evidence, V1
      // inventory, generation and dark mode before reporting any coverage.
      const second=await readNotesPreviewRows(notesDb);
      if (stableJson(first)!==stableJson(second)
        || !isWalTestPreviewHost() || !isDarkEnabled()
        || epoch!==darkMirrorModeEpoch
        || currentGeneration({create:false})!==generation)
        return refuse('notes_checkpoint_evidence_changed_during_audit');
      const endInventory=captureReadOnlyFullStorageInventory();
      if (startInventory!==endInventory)
        return refuse('notes_checkpoint_origin_changed_during_audit');
      const checkpointMatchesCurrentV1=checkpointToken===endInventory;
      return {
        checked:true,previewOnly:true,checkpointVerified:true,
        notesBundleVerified:true,checkpointMatchesPreviewBundle,
        checkpointMatchesCurrentV1,fullOriginLocalStorageCovered:true,
        checkpointGenerationMatches:true,
        reason:!checkpointMatchesPreviewBundle
          ? 'checkpoint_notes_bundle_differs'
          : !checkpointMatchesCurrentV1
            ? 'checkpoint_older_than_current_origin'
            : 'checkpoint_notes_coverage_verified',
        // Local snapshots alone do not include Notes V2 IndexedDB,
        // images, or off-device backups. No automatic rollback is safe.
        coversIndexedDB:false,coversImages:false,offDeviceBackupVerified:false,
        canApply:false,canPromote:false,notesMigrated:false,
        productionWritersFenced:false,readAuthority:'legacy_only',
        mutationAuthority:'legacy_only'
      };
    } catch (_) {return refuse('notes_checkpoint_coverage_unavailable');}
    finally {
      try{recoveryDb?.close();}catch(_){}
      try{notesDb?.close();}catch(_){}
    }
  }




  // Open only a PREEXISTING Notes preview database. Unlike a normal IDB
  // open(), this refuses an upgrade, so a missing preview cannot create an
  // empty database merely because a read-only diagnostic was invoked.
  function openExistingNotesPreviewDb() {
    return new Promise((resolve,reject)=>{
      if(typeof global.indexedDB?.open!=='function'){
        reject(Error('notes_preview_indexeddb_unavailable'));return;
      }
      let request,missing=false;
      try{request=global.indexedDB.open(NOTES_PREVIEW_DB);}
      catch(error){reject(error);return;}
      request.onupgradeneeded=()=>{
        missing=true;
        try{request.transaction?.abort();}catch(_){}
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(Error(missing
        ?'notes_preview_seed_required':'notes_preview_read_failed'));
      request.onblocked=()=>reject(Error('notes_preview_read_blocked'));
    });
  }

  // Read-only Notes handoff evidence. A sealed V2 copy is a point-in-time
  // observation, not authority to rewrite V1's multi-key Notes save.
  async function inspectPreviewNotesTransitionSafety(expectedInventoryToken) {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,sourceCompared:false,
      previewEvidenceVerified:false,currentSourceVerified:false,
      notesMultiKeySyncVerified:false,safeToAutoReconcile:false,
      safeToClearDirtyMarker:false,safeToRestore:false,
      notesMigrated:false,canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken)
      return refuse('full_origin_token_required');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    let captured,db;
    try {
      if(captureReadOnlyFullStorageInventory()!==expectedInventoryToken)
        return refuse('full_origin_changed');
      captured=await capturePreviewNotesBundle(
        expectedInventoryToken,generation,epoch);
      if(captured.reason)return refuse('notes_source_preflight_failed',{
        prerequisiteReason:captured.reason});
      db=await openExistingNotesPreviewDb();
      const initial=await readNotesPreviewRows(db);
      const proof=await validateNotesPreviewLineage(initial,generation);
      if(!proof.verified)return refuse('notes_preview_evidence_unverified',{
        prerequisiteReason:proof.reason});
      const saved=initial.bundle,now=captured.bundle;
      if(typeof saved.stateNotes!=='string'
        ||typeof saved.cacheNotes!=='string'
        ||![null,'0','1'].includes(saved.dirtyRaw)
        ||![null,'0','1'].includes(saved.authorityRaw)
        ||typeof saved.snapshotPresent!=='boolean'
        ||typeof saved.cachePresent!=='boolean'
        ||(!saved.cachePresent
          &&(saved.dirtyRaw==='1'||saved.authorityRaw==='1')))
        return refuse('notes_preview_saved_source_invalid');
      const classify=b=>{
        const dirty=b.dirtyRaw==='1',authoritative=b.authorityRaw==='1';
        if(dirty)return authoritative
          ?'dirty_cache_pending_snapshot_sync'
          :'dirty_marker_without_authority';
        if(!authoritative)return 'unmarked_legacy_bootstrap';
        if(!b.snapshotPresent)return 'authoritative_cache_without_snapshot';
        return b.stateNotes===b.cacheNotes
          ?'authoritative_cache_matches_snapshot'
          :'authoritative_cache_snapshot_diverged';
      };
      // Receipt digests are asynchronous; detect newer legacy edits and
      // altered receipt rows before declaring this evidence current.
      const after=await readNotesPreviewRows(db);
      if(stableJson(initial)!==stableJson(after)
        ||!isWalTestPreviewHost()||!captured.current()
        ||!isDarkEnabled()||darkMirrorModeEpoch!==epoch
        ||currentGeneration({create:false})!==generation)
        return refuse('notes_transition_changed_during_audit');
      const sameNotes=saved.sourceFingerprint===now.sourceFingerprint;
      const sameOrigin=saved.originFingerprint===now.originFingerprint;
      return {
        ...refuse(sameNotes
          ?sameOrigin?'notes_transition_source_unchanged'
            :'notes_transition_unrelated_origin_changed'
          :'notes_transition_notes_source_changed'),
        sourceCompared:true,previewEvidenceVerified:true,
        currentSourceVerified:true,receiptCount:proof.receiptCount,
        currentNotesSavePhase:classify(now),
        savedNotesSavePhase:classify(saved),
        currentDirtyMarker:now.dirtyRaw==='1',
        currentAuthoritativeMarker:now.authorityRaw==='1',
        currentCachePreferred:now.selectedSource==='marked_cache',
        currentSnapshotAndCacheDiffer:
          now.snapshotPresent&&now.cachePresent
          &&now.stateNotes!==now.cacheNotes,
        notesSourceMatchesPreview:sameNotes,
        fullOriginMatchesPreview:sameOrigin,
        cacheChangedSincePreview:
          saved.cachePresent!==now.cachePresent
          ||saved.cacheNotes!==now.cacheNotes,
        snapshotNotesChangedSincePreview:
          saved.snapshotPresent!==now.snapshotPresent
          ||saved.stateNotes!==now.stateNotes,
        markersChangedSincePreview:
          saved.dirtyRaw!==now.dirtyRaw
          ||saved.authorityRaw!==now.authorityRaw,
        // Matching content cannot exclude dormant old-tab writers or
        // demonstrate the durability of a multi-key snapshot transition.
        notesMultiKeySyncVerified:false,safeToAutoReconcile:false,
        safeToClearDirtyMarker:false,safeToRestore:false
      };
    }catch(error){return refuse(error?.message==='notes_preview_seed_required'
      ?'notes_preview_seed_required':'notes_transition_audit_unavailable');}
    finally{try{db?.close();}catch(_){}}
  }


  // PREVIEW-ONLY, READ-ONLY Notes interruption model. The existing Notes
  // page performs synchronous cache, authority and dirty-marker writes in
  // sequence. If a first edit is shortened or cleared and the page dies
  // between cache and authority marker writes, V1's unmarked bootstrap can
  // select the older (longer) snapshot. Rehearse every prefix IN MEMORY
  // without ever changing a V1 key or creating a V2 database.
  async function inspectPreviewNotesInterruptedSaveWindows(nextText,
    expectedInventoryToken) {
    const refuse=(reason,extra={})=>({
      checked:true,previewOnly:true,sourceVerified:false,
      firstEditWindowVerified:false,finalSaveWindowVerified:false,
      notesMultiKeySyncVerified:false,
      safeToBeginNotesWrite:false,safeToClearDirtyMarker:false,
      safeToRestore:false,notesMigrated:false,
      productionWritersFenced:false,canPromote:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...extra
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(typeof nextText!=='string'||nextText.length>1048576)
      return refuse('notes_text_invalid_or_oversized');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken)
      return refuse('full_origin_token_required');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    let source;
    try {
      if(captureReadOnlyFullStorageInventory()!==expectedInventoryToken)
        return refuse('full_origin_changed');
      source=await capturePreviewNotesBundle(expectedInventoryToken,
        generation,epoch);
      if(source.reason)return refuse('notes_source_preflight_failed',{
        prerequisiteReason:source.reason});
      const original=source.bundle;
      const pick=(cache,cachePresent,dirty,authority,snapshot)=>{
        if(cachePresent&&(dirty==='1'||authority==='1'))
          return {from:'marked_cache',text:cache};
        if(cache.trim()&&!snapshot.trim())
          return {from:'unmarked_cache_only',text:cache};
        if(snapshot.trim()&&!cache.trim())
          return {from:'unmarked_snapshot_only',text:snapshot};
        if(cache===snapshot)
          return {from:'unmarked_equal',text:cache};
        return cache.length>=snapshot.length
          ?{from:'unmarked_cache_longer',text:cache}
          :{from:'unmarked_snapshot_longer',text:snapshot};
      };
      const prior=pick(original.cacheNotes,original.cachePresent,
        original.dirtyRaw,original.authorityRaw,original.stateNotes);
      // This is a hypothetical next edit; do not expose original/proposed
      // Notes text, and do not mistake a point-in-time match for durability.
      const stages=[
        {stage:'after_cache_write_before_authority_marker',
          cache:nextText,authority:original.authorityRaw,
          dirty:original.dirtyRaw,snapshot:original.stateNotes},
        {stage:'after_authority_marker_before_dirty_marker',
          cache:nextText,authority:'1',dirty:original.dirtyRaw,
          snapshot:original.stateNotes},
        {stage:'after_dirty_marker_before_snapshot_sync',
          cache:nextText,authority:'1',dirty:'1',
          snapshot:original.stateNotes},
        {stage:'after_snapshot_sync_before_dirty_clear',
          cache:nextText,authority:'1',dirty:'1',
          snapshot:nextText},
        {stage:'after_dirty_marker_clear',
          cache:nextText,authority:'1',dirty:null,
          snapshot:nextText}
      ];
      const proposedIsChange=prior.text!==nextText;
      const windows=stages.map(({stage,cache,authority,dirty,snapshot})=>{
        const chosen=pick(cache,true,dirty,authority,snapshot);
        return {
          stage,selectedSource:chosen.from,
          proposedEditWouldBeSelected:chosen.text===nextText,
          proposedEditMayBeHidden:
            proposedIsChange&&chosen.text!==nextText,
          cacheAuthorityMarked:authority==='1'||dirty==='1',
          snapshotContainsProposedEdit:snapshot===nextText
        };
      });
      if(!source.current())
        return refuse('notes_source_changed_during_interruption_audit');
      return {
        ...refuse('notes_interruption_windows_inspected'),
        sourceVerified:true,firstEditWindowVerified:true,
        finalSaveWindowVerified:true,
        proposedEditIsChange:proposedIsChange,
        cacheMarkerBootstrapRequired:
          original.dirtyRaw!=='1'&&original.authorityRaw!=='1',
        hasUnprotectedFirstEditWindow:
          windows[0].proposedEditMayBeHidden,
        scenarios:windows,
        comparisonScope:'hypothetical_v1_notes_cache_and_marker_prefixes',
        // No old-tab exclusion, atomic multi-key save or actual physical
        // crash durability has been proven. NEVER auto-replay these steps.
        notesMultiKeySyncVerified:false,
        safeToBeginNotesWrite:false,safeToClearDirtyMarker:false,
        safeToRestore:false,canPromote:false
      };
    }catch(_){return refuse('notes_interruption_audit_unavailable');}
  }

  // PREVIEW-ONLY, NONMUTATING Game preferences inventory. The Players page
  // keeps three independent raw localStorage keys outside the V1 snapshot.
  // Never substitute its forgiving UI defaults for missing/corrupt source
  // evidence during a future authority transfer.
  async function inspectPreviewGamePreferencesSource() {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,sourceVerified:false,
      gamePreferencesMigrated:false,canPromote:false,
      productionWritersFenced:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...detail
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const keys=[
      'taskpoints_gallery_columns',
      'taskpoints_player_sort_mode',
      'taskpoints_group_active_players'
    ];
    let inventory,raw;
    try{
      inventory=captureReadOnlyFullStorageInventory();
      raw=keys.map(key=>global.localStorage.getItem(key));
    }catch(_){return refuse('game_preferences_source_unreadable');}
    const [columnsRaw,sortRaw,groupRaw]=raw;
    let portrait=2,landscape=3,sort='name-asc',groupActive=false;
    if(columnsRaw!==null && columnsRaw!==''){
      let parsed;
      try{parsed=JSON.parse(columnsRaw);}
      catch(_){return refuse('game_preferences_gallery_json_invalid');}
      // The production reader may fall back to defaults here. V2 must not
      // turn an unrecognized explicitly stored value into canonical data.
      if(!parsed || typeof parsed!=='object' || Array.isArray(parsed)
        || !Object.prototype.hasOwnProperty.call(parsed,'portrait')
        || !Object.prototype.hasOwnProperty.call(parsed,'landscape')
        || ![2,3].includes(parsed.portrait)
        || ![3,4].includes(parsed.landscape))
        return refuse('game_preferences_gallery_value_invalid');
      portrait=parsed.portrait;
      landscape=parsed.landscape;
    }
    if(sortRaw!==null && sortRaw!==''){
      const modes=['name-asc','name-desc','pid-asc','pid-desc',
        'avg-desc','overall-desc','ranking-asc','baseline-desc',
        'created-desc','created-asc'];
      if(!modes.includes(sortRaw))
        return refuse('game_preferences_sort_invalid');
      sort=sortRaw;
    }
    if(groupRaw!==null){
      if(groupRaw!=='true'&&groupRaw!=='false')
        return refuse('game_preferences_group_invalid');
      groupActive=groupRaw==='true';
    }
    const current=()=>isWalTestPreviewHost()&&isDarkEnabled()
      && epoch===darkMirrorModeEpoch
      && currentGeneration({create:false})===generation
      && captureReadOnlyFullStorageInventory()===inventory
      && keys.every((key,index)=>
        global.localStorage.getItem(key)===raw[index]);
    try{if(!current())return refuse('game_preferences_changed_during_capture');}
    catch(_){return refuse('game_preferences_source_unreadable');}
    let fingerprint;
    try{
      fingerprint=await previewRecoveryFingerprint({
        keys,raw,portrait,landscape,sort,groupActive
      });
    }catch(_){return refuse('game_preferences_digest_unavailable');}
    try{if(!current())return refuse('game_preferences_changed_after_digest');}
    catch(_){return refuse('game_preferences_source_unreadable');}
    return {
      checked:true,previewOnly:true,sourceVerified:true,
      sourceFingerprint:fingerprint,
      galleryColumnsPresent:columnsRaw!==null,
      playerSortPresent:sortRaw!==null,
      groupActivePresent:groupRaw!==null,
      effectiveGalleryColumns:{portrait,landscape},
      effectiveSortMode:sort,effectiveGroupActive:groupActive,
      comparisonScope:'v1_game_preferences_and_full_origin',
      reason:'game_preferences_source_verified',
      gamePreferencesMigrated:false,canPromote:false,
      productionWritersFenced:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only'
    };
  }


  // The V1 Habit order overlay is its own synchronous, authoritative
  // localStorage sidecar. The existing dark Habit mirror can represent its
  // *effective* order, but cannot restore its exact raw bytes or unknown
  // fields. Keep a separate, explicit record-level PREVIEW copy; never
  // install a production writer, take read authority, or auto-restore it.
  const HABIT_ORDER_SIDECAR_KEY='taskpoints_habit_order_overlay_v1';
  const HABIT_ORDER_PREVIEW_DB='taskpoints_v2_habit_order_preview';

  function openHabitOrderPreviewDb(generation,epoch) {
    return new Promise((resolve,reject)=>{
      if(!isWalTestPreviewHost()||!isDarkEnabled()
        ||currentGeneration({create:false})!==generation
        ||darkMirrorModeEpoch!==epoch)
        return reject(Error('habit_order_preview_context_changed'));
      if(typeof global.indexedDB?.open!=='function')
        return reject(Error('habit_order_preview_indexeddb_unavailable'));
      let req,failed=false;
      try{req=global.indexedDB.open(HABIT_ORDER_PREVIEW_DB,1);}
      catch(error){reject(error);return;}
      req.onupgradeneeded=()=>{
        if(failed||!isWalTestPreviewHost()||!isDarkEnabled()
          ||darkMirrorModeEpoch!==epoch
          ||currentGeneration({create:false})!==generation){
          try{req.transaction?.abort();}catch(_){}
          return;
        }
        try{
          for(const name of ['records','receipts','meta'])
            if(!req.result.objectStoreNames.contains(name))
              req.result.createObjectStore(name,{keyPath:'id'});
        }catch(_){try{req.transaction?.abort();}catch(_){}}
      };
      req.onsuccess=()=>{
        if(failed)try{req.result.close();}catch(_){}
        else resolve(req.result);
      };
      req.onerror=()=>{failed=true;reject(req.error||Error('habit_order_preview_open_failed'));};
      req.onblocked=()=>{failed=true;reject(Error('habit_order_preview_open_blocked'));};
    });
  }


  // The same lossless projection serves source mirroring and independent
  // read-only recovery evidence; never normalize raw source bytes.
  function projectHabitOrderPreviewRows(raw) {
    let rows;
    try {
      if(raw!==null&&(typeof raw!=='string'||!raw.length
        ||raw.length>524288))return {reason:'habit_order_source_size_invalid'};
      let orders={},timestamps={};
      if(raw!==null){
        const parsed=JSON.parse(raw);
        if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)
          ||!parsed.orders||typeof parsed.orders!=='object'
          ||Array.isArray(parsed.orders)
          ||(parsed.version!=null&&parsed.version!==1))
          return {reason:'habit_order_source_schema_invalid'};
        orders=parsed.orders;
        if(parsed.habitUpdatedAtISO!==undefined){
          if(!parsed.habitUpdatedAtISO
            ||typeof parsed.habitUpdatedAtISO!=='object'
            ||Array.isArray(parsed.habitUpdatedAtISO))
            return {reason:'habit_order_timestamps_invalid'};
          timestamps=parsed.habitUpdatedAtISO;
        }
      }
      const ids=[...new Set([...Object.keys(orders),...Object.keys(timestamps)])].sort();
      if(ids.length>1024||ids.some(id=>!id||id.length>256))
        return {reason:'habit_order_record_limit'};
      for(const id of Object.keys(orders)){
        const value=orders[id];
        if((typeof value!=='number'&&typeof value!=='string')
          ||value===''||!Number.isFinite(Number(value)))
          return {reason:'habit_order_value_invalid'};
      }
      for(const id of Object.keys(timestamps))
        if(typeof timestamps[id]!=='string')
          return {reason:'habit_order_timestamp_invalid'};
      rows=[{id:'root',raw},...ids.map(id=>({
        id:'habit:'+id,habitId:id,
        orderPresent:Object.prototype.hasOwnProperty.call(orders,id),
        ...(Object.prototype.hasOwnProperty.call(orders,id)
          ?{order:orders[id]}:{}),
        timestampPresent:Object.prototype.hasOwnProperty.call(timestamps,id),
        ...(Object.prototype.hasOwnProperty.call(timestamps,id)
          ?{updatedAtISO:timestamps[id]}:{})
      }))];
      return {rows,present:raw!==null};
    }catch(_){return {reason:'habit_order_source_unreadable'};}
  }

  // Match JavaScript's code-unit ordering used when forming source rows,
  // independent of the browser's locale/collation rules.
  function sortHabitOrderPreviewRows(rows) {
    return rows.slice().sort((a,b)=>{
      if(a.id==='root')return -1;
      if(b.id==='root')return 1;
      return a.id<b.id?-1:a.id>b.id?1:0;
    });
  }

  async function capturePreviewHabitOrderSidecar(token,generation,epoch) {
    const current=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&currentGeneration({create:false})===generation
      &&darkMirrorModeEpoch===epoch
      &&captureReadOnlyFullStorageInventory()===token;
    try{if(!current())return {reason:'full_origin_changed'};}
    catch(_){return {reason:'full_origin_unreadable'};}
    let raw,rows;
    try{
      raw=global.localStorage.getItem(HABIT_ORDER_SIDECAR_KEY);
      const projected=projectHabitOrderPreviewRows(raw);
      if(projected.reason)return projected;
      rows=projected.rows;
      if(!current()||global.localStorage.getItem(HABIT_ORDER_SIDECAR_KEY)!==raw)
        return {reason:'habit_order_source_changed_during_capture'};
    }catch(_){return {reason:'habit_order_source_unreadable'};}
    let fingerprint;
    try{fingerprint=await previewRecoveryFingerprint(rows);}
    catch(_){return {reason:'habit_order_digest_unavailable'};}
    try{
      if(!current()||global.localStorage.getItem(HABIT_ORDER_SIDECAR_KEY)!==raw)
        return {reason:'habit_order_source_changed_after_digest'};
    }catch(_){return {reason:'habit_order_source_unreadable'};}
    return {rows,fingerprint,current,present:raw!==null};
  }

  async function readHabitOrderPreview(db) {
    const tx=db.transaction(['records','receipts','meta'],'readonly');
    const [rows,receipts,seal]=await Promise.all([
      requestPromise(tx.objectStore('records').getAll()),
      requestPromise(tx.objectStore('receipts').getAll()),
      requestPromise(tx.objectStore('meta').get('habit-order-preview'))
    ]);
    return {rows,receipts,seal};
  }

  async function verifyHabitOrderPreviewEvidence(previous,generation) {
    const {rows,receipts,seal}=previous;
    if(!seal)
      return {ok:rows.length===0&&receipts.length===0,
        empty:true,reason:'habit_order_preview_orphaned_evidence'};
    const root=rows.find(r=>r.id==='root');
    if(seal.schemaVersion!==1||seal.resetGeneration!==generation
      ||typeof seal.fingerprint!=='string'
      ||typeof seal.receiptId!=='string'||!root
      ||new Set(rows.map(r=>r.id)).size!==rows.length
      ||(root.raw!==null&&typeof root.raw!=='string')
      ||seal.recordCount!==rows.length
      ||typeof seal.sourcePresent!=='boolean'
      ||seal.sourcePresent!==(root.raw!==null))
      return {ok:false,reason:'habit_order_preview_seal_invalid'};
    const sorted=sortHabitOrderPreviewRows(rows);
    const calculated=await previewRecoveryFingerprint(sorted);
    if(calculated!==seal.fingerprint)
      return {ok:false,reason:'habit_order_preview_rows_tampered'};
    // The digest must match rows that independently reproduce the raw overlay.
    const projected=projectHabitOrderPreviewRows(root.raw);
    if(projected.reason||stableJson(sorted)!==stableJson(projected.rows))
      return {ok:false,reason:'habit_order_preview_row_projection_invalid'};
    const byId=new Map(receipts.map(r=>[r?.id,r]));
    if(byId.size!==receipts.length||receipts.length>128)
      return {ok:false,reason:'habit_order_preview_receipts_invalid'};
    let id=seal.receiptId,expected=seal.fingerprint;
    const visited=new Set();
    while(id){
      if(visited.has(id))return {ok:false,reason:'habit_order_preview_receipt_cycle'};
      visited.add(id);
      const receipt=byId.get(id);
      if(!receipt||receipt.resetGeneration!==generation
        ||receipt.fingerprint!==expected
        ||!Number.isSafeInteger(receipt.changeCount)
        ||receipt.changeCount<0||receipt.changeCount>1025
        ||!Number.isSafeInteger(receipt.deleteCount)
        ||receipt.deleteCount<0||receipt.deleteCount>1025)
        return {ok:false,reason:'habit_order_preview_receipt_invalid'};
      if(receipt.type==='habit-order-preview-seed'){
        if(receipt.priorReceiptId!=null||receipt.priorFingerprint!=null
          ||visited.size!==receipts.length)
          return {ok:false,reason:'habit_order_preview_orphan_receipts'};
        return {ok:true,empty:false};
      }
      if(receipt.type!=='habit-order-preview-reconcile'
        ||typeof receipt.priorReceiptId!=='string'
        ||typeof receipt.priorFingerprint!=='string')
        return {ok:false,reason:'habit_order_preview_receipt_invalid'};
      id=receipt.priorReceiptId;
      expected=receipt.priorFingerprint;
    }
    return {ok:false,reason:'habit_order_preview_receipt_root_missing'};
  }

  const refuseHabitOrderPreview=(reason,detail={})=>({
    checked:true,previewOnly:true,committed:false,confirmedDurable:false,
    collectionParityVerified:false,habitOrderSidecarMigrated:false,
    readAuthority:'legacy_only',mutationAuthority:'legacy_only',
    productionWritersFenced:false,canPromote:false,reason,...detail
  });

  async function inspectPreviewHabitOrderSidecarParity() {
    const fail=(reason,detail={})=>({
      ...refuseHabitOrderPreview(reason),match:false,...detail
    });
    if(!isWalTestPreviewHost())return fail('preview_host_required');
    if(!isDarkEnabled())return fail('dark_disabled');
    const generation=currentGeneration({create:false}),epoch=darkMirrorModeEpoch;
    if(!generation)return fail('generation_unavailable');
    let token,source,db;
    try{
      token=captureReadOnlyFullStorageInventory();
      source=await capturePreviewHabitOrderSidecar(token,generation,epoch);
      if(source.reason)return fail(source.reason);
      db=await openHabitOrderPreviewDb(generation,epoch);
      const previous=await readHabitOrderPreview(db);
      const proof=await verifyHabitOrderPreviewEvidence(previous,generation);
      if(!proof.ok||proof.empty)
        return fail(proof.reason||'habit_order_preview_seed_required');
      if(stableJson(sortHabitOrderPreviewRows(previous.rows))
        !==stableJson(source.rows))
        return fail('habit_order_preview_source_mismatch');
      if(!source.current())return fail('habit_order_source_changed_after_parity');
      return {checked:true,previewOnly:true,match:true,
        collectionParityVerified:true,rowCount:source.rows.length,
        sourcePresent:source.present,habitOrderSidecarMigrated:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only',
        productionWritersFenced:false,canPromote:false,
        reason:'habit_order_preview_parity_verified'};
    }catch(_){return fail('habit_order_preview_parity_unreadable');}
    finally{try{db?.close();}catch(_){}}
  }


  // Inspect independent V2 evidence WITHOUT reading the current V1 overlay.
  // This is not authorization to restore, switch read authority or promote V2.
  async function inspectPreviewHabitOrderSidecarRecoveryEvidence() {
    const fail=(reason)=>({
      ...refuseHabitOrderPreview(reason),evidenceVerified:false,
      sourceCompared:false,safeToRestore:false
    });
    if(!isWalTestPreviewHost())return fail('preview_host_required');
    if(!isDarkEnabled())return fail('dark_disabled');
    const generation=currentGeneration({create:false}),epoch=darkMirrorModeEpoch;
    if(!generation)return fail('generation_unavailable');
    let db;
    try{
      db=await openHabitOrderPreviewDb(generation,epoch);
      const previous=await readHabitOrderPreview(db);
      const proof=await verifyHabitOrderPreviewEvidence(previous,generation);
      if(!proof.ok||proof.empty)
        return fail(proof.reason||'habit_order_preview_seed_required');
      if(!isWalTestPreviewHost()||!isDarkEnabled()
        ||darkMirrorModeEpoch!==epoch
        ||currentGeneration({create:false})!==generation)
        return fail('habit_order_preview_context_changed');
      return {...refuseHabitOrderPreview('habit_order_preview_recovery_evidence_verified'),
        evidenceVerified:true,sourceCompared:false,safeToRestore:false,
        recordCount:previous.rows.length,sourcePresent:previous.seal.sourcePresent};
    }catch(_){return fail('habit_order_preview_recovery_unreadable');}
    finally{try{db?.close();}catch(_){}}
  }

  async function rehearsePreviewHabitOrderSidecarAction(sourceToken,actionId,allowReconcile) {
    const fail=refuseHabitOrderPreview;
    if(!isWalTestPreviewHost())return fail('preview_host_required');
    if(!isDarkEnabled())return fail('dark_disabled');
    if(typeof sourceToken!=='string'||!sourceToken)
      return fail('full_origin_token_required');
    if(typeof actionId!=='string'||!actionId||actionId.length>128)
      return fail('habit_order_action_id_required');
    const generation=currentGeneration({create:false}),epoch=darkMirrorModeEpoch;
    if(!generation)return fail('generation_unavailable');
    let source,db;
    try{
      source=await capturePreviewHabitOrderSidecar(sourceToken,generation,epoch);
      if(source.reason)return fail(source.reason);
      db=await openHabitOrderPreviewDb(generation,epoch);
      const previous=await readHabitOrderPreview(db);
      const proof=await verifyHabitOrderPreviewEvidence(previous,generation);
      if(!proof.ok)return fail(proof.reason);
      if(proof.empty&&allowReconcile)
        return fail('habit_order_preview_seed_required');
      if(!proof.empty&&!allowReconcile){
        if(previous.seal.fingerprint!==source.fingerprint)
          return fail('habit_order_preview_source_changed_requires_reconcile');
        const parity=await inspectPreviewHabitOrderSidecarParity();
        return parity.match
          ?{...parity,committed:false,confirmedDurable:true}
          :fail('habit_order_preview_existing_evidence_unverified',{
            prerequisiteReason:parity.reason
          });
      }
      const same=!proof.empty&&previous.seal.fingerprint===source.fingerprint;
      if(same){
        const parity=await inspectPreviewHabitOrderSidecarParity();
        return parity.match
          ?{...parity,committed:false,confirmedDurable:true,
            reason:'habit_order_preview_already_current'}
          :fail('habit_order_preview_noop_unverified',{
            prerequisiteReason:parity.reason
          });
      }
      const before=new Map(previous.rows.map(r=>[r.id,r]));
      const desired=new Map(source.rows.map(r=>[r.id,r]));
      const changed=source.rows.filter(r=>stableJson(before.get(r.id))!==stableJson(r));
      const removed=previous.rows.filter(r=>!desired.has(r.id));
      if(!proof.empty&&(changed.length+removed.length>64
        ||JSON.stringify({changed,removed}).length>262144))
        return fail('habit_order_preview_batch_limit');
      if(previous.receipts.length>=128)
        return fail('habit_order_preview_receipt_limit');
      const receiptId='habit-order-preview:'+actionId;
      if(previous.receipts.some(r=>r.id===receiptId))
        return fail('habit_order_preview_action_id_reused');
      const receipt={
        id:receiptId,type:proof.empty
          ?'habit-order-preview-seed':'habit-order-preview-reconcile',
        resetGeneration:generation,fingerprint:source.fingerprint,
        priorReceiptId:proof.empty?null:previous.seal.receiptId,
        priorFingerprint:proof.empty?null:previous.seal.fingerprint,
        changeCount:changed.length,deleteCount:removed.length
      };
      const seal={id:'habit-order-preview',schemaVersion:1,
        resetGeneration:generation,fingerprint:source.fingerprint,
        receiptId,recordCount:source.rows.length,
        sourcePresent:source.present};
      if(!source.current())
        return fail('habit_order_source_changed_before_write');
      let failure=null;
      const abort=(tx,reason)=>{
        failure=reason;try{tx.abort();}catch(_){}
      };
      try{
        const tx=db.transaction(['records','receipts','meta'],'readwrite');
        const recordStore=tx.objectStore('records');
        const receiptStore=tx.objectStore('receipts');
        const metaStore=tx.objectStore('meta');
        const requests=[recordStore.getAll(),receiptStore.getAll(),
          metaStore.get('habit-order-preview')];
        const values=new Array(requests.length);
        let pending=requests.length;
        requests.forEach((req,i)=>{req.onsuccess=()=>{
          values[i]=req.result;
          if(--pending)return;
          try{
            if(!source.current())
              return abort(tx,'habit_order_source_changed_under_transaction');
            if(stableJson(values[0])!==stableJson(previous.rows)
              ||stableJson(values[1])!==stableJson(previous.receipts)
              ||stableJson(values[2])!==stableJson(previous.seal))
              return abort(tx,'habit_order_preview_concurrent_change');
            for(const row of removed)recordStore.delete(row.id);
            for(const row of changed)recordStore.put(row);
            receiptStore.add(receipt);
            metaStore.put(seal);
          }catch(_){abort(tx,'habit_order_preview_atomic_write_failed');}
        };});
        await transactionPromise(tx);
      }catch(_){return fail(failure||'habit_order_preview_atomic_write_failed');}
      try{
        const saved=await readHabitOrderPreview(db);
        const sorted=sortHabitOrderPreviewRows(saved.rows);
        if(stableJson(sorted)!==stableJson(source.rows)
          ||stableJson(saved.seal)!==stableJson(seal)
          ||stableJson(saved.receipts.find(r=>r.id===receiptId))!==stableJson(receipt))
          return fail('habit_order_preview_readback_unverified',{
            committed:true,writeOutcomeUncertain:true});
        if(!source.current())
          return fail('habit_order_source_changed_after_write',{
            committed:true,confirmedDurable:true,writeOutcomeUncertain:true});
        const parity=await inspectPreviewHabitOrderSidecarParity();
        if(!parity.match)
          return fail('habit_order_preview_postwrite_parity_unverified',{
            committed:true,confirmedDurable:true,writeOutcomeUncertain:true,
            prerequisiteReason:parity.reason});
        if(!source.current())
          return fail('habit_order_source_changed_after_parity',{
            committed:true,confirmedDurable:true,writeOutcomeUncertain:true});
        return {
          ...parity,committed:true,confirmedDurable:true,
          changedRows:changed.length,removedRows:removed.length,
          reason:proof.empty?'habit_order_preview_seed_verified'
            :'habit_order_preview_reconcile_verified'
        };
      }catch(_){
        return fail('habit_order_preview_readback_unavailable',{
          committed:true,writeOutcomeUncertain:true});
      }
    }catch(_){return fail('habit_order_preview_unavailable');}
    finally{try{db?.close();}catch(_){}}
  }

  async function rehearsePreviewHabitOrderSidecarSeed(sourceToken,actionId) {
    return rehearsePreviewHabitOrderSidecarAction(sourceToken,actionId,false);
  }

  async function rehearsePreviewHabitOrderSidecarReconcile(sourceToken,actionId) {
    return rehearsePreviewHabitOrderSidecarAction(sourceToken,actionId,true);
  }

  // GAME SOURCE BOUNDARY. These are the Game/Players/Season snapshot-owned
  // fields that the current Game page uses. Preserve unknown fields inside
  // every record, row order, missing-property distinctions and raw independent
  // gallery/sort/group preferences. This is a bounded preview, not yet a
  // complete proof of every indirect Game, season or image writer.
  const GAME_PREVIEW_DB='taskpoints_v2_game_preview';
  const GAME_PREVIEW_ID='game-source';
  const GAME_ARRAY_FIELDS=['players','gameHistory','matchups','schedule',
    'opponentDripSchedules','seasonHistory'];
  const GAME_SCALAR_FIELDS=['currentSeason','latestSeasonId',
    'youImageId','youName','youNotes','youRivalId','youPrimaryColor',
    'youSecondaryColor'];
  const GAME_PREFERENCE_KEYS=['taskpoints_gallery_columns',
    'taskpoints_player_sort_mode','taskpoints_group_active_players'];

  function openGamePreviewDb(generation,epoch) {
    return new Promise((resolve,reject)=>{
      if(typeof global.indexedDB?.open!=='function')
        return reject(Error('game_preview_indexeddb_unavailable'));
      let request,failed=false;
      try{request=global.indexedDB.open(GAME_PREVIEW_DB,1);}
      catch(error){reject(error);return;}
      const fail=error=>{
        if(failed)return;
        failed=true;reject(error||Error('game_preview_open_failed'));
      };
      request.onupgradeneeded=()=>{
        if(failed||!isWalTestPreviewHost()||!isDarkEnabled()
          || epoch!==darkMirrorModeEpoch
          || currentGeneration({create:false})!==generation) {
          try{request.transaction?.abort();}catch(_){}
          return;
        }
        try{
          const db=request.result;
          for(const name of ['players','bundles','receipts','meta'])
            if(!db.objectStoreNames.contains(name))
              db.createObjectStore(name,{keyPath:'id'});
        }catch(_){try{request.transaction?.abort();}catch(_){}}
      };
      request.onsuccess=()=>{
        if(failed){try{request.result.close();}catch(_){}}
        else resolve(request.result);
      };
      request.onerror=()=>fail(request.error);
      request.onblocked=()=>fail(Error('game_preview_open_blocked'));
    });
  }

  async function capturePreviewGameSource(sourceToken,generation,epoch) {
    const current=()=>isWalTestPreviewHost()&&isDarkEnabled()
      && darkMirrorModeEpoch===epoch
      && currentGeneration({create:false})===generation
      && captureReadOnlyFullStorageInventory()===sourceToken;
    if(!current())return {reason:'full_origin_changed'};
    const preferenceAudit=await inspectPreviewGamePreferencesSource();
    if(!preferenceAudit.sourceVerified)
      return {reason:'game_preferences_preflight_required',
        prerequisiteReason:preferenceAudit.reason};
    if(!current())return {reason:'legacy_game_changed_during_preflight'};
    const key=core.STORAGE_KEY||'taskpoints_v1';
    let raw,parsed,fields,rows,preferences;
    try{
      raw=global.localStorage.getItem(key);
      if(typeof raw!=='string'||!raw)
        return {reason:'legacy_game_snapshot_required'};
      parsed=core.parseTaskPointsStorageJson(raw);
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))
        return {reason:'legacy_game_snapshot_invalid'};
      fields={};
      for(const field of GAME_ARRAY_FIELDS) {
        if(!Object.prototype.hasOwnProperty.call(parsed,field))continue;
        if(!Array.isArray(parsed[field]))
          return {reason:'legacy_game_array_invalid',field};
        fields[field]=parsed[field];
      }
      for(const field of GAME_SCALAR_FIELDS)
        if(Object.prototype.hasOwnProperty.call(parsed,field))
          fields[field]=parsed[field];
      const players=fields.players||[];
      if(players.length>1024)return {reason:'game_preview_player_limit'};
      for(const player of players)
        if(!player||typeof player!=='object'||Array.isArray(player))
          return {reason:'legacy_game_player_invalid'};
      rows=players.map((value,id)=>({id,value}));
      // Player objects are stored as individually addressable records. The
      // rest of the Game/Season source is kept in its own immutable bundle.
      delete fields.players;
      preferences=GAME_PREFERENCE_KEYS.map(k=>global.localStorage.getItem(k));
      if(!current()||raw!==global.localStorage.getItem(key)
        ||preferences.some((v,i)=>v!==global.localStorage.getItem(
          GAME_PREFERENCE_KEYS[i])))
        return {reason:'legacy_game_changed_during_capture'};
    }catch(_){return {reason:'legacy_game_source_unreadable'};}
    let bundle,digest,originFingerprint,sourceFingerprint;
    try{
      sourceFingerprint=await previewRecoveryFingerprint({fields,
        players:rows.map(x=>x.value),preferences});
      originFingerprint=await previewRecoveryFingerprint(sourceToken);
      bundle={id:GAME_PREVIEW_ID,schemaVersion:1,
        resetGeneration:generation,originFingerprint,sourceFingerprint,
        snapshotFingerprint:await previewRecoveryFingerprint(raw),
        playerCount:rows.length,
        playersPresent:Object.prototype.hasOwnProperty.call(parsed,'players'),
        fields,preferences};
      digest=await previewRecoveryFingerprint({bundle,rows});
    }catch(_){return {reason:'game_preview_digest_unavailable'};}
    try{if(!current()||raw!==global.localStorage.getItem(key))
      return {reason:'legacy_game_changed_after_digest'};}
    catch(_){return {reason:'legacy_game_source_unreadable'};}
    const bytes=JSON.stringify({bundle,rows}).length;
    if(bytes>2097152)return {reason:'game_preview_source_too_large'};
    return {bundle,rows,digest,current,sourceToken};
  }

  async function readGamePreviewRows(db) {
    const tx=db.transaction(['players','bundles','receipts','meta'],'readonly');
    const [rows,bundle,evidence,receipts]=await Promise.all([
      requestPromise(tx.objectStore('players').getAll()),
      requestPromise(tx.objectStore('bundles').get(GAME_PREVIEW_ID)),
      requestPromise(tx.objectStore('meta').get(GAME_PREVIEW_ID)),
      requestPromise(tx.objectStore('receipts').getAll())
    ]);
    return {rows,bundle,evidence,receipts};
  }

  async function verifyGamePreviewLineage(result,generation) {
    const fail=reason=>({verified:false,reason});
    const {rows,bundle,evidence,receipts}=result;
    if(!bundle&&!evidence&&!rows.length&&!receipts.length)
      return fail('game_preview_seed_required');
    if(!bundle||!evidence||!Array.isArray(receipts)
      ||receipts.length<1||receipts.length>128
      ||bundle.id!==GAME_PREVIEW_ID||bundle.schemaVersion!==1
      ||bundle.resetGeneration!==generation
      ||evidence.id!==GAME_PREVIEW_ID||evidence.schemaVersion!==1
      ||evidence.resetGeneration!==generation||bundle.playerCount!==rows.length
      ||(bundle.playersPresent!==undefined
        &&typeof bundle.playersPresent!=='boolean')
      ||evidence.bundleFingerprint===undefined
      ||typeof evidence.receiptId!=='string')
      return fail('game_preview_evidence_invalid');
    const sorted=rows.slice().sort((a,b)=>a.id-b.id);
    for(let i=0;i<sorted.length;i++)
      if(sorted[i].id!==i||!sorted[i].value
        ||typeof sorted[i].value!=='object'
        ||Array.isArray(sorted[i].value))
        return fail('game_preview_player_rows_invalid');
    if(!bundle.fields||typeof bundle.fields!=='object'
      ||Array.isArray(bundle.fields)
      ||!Array.isArray(bundle.preferences)
      ||bundle.preferences.length!==GAME_PREFERENCE_KEYS.length)
      return fail('game_preview_bundle_shape_invalid');
    const hash=await previewRecoveryFingerprint({bundle,rows:sorted});
    if(hash!==evidence.bundleFingerprint)
      return fail('game_preview_bundle_digest_mismatch');
    const byId=new Map();
    for(const r of receipts) {
      if(!r||typeof r.id!=='string'||byId.has(r.id)
        ||r.resetGeneration!==generation
        ||!['game-preview-seed','game-preview-reconcile'].includes(r.type))
        return fail('game_preview_receipts_invalid');
      byId.set(r.id,r);
    }
    const head=byId.get(evidence.receiptId);
    if(!head||head.bundleFingerprint!==hash
      ||head.sourceFingerprint!==bundle.sourceFingerprint
      ||head.originFingerprint!==bundle.originFingerprint)
      return fail('game_preview_receipts_invalid');
    const visited=new Set();
    let cursor=head;
    while(cursor) {
      if(visited.has(cursor.id))return fail('game_preview_receipts_invalid');
      visited.add(cursor.id);
      if(cursor.type==='game-preview-seed') {
        if('priorReceiptId' in cursor||'priorReceiptFingerprint' in cursor)
          return fail('game_preview_receipts_invalid');
        cursor=null;
      }else{
        const parent=byId.get(cursor.priorReceiptId);
        if(!parent||typeof cursor.priorReceiptFingerprint!=='string'
          ||await previewRecoveryFingerprint(parent)!==
            cursor.priorReceiptFingerprint)
          return fail('game_preview_receipts_invalid');
        cursor=parent;
      }
    }
    if(visited.size!==receipts.length)
      return fail('game_preview_receipts_invalid');
    return {verified:true,reason:'game_preview_evidence_verified',
      head,receiptCount:receipts.length};
  }

  async function proveGamePreviewParity(db,captured) {
    const original=await readGamePreviewRows(db);
    const lineage=await verifyGamePreviewLineage(
      original,captured.bundle.resetGeneration);
    if(!lineage.verified)return lineage;
    // Earlier Game preview v1 receipts did not seal the distinction
    // between an absent players field and an explicit empty array. Keep
    // their original hash valid and their parity inspectable, but require
    // explicit reconciliation before a new compatibility proof can certify
    // property-presence semantics.
    const comparableBundle={...captured.bundle};
    const legacyPresenceUnsealed=original.bundle.playersPresent===undefined;
    if(legacyPresenceUnsealed)delete comparableBundle.playersPresent;
    // Historical receipts fingerprinted the exact old bundle shape; never
    // compare their certified SHA with a newly expanded format's SHA.
    // Verify each stored version using its original canonical digest.
    const comparableDigest=legacyPresenceUnsealed
      ? await previewRecoveryFingerprint({bundle:comparableBundle,
          rows:captured.rows})
      : captured.digest;
    if(stableJson(original.bundle)!==stableJson(comparableBundle)
      ||stableJson(original.rows.slice().sort((a,b)=>a.id-b.id))
        !==stableJson(captured.rows)
      ||original.evidence.bundleFingerprint!==comparableDigest)
      return {verified:false,reason:'game_preview_source_stale'};
    if(!captured.current())
      return {verified:false,reason:'legacy_game_changed_during_readback'};
    const second=await readGamePreviewRows(db);
    if(stableJson(original)!==stableJson(second)||!captured.current())
      return {verified:false,reason:'game_preview_changed_during_digest'};
    return {verified:true,reason:'game_preview_parity_verified',
      receiptCount:lineage.receiptCount};
  }


  // A Game-only reconstructed compatibility projection: retain every other
  // original V1 snapshot property untouched, then replace only the explicit
  // Game/Players field boundary from VERIFIED preview records. Never use the
  // projection as an exporter, restore source, or live application reader.
  async function inspectPreviewGameCompatibilityProjection() {
    const refuse=(reason,details={})=>({
      checked:true,previewOnly:true,match:false,
      gameProjectionVerified:false,fullExportVerified:false,
      canPromote:false,gameMigrated:false,
      productionWritersFenced:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...details
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    let db;
    try {
      const token=captureReadOnlyFullStorageInventory();
      const captured=await capturePreviewGameSource(token,generation,epoch);
      if(captured.reason)return refuse(captured.reason,{
        prerequisiteReason:captured.prerequisiteReason
      });
      db=await openGamePreviewDb(generation,epoch);
      const first=await readGamePreviewRows(db);
      const proof=await verifyGamePreviewLineage(first,generation);
      if(!proof.verified)return refuse(proof.reason);
      if(!captured.current())return refuse('legacy_game_changed_before_projection');
      if(first.bundle.playersPresent===undefined)
        return refuse('game_preview_player_presence_unsealed');
      if(first.bundle.originFingerprint!==captured.bundle.originFingerprint)
        return refuse('game_preview_source_stale');
      const sorted=first.rows.slice().sort((a,b)=>a.id-b.id);
      const raw=global.localStorage.getItem(core.STORAGE_KEY||'taskpoints_v1');
      if(typeof raw!=='string'||!raw)return refuse('legacy_game_snapshot_missing');
      const original=core.parseTaskPointsStorageJson(raw);
      if(!original||typeof original!=='object'||Array.isArray(original))
        return refuse('legacy_game_snapshot_invalid');
      const projected={...original};
      // Property *absence* matters for round-trip compatibility; never
      // materialize default [] just because the Game UI would do so.
      if(first.bundle.playersPresent)
        projected.players=sorted.map(row=>row.value);
      else delete projected.players;
      for(const key of GAME_ARRAY_FIELDS.filter(k=>k!=='players')
        .concat(GAME_SCALAR_FIELDS)) {
        const has=Object.prototype.hasOwnProperty.call(first.bundle.fields,key);
        const sourceHas=Object.prototype.hasOwnProperty.call(original,key);
        if(has!==sourceHas)return refuse('game_projection_property_presence_mismatch');
        if(has)projected[key]=first.bundle.fields[key];
        else delete projected[key];
      }
      if(Object.prototype.hasOwnProperty.call(original,'players')
        !==first.bundle.playersPresent)
        return refuse('game_projection_player_presence_mismatch');
      const preferences=GAME_PREFERENCE_KEYS.map(key=>global.localStorage.getItem(key));
      if(stableJson(preferences)!==stableJson(first.bundle.preferences))
        return refuse('game_projection_preference_mismatch');
      if(stableJson(original)!==stableJson(projected))
        return refuse('game_projection_payload_mismatch');
      const digest=await previewRecoveryFingerprint(stableJson(projected));
      if(!captured.current()||raw!==global.localStorage.getItem(
        core.STORAGE_KEY||'taskpoints_v1'))
        return refuse('legacy_game_changed_after_projection_digest');
      const second=await readGamePreviewRows(db);
      if(stableJson(first)!==stableJson(second)||!captured.current())
        return refuse('game_preview_changed_during_projection_digest');
      return {
        checked:true,previewOnly:true,match:true,
        gameProjectionVerified:true,fullExportVerified:false,
        snapshotFingerprint:digest,sourceFieldCount:
          GAME_ARRAY_FIELDS.length+GAME_SCALAR_FIELDS.length,
        playersPresent:first.bundle.playersPresent,
        playerCount:sorted.length,receiptCount:proof.receiptCount,
        comparisonScope:'game_fields_plus_original_v1_snapshot',
        reason:'game_preview_compatibility_projection_verified',
        canPromote:false,gameMigrated:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    }catch(_){return refuse('game_preview_projection_unavailable');}
    finally{try{db?.close();}catch(_){}}
  }


  // A full-origin local checkpoint can prove the Game preview's snapshot
  // and auxiliary preference keys are covered. This is a local, READ-ONLY
  // provenance comparison, not a restore plan or export package.
  async function inspectPreviewGameCheckpointCoverage(checkpointId) {
    const refuse=(reason,details={})=>({
      checked:true,previewOnly:true,checkpointVerified:false,
      gameBundleVerified:false,checkpointMatchesPreviewOrigin:false,
      checkpointMatchesPreviewGameState:false,
      checkpointMatchesCurrentV1:false,
      fullOriginLocalStorageCovered:false,
      coversImages:false,coversIndexedDB:false,
      offDeviceBackupVerified:false,
      canApply:false,canPromote:false,gameMigrated:false,
      productionWritersFenced:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...details
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(typeof checkpointId!=='string'
      ||!checkpointId.startsWith('v1-preview:')||checkpointId.length>160)
      return refuse('checkpoint_id_required');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    let recoveryDb,gameDb;
    try {
      const startingToken=captureReadOnlyFullStorageInventory();
      recoveryDb=await openPreviewRecoveryDb();
      const snapshotStore=PREVIEW_RECOVERY_STORE;
      const record=await requestPromise(recoveryDb.transaction(
        snapshotStore,'readonly').objectStore(snapshotStore).get(checkpointId));
      if(!record)return refuse('checkpoint_missing');
      if(!await validPreviewRecoveryRecord(record))
        return refuse('checkpoint_integrity_failed');
      if(record.integrityVersion!==3||record.captureScope!=='full_origin')
        return refuse('checkpoint_full_origin_required',{checkpointVerified:true});
      if(record.generation!==generation)
        return refuse('checkpoint_generation_mismatch',{
          checkpointVerified:true,fullOriginLocalStorageCovered:true
        });
      const checkpointToken=JSON.stringify(record.entries);
      const stored=new Map(record.entries);
      const rawSnapshot=stored.get(core.STORAGE_KEY||'taskpoints_v1');
      if(typeof rawSnapshot!=='string'||!rawSnapshot)
        return refuse('checkpoint_game_snapshot_missing',{
          checkpointVerified:true,fullOriginLocalStorageCovered:true
        });
      const prefs=GAME_PREFERENCE_KEYS.map(key=>
        stored.has(key)?stored.get(key):null);
      const [checkpointOriginHash,checkpointSnapshotHash]=await Promise.all([
        previewRecoveryFingerprint(checkpointToken),
        previewRecoveryFingerprint(rawSnapshot)
      ]);
      gameDb=await openGamePreviewDb(generation,epoch);
      const first=await readGamePreviewRows(gameDb);
      const proof=await verifyGamePreviewLineage(first,generation);
      if(!proof.verified)return refuse(proof.reason,{
        checkpointVerified:true,fullOriginLocalStorageCovered:true
      });
      const bundle=first.bundle;
      const checkpointMatchesPreviewOrigin=
        checkpointOriginHash===bundle.originFingerprint;
      const checkpointMatchesPreviewGameState=
        checkpointSnapshotHash===bundle.snapshotFingerprint
        &&stableJson(prefs)===stableJson(bundle.preferences);
      // All async fingerprint operations above can yield to a second tab.
      // Confirm the checkpoint and the original preview evidence were not
      // changed underneath this audit, and inventory is still byte-identical.
      const [second,checkpointAgain]=await Promise.all([
        readGamePreviewRows(gameDb),
        requestPromise(recoveryDb.transaction(snapshotStore,'readonly')
          .objectStore(snapshotStore).get(checkpointId))
      ]);
      if(stableJson(second)!==stableJson(first)
        ||stableJson(checkpointAgain)!==stableJson(record)
        ||!isWalTestPreviewHost()||!isDarkEnabled()
        ||darkMirrorModeEpoch!==epoch
        ||currentGeneration({create:false})!==generation)
        return refuse('game_checkpoint_evidence_changed_during_audit');
      const currentToken=captureReadOnlyFullStorageInventory();
      if(currentToken!==startingToken)
        return refuse('game_checkpoint_origin_changed_during_audit');
      const checkpointMatchesCurrentV1=
        checkpointToken===currentToken;
      return {
        checked:true,previewOnly:true,checkpointVerified:true,
        gameBundleVerified:true,fullOriginLocalStorageCovered:true,
        checkpointMatchesPreviewOrigin,checkpointMatchesPreviewGameState,
        checkpointMatchesCurrentV1,
        reason:!checkpointMatchesPreviewOrigin
          ? 'checkpoint_game_bundle_differs'
          :!checkpointMatchesCurrentV1
            ? 'checkpoint_older_than_current_origin'
            :'checkpoint_game_coverage_verified',
        coversImages:false,coversIndexedDB:false,
        offDeviceBackupVerified:false,canApply:false,
        canPromote:false,gameMigrated:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    }catch(_){return refuse('game_checkpoint_coverage_unavailable');}
    finally{
      try{recoveryDb?.close();}catch(_){}
      try{gameDb?.close();}catch(_){}
    }
  }


  // Read-only, independently hashed verification of Game/Season image
  // REFERENCES against the actual legacy \`taskpoints\` IndexedDB image store.
  // Never open an absent DB (which would create it), never write/delete blobs,
  // and never equate an intact local image with an off-device backup.
  async function inspectPreviewGameImageCoverage() {
    const refuse=(reason,details={})=>({
      checked:true,previewOnly:true,sourceVerified:false,
      gameImageReferencesVerified:false,allReferencedImagesPresent:false,
      imageBytesVerified:false,externalImageBackupVerified:false,
      canPromote:false,gameMigrated:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...details
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    let db,imageDb;
    try {
      const token=captureReadOnlyFullStorageInventory();
      const source=await capturePreviewGameSource(token,generation,epoch);
      if(source.reason)return refuse(source.reason,{
        prerequisiteReason:source.prerequisiteReason
      });
      db=await openGamePreviewDb(generation,epoch);
      const parity=await proveGamePreviewParity(db,source);
      if(!parity.verified)return refuse('game_preview_parity_required',{
        prerequisiteReason:parity.reason
      });
      // Walk every Game/Season value, not just currently visible player
      // portraits. Older season archives and future added imageId keys
      // must survive an eventual import/export.
      const references=new Set();
      let invalid=false,visited=0;
      const inspect=(value,key='')=>{
        visited++;
        if(visited>75000){invalid=true;return;}
        if(/imageId$/i.test(key)) {
          if(value===null||value===undefined||value==='')return;
          if(typeof value!=='string'||value!==value.trim()
            ||value.length>256){invalid=true;return;}
          references.add(value);
        }
        if(Array.isArray(value)) {
          for(const v of value)inspect(v);
        }else if(value&&typeof value==='object'){
          for(const [k,v] of Object.entries(value))inspect(v,k);
        }
      };
      for(const row of source.rows)inspect(row.value);
      inspect(source.bundle.fields);
      if(invalid)return refuse('game_image_reference_invalid');
      if(references.size>256)return refuse('game_image_reference_limit');
      if(!source.current())return refuse('legacy_game_changed_during_image_audit');
      const ids=[...references].sort();
      if(!ids.length){
        return {
          checked:true,previewOnly:true,sourceVerified:true,
          gameImageReferencesVerified:true,allReferencedImagesPresent:true,
          imageBytesVerified:true,referencedImageCount:0,
          verifiedImageBytes:0,imageDatabaseChecked:false,
          reason:'game_preview_no_image_references',
          externalImageBackupVerified:false,canPromote:false,
          gameMigrated:false,productionWritersFenced:false,
          readAuthority:'legacy_only',mutationAuthority:'legacy_only'
        };
      }
      // Without IDB database enumeration, even an open('taskpoints')
      // would create a missing V1 image database: fail closed instead.
      if(typeof global.indexedDB?.databases!=='function')
        return refuse('game_image_database_enumeration_unavailable',{
          referencedImageCount:ids.length
        });
      const listed=await global.indexedDB.databases();
      if(!Array.isArray(listed)||!listed.some(d=>d?.name==='taskpoints'))
        return refuse('game_image_database_missing',{
          referencedImageCount:ids.length
        });
      if(!source.current())return refuse('legacy_game_changed_during_image_audit');
      imageDb=await new Promise((resolve,reject)=>{
        const req=global.indexedDB.open('taskpoints');
        req.onupgradeneeded=()=>{
          try{req.transaction?.abort();}catch(_){}
          reject(Error('game_image_database_created_during_audit'));
        };
        req.onsuccess=()=>resolve(req.result);
        req.onerror=()=>reject(req.error||Error('game_image_db_unreadable'));
        req.onblocked=()=>reject(Error('game_image_db_blocked'));
      });
      if(!imageDb.objectStoreNames?.contains('images'))
        return refuse('game_image_store_missing');
      const read=async()=>{
        const tx=imageDb.transaction('images','readonly');
        const store=tx.objectStore('images');
        // Issue all requests inside the same readonly transaction before
        // awaiting any completion (no async gap that closes the transaction).
        return Promise.all(ids.map(id=>requestPromise(store.get(id))));
      };
      const hash=async blobs=>{
        if(blobs.some(blob=>blob===null||blob===undefined))
          return {reason:'game_image_references_missing',
            missingImageCount:blobs.filter(b=>b==null).length};
        let total=0;
        for(const blob of blobs){
          if(!blob||typeof blob.arrayBuffer!=='function'
            ||!Number.isSafeInteger(blob.size)||blob.size<0)
            return {reason:'game_image_blob_invalid'};
          total+=blob.size;
          if(total>67108864)return {reason:'game_image_digest_budget_exceeded'};
        }
        const assets=[];
        for(let i=0;i<blobs.length;i++){
          const buffer=await blobs[i].arrayBuffer();
          if(buffer.byteLength!==blobs[i].size)
            return {reason:'game_image_blob_changed_during_read'};
          const digest=await global.crypto.subtle.digest('SHA-256',buffer);
          const hex=Array.from(new Uint8Array(digest),
            n=>n.toString(16).padStart(2,'0')).join('');
          assets.push([ids[i],blobs[i].size,blobs[i].type||'',hex]);
        }
        return {assets,total};
      };
      const first=await hash(await read());
      if(first.reason)return refuse(first.reason,{
        referencedImageCount:ids.length,
        ...(first.missingImageCount!==undefined
          ?{missingImageCount:first.missingImageCount}:{})
      });
      if(!source.current())return refuse('legacy_game_changed_during_image_digest');
      const second=await hash(await read());
      if(second.reason||stableJson(first)!==stableJson(second))
        return refuse('game_image_bytes_changed_during_audit');
      if(!source.current())
        return refuse('legacy_game_changed_after_image_digest');
      // The *Game preview itself* might have changed while reading blobs.
      const final=await proveGamePreviewParity(db,source);
      if(!final.verified)return refuse('game_preview_changed_during_image_audit',{
        prerequisiteReason:final.reason
      });
      const imageFingerprint=await previewRecoveryFingerprint(first.assets);
      if(!source.current())
        return refuse('legacy_game_changed_after_image_fingerprint');
      return {
        checked:true,previewOnly:true,sourceVerified:true,
        gameImageReferencesVerified:true,allReferencedImagesPresent:true,
        imageBytesVerified:true,referencedImageCount:ids.length,
        verifiedImageBytes:first.total,imageDatabaseChecked:true,
        imageFingerprint,reason:'game_preview_image_coverage_verified',
        externalImageBackupVerified:false,canPromote:false,
        gameMigrated:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    }catch(_){return refuse('game_image_coverage_unavailable');}
    finally{
      try{db?.close();}catch(_){}
      try{imageDb?.close();}catch(_){}
    }
  }


  // Parse precisely the stored/CRC-protected ZIP layout emitted by
  // home_export_responsiveness.js and accepted by Settings. The existing
  // Settings importer does not independently authenticate ZIP contents;
  // this V2 preflight is read-only and does not change that importer.
  // A caller may mutate an ArrayBuffer/Uint8Array after any await. Freeze
  // once at the outermost multi-stage audit boundary, then pass only the
  // private copy to ZIP CRC, live-asset SHA, and normalization rehearsals.
  function freezePreviewGameZipInput(input) {
    let bytes;
    try{
      if(input instanceof ArrayBuffer)bytes=new Uint8Array(input);
      else if(ArrayBuffer.isView(input)&&input.BYTES_PER_ELEMENT===1)
        bytes=new Uint8Array(input.buffer,input.byteOffset,input.byteLength);
      else return {reason:'game_backup_zip_bytes_required'};
    }catch(_){return {reason:'game_backup_zip_bytes_required'};}
    if(bytes.byteLength<52||bytes.byteLength>67108864)
      return {reason:'game_backup_zip_size_invalid'};
    return {bytes:Uint8Array.from(bytes)};
  }

  function parsePreviewGameBackupZip(input) {
    const fail=reason=>({reason});
    const frozen=freezePreviewGameZipInput(input);
    if(frozen.reason)return fail(frozen.reason);
    const bytes=frozen.bytes;
    if(typeof global.TextDecoder!=='function')
      return fail('game_backup_zip_decoder_unavailable');
    const decode=new global.TextDecoder('utf-8',{fatal:true});
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const u16=i=>view.getUint16(i,true),u32=i=>view.getUint32(i,true);
    const validName=name=>name==='manifest.json'
      ||(/^images\/[A-Za-z0-9_.:-]{1,256}\.(png|webp|gif|jpg|bin)$/
        .test(name)&&!name.includes('..'));
    const crcTable=new Uint32Array(256);
    for(let i=0;i<256;i++){
      let c=i;
      for(let j=0;j<8;j++)c=c&1?(0xEDB88320^(c>>>1)):(c>>>1);
      crcTable[i]=c>>>0;
    }
    const checksum=data=>{
      let crc=0xFFFFFFFF;
      for(const b of data)
        crc=crcTable[(crc^b)&255]^(crc>>>8);
      return (crc^0xFFFFFFFF)>>>0;
    };
    const entries=new Map(),rows=[];
    let offset=0;
    try {
      while(offset+4<=bytes.length&&u32(offset)===0x04034b50){
        if(rows.length>=300||offset+30>bytes.length)
          return fail('game_backup_zip_entry_limit');
        const flags=u16(offset+6),method=u16(offset+8);
        const crc=u32(offset+14),compressed=u32(offset+18);
        const uncompressed=u32(offset+22),nameLength=u16(offset+26);
        const extraLength=u16(offset+28);
        if(flags!==0||method!==0||compressed!==uncompressed
          ||extraLength!==0||!nameLength)
          return fail('game_backup_zip_unsupported_entry');
        const nameStart=offset+30;
        const dataStart=nameStart+nameLength;
        const end=dataStart+compressed;
        if(end>bytes.length)return fail('game_backup_zip_truncated_entry');
        const name=decode.decode(bytes.subarray(nameStart,dataStart));
        if(!validName(name)||entries.has(name))
          return fail('game_backup_zip_unsafe_or_duplicate_name');
        const data=bytes.subarray(dataStart,end);
        if(checksum(data)!==crc)
          return fail('game_backup_zip_crc_mismatch');
        rows.push({name,crc,size:compressed,offset});
        entries.set(name,data);
        offset=end;
      }
      const centralStart=offset;
      for(const row of rows){
        if(offset+46>bytes.length||u32(offset)!==0x02014b50)
          return fail('game_backup_zip_central_missing');
        const nameLength=u16(offset+28);
        const extraLength=u16(offset+30),commentLength=u16(offset+32);
        const end=offset+46+nameLength+extraLength+commentLength;
        if(end>bytes.length||u16(offset+8)!==0
          ||u16(offset+10)!==0||u16(offset+34)!==0
          ||extraLength!==0||commentLength!==0
          ||u32(offset+16)!==row.crc
          ||u32(offset+20)!==row.size
          ||u32(offset+24)!==row.size
          ||u32(offset+42)!==row.offset)
          return fail('game_backup_zip_central_mismatch');
        const name=decode.decode(bytes.subarray(offset+46,offset+46+nameLength));
        if(name!==row.name)return fail('game_backup_zip_central_mismatch');
        offset=end;
      }
      if(offset+22!==bytes.length||u32(offset)!==0x06054b50
        ||u16(offset+4)!==0||u16(offset+6)!==0
        ||u16(offset+8)!==rows.length
        ||u16(offset+10)!==rows.length
        ||u32(offset+12)!==offset-centralStart
        ||u32(offset+16)!==centralStart
        ||u16(offset+20)!==0)
        return fail('game_backup_zip_footer_invalid');
      if(!entries.has('manifest.json'))
        return fail('game_backup_zip_manifest_missing');
      return {entries};
    }catch(_){return fail('game_backup_zip_invalid');}
  }

  // Verify actual archived ZIP entry bytes against a sealed Game preview and
  // actual live V1 image bytes; NEVER import, restore, create or amend backups.
  // Separate Game preferences are not in the existing backup ZIP manifest,
  // so even a positive photo comparison does NOT authorize whole-app cutover.
  async function inspectPreviewGameBackupZip(archiveInput) {
    const refuse=(reason,details={})=>({
      checked:true,previewOnly:true,archiveStructureVerified:false,
      archiveGameFieldsVerified:false,archiveReferencedImagesVerified:false,
      independentPreferencesIncluded:false,independentPreferencesRestorable:false,
      completeGameBackupVerified:false,gameImportRoundTripVerified:false,
      offDeviceBackupVerified:false,canApply:false,canPromote:false,
      gameMigrated:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...details
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    let db;
    try {
      const token=captureReadOnlyFullStorageInventory();
      const captured=await capturePreviewGameSource(token,generation,epoch);
      if(captured.reason)return refuse(captured.reason,{
        prerequisiteReason:captured.prerequisiteReason
      });
      db=await openGamePreviewDb(generation,epoch);
      const proof=await proveGamePreviewParity(db,captured);
      if(!proof.verified)return refuse('game_preview_parity_required',{
        prerequisiteReason:proof.reason
      });
      // Legacy V2 previews did not seal absent-vs-empty roster presence:
      // explicit preview reconciliation is required before ZIP verification.
      const existingPreview=await readGamePreviewRows(db);
      if(typeof existingPreview.bundle?.playersPresent!=='boolean')
        return refuse('game_preview_player_presence_unsealed');
      const parsed=parsePreviewGameBackupZip(archiveInput);
      if(parsed.reason)return refuse(parsed.reason);
      let manifest;
      try{
        manifest=JSON.parse(
          new global.TextDecoder('utf-8',{fatal:true})
            .decode(parsed.entries.get('manifest.json')));
      }catch(_){return refuse('game_backup_manifest_invalid');}
      if(!manifest||manifest.exportType!=='taskpoints_full_backup'
        ||manifest.version!==2||!manifest.state
        ||typeof manifest.state!=='object'||Array.isArray(manifest.state)
        ||!Array.isArray(manifest.state.tasks)
        ||!Array.isArray(manifest.state.completions))
        return refuse('game_backup_manifest_unsupported');
      for(const key of GAME_ARRAY_FIELDS.concat(GAME_SCALAR_FIELDS)){
        const sourceHas=key==='players'?captured.bundle.playersPresent
          :Object.prototype.hasOwnProperty.call(captured.bundle.fields,key);
        const archiveHas=Object.prototype.hasOwnProperty.call(manifest.state,key);
        if(sourceHas!==archiveHas)
          return refuse('game_backup_field_presence_mismatch',{
            archiveStructureVerified:true
          });
        if(!sourceHas)continue;
        const canonical=key==='players'
          ?captured.rows.map(row=>row.value):captured.bundle.fields[key];
        if(stableJson(canonical)!==stableJson(manifest.state[key]))
          return refuse('game_backup_game_fields_mismatch',{
            archiveStructureVerified:true
          });
      }
      if(!captured.current())return refuse('game_backup_source_changed');
      const references=new Set();
      let invalid=false,visited=0;
      const collect=(value,key='')=>{
        if(++visited>75000){invalid=true;return;}
        if(/imageId$/i.test(key)){
          if(value==null||value==='')return;
          if(typeof value!=='string'||value!==value.trim()
            ||value.length>256){invalid=true;return;}
          references.add(value);
        }
        if(Array.isArray(value)){
          for(const item of value)collect(item);
        }else if(value&&typeof value==='object'){
          for(const [k,v] of Object.entries(value))collect(v,k);
        }
      };
      captured.rows.forEach(row=>collect(row.value));
      collect(captured.bundle.fields);
      if(invalid||references.size>256)
        return refuse('game_backup_image_reference_invalid',{
          archiveStructureVerified:true,archiveGameFieldsVerified:true
        });
      const assetFiles=new Map();
      for(const [path,data] of parsed.entries){
        if(path==='manifest.json')continue;
        const hit=/^images\/(.+)\.(png|webp|gif|jpg|bin)$/.exec(path);
        if(!hit)return refuse('game_backup_zip_unsafe_or_duplicate_name');
        const [,id,ext]=hit;
        if(assetFiles.has(id))
          return refuse('game_backup_duplicate_image_id');
        assetFiles.set(id,{data,ext});
      }
      const ids=[...references].sort();
      const missing=ids.filter(id=>!assetFiles.has(id));
      if(missing.length)return refuse('game_backup_referenced_images_missing',{
        archiveStructureVerified:true,archiveGameFieldsVerified:true,
        referencedImageCount:ids.length,missingImageCount:missing.length
      });
      if(!captured.current())return refuse('game_backup_source_changed');
      const imageTypes={
        png:'image/png',webp:'image/webp',gif:'image/gif',
        jpg:'image/jpeg'
      };
      const archivedAssets=[];
      for(const id of ids){
        const file=assetFiles.get(id);
        if(!Object.prototype.hasOwnProperty.call(imageTypes,file.ext))
          return refuse('game_backup_image_type_unverifiable',{
            archiveStructureVerified:true,archiveGameFieldsVerified:true
          });
        const digest=await global.crypto.subtle.digest('SHA-256',file.data);
        const hex=Array.from(new Uint8Array(digest),
          n=>n.toString(16).padStart(2,'0')).join('');
        archivedAssets.push([id,file.data.byteLength,imageTypes[file.ext],hex]);
      }
      const sealedArchiveFingerprint=await previewRecoveryFingerprint(archivedAssets);
      if(!captured.current())return refuse('game_backup_source_changed');
      // An in-memory ZIP is not an off-device backup. Compare its binary
      // bytes with the actual live image DB using the separate double-read
      // audit; never claim the external archive was saved or is recoverable.
      const live=await inspectPreviewGameImageCoverage();
      if(!live.gameImageReferencesVerified)
        return refuse('game_backup_live_images_unverifiable',{
          archiveStructureVerified:true,archiveGameFieldsVerified:true,
          prerequisiteReason:live.reason
        });
      if(ids.length && live.imageFingerprint!==sealedArchiveFingerprint)
        return refuse('game_backup_image_bytes_mismatch',{
          archiveStructureVerified:true,archiveGameFieldsVerified:true,
          referencedImageCount:ids.length
        });
      if(!captured.current())
        return refuse('game_backup_source_changed_after_image_comparison');
      const final=await proveGamePreviewParity(db,captured);
      if(!final.verified)
        return refuse('game_preview_changed_during_backup_audit',{
          prerequisiteReason:final.reason
        });
      // The legacy "Backup + Images" exporter archives only player.imageId
      // and youImageId. It does NOT include the independent Game preference
      // keys, so no archive can currently prove a complete Game restore.
      const aux=manifest.aux&&typeof manifest.aux==='object'
        ?manifest.aux:{};
      const independentPreferencesIncluded=GAME_PREFERENCE_KEYS.every(
        key=>Object.prototype.hasOwnProperty.call(aux,key)
          &&aux[key]===global.localStorage.getItem(key));
      if(!captured.current())
        return refuse('game_backup_source_changed_after_validation');
      return {
        checked:true,previewOnly:true,archiveStructureVerified:true,
        archiveGameFieldsVerified:true,
        archiveReferencedImagesVerified:true,
        referencedImageCount:ids.length,
        archivedImageFileCount:assetFiles.size,
        imageFingerprint:ids.length?sealedArchiveFingerprint:null,
        independentPreferencesIncluded,
        // The current Settings import ZIP path does NOT replay these three
        // auxiliary preferences even if they are present in a custom ZIP.
        // Contents verified is not the same as restoration verified.
        independentPreferencesRestorable:false,
        completeGameBackupVerified:false,
        gameImportRoundTripVerified:false,
        // An in-memory ZIP is not a separately durable device-loss backup.
        offDeviceBackupVerified:false,canApply:false,canPromote:false,
        gameMigrated:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only',
        reason:independentPreferencesIncluded
          ?'game_backup_preferences_restore_unverified'
          :'game_backup_missing_independent_preferences'
      };
    }catch(_){return refuse('game_backup_zip_audit_unavailable');}
    finally{try{db?.close();}catch(_){}}
  }


  // Nonmutating import round-trip preflight. Reconstruct a hypothetical
  // Settings ZIP import entirely in detached JavaScript objects and RAM.
  // No writes to V1, V2, the image DB, storage, or actual download paths.
  // It inspects the *existing* Settings normalizer, not a fabricated
  // replacement, and never calls any Settings save/import method.
  async function rehearsePreviewGameZipRestoreInMemory(archiveInput) {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,restoredInMemory:false,
      settingsNormalizationVerified:false,
      gameNormalizationParityVerified:false,
      rawGameFieldPreservationVerified:false,
      imageReconstructionVerified:false,
      independentPreferencesRestorable:false,
      completeGameRestoreVerified:false,fullAppRestoreVerified:false,
      offDeviceBackupVerified:false,canApply:false,canPromote:false,
      gameMigrated:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    if(typeof core.normalizeImportedFullBackupState!=='function')
      return refuse('settings_import_normalizer_unavailable');
    const epoch=darkMirrorModeEpoch;
    const frozen=freezePreviewGameZipInput(archiveInput);
    if(frozen.reason)return refuse('game_backup_zip_preflight_required',{
      prerequisiteReason:frozen.reason
    });
    const input=frozen.bytes;
    let db;
    try {
      const origin=captureReadOnlyFullStorageInventory();
      const source=await capturePreviewGameSource(origin,generation,epoch);
      if(source.reason)return refuse(source.reason);
      db=await openGamePreviewDb(generation,epoch);
      const before=await proveGamePreviewParity(db,source);
      if(!before.verified)return refuse('game_preview_parity_required',{
        prerequisiteReason:before.reason
      });
      // Never treat a structurally correct but incomplete ZIP as
      // restorable: first check the real ZIP, all referenced binary photos,
      // the original V1 snapshot and the Game preview provenance.
      const archive=await inspectPreviewGameBackupZip(input);
      if(!archive.archiveStructureVerified
        ||!archive.archiveGameFieldsVerified
        ||!archive.archiveReferencedImagesVerified)
        return refuse('game_backup_zip_preflight_required',{
          prerequisiteReason:archive.reason
        });
      if(!source.current())return refuse('source_changed_before_restore_rehearsal');
      const parsed=parsePreviewGameBackupZip(input);
      if(parsed.reason)return refuse(parsed.reason);
      const manifest=JSON.parse(
        new global.TextDecoder('utf-8',{fatal:true})
          .decode(parsed.entries.get('manifest.json')));
      const raw=global.localStorage.getItem(core.STORAGE_KEY||'taskpoints_v1');
      const original=core.parseTaskPointsStorageJson(raw);
      if(!original||typeof original!=='object'||Array.isArray(original)
        ||!manifest?.state||typeof manifest.state!=='object')
        return refuse('game_restore_source_invalid');
      // Core normalizeImportedFullBackupState is the same pure
      // normalization entry point currently called by settings.html.
      // Separate Notes/Projects, warning prompts and the final durable
      // save are intentionally NOT impersonated by this rehearsal.
      const cloneValue=value=>JSON.parse(JSON.stringify(value));
      const options={preserveMissingReminders:false,
        preserveMissingProjects:false};
      const inputOriginal=cloneValue(original);
      const inputArchive=cloneValue(manifest.state);
      const baseline=core.normalizeImportedFullBackupState(
        inputOriginal,cloneValue(original),options);
      const reconstructed=core.normalizeImportedFullBackupState(
        inputArchive,cloneValue(original),options);
      if(!baseline||typeof baseline!=='object'
        ||!reconstructed||typeof reconstructed!=='object'
        ||Array.isArray(baseline)||Array.isArray(reconstructed))
        return refuse('settings_import_normalization_invalid');
      const tracked=GAME_ARRAY_FIELDS.concat(GAME_SCALAR_FIELDS,
        ['reservedPlayerPids','playerBadges']);
      // These extra player resources live in V1 but were not in the
      // original Game preview bundle. They must not silently disappear
      // from a future backup even when the normalizer would fill defaults.
      for(const field of ['reservedPlayerPids','playerBadges']){
        const has=Object.prototype.hasOwnProperty.call(original,field);
        if(has!==Object.prototype.hasOwnProperty.call(manifest.state,field)
          ||has&&stableJson(original[field])!==
            stableJson(manifest.state[field]))
          return refuse('game_backup_additional_player_state_mismatch');
      }
      let normalizedDifferences=0,rawDifferences=0;
      for(const field of tracked){
        const inBaseline=Object.prototype.hasOwnProperty.call(baseline,field);
        const inRestored=Object.prototype.hasOwnProperty.call(
          reconstructed,field);
        if(inBaseline!==inRestored
          ||inBaseline&&stableJson(baseline[field])!==
            stableJson(reconstructed[field]))
          normalizedDifferences++;
        const inRaw=Object.prototype.hasOwnProperty.call(original,field);
        const inResult=Object.prototype.hasOwnProperty.call(
          reconstructed,field);
        if(inRaw!==inResult
          ||inRaw&&stableJson(original[field])!==
            stableJson(reconstructed[field]))
          rawDifferences++;
      }
      if(normalizedDifferences)
        return refuse('game_import_normalization_parity_mismatch',{
          settingsNormalizationVerified:true,normalizedDifferences
        });
      if(!source.current()||raw!==global.localStorage.getItem(
        core.STORAGE_KEY||'taskpoints_v1'))
        return refuse('source_changed_after_import_normalization');
      // Recreate the Settings ZIP importer image stage in an ephemeral
      // Map of exact byte copies. Never instantiate a real legacy Blob
      // store or call saveImageBlob. SHA the copies and compare against
      // the already independently verified live-image archive proof.
      const imageMimes={png:'image/png',webp:'image/webp',
        gif:'image/gif',jpg:'image/jpeg'};
      const referenced=new Set();
      let scanned=0;
      const visit=(value,key='')=>{
        if(++scanned>75000)throw Error('image_reference_scope_exceeded');
        if(/imageId$/i.test(key)&&typeof value==='string'&&value)
          referenced.add(value);
        if(Array.isArray(value))
          value.forEach(item=>visit(item));
        else if(value&&typeof value==='object')
          Object.entries(value).forEach(([k,v])=>visit(v,k));
      };
      visit(manifest.state.players||[]);
      for(const field of GAME_ARRAY_FIELDS.concat(GAME_SCALAR_FIELDS)){
        if(field==='players')continue;
        if(Object.prototype.hasOwnProperty.call(manifest.state,field))
          visit(manifest.state[field],field);
      }
      if(referenced.size>256)
        return refuse('game_restore_image_reference_limit');
      const staged=new Map();
      for(const [file,data] of parsed.entries){
        if(file==='manifest.json')continue;
        const match=/^images\/(.+)\.(png|webp|gif|jpg|bin)$/.exec(file);
        if(!match)return refuse('game_restore_image_file_invalid');
        if(staged.has(match[1]))return refuse('game_restore_duplicate_image_id');
        staged.set(match[1],{bytes:Uint8Array.from(data),ext:match[2]});
      }
      const identities=[...referenced].sort();
      let verifiedBytes=0;
      const checks=[];
      for(const id of identities){
        const item=staged.get(id);
        if(!item||!imageMimes[item.ext])
          return refuse('game_restore_referenced_image_unavailable');
        verifiedBytes+=item.bytes.byteLength;
        if(verifiedBytes>67108864)
          return refuse('game_restore_image_memory_budget_exceeded');
        const digest=await global.crypto.subtle.digest(
          'SHA-256',item.bytes);
        const hex=Array.from(new Uint8Array(digest),
          n=>n.toString(16).padStart(2,'0')).join('');
        checks.push([id,item.bytes.byteLength,imageMimes[item.ext],hex]);
      }
      const fingerprint=identities.length
        ?await previewRecoveryFingerprint(checks):null;
      if(fingerprint!==archive.imageFingerprint)
        return refuse('game_restore_image_digest_mismatch');
      if(!source.current())
        return refuse('source_changed_after_image_staging');
      const after=await proveGamePreviewParity(db,source);
      if(!after.verified)
        return refuse('game_preview_changed_during_restore_rehearsal',{
          prerequisiteReason:after.reason
        });
      // Re-read V1 and sidecars after async digest to prevent a stale
      // normalizer or old-tab import from receiving a positive verdict.
      if(!source.current())
        return refuse('source_changed_after_restore_rehearsal');
      return {
        checked:true,previewOnly:true,restoredInMemory:true,
        settingsNormalizationVerified:true,
        gameNormalizationParityVerified:true,
        rawGameFieldPreservationVerified:rawDifferences===0,
        rawGameFieldDifferenceCount:rawDifferences,
        comparedGameFieldCount:tracked.length,
        imageReconstructionVerified:true,
        reconstructedReferencedImages:identities.length,
        reconstructedImageBytes:verifiedBytes,
        inMemoryImageFingerprint:fingerprint,
        // Game preferences are stored separately and the actual Settings
        // import DOES NOT restore them, even from an enriched manifest.
        independentPreferencesRestorable:false,
        completeGameRestoreVerified:false,fullAppRestoreVerified:false,
        offDeviceBackupVerified:false,canApply:false,canPromote:false,
        gameMigrated:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only',
        reason:rawDifferences
          ?'game_zip_normalized_restore_only'
          :'game_zip_in_memory_restore_rehearsed'
      };
    }catch(_){return refuse('game_zip_restore_rehearsal_unavailable');}
    finally{try{db?.close();}catch(_){}}
  }


  // Whole-application backup COVERAGE audit, not an import or a restore.
  // The existing Game ZIP preflight authenticates the archive's structural
  // envelope, Game fields, and referenced live image bytes. This separate
  // read-only rehearsal checks *every* V1 snapshot field, including future
  // unknown keys, plus independently persisted origin sidecars. It never
  // calls a save, opens an image writer, or grants authority to V2.
  async function inspectPreviewWholeBackupRestoreCoverage(archiveInput) {
    const refuse=(reason,more={})=>({
      checked:true,previewOnly:true,wholeSnapshotCompared:false,
      rawSnapshotFieldsPreserved:false,
      settingsNormalizationParityVerified:false,
      rawImportFieldPreservationVerified:false,
      independentOriginSidecarsCovered:false,
      independentOriginSidecarsRestorable:false,
      fullAppRestoreVerified:false,offDeviceBackupVerified:false,
      canApply:false,canPromote:false,
      productionWritersFenced:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...more
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(typeof core.normalizeImportedFullBackupState!=='function')
      return refuse('settings_import_normalizer_unavailable');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const frozen=freezePreviewGameZipInput(archiveInput);
    if(frozen.reason)return refuse(frozen.reason);
    const input=frozen.bytes;
    try{
      const origin=captureReadOnlyFullStorageInventory();
      const game=await inspectPreviewGameBackupZip(input);
      if(!game.archiveStructureVerified||!game.archiveGameFieldsVerified
        ||!game.archiveReferencedImagesVerified)
        return refuse('whole_backup_game_preflight_required',{
          prerequisiteReason:game.reason
        });
      if(captureReadOnlyFullStorageInventory()!==origin
        ||currentGeneration({create:false})!==generation
        ||darkMirrorModeEpoch!==epoch||!isDarkEnabled())
        return refuse('whole_backup_origin_changed');
      const zip=parsePreviewGameBackupZip(input);
      if(zip.reason)return refuse(zip.reason);
      const manifest=JSON.parse(
        new global.TextDecoder('utf-8',{fatal:true})
          .decode(zip.entries.get('manifest.json')));
      const stored=global.localStorage.getItem(core.STORAGE_KEY||'taskpoints_v1');
      if(typeof stored!=='string')return refuse('whole_backup_source_missing');
      const original=core.parseTaskPointsStorageJson(stored);
      const imported=manifest?.state;
      if(!original||typeof original!=='object'||Array.isArray(original)
        ||!imported||typeof imported!=='object'||Array.isArray(imported)
        ||!Array.isArray(original.tasks)
        ||!Array.isArray(original.completions))
        return refuse('whole_backup_snapshot_invalid');
      // The Settings full-import path calls this normalizer. Invoke only
      // its pure normalization entry point with detached arguments.
      const copy=value=>JSON.parse(JSON.stringify(value));
      const options={preserveMissingReminders:false,
        preserveMissingProjects:false};
      const normalizedOriginal=core.normalizeImportedFullBackupState(
        copy(original),copy(original),options);
      const normalizedImport=core.normalizeImportedFullBackupState(
        copy(imported),copy(original),options);
      if(!normalizedOriginal||typeof normalizedOriginal!=='object'
        ||Array.isArray(normalizedOriginal)||!normalizedImport
        ||typeof normalizedImport!=='object'||Array.isArray(normalizedImport))
        return refuse('whole_backup_normalizer_result_invalid');
      const difference=(left,right)=>{
        const keys=new Set([...Object.keys(left),...Object.keys(right)]);
        let mismatches=0;
        for(const key of keys){
          const a=Object.prototype.hasOwnProperty.call(left,key);
          const b=Object.prototype.hasOwnProperty.call(right,key);
          if(a!==b||a&&stableJson(left[key])!==stableJson(right[key]))
            mismatches++;
        }
        return {compared:keys.size,mismatches};
      };
      const raw=difference(original,imported);
      const normalized=difference(normalizedOriginal,normalizedImport);
      const restoredRaw=difference(original,normalizedImport);
      // Source keys outside taskpoints_v1 can be authoritative. A ZIP
      // exporter may include an auxiliary value while Settings never
      // restores it. Observe BOTH properties separately, never infer
      // restorable=true from a matching manifest value.
      const keys=[
        'taskpoints_notes_v1',
        'taskpoints_notes_dirty_v1',
        'taskpoints_notes_authoritative_v1',
        'tp_projects_v1',
        'taskpoints_today_view_v1',
        ...GAME_PREFERENCE_KEYS
      ];
      const aux=manifest.aux&&typeof manifest.aux==='object'
        &&!Array.isArray(manifest.aux)?manifest.aux:{};
      let sidecarCount=0,covered=0;
      for(const key of keys){
        const actual=global.localStorage.getItem(key);
        if(actual===null)continue;
        sidecarCount++;
        if(Object.prototype.hasOwnProperty.call(aux,key)
          &&typeof aux[key]==='string'&&aux[key]===actual)
          covered++;
      }
      const sourceUnchanged=captureReadOnlyFullStorageInventory()===origin
        &&global.localStorage.getItem(core.STORAGE_KEY||'taskpoints_v1')===stored
        &&currentGeneration({create:false})===generation
        &&darkMirrorModeEpoch===epoch&&isDarkEnabled()
        &&isWalTestPreviewHost();
      if(!sourceUnchanged)return refuse('whole_backup_origin_changed');
      // The real Settings ZIP flow writes photos before confirming a full
      // import, and never replays Today, Game prefs or Notes dirty flags.
      // Therefore even 100% archive-field parity cannot certify a safe,
      // reversible whole-app restore or an off-device copy.
      const details={
        wholeSnapshotCompared:true,
        snapshotFieldCount:raw.compared,
        snapshotFieldMismatchCount:raw.mismatches,
        rawSnapshotFieldsPreserved:raw.mismatches===0,
        normalizedFieldCount:normalized.compared,
        normalizedFieldMismatchCount:normalized.mismatches,
        settingsNormalizationParityVerified:normalized.mismatches===0,
        rawImportFieldMismatchCount:restoredRaw.mismatches,
        rawImportFieldPreservationVerified:restoredRaw.mismatches===0,
        observedIndependentSidecarCount:sidecarCount,
        archivedIndependentSidecarCount:covered,
        missingIndependentSidecarCount:sidecarCount-covered,
        independentOriginSidecarsCovered:covered===sidecarCount,
        independentOriginSidecarsRestorable:false,
        imagesWrittenBeforeImportConfirmation:true,
        restoreOrderAndInterruptionValidated:false
      };
      return refuse(normalized.mismatches
        ?'whole_backup_normalization_parity_mismatch'
        :restoredRaw.mismatches
          ?'whole_backup_normalization_drops_raw_fields'
          :raw.mismatches
            ?'whole_backup_snapshot_field_mismatch'
            :covered!==sidecarCount
              ?'whole_backup_independent_sidecars_missing'
              :'whole_backup_import_and_rollback_unverified',details);
    }catch(_){return refuse('whole_backup_coverage_unavailable');}
  }

  async function rehearsePreviewGameCollectionAction(sourceToken,actionId,reconcile) {
    const refuse=(reason,extra={})=>({
      checked:true,previewOnly:true,committed:false,confirmedDurable:false,
      collectionParityVerified:false,gameMigrated:false,canPromote:false,
      productionWritersFenced:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...extra
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(typeof sourceToken!=='string'||!sourceToken)
      return refuse('full_origin_token_required');
    if(typeof actionId!=='string'||!actionId||actionId.length>128)
      return refuse('game_preview_action_id_required');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    let captured,db,committed=false;
    try{
      captured=await capturePreviewGameSource(sourceToken,generation,epoch);
      if(captured.reason)return refuse(captured.reason,{
        prerequisiteReason:captured.prerequisiteReason
      });
      db=await openGamePreviewDb(generation,epoch);
      const original=await readGamePreviewRows(db);
      const any=original.rows.length||original.bundle
        ||original.evidence||original.receipts.length;
      let lineage=null;
      if(any){
        lineage=await verifyGamePreviewLineage(original,generation);
        if(!lineage.verified)return refuse(lineage.reason);
      }
      if(!any&&reconcile)return refuse('game_preview_seed_required');
      if(any&&!reconcile){
        const proof=await proveGamePreviewParity(db,captured);
        if(!proof.verified)return refuse(proof.reason);
        return {
          checked:true,previewOnly:true,committed:false,confirmedDurable:true,
          collectionParityVerified:true,gameMigrated:false,
          receiptCount:proof.receiptCount,reason:'game_preview_already_verified',
          canPromote:false,productionWritersFenced:false,
          readAuthority:'legacy_only',mutationAuthority:'legacy_only'
        };
      }
      if(!captured.current())return refuse('legacy_game_changed_before_write');
      if(any&&stableJson(original.bundle)===stableJson(captured.bundle)
        && stableJson(original.rows.slice().sort((a,b)=>a.id-b.id))
          ===stableJson(captured.rows)) {
        const proof=await proveGamePreviewParity(db,captured);
        if(!proof.verified)return refuse(proof.reason);
        return {
          checked:true,previewOnly:true,committed:false,confirmedDurable:true,
          collectionParityVerified:true,gameMigrated:false,
          receiptCount:proof.receiptCount,reason:'game_preview_reconcile_no_change',
          canPromote:false,productionWritersFenced:false,
          readAuthority:'legacy_only',mutationAuthority:'legacy_only'
        };
      }
      if(original.receipts.length>=128)
        return refuse('game_preview_receipt_limit');
      const prior=new Map(original.rows.map(row=>[row.id,row]));
      const changed=captured.rows.filter(row=>
        stableJson(prior.get(row.id))!==stableJson(row));
      const removed=original.rows.filter(row=>row.id>=captured.rows.length);
      if(reconcile&&(changed.length+removed.length>64
        ||JSON.stringify(changed.concat(removed)).length>262144))
        return refuse('game_preview_reconcile_batch_too_large');
      const receiptId=(reconcile?'game-preview-reconcile:':'game-preview-seed:')
        +actionId;
      if(original.receipts.some(row=>row.id===receiptId))
        return refuse('game_preview_action_id_reused');
      const receipt={
        id:receiptId,
        type:reconcile?'game-preview-reconcile':'game-preview-seed',
        resetGeneration:generation,
        originFingerprint:captured.bundle.originFingerprint,
        sourceFingerprint:captured.bundle.sourceFingerprint,
        bundleFingerprint:captured.digest,
        ...(reconcile?{
          priorReceiptId:lineage.head.id,
          priorReceiptFingerprint:
            await previewRecoveryFingerprint(lineage.head)
        }:{})
      };
      const evidence={id:GAME_PREVIEW_ID,schemaVersion:1,
        resetGeneration:generation,receiptId,
        bundleFingerprint:captured.digest};
      if(!captured.current())
        return refuse('legacy_game_changed_before_transaction');
      let failure='game_preview_atomic_write_failed';
      const tx=db.transaction(['players','bundles','receipts','meta'],'readwrite');
      const ps=tx.objectStore('players'),bs=tx.objectStore('bundles');
      const rs=tx.objectStore('receipts'),ms=tx.objectStore('meta');
      const reads=[ps.getAll(),bs.get(GAME_PREVIEW_ID),
        ms.get(GAME_PREVIEW_ID),rs.getAll(),rs.get(receiptId)];
      const results=[];
      let pending=reads.length;
      const abort=reason=>{failure=reason;try{tx.abort();}catch(_){}};
      reads.forEach((request,index)=>{request.onsuccess=()=>{
        results[index]=request.result;
        if(--pending!==0)return;
        try{
          if(!captured.current())
            return abort('legacy_game_changed_under_transaction');
          if(stableJson(results[0])!==stableJson(original.rows)
            ||stableJson(results[1])!==stableJson(original.bundle)
            ||stableJson(results[2])!==stableJson(original.evidence)
            ||stableJson(results[3])!==stableJson(original.receipts)
            ||results[4])
            return abort('game_preview_concurrent_change');
          for(const row of removed)ps.delete(row.id);
          for(const row of changed)ps.put(row);
          // Seeds add all records, including index 0 (no fixed ID needed).
          bs.put(captured.bundle);
          rs.add(receipt);
          ms.put(evidence);
        }catch(_){abort('game_preview_atomic_write_failed');}
      };});
      try{await transactionPromise(tx);}
      catch(_){return refuse(failure);}
      committed=true;
      const proof=await proveGamePreviewParity(db,captured);
      if(!proof.verified)return refuse(proof.reason,{
        committed:true,writeOutcomeUncertain:true
      });
      return {
        checked:true,previewOnly:true,committed:true,confirmedDurable:true,
        collectionParityVerified:true,gameMigrated:false,
        changedPlayers:changed.length,removedPlayers:removed.length,
        receiptCount:proof.receiptCount,
        reason:reconcile?'game_preview_reconcile_verified'
          :'game_preview_seed_verified',
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    }catch(_){return refuse('game_preview_action_unavailable',{
      committed,writeOutcomeUncertain:committed
    });}
    finally{try{db?.close();}catch(_){}}
  }

  async function rehearsePreviewGameCollectionSeed(sourceToken,actionId) {
    return rehearsePreviewGameCollectionAction(sourceToken,actionId,false);
  }
  async function rehearsePreviewGameCollectionReconcile(sourceToken,actionId) {
    return rehearsePreviewGameCollectionAction(sourceToken,actionId,true);
  }
  async function inspectPreviewGameCollectionParity() {
    const refuse=(reason,extra={})=>({
      checked:true,previewOnly:true,match:false,gameMigrated:false,
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...extra
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    let db;
    try{
      const token=captureReadOnlyFullStorageInventory();
      const captured=await capturePreviewGameSource(token,generation,epoch);
      if(captured.reason)return refuse(captured.reason,{
        prerequisiteReason:captured.prerequisiteReason
      });
      db=await openGamePreviewDb(generation,epoch);
      const proof=await proveGamePreviewParity(db,captured);
      if(!proof.verified)return refuse(proof.reason);
      return {
        checked:true,previewOnly:true,match:true,
        receiptCount:proof.receiptCount,
        gameMigrated:false,reason:'game_preview_collection_parity_verified',
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    }catch(_){return refuse('game_preview_parity_unavailable');}
    finally{try{db?.close();}catch(_){}}
  }


  // Read-only, same-device recovery preflight for isolated Game preview rows.
  // Never read V1 Game, images or preference keys here, and never restore them.
  async function inspectPreviewGameRecoveryEvidence(){
    const refuse=reason=>({
      checked:true,previewOnly:true,evidenceVerified:false,
      sourceCompared:false,safeToRestore:false,gameMigrated:false,
      coversImages:false,fullExportVerified:false,
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',reason
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    const generation=currentGeneration({create:false}),epoch=darkMirrorModeEpoch;
    if(!generation)return refuse('generation_unavailable');
    const current=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&darkMirrorModeEpoch===epoch
      &&currentGeneration({create:false})===generation;
    const sha=x=>typeof x==='string'&&/^sha256:[a-f0-9]{64}:\d+$/.test(x);
    let db;
    try{
      db=await openGamePreviewDb(generation,epoch);
      const saved=await readGamePreviewRows(db);
      const lineage=await verifyGamePreviewLineage(saved,generation);
      if(!lineage.verified)return refuse(lineage.reason);
      const {bundle,rows,receipts}=saved;
      // The earliest preview did not encode whether players was missing
      // versus an explicit empty array. Do not claim independent proof.
      if(typeof bundle.playersPresent!=='boolean')
        return refuse('game_preview_player_presence_unsealed');
      if(!sha(bundle.originFingerprint)||!sha(bundle.sourceFingerprint)
        ||!sha(bundle.snapshotFingerprint)||rows.length>1024
        ||(!bundle.playersPresent&&rows.length!==0))
        return refuse('game_preview_saved_provenance_invalid');
      if(Object.keys(bundle.fields).some(key=>
        !GAME_ARRAY_FIELDS.includes(key)&&!GAME_SCALAR_FIELDS.includes(key))
        ||Object.prototype.hasOwnProperty.call(bundle.fields,'players'))
        return refuse('game_preview_field_boundary_invalid');
      for(const key of GAME_ARRAY_FIELDS.filter(x=>x!=='players'))
        if(Object.prototype.hasOwnProperty.call(bundle.fields,key)
          &&!Array.isArray(bundle.fields[key]))
          return refuse('game_preview_field_shape_invalid');
      if(bundle.preferences.some(x=>x!==null&&typeof x!=='string'))
        return refuse('game_preview_preferences_invalid');
      const sorted=rows.slice().sort((a,b)=>a.id-b.id);
      const projection=await previewRecoveryFingerprint({
        fields:bundle.fields,players:sorted.map(x=>x.value),
        preferences:bundle.preferences
      });
      if(projection!==bundle.sourceFingerprint)
        return refuse('game_preview_source_projection_invalid');
      // Lineage needs an intact entire history, not only the head record.
      for(const receipt of receipts){
        if(!receipt.id.startsWith(receipt.type+':')
          ||!sha(receipt.bundleFingerprint)
          ||!sha(receipt.sourceFingerprint)
          ||!sha(receipt.originFingerprint))
          return refuse('game_preview_receipt_metadata_invalid');
      }
      const again=await readGamePreviewRows(db);
      if(!current()||stableJson(again)!==stableJson(saved))
        return refuse('game_preview_evidence_changed_during_inspection');
      return {...refuse('game_preview_recovery_evidence_verified'),
        evidenceVerified:true,playerCount:sorted.length,
        playersPresent:bundle.playersPresent,
        receiptCount:lineage.receiptCount};
    }catch(_){return refuse('game_preview_recovery_unavailable');}
    finally{try{db?.close();}catch(_){}}
  }

  // Today is a separate, independently writable V1 authority. Its four
  // per-day maps do not live in the main TaskPoints snapshot. This preview
  // capture never invokes Today page's forgiving fallback, which can erase
  // malformed records by turning them into empty maps when saved.
  async function inspectPreviewTodaySource() {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,sourceVerified:false,
      todayMigrated:false,canPromote:false,
      productionWritersFenced:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    const generation=currentGeneration({create:false});
    if (!generation) return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const sourceKey='taskpoints_today_view_v1';
    const fields=['tasksByDay','notesByDay','selectedHabitIdsByDay','orderByDay'];
    let inventory,raw,payload,keys=new Set(),entryCount=0,noteCount=0;
    try {
      inventory=captureReadOnlyFullStorageInventory();
      raw=global.localStorage.getItem(sourceKey);
      if (raw===null) payload={};
      else if (typeof raw==='string') {
        try { payload=JSON.parse(raw); }
        catch (_) { return refuse('legacy_today_json_malformed'); }
      } else return refuse('legacy_today_storage_unreadable');
      if (!payload || typeof payload!=='object' || Array.isArray(payload))
        return refuse('legacy_today_object_required');
      if (Object.prototype.hasOwnProperty.call(payload,'version')
        && payload.version!==1)
        return refuse('legacy_today_schema_unrecognized');
      for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(payload,field)) continue;
        const map=payload[field];
        if (!map || typeof map!=='object' || Array.isArray(map))
          return refuse('legacy_today_day_map_invalid',{field});
        for (const [day,items] of Object.entries(map)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)
            || !Array.isArray(items))
            return refuse('legacy_today_day_entries_invalid',{field});
          keys.add(day);
          entryCount+=items.length;
          if (field==='notesByDay') noteCount+=items.length;
        }
      }
      if (keys.size>4096 || JSON.stringify(payload).length>1048576)
        return refuse('legacy_today_preview_size_limit');
      if (captureReadOnlyFullStorageInventory()!==inventory
        || global.localStorage.getItem(sourceKey)!==raw)
        return refuse('legacy_today_changed_during_capture');
    } catch (_) { return refuse('legacy_today_storage_unreadable'); }
    let sourceFingerprint;
    try {
      sourceFingerprint=await previewRecoveryFingerprint({
        sourcePresent:raw!==null,payload
      });
    } catch (_) { return refuse('legacy_today_digest_unavailable'); }
    try {
      if (!isDarkEnabled() || epoch!==darkMirrorModeEpoch
        || currentGeneration({create:false})!==generation
        || captureReadOnlyFullStorageInventory()!==inventory
        || global.localStorage.getItem(sourceKey)!==raw)
        return refuse('legacy_today_changed_after_digest');
    } catch (_) { return refuse('legacy_today_storage_unreadable'); }
    return {
      checked:true,previewOnly:true,sourceVerified:true,
      todayMigrated:false,hasSourceKey:raw!==null,
      dayCount:keys.size,entryCount,noteCount,sourceFingerprint,
      comparisonScope:'independent_v1_today_complete_source',
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason:'legacy_today_source_verified'
    };
  }

  // Exact stable source capture for future record-by-day preview migration.
  // Unknown top-level fields and sparse day-map membership are not normalized.
  async function capturePreviewTodaySource() {
    const inventory=captureReadOnlyFullStorageInventory();
    const raw=global.localStorage.getItem('taskpoints_today_view_v1');
    const proof=await inspectPreviewTodaySource();
    if (!proof.sourceVerified)
      return {reason:'today_source_preflight_required',
        prerequisiteReason:proof.reason};
    if (captureReadOnlyFullStorageInventory()!==inventory
      || global.localStorage.getItem('taskpoints_today_view_v1')!==raw)
      return {reason:'legacy_today_changed_during_capture'};
    const payload=raw===null?{}:JSON.parse(raw);
    const fields=['tasksByDay','notesByDay','selectedHabitIdsByDay','orderByDay'];
    const root={};
    for (const [key,value] of Object.entries(payload)) {
      if (!fields.includes(key)) {
        // JSON permits an own "__proto__" key. Defining the property
        // explicitly preserves it without mutating the object prototype.
        Object.defineProperty(root,key,{
          value:clone(value),enumerable:true,writable:true,configurable:true
        });
      }
    }
    const days=new Set();
    for (const key of fields) {
      for (const day of Object.keys(payload[key]||{})) days.add(day);
    }
    const presentMaps=fields.filter(field=>
      Object.prototype.hasOwnProperty.call(payload,field));
    const records=[{id:'root',value:root,presentMaps}];
    for (const day of [...days].sort()) {
      const value={};
      for (const key of fields) {
        if (Object.prototype.hasOwnProperty.call(payload[key]||{},day))
          value[key]=clone(payload[key][day]);
      }
      records.push({id:'day:'+day,dayKey:day,value});
    }
    return {inventory,raw,sourceFingerprint:proof.sourceFingerprint,
      dayCount:days.size,records};
  }

  // PREVIEW ONLY: materialize Today view one day at a time without
  // normalizing away unknown top-level properties or absent day-map keys.
  // No production Today writer or export path reads this isolated store.
  async function rehearsePreviewTodayCollectionSeed(sourceToken,actionId) {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,committed:false,confirmedDurable:false,
      collectionParityVerified:false,todayMigrated:false,
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof sourceToken!=='string' || !sourceToken)
      return refuse('full_origin_token_required');
    if (typeof actionId!=='string' || !actionId || actionId.length>128)
      return refuse('today_preview_action_id_required');
    const generation=currentGeneration({create:false});
    if (!generation) return refuse('generation_unavailable');
    const modeEpoch=darkMirrorModeEpoch;
    const sourceCurrent=()=>isDarkEnabled()
      && darkMirrorModeEpoch===modeEpoch
      && currentGeneration({create:false})===generation
      && captureReadOnlyFullStorageInventory()===sourceToken;
    let captured;
    try {
      if (!sourceCurrent()) return refuse('full_origin_changed');
      captured=await capturePreviewTodaySource();
      if (captured.reason) return refuse(captured.reason,{
        prerequisiteReason:captured.prerequisiteReason
      });
      if (captured.inventory!==sourceToken || !sourceCurrent())
        return refuse('legacy_today_changed_during_capture');
    } catch (_) { return refuse('legacy_today_storage_unreadable'); }
    const {records,sourceFingerprint,dayCount,raw}=captured;
    if (records.length>4097 || JSON.stringify(records).length>1258291)
      return refuse('today_preview_seed_too_large');
    let recordsFingerprint;
    try { recordsFingerprint=await previewRecoveryFingerprint(records.slice().sort((a,b)=>String(a.id).localeCompare(String(b.id)))); }
    catch (_) { return refuse('today_preview_records_digest_unavailable'); }
    const sourceInventory=fnv1a(sourceToken)+':'+sourceToken.length;
    const receiptId='today-preview-seed:'+actionId;
    const receipt={id:receiptId,type:'today-preview-seed',
      resetGeneration:generation,sourceInventory,sourceFingerprint,
      sourcePresent:raw!==null,dayCount,recordCount:records.length,
      recordsFingerprint};
    const evidence={id:'today-preview',schemaVersion:1,
      resetGeneration:generation,sourceInventory,sourceFingerprint,
      sourcePresent:raw!==null,dayCount,recordCount:records.length,
      recordsFingerprint,receiptId,capturedAtISO:nowIso()};
    let db,initialRows,initialEvidence,initialMeta,priorReceipt;
    try {
      db=await open();
      if (!db) return refuse('v2_unavailable');
      const tx=db.transaction(['todayDays','mutations','meta'],'readonly');
      const [rows,ev,meta,allReceipts]=await Promise.all([
        requestPromise(tx.objectStore('todayDays').getAll()),
        requestPromise(tx.objectStore('meta').get('today-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').getAll())
      ]);
      initialRows=rows;initialEvidence=ev;initialMeta=meta;
      priorReceipt=ev?allReceipts.find(x=>x?.id===ev.receiptId):null;
    } catch (_) { return refuse('today_preview_read_unavailable'); }
    if (!initialMeta || initialMeta.schemaVersion!==SCHEMA_VERSION
      || initialMeta.resetGeneration!==generation
      || initialMeta.legacyMissing===true)
      return refuse('pilot_meta_not_ready');
    const normalizedRows=rows=>rows.slice().sort((a,b)=>
      String(a.id).localeCompare(String(b.id)));
    if (initialEvidence) {
      if (initialEvidence.schemaVersion!==1
        || initialEvidence.resetGeneration!==generation
        || initialEvidence.sourceInventory!==sourceInventory
        || initialEvidence.sourceFingerprint!==sourceFingerprint
        || initialEvidence.sourcePresent!==(raw!==null)
        || initialEvidence.dayCount!==dayCount
        || initialEvidence.recordCount!==records.length
        || (initialEvidence.recordsFingerprint!==undefined
          && initialEvidence.recordsFingerprint!==recordsFingerprint)
        || !priorReceipt || priorReceipt.id!==initialEvidence.receiptId
        || priorReceipt.type!=='today-preview-seed'
        || priorReceipt.resetGeneration!==generation
        || priorReceipt.sourceInventory!==sourceInventory
        || priorReceipt.sourceFingerprint!==sourceFingerprint
        || priorReceipt.sourcePresent!==(raw!==null)
        || priorReceipt.dayCount!==dayCount
        || priorReceipt.recordCount!==records.length
        || (priorReceipt.recordsFingerprint!==undefined
          && priorReceipt.recordsFingerprint!==recordsFingerprint)
        || stableJson(normalizedRows(initialRows))
          !==stableJson(normalizedRows(records)))
        return refuse('today_preview_existing_evidence_preserved');
    } else if (initialRows.length) {
      return refuse('today_preview_orphaned_rows_preserved');
    }
    try { if (!sourceCurrent()) return refuse('legacy_today_changed_before_seed'); }
    catch (_) { return refuse('legacy_today_storage_unreadable'); }

    if (!initialEvidence) {
      let failure=null;
      const abort=(tx,reason)=>{failure=reason;try{tx.abort();}catch(_){}};
      try {
        const tx=db.transaction(['todayDays','mutations','meta'],'readwrite');
        const dayStore=tx.objectStore('todayDays');
        const mutationStore=tx.objectStore('mutations');
        const metaStore=tx.objectStore('meta');
        const reads=[dayStore.getAll(),metaStore.get('today-preview'),
          metaStore.get(RUNTIME_META_ID),mutationStore.get(receiptId)];
        const values=new Array(reads.length);
        let pending=reads.length;
        reads.forEach((request,index)=>{request.onsuccess=()=>{
          values[index]=request.result;
          if (--pending!==0) return;
          try {
            if (!sourceCurrent())
              return abort(tx,'legacy_today_changed_under_transaction');
            if (stableJson(values[0])!==stableJson(initialRows)
              || stableJson(values[1])!==stableJson(initialEvidence)
              || stableJson(values[2])!==stableJson(initialMeta)
              || values[3])
              return abort(tx,'today_preview_concurrent_change');
            for (const record of records) dayStore.add(record);
            mutationStore.add(receipt);
            metaStore.add(evidence);
          } catch (_) { abort(tx,'today_preview_atomic_seed_failed'); }
        };});
        await transactionPromise(tx);
      } catch (_) { return refuse(failure||'today_preview_atomic_seed_failed'); }
    }

    // Re-read all record rows, receipt, and metadata in one transaction.
    // Any V1 edit during readback is reported as uncertain, not safe parity.
    try {
      const tx=db.transaction(['todayDays','mutations','meta'],'readonly');
      const [rows,storedEvidence,storedMeta,storedReceipt]=await Promise.all([
        requestPromise(tx.objectStore('todayDays').getAll()),
        requestPromise(tx.objectStore('meta').get('today-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').get(
          initialEvidence?initialEvidence.receiptId:receiptId))
      ]);
      if (stableJson(normalizedRows(rows))!==stableJson(normalizedRows(records))
        || stableJson(storedEvidence)!==stableJson(initialEvidence||evidence)
        || stableJson(storedMeta)!==stableJson(initialMeta)
        || stableJson(storedReceipt)!==stableJson(
          initialEvidence?{
            id:initialEvidence.receiptId,type:'today-preview-seed',
            resetGeneration:generation,sourceInventory,sourceFingerprint,
            sourcePresent:raw!==null,dayCount,recordCount:records.length,
            ...(initialEvidence.recordsFingerprint===undefined?{}
              :{recordsFingerprint:initialEvidence.recordsFingerprint})
          }:receipt))
        return refuse('today_preview_readback_unverified',{
          committed:!initialEvidence,writeOutcomeUncertain:true
        });
      if (!sourceCurrent()) return refuse('legacy_today_changed_after_seed',{
        committed:!initialEvidence,confirmedDurable:true,writeOutcomeUncertain:true
      });
      return {
        checked:true,previewOnly:true,committed:!initialEvidence,
        confirmedDurable:true,collectionParityVerified:true,
        todayMigrated:false,dayCount,recordCount:records.length,
        reason:initialEvidence?'today_preview_already_verified'
          :'today_preview_seed_verified',
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    } catch (_) { return refuse('today_preview_readback_unavailable',{
      committed:!initialEvidence,writeOutcomeUncertain:true
    }); }
  }

  // Developer-only targeted Today read proof. Consults one V2 day row and
  // the root/provenance rows with IDB get(), not todayDays.getAll(). This is
  // NOT a production read: V1 is parsed and verified as the source of truth.
  async function inspectPreviewTodayDayRecord(dayKey) {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,targetDayVerified:false,
      recordPresent:false,collectionParityVerified:false,
      todayMigrated:false,canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(typeof dayKey!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(dayKey))
      return refuse('today_day_key_invalid');
    try{
      if(new Date(dayKey+'T00:00:00.000Z').toISOString().slice(0,10)!==dayKey)
        return refuse('today_day_key_invalid');
    }catch(_){return refuse('today_day_key_invalid');}
    const generation=currentGeneration({create:false}),epoch=darkMirrorModeEpoch;
    if(!generation)return refuse('generation_unavailable');
    let source;
    try{
      source=await capturePreviewTodaySource();
      if(source.reason)return refuse('today_source_preflight_required',{
        prerequisiteReason:source.prerequisiteReason||source.reason
      });
    }catch(_){return refuse('legacy_today_storage_unreadable');}
    const current=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&darkMirrorModeEpoch===epoch
      &&currentGeneration({create:false})===generation
      &&captureReadOnlyFullStorageInventory()===source.inventory;
    try{if(!current())return refuse('today_source_changed_before_day_read');}
    catch(_){return refuse('legacy_today_storage_unreadable');}
    const expectedRoot=source.records[0];
    const expectedDay=source.records.find(row=>row.id==='day:'+dayKey);
    let db,evidence;
    try{
      db=await open();
      if(!db)return refuse('v2_unavailable');
      evidence=await requestPromise(db.transaction('meta','readonly')
        .objectStore('meta').get('today-preview'));
    }catch(_){return refuse('today_day_evidence_unavailable');}
    if(!evidence)return refuse('today_preview_seed_required');
    if(evidence.id!=='today-preview'||evidence.schemaVersion!==1
      ||evidence.resetGeneration!==generation
      ||evidence.sourceInventory!==fnv1a(source.inventory)+':'+source.inventory.length
      ||evidence.sourceFingerprint!==source.sourceFingerprint
      ||evidence.sourcePresent!==(source.raw!==null)
      ||evidence.dayCount!==source.dayCount
      ||evidence.recordCount!==source.records.length)
      return refuse('today_preview_source_stale');
    if(typeof evidence.recordsFingerprint!=='string'
      ||!/^sha256:[0-9a-f]{64}:\d+$/.test(evidence.recordsFingerprint))
      return refuse('today_preview_row_seal_required');
    if(typeof evidence.receiptId!=='string'||!evidence.receiptId.startsWith('today-preview-'))
      return refuse('today_preview_receipt_invalid');
    const read=async()=>{
      // Queue every request before awaiting: iPhone Safari can close an
      // IndexedDB transaction between separate asynchronous get() calls.
      const tx=db.transaction(['todayDays','meta','mutations'],'readonly');
      const completed=transactionPromise(tx);
      const values=await Promise.all([
        requestPromise(tx.objectStore('todayDays').get('root')),
        requestPromise(tx.objectStore('todayDays').get('day:'+dayKey)),
        requestPromise(tx.objectStore('meta').get('today-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').get(evidence.receiptId)),
        completed
      ]);
      return values.slice(0,5);
    };
    let first,second;
    try{first=await read();}
    catch(_){return refuse('today_day_record_read_unavailable');}
    const [root,record,storedEvidence,meta,receipt]=first;
    if(!meta||meta.schemaVersion!==SCHEMA_VERSION
      ||meta.resetGeneration!==generation||meta.legacyMissing===true)
      return refuse('pilot_meta_not_ready');
    if(stableJson(storedEvidence)!==stableJson(evidence))
      return refuse('today_day_evidence_changed');
    if(!receipt||receipt.id!==evidence.receiptId
      ||!['today-preview-seed','today-preview-reconcile',
        'today-preview-seal'].includes(receipt.type)
      ||receipt.resetGeneration!==generation
      ||receipt.sourceInventory!==evidence.sourceInventory
      ||receipt.sourceFingerprint!==evidence.sourceFingerprint
      ||receipt.sourcePresent!==evidence.sourcePresent
      ||receipt.dayCount!==evidence.dayCount
      ||receipt.recordCount!==evidence.recordCount
      ||receipt.recordsFingerprint!==evidence.recordsFingerprint)
      return refuse('today_preview_receipt_invalid');
    // Both the root and selected day must equal the V1 projection,
    // including absent-vs-empty map entries and unknown root fields.
    if(stableJson(root)!==stableJson(expectedRoot))
      return refuse('today_day_root_mismatch');
    if(stableJson(record)!==stableJson(expectedDay))
      return refuse('today_day_record_mismatch');
    try{
      if(!current())return refuse('today_source_changed_during_day_read');
      second=await read();
      if(stableJson(second)!==stableJson(first))
        return refuse('today_day_changed_during_read');
      if(!current())return refuse('today_source_changed_after_day_read');
    }catch(_){return refuse('today_day_readback_unavailable');}
    return {
      checked:true,previewOnly:true,targetDayVerified:true,
      recordPresent:!!expectedDay,sourceDayPresent:!!expectedDay,
      // A targeted record check cannot rule out extra or corrupt day
      // rows elsewhere. Neither write authority nor full parity follows.
      collectionParityVerified:false,todayMigrated:false,
      reason:expectedDay?'today_day_record_verified':'today_day_absence_verified',
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only'
    };
  }


  // Explicit, isolated Today compatibility projection: reconstruct the
  // old sparse document IN MEMORY from verified V2 day records.
  async function buildPreviewTodayCompatibilitySnapshot() {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,snapshotBuilt:false,
      fullCollectionCompared:false,previewEvidenceChainVerified:false,
      independentRecoveryVerified:false,offDeviceBackupVerified:false,
      canRestore:false,
      todayMigrated:false,canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    let source;
    try{
      source=await capturePreviewTodaySource();
      if(source.reason)return refuse('today_source_preflight_required',{
        prerequisiteReason:source.prerequisiteReason||source.reason
      });
    }catch(_){return refuse('today_source_unavailable');}
    const current=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&darkMirrorModeEpoch===epoch
      &&currentGeneration({create:false})===generation
      &&captureReadOnlyFullStorageInventory()===source.inventory;
    try{if(!current())return refuse('today_source_changed_before_rebuild');}
    catch(_){return refuse('today_source_unavailable');}
    // Targeted day parity cannot exclude unexpected rows or broken
    // ancestry: require full V1/V2 parity AND independent receipt proof.
    const parity=await inspectPreviewTodayCollectionParity();
    if(!parity.match)return refuse('today_collection_parity_required',{
      prerequisiteReason:parity.reason
    });
    const recovery=await inspectPreviewTodayRecoveryEvidence();
    if(!recovery.evidenceVerified)
      return refuse('today_recovery_evidence_required',{
        prerequisiteReason:recovery.reason
      });
    try{if(!current())return refuse('today_source_changed_before_rebuild');}
    catch(_){return refuse('today_source_unavailable');}
    let db;
    try{
      db=await open();
      if(!db)return refuse('v2_unavailable');
    }catch(_){return refuse('today_rebuild_database_unavailable');}
    const read=async()=>{
      const tx=db.transaction(['todayDays','meta','mutations'],'readonly');
      const completed=transactionPromise(tx);
      // Queue all reads before awaiting to accommodate Safari IDB.
      const values=await Promise.all([
        requestPromise(tx.objectStore('todayDays').getAll()),
        requestPromise(tx.objectStore('meta').get('today-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').getAll()),
        completed
      ]);
      return values.slice(0,4);
    };
    let first;
    try{first=await read();}
    catch(_){return refuse('today_rebuild_read_unavailable');}
    const [rows,evidence,meta,receipts]=first;
    if(!meta||meta.schemaVersion!==SCHEMA_VERSION
      ||meta.resetGeneration!==generation||meta.legacyMissing===true)
      return refuse('pilot_meta_not_ready');
    if(!evidence||evidence.id!=='today-preview'
      ||evidence.resetGeneration!==generation
      ||evidence.sourceInventory!==fnv1a(source.inventory)+':'+source.inventory.length
      ||evidence.sourceFingerprint!==source.sourceFingerprint
      ||evidence.recordCount!==source.records.length
      ||evidence.dayCount!==source.dayCount
      ||evidence.sourcePresent!==(source.raw!==null))
      return refuse('today_rebuild_source_stale');
    const head=receipts.find(r=>r.id===evidence.receiptId);
    if(!head||head.recordsFingerprint!==evidence.recordsFingerprint
      ||head.resetGeneration!==generation)
      return refuse('today_rebuild_receipt_changed');
    if(rows.length!==source.records.length)
      return refuse('today_rebuild_row_count_mismatch');
    const sorted=items=>items.slice().sort((a,b)=>
      String(a.id).localeCompare(String(b.id)));
    if(stableJson(sorted(rows))!==stableJson(sorted(source.records)))
      return refuse('today_rebuild_row_mismatch');
    const fields=['tasksByDay','notesByDay','selectedHabitIdsByDay','orderByDay'];
    const root=rows.find(row=>row.id==='root');
    if(!root||!Array.isArray(root.presentMaps)
      ||root.presentMaps.some(field=>!fields.includes(field))
      ||new Set(root.presentMaps).size!==root.presentMaps.length
      ||!root.value||typeof root.value!=='object'
      ||Array.isArray(root.value))
      return refuse('today_rebuild_root_invalid');
    try{
      const document={};
      // Explicit property definition preserves literal "__proto__" keys
      // from older imported payloads without modifying prototypes.
      const put=(object,key,value)=>Object.defineProperty(object,key,{
        value:clone(value),enumerable:true,writable:true,configurable:true
      });
      for(const [key,value] of Object.entries(root.value))
        put(document,key,value);
      for(const field of root.presentMaps){
        const days={};
        for(const row of rows){
          if(row.id==='root')continue;
          if(!/^day:\d{4}-\d{2}-\d{2}$/.test(row.id)
            ||row.dayKey!==row.id.slice(4))throw Error('invalid_day_row');
          if(Object.prototype.hasOwnProperty.call(row.value,field))
            put(days,row.dayKey,row.value[field]);
        }
        put(document,field,days);
      }
      const original=source.raw===null?{}:JSON.parse(source.raw);
      if(stableJson(document)!==stableJson(original))
        return refuse('today_rebuild_legacy_roundtrip_mismatch');
      // The legacy provenance SHA covers JSON.stringify's insertion order.
      // V2 day records are intentionally grouped differently, so compare
      // *canonical semantic bytes* rather than confusing key order with a
      // missing field. The original V1 SHA remains checked against evidence.
      const originalProof=await previewRecoveryFingerprint(stableJson(original));
      const rebuiltProof=await previewRecoveryFingerprint(stableJson(document));
      if(rebuiltProof!==originalProof)
        return refuse('today_rebuild_canonical_fingerprint_mismatch');
      const rowProof=await previewRecoveryFingerprint(sorted(rows));
      if(rowProof!==evidence.recordsFingerprint)
        return refuse('today_rebuild_row_fingerprint_mismatch');
      if(!current())return refuse('today_source_changed_during_rebuild');
      const reread=await read();
      if(stableJson(reread)!==stableJson(first))
        return refuse('today_rebuild_changed_during_readback');
      if(!current())return refuse('today_source_changed_after_rebuild');
      return {
        checked:true,previewOnly:true,snapshotBuilt:true,
        fullCollectionCompared:true,previewEvidenceChainVerified:true,
        independentRecoveryVerified:false,offDeviceBackupVerified:false,
        canRestore:false,
        sourcePresent:source.raw!==null,dayCount:source.dayCount,
        // This is a Today-only preview, NOT a restorable whole-app
        // backup, deployed read path or authority transfer.
        previewSnapshot:document,
        todayMigrated:false,reason:'today_preview_compatibility_rebuilt',
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    }catch(_){return refuse('today_rebuild_validation_unavailable');}
  }


  // DEV PREVIEW ONLY: reconstruct the Today document from sealed V2 records
  // even if the independent V1 Today localStorage key is no longer readable.
  // This never rewrites that key or authorizes restoration / read promotion.
  async function buildPreviewTodayDetachedRecoveryCandidate() {
    const refuse=(reason,extra={})=>({
      checked:true,previewOnly:true,candidateBuilt:false,
      v2ReceiptChainVerified:false,legacyTodaySourceRead:false,
      v1SourceCompared:false,independentRecoveryVerified:false,
      offDeviceBackupVerified:false,canRestore:false,todayMigrated:false,
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...extra
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const current=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&darkMirrorModeEpoch===epoch
      &&currentGeneration({create:false})===generation;
    // Only the V2 record seal + complete immutable receipt chain are
    // authoritative here; never read taskpoints_today_view_v1.
    const firstProof=await inspectPreviewTodayRecoveryEvidence();
    if(!firstProof.evidenceVerified)
      return refuse('today_detached_evidence_required',{
        prerequisiteReason:firstProof.reason
      });
    if(!current())return refuse('today_detached_generation_changed');
    let db;
    try{
      db=await open();
      if(!db)return refuse('v2_unavailable');
    }catch(_){return refuse('today_detached_database_unavailable');}
    const read=async()=>{
      const tx=db.transaction(['todayDays','mutations','meta'],'readonly');
      const completed=transactionPromise(tx);
      // Queue requests before any await: WebKit may deactivate a
      // transaction when promises yield between IDB requests.
      const all=await Promise.all([
        requestPromise(tx.objectStore('todayDays').getAll()),
        requestPromise(tx.objectStore('meta').get('today-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').getAll()),
        completed
      ]);
      return all.slice(0,4);
    };
    let first;
    try{first=await read();}
    catch(_){return refuse('today_detached_read_unavailable');}
    const [rows,evidence,meta,receipts]=first;
    if(!meta||meta.schemaVersion!==SCHEMA_VERSION
      ||meta.resetGeneration!==generation||meta.legacyMissing===true)
      return refuse('pilot_meta_not_ready');
    if(!evidence||evidence.id!=='today-preview'
      ||evidence.schemaVersion!==1||evidence.resetGeneration!==generation
      ||evidence.recordCount!==rows.length
      ||evidence.dayCount!==rows.length-1
      ||typeof evidence.sourcePresent!=='boolean'
      ||typeof evidence.recordsFingerprint!=='string')
      return refuse('today_detached_evidence_changed');
    const head=receipts.find(r=>r?.id===evidence.receiptId);
    if(!head||head.resetGeneration!==generation
      ||head.recordsFingerprint!==evidence.recordsFingerprint
      ||head.sourceFingerprint!==evidence.sourceFingerprint
      ||head.sourceInventory!==evidence.sourceInventory)
      return refuse('today_detached_receipt_changed');
    const ordered=rows.slice().sort((a,b)=>
      String(a?.id).localeCompare(String(b?.id)));
    let rebuilt;
    try{
      const digest=await previewRecoveryFingerprint(ordered);
      if(digest!==evidence.recordsFingerprint)
        return refuse('today_detached_rows_changed');
      const fields=['tasksByDay','notesByDay',
        'selectedHabitIdsByDay','orderByDay'];
      const root=ordered.find(r=>r?.id==='root');
      if(!root||!root.value||typeof root.value!=='object'
        ||Array.isArray(root.value)||!Array.isArray(root.presentMaps)
        ||root.presentMaps.length!==new Set(root.presentMaps).size
        ||root.presentMaps.some(x=>!fields.includes(x))
        ||stableJson(root.presentMaps)!==stableJson(
          fields.filter(x=>root.presentMaps.includes(x))))
        return refuse('today_detached_root_invalid');
      if(!evidence.sourcePresent&&(ordered.length!==1
        ||root.presentMaps.length||Object.keys(root.value).length))
        return refuse('today_detached_absent_source_mismatch');
      rebuilt={};
      const define=(obj,key,value)=>Object.defineProperty(obj,key,{
        value:clone(value),enumerable:true,writable:true,configurable:true
      });
      for(const [key,value] of Object.entries(root.value)){
        if(fields.includes(key))
          return refuse('today_detached_root_invalid');
        define(rebuilt,key,value);
      }
      const maps=new Map(root.presentMaps.map(field=>[field,{}]));
      const ids=new Set();
      for(const row of ordered){
        if(!row||typeof row.id!=='string'||ids.has(row.id))
          return refuse('today_detached_row_invalid');
        ids.add(row.id);
        if(row.id==='root')continue;
        if(!/^day:\d{4}-\d{2}-\d{2}$/.test(row.id)
          ||row.dayKey!==row.id.slice(4)
          ||!row.value||typeof row.value!=='object'
          ||Array.isArray(row.value)||Object.keys(row.value).length===0)
          return refuse('today_detached_row_invalid');
        for(const [field,value] of Object.entries(row.value)){
          if(!maps.has(field)||!Array.isArray(value))
            return refuse('today_detached_day_map_invalid');
          define(maps.get(field),row.dayKey,value);
        }
      }
      if(ids.size!==evidence.recordCount)
        return refuse('today_detached_row_count_mismatch');
      for(const field of root.presentMaps)
        define(rebuilt,field,maps.get(field));
      // Verify the candidate can be serialized without any hidden
      // normalization or loss of unknown JSON fields.
      if(stableJson(JSON.parse(JSON.stringify(rebuilt)))
        !==stableJson(rebuilt))
        return refuse('today_detached_json_roundtrip_mismatch');
      if(!current())return refuse('today_detached_generation_changed');
      // A second proof catches edits to historical receipts between the
      // first chain audit and the in-memory candidate construction.
      const nextProof=await inspectPreviewTodayRecoveryEvidence();
      if(!nextProof.evidenceVerified)
        return refuse('today_detached_evidence_changed',{
          prerequisiteReason:nextProof.reason
        });
      if(!current())return refuse('today_detached_generation_changed');
      const second=await read();
      if(stableJson(second)!==stableJson(first))
        return refuse('today_detached_records_changed_during_readback');
      if(!current())return refuse('today_detached_generation_changed');
    }catch(_){return refuse('today_detached_validation_unavailable');}
    return {
      ...refuse('today_detached_candidate_verified'),
      candidateBuilt:true,v2ReceiptChainVerified:true,
      sourcePresent:evidence.sourcePresent,dayCount:evidence.dayCount,
      previewSnapshot:rebuilt
    };
  }


  // Developer-only, read-only recovery package for a fresh SANDBOX origin.
  // The package can be inspected/validated elsewhere; this app does not
  // import it, write V1 keys or automatically promote any storage.
  async function preparePreviewTodayDetachedRestorePackage() {
    const refuse=(reason,extra={})=>({
      checked:true,previewOnly:true,packagePrepared:false,
      sourceReadAuthority:'legacy_only',readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',todayMigrated:false,
      independentRecoveryVerified:false,offDeviceBackupVerified:false,
      canApply:false,canRestore:false,canPromote:false,
      reason,...extra
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const current=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&darkMirrorModeEpoch===epoch
      &&currentGeneration({create:false})===generation;
    let first;
    try{first=await buildPreviewTodayDetachedRecoveryCandidate();}
    catch(_){return refuse('today_package_candidate_unavailable');}
    if(!first.candidateBuilt||!first.v2ReceiptChainVerified
      ||first.canRestore!==false)
      return refuse('today_package_candidate_required',{
        prerequisiteReason:first.reason
      });
    if(!current())return refuse('today_package_generation_changed');
    let serialized,sha;
    try{
      serialized=JSON.stringify(first.previewSnapshot);
      if(typeof serialized!=='string'||serialized.length>1048576
        ||stableJson(JSON.parse(serialized))
          !==stableJson(first.previewSnapshot))
        return refuse('today_package_json_invalid');
      sha=await previewRecoveryFingerprint({
        schemaVersion:1,sourcePresent:first.sourcePresent,serialized
      });
    }catch(_){return refuse('today_package_digest_unavailable');}
    if(!current())return refuse('today_package_generation_changed');
    // A generation-safe second reconstruction catches a preview edit that
    // occurs while hashing. No source localStorage Today key is read.
    let second;
    try{second=await buildPreviewTodayDetachedRecoveryCandidate();}
    catch(_){return refuse('today_package_second_read_unavailable');}
    if(!second.candidateBuilt||second.sourcePresent!==first.sourcePresent
      ||stableJson(second.previewSnapshot)!==stableJson(first.previewSnapshot))
      return refuse('today_package_source_changed');
    if(!current())return refuse('today_package_generation_changed');
    return {
      ...refuse('today_detached_restore_package_prepared'),
      packagePrepared:true,
      // Explicit absence means an isolated test target should have NO
      // Today key. Writing "{}" would change absent-source semantics.
      recoveryPackage:{
        schemaVersion:1,sourcePresent:first.sourcePresent,
        serialized,sha256:sha
      }
    };
  }

  // Independent, read-only Today source vs record-level V2 proof. The V1
  // Today page keeps complete write/read authority even on a green result.
  async function inspectPreviewTodayCollectionParity() {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,match:false,todayMigrated:false,
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    const generation=currentGeneration({create:false});
    if (!generation) return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    let captured;
    try {
      captured=await capturePreviewTodaySource();
      if (captured.reason) return refuse('today_source_preflight_required',{
        prerequisiteReason:captured.prerequisiteReason||captured.reason
      });
    } catch (_) { return refuse('legacy_today_storage_unreadable'); }
    const current=()=>isDarkEnabled() && epoch===darkMirrorModeEpoch
      && currentGeneration({create:false})===generation
      && captureReadOnlyFullStorageInventory()===captured.inventory;
    try { if (!current()) return refuse('legacy_today_changed_before_parity'); }
    catch (_) { return refuse('legacy_today_storage_unreadable'); }
    let db,rows,evidence,meta,receipts;
    try {
      db=await open();
      if (!db) return refuse('v2_unavailable');
      const tx=db.transaction(['todayDays','mutations','meta'],'readonly');
      [rows,evidence,meta,receipts]=await Promise.all([
        requestPromise(tx.objectStore('todayDays').getAll()),
        requestPromise(tx.objectStore('meta').get('today-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').getAll())
      ]);
    } catch (_) { return refuse('today_preview_read_unavailable'); }
    try {
      if (!current()) return refuse('legacy_today_changed_during_parity');
      if (!meta || meta.schemaVersion!==SCHEMA_VERSION
        || meta.resetGeneration!==generation || meta.legacyMissing===true)
        return refuse('pilot_meta_not_ready');
      if (!evidence) return refuse('today_preview_seed_required');
      if (evidence.schemaVersion!==1 || evidence.resetGeneration!==generation
        || evidence.sourceInventory!==fnv1a(captured.inventory)+':'+captured.inventory.length
        || evidence.sourceFingerprint!==captured.sourceFingerprint
        || evidence.sourcePresent!==(captured.raw!==null)
        || evidence.dayCount!==captured.dayCount
        || evidence.recordCount!==captured.records.length)
        return refuse('today_preview_source_stale');
      const normalized=rs=>rs.slice().sort((a,b)=>
        String(a.id).localeCompare(String(b.id)));
      if (stableJson(normalized(rows))!==stableJson(normalized(captured.records)))
        return refuse('today_preview_record_mismatch',{
          expectedCount:captured.records.length,actualCount:rows.length
        });
      const receipt=receipts.find(x=>x?.id===evidence.receiptId);
      if (!receipt || receipt.id!==evidence.receiptId
        || !['today-preview-seed','today-preview-reconcile',
          'today-preview-seal'].includes(receipt.type)
        || receipt.resetGeneration!==generation
        || receipt.sourceInventory!==evidence.sourceInventory
        || receipt.sourceFingerprint!==evidence.sourceFingerprint
        || receipt.sourcePresent!==evidence.sourcePresent
        || receipt.dayCount!==evidence.dayCount
        || receipt.recordCount!==evidence.recordCount
        || (evidence.recordsFingerprint!==undefined
          && evidence.recordsFingerprint!==receipt.recordsFingerprint))
        return refuse('today_preview_receipt_invalid');
      if (receipt.type==='today-preview-reconcile'
        || receipt.type==='today-preview-seal') {
        const parent=receipts.find(row=>row?.id===receipt.priorReceiptId);
        if (!parent || parent.id===receipt.id
          || !['today-preview-seed','today-preview-reconcile',
            'today-preview-seal'].includes(parent.type)
          || parent.resetGeneration!==generation
          || receipt.priorFingerprint!==parent.sourceFingerprint
          || receipt.priorRecordsFingerprint!==parent.recordsFingerprint
          || receipt.priorCount!==parent.recordCount
          || receipt.priorDayCount!==parent.dayCount)
          return refuse('today_preview_receipt_chain_invalid');
      }
      // Authenticate the entire stored snapshot, not only the source
      // metadata. A synthetic V2-only edit must never be misreported as
      // a successful V1 parity check.
      if (evidence.recordsFingerprint!==undefined) {
        const actualRowsFingerprint=await previewRecoveryFingerprint(normalized(rows));
        if (actualRowsFingerprint!==evidence.recordsFingerprint)
          return refuse('today_preview_rows_fingerprint_invalid');
      }
      // An asynchronous digest leaves a window for a second preview tab
      // to commit. Freshly verify the V2 rows, receipt and meta after it.
      const freshTx=db.transaction(['todayDays','mutations','meta'],'readonly');
      const [freshRows,freshEvidence,freshMeta,freshReceipt]=await Promise.all([
        requestPromise(freshTx.objectStore('todayDays').getAll()),
        requestPromise(freshTx.objectStore('meta').get('today-preview')),
        requestPromise(freshTx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(freshTx.objectStore('mutations').get(evidence.receiptId))
      ]);
      if (stableJson(normalized(freshRows))!==stableJson(normalized(rows))
        || stableJson(freshEvidence)!==stableJson(evidence)
        || stableJson(freshMeta)!==stableJson(meta)
        || stableJson(freshReceipt)!==stableJson(receipt))
        return refuse('today_preview_changed_during_parity');
      if (!current()) return refuse('legacy_today_changed_after_parity');
      return {
        checked:true,previewOnly:true,match:true,todayMigrated:false,
        dayCount:captured.dayCount,recordCount:captured.records.length,
        hasSourceKey:captured.raw!==null,
        reason:'today_preview_parity_verified',
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    } catch (_) { return refuse('today_preview_parity_unreadable'); }
  }

  // One-time PREVIEW ONLY provenance upgrade for Today previews created
  // before the stored-row SHA seal existed. It only runs while V1 is
  // unchanged and a full independent V1/V2 parity proof is still possible.
  // The original seed receipt is preserved; no historical day row is edited.
  async function rehearsePreviewTodayRowSeal(sourceToken,actionId) {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,committed:false,confirmedDurable:false,
      collectionParityVerified:false,todayMigrated:false,
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof sourceToken!=='string' || !sourceToken)
      return refuse('full_origin_token_required');
    if (typeof actionId!=='string' || !actionId || actionId.length>128)
      return refuse('today_preview_action_id_required');
    const generation=currentGeneration({create:false});
    if (!generation) return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const sourceCurrent=()=>isDarkEnabled()
      && epoch===darkMirrorModeEpoch
      && currentGeneration({create:false})===generation
      && captureReadOnlyFullStorageInventory()===sourceToken;
    let source;
    try {
      if (!sourceCurrent()) return refuse('full_origin_changed');
      source=await capturePreviewTodaySource();
      if (source.reason) return refuse(source.reason,{
        prerequisiteReason:source.prerequisiteReason
      });
      if (source.inventory!==sourceToken || !sourceCurrent())
        return refuse('legacy_today_changed_during_capture');
    } catch (_) { return refuse('legacy_today_storage_unreadable'); }
    const proof=await inspectPreviewTodayCollectionParity();
    if (!proof.match)
      return refuse('today_preview_seal_parity_required',{
        prerequisiteReason:proof.reason
      });
    try { if (!sourceCurrent()) return refuse('legacy_today_changed_before_seal'); }
    catch (_) { return refuse('legacy_today_storage_unreadable'); }
    let db,rows,evidence,runtimeMeta,seedReceipt,actionReceipt;
    const receiptId='today-preview-seal:'+actionId;
    try {
      db=await open();
      if (!db) return refuse('v2_unavailable');
      const tx=db.transaction(['todayDays','mutations','meta'],'readonly');
      const [storedRows,ev,meta,allReceipts]=await Promise.all([
        requestPromise(tx.objectStore('todayDays').getAll()),
        requestPromise(tx.objectStore('meta').get('today-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').getAll())
      ]);
      rows=storedRows;evidence=ev;runtimeMeta=meta;
      seedReceipt=allReceipts.find(x=>x?.id===ev?.receiptId);
      actionReceipt=allReceipts.find(x=>x?.id===receiptId);
    } catch (_) { return refuse('today_preview_seal_read_unavailable'); }
    if (!runtimeMeta || runtimeMeta.schemaVersion!==SCHEMA_VERSION
      || runtimeMeta.resetGeneration!==generation
      || runtimeMeta.legacyMissing===true)
      return refuse('pilot_meta_not_ready');
    if (!evidence) return refuse('today_preview_seed_required');
    if (actionReceipt) return refuse('today_preview_action_id_conflict');
    if (typeof evidence.recordsFingerprint==='string') {
      return {
        checked:true,previewOnly:true,committed:false,confirmedDurable:true,
        collectionParityVerified:true,todayMigrated:false,
        reason:'today_preview_row_seal_already_verified',
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    }
    if (evidence.recordsFingerprint!==undefined
      || evidence.schemaVersion!==1
      || evidence.resetGeneration!==generation
      || evidence.sourceFingerprint!==source.sourceFingerprint
      || evidence.sourceInventory!==fnv1a(sourceToken)+':'+sourceToken.length
      || evidence.sourcePresent!==(source.raw!==null)
      || evidence.dayCount!==source.dayCount
      || evidence.recordCount!==source.records.length
      || !seedReceipt || seedReceipt.type!=='today-preview-seed'
      || seedReceipt.resetGeneration!==generation
      || seedReceipt.sourceFingerprint!==evidence.sourceFingerprint
      || seedReceipt.sourceInventory!==evidence.sourceInventory
      || seedReceipt.sourcePresent!==evidence.sourcePresent
      || seedReceipt.dayCount!==evidence.dayCount
      || seedReceipt.recordCount!==evidence.recordCount
      || seedReceipt.recordsFingerprint!==undefined)
      return refuse('today_preview_seal_existing_provenance_invalid');
    const normalized=all=>all.slice().sort((a,b)=>
      String(a.id).localeCompare(String(b.id)));
    if (stableJson(normalized(rows))!==stableJson(normalized(source.records)))
      return refuse('today_preview_seal_existing_records_invalid');
    let fingerprint;
    try {
      fingerprint=await previewRecoveryFingerprint(normalized(rows));
      if (!sourceCurrent()) return refuse('legacy_today_changed_during_seal_digest');
    } catch (_) { return refuse('today_preview_seal_digest_unavailable'); }
    const sealReceipt={
      id:receiptId,type:'today-preview-seal',
      resetGeneration:generation,sourceInventory:evidence.sourceInventory,
      sourceFingerprint:evidence.sourceFingerprint,
      sourcePresent:evidence.sourcePresent,dayCount:evidence.dayCount,
      recordCount:evidence.recordCount,recordsFingerprint:fingerprint,
      priorReceiptId:evidence.receiptId,
      priorFingerprint:seedReceipt.sourceFingerprint,
      priorCount:seedReceipt.recordCount,
      priorDayCount:seedReceipt.dayCount
    };
    const newEvidence={
      ...evidence,recordsFingerprint:fingerprint,
      receiptId,capturedAtISO:nowIso()
    };
    let failure=null;
    const abort=(tx,reason)=>{failure=reason;try{tx.abort();}catch(_){}};
    try {
      if (!sourceCurrent()) return refuse('legacy_today_changed_before_seal_write');
      const tx=db.transaction(['todayDays','mutations','meta'],'readwrite');
      const dayStore=tx.objectStore('todayDays');
      const metaStore=tx.objectStore('meta');
      const mutationStore=tx.objectStore('mutations');
      const requests=[
        dayStore.getAll(),metaStore.get('today-preview'),
        metaStore.get(RUNTIME_META_ID),
        mutationStore.get(evidence.receiptId),
        mutationStore.get(receiptId)
      ];
      const values=new Array(requests.length);
      let remaining=requests.length;
      requests.forEach((request,index)=>{request.onsuccess=()=>{
        values[index]=request.result;
        if (--remaining!==0) return;
        try {
          if (!sourceCurrent())
            return abort(tx,'legacy_today_changed_under_seal_transaction');
          if (stableJson(values[0])!==stableJson(rows)
            || stableJson(values[1])!==stableJson(evidence)
            || stableJson(values[2])!==stableJson(runtimeMeta)
            || stableJson(values[3])!==stableJson(seedReceipt)
            || values[4])
            return abort(tx,'today_preview_seal_concurrent_change');
          mutationStore.add(sealReceipt);
          metaStore.put(newEvidence);
        } catch (_) { abort(tx,'today_preview_seal_atomic_write_failed'); }
      };});
      await transactionPromise(tx);
    } catch (_) { return refuse(failure||'today_preview_seal_atomic_write_failed'); }
    try {
      const tx=db.transaction(['todayDays','mutations','meta'],'readonly');
      const [freshRows,freshEvidence,freshMeta,freshReceipt]=await Promise.all([
        requestPromise(tx.objectStore('todayDays').getAll()),
        requestPromise(tx.objectStore('meta').get('today-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').get(receiptId))
      ]);
      if (stableJson(normalized(freshRows))!==stableJson(normalized(rows))
        || stableJson(freshEvidence)!==stableJson(newEvidence)
        || stableJson(freshMeta)!==stableJson(runtimeMeta)
        || stableJson(freshReceipt)!==stableJson(sealReceipt))
        return refuse('today_preview_seal_readback_unverified',{
          committed:true,writeOutcomeUncertain:true
        });
      if (!sourceCurrent()) return refuse('legacy_today_changed_after_seal',{
        committed:true,confirmedDurable:true,writeOutcomeUncertain:true
      });
      const parity=await inspectPreviewTodayCollectionParity();
      if (!parity.match) return refuse('today_preview_seal_parity_unverified',{
        prerequisiteReason:parity.reason,
        committed:true,confirmedDurable:true,writeOutcomeUncertain:true
      });
      if (!sourceCurrent()) return refuse('legacy_today_changed_after_seal_parity',{
        committed:true,confirmedDurable:true,writeOutcomeUncertain:true
      });
      return {
        checked:true,previewOnly:true,committed:true,confirmedDurable:true,
        collectionParityVerified:true,todayMigrated:false,
        reason:'today_preview_row_sealed',
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    } catch (_) { return refuse('today_preview_seal_readback_unavailable',{
      committed:true,writeOutcomeUncertain:true
    }); }
  }


  // Inspect ONLY V2's saved Today data, without reading the legacy Today key.
  // Evidence verification does not authorize restores or production reads.
  async function inspectPreviewTodayRecoveryEvidence(){
    const refuse=reason=>({
      checked:true,previewOnly:true,evidenceVerified:false,
      sourceCompared:false,safeToRestore:false,todayMigrated:false,
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',reason
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    const generation=currentGeneration({create:false}),epoch=darkMirrorModeEpoch;
    if(!generation)return refuse('generation_unavailable');
    const stillCurrent=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&darkMirrorModeEpoch===epoch
      &&currentGeneration({create:false})===generation;
    const sha=x=>typeof x==='string'&&/^sha256:[0-9a-f]{64}:\d+$/.test(x);
    const inventory=x=>typeof x==='string'&&/^[0-9a-f]{8}:\d+$/.test(x);
    const count=(x,max)=>Number.isSafeInteger(x)&&x>=0&&x<=max;
    const fields=['tasksByDay','notesByDay','selectedHabitIdsByDay','orderByDay'];
    const read=async db=>{
      const tx=db.transaction(['todayDays','mutations','meta'],'readonly');
      const [rows,evidence,meta,all]=await Promise.all([
        requestPromise(tx.objectStore('todayDays').getAll()),
        requestPromise(tx.objectStore('meta').get('today-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').getAll())
      ]);
      return {rows,evidence,meta,receipts:all.filter(r=>
        typeof r?.id==='string'&&r.id.startsWith('today-preview-'))};
    };
    try{
      const db=await open();
      if(!db)return refuse('v2_unavailable');
      const saved=await read(db),{rows,evidence,meta,receipts}=saved;
      if(!meta||meta.schemaVersion!==SCHEMA_VERSION
        ||meta.resetGeneration!==generation||meta.legacyMissing===true)
        return refuse('pilot_meta_not_ready');
      if(!evidence||evidence.id!=='today-preview'
        ||evidence.schemaVersion!==1||evidence.resetGeneration!==generation
        ||!inventory(evidence.sourceInventory)||!sha(evidence.sourceFingerprint)
        ||typeof evidence.sourcePresent!=='boolean'
        ||!count(evidence.dayCount,4096)
        ||evidence.recordCount!==evidence.dayCount+1
        ||evidence.recordCount!==rows.length
        ||typeof evidence.receiptId!=='string')
        return refuse('today_preview_evidence_invalid');
      // Old unsealed V5 data is preserved, but cannot be independently proved.
      if(!sha(evidence.recordsFingerprint))
        return refuse('today_preview_row_seal_required');
      const root=rows.find(r=>r?.id==='root');
      if(!root||!root.value||typeof root.value!=='object'
        ||Array.isArray(root.value)||!Array.isArray(root.presentMaps)
        ||root.presentMaps.length!==new Set(root.presentMaps).size
        ||root.presentMaps.some(x=>!fields.includes(x))
        ||stableJson(root.presentMaps)!==stableJson(fields.filter(x=>
          root.presentMaps.includes(x)))
        ||Object.keys(root.value).some(x=>fields.includes(x)))
        return refuse('today_preview_root_invalid');
      if(!evidence.sourcePresent&&(rows.length!==1
        ||root.presentMaps.length||Object.keys(root.value).length))
        return refuse('today_preview_absent_source_invalid');
      const ordered=rows.slice().sort((a,b)=>
        String(a?.id).localeCompare(String(b?.id)));
      const ids=new Set(),days=new Set();
      for(const row of ordered){
        if(!row||typeof row.id!=='string'||ids.has(row.id)
          ||!row.value||typeof row.value!=='object'
          ||Array.isArray(row.value))
          return refuse('today_preview_rows_invalid');
        ids.add(row.id);
        if(row.id==='root')continue;
        if(!/^day:\d{4}-\d{2}-\d{2}$/.test(row.id)
          ||row.dayKey!==row.id.slice(4)||days.has(row.dayKey)
          ||Object.keys(row.value).length===0)
          return refuse('today_preview_rows_invalid');
        days.add(row.dayKey);
        for(const field of Object.keys(row.value))
          if(!root.presentMaps.includes(field)||!Array.isArray(row.value[field]))
            return refuse('today_preview_day_map_invalid');
      }
      if(ids.size!==evidence.recordCount||days.size!==evidence.dayCount)
        return refuse('today_preview_row_count_invalid');
      const fingerprint=await previewRecoveryFingerprint(ordered);
      if(fingerprint!==evidence.recordsFingerprint)
        return refuse('today_preview_rows_fingerprint_invalid');
      if(!receipts.length||receipts.length>2048)
        return refuse('today_preview_receipts_invalid');
      const byId=new Map();
      for(const receipt of receipts){
        if(!receipt||typeof receipt.id!=='string'||byId.has(receipt.id)
          ||!['today-preview-seed','today-preview-seal',
            'today-preview-reconcile'].includes(receipt.type)
          ||!receipt.id.startsWith(receipt.type+':')
          ||receipt.resetGeneration!==generation
          ||!inventory(receipt.sourceInventory)||!sha(receipt.sourceFingerprint)
          ||typeof receipt.sourcePresent!=='boolean'
          ||!count(receipt.dayCount,4096)
          ||receipt.recordCount!==receipt.dayCount+1)
          return refuse('today_preview_receipt_invalid');
        byId.set(receipt.id,receipt);
      }
      let receipt=byId.get(evidence.receiptId);
      if(!receipt||receipt.sourceInventory!==evidence.sourceInventory
        ||receipt.sourceFingerprint!==evidence.sourceFingerprint
        ||receipt.sourcePresent!==evidence.sourcePresent
        ||receipt.dayCount!==evidence.dayCount
        ||receipt.recordCount!==evidence.recordCount
        ||receipt.recordsFingerprint!==evidence.recordsFingerprint)
        return refuse('today_preview_head_receipt_invalid');
      const seen=new Set();
      while(receipt){
        if(seen.has(receipt.id))return refuse('today_preview_receipt_cycle');
        seen.add(receipt.id);
        if(receipt.type==='today-preview-seed'){
          if(receipt.priorReceiptId!==undefined
            ||receipt.priorFingerprint!==undefined
            ||receipt.priorRecordsFingerprint!==undefined)
            return refuse('today_preview_receipt_chain_invalid');
          break;
        }
        const parent=byId.get(receipt.priorReceiptId);
        if(!parent||parent.id===receipt.id
          ||receipt.priorFingerprint!==parent.sourceFingerprint
          ||receipt.priorCount!==parent.recordCount
          ||receipt.priorDayCount!==parent.dayCount)
          return refuse('today_preview_receipt_chain_invalid');
        if(receipt.type==='today-preview-reconcile'){
          if(receipt.priorRecordsFingerprint!==parent.recordsFingerprint
            ||!sha(receipt.recordsFingerprint)
            ||!Array.isArray(receipt.changedIds)
            ||!Array.isArray(receipt.deletedIds)
            ||receipt.changedIds.length+receipt.deletedIds.length>64
            ||new Set(receipt.changedIds).size!==receipt.changedIds.length
            ||new Set(receipt.deletedIds).size!==receipt.deletedIds.length
            ||receipt.changedIds.some(x=>typeof x!=='string'||!x)
            ||receipt.deletedIds.some(x=>typeof x!=='string'||!x))
            return refuse('today_preview_receipt_chain_invalid');
        }else if(receipt.type==='today-preview-seal'){
          if(parent.type!=='today-preview-seed'
            ||parent.recordsFingerprint!==undefined
            ||receipt.priorRecordsFingerprint!==undefined
            ||!sha(receipt.recordsFingerprint)
            ||receipt.sourceInventory!==parent.sourceInventory
            ||receipt.sourceFingerprint!==parent.sourceFingerprint
            ||receipt.sourcePresent!==parent.sourcePresent
            ||receipt.dayCount!==parent.dayCount
            ||receipt.recordCount!==parent.recordCount)
            return refuse('today_preview_receipt_chain_invalid');
        }
        receipt=parent;
      }
      if(seen.size!==receipts.length)
        return refuse('today_preview_orphan_receipts');
      if(!stillCurrent()||stableJson(await read(db))!==stableJson(saved)
        ||!stillCurrent())
        return refuse('today_preview_evidence_changed_during_inspection');
      return {...refuse('today_preview_recovery_evidence_verified'),
        evidenceVerified:true,dayCount:days.size,recordCount:rows.length,
        receiptCount:seen.size,sourcePresent:evidence.sourcePresent};
    }catch(_){return refuse('today_preview_recovery_unavailable');}
  }

  // Explicit PREVIEW ONLY: reconcile changed Today day rows after an
  // immutable seed. A whole-collection SHA proof binds existing rows to
  // the last receipt before any update or deletion is permitted.
  async function rehearsePreviewTodayCollectionReconcile(sourceToken,actionId) {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,committed:false,confirmedDurable:false,
      collectionParityVerified:false,todayMigrated:false,
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof sourceToken!=='string' || !sourceToken)
      return refuse('full_origin_token_required');
    if (typeof actionId!=='string' || !actionId || actionId.length>128)
      return refuse('today_preview_action_id_required');
    const generation=currentGeneration({create:false});
    if (!generation) return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const sourceCurrent=()=>isDarkEnabled()
      && epoch===darkMirrorModeEpoch
      && currentGeneration({create:false})===generation
      && captureReadOnlyFullStorageInventory()===sourceToken;
    let source;
    try {
      if (!sourceCurrent()) return refuse('full_origin_changed');
      source=await capturePreviewTodaySource();
      if (source.reason) return refuse(source.reason,{
        prerequisiteReason:source.prerequisiteReason
      });
      if (source.inventory!==sourceToken || !sourceCurrent())
        return refuse('legacy_today_changed_during_capture');
    } catch (_) { return refuse('legacy_today_storage_unreadable'); }
    const target=source.records;
    if (target.length>4097 || JSON.stringify(target).length>1258291)
      return refuse('today_preview_reconcile_source_too_large');
    const normalized=rows=>rows.slice().sort((a,b)=>
      String(a.id).localeCompare(String(b.id)));
    let nextRecordsFingerprint;
    try {
      nextRecordsFingerprint=await previewRecoveryFingerprint(normalized(target));
      if (!sourceCurrent()) return refuse('legacy_today_changed_after_target_digest');
    } catch (_) { return refuse('today_preview_target_digest_unavailable'); }
    const inventorySignature=fnv1a(sourceToken)+':'+sourceToken.length;
    const receiptId='today-preview-reconcile:'+actionId;
    let db,oldRows,oldEvidence,runtimeMeta,receipts;
    try {
      db=await open();
      if (!db) return refuse('v2_unavailable');
      const tx=db.transaction(['todayDays','mutations','meta'],'readonly');
      [oldRows,oldEvidence,runtimeMeta,receipts]=await Promise.all([
        requestPromise(tx.objectStore('todayDays').getAll()),
        requestPromise(tx.objectStore('meta').get('today-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').getAll())
      ]);
    } catch (_) { return refuse('today_preview_reconcile_read_unavailable'); }
    if (!runtimeMeta || runtimeMeta.schemaVersion!==SCHEMA_VERSION
      || runtimeMeta.resetGeneration!==generation
      || runtimeMeta.legacyMissing===true)
      return refuse('pilot_meta_not_ready');
    if (!oldEvidence) return refuse('today_preview_seed_required');
    if (receipts.some(row=>row?.id===receiptId))
      return refuse('today_preview_action_id_conflict');
    if (oldEvidence.schemaVersion!==1
      || oldEvidence.resetGeneration!==generation
      || oldEvidence.recordCount!==oldRows.length
      || oldEvidence.dayCount!==oldRows.length-1
      || typeof oldEvidence.sourceInventory!=='string'
      || typeof oldEvidence.sourceFingerprint!=='string'
      || typeof oldEvidence.sourcePresent!=='boolean'
      || typeof oldEvidence.receiptId!=='string'
      || !oldEvidence.receiptId)
      return refuse('today_preview_existing_provenance_invalid');
    // Earlier V5 previews had source-only fingerprints. Retain their
    // records unchanged and reject reconciliation rather than inventing
    // a row-integrity proof after the authoritative source has changed.
    if (typeof oldEvidence.recordsFingerprint!=='string')
      return refuse('today_preview_row_seal_required');
    const priorReceipt=receipts.find(row=>row?.id===oldEvidence.receiptId);
    if (!priorReceipt
      || !['today-preview-seed','today-preview-reconcile',
        'today-preview-seal'].includes(priorReceipt.type)
      || priorReceipt.resetGeneration!==generation
      || priorReceipt.sourceInventory!==oldEvidence.sourceInventory
      || priorReceipt.sourceFingerprint!==oldEvidence.sourceFingerprint
      || priorReceipt.sourcePresent!==oldEvidence.sourcePresent
      || priorReceipt.dayCount!==oldEvidence.dayCount
      || priorReceipt.recordCount!==oldEvidence.recordCount
      || priorReceipt.recordsFingerprint!==oldEvidence.recordsFingerprint)
      return refuse('today_preview_existing_receipt_invalid');
    if (priorReceipt.type==='today-preview-reconcile'
      || priorReceipt.type==='today-preview-seal') {
      const parent=receipts.find(row=>row?.id===priorReceipt.priorReceiptId);
      if (!parent || parent.id===priorReceipt.id
        || !['today-preview-seed','today-preview-reconcile',
          'today-preview-seal'].includes(parent.type)
        || parent.resetGeneration!==generation
        || parent.sourceFingerprint!==priorReceipt.priorFingerprint
        || parent.recordsFingerprint!==priorReceipt.priorRecordsFingerprint
        || parent.recordCount!==priorReceipt.priorCount
        || parent.dayCount!==priorReceipt.priorDayCount)
        return refuse('today_preview_existing_receipt_chain_invalid');
    }

    const previous=normalized(oldRows);
    if (previous.length===0 || previous[0]?.id!=='root'
      && !previous.some(row=>row?.id==='root'))
      return refuse('today_preview_existing_rows_invalid');
    const seenIds=new Set(),fields=new Set([
      'tasksByDay','notesByDay','selectedHabitIdsByDay','orderByDay'
    ]);
    let priorDayCount=0;
    for (const row of previous) {
      if (!row || typeof row.id!=='string' || seenIds.has(row.id)
        || !row.value || typeof row.value!=='object'
        || Array.isArray(row.value))
        return refuse('today_preview_existing_rows_invalid');
      seenIds.add(row.id);
      if (row.id==='root') {
        if (!Array.isArray(row.presentMaps)
          || row.presentMaps.length!==new Set(row.presentMaps).size
          || row.presentMaps.some(field=>!fields.has(field))
          || Object.keys(row.value).some(field=>fields.has(field)))
          return refuse('today_preview_existing_rows_invalid');
      } else {
        if (!/^day:\d{4}-\d{2}-\d{2}$/.test(row.id)
          || row.dayKey!==row.id.slice(4)
          || Object.keys(row.value).length===0
          || Object.keys(row.value).some(field=>
            !fields.has(field)||!Array.isArray(row.value[field])))
          return refuse('today_preview_existing_rows_invalid');
        priorDayCount+=1;
      }
    }
    if (priorDayCount!==oldEvidence.dayCount)
      return refuse('today_preview_existing_rows_invalid');
    let priorRecordsFingerprint;
    try {
      priorRecordsFingerprint=await previewRecoveryFingerprint(previous);
    } catch (_) { return refuse('today_preview_existing_digest_unavailable'); }
    if (priorRecordsFingerprint!==oldEvidence.recordsFingerprint)
      return refuse('today_preview_existing_parity_mismatch');
    try { if (!sourceCurrent()) return refuse('legacy_today_changed_during_reconcile'); }
    catch (_) { return refuse('legacy_today_storage_unreadable'); }

    const byId=new Map(previous.map(row=>[row.id,row]));
    const wanted=new Set(target.map(row=>row.id));
    const changed=target.filter(row=>stableJson(byId.get(row.id))!==stableJson(row));
    const removed=previous.filter(row=>!wanted.has(row.id));
    const added=changed.filter(row=>!byId.has(row.id));
    const deltaCount=changed.length+removed.length;
    if (!deltaCount
      && oldEvidence.sourceFingerprint===source.sourceFingerprint
      && oldEvidence.sourceInventory===inventorySignature
      && oldEvidence.sourcePresent===(source.raw!==null)) {
      const live=await inspectPreviewTodayCollectionParity();
      if (!live.match) return refuse('today_preview_reconcile_noop_parity_mismatch',{
        prerequisiteReason:live.reason
      });
      try { if (!sourceCurrent()) return refuse('legacy_today_changed_after_noop'); }
      catch (_) { return refuse('legacy_today_storage_unreadable'); }
      return {
        checked:true,previewOnly:true,committed:false,confirmedDurable:true,
        collectionParityVerified:true,todayMigrated:false,
        changedRows:0,addedRows:0,deletedRows:0,
        reason:'today_preview_already_current',
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    }
    // A single atomic mutation is bounded, never a partial chunk that
    // could be mistaken for a complete source snapshot.
    if (deltaCount>64) return refuse('today_preview_reconcile_batch_too_large',{
      changedRows:deltaCount,maxAtomicRows:64
    });
    const deltaBytes=changed.concat(removed).reduce(
      (total,row)=>total+JSON.stringify(row).length,0);
    if (deltaBytes>262144)
      return refuse('today_preview_reconcile_payload_too_large');

    const receipt={
      id:receiptId,type:'today-preview-reconcile',
      resetGeneration:generation,sourceInventory:inventorySignature,
      sourceFingerprint:source.sourceFingerprint,
      recordsFingerprint:nextRecordsFingerprint,
      sourcePresent:source.raw!==null,dayCount:source.dayCount,
      recordCount:target.length,priorReceiptId:oldEvidence.receiptId,
      priorFingerprint:oldEvidence.sourceFingerprint,
      priorRecordsFingerprint:oldEvidence.recordsFingerprint,
      priorCount:oldEvidence.recordCount,priorDayCount:oldEvidence.dayCount,
      changedIds:changed.map(row=>row.id),
      deletedIds:removed.map(row=>row.id)
    };
    const evidence={
      id:'today-preview',schemaVersion:1,resetGeneration:generation,
      sourceInventory:inventorySignature,
      sourceFingerprint:source.sourceFingerprint,
      recordsFingerprint:nextRecordsFingerprint,
      sourcePresent:source.raw!==null,dayCount:source.dayCount,
      recordCount:target.length,receiptId,capturedAtISO:nowIso()
    };
    try { if (!sourceCurrent()) return refuse('legacy_today_changed_before_write'); }
    catch (_) { return refuse('legacy_today_storage_unreadable'); }
    let failure=null;
    const abort=(tx,reason)=>{failure=reason;try{tx.abort();}catch(_){}};
    try {
      const tx=db.transaction(['todayDays','mutations','meta'],'readwrite');
      const dayStore=tx.objectStore('todayDays');
      const mutationStore=tx.objectStore('mutations');
      const metaStore=tx.objectStore('meta');
      const reads=[
        dayStore.getAll(),metaStore.get('today-preview'),
        metaStore.get(RUNTIME_META_ID),
        mutationStore.get(oldEvidence.receiptId),mutationStore.get(receiptId)
      ];
      const values=new Array(reads.length);
      let remaining=reads.length;
      reads.forEach((request,index)=>{request.onsuccess=()=>{
        values[index]=request.result;
        if (--remaining!==0) return;
        try {
          if (!sourceCurrent())
            return abort(tx,'legacy_today_changed_under_transaction');
          if (stableJson(values[0])!==stableJson(oldRows)
            || stableJson(values[1])!==stableJson(oldEvidence)
            || stableJson(values[2])!==stableJson(runtimeMeta)
            || stableJson(values[3])!==stableJson(priorReceipt)
            || values[4])
            return abort(tx,'today_preview_reconcile_concurrent_change');
          for (const row of removed) dayStore.delete(row.id);
          for (const row of changed) dayStore.put(row);
          mutationStore.add(receipt);
          metaStore.put(evidence);
        } catch (_) { abort(tx,'today_preview_reconcile_atomic_write_failed'); }
      };});
      await transactionPromise(tx);
    } catch (_) { return refuse(failure||'today_preview_reconcile_atomic_write_failed'); }

    // Full independent post-write readback. A V1 write after committing
    // produces an explicitly uncertain outcome rather than false parity.
    try {
      const tx=db.transaction(['todayDays','mutations','meta'],'readonly');
      const [rows,storedEvidence,storedMeta,storedReceipt]=await Promise.all([
        requestPromise(tx.objectStore('todayDays').getAll()),
        requestPromise(tx.objectStore('meta').get('today-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').get(receiptId))
      ]);
      if (stableJson(normalized(rows))!==stableJson(normalized(target))
        || stableJson(storedEvidence)!==stableJson(evidence)
        || stableJson(storedMeta)!==stableJson(runtimeMeta)
        || stableJson(storedReceipt)!==stableJson(receipt))
        return refuse('today_preview_reconcile_readback_unverified',{
          committed:true,writeOutcomeUncertain:true
        });
      if (!sourceCurrent()) return refuse('legacy_today_changed_after_commit',{
        committed:true,confirmedDurable:true,writeOutcomeUncertain:true
      });
      const parity=await inspectPreviewTodayCollectionParity();
      if (!parity.match) return refuse('today_preview_reconcile_parity_unverified',{
        prerequisiteReason:parity.reason,
        committed:true,confirmedDurable:true,writeOutcomeUncertain:true
      });
      try { if (!sourceCurrent()) return refuse('legacy_today_changed_after_parity',{
        committed:true,confirmedDurable:true,writeOutcomeUncertain:true
      }); }
      catch (_) { return refuse('legacy_today_storage_unreadable_after_commit',{
        committed:true,confirmedDurable:true,writeOutcomeUncertain:true
      }); }
      return {
        checked:true,previewOnly:true,committed:true,confirmedDurable:true,
        collectionParityVerified:true,todayMigrated:false,
        dayCount:source.dayCount,recordCount:target.length,
        changedRows:deltaCount,addedRows:added.length,deletedRows:removed.length,
        reason:'today_preview_reconciled',
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    } catch (_) { return refuse('today_preview_reconcile_readback_unavailable',{
      committed:true,writeOutcomeUncertain:true
    }); }
  }


  // Opt-in Gold source capture: a complete ordered ledger and every economy
  // metadata field are authoritative, even when Game results also refer to
  // those transactions. This never initializes or repairs V1 Gold.
  async function capturePreviewGoldSource() {
    const fail=reason=>({reason});
    const generation=currentGeneration({create:false});
    if(!generation)return fail('gold_generation_unavailable');
    const epoch=darkMirrorModeEpoch,key=core.STORAGE_KEY||'taskpoints_v1';
    let inventory,raw,ledger,metadata,present,metaPresent;
    try {
      inventory=captureReadOnlyFullStorageInventory();
      raw=global.localStorage.getItem(key);
      if(typeof raw!=='string')return fail('gold_snapshot_missing');
      const state=core.parseTaskPointsStorageJson(raw);
      if(!state||typeof state!=='object'||Array.isArray(state)
        ||!Array.isArray(state.habits)||!Array.isArray(state.completions))
        return fail('gold_snapshot_invalid');
      present=Object.prototype.hasOwnProperty.call(state,'goldLedger');
      metaPresent=Object.prototype.hasOwnProperty.call(state,'goldEconomy');
      ledger=present?state.goldLedger:[];
      metadata=metaPresent?state.goldEconomy:null;
      if(!Array.isArray(ledger))return fail('gold_ledger_array_required');
      if(present!==metaPresent)
        return fail('gold_ledger_economy_presence_mismatch');
      if(metaPresent&&(!metadata||typeof metadata!=='object'
        ||Array.isArray(metadata)||!Number.isSafeInteger(Number(metadata.version))
        ||Number(metadata.version)<1))
        return fail('gold_economy_metadata_invalid');
      if(metaPresent&&ledger.length===0
        &&[metadata.settledMatchupKeys,metadata.settledChampionKeys]
          .some(keys=>Array.isArray(keys)&&keys.length>0))
        return fail('gold_settlements_without_ledger_rows');
      if(ledger.length>8192||JSON.stringify(ledger).length>2097152)
        return fail('gold_ledger_preview_too_large');
      const ids=new Set();
      for(const row of ledger){
        if(!row||typeof row!=='object'||Array.isArray(row)
          ||typeof row.id!=='string'||!row.id||row.id.length>256
          ||ids.has(row.id))
          return fail('gold_ledger_ids_invalid');
        ids.add(row.id);
      }
      // Settled Game outcomes must not be taken as proof of zero Gold if
      // storage has lost either ledger or its economic metadata.
      if(!present||!metaPresent){
        const groups=[state.matchups,state.gameHistory,
          state.currentSeason?.tournamentMatchupResults];
        if(Array.isArray(state.seasonHistory))
          state.seasonHistory.forEach(season=>groups.push(
            season?.tournamentMatchupResults));
        if(groups.some(rows=>Array.isArray(rows)&&rows.some(
          row=>row?.goldOutcome?.settled===true)))
          return fail('gold_settlement_missing_ledger_or_metadata');
      }
      if(captureReadOnlyFullStorageInventory()!==inventory
        ||global.localStorage.getItem(key)!==raw)
        return fail('gold_source_changed_during_capture');
      const fingerprint=await previewRecoveryFingerprint({
        ledgerPresent:present,economyPresent:metaPresent,
        ledger,economy:metadata
      });
      if(!isWalTestPreviewHost()||!isDarkEnabled()
        ||darkMirrorModeEpoch!==epoch
        ||currentGeneration({create:false})!==generation
        ||captureReadOnlyFullStorageInventory()!==inventory
        ||global.localStorage.getItem(key)!==raw)
        return fail('gold_source_changed_during_hash');
      return {generation,epoch,inventory,raw,ledger,metadata,present,
        metaPresent,fingerprint};
    }catch(_){return fail('gold_source_unavailable');}
  }

  function refuseGoldPreview(reason,more={}) {
    return {checked:true,previewOnly:true,committed:false,
      confirmedDurable:false,collectionParityVerified:false,
      goldMigrated:false,canApply:false,canPromote:false,
      productionWritersFenced:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...more};
  }

  // One strictly bounded transaction writes all Gold rows, the sealed
  // source metadata and the receipt. No production write/restore occurs.
  async function rehearsePreviewGoldLedgerSeed(sourceToken,actionId) {
    const fail=refuseGoldPreview;
    if(!isWalTestPreviewHost())return fail('preview_host_required');
    if(!isDarkEnabled())return fail('dark_disabled');
    if(typeof sourceToken!=='string'||!sourceToken)
      return fail('full_origin_token_required');
    if(typeof actionId!=='string'||!actionId||actionId.length>128)
      return fail('gold_action_id_required');
    let source;
    try{
      if(captureReadOnlyFullStorageInventory()!==sourceToken)
        return fail('full_origin_changed');
      source=await capturePreviewGoldSource();
      if(source.reason)return fail('gold_source_preflight_required',{
        prerequisiteReason:source.reason});
      if(source.inventory!==sourceToken)return fail('full_origin_changed');
    }catch(_){return fail('gold_source_unreadable');}
    const current=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&darkMirrorModeEpoch===source.epoch
      &&currentGeneration({create:false})===source.generation
      &&captureReadOnlyFullStorageInventory()===source.inventory
      &&global.localStorage.getItem(core.STORAGE_KEY||'taskpoints_v1')
        ===source.raw;
    const rows=source.ledger.map((value,i)=>({
      id:'gold-row:'+i,legacyIndex:i,value
    }));
    const signature=fnv1a(source.inventory)+':'+source.inventory.length;
    const receipt={id:'gold-preview-seed:'+actionId,
      type:'gold-preview-seed',resetGeneration:source.generation,
      sourceFingerprint:source.fingerprint,sourceInventory:signature,
      rowCount:rows.length,present:source.present,
      metaPresent:source.metaPresent};
    const evidence={id:'gold-preview',schemaVersion:1,
      resetGeneration:source.generation,
      sourceFingerprint:source.fingerprint,sourceInventory:signature,
      rowCount:rows.length,present:source.present,
      metaPresent:source.metaPresent,metadata:clone(source.metadata),
      receiptId:receipt.id};
    let db,prior,priorEvidence,priorMeta,priorReceipts;
    try{
      db=await open();if(!db)return fail('v2_unavailable');
      const tx=db.transaction(['goldLedger','mutations','meta'],'readonly');
      [prior,priorEvidence,priorMeta,priorReceipts]=await Promise.all([
        requestPromise(tx.objectStore('goldLedger').getAll()),
        requestPromise(tx.objectStore('meta').get('gold-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').getAll())
      ]);
    }catch(_){return fail('gold_preview_read_unavailable');}
    if(!priorMeta||priorMeta.schemaVersion!==SCHEMA_VERSION
      ||priorMeta.resetGeneration!==source.generation
      ||priorMeta.legacyMissing===true)
      return fail('pilot_meta_not_ready');
    if(prior.length||priorEvidence||priorReceipts.some(row=>
      typeof row?.id==='string'&&row.id.startsWith('gold-preview-')))
      return fail('gold_preview_existing_evidence_preserved');
    try{if(!current())return fail('gold_source_changed_before_seed');}
    catch(_){return fail('gold_source_unavailable_before_seed');}
    let failure=null;
    const abort=(tx,reason)=>{failure=reason;try{tx.abort();}catch(_){}};
    try{
      const tx=db.transaction(['goldLedger','mutations','meta'],'readwrite');
      const store=tx.objectStore('goldLedger');
      const mutations=tx.objectStore('mutations');
      const meta=tx.objectStore('meta');
      const reads=[store.getAll(),meta.get('gold-preview'),
        meta.get(RUNTIME_META_ID),mutations.getAll()];
      const values=new Array(reads.length);
      let pending=reads.length;
      reads.forEach((req,i)=>{req.onsuccess=()=>{
        values[i]=req.result;
        if(--pending)return;
        try{
          if(!current())return abort(tx,'gold_source_changed_under_transaction');
          if(stableJson(values[0])!==stableJson(prior)
            ||stableJson(values[1])!==stableJson(priorEvidence)
            ||stableJson(values[2])!==stableJson(priorMeta)
            ||stableJson(values[3])!==stableJson(priorReceipts))
            return abort(tx,'gold_preview_concurrent_change');
          rows.forEach(row=>store.add(row));
          mutations.add(receipt);meta.add(evidence);
        }catch(_){abort(tx,'gold_preview_atomic_seed_failed');}
      };});
      await transactionPromise(tx);
    }catch(_){return fail(failure||'gold_preview_atomic_seed_failed');}
    try{
      const tx=db.transaction(['goldLedger','mutations','meta'],'readonly');
      const [saved,proof,meta,receiptReadback]=await Promise.all([
        requestPromise(tx.objectStore('goldLedger').getAll()),
        requestPromise(tx.objectStore('meta').get('gold-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').get(receipt.id))
      ]);
      if(stableJson(saved.sort((a,b)=>a.legacyIndex-b.legacyIndex))
          !==stableJson(rows)||stableJson(proof)!==stableJson(evidence)
        ||stableJson(meta)!==stableJson(priorMeta)
        ||stableJson(receiptReadback)!==stableJson(receipt))
        return fail('gold_preview_readback_unverified',{
          committed:true,writeOutcomeUncertain:true});
      if(!current())return fail('gold_source_changed_after_commit',{
        committed:true,confirmedDurable:true,writeOutcomeUncertain:true});
      const parity=await inspectPreviewGoldLedgerParity();
      if(!parity.match)return fail('gold_preview_parity_unverified',{
        prerequisiteReason:parity.reason,committed:true,
        confirmedDurable:true,writeOutcomeUncertain:true});
      if(!current())return fail('gold_source_changed_after_parity',{
        committed:true,confirmedDurable:true,writeOutcomeUncertain:true});
      return {checked:true,previewOnly:true,committed:true,
        confirmedDurable:true,collectionParityVerified:true,
        goldMigrated:false,rowCount:rows.length,
        reason:'gold_preview_seed_verified',canApply:false,
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'};
    }catch(_){return fail('gold_preview_readback_unavailable',{
      committed:true,writeOutcomeUncertain:true});}
  }


  // Verify every Gold preview receipt back to the initial seed. Orphaned
  // receipts are never ignored: a missing/tampered ancestor or a second
  // disconnected history makes the entire preview ineligible.
  function verifyGoldPreviewReceiptChain(evidence, allMutations, generation) {
    if(!evidence||typeof evidence.receiptId!=='string'
      ||!evidence.receiptId.startsWith('gold-preview-'))
      return 'gold_preview_receipt_missing_or_invalid';
    if(!Array.isArray(allMutations))
      return 'gold_preview_receipts_unreadable';
    const gold=allMutations.filter(row=>typeof row?.id==='string'
      &&row.id.startsWith('gold-preview-'));
    const byId=new Map(gold.map(row=>[row.id,row]));
    if(byId.size!==gold.length)return 'gold_preview_duplicate_receipts';
    let cursor=evidence.receiptId;
    let expected={fingerprint:evidence.sourceFingerprint,
      inventory:evidence.sourceInventory,rowCount:evidence.rowCount,
      present:evidence.present,metaPresent:evidence.metaPresent};
    const seen=new Set();
    while(cursor){
      if(seen.has(cursor)||seen.size>8192)
        return 'gold_preview_receipt_cycle';
      seen.add(cursor);
      const row=byId.get(cursor);
      if(!row||row.resetGeneration!==generation
        ||row.sourceFingerprint!==expected.fingerprint
        ||row.sourceInventory!==expected.inventory
        ||row.rowCount!==expected.rowCount
        ||row.present!==expected.present
        ||row.metaPresent!==expected.metaPresent)
        return 'gold_preview_receipt_missing_or_invalid';
      if(row.type==='gold-preview-seed'){
        if(!row.id.startsWith('gold-preview-seed:')
          ||row.priorReceiptId!=null)
          return 'gold_preview_receipt_chain_invalid';
        if(seen.size!==gold.length)
          return 'gold_preview_orphan_receipts_preserved';
        return null;
      }
      if(row.type!=='gold-preview-reconcile'
        ||!row.id.startsWith('gold-preview-reconcile:')
        ||typeof row.priorReceiptId!=='string'
        ||!row.priorReceiptId.startsWith('gold-preview-')
        ||typeof row.priorSourceFingerprint!=='string'
        ||typeof row.priorSourceInventory!=='string'
        ||!Number.isSafeInteger(row.priorRowCount)
        ||typeof row.priorPresent!=='boolean'
        ||typeof row.priorMetaPresent!=='boolean'
        ||!Number.isSafeInteger(row.changedRows)
        ||row.changedRows<0||row.changedRows>64)
        return 'gold_preview_receipt_chain_invalid';
      cursor=row.priorReceiptId;
      expected={fingerprint:row.priorSourceFingerprint,
        inventory:row.priorSourceInventory,rowCount:row.priorRowCount,
        present:row.priorPresent,metaPresent:row.priorMetaPresent};
    }
    return 'gold_preview_receipt_chain_invalid';
  }

  function orderedGoldPreviewRows(rows) {
    if(!Array.isArray(rows))return null;
    const sorted=rows.slice().sort((a,b)=>a.legacyIndex-b.legacyIndex);
    for(let i=0;i<sorted.length;i++){
      const row=sorted[i];
      if(!row||row.id!=='gold-row:'+i||row.legacyIndex!==i
        ||!row.value||typeof row.value!=='object'
        ||Array.isArray(row.value)||typeof row.value.id!=='string'
        ||!row.value.id)
        return null;
    }
    return sorted;
  }

  async function inspectPreviewGoldLedgerParity() {
    const fail=(reason,more={})=>({...refuseGoldPreview(reason),
      match:false,...more});
    if(!isWalTestPreviewHost())return fail('preview_host_required');
    if(!isDarkEnabled())return fail('dark_disabled');
    const source=await capturePreviewGoldSource();
    if(source.reason)return fail('gold_source_preflight_required',{
      prerequisiteReason:source.reason});
    const current=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&darkMirrorModeEpoch===source.epoch
      &&currentGeneration({create:false})===source.generation
      &&captureReadOnlyFullStorageInventory()===source.inventory
      &&global.localStorage.getItem(core.STORAGE_KEY||'taskpoints_v1')
        ===source.raw;
    let rows,evidence,meta,mutations;
    try{
      const db=await open();if(!db)return fail('v2_unavailable');
      // All provenance and record facts come from one IDB snapshot.
      const tx=db.transaction(['goldLedger','mutations','meta'],'readonly');
      [rows,evidence,meta,mutations]=await Promise.all([
        requestPromise(tx.objectStore('goldLedger').getAll()),
        requestPromise(tx.objectStore('meta').get('gold-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').getAll())
      ]);
    }catch(_){return fail('gold_preview_read_unavailable');}
    try{
      if(!current())return fail('gold_source_changed_during_parity');
      if(!meta||meta.schemaVersion!==SCHEMA_VERSION
        ||meta.resetGeneration!==source.generation
        ||meta.legacyMissing===true)
        return fail('pilot_meta_not_ready');
      const signature=fnv1a(source.inventory)+':'+source.inventory.length;
      if(!evidence||evidence.schemaVersion!==1
        ||evidence.resetGeneration!==source.generation
        ||evidence.sourceFingerprint!==source.fingerprint
        ||evidence.sourceInventory!==signature
        ||evidence.present!==source.present
        ||evidence.metaPresent!==source.metaPresent
        ||evidence.rowCount!==source.ledger.length
        ||stableJson(evidence.metadata)!==stableJson(source.metadata))
        return fail('gold_preview_source_stale');
      const ordered=orderedGoldPreviewRows(rows);
      if(!ordered)return fail('gold_preview_row_invalid');
      const expected=source.ledger.map((value,i)=>({
        id:'gold-row:'+i,legacyIndex:i,value
      }));
      if(stableJson(ordered)!==stableJson(expected))
        return fail('gold_preview_record_mismatch',{
          expectedCount:expected.length,actualCount:ordered.length});
      const receiptProblem=verifyGoldPreviewReceiptChain(
        evidence,mutations,source.generation);
      if(receiptProblem)return fail(receiptProblem);
      if(!current())return fail('gold_source_changed_after_parity');
      return {checked:true,previewOnly:true,match:true,
        rowCount:ordered.length,goldMigrated:false,
        present:source.present,metaPresent:source.metaPresent,
        reason:'gold_preview_parity_verified',canApply:false,
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'};
    }catch(_){return fail('gold_preview_parity_unreadable');}
  }


  // Independent, read-only inspection of an existing same-device V2 Gold
  // snapshot. This does not prove transaction completeness or restore Gold.
  async function inspectPreviewGoldRecoveryEvidence(){
    const deny=reason=>({
      checked:true,previewOnly:true,evidenceVerified:false,
      sourceCompared:false,safeToRestore:false,goldMigrated:false,
      transactionIntegrityVerified:false,settledOutcomesVerified:false,
      offDeviceBackupVerified:false,canApply:false,canPromote:false,
      productionWritersFenced:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason
    });
    if(!isWalTestPreviewHost())return deny('preview_host_required');
    if(!isDarkEnabled())return deny('dark_disabled');
    const generation=currentGeneration({create:false}),epoch=darkMirrorModeEpoch;
    if(!generation)return deny('generation_unavailable');
    const sha=x=>typeof x==='string'&&/^sha256:[a-f0-9]{64}:\d+$/.test(x);
    const sig=x=>typeof x==='string'&&/^[a-f0-9]{8}:\d+$/.test(x);
    const contextValid=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&darkMirrorModeEpoch===epoch
      &&currentGeneration({create:false})===generation;
    const read=async db=>{
      const tx=db.transaction(['goldLedger','mutations','meta'],'readonly');
      const [rows,evidence,meta,mutations]=await Promise.all([
        requestPromise(tx.objectStore('goldLedger').getAll()),
        requestPromise(tx.objectStore('meta').get('gold-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').getAll())
      ]);
      return {rows,evidence,meta,receipts:mutations.filter(r=>
        typeof r?.id==='string'&&r.id.startsWith('gold-preview-'))};
    };
    try{
      const db=await open();
      if(!db)return deny('v2_unavailable');
      const stored=await read(db);
      const {rows,evidence,meta,receipts}=stored;
      if(!meta||meta.schemaVersion!==SCHEMA_VERSION
        ||meta.resetGeneration!==generation||meta.legacyMissing===true)
        return deny('pilot_meta_not_ready');
      if(!evidence||evidence.id!=='gold-preview'
        ||evidence.schemaVersion!==1
        ||evidence.resetGeneration!==generation
        ||!sha(evidence.sourceFingerprint)||!sig(evidence.sourceInventory)
        ||typeof evidence.present!=='boolean'
        ||typeof evidence.metaPresent!=='boolean'
        ||evidence.present!==evidence.metaPresent
        ||!Number.isSafeInteger(evidence.rowCount)
        ||evidence.rowCount<0||evidence.rowCount>8192
        ||evidence.rowCount!==rows.length
        ||typeof evidence.receiptId!=='string'
        ||(!evidence.present&&rows.length!==0)
        ||(!evidence.metaPresent&&evidence.metadata!==null))
        return deny('gold_preview_evidence_invalid');
      if(evidence.metaPresent&&(!evidence.metadata
        ||typeof evidence.metadata!=='object'
        ||Array.isArray(evidence.metadata)
        ||!Number.isSafeInteger(Number(evidence.metadata.version))
        ||Number(evidence.metadata.version)<1))
        return deny('gold_preview_economy_invalid');
      if(evidence.metaPresent&&!rows.length
        &&[evidence.metadata.settledMatchupKeys,
          evidence.metadata.settledChampionKeys]
          .some(list=>Array.isArray(list)&&list.length))
        return deny('gold_preview_settlements_without_rows');
      const ordered=orderedGoldPreviewRows(rows);
      if(!ordered||JSON.stringify(ordered).length>2300000)
        return deny('gold_preview_rows_invalid');
      const ids=new Set();
      for(const r of ordered){
        const id=r.value.id;
        if(typeof id!=='string'||!id||id.length>256||ids.has(id))
          return deny('gold_preview_transaction_ids_invalid');
        ids.add(id);
      }
      const digest=await previewRecoveryFingerprint({
        ledgerPresent:evidence.present,economyPresent:evidence.metaPresent,
        ledger:ordered.map(x=>x.value),economy:evidence.metadata
      });
      if(digest!==evidence.sourceFingerprint)
        return deny('gold_preview_saved_digest_mismatch');
      if(!receipts.length||receipts.length>8192
        ||receipts.some(r=>!r||typeof r.id!=='string'
          ||!['gold-preview-seed','gold-preview-reconcile'].includes(r.type)
          ||!r.id.startsWith(r.type+':')
          ||!sha(r.sourceFingerprint)||!sig(r.sourceInventory)))
        return deny('gold_preview_receipts_invalid');
      const problem=verifyGoldPreviewReceiptChain(evidence,receipts,generation);
      if(problem)return deny(problem);
      if(!contextValid()||stableJson(await read(db))!==stableJson(stored)
        ||!contextValid())
        return deny('gold_preview_evidence_changed_during_inspection');
      return {...deny('gold_preview_recovery_evidence_verified'),
        evidenceVerified:true,rowCount:ordered.length,receiptCount:receipts.length,
        ledgerPresent:evidence.present,economyPresent:evidence.metaPresent};
    }catch(_){return deny('gold_preview_recovery_unavailable');}
  }

  // Read-only, preview-host-only semantic check of the Gold ledger that
  // has ALREADY passed exact source/record/receipt parity. Equality alone
  // cannot tell us whether theft transfers were lost or balances drifted.
  // This reports anomalies; never repairs V1 or V2, grants writer admission,
  // or makes a claim about transactions absent from BOTH histories.
  async function inspectPreviewGoldTransactionIntegrity() {
    const fail=(reason,details={})=>({
      ...refuseGoldPreview(reason),match:false,
      balanceChainVerified:false,theftPairsVerified:false,...details
    });
    if(!isWalTestPreviewHost())return fail('preview_host_required');
    if(!isDarkEnabled())return fail('dark_disabled');
    const source=await capturePreviewGoldSource();
    if(source.reason)return fail('gold_source_preflight_required',{
      prerequisiteReason:source.reason
    });
    const current=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&darkMirrorModeEpoch===source.epoch
      &&currentGeneration({create:false})===source.generation
      &&captureReadOnlyFullStorageInventory()===source.inventory
      &&global.localStorage.getItem(core.STORAGE_KEY||'taskpoints_v1')
        ===source.raw;
    const parity=await inspectPreviewGoldLedgerParity();
    if(!parity.match)return fail('gold_preview_parity_required',{
      prerequisiteReason:parity.reason
    });
    try {if(!current())return fail('gold_source_changed_before_integrity_check');}
    catch(_){return fail('gold_source_unreadable_before_integrity_check');}
    let rows,seal,meta;
    try {
      const db=await open();
      if(!db)return fail('v2_unavailable');
      const tx=db.transaction(['goldLedger','meta'],'readonly');
      [rows,seal,meta]=await Promise.all([
        requestPromise(tx.objectStore('goldLedger').getAll()),
        requestPromise(tx.objectStore('meta').get('gold-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID))
      ]);
    }catch(_){return fail('gold_integrity_read_unavailable');}
    try {
      if(!current())return fail('gold_source_changed_during_integrity_check');
      const ordered=orderedGoldPreviewRows(rows);
      if(!ordered || !seal || seal.resetGeneration!==source.generation
        || !meta || meta.resetGeneration!==source.generation
        || seal.sourceFingerprint!==source.fingerprint
        || stableJson(ordered.map(row=>row.value))!==stableJson(source.ledger))
        return fail('gold_preview_changed_during_integrity_check');
      const counts={
        invalidPlayer:0,invalidAmount:0,invalidBalanceAfter:0,
        runningBalanceMismatch:0,missingTheftTransferId:0,
        incompleteTheftTransfer:0,invalidTheftTransfer:0,
        contradictorySettledOutcome:0,unverifiableSettledOutcome:0,
        settledTheftLedgerMissing:0,settledTheftLedgerMismatch:0,
        settledMarginLedgerMissing:0,settledMarginLedgerMismatch:0
      };
      const samples=[];
      const markIssue=(type,entry,index)=>{
        counts[type]+=1;
        if(samples.length<8)samples.push({
          type,index,transactionId:String(entry?.id||'').slice(0,256)
        });
      };
      const balances=new Map(),invalidPlayers=new Set(),transfers=new Map();
      for(let i=0;i<ordered.length;i++){
        const entry=ordered[i].value;
        const player=typeof entry.playerId==='string'?entry.playerId.trim():'';
        const amount=entry.amount;
        const balanceAfter=entry.balanceAfter;
        if(!player)markIssue('invalidPlayer',entry,i);
        if(typeof amount!=='number'||!Number.isFinite(amount)
          ||Math.abs(amount-Math.round((amount+Number.EPSILON)*10)/10)>1e-6)
          markIssue('invalidAmount',entry,i);
        if(typeof balanceAfter!=='number'||!Number.isFinite(balanceAfter)
          ||Math.abs(balanceAfter-Math.round((balanceAfter+Number.EPSILON)*10)/10)>1e-6)
          markIssue('invalidBalanceAfter',entry,i);
        if(player&&typeof amount==='number'&&Number.isFinite(amount)) {
          const next=(balances.get(player)||0)+Math.round((amount+Number.EPSILON)*10);
          balances.set(player,next);
          if(!invalidPlayers.has(player)
            &&typeof balanceAfter==='number'&&Number.isFinite(balanceAfter)
            &&Math.abs(balanceAfter-next/10)>1e-6)
            markIssue('runningBalanceMismatch',entry,i);
        }else if(player)invalidPlayers.add(player);
        if(entry.type==='matchup_theft') {
          const id=typeof entry.transferId==='string'
            ?entry.transferId.trim():'';
          if(!id)markIssue('missingTheftTransferId',entry,i);
          else {
            const group=transfers.get(id)||[];
            group.push({entry,index:i});
            transfers.set(id,group);
          }
        }
      }
      for(const group of transfers.values()){
        if(group.length!==2){
          markIssue('incompleteTheftTransfer',group[0].entry,group[0].index);
          continue;
        }
        const [a,b]=group.map(x=>x.entry);
        const ta=Math.round((a.amount+Number.EPSILON)*10);
        const tb=Math.round((b.amount+Number.EPSILON)*10);
        const valid=typeof a.amount==='number'&&Number.isFinite(a.amount)
          &&typeof b.amount==='number'&&Number.isFinite(b.amount)
          &&ta+tb===0&&ta!==0
          &&a.playerId!==b.playerId
          &&typeof a.playerId==='string'&&Boolean(a.playerId.trim())
          &&typeof b.playerId==='string'&&Boolean(b.playerId.trim())
          &&typeof a.matchupId==='string'&&Boolean(a.matchupId.trim())
          &&a.matchupId===b.matchupId
          &&(!a.opponentId&&!b.opponentId
            ||a.opponentId===b.playerId&&b.opponentId===a.playerId)
          &&(a.meta?.direction==null
            ||a.meta.direction===(a.amount<0?'lost':'stolen'))
          &&(b.meta?.direction==null
            ||b.meta.direction===(b.amount<0?'lost':'stolen'));
        if(!valid)markIssue('invalidTheftTransfer',group[0].entry,group[0].index);
      }
      // A balanced ledger can still lose BOTH theft legs, so compare
      // explicit, already-settled matchup outcomes with their transactions.
      // Inspect only recorded outcome claims with an explicit matchup ID.
      // This does not infer anything about unrecorded historical games.
      const sourceState=typeof core.parseTaskPointsStorageJson==='function'
        ?core.parseTaskPointsStorageJson(source.raw,{})
        :JSON.parse(source.raw);
      if(!sourceState||typeof sourceState!=='object'
        ||Array.isArray(sourceState))
        return fail('gold_outcome_source_unreadable');
      const claimGroups=[
        sourceState.matchups,sourceState.currentSeason?.tournamentMatchupResults,
        ...((Array.isArray(sourceState.seasonHistory)
          ?sourceState.seasonHistory:[]).map(s=>s?.tournamentMatchupResults)),
        ...((Array.isArray(sourceState.schedule)
          ?sourceState.schedule:[]).map(day=>day?.matchups))
      ];
      const outcomeClaims=new Map();
      let examined=0;
      for(const group of claimGroups){
        if(!Array.isArray(group))continue;
        for(const game of group){
          if(++examined>50000)return fail('gold_outcome_scan_limit');
          const outcome=game?.goldOutcome;
          if(outcome?.settled!==true)continue;
          const theft=outcome.theftGoldStolen??0;
          const margin=outcome.marginGoldAwarded??0;
          if(!theft&&!margin)continue;
          const gameId=String(game?.id||game?.matchupId||'').trim();
          const winner=String(outcome.winnerId||'').trim();
          const loser=String(outcome.loserId||'').trim();
          if(!gameId||!winner||!loser||winner===loser
            ||typeof theft!=='number'||!Number.isFinite(theft)||theft<0
            ||typeof margin!=='number'||!Number.isFinite(margin)||margin<0){
            markIssue('unverifiableSettledOutcome',game,-1);
            continue;
          }
          const claim={id:gameId,winner,loser,theft,margin};
          const prior=outcomeClaims.get(gameId);
          if(prior){
            if(stableJson(prior)!==stableJson(claim))
              markIssue('contradictorySettledOutcome',game,-1);
          }else outcomeClaims.set(gameId,claim);
        }
      }
      const ledgerByMatchup=new Map();
      for(const row of ordered){
        const entry=row.value;
        if(entry.type!=='matchup_theft'&&entry.type!=='matchup_margin')
          continue;
        const id=String(entry.matchupId||'').trim();
        if(!id)continue;
        const group=ledgerByMatchup.get(id)||[];
        group.push(entry);
        ledgerByMatchup.set(id,group);
      }
      for(const claim of outcomeClaims.values()){
        const ledger=ledgerByMatchup.get(claim.id)||[];
        if(claim.theft>0){
          const legs=ledger.filter(row=>row.type==='matchup_theft');
          if(legs.length!==2)
            markIssue('settledTheftLedgerMissing',claim,-1);
          else {
            const won=legs.filter(row=>row.playerId===claim.winner
              &&row.opponentId===claim.loser&&row.amount===claim.theft);
            const lost=legs.filter(row=>row.playerId===claim.loser
              &&row.opponentId===claim.winner&&row.amount===-claim.theft);
            if(won.length!==1||lost.length!==1)
              markIssue('settledTheftLedgerMismatch',claim,-1);
          }
        }
        if(claim.margin>0){
          const margins=ledger.filter(row=>row.type==='matchup_margin');
          if(margins.length!==1)
            markIssue('settledMarginLedgerMissing',claim,-1);
          else if(margins[0].playerId!==claim.winner
            ||margins[0].amount!==claim.margin)
            markIssue('settledMarginLedgerMismatch',claim,-1);
        }
      }
      if(!current())return fail('gold_source_changed_after_integrity_check');
      const issueCount=Object.values(counts).reduce((sum,n)=>sum+n,0);
      return {
        checked:true,previewOnly:true,match:issueCount===0,
        balanceChainVerified:issueCount===0,
        theftPairsVerified:issueCount===0,
        issueCount,issues:counts,samples,
        rowCount:ordered.length,transferCount:transfers.size,
        playerCount:balances.size,
        settledOutcomeClaimsChecked:outcomeClaims.size,
        reason:issueCount?'gold_transaction_integrity_anomalies'
          :'gold_transaction_integrity_verified',
        goldMigrated:false,canApply:false,canPromote:false,
        productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    }catch(_){return fail('gold_integrity_check_unavailable');}
  }

  // Advance one already sealed Gold history to a newer V1 authority. This
  // supports append-only transactions, economy metadata changes, and
  // explicitly opted-in in-place corrections. Deletions and transaction-ID
  // swaps/reorders are NEVER normalized into apparent zero-Gold history.
  // No live writer is installed, no source data is modified, and a
  // confirmed V2 commit is still only a historical preview observation.
  async function rehearsePreviewGoldLedgerReconcile(sourceToken,actionId,options={}) {
    const fail=refuseGoldPreview;
    if(!isWalTestPreviewHost())return fail('preview_host_required');
    if(!isDarkEnabled())return fail('dark_disabled');
    if(typeof sourceToken!=='string'||!sourceToken)
      return fail('full_origin_token_required');
    if(typeof actionId!=='string'||!actionId||actionId.length>128)
      return fail('gold_action_id_required');
    const correctionAllowed=options?.allowHistoricalCorrections===true;
    let source;
    try{
      if(captureReadOnlyFullStorageInventory()!==sourceToken)
        return fail('full_origin_changed');
      source=await capturePreviewGoldSource();
      if(source.reason)return fail('gold_source_preflight_required',{
        prerequisiteReason:source.reason});
      if(source.inventory!==sourceToken)return fail('full_origin_changed');
    }catch(_){return fail('gold_source_unreadable');}
    const current=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&source.epoch===darkMirrorModeEpoch
      &&currentGeneration({create:false})===source.generation
      &&captureReadOnlyFullStorageInventory()===source.inventory
      &&global.localStorage.getItem(core.STORAGE_KEY||'taskpoints_v1')
        ===source.raw;
    let db,prior,proof,meta,mutations;
    try{
      db=await open();if(!db)return fail('v2_unavailable');
      const tx=db.transaction(['goldLedger','mutations','meta'],'readonly');
      [prior,proof,meta,mutations]=await Promise.all([
        requestPromise(tx.objectStore('goldLedger').getAll()),
        requestPromise(tx.objectStore('meta').get('gold-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').getAll())
      ]);
    }catch(_){return fail('gold_preview_read_unavailable');}
    if(!meta||meta.schemaVersion!==SCHEMA_VERSION
      ||meta.resetGeneration!==source.generation||meta.legacyMissing===true)
      return fail('pilot_meta_not_ready');
    if(!proof)return fail('gold_preview_seed_required');
    if(proof.schemaVersion!==1||proof.resetGeneration!==source.generation
      ||typeof proof.sourceFingerprint!=='string'
      ||typeof proof.sourceInventory!=='string'
      ||!Number.isSafeInteger(proof.rowCount)
      ||typeof proof.present!=='boolean'
      ||typeof proof.metaPresent!=='boolean')
      return fail('gold_preview_prior_evidence_invalid');
    const priorOrder=orderedGoldPreviewRows(prior);
    if(!priorOrder||priorOrder.length!==proof.rowCount)
      return fail('gold_preview_existing_records_invalid');
    const chainProblem=verifyGoldPreviewReceiptChain(
      proof,mutations,source.generation);
    if(chainProblem)return fail(chainProblem);
    let oldFingerprint;
    try{
      oldFingerprint=await previewRecoveryFingerprint({
        ledgerPresent:proof.present,economyPresent:proof.metaPresent,
        ledger:priorOrder.map(r=>r.value),economy:proof.metadata
      });
    }catch(_){return fail('gold_preview_prior_digest_unavailable');}
    if(oldFingerprint!==proof.sourceFingerprint)
      return fail('gold_preview_existing_parity_mismatch');
    try{if(!current())return fail('gold_source_changed_during_reconcile');}
    catch(_){return fail('gold_source_unreadable_during_reconcile');}

    if(proof.present&&!source.present)
      return fail('gold_preview_ledger_disappearance_requires_review');
    if(source.ledger.length<priorOrder.length)
      return fail('gold_preview_history_deletion_requires_review');
    const changed=[],added=[];
    for(let i=0;i<source.ledger.length;i++){
      const row={id:'gold-row:'+i,legacyIndex:i,value:source.ledger[i]};
      if(i<priorOrder.length){
        if(row.value.id!==priorOrder[i].value.id)
          return fail('gold_preview_history_reorder_or_replacement');
        if(stableJson(row)!==stableJson(priorOrder[i]))
          changed.push(row);
      }else{changed.push(row);added.push(row);}
    }
    if(changed.length>added.length&&!correctionAllowed)
      return fail('gold_preview_historical_correction_requires_optin',{
        changedHistoricalRows:changed.length-added.length});
    const metadataChanged=stableJson(proof.metadata)!==stableJson(source.metadata)
      ||proof.present!==source.present
      ||proof.metaPresent!==source.metaPresent;
    const signature=fnv1a(source.inventory)+':'+source.inventory.length;
    const noChange=changed.length===0&&!metadataChanged
      &&proof.sourceInventory===signature
      &&proof.sourceFingerprint===source.fingerprint;
    if(noChange){
      const parity=await inspectPreviewGoldLedgerParity();
      if(!parity.match)return fail('gold_preview_noop_parity_unverified',{
        prerequisiteReason:parity.reason});
      if(!current())return fail('gold_source_changed_after_noop');
      return {checked:true,previewOnly:true,committed:false,
        confirmedDurable:true,collectionParityVerified:true,
        goldMigrated:false,changedRows:0,addedRows:0,
        reason:'gold_preview_already_current',
        canApply:false,canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'};
    }
    if(changed.length>64)return fail('gold_preview_reconcile_batch_too_large',{
      changedRows:changed.length,maxAtomicRows:64});
    if(changed.reduce((sum,row)=>sum+JSON.stringify(row).length,0)>262144
      ||JSON.stringify(source.metadata).length>262144)
      return fail('gold_preview_reconcile_payload_too_large');
    const receiptId='gold-preview-reconcile:'+actionId;
    if(mutations.some(row=>row?.id===receiptId))
      return fail('gold_preview_action_id_already_used');
    const receipt={id:receiptId,type:'gold-preview-reconcile',
      resetGeneration:source.generation,
      sourceFingerprint:source.fingerprint,
      sourceInventory:signature,rowCount:source.ledger.length,
      present:source.present,metaPresent:source.metaPresent,
      priorReceiptId:proof.receiptId,
      priorSourceFingerprint:proof.sourceFingerprint,
      priorSourceInventory:proof.sourceInventory,
      priorRowCount:proof.rowCount,priorPresent:proof.present,
      priorMetaPresent:proof.metaPresent,changedRows:changed.length,
      addedRows:added.length,correctedRows:changed.length-added.length};
    const evidence={id:'gold-preview',schemaVersion:1,
      resetGeneration:source.generation,
      sourceFingerprint:source.fingerprint,
      sourceInventory:signature,rowCount:source.ledger.length,
      present:source.present,metaPresent:source.metaPresent,
      metadata:clone(source.metadata),receiptId};
    try{if(!current())return fail('gold_source_changed_before_write');}
    catch(_){return fail('gold_source_unreadable_before_write');}
    let failure=null;
    const abort=(tx,reason)=>{failure=reason;try{tx.abort();}catch(_){}};
    try{
      const tx=db.transaction(['goldLedger','mutations','meta'],'readwrite');
      const rows=tx.objectStore('goldLedger');
      const mut=tx.objectStore('mutations');
      const m=tx.objectStore('meta');
      const reads=[rows.getAll(),m.get('gold-preview'),
        m.get(RUNTIME_META_ID),mut.getAll()];
      const values=new Array(reads.length);
      let pending=reads.length;
      reads.forEach((request,i)=>{request.onsuccess=()=>{
        values[i]=request.result;
        if(--pending)return;
        try{
          if(!current())return abort(tx,'gold_source_changed_under_transaction');
          if(stableJson(values[0])!==stableJson(prior)
            ||stableJson(values[1])!==stableJson(proof)
            ||stableJson(values[2])!==stableJson(meta)
            ||stableJson(values[3])!==stableJson(mutations))
            return abort(tx,'gold_preview_concurrent_change');
          changed.forEach(row=>rows.put(row));
          mut.add(receipt);
          m.put(evidence);
        }catch(_){abort(tx,'gold_preview_reconcile_atomic_write_failed');}
      };});
      await transactionPromise(tx);
    }catch(_){return fail(failure||'gold_preview_reconcile_atomic_write_failed');}
    try{
      const tx=db.transaction(['goldLedger','mutations','meta'],'readonly');
      const [saved,newEvidence,newMeta,savedReceipt]=await Promise.all([
        requestPromise(tx.objectStore('goldLedger').getAll()),
        requestPromise(tx.objectStore('meta').get('gold-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').get(receiptId))
      ]);
      const desired=source.ledger.map((value,i)=>({
        id:'gold-row:'+i,legacyIndex:i,value
      }));
      if(stableJson(orderedGoldPreviewRows(saved))!==stableJson(desired)
        ||stableJson(newEvidence)!==stableJson(evidence)
        ||stableJson(newMeta)!==stableJson(meta)
        ||stableJson(savedReceipt)!==stableJson(receipt))
        return fail('gold_preview_reconcile_readback_unverified',{
          committed:true,writeOutcomeUncertain:true});
      if(!current())return fail('gold_source_changed_after_commit',{
        committed:true,confirmedDurable:true,writeOutcomeUncertain:true});
      const parity=await inspectPreviewGoldLedgerParity();
      if(!parity.match)return fail('gold_preview_reconcile_parity_unverified',{
        prerequisiteReason:parity.reason,committed:true,
        confirmedDurable:true,writeOutcomeUncertain:true});
      if(!current())return fail('gold_source_changed_after_parity',{
        committed:true,confirmedDurable:true,writeOutcomeUncertain:true});
      return {checked:true,previewOnly:true,committed:true,
        confirmedDurable:true,collectionParityVerified:true,
        goldMigrated:false,rowCount:desired.length,
        changedRows:changed.length,addedRows:added.length,
        correctedRows:changed.length-added.length,
        reason:'gold_preview_reconciled',canApply:false,
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'};
    }catch(_){return fail('gold_preview_reconcile_readback_unavailable',{
      committed:true,writeOutcomeUncertain:true});}
  }

  // PREVIEW-ONLY source inventory for the independent Projects mini-app.
  // Projects live in tp_projects_v1, NOT the main TaskPoints snapshot. This
  // validator deliberately does not normalize, seed, rewrite, or migrate.
  // Invalid or changing source bytes must not become an empty collection.
  async function inspectPreviewProjectsSource() {
    const refuse = (reason, detail={}) => ({
      checked:true, previewOnly:true, sourceVerified:false,
      projectsMigrated:false, canPromote:false,
      productionWritersFenced:false, readAuthority:'legacy_only',
      mutationAuthority:'legacy_only', reason, ...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    const generation=currentGeneration({create:false});
    if (!generation) return refuse('generation_unavailable');
    const modeEpoch=darkMirrorModeEpoch;
    const key='tp_projects_v1';
    let inventory, raw, projects, subtaskCount=0, fingerprint;
    try {
      inventory=captureReadOnlyFullStorageInventory();
      raw=global.localStorage.getItem(key);
      if (raw===null) projects=[];
      else if (typeof raw==='string') {
        try { projects=JSON.parse(raw); }
        catch (_) { return refuse('legacy_projects_malformed_json'); }
        if (!Array.isArray(projects))
          return refuse('legacy_projects_array_required');
      } else return refuse('legacy_projects_source_unreadable');
      const seenProjects=new Set();
      for (const project of projects) {
        if (!project || typeof project!=='object' || Array.isArray(project)
          || typeof project.id!=='string' || !project.id
          || project.id.length>128 || seenProjects.has(project.id))
          return refuse('legacy_project_ids_invalid');
        seenProjects.add(project.id);
        if (project.subtasks!=null) {
          if (!Array.isArray(project.subtasks))
            return refuse('legacy_project_subtasks_invalid');
          const seenSubtasks=new Set();
          for (const subtask of project.subtasks) {
            if (!subtask || typeof subtask!=='object'
              || Array.isArray(subtask) || typeof subtask.id!=='string'
              || !subtask.id || subtask.id.length>128
              || seenSubtasks.has(subtask.id))
              return refuse('legacy_project_subtasks_invalid');
            seenSubtasks.add(subtask.id);
            subtaskCount+=1;
          }
        }
      }
      if (captureReadOnlyFullStorageInventory()!==inventory
        || global.localStorage.getItem(key)!==raw)
        return refuse('legacy_projects_changed_during_capture');
      // Hash the exact ordered Project objects, including every unknown
      // field, note, progress value and subtask; never silently prune data.
      fingerprint=await previewRecoveryFingerprint(projects);
    } catch (_) { return refuse('legacy_projects_source_unreadable'); }
    try {
      if (!isDarkEnabled() || modeEpoch!==darkMirrorModeEpoch
        || currentGeneration({create:false})!==generation
        || captureReadOnlyFullStorageInventory()!==inventory
        || global.localStorage.getItem(key)!==raw)
        return refuse('legacy_projects_changed_after_fingerprint');
    } catch (_) { return refuse('legacy_projects_source_unreadable'); }
    return {
      checked:true,previewOnly:true,sourceVerified:true,
      projectsMigrated:false,hasSourceKey:raw!==null,
      projectCount:projects.length,subtaskCount,sourceFingerprint:fingerprint,
      comparisonScope:'independent_v1_projects_source_only',
      reason:'legacy_projects_source_verified',
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only'
    };
  }

  // Capture one immutable Projects source under the same full-origin and
  // generation guards used elsewhere in V2. The existing read-only source
  // inspector owns validation; this helper cannot downgrade bad JSON to [].
  async function capturePreviewProjectsSnapshot() {
    const inventory=captureReadOnlyFullStorageInventory();
    const raw=global.localStorage.getItem('tp_projects_v1');
    const proof=await inspectPreviewProjectsSource();
    if (!proof.sourceVerified)
      return {reason:'projects_source_preflight_required',prerequisiteReason:proof.reason};
    if (captureReadOnlyFullStorageInventory()!==inventory
      || global.localStorage.getItem('tp_projects_v1')!==raw)
      return {reason:'legacy_projects_source_changed_during_capture'};
    const projects=raw===null?[]:JSON.parse(raw);
    if (proof.hasSourceKey!==(raw!==null) || !Array.isArray(projects))
      return {reason:'legacy_projects_source_changed_during_capture'};
    return {inventory,raw,projects,sourceFingerprint:proof.sourceFingerprint};
  }

  // Explicit preview-host-only, V1-backed Projects collection seed. This
  // adds one record per Project to an isolated V2 store and commits the
  // receipt+source evidence in that SAME IndexedDB transaction. Never clear
  // earlier evidence or rewrite the separately authoritative V1 Projects key.
  async function rehearsePreviewProjectsCollectionSeed(sourceToken,actionId) {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,committed:false,confirmedDurable:false,
      collectionParityVerified:false,projectsMigrated:false,
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof sourceToken!=='string' || !sourceToken)
      return refuse('full_origin_token_required');
    if (typeof actionId!=='string' || !actionId || actionId.length>128)
      return refuse('projects_preview_action_id_required');
    const generation=currentGeneration({create:false});
    if (!generation) return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const sourceCurrent=()=>isDarkEnabled()
      && epoch===darkMirrorModeEpoch
      && currentGeneration({create:false})===generation
      && captureReadOnlyFullStorageInventory()===sourceToken;
    let captured;
    try {
      if (!sourceCurrent()) return refuse('full_origin_changed');
      captured=await capturePreviewProjectsSnapshot();
      if (captured.reason) return refuse(captured.reason,{
        prerequisiteReason:captured.prerequisiteReason
      });
      if (captured.inventory!==sourceToken || !sourceCurrent())
        return refuse('legacy_projects_source_changed_during_capture');
    } catch (_) { return refuse('legacy_projects_source_unreadable'); }
    const {projects,sourceFingerprint,raw}=captured;
    const target=projects.map((value,legacyIndex)=>({
      id:value.id,legacyIndex,value
    }));
    // A single bounded seed transaction never partially migrates a source.
    if (projects.length>2048 || JSON.stringify(target).length>2097152)
      return refuse('projects_preview_seed_too_large');
    const sourceInventory=fnv1a(sourceToken)+':'+sourceToken.length;
    const receiptId='projects-preview-seed:'+actionId;
    const receipt={
      id:receiptId,type:'projects-preview-seed',
      resetGeneration:generation,sourceInventory,sourceFingerprint,
      projectCount:projects.length,sourcePresent:raw!==null
    };
    const evidence={
      id:'projects-preview',schemaVersion:1,resetGeneration:generation,
      sourceInventory,sourceFingerprint,sourcePresent:raw!==null,
      projectCount:projects.length,receiptId,capturedAtISO:nowIso()
    };
    let db,initialRows,initialEvidence,initialMeta;
    try {
      db=await open();
      if (!db) return refuse('v2_unavailable');
      const tx=db.transaction(['projects','meta'],'readonly');
      [initialRows,initialEvidence,initialMeta]=await Promise.all([
        requestPromise(tx.objectStore('projects').getAll()),
        requestPromise(tx.objectStore('meta').get('projects-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID))
      ]);
    } catch (_) { return refuse('projects_preview_read_unavailable'); }
    if (!initialMeta || initialMeta.schemaVersion!==SCHEMA_VERSION
      || initialMeta.resetGeneration!==generation
      || initialMeta.legacyMissing===true)
      return refuse('pilot_meta_not_ready');
    if (initialEvidence) {
      // Never infer valid V2 state from source metadata alone. A later source
      // edit remains V1-only until a separate explicit reconcile operation.
      if (initialEvidence.resetGeneration!==generation
        || initialEvidence.schemaVersion!==1
        || initialEvidence.sourceFingerprint!==sourceFingerprint
        || initialEvidence.sourceInventory!==sourceInventory
        || initialEvidence.sourcePresent!==(raw!==null)
        || initialEvidence.projectCount!==projects.length)
        return refuse('projects_preview_existing_evidence_preserved');
      if (stableJson(initialRows.slice().sort((a,b)=>a.legacyIndex-b.legacyIndex))
        !==stableJson(target))
        return refuse('projects_preview_existing_evidence_preserved');
    } else if (initialRows.length) {
      return refuse('projects_preview_orphaned_records_preserved');
    }
    try { if (!sourceCurrent()) return refuse('legacy_projects_changed_before_seed'); }
    catch (_) { return refuse('legacy_projects_source_unreadable'); }
    if (!initialEvidence) {
      let failure=null;
      const abort=(tx,reason)=>{failure=reason;try{tx.abort();}catch(_){}};
      try {
        const tx=db.transaction(['projects','mutations','meta'],'readwrite');
        const projectStore=tx.objectStore('projects');
        const metaStore=tx.objectStore('meta');
        const mutationStore=tx.objectStore('mutations');
        const reads=[
          projectStore.getAll(),metaStore.get('projects-preview'),
          metaStore.get(RUNTIME_META_ID),mutationStore.get(receiptId)
        ];
        const values=new Array(reads.length);
        let outstanding=reads.length;
        reads.forEach((req,index)=>{req.onsuccess=()=>{
          values[index]=req.result;
          if (--outstanding!==0) return;
          try {
            if (!sourceCurrent()) return abort(tx,'legacy_projects_changed_under_transaction');
            if (stableJson(values[0])!==stableJson(initialRows)
              || stableJson(values[1])!==stableJson(initialEvidence)
              || stableJson(values[2])!==stableJson(initialMeta)
              || values[3])
              return abort(tx,'projects_preview_concurrent_change');
            for (const row of target) projectStore.add(row);
            mutationStore.add(receipt);
            metaStore.add(evidence);
          } catch (_) { abort(tx,'projects_preview_atomic_seed_failed'); }
        };});
        await transactionPromise(tx);
      } catch (_) { return refuse(failure||'projects_preview_atomic_seed_failed'); }
    }

    // Independent complete readback of Projects records, evidence, receipt
    // and runtime epoch. A durable write with later source drift is reported
    // as uncertain instead of authorizing parity or a V2 read cutover.
    try {
      const tx=db.transaction(['projects','mutations','meta'],'readonly');
      const [rows,storedEvidence,storedMeta,storedReceipt]=await Promise.all([
        requestPromise(tx.objectStore('projects').getAll()),
        requestPromise(tx.objectStore('meta').get('projects-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').get(
          initialEvidence?initialEvidence.receiptId:receiptId))
      ]);
      const order=rows.slice().sort((a,b)=>a.legacyIndex-b.legacyIndex);
      const expectedReceipt=initialEvidence
        ? {id:initialEvidence.receiptId,type:'projects-preview-seed',
          resetGeneration:generation,sourceInventory,sourceFingerprint,
          projectCount:projects.length,sourcePresent:raw!==null}
        : receipt;
      if (stableJson(order)!==stableJson(target)
        || stableJson(storedEvidence)!==stableJson(initialEvidence||evidence)
        || stableJson(storedMeta)!==stableJson(initialMeta)
        || stableJson(storedReceipt)!==stableJson(expectedReceipt))
        return refuse('projects_preview_readback_unverified',{
          committed:!initialEvidence,writeOutcomeUncertain:true
        });
      if (!sourceCurrent()) return refuse('legacy_projects_changed_after_seed',{
        committed:!initialEvidence,confirmedDurable:true,writeOutcomeUncertain:true
      });
      return {
        checked:true,previewOnly:true,committed:!initialEvidence,
        confirmedDurable:true,collectionParityVerified:true,
        projectsMigrated:false,projectCount:projects.length,
        reason:initialEvidence?'projects_preview_already_verified'
          :'projects_preview_seed_verified',
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    } catch (_) {
      return refuse('projects_preview_readback_unavailable',{
        committed:!initialEvidence,writeOutcomeUncertain:true
      });
    }
  }

  // Read-only, independent V1-vs-V2 Projects parity. This cannot certify
  // source authority or safe future writes because old tabs remain unfenced.
  async function inspectPreviewProjectsCollectionParity() {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,match:false,
      projectsMigrated:false,canPromote:false,
      productionWritersFenced:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    const generation=currentGeneration({create:false});
    if (!generation) return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    let source;
    try {
      source=await capturePreviewProjectsSnapshot();
      if (source.reason) return refuse('projects_source_preflight_required',{
        prerequisiteReason:source.prerequisiteReason||source.reason
      });
    } catch (_) { return refuse('legacy_projects_source_unreadable'); }
    const current=()=>isDarkEnabled()
      && epoch===darkMirrorModeEpoch
      && currentGeneration({create:false})===generation
      && captureReadOnlyFullStorageInventory()===source.inventory;
    try { if (!current()) return refuse('legacy_projects_changed_before_parity'); }
    catch (_) { return refuse('legacy_projects_source_unreadable'); }
    const expected=source.projects.map((value,legacyIndex)=>({
      id:value.id,legacyIndex,value
    }));
    const inventorySignature=fnv1a(source.inventory)+':'+source.inventory.length;
    let rows,evidence,meta,receipts;
    try {
      const db=await open();
      if (!db) return refuse('v2_unavailable');
      // One readonly transaction prevents mixing Project rows, metadata
      // and receipts from different V2 revisions during a parity decision.
      const tx=db.transaction(['projects','mutations','meta'],'readonly');
      [rows,evidence,meta,receipts]=await Promise.all([
        requestPromise(tx.objectStore('projects').getAll()),
        requestPromise(tx.objectStore('meta').get('projects-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').getAll())
      ]);
      if (!evidence) return refuse('projects_preview_missing');
    } catch (_) { return refuse('projects_preview_read_unavailable'); }
    try {
      if (!current()) return refuse('legacy_projects_changed_during_parity');
      if (!meta || meta.schemaVersion!==SCHEMA_VERSION
        || meta.resetGeneration!==generation || meta.legacyMissing===true)
        return refuse('pilot_meta_not_ready');
      if (evidence.schemaVersion!==1 || evidence.resetGeneration!==generation
        || evidence.sourceInventory!==inventorySignature
        || evidence.sourceFingerprint!==source.sourceFingerprint
        || evidence.sourcePresent!==(source.raw!==null)
        || evidence.projectCount!==expected.length)
        return refuse('projects_preview_source_stale');
      const ordered=rows.slice().sort((a,b)=>a.legacyIndex-b.legacyIndex);
      if (stableJson(ordered)!==stableJson(expected))
        return refuse('projects_preview_record_mismatch',{
          expectedCount:expected.length,actualCount:rows.length
        });
      const receipt=receipts.find(row=>row?.id===evidence.receiptId);
      if (!receipt || receipt.id!==evidence.receiptId
        || !['projects-preview-seed','projects-preview-reconcile']
          .includes(receipt.type)
        || receipt.resetGeneration!==generation
        || receipt.sourceInventory!==inventorySignature
        || receipt.sourceFingerprint!==source.sourceFingerprint
        || receipt.sourcePresent!==(source.raw!==null)
        || receipt.projectCount!==expected.length)
        return refuse('projects_preview_receipt_missing_or_invalid');
      if (receipt.type==='projects-preview-reconcile') {
        const parent=receipts.find(row=>row?.id===receipt.priorReceiptId);
        if (!parent || parent.id===receipt.id
          || !['projects-preview-seed','projects-preview-reconcile']
            .includes(parent.type)
          || parent.resetGeneration!==generation
          || receipt.nextFingerprint!==evidence.sourceFingerprint
          || receipt.nextCount!==evidence.projectCount
          || receipt.priorFingerprint!==parent.sourceFingerprint
          || receipt.priorCount!==parent.projectCount)
          return refuse('projects_preview_receipt_chain_invalid');
      }
      if (!current()) return refuse('legacy_projects_changed_after_parity');
      return {
        checked:true,previewOnly:true,match:true,
        projectCount:expected.length,hasSourceKey:source.raw!==null,
        projectsMigrated:false,reason:'projects_preview_parity_verified',
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    } catch (_) { return refuse('projects_preview_parity_unreadable'); }
  }


  // Explicit PREVIEW ONLY: reconcile edits/additions/removals/reordering of
  // Projects after an intact V4 seed. The last durable V2 source proof must
  // match EVERY existing row before any overwrite or deletion is attempted.
  // Unrecognized V2-only rows/metadata, malformed V1 or lost receipts refuse.

  // Preview-only independent Projects evidence; no V1 reads, writes or restore.
  async function inspectPreviewProjectsRecoveryEvidence(){
    const deny=reason=>({
      checked:true,previewOnly:true,evidenceVerified:false,
      sourceCompared:false,safeToRestore:false,projectsMigrated:false,
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',reason
    });
    if(!isWalTestPreviewHost())return deny('preview_host_required');
    if(!isDarkEnabled())return deny('dark_disabled');
    const generation=currentGeneration({create:false}),epoch=darkMirrorModeEpoch;
    if(!generation)return deny('generation_unavailable');
    const stable=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&darkMirrorModeEpoch===epoch
      &&currentGeneration({create:false})===generation;
    const sha=s=>typeof s==='string'&&/^sha256:[a-f0-9]{64}:\d+$/.test(s);
    const origin=s=>typeof s==='string'&&/^[a-f0-9]{8}:\d+$/.test(s);
    const count=n=>Number.isSafeInteger(n)&&n>=0&&n<=2048;
    const read=async db=>{
      const tx=db.transaction(['projects','mutations','meta'],'readonly');
      const [rows,evidence,meta,mutations]=await Promise.all([
        requestPromise(tx.objectStore('projects').getAll()),
        requestPromise(tx.objectStore('meta').get('projects-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').getAll())
      ]);
      return {rows,evidence,meta,receipts:mutations.filter(r=>
        typeof r?.id==='string'&&r.id.startsWith('projects-preview-'))};
    };
    try{
      const db=await open();
      if(!db)return deny('v2_unavailable');
      const saved=await read(db),{rows,evidence,meta,receipts}=saved;
      if(!meta||meta.schemaVersion!==SCHEMA_VERSION
        ||meta.resetGeneration!==generation||meta.legacyMissing===true)
        return deny('pilot_meta_not_ready');
      if(!evidence||evidence.id!=='projects-preview'
        ||evidence.schemaVersion!==1||evidence.resetGeneration!==generation
        ||!origin(evidence.sourceInventory)||!sha(evidence.sourceFingerprint)
        ||typeof evidence.sourcePresent!=='boolean'
        ||!count(evidence.projectCount)||evidence.projectCount!==rows.length
        ||(!evidence.sourcePresent&&evidence.projectCount!==0)
        ||typeof evidence.receiptId!=='string')
        return deny('projects_preview_evidence_invalid');
      const ordered=rows.slice().sort((a,b)=>a.legacyIndex-b.legacyIndex);
      const ids=new Set();
      for(let i=0;i<ordered.length;i++){
        const row=ordered[i],value=row?.value;
        if(!row||typeof row.id!=='string'||!row.id||row.id.length>128
          ||ids.has(row.id)||row.legacyIndex!==i||!value
          ||typeof value!=='object'||Array.isArray(value)
          ||row.id!==value.id)
          return deny('projects_preview_records_invalid');
        ids.add(row.id);
        if(value.subtasks!=null){
          if(!Array.isArray(value.subtasks))
            return deny('projects_preview_subtasks_invalid');
          const subids=new Set();
          for(const x of value.subtasks){
            if(!x||typeof x!=='object'||Array.isArray(x)
              ||typeof x.id!=='string'||!x.id||x.id.length>128
              ||subids.has(x.id))
              return deny('projects_preview_subtasks_invalid');
            subids.add(x.id);
          }
        }
      }
      const digest=await previewRecoveryFingerprint(ordered.map(x=>x.value));
      if(digest!==evidence.sourceFingerprint)
        return deny('projects_preview_records_digest_mismatch');
      if(!receipts.length||receipts.length>2048)
        return deny('projects_preview_receipts_invalid');
      const byId=new Map();
      for(const r of receipts){
        if(!r||typeof r.id!=='string'||byId.has(r.id)
          ||!['projects-preview-seed','projects-preview-reconcile'].includes(r.type)
          ||!r.id.startsWith(r.type+':')||r.resetGeneration!==generation
          ||!origin(r.sourceInventory)||!sha(r.sourceFingerprint)
          ||typeof r.sourcePresent!=='boolean'||!count(r.projectCount)
          ||(!r.sourcePresent&&r.projectCount!==0))
          return deny('projects_preview_receipt_invalid');
        byId.set(r.id,r);
      }
      let step=byId.get(evidence.receiptId);
      if(!step||step.sourceInventory!==evidence.sourceInventory
        ||step.sourceFingerprint!==evidence.sourceFingerprint
        ||step.sourcePresent!==evidence.sourcePresent
        ||step.projectCount!==evidence.projectCount)
        return deny('projects_preview_head_receipt_invalid');
      const visited=new Set();
      while(step){
        if(visited.has(step.id))return deny('projects_preview_receipt_cycle');
        visited.add(step.id);
        if(step.type==='projects-preview-seed'){
          if(step.priorReceiptId!==undefined||step.priorFingerprint!==undefined
            ||step.priorCount!==undefined||step.nextFingerprint!==undefined
            ||step.nextCount!==undefined)
            return deny('projects_preview_receipt_chain_invalid');
          break;
        }
        const parent=byId.get(step.priorReceiptId);
        if(!parent||parent.id===step.id||!sha(step.priorFingerprint)
          ||step.priorFingerprint!==parent.sourceFingerprint
          ||step.priorCount!==parent.projectCount
          ||step.nextFingerprint!==step.sourceFingerprint
          ||step.nextCount!==step.projectCount
          ||!Array.isArray(step.changedIds)||!Array.isArray(step.deletedIds)
          ||step.changedIds.length+step.deletedIds.length>64
          ||new Set(step.changedIds).size!==step.changedIds.length
          ||new Set(step.deletedIds).size!==step.deletedIds.length
          ||step.changedIds.some(id=>typeof id!=='string'||!id)
          ||step.deletedIds.some(id=>typeof id!=='string'||!id))
          return deny('projects_preview_receipt_chain_invalid');
        step=parent;
      }
      if(visited.size!==receipts.length)
        return deny('projects_preview_orphan_receipts');
      const again=await read(db);
      if(!stable()||stableJson(again)!==stableJson(saved))
        return deny('projects_preview_evidence_changed_during_inspection');
      return {...deny('projects_preview_recovery_evidence_verified'),
        evidenceVerified:true,projectCount:rows.length,
        sourcePresent:evidence.sourcePresent,receiptCount:visited.size};
    }catch(_){return deny('projects_preview_recovery_unavailable');}
  }

  async function rehearsePreviewProjectsCollectionReconcile(sourceToken,actionId) {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,committed:false,confirmedDurable:false,
      collectionParityVerified:false,projectsMigrated:false,
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof sourceToken!=='string' || !sourceToken)
      return refuse('full_origin_token_required');
    if (typeof actionId!=='string' || !actionId || actionId.length>128)
      return refuse('projects_preview_action_id_required');
    const generation=currentGeneration({create:false});
    if (!generation) return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const sourceCurrent=()=>isDarkEnabled()
      && epoch===darkMirrorModeEpoch
      && currentGeneration({create:false})===generation
      && captureReadOnlyFullStorageInventory()===sourceToken;
    let source;
    try {
      if (!sourceCurrent()) return refuse('full_origin_changed');
      source=await capturePreviewProjectsSnapshot();
      if (source.reason) return refuse(source.reason,{
        prerequisiteReason:source.prerequisiteReason
      });
      if (source.inventory!==sourceToken || !sourceCurrent())
        return refuse('legacy_projects_changed_during_capture');
    } catch (_) { return refuse('legacy_projects_source_unreadable'); }

    const target=source.projects.map((value,legacyIndex)=>({
      id:value.id,legacyIndex,value
    }));
    if (target.length>2048 || JSON.stringify(target).length>2097152)
      return refuse('projects_preview_reconcile_source_too_large');
    const nextInventory=fnv1a(sourceToken)+':'+sourceToken.length;
    let db, oldRows, oldEvidence, runtimeMeta, oldReceipt, actionReceipt;
    const receiptId='projects-preview-reconcile:'+actionId;
    try {
      db=await open();
      if (!db) return refuse('v2_unavailable');
      const tx=db.transaction(['projects','mutations','meta'],'readonly');
      [oldRows,oldEvidence,runtimeMeta,actionReceipt]=await Promise.all([
        requestPromise(tx.objectStore('projects').getAll()),
        requestPromise(tx.objectStore('meta').get('projects-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').get(receiptId))
      ]);
      if (!oldEvidence) return refuse('projects_preview_seed_required');
      if (typeof oldEvidence.receiptId!=='string'
        || !oldEvidence.receiptId)
        return refuse('projects_preview_provenance_invalid');
      const receiptTx=db.transaction('mutations','readonly');
      oldReceipt=await requestPromise(
        receiptTx.objectStore('mutations').get(oldEvidence.receiptId));
    } catch (_) { return refuse('projects_preview_reconcile_read_unavailable'); }
    if (!runtimeMeta || runtimeMeta.schemaVersion!==SCHEMA_VERSION
      || runtimeMeta.resetGeneration!==generation
      || runtimeMeta.legacyMissing===true)
      return refuse('pilot_meta_not_ready');
    if (actionReceipt) return refuse('projects_preview_action_id_conflict');
    if (oldEvidence.schemaVersion!==1
      || oldEvidence.resetGeneration!==generation
      || typeof oldEvidence.sourceFingerprint!=='string'
      || typeof oldEvidence.sourceInventory!=='string'
      || typeof oldEvidence.projectCount!=='number'
      || typeof oldEvidence.sourcePresent!=='boolean'
      || oldEvidence.projectCount!==oldRows.length
      || !oldReceipt
      || oldReceipt.id!==oldEvidence.receiptId
      || !['projects-preview-seed','projects-preview-reconcile']
        .includes(oldReceipt.type)
      || oldReceipt.resetGeneration!==generation
      || oldReceipt.sourceInventory!==oldEvidence.sourceInventory
      || oldReceipt.sourceFingerprint!==oldEvidence.sourceFingerprint
      || oldReceipt.sourcePresent!==oldEvidence.sourcePresent
      || oldReceipt.projectCount!==oldEvidence.projectCount
      || (oldReceipt.type==='projects-preview-reconcile'
        && (oldReceipt.nextFingerprint!==oldEvidence.sourceFingerprint
          || oldReceipt.nextCount!==oldEvidence.projectCount
          || oldReceipt.priorReceiptId===oldReceipt.id)))
      return refuse('projects_preview_provenance_invalid');

    // Require contiguous order, complete IDs and exact old SHA digest.
    // This detects a stale or tampered V2-only write even if a source
    // edit would otherwise replace that same record.
    const previous=oldRows.slice().sort((a,b)=>a.legacyIndex-b.legacyIndex);
    const ids=new Set();
    for (let index=0;index<previous.length;index+=1) {
      const row=previous[index];
      if (!row || typeof row.id!=='string' || !row.id
        || ids.has(row.id) || row.legacyIndex!==index
        || !row.value || typeof row.value!=='object'
        || Array.isArray(row.value) || row.value.id!==row.id)
        return refuse('projects_preview_existing_records_invalid');
      ids.add(row.id);
    }
    let oldFingerprint;
    try {
      oldFingerprint=await previewRecoveryFingerprint(previous.map(r=>r.value));
    } catch (_) { return refuse('projects_preview_existing_digest_unavailable'); }
    if (oldFingerprint!==oldEvidence.sourceFingerprint)
      return refuse('projects_preview_existing_parity_mismatch');
    try { if (!sourceCurrent()) return refuse('legacy_projects_changed_during_reconcile'); }
    catch (_) { return refuse('legacy_projects_source_unreadable'); }

    const priorById=new Map(previous.map(r=>[r.id,r]));
    const wantedIds=new Set(target.map(r=>r.id));
    const changed=target.filter(row=>stableJson(priorById.get(row.id))!==stableJson(row));
    const removed=previous.filter(row=>!wantedIds.has(row.id));
    const added=changed.filter(row=>!priorById.has(row.id));
    const deltaCount=changed.length+removed.length;
    // Even an unchanged collection must re-check *live* V2 parity rather
    // than accepting evidence read before an asynchronous digest.
    if (!deltaCount && oldEvidence.sourceInventory===nextInventory
      && oldEvidence.sourcePresent===(source.raw!==null)
      && oldEvidence.sourceFingerprint===source.sourceFingerprint) {
      const live=await inspectPreviewProjectsCollectionParity();
      if (!live.match) return refuse('projects_preview_reconcile_noop_parity_mismatch',{
        prerequisiteReason:live.reason
      });
      try { if (!sourceCurrent()) return refuse('legacy_projects_changed_after_noop'); }
      catch (_) { return refuse('legacy_projects_source_unreadable'); }
      return {
        checked:true,previewOnly:true,committed:false,confirmedDurable:true,
        collectionParityVerified:true,projectsMigrated:false,
        changedRows:0,addedRows:0,deletedRows:0,
        reason:'projects_preview_already_current',canPromote:false,
        productionWritersFenced:false,readAuthority:'legacy_only',
        mutationAuthority:'legacy_only'
      };
    }
    if (deltaCount>64) return refuse('projects_preview_reconcile_batch_too_large',{
      changedRows:deltaCount,maxAtomicRows:64
    });
    const affectedBytes=changed.concat(removed).reduce(
      (total,row)=>total+JSON.stringify(row).length,0);
    if (affectedBytes>262144)
      return refuse('projects_preview_reconcile_payload_too_large');
    const receipt={
      id:receiptId,type:'projects-preview-reconcile',
      resetGeneration:generation,sourceInventory:nextInventory,
      sourceFingerprint:source.sourceFingerprint,
      projectCount:target.length,sourcePresent:source.raw!==null,
      priorReceiptId:oldEvidence.receiptId,
      priorFingerprint:oldFingerprint,nextFingerprint:source.sourceFingerprint,
      priorCount:previous.length,nextCount:target.length,
      changedIds:changed.map(r=>r.id),deletedIds:removed.map(r=>r.id)
    };
    const evidence={
      id:'projects-preview',schemaVersion:1,resetGeneration:generation,
      sourceInventory:nextInventory,
      sourceFingerprint:source.sourceFingerprint,
      sourcePresent:source.raw!==null,projectCount:target.length,
      receiptId,capturedAtISO:nowIso()
    };
    try { if (!sourceCurrent()) return refuse('legacy_projects_changed_before_write'); }
    catch (_) { return refuse('legacy_projects_source_unreadable'); }

    let failure=null;
    const abort=(tx,reason)=>{failure=reason;try{tx.abort();}catch(_){}};
    try {
      const tx=db.transaction(['projects','mutations','meta'],'readwrite');
      const projectStore=tx.objectStore('projects');
      const mutationStore=tx.objectStore('mutations');
      const metaStore=tx.objectStore('meta');
      const reads=[
        projectStore.getAll(),metaStore.get('projects-preview'),
        metaStore.get(RUNTIME_META_ID),
        mutationStore.get(oldEvidence.receiptId),mutationStore.get(receiptId)
      ];
      const values=new Array(reads.length);
      let remaining=reads.length;
      reads.forEach((request,index)=>{request.onsuccess=()=>{
        values[index]=request.result;
        if (--remaining!==0) return;
        try {
          if (!sourceCurrent())
            return abort(tx,'legacy_projects_changed_under_transaction');
          if (stableJson(values[0])!==stableJson(oldRows)
            || stableJson(values[1])!==stableJson(oldEvidence)
            || stableJson(values[2])!==stableJson(runtimeMeta)
            || stableJson(values[3])!==stableJson(oldReceipt)
            || values[4])
            return abort(tx,'projects_preview_reconcile_concurrent_change');
          for (const row of removed) projectStore.delete(row.id);
          for (const row of changed) projectStore.put(row);
          mutationStore.add(receipt);
          metaStore.put(evidence);
        } catch (_) { abort(tx,'projects_preview_reconcile_atomic_write_failed'); }
      };});
      await transactionPromise(tx);
    } catch (_) { return refuse(failure||'projects_preview_reconcile_atomic_write_failed'); }

    // All three stores must match in one fresh read. Do not return green
    // parity after a later V1 writer changes the source during verification.
    try {
      const tx=db.transaction(['projects','mutations','meta'],'readonly');
      const [rows,storedEvidence,storedMeta,storedReceipt]=await Promise.all([
        requestPromise(tx.objectStore('projects').getAll()),
        requestPromise(tx.objectStore('meta').get('projects-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('mutations').get(receiptId))
      ]);
      if (stableJson(rows.slice().sort((a,b)=>a.legacyIndex-b.legacyIndex))
          !==stableJson(target)
        || stableJson(storedEvidence)!==stableJson(evidence)
        || stableJson(storedMeta)!==stableJson(runtimeMeta)
        || stableJson(storedReceipt)!==stableJson(receipt))
        return refuse('projects_preview_reconcile_readback_unverified',{
          committed:true,writeOutcomeUncertain:true
        });
      if (!sourceCurrent()) return refuse('legacy_projects_changed_after_commit',{
        committed:true,confirmedDurable:true,writeOutcomeUncertain:true
      });
      const parity=await inspectPreviewProjectsCollectionParity();
      if (!parity.match) return refuse('projects_preview_reconcile_parity_unverified',{
        prerequisiteReason:parity.reason,
        committed:true,confirmedDurable:true,writeOutcomeUncertain:true
      });
      if (!sourceCurrent()) return refuse('legacy_projects_changed_after_parity',{
        committed:true,confirmedDurable:true,writeOutcomeUncertain:true
      });
      return {
        checked:true,previewOnly:true,committed:true,confirmedDurable:true,
        collectionParityVerified:true,projectsMigrated:false,
        projectCount:target.length,changedRows:deltaCount,
        addedRows:added.length,deletedRows:removed.length,
        reason:'projects_preview_reconciled',canPromote:false,
        productionWritersFenced:false,readAuthority:'legacy_only',
        mutationAuthority:'legacy_only'
      };
    } catch (_) { return refuse('projects_preview_reconcile_readback_unavailable',{
      committed:true,writeOutcomeUncertain:true
    }); }
  }

  async function rehearsePreviewTaskCollectionSeed() {
    const refuse = (reason, detail = {}) => ({
      checked: true, previewOnly: true, verified: false, stored: false,
      canPromote: false, productionWritersFenced: false,
      mutationAuthority: 'legacy_only', readAuthority: 'legacy_only',
      reason, ...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof core.readTaskPointsStoredState !== 'function'
      || typeof core.readPendingTaskMutations !== 'function')
      return refuse('legacy_task_reader_unavailable');
    const expectedEpoch = darkMirrorModeEpoch;
    const generation = currentGeneration({ create: false });
    if (!generation) return refuse('generation_unavailable');
    let inventoryBefore, inventoryAfter, tasks, taskSignature;
    try {
      inventoryBefore = captureReadOnlyFullStorageInventory();
      const pending = core.readPendingTaskMutations();
      if (pending?.malformed) return refuse('legacy_task_journal_malformed');
      const state = core.readTaskPointsStoredState();
      if (!state || !Array.isArray(state.tasks))
        return refuse('legacy_tasks_missing');
      tasks = clone(state.tasks);
      const ids = new Set();
      for (const task of tasks) {
        if (!task || typeof task !== 'object' || Array.isArray(task)
          || task.id == null || String(task.id) === ''
          || ids.has(String(task.id))) return refuse('legacy_task_ids_invalid');
        ids.add(String(task.id));
      }
      taskSignature = stableJson(tasks);
      inventoryAfter = captureReadOnlyFullStorageInventory();
    } catch (_) { return refuse('legacy_task_capture_unreadable'); }
    if (inventoryBefore !== inventoryAfter)
      return refuse('legacy_changed_during_capture');
    let taskFingerprint;
    try { taskFingerprint = await previewRecoveryFingerprint(tasks); }
    catch (_) { return refuse('task_fingerprint_unavailable'); }
    const stillSameSource = () => {
      if (!isDarkEnabled() || darkMirrorModeEpoch !== expectedEpoch
        || currentGeneration({ create: false }) !== generation) return false;
      return captureReadOnlyFullStorageInventory() === inventoryBefore;
    };
    try { if (!stillSameSource()) return refuse('legacy_changed_before_seed'); }
    catch (_) { return refuse('legacy_unreadable_before_seed'); }
    let db, initialMeta;
    try {
      db = await open();
      if (!db) return refuse('dark_disabled');
      initialMeta = await readMeta(db);
    } catch (_) { return refuse('task_preview_db_unavailable'); }
    if (initialMeta?.schemaVersion !== SCHEMA_VERSION
      || initialMeta.resetGeneration !== generation
      || initialMeta.legacyMissing === true)
      return refuse('pilot_meta_not_ready');
    try { if (!stillSameSource()) return refuse('legacy_changed_before_seed'); }
    catch (_) { return refuse('legacy_unreadable_before_seed'); }
    let priorEvidence = null, unownedTaskRows = [], lifecycleCursor = null;
    try {
      const tx = db.transaction(['tasks','meta'], 'readonly');
      [priorEvidence,unownedTaskRows,lifecycleCursor] = await Promise.all([
        requestPromise(tx.objectStore('meta').get('task-preview')),
        requestPromise(tx.objectStore('tasks').getAll()),
        requestPromise(tx.objectStore('meta').get('task-preview-lifecycle-state'))
      ]);
    } catch (_) { return refuse('task_preview_evidence_unreadable'); }
    // An older preview experiment may have written a Task record without
    // the Task collection seed receipt. Never clear unowned preview bytes
    // during the optional live-Task mirror's first seed.
    if (!priorEvidence && (unownedTaskRows.length || lifecycleCursor))
      return refuse('task_preview_unowned_rows_preserved');
    const sameEvidence = priorEvidence?.resetGeneration === generation
      && priorEvidence?.taskFingerprint === taskFingerprint
      && priorEvidence?.sourceInventory === `${fnv1a(inventoryBefore)}:${inventoryBefore.length}`;
    if (priorEvidence && !sameEvidence)
      return refuse('task_preview_existing_evidence_preserved');
    if (!priorEvidence) {
      let commitError = null;
      try {
        if (!stillSameSource()) return refuse('legacy_changed_before_seed');
        const tx = db.transaction(['tasks','meta'], 'readwrite');
        const metaStore = tx.objectStore('meta');
        const req = metaStore.get(RUNTIME_META_ID);
        const evidenceReq = metaStore.get('task-preview');
        const rowsReq = tx.objectStore('tasks').getAll();
        const lifecycleReq = metaStore.get('task-preview-lifecycle-state');
        let have = 0, currentMeta, currentEvidence, currentRows, currentLifecycle;
        const check = () => {
          if (++have !== 4) return;
          if (stableJson(currentMeta || null) !== stableJson(initialMeta)
            || currentEvidence || currentRows?.length || currentLifecycle
            || !isDarkEnabled()
            || darkMirrorModeEpoch !== expectedEpoch
            || currentGeneration({ create: false }) !== generation) {
            commitError = 'task_preview_concurrent_conflict';
            try { tx.abort(); } catch (_) {}
            return;
          }
          try {
            if (!stillSameSource()) {
              commitError = 'legacy_changed_before_commit';
              tx.abort(); return;
            }
            const store = tx.objectStore('tasks');
            store.clear();
            tasks.forEach((task,index) =>
              store.put({id:String(task.id),legacyIndex:index,value:task}));
            metaStore.put({
              id:'task-preview', schemaVersion:1, resetGeneration:generation,
              taskFingerprint, sourceInventory:
                // This digest is metadata only, never authority proof.
                `${fnv1a(inventoryBefore)}:${inventoryBefore.length}`,
              taskCount:tasks.length, capturedAtISO:nowIso()
            });
          } catch (_) {
            commitError = 'task_preview_write_failed';
            try { tx.abort(); } catch (_) {}
          }
        };
        req.onsuccess = () => { currentMeta=req.result; check(); };
        evidenceReq.onsuccess = () => { currentEvidence=evidenceReq.result; check(); };
        rowsReq.onsuccess = () => { currentRows=rowsReq.result; check(); };
        lifecycleReq.onsuccess = () => { currentLifecycle=lifecycleReq.result; check(); };
        await transactionPromise(tx);
      } catch (_) { return refuse(commitError || 'task_preview_write_failed'); }
    }
    // Every success claim is backed by a NEW, read-only IDB readback and
    // source verification. A concurrent V1 edit during IDB commit keeps
    // the preview evidence, but the returned status refuses current parity.
    try {
      const tx = db.transaction(['tasks','meta'], 'readonly');
      const storedReq = tx.objectStore('tasks').getAll();
      const evidenceReq = tx.objectStore('meta').get('task-preview');
      const [rows, evidence] = await Promise.all([
        requestPromise(storedReq), requestPromise(evidenceReq)
      ]);
      const ordered = rows.slice()
        .sort((a,b)=>a.legacyIndex-b.legacyIndex)
        .map(row=>row.value);
      if (stableJson(ordered) !== taskSignature
        || evidence?.taskFingerprint !== taskFingerprint
        || evidence?.resetGeneration !== generation
        || evidence?.taskCount !== tasks.length)
        return refuse('task_preview_readback_mismatch');
      if (!stillSameSource()) return refuse('legacy_changed_after_seed');
      return {
        checked:true, previewOnly:true, verified:true,
        stored:priorEvidence == null, reason:priorEvidence
          ? 'task_preview_already_verified' : 'task_preview_seed_verified',
        taskCount:tasks.length, taskFingerprint,
        resetGeneration:generation,
        canPromote:false, productionWritersFenced:false,
        mutationAuthority:'legacy_only', readAuthority:'legacy_only'
      };
    } catch (_) { return refuse('task_preview_readback_failed'); }
  }

  // PREVIEW ONLY: reconcile an already-seeded Task collection after a real
  // V1 save/journal update. Unlike the initial Task seed, this changes ONLY
  // affected records and atomically advances the source evidence + receipt.
  // Never repair an unexplained V2 mismatch or overwrite preview-only edits.
  // V1 retains all read, mutation, import/export and recovery authority.
  async function rehearsePreviewTaskCollectionReconcile(sourceToken, actionId) {
    const refuse = (reason, detail = {}) => ({
      checked: true, previewOnly: true, committed: false,
      confirmedDurable: false, collectionParityVerified: false,
      canPromote: false, productionWritersFenced: false,
      readAuthority: 'legacy_only', mutationAuthority: 'legacy_only',
      reason, ...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof sourceToken !== 'string' || !sourceToken)
      return refuse('full_origin_token_required');
    if (typeof actionId !== 'string' || !actionId || actionId.length > 128)
      return refuse('task_action_id_required');
    if (typeof core.readTaskPointsStoredState !== 'function'
      || typeof core.readPendingTaskMutations !== 'function')
      return refuse('legacy_task_reader_unavailable');

    const modeEpoch = darkMirrorModeEpoch;
    const generation = currentGeneration({ create: false });
    if (!generation) return refuse('generation_unavailable');
    const sourceCurrent = () => isDarkEnabled()
      && darkMirrorModeEpoch === modeEpoch
      && currentGeneration({ create: false }) === generation
      && captureReadOnlyFullStorageInventory() === sourceToken;

    let desired, desiredFingerprint;
    try {
      if (!sourceCurrent()) return refuse('full_origin_changed');
      const pending = core.readPendingTaskMutations();
      if (pending?.malformed) return refuse('legacy_task_journal_malformed');
      const state = core.readTaskPointsStoredState();
      if (!state || !Array.isArray(state.tasks))
        return refuse('legacy_tasks_missing');
      desired = clone(state.tasks);
      const ids = new Set();
      for (const item of desired) {
        if (!item || typeof item !== 'object' || Array.isArray(item)
          || item.id == null || !String(item.id)
          || ids.has(String(item.id))) return refuse('legacy_task_ids_invalid');
        ids.add(String(item.id));
      }
      if (!sourceCurrent()) return refuse('legacy_changed_during_capture');
      desiredFingerprint = await previewRecoveryFingerprint(desired);
    } catch (_) { return refuse('legacy_task_capture_unreadable'); }
    try { if (!sourceCurrent()) return refuse('legacy_changed_before_reconcile'); }
    catch (_) { return refuse('legacy_unreadable_before_reconcile'); }

    let db, priorRows, priorEvidence, runtimeMeta, lifecycleCursor;
    try {
      db = await open();
      if (!db) return refuse('v2_unavailable');
      const tx = db.transaction(['tasks','meta'], 'readonly');
      [priorRows, priorEvidence, runtimeMeta, lifecycleCursor] = await Promise.all([
        requestPromise(tx.objectStore('tasks').getAll()),
        requestPromise(tx.objectStore('meta').get('task-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('meta').get('task-preview-lifecycle-state'))
      ]);
    } catch (_) { return refuse('task_preview_read_unavailable'); }
    if (!runtimeMeta || runtimeMeta.schemaVersion !== SCHEMA_VERSION
      || runtimeMeta.resetGeneration !== generation
      || runtimeMeta.legacyMissing === true)
      return refuse('pilot_meta_not_ready');
    if (!priorEvidence || priorEvidence.schemaVersion !== 1
      || priorEvidence.resetGeneration !== generation)
      return refuse('task_preview_source_not_seeded');
    // Existing preview-only creates/deletes have a distinct counter. Refuse
    // to rebase them as V1 changes without independently proving ownership.
    if (lifecycleCursor) return refuse('task_preview_lifecycle_evidence_preserved');

    const priorOrdered = priorRows.slice().sort((a,b)=>a.legacyIndex-b.legacyIndex);
    const oldIds = new Set();
    for (let i = 0; i < priorOrdered.length; i += 1) {
      const row = priorOrdered[i];
      if (!row || row.id == null || !String(row.id)
        || oldIds.has(String(row.id)) || row.legacyIndex !== i
        || !row.value || String(row.value.id) !== String(row.id))
        return refuse('task_preview_prior_rows_invalid');
      oldIds.add(String(row.id));
    }
    let oldFingerprint;
    try { oldFingerprint = await previewRecoveryFingerprint(priorOrdered.map(r=>r.value)); }
    catch (_) { return refuse('task_preview_old_fingerprint_unavailable'); }
    if (oldFingerprint !== priorEvidence.taskFingerprint
      || priorOrdered.length !== priorEvidence.taskCount)
      return refuse('task_preview_existing_evidence_preserved');
    try { if (!sourceCurrent()) return refuse('legacy_changed_during_reconcile'); }
    catch (_) { return refuse('legacy_unreadable_during_reconcile'); }

    const sourceSignature = `${fnv1a(sourceToken)}:${sourceToken.length}`;
    if (priorEvidence.taskFingerprint === desiredFingerprint
      && priorEvidence.sourceInventory === sourceSignature) {
      // The initial read and its SHA calculation are asynchronous. A second
      // preview tab may change V2 records while V1's source token stays
      // unchanged. Revalidate the complete live Task collection before
      // claiming that the no-op case is durably identical to V1.
      let parity;
      try { parity = await inspectPreviewTaskCollectionParity(); }
      catch (_) { return refuse('task_preview_noop_parity_unreadable'); }
      if (!parity.match) return refuse('task_preview_noop_parity_mismatch', {
        prerequisiteReason:parity.reason
      });
      try {
        if (!sourceCurrent()) return refuse('legacy_changed_after_noop_parity');
      } catch (_) { return refuse('legacy_unreadable_after_noop_parity'); }
      return {
        checked:true, previewOnly:true, committed:false,
        confirmedDurable:true, collectionParityVerified:true,
        reason:'task_preview_already_current',
        changedRows:0, taskCount:desired.length,
        canPromote:false, productionWritersFenced:false,
        readAuthority:'legacy_only', mutationAuthority:'legacy_only'
      };
    }
    const target = desired.map((task,i)=>({
      id:String(task.id),legacyIndex:i,value:task
    }));
    const oldMap = new Map(priorOrdered.map(row=>[String(row.id),row]));
    const newMap = new Map(target.map(row=>[row.id,row]));
    const removed = priorOrdered.filter(row=>!newMap.has(String(row.id)));
    const changed = target.filter(row=>
      stableJson(row)!==stableJson(oldMap.get(row.id)));
    if (removed.length + changed.length > 64)
      return refuse('task_reconcile_batch_too_large', {
        changedRows:removed.length+changed.length, maxAtomicRows:64
      });
    const nextEvidence = {
      id:'task-preview', schemaVersion:1, resetGeneration:generation,
      taskFingerprint:desiredFingerprint, sourceInventory:sourceSignature,
      taskCount:desired.length, capturedAtISO:nowIso()
    };
    const receipt = {
      id:'task-preview-reconcile:'+actionId,
      type:'task-preview-reconcile', resetGeneration:generation,
      priorTaskFingerprint:priorEvidence.taskFingerprint,
      nextTaskFingerprint:desiredFingerprint,
      sourceInventory:sourceSignature,
      removedIds:removed.map(row=>String(row.id)),
      changedIds:changed.map(row=>row.id)
    };
    let failure = null, repeated = false;
    const refuseAbort = (tx,reason) => {
      failure=reason;
      try { tx.abort(); } catch (_) {}
    };
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_before_reconcile');
      const tx=db.transaction(['tasks','mutations','meta'],'readwrite');
      const taskStore=tx.objectStore('tasks');
      const mutationStore=tx.objectStore('mutations');
      const metaStore=tx.objectStore('meta');
      const reads=[
        taskStore.getAll(),metaStore.get(RUNTIME_META_ID),
        metaStore.get('task-preview'),
        metaStore.get('task-preview-lifecycle-state'),
        mutationStore.get(receipt.id)
      ];
      const values=new Array(reads.length);
      let remaining=reads.length;
      reads.forEach((request,index)=>{
        request.onsuccess=()=>{
          values[index]=request.result;
          if (--remaining!==0) return;
          try {
            if (!sourceCurrent())
              return refuseAbort(tx,'legacy_changed_under_transaction');
            if (stableJson(values[0])!==stableJson(priorRows)
              || stableJson(values[1])!==stableJson(runtimeMeta)
              || stableJson(values[2])!==stableJson(priorEvidence)
              || stableJson(values[3])!==stableJson(lifecycleCursor))
              return refuseAbort(tx,'task_preview_concurrent_change');
            if (values[4]) {
              if (stableJson(values[4])!==stableJson(receipt))
                return refuseAbort(tx,'task_reconcile_action_id_conflict');
              repeated=true;
              return;
            }
            for (const row of removed) taskStore.delete(String(row.id));
            for (const row of changed) taskStore.put(row);
            metaStore.put(nextEvidence);
            mutationStore.add(receipt);
          } catch (_) { refuseAbort(tx,'task_reconcile_atomic_write_failed'); }
        };
      });
      await transactionPromise(tx);
    } catch (_) { return refuse(failure || 'task_reconcile_atomic_write_failed'); }
    try {
      const tx=db.transaction(['tasks','mutations','meta'],'readonly');
      const [rows,evidence,savedReceipt,postMeta]=await Promise.all([
        requestPromise(tx.objectStore('tasks').getAll()),
        requestPromise(tx.objectStore('meta').get('task-preview')),
        requestPromise(tx.objectStore('mutations').get(receipt.id)),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID))
      ]);
      const ordered=rows.slice().sort((a,b)=>a.legacyIndex-b.legacyIndex);
      if (stableJson(ordered)!==stableJson(target)
        || stableJson(evidence)!==stableJson(nextEvidence)
        || stableJson(savedReceipt)!==stableJson(receipt)
        || stableJson(postMeta)!==stableJson(runtimeMeta))
        return refuse('task_reconcile_readback_unverified',{
          committed:!repeated,writeOutcomeUncertain:true
        });
      if (!sourceCurrent()) return refuse('legacy_changed_after_preview_commit',{
        committed:!repeated,confirmedDurable:true,
        writeOutcomeUncertain:true
      });
      return {
        checked:true,previewOnly:true,committed:!repeated,
        confirmedDurable:true,collectionParityVerified:true,
        replayed:repeated,
        reason:repeated ? 'task_preview_reconcile_replayed'
          : 'task_preview_reconcile_verified',
        changedRows:removed.length+changed.length,
        addedRows:changed.filter(row=>!oldMap.has(row.id)).length,
        deletedRows:removed.length, taskCount:desired.length,
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    } catch (_) {
      return refuse('task_reconcile_readback_unavailable',{
        committed:!repeated,writeOutcomeUncertain:true
      });
    }
  }

  // Independent preview-only nonpilot Tasks parity inspector. It reads the
  // effective V1 Tasks (including pending Task journal overlays) and the
  // isolated V2 Task rows without writing, reseeding, repairing, or promoting.
  async function inspectPreviewTaskCollectionParity() {
    const refuse = (reason, detail = {}) => ({
      checked: true, previewOnly: true, match: false, reason,
      canPromote: false, productionWritersFenced: false,
      mutationAuthority: 'legacy_only', readAuthority: 'legacy_only',
      ...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof core.readTaskPointsStoredState !== 'function'
      || typeof core.readPendingTaskMutations !== 'function')
      return refuse('legacy_task_reader_unavailable');
    const expectedEpoch = darkMirrorModeEpoch;
    const generation = currentGeneration({ create: false });
    if (!generation) return refuse('generation_unavailable');
    let sourceInventory, tasks, taskFingerprint;
    try {
      sourceInventory = captureReadOnlyFullStorageInventory();
      const pending = core.readPendingTaskMutations();
      if (pending?.malformed) return refuse('legacy_task_journal_malformed');
      const state = core.readTaskPointsStoredState();
      if (!state || !Array.isArray(state.tasks))
        return refuse('legacy_tasks_missing');
      tasks = clone(state.tasks);
      const ids = new Set();
      for (const task of tasks) {
        if (!task || typeof task !== 'object' || Array.isArray(task)
          || task.id == null || !String(task.id) || ids.has(String(task.id)))
          return refuse('legacy_task_ids_invalid');
        ids.add(String(task.id));
      }
      if (captureReadOnlyFullStorageInventory() !== sourceInventory)
        return refuse('legacy_changed_during_capture');
      taskFingerprint = await previewRecoveryFingerprint(tasks);
    } catch (_) { return refuse('legacy_task_capture_unreadable'); }
    const sourceCurrent = () => isDarkEnabled()
      && darkMirrorModeEpoch === expectedEpoch
      && currentGeneration({ create: false }) === generation
      && captureReadOnlyFullStorageInventory() === sourceInventory;
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_before_inspection');
    } catch (_) { return refuse('legacy_unreadable_before_inspection'); }
    let db, rows, evidence, meta;
    try {
      db = await open();
      if (!db) return refuse('dark_disabled');
      const tx = db.transaction(['tasks', 'meta'], 'readonly');
      [rows, evidence, meta] = await Promise.all([
        requestPromise(tx.objectStore('tasks').getAll()),
        requestPromise(tx.objectStore('meta').get('task-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID))
      ]);
    } catch (_) { return refuse('task_preview_read_unavailable'); }
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_during_inspection');
      if (meta?.schemaVersion !== SCHEMA_VERSION
        || meta.resetGeneration !== generation || meta.legacyMissing === true)
        return refuse('pilot_meta_not_ready');
      if (!evidence) return refuse('task_preview_missing');
      if (evidence.schemaVersion !== 1
        || evidence.resetGeneration !== generation)
        return refuse('task_preview_generation_mismatch');
      const inventorySignature = `${fnv1a(sourceInventory)}:${sourceInventory.length}`;
      if (evidence.taskFingerprint !== taskFingerprint
        || evidence.sourceInventory !== inventorySignature)
        return refuse('task_preview_source_stale');
      if (evidence.taskCount !== tasks.length)
        return refuse('task_preview_evidence_mismatch');
      // Never accept a matching metadata fingerprint as proof of actual rows.
      const seen = new Set();
      const ordered = rows.slice().sort((a, b) => a.legacyIndex - b.legacyIndex);
      if (ordered.length !== tasks.length)
        return refuse('task_preview_record_mismatch',
          { expectedCount: tasks.length, actualCount: ordered.length });
      for (let index = 0; index < ordered.length; index += 1) {
        const row = ordered[index];
        if (!row || typeof row.id !== 'string'
          || seen.has(row.id) || row.legacyIndex !== index
          || !row.value || String(row.value.id) !== row.id
          || stableJson(row.value) !== stableJson(tasks[index]))
          return refuse('task_preview_record_mismatch',
            { expectedCount: tasks.length, actualCount: ordered.length });
        seen.add(row.id);
      }
      if (!sourceCurrent()) return refuse('legacy_changed_during_inspection');
      return {
        checked: true, previewOnly: true, match: true,
        reason: 'task_preview_parity_verified', taskCount: tasks.length,
        resetGeneration: generation, canPromote: false,
        productionWritersFenced: false,
        mutationAuthority: 'legacy_only', readAuthority: 'legacy_only'
      };
    } catch (_) { return refuse('task_preview_parity_unreadable'); }
  }

  // A single-record preview read is a narrower building block than a full
  // Task collection scan. It authenticates the existing seed evidence and
  // current V1 source but inspects only ONE V2 Task row using IDB.get().
  // The result is deliberately not a claim of collection-wide parity.
  async function inspectPreviewTaskRecord(idInput) {
    const refuse = (reason, detail = {}) => ({
      checked: true, previewOnly: true, recordVerified: false,
      collectionParityVerified: false, reason,
      canPromote: false, productionWritersFenced: false,
      mutationAuthority: 'legacy_only', readAuthority: 'legacy_only',
      ...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if ((typeof idInput !== 'string' && typeof idInput !== 'number')
      || !String(idInput) || String(idInput).length > 256)
      return refuse('task_id_required');
    if (typeof core.readTaskPointsStoredState !== 'function'
      || typeof core.readPendingTaskMutations !== 'function')
      return refuse('legacy_task_reader_unavailable');
    const id = String(idInput);
    const expectedEpoch = darkMirrorModeEpoch;
    const generation = currentGeneration({ create: false });
    if (!generation) return refuse('generation_unavailable');
    let inventory, tasks, expectedIndex, fingerprint;
    try {
      inventory = captureReadOnlyFullStorageInventory();
      const pending = core.readPendingTaskMutations();
      if (pending?.malformed) return refuse('legacy_task_journal_malformed');
      const state = core.readTaskPointsStoredState();
      if (!state || !Array.isArray(state.tasks)) return refuse('legacy_tasks_missing');
      tasks = clone(state.tasks);
      const ids = new Set();
      for (const task of tasks) {
        if (!task || typeof task !== 'object' || Array.isArray(task)
          || task.id == null || !String(task.id) || ids.has(String(task.id)))
          return refuse('legacy_task_ids_invalid');
        ids.add(String(task.id));
      }
      expectedIndex = tasks.findIndex(task => String(task.id) === id);
      if (captureReadOnlyFullStorageInventory() !== inventory)
        return refuse('legacy_changed_during_capture');
      fingerprint = await previewRecoveryFingerprint(tasks);
    } catch (_) { return refuse('legacy_task_capture_unreadable'); }
    const sourceCurrent = () => isDarkEnabled()
      && darkMirrorModeEpoch === expectedEpoch
      && currentGeneration({ create: false }) === generation
      && captureReadOnlyFullStorageInventory() === inventory;
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_before_read');
    } catch (_) { return refuse('legacy_unreadable_before_read'); }
    let db, record, evidence, meta;
    try {
      db = await open();
      if (!db) return refuse('dark_disabled');
      const tx = db.transaction(['tasks', 'meta'], 'readonly');
      [record, evidence, meta] = await Promise.all([
        requestPromise(tx.objectStore('tasks').get(id)),
        requestPromise(tx.objectStore('meta').get('task-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID))
      ]);
    } catch (_) { return refuse('task_record_read_unavailable'); }
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_during_read');
      if (meta?.schemaVersion !== SCHEMA_VERSION
        || meta.resetGeneration !== generation || meta.legacyMissing === true)
        return refuse('pilot_meta_not_ready');
      if (!evidence) return refuse('task_preview_missing');
      if (evidence.schemaVersion !== 1 || evidence.resetGeneration !== generation)
        return refuse('task_preview_generation_mismatch');
      const inventorySignature = `${fnv1a(inventory)}:${inventory.length}`;
      if (evidence.taskFingerprint !== fingerprint
        || evidence.sourceInventory !== inventorySignature)
        return refuse('task_preview_source_stale');
      if (evidence.taskCount !== tasks.length)
        return refuse('task_preview_evidence_mismatch');
      const expected = expectedIndex < 0 ? null : tasks[expectedIndex];
      const matches = expected === null ? !record
        : Boolean(record && record.id === id
          && record.legacyIndex === expectedIndex
          && record.value && String(record.value.id) === id
          && stableJson(record.value) === stableJson(expected));
      if (!matches) return refuse('task_preview_record_mismatch');
      if (!sourceCurrent()) return refuse('legacy_changed_after_read');
      return {
        checked: true, previewOnly: true, recordVerified: true,
        collectionParityVerified: false, exists: expected !== null,
        taskId: id, reason: 'task_preview_record_verified',
        canPromote: false, productionWritersFenced: false,
        mutationAuthority: 'legacy_only', readAuthority: 'legacy_only'
      };
    } catch (_) { return refuse('task_record_verification_unreadable'); }
  }

  // PREVIEW ONLY: rehearse a record-level Task update in the isolated V2
  // store. This intentionally does NOT journal into V1 or claim parity:
  // the resulting V2 Task differs from authoritative V1 until rollback.
  // Task bytes and an idempotent action receipt commit in ONE IDB transaction.
  async function rehearsePreviewTaskRecordUpdate(nextInput, sourceToken, actionInput) {
    const refuse = (reason, detail = {}) => ({
      checked: true, previewOnly: true, committed: false,
      confirmedDurable: false, canPromote: false,
      productionWritersFenced: false, readAuthority: 'legacy_only',
      mutationAuthority: 'legacy_only', reason, ...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof sourceToken !== 'string' || !sourceToken)
      return refuse('full_origin_token_required');
    if (typeof actionInput !== 'string' || !actionInput
      || actionInput.length > 128) return refuse('task_action_id_required');
    if (typeof core.readPendingTaskMutations !== 'function'
      || typeof core.readTaskPointsStoredState !== 'function')
      return refuse('legacy_task_reader_unavailable');

    // Freeze the caller's Task before any await: mutable JS references must
    // never change the payload after its SHA-256 receipt was calculated.
    let nextTask, taskId, nextFingerprint;
    try {
      const json = JSON.stringify(nextInput);
      if (typeof json !== 'string' || json.length > 131072) 
        return refuse('invalid_task_payload');
      nextTask = JSON.parse(json);
      if (!nextTask || typeof nextTask !== 'object' || Array.isArray(nextTask)
        || typeof nextTask.id !== 'string' || !nextTask.id
        || nextTask.id.length > 128)
        return refuse('invalid_task_payload');
      taskId = nextTask.id;
      if (stableJson(nextInput) !== stableJson(nextTask))
        return refuse('invalid_task_payload');
      nextFingerprint = await previewRecoveryFingerprint(nextTask);
    } catch (_) { return refuse('invalid_task_payload'); }
    const modeEpoch = darkMirrorModeEpoch;
    const generation = currentGeneration({ create: false });
    if (!generation) return refuse('generation_unavailable');

    let tasks, baseTask, baseIndex, sourceFingerprint, baseFingerprint;
    try {
      const firstInventory = captureReadOnlyFullStorageInventory();
      if (firstInventory !== sourceToken)
        return refuse('full_origin_changed');
      const pending = core.readPendingTaskMutations();
      if (pending?.malformed) return refuse('legacy_task_journal_malformed');
      const state = core.readTaskPointsStoredState();
      if (!state || !Array.isArray(state.tasks))
        return refuse('legacy_tasks_missing');
      tasks = clone(state.tasks);
      const unique = new Set();
      for (const task of tasks) {
        if (!task || typeof task !== 'object' || Array.isArray(task)
          || task.id == null || !String(task.id)
          || unique.has(String(task.id)))
          return refuse('legacy_task_ids_invalid');
        unique.add(String(task.id));
      }
      baseIndex = tasks.findIndex(task => String(task.id) === taskId);
      if (baseIndex < 0) return refuse('legacy_task_not_found');
      baseTask = tasks[baseIndex];
      if (stableJson(baseTask) === stableJson(nextTask))
        return refuse('task_payload_unchanged');
      if (captureReadOnlyFullStorageInventory() !== sourceToken)
        return refuse('legacy_changed_during_capture');
      sourceFingerprint = await previewRecoveryFingerprint(tasks);
      baseFingerprint = await previewRecoveryFingerprint(baseTask);
    } catch (_) { return refuse('legacy_task_capture_unreadable'); }
    const sourceCurrent = () => isDarkEnabled()
      && darkMirrorModeEpoch === modeEpoch
      && currentGeneration({ create: false }) === generation
      && captureReadOnlyFullStorageInventory() === sourceToken;
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_before_update');
    } catch (_) { return refuse('legacy_unreadable_before_update'); }

    const receiptId = 'task-preview-action:' + actionInput;
    const sourceSignature = `${fnv1a(sourceToken)}:${sourceToken.length}`;
    const receipt = {
      id: receiptId, type: 'task-preview-update',
      taskId, resetGeneration: generation,
      sourceInventory: sourceSignature, sourceFingerprint,
      priorFingerprint: baseFingerprint, nextFingerprint
    };
    let db;
    try {
      db = await open();
      if (!db) return refuse('dark_disabled');
    } catch (_) { return refuse('task_preview_db_unavailable'); }
    let failure = null, repeated = false;
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_before_update');
      const tx = db.transaction(['tasks', 'mutations', 'meta'], 'readwrite');
      const tasksStore = tx.objectStore('tasks');
      const mutationsStore = tx.objectStore('mutations');
      const metaStore = tx.objectStore('meta');
      const taskRequest = tasksStore.get(taskId);
      const receiptRequest = mutationsStore.get(receiptId);
      const evidenceRequest = metaStore.get('task-preview');
      const metaRequest = metaStore.get(RUNTIME_META_ID);
      let taskRow, previousReceipt, evidence, meta, count = 0;
      const abort = reason => {
        failure = reason;
        try { tx.abort(); } catch (_) {}
      };
      const decide = () => {
        if (++count !== 4) return;
        try {
          if (!sourceCurrent()) return abort('legacy_changed_under_transaction');
          if (meta?.schemaVersion !== SCHEMA_VERSION
            || meta.resetGeneration !== generation
            || meta.legacyMissing === true)
            return abort('pilot_meta_not_ready');
          if (!evidence || evidence.schemaVersion !== 1
            || evidence.resetGeneration !== generation
            || evidence.taskFingerprint !== sourceFingerprint
            || evidence.sourceInventory !== sourceSignature
            || evidence.taskCount !== tasks.length)
            return abort('task_preview_source_not_seeded');
          if (previousReceipt) {
            if (stableJson(previousReceipt) !== stableJson(receipt))
              return abort('task_action_id_conflict');
            repeated = true;
            // Do not write on a duplicate. Posttransaction readback must
            // still verify both the receipt and the exact Task payload.
            return;
          }
          if (!taskRow || taskRow.id !== taskId
            || taskRow.legacyIndex !== baseIndex
            || stableJson(taskRow.value) !== stableJson(baseTask))
            return abort('task_preview_target_stale');
          tasksStore.put({id: taskId, legacyIndex: baseIndex, value: nextTask});
          mutationsStore.add(receipt);
        } catch (_) { abort('task_preview_atomic_write_failed'); }
      };
      taskRequest.onsuccess = () => { taskRow = taskRequest.result; decide(); };
      receiptRequest.onsuccess = () => { previousReceipt = receiptRequest.result; decide(); };
      evidenceRequest.onsuccess = () => { evidence = evidenceRequest.result; decide(); };
      metaRequest.onsuccess = () => { meta = metaRequest.result; decide(); };
      await transactionPromise(tx);
    } catch (_) {
      return refuse(failure || 'task_preview_atomic_write_failed');
    }

    // Never acknowledge the IDB request alone as durable. Read exact Task
    // bytes and receipt again in a NEW readonly transaction after commit.
    try {
      const tx = db.transaction(['tasks', 'mutations'], 'readonly');
      const [row, savedReceipt] = await Promise.all([
        requestPromise(tx.objectStore('tasks').get(taskId)),
        requestPromise(tx.objectStore('mutations').get(receiptId))
      ]);
      if (!row || row.id !== taskId || row.legacyIndex !== baseIndex
        || stableJson(row.value) !== stableJson(nextTask)
        || stableJson(savedReceipt) !== stableJson(receipt))
        return refuse('task_preview_readback_unverified', {
          committed: !repeated, writeOutcomeUncertain: true
        });
      if (!sourceCurrent())
        return refuse('legacy_changed_after_preview_commit', {
          committed: !repeated, confirmedDurable: true,
          writeOutcomeUncertain: true
        });
      return {
        checked: true, previewOnly: true,
        committed: !repeated, confirmedDurable: true, replayed: repeated,
        collectionParityVerified: false, taskId,
        reason: repeated ? 'task_preview_update_replayed' : 'task_preview_update_verified',
        canPromote: false, productionWritersFenced: false,
        mutationAuthority: 'legacy_only', readAuthority: 'legacy_only'
      };
    } catch (_) {
      return refuse('task_preview_readback_unavailable', {
        committed: !repeated, writeOutcomeUncertain: true
      });
    }
  }

  // PREVIEW ONLY: atomic Task creation or deletion in V2's isolated store.
  // V1 remains authoritative. A mutation receipt is committed alongside
  // the record change, and a V2-only monotonic index prevents two preview
  // creates from accidentally sharing the same legacy order position.
  async function rehearsePreviewTaskLifecycleMutation(input, sourceToken, actionId) {
    const refuse = (reason, detail = {}) => ({
      checked: true, previewOnly: true, committed: false,
      confirmedDurable: false, collectionParityVerified: false,
      canPromote: false, productionWritersFenced: false,
      readAuthority: 'legacy_only', mutationAuthority: 'legacy_only',
      reason, ...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof sourceToken !== 'string' || !sourceToken)
      return refuse('full_origin_token_required');
    if (typeof actionId !== 'string' || !actionId || actionId.length > 128)
      return refuse('task_action_id_required');
    if (typeof core.readPendingTaskMutations !== 'function'
      || typeof core.readTaskPointsStoredState !== 'function')
      return refuse('legacy_task_reader_unavailable');

    // Canonicalize all user-controlled bytes before any async operation.
    let action, taskId, actionFingerprint;
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        return refuse('task_lifecycle_payload_invalid');
      const raw = JSON.stringify(input);
      if (!raw || raw.length > 131072)
        return refuse('task_lifecycle_payload_invalid');
      action = JSON.parse(raw);
      const props = Object.keys(action).sort().join(',');
      if (action.operation === 'create') {
        if (props !== 'operation,task' || !action.task
          || typeof action.task !== 'object' || Array.isArray(action.task))
          return refuse('task_lifecycle_payload_invalid');
        taskId = action.task.id;
      } else if (action.operation === 'delete') {
        if (props !== 'operation,taskId')
          return refuse('task_lifecycle_payload_invalid');
        taskId = action.taskId;
      } else return refuse('task_lifecycle_payload_invalid');
      if (typeof taskId !== 'string' || !taskId || taskId.length > 128)
        return refuse('task_lifecycle_payload_invalid');
      if (stableJson(input) !== stableJson(action))
        return refuse('task_lifecycle_payload_invalid');
      actionFingerprint = await previewRecoveryFingerprint(action);
    } catch (_) { return refuse('task_lifecycle_payload_invalid'); }

    const generation = currentGeneration({ create: false });
    if (!generation) return refuse('generation_unavailable');
    const modeEpoch = darkMirrorModeEpoch;
    let tasks, baseIndex, baseTask, sourceFingerprint;
    try {
      if (captureReadOnlyFullStorageInventory() !== sourceToken)
        return refuse('full_origin_changed');
      const pending = core.readPendingTaskMutations();
      if (pending?.malformed) return refuse('legacy_task_journal_malformed');
      const state = core.readTaskPointsStoredState();
      if (!state || !Array.isArray(state.tasks))
        return refuse('legacy_tasks_missing');
      tasks = clone(state.tasks);
      const ids = new Set();
      for (const task of tasks) {
        if (!task || typeof task !== 'object' || Array.isArray(task)
          || task.id == null || !String(task.id) || ids.has(String(task.id)))
          return refuse('legacy_task_ids_invalid');
        ids.add(String(task.id));
      }
      baseIndex = tasks.findIndex(task => String(task.id) === taskId);
      if (action.operation === 'create' && baseIndex >= 0)
        return refuse('legacy_task_already_exists');
      if (action.operation === 'delete' && baseIndex < 0)
        return refuse('legacy_task_not_found');
      baseTask = baseIndex < 0 ? null : tasks[baseIndex];
      if (captureReadOnlyFullStorageInventory() !== sourceToken)
        return refuse('legacy_changed_during_capture');
      sourceFingerprint = await previewRecoveryFingerprint(tasks);
    } catch (_) { return refuse('legacy_task_capture_unreadable'); }

    const sourceCurrent = () => isDarkEnabled()
      && darkMirrorModeEpoch === modeEpoch
      && currentGeneration({ create: false }) === generation
      && captureReadOnlyFullStorageInventory() === sourceToken;
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_before_mutation');
    } catch (_) { return refuse('legacy_unreadable_before_mutation'); }

    const receiptId = 'task-preview-lifecycle:' + actionId;
    const inventorySignature = `${fnv1a(sourceToken)}:${sourceToken.length}`;
    const receipt = {
      id: receiptId, type: 'task-preview-lifecycle',
      operation: action.operation, taskId,
      actionFingerprint, resetGeneration: generation,
      sourceInventory: inventorySignature, sourceFingerprint
    };
    const lifecycleId = 'task-preview-lifecycle-state';
    let db;
    try {
      db = await open();
      if (!db) return refuse('dark_disabled');
    } catch (_) { return refuse('task_preview_db_unavailable'); }

    let failure = null, repeated = false, committedIndex = null;
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_before_mutation');
      const tx = db.transaction(['tasks', 'mutations', 'meta'], 'readwrite');
      const taskStore = tx.objectStore('tasks');
      const mutationStore = tx.objectStore('mutations');
      const metaStore = tx.objectStore('meta');
      const taskReq = taskStore.get(taskId);
      const receiptReq = mutationStore.get(receiptId);
      const evidenceReq = metaStore.get('task-preview');
      const runtimeReq = metaStore.get(RUNTIME_META_ID);
      const counterReq = metaStore.get(lifecycleId);
      let row, previousReceipt, evidence, meta, counter, ready = 0;
      const abort = reason => {
        failure = reason;
        try { tx.abort(); } catch (_) {}
      };
      const decide = () => {
        if (++ready !== 5) return;
        try {
          if (!sourceCurrent()) return abort('legacy_changed_under_transaction');
          if (meta?.schemaVersion !== SCHEMA_VERSION
            || meta.resetGeneration !== generation || meta.legacyMissing === true)
            return abort('pilot_meta_not_ready');
          if (!evidence || evidence.schemaVersion !== 1
            || evidence.resetGeneration !== generation
            || evidence.taskFingerprint !== sourceFingerprint
            || evidence.sourceInventory !== inventorySignature
            || evidence.taskCount !== tasks.length)
            return abort('task_preview_source_not_seeded');
          if (counter && (counter.resetGeneration !== generation
            || counter.sourceInventory !== inventorySignature
            || counter.sourceFingerprint !== sourceFingerprint
            || !Number.isSafeInteger(counter.nextIndex)
            || counter.nextIndex < tasks.length))
            return abort('task_preview_lifecycle_counter_invalid');
          if (previousReceipt) {
            if (stableJson(previousReceipt) !== stableJson(receipt))
              return abort('task_action_id_conflict');
            repeated = true;
            return;
          }
          if (action.operation === 'create') {
            if (row) return abort('task_preview_target_exists');
            const index = counter ? counter.nextIndex : tasks.length;
            if (!Number.isSafeInteger(index) || index >= Number.MAX_SAFE_INTEGER)
              return abort('task_preview_lifecycle_counter_invalid');
            committedIndex = index;
            taskStore.add({id: taskId, legacyIndex: index, value: action.task});
            metaStore.put({
              id: lifecycleId, resetGeneration: generation,
              sourceInventory: inventorySignature,
              sourceFingerprint, nextIndex: index + 1
            });
          } else {
            if (!row || row.id !== taskId || row.legacyIndex !== baseIndex
              || stableJson(row.value) !== stableJson(baseTask))
              return abort('task_preview_target_stale');
            committedIndex = baseIndex;
            taskStore.delete(taskId);
          }
          mutationStore.add(receipt);
        } catch (_) { abort('task_lifecycle_atomic_write_failed'); }
      };
      taskReq.onsuccess = () => { row = taskReq.result; decide(); };
      receiptReq.onsuccess = () => { previousReceipt = receiptReq.result; decide(); };
      evidenceReq.onsuccess = () => { evidence = evidenceReq.result; decide(); };
      runtimeReq.onsuccess = () => { meta = runtimeReq.result; decide(); };
      counterReq.onsuccess = () => { counter = counterReq.result; decide(); };
      await transactionPromise(tx);
    } catch (_) {
      return refuse(failure || 'task_lifecycle_atomic_write_failed');
    }

    // New transaction, not just a successful IDB request or oncomplete:
    // confirm the final record state and exactly matching action receipt.
    try {
      const tx = db.transaction(['tasks', 'mutations'], 'readonly');
      const [row, savedReceipt] = await Promise.all([
        requestPromise(tx.objectStore('tasks').get(taskId)),
        requestPromise(tx.objectStore('mutations').get(receiptId))
      ]);
      const matched = action.operation === 'create'
        ? row && row.id === taskId
          && Number.isSafeInteger(row.legacyIndex)
          && row.legacyIndex >= tasks.length
          && stableJson(row.value) === stableJson(action.task)
        : !row;
      if (!matched || stableJson(savedReceipt) !== stableJson(receipt))
        return refuse('task_lifecycle_readback_unverified', {
          committed: !repeated, writeOutcomeUncertain: true
        });
      if (!sourceCurrent())
        return refuse('legacy_changed_after_preview_commit', {
          committed: !repeated, confirmedDurable: true,
          writeOutcomeUncertain: true
        });
      return {
        checked: true, previewOnly: true, committed: !repeated,
        confirmedDurable: true, replayed: repeated,
        collectionParityVerified: false, taskId, operation: action.operation,
        reason: repeated
          ? 'task_lifecycle_replayed' : 'task_lifecycle_mutation_verified',
        canPromote: false, productionWritersFenced: false,
        mutationAuthority: 'legacy_only', readAuthority: 'legacy_only'
      };
    } catch (_) {
      return refuse('task_lifecycle_readback_unavailable', {
        committed: !repeated, writeOutcomeUncertain: true
      });
    }
  }

  // PREVIEW ONLY: copy an existing, journal-backed nonpilot V1 completion
  // into the isolated V2 completion store, bound to its unchanged V1 Task.
  // The completion row and its replay receipt commit in one IDB transaction.
  // No V1 journal writes, no new completion, no production read authority.
  async function rehearsePreviewTaskLinkedCompletion(completionIdInput, sourceToken, actionId) {
    const refuse = (reason, detail = {}) => ({
      checked: true, previewOnly: true, committed: false,
      confirmedDurable: false, collectionParityVerified: false,
      canPromote: false, productionWritersFenced: false,
      readAuthority: 'legacy_only', mutationAuthority: 'legacy_only',
      reason, ...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof sourceToken !== 'string' || !sourceToken)
      return refuse('full_origin_token_required');
    if (typeof actionId !== 'string' || !actionId || actionId.length > 128)
      return refuse('task_completion_action_id_required');
    if (typeof completionIdInput !== 'string' || !completionIdInput
      || completionIdInput.length > 128)
      return refuse('task_completion_id_required');
    if (typeof core.readTaskPointsStoredState !== 'function'
      || typeof core.readPendingTaskMutations !== 'function')
      return refuse('legacy_task_reader_unavailable');

    const generation = currentGeneration({ create: false });
    if (!generation) return refuse('generation_unavailable');
    const modeEpoch = darkMirrorModeEpoch;
    const completionId = completionIdInput;
    let tasks, completion, task, taskIndex, completionIndex;
    let sourceFingerprint, completionFingerprint;
    try {
      if (captureReadOnlyFullStorageInventory() !== sourceToken)
        return refuse('full_origin_changed');
      const pending = core.readPendingTaskMutations();
      if (pending?.malformed) return refuse('legacy_task_journal_malformed');
      const state = core.readTaskPointsStoredState();
      if (!state || !Array.isArray(state.tasks)
        || !Array.isArray(state.completions))
        return refuse('legacy_tasks_or_completions_missing');
      tasks = clone(state.tasks);
      const ids = new Set();
      for (const item of tasks) {
        if (!item || typeof item !== 'object' || Array.isArray(item)
          || item.id == null || !String(item.id) || ids.has(String(item.id)))
          return refuse('legacy_task_ids_invalid');
        ids.add(String(item.id));
      }
      const matches = state.completions
        .map((value, index) => ({value, index}))
        .filter(entry => entry.value?.id === completionId);
      if (matches.length !== 1)
        return refuse(matches.length ? 'legacy_completion_id_ambiguous'
          : 'legacy_completion_not_found');
      completion = clone(matches[0].value);
      completionIndex = matches[0].index;
      if (!completion || typeof completion !== 'object'
        || Array.isArray(completion) || !completion.source
        || isPilotCompletion(completion)
        || !['task','work','metric'].includes(String(completion.source))
        || typeof completion.taskId !== 'string' || !completion.taskId)
        return refuse('nonpilot_task_completion_required');
      taskIndex = tasks.findIndex(row => String(row.id) === completion.taskId);
      if (taskIndex < 0) return refuse('linked_legacy_task_missing');
      task = tasks[taskIndex];
      const frozenBytes = JSON.stringify(completion);
      if (!frozenBytes || frozenBytes.length > 131072)
        return refuse('task_completion_payload_invalid');
      if (captureReadOnlyFullStorageInventory() !== sourceToken)
        return refuse('legacy_changed_during_capture');
      sourceFingerprint = await previewRecoveryFingerprint(tasks);
      completionFingerprint = await previewRecoveryFingerprint(completion);
    } catch (_) { return refuse('legacy_task_completion_capture_unreadable'); }

    const sourceCurrent = () => isDarkEnabled()
      && darkMirrorModeEpoch === modeEpoch
      && currentGeneration({ create: false }) === generation
      && captureReadOnlyFullStorageInventory() === sourceToken;
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_before_completion');
    } catch (_) { return refuse('legacy_unreadable_before_completion'); }

    // Preserve the existing packed duplicate-ID completion representation.
    // A negative preview-only sequence is NOT full compatibility ordering.
    // The pilot Habit index remains empty for this non-Habit completion.
    const packed = withCompletionHabitIds({
      id: completionId,
      entries: [{value: completion, sequence: -(completionIndex + 1)}]
    });
    const sourceSignature = `${fnv1a(sourceToken)}:${sourceToken.length}`;
    const receiptId = 'task-preview-completion:' + actionId;
    const receipt = {
      id: receiptId, type: 'task-preview-completion',
      completionId, taskId: task.id, completionFingerprint,
      sourceTaskFingerprint: sourceFingerprint,
      sourceInventory: sourceSignature, resetGeneration: generation
    };
    let db;
    try {
      db = await open();
      if (!db) return refuse('dark_disabled');
    } catch (_) { return refuse('task_preview_db_unavailable'); }
    let failure = null, repeated = false;
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_before_completion');
      const tx = db.transaction(['tasks','completions','mutations','meta'], 'readwrite');
      const taskStore = tx.objectStore('tasks');
      const completionStore = tx.objectStore('completions');
      const mutationStore = tx.objectStore('mutations');
      const metaStore = tx.objectStore('meta');
      const taskReq = taskStore.get(task.id);
      const completionReq = completionStore.get(completionId);
      const receiptReq = mutationStore.get(receiptId);
      const evidenceReq = metaStore.get('task-preview');
      const runtimeReq = metaStore.get(RUNTIME_META_ID);
      let taskRow, existingCompletion, priorReceipt, evidence, meta, count = 0;
      const abort = reason => {
        failure = reason;
        try { tx.abort(); } catch (_) {}
      };
      const decide = () => {
        if (++count !== 5) return;
        try {
          if (!sourceCurrent()) return abort('legacy_changed_under_transaction');
          if (meta?.schemaVersion !== SCHEMA_VERSION
            || meta.resetGeneration !== generation || meta.legacyMissing === true)
            return abort('pilot_meta_not_ready');
          if (!evidence || evidence.schemaVersion !== 1
            || evidence.resetGeneration !== generation
            || evidence.taskFingerprint !== sourceFingerprint
            || evidence.sourceInventory !== sourceSignature
            || evidence.taskCount !== tasks.length)
            return abort('task_preview_source_not_seeded');
          // Linked Task must still be the exact V1-backed, unmodified
          // seed record. Reject a prior preview-only Task edit/delete.
          if (!taskRow || taskRow.id !== String(task.id)
            || taskRow.legacyIndex !== taskIndex
            || stableJson(taskRow.value) !== stableJson(task))
            return abort('task_preview_linked_task_stale');
          if (priorReceipt) {
            if (stableJson(priorReceipt) !== stableJson(receipt))
              return abort('task_completion_action_id_conflict');
            repeated = true;
            return;
          }
          if (existingCompletion)
            return abort('task_preview_completion_id_exists');
          completionStore.add(packed);
          mutationStore.add(receipt);
        } catch (_) { abort('task_completion_atomic_write_failed'); }
      };
      taskReq.onsuccess = () => { taskRow = taskReq.result; decide(); };
      completionReq.onsuccess = () => { existingCompletion = completionReq.result; decide(); };
      receiptReq.onsuccess = () => { priorReceipt = receiptReq.result; decide(); };
      evidenceReq.onsuccess = () => { evidence = evidenceReq.result; decide(); };
      runtimeReq.onsuccess = () => { meta = runtimeReq.result; decide(); };
      await transactionPromise(tx);
    } catch (_) {
      return refuse(failure || 'task_completion_atomic_write_failed');
    }

    // Fresh readonly transaction: verify actual packed row and matching
    // journal-backed intent receipt, not merely successful IDB requests.
    try {
      const tx = db.transaction(['tasks','completions','mutations'], 'readonly');
      const [taskRow, row, storedReceipt] = await Promise.all([
        requestPromise(tx.objectStore('tasks').get(String(task.id))),
        requestPromise(tx.objectStore('completions').get(completionId)),
        requestPromise(tx.objectStore('mutations').get(receiptId))
      ]);
      if (!taskRow || taskRow.legacyIndex !== taskIndex
        || stableJson(taskRow.value) !== stableJson(task)
        || stableJson(row) !== stableJson(packed)
        || stableJson(storedReceipt) !== stableJson(receipt))
        return refuse('task_completion_readback_unverified', {
          committed: !repeated, writeOutcomeUncertain: true
        });
      if (!sourceCurrent())
        return refuse('legacy_changed_after_preview_commit', {
          committed: !repeated, confirmedDurable: true,
          writeOutcomeUncertain: true
        });
      return {
        checked: true, previewOnly: true,
        committed: !repeated, confirmedDurable: true, replayed: repeated,
        collectionParityVerified: false, pilotParityVerified: false,
        taskId: task.id, completionId,
        reason: repeated
          ? 'task_completion_preview_replayed'
          : 'task_completion_preview_verified',
        canPromote: false, productionWritersFenced: false,
        readAuthority: 'legacy_only', mutationAuthority: 'legacy_only'
      };
    } catch (_) {
      return refuse('task_completion_readback_unavailable', {
        committed: !repeated, writeOutcomeUncertain: true
      });
    }
  }

  // PREVIEW ONLY: one logical Task/Work/metric action may have multiple
  // authoritative V1 completion rows. Mirror those rows into isolated V2
  // in ONE transaction, never one per ID. No production writes or authority.
  async function rehearsePreviewTaskLinkedCompletionBatch(idsInput, sourceToken, actionId) {
    const refuse = (reason, details = {}) => ({
      checked: true, previewOnly: true, committed: false,
      confirmedDurable: false, collectionParityVerified: false,
      pilotParityVerified: false, canPromote: false,
      productionWritersFenced: false, readAuthority: 'legacy_only',
      mutationAuthority: 'legacy_only', reason, ...details
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof sourceToken !== 'string' || !sourceToken)
      return refuse('full_origin_token_required');
    if (typeof actionId !== 'string' || !actionId || actionId.length > 128)
      return refuse('task_completion_action_id_required');
    if (typeof core.readTaskPointsStoredState !== 'function'
      || typeof core.readPendingTaskMutations !== 'function')
      return refuse('legacy_task_reader_unavailable');
    if (!Array.isArray(idsInput) || !idsInput.length || idsInput.length > 64
      || idsInput.some(id => typeof id !== 'string' || !id || id.length > 128)
      || new Set(idsInput).size !== idsInput.length)
      return refuse('task_completion_batch_ids_invalid');
    // Freeze caller order and IDs before the first asynchronous boundary.
    const ids = idsInput.slice();
    const generation = currentGeneration({ create: false });
    if (!generation) return refuse('generation_unavailable');
    const expectedModeEpoch = darkMirrorModeEpoch;
    let tasks, packedRows, referencedTasks, taskSourceFingerprint, batchFingerprint;
    try {
      if (captureReadOnlyFullStorageInventory() !== sourceToken)
        return refuse('full_origin_changed');
      const pending = core.readPendingTaskMutations();
      if (pending?.malformed) return refuse('legacy_task_journal_malformed');
      const state = core.readTaskPointsStoredState();
      if (!state || !Array.isArray(state.tasks)
        || !Array.isArray(state.completions))
        return refuse('legacy_tasks_or_completions_missing');
      tasks = clone(state.tasks);
      const tasksById = new Map();
      tasks.forEach((task,index) => {
        if (!task || typeof task !== 'object' || Array.isArray(task)
          || task.id == null || !String(task.id)
          || tasksById.has(String(task.id)))
          throw new Error('legacy_task_ids_invalid');
        tasksById.set(String(task.id), {value:task,index});
      });
      const wanted = new Set(ids);
      const found = new Map();
      state.completions.forEach((value,index) => {
        if (!wanted.has(value?.id)) return;
        const id = value.id;
        if (found.has(id)) throw new Error('legacy_completion_id_ambiguous');
        found.set(id,{value:clone(value),index});
      });
      packedRows = [];
      referencedTasks = new Map();
      for (const id of ids) {
        const selected = found.get(id);
        if (!selected) return refuse('legacy_completion_not_found');
        const completion = selected.value;
        if (!completion || typeof completion !== 'object'
          || Array.isArray(completion) || isPilotCompletion(completion)
          || !['task','work','metric'].includes(String(completion.source))
          || typeof completion.taskId !== 'string' || !completion.taskId)
          return refuse('nonpilot_task_completion_required');
        const linked = tasksById.get(completion.taskId);
        if (!linked) return refuse('linked_legacy_task_missing');
        const completionJson = JSON.stringify(completion);
        if (!completionJson || completionJson.length > 131072)
          return refuse('task_completion_payload_invalid');
        referencedTasks.set(completion.taskId, linked);
        packedRows.push(withCompletionHabitIds({
          id, entries:[{value:completion,sequence:-(selected.index+1)}]
        }));
      }
      if (JSON.stringify(packedRows).length > 262144)
        return refuse('task_completion_batch_too_large');
      if (captureReadOnlyFullStorageInventory() !== sourceToken)
        return refuse('legacy_changed_during_capture');
      taskSourceFingerprint = await previewRecoveryFingerprint(tasks);
      batchFingerprint = await previewRecoveryFingerprint(packedRows);
    } catch (error) {
      if (error?.message === 'legacy_task_ids_invalid'
        || error?.message === 'legacy_completion_id_ambiguous')
        return refuse(error.message);
      return refuse('legacy_completion_batch_capture_unreadable');
    }
    const sourceCurrent = () => isDarkEnabled()
      && darkMirrorModeEpoch === expectedModeEpoch
      && currentGeneration({create:false}) === generation
      && captureReadOnlyFullStorageInventory() === sourceToken;
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_before_batch');
    } catch (_) { return refuse('legacy_unreadable_before_batch'); }

    const signature = `${fnv1a(sourceToken)}:${sourceToken.length}`;
    const receiptId = 'task-preview-completion-batch:' + actionId;
    const receipt = {
      id:receiptId, type:'task-preview-completion-batch',
      ids, batchFingerprint, taskSourceFingerprint,
      sourceInventory:signature, resetGeneration:generation
    };
    let db;
    try {
      db = await open();
      if (!db) return refuse('dark_disabled');
    } catch (_) { return refuse('task_preview_db_unavailable'); }

    let failure = null, repeated = false;
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_before_batch');
      const tx = db.transaction(['tasks','completions','mutations','meta'],'readwrite');
      const taskStore = tx.objectStore('tasks');
      const completionStore = tx.objectStore('completions');
      const mutationStore = tx.objectStore('mutations');
      const metaStore = tx.objectStore('meta');
      const taskIds = Array.from(referencedTasks.keys());
      const taskRequests = taskIds.map(id=>taskStore.get(id));
      const completionRequests = ids.map(id=>completionStore.get(id));
      const receiptRequest = mutationStore.get(receiptId);
      const evidenceRequest = metaStore.get('task-preview');
      const runtimeRequest = metaStore.get(RUNTIME_META_ID);
      const requests = [...taskRequests, ...completionRequests,
        receiptRequest, evidenceRequest, runtimeRequest];
      let outstanding = requests.length;
      const abort = reason => {
        failure = reason;
        try { tx.abort(); } catch (_) {}
      };
      const decide = () => {
        if (--outstanding !== 0) return;
        try {
          if (!sourceCurrent()) return abort('legacy_changed_under_transaction');
          const meta = runtimeRequest.result;
          const evidence = evidenceRequest.result;
          if (meta?.schemaVersion !== SCHEMA_VERSION
            || meta.resetGeneration !== generation || meta.legacyMissing === true)
            return abort('pilot_meta_not_ready');
          if (!evidence || evidence.schemaVersion !== 1
            || evidence.resetGeneration !== generation
            || evidence.taskFingerprint !== taskSourceFingerprint
            || evidence.sourceInventory !== signature
            || evidence.taskCount !== tasks.length)
            return abort('task_preview_source_not_seeded');
          for (let index=0;index<taskIds.length;index++) {
            const expected = referencedTasks.get(taskIds[index]);
            const row = taskRequests[index].result;
            if (!row || row.id !== taskIds[index]
              || row.legacyIndex !== expected.index
              || stableJson(row.value) !== stableJson(expected.value))
              return abort('task_preview_linked_task_stale');
          }
          const previous = receiptRequest.result;
          if (previous) {
            if (stableJson(previous) !== stableJson(receipt))
              return abort('task_completion_action_id_conflict');
            repeated = true;
            return;
          }
          if (completionRequests.some(request => request.result))
            return abort('task_preview_completion_id_exists');
          for (const row of packedRows) completionStore.add(row);
          mutationStore.add(receipt);
        } catch (_) { abort('task_completion_batch_atomic_write_failed'); }
      };
      for (const req of requests) req.onsuccess = decide;
      await transactionPromise(tx);
    } catch (_) {
      return refuse(failure || 'task_completion_batch_atomic_write_failed');
    }

    // Verify all rows AND the exact receipt in a fresh transaction.
    // A half-visible batch must never be acknowledged as durable.
    try {
      const tx = db.transaction(['tasks','completions','mutations'],'readonly');
      const taskIds = Array.from(referencedTasks.keys());
      const values = await Promise.all([
        ...taskIds.map(id=>requestPromise(tx.objectStore('tasks').get(id))),
        ...ids.map(id=>requestPromise(tx.objectStore('completions').get(id))),
        requestPromise(tx.objectStore('mutations').get(receiptId))
      ]);
      const savedReceipt = values.pop();
      const taskRows = values.slice(0,taskIds.length);
      const completionRows = values.slice(taskIds.length);
      const matchedTasks = taskRows.every((row,index)=>{
        const expected = referencedTasks.get(taskIds[index]);
        return row && row.id === taskIds[index]
          && row.legacyIndex === expected.index
          && stableJson(row.value) === stableJson(expected.value);
      });
      if (!matchedTasks
        || !completionRows.every((row,index)=>
          stableJson(row) === stableJson(packedRows[index]))
        || stableJson(savedReceipt) !== stableJson(receipt))
        return refuse('task_completion_batch_readback_unverified',{
          committed:!repeated,writeOutcomeUncertain:true
        });
      if (!sourceCurrent())
        return refuse('legacy_changed_after_preview_commit',{
          committed:!repeated,confirmedDurable:true,writeOutcomeUncertain:true
        });
      return {
        checked:true,previewOnly:true,committed:!repeated,
        confirmedDurable:true,replayed:repeated,
        completionCount:ids.length,collectionParityVerified:false,
        pilotParityVerified:false,
        reason:repeated ? 'task_completion_batch_replayed'
          : 'task_completion_batch_verified',
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    } catch (_) {
      return refuse('task_completion_batch_readback_unavailable',{
        committed:!repeated,writeOutcomeUncertain:true
      });
    }
  }

  // Read-only, preview-host-only diagnostic for Task/Work/metric completion
  // chronology. A scoped match never establishes whole-app compatibility:
  // unrelated completion classes, production writer admission and exports
  // remain unverified. The full V2 store is scanned only in this inspector.
  // PREVIEW ONLY: discover a historical backlog of Task/Work/metric
  // completions in effective V1 and ingest ONE bounded batch through the
  // existing atomic receipt-backed importer. Never overwrite existing V2
  // evidence, drop duplicate IDs, or mix unrelated completion classes.
  // This is explicit developer rehearsal, not automatic production mirroring.
  async function rehearsePreviewTaskCompletionHistoryCatchUp(sourceToken, actionId) {
    const refuse = (reason, detail = {}) => ({
      checked:true, previewOnly:true, committed:false,
      confirmedDurable:false, collectionParityVerified:false,
      canPromote:false, productionWritersFenced:false,
      readAuthority:'legacy_only', mutationAuthority:'legacy_only',
      reason, ...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof sourceToken !== 'string' || !sourceToken)
      return refuse('full_origin_token_required');
    if (typeof actionId !== 'string' || !actionId || actionId.length > 128)
      return refuse('task_completion_action_id_required');
    if (typeof core.readTaskPointsStoredState !== 'function'
      || typeof core.readPendingTaskMutations !== 'function')
      return refuse('legacy_task_reader_unavailable');

    const generation = currentGeneration({create:false});
    const modeEpoch = darkMirrorModeEpoch;
    const sourceCurrent = () => isDarkEnabled()
      && darkMirrorModeEpoch === modeEpoch
      && currentGeneration({create:false}) === generation
      && captureReadOnlyFullStorageInventory() === sourceToken;
    if (!generation) return refuse('generation_unavailable');
    let effective, wanted, unsupported = 0;
    try {
      if (!sourceCurrent()) return refuse('full_origin_changed');
      const pending = core.readPendingTaskMutations();
      if (pending?.malformed) return refuse('legacy_task_journal_malformed');
      effective = core.readTaskPointsStoredState();
      if (!effective || !Array.isArray(effective.completions))
        return refuse('legacy_completions_missing');
      const occurrences = new Map();
      for (const item of effective.completions) {
        if (typeof item?.id === 'string' && item.id)
          occurrences.set(item.id, (occurrences.get(item.id) || 0) + 1);
      }
      const supported = row => ['task','work','metric'].includes(
        String(row?.source || '')
      ) && typeof row?.taskId === 'string' && Boolean(row.taskId);
      wanted = new Map();
      for (let i=0; i<effective.completions.length; i+=1) {
        const row = effective.completions[i];
        if (isPilotCompletion(row)) continue;
        if (!supported(row)) { unsupported+=1; continue; }
        if (typeof row.id !== 'string' || !row.id || row.id.length > 128
          || occurrences.get(row.id) !== 1)
          return refuse('legacy_completion_id_ambiguous');
        if (wanted.has(row.id)) return refuse('legacy_completion_id_ambiguous');
        wanted.set(row.id, withCompletionHabitIds({
          id:row.id,
          entries:[{value:clone(row),sequence:-(i+1)}]
        }));
      }
      if (!sourceCurrent()) return refuse('legacy_changed_during_capture');
    } catch (_) { return refuse('legacy_completion_history_unreadable'); }
    // The already-seeded Task collection must be fully consistent, not just
    // metadata-authenticated. Otherwise importing completions for stale or
    // preview-edited Tasks could misattribute user work.
    const taskParity = await inspectPreviewTaskCollectionParity();
    if (!taskParity.match) return refuse('task_preview_parity_required', {
      prerequisiteReason:taskParity.reason
    });
    try { if (!sourceCurrent()) return refuse('legacy_changed_before_scan'); }
    catch (_) { return refuse('legacy_unreadable_before_scan'); }

    let priorRows, meta;
    try {
      const db=await open();
      if (!db) return refuse('v2_unavailable');
      const tx=db.transaction(['completions','meta'],'readonly');
      [priorRows,meta]=await Promise.all([
        requestPromise(tx.objectStore('completions').getAll()),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID))
      ]);
    } catch (_) { return refuse('v2_completion_history_unreadable'); }
    if (!meta || meta.schemaVersion !== SCHEMA_VERSION
      || meta.resetGeneration !== generation || meta.legacyMissing === true)
      return refuse('pilot_meta_not_ready');

    const existing = new Set();
    let presentSupported = 0;
    try {
      for (const row of priorRows) {
        if (!row || typeof row.id !== 'string' || !row.id
          || existing.has(row.id)) return refuse('v2_completion_pack_invalid');
        existing.add(row.id);
        const entries = Array.isArray(row.entries)
          ? row.entries
          : Object.prototype.hasOwnProperty.call(row,'value')
            ? [{value:row.value,sequence:row.sequence}] : [];
        if (!entries.length) return refuse('v2_completion_pack_invalid');
        const nonpilot = entries.filter(entry =>
          !isPilotCompletion(entry?.value));
        if (!nonpilot.length) {
          if (wanted.has(row.id))
            return refuse('v2_completion_id_collides_with_pilot');
          continue;
        }
        const expected=wanted.get(row.id);
        // An old preview row is NEVER trusted just because its ID exists.
        // Require the entire packed payload and chronology to agree with V1.
        if (!expected || nonpilot.length !== entries.length
          || stableJson(row) !== stableJson(expected))
          return refuse('v2_nonpilot_completion_evidence_preserved', {
            conflictingId:row.id
          });
        presentSupported += 1;
      }
      if (!sourceCurrent()) return refuse('legacy_changed_during_scan');
    } catch (_) { return refuse('v2_completion_history_verification_unreadable'); }

    let bytes=2;
    const selected=[];
    for (const [id,row] of wanted) {
      if (existing.has(id)) continue;
      const size=JSON.stringify(row).length + 1;
      if (size > 131072) return refuse('task_completion_payload_too_large');
      if (selected.length && (selected.length>=64 || bytes+size>240000))
        break;
      if (bytes+size>240000)
        return refuse('task_completion_payload_too_large');
      selected.push(id); bytes+=size;
    }
    if (!selected.length) {
      // A completion-free V1 state is legitimate, but unsupported classes
      // are not counted as successfully migrated.
      if (unsupported) return refuse('unsupported_nonpilot_completion_classes', {
        unsupportedCount:unsupported, supportedCount:wanted.size
      });
      const parity = wanted.size
        ? await inspectPreviewTaskCompletionOrderParity()
        : {match:true,completionOrderingVerified:true};
      if (!parity.match) return refuse('task_completion_history_parity_mismatch',{
        prerequisiteReason:parity.reason
      });
      // The parity inspector captured its own source snapshot. An older V1
      // tab can change an unrelated origin key after that inspector returns,
      // so the original caller token must also survive this async boundary.
      try {
        if (!sourceCurrent()) return refuse('legacy_changed_after_history_check');
      } catch (_) {
        return refuse('legacy_unreadable_after_history_check');
      }
      return {
        checked:true, previewOnly:true, committed:false,
        confirmedDurable:true, collectionParityVerified:true,
        fullyMirrored:true, importedRows:0, remainingRows:0,
        supportedRows:wanted.size, reason:'task_completion_history_current',
        canPromote:false, productionWritersFenced:false,
        readAuthority:'legacy_only', mutationAuthority:'legacy_only'
      };
    }
    try { if (!sourceCurrent()) return refuse('legacy_changed_before_import'); }
    catch (_) { return refuse('legacy_unreadable_before_import'); }
    const result = await rehearsePreviewTaskLinkedCompletionBatch(
      selected,sourceToken,actionId
    );
    if (!result.confirmedDurable)
      return refuse(result.reason || 'task_completion_batch_unverified', {
        batchResult:result, importedRows:0
      });
    // This count reflects the audited, original backlog; never claim complete
    // parity for a bounded partial batch without an independent full read.
    const remainingRows=wanted.size-presentSupported-selected.length;
    let fullVerified=false;
    if (remainingRows===0 && unsupported===0) {
      const parity=await inspectPreviewTaskCompletionOrderParity();
      fullVerified=parity.match === true;
    }
    // A durable V2 import is not the same as a fresh V1 parity proof. If an
    // old/nonparticipating tab writes during the independent parity await,
    // preserve the committed rows and report an uncertain source instead
    // of claiming complete mirroring against the caller's stale token.
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_after_history_import',{
        committed:result.committed===true,confirmedDurable:true,
        writeOutcomeUncertain:true,importedRows:selected.length
      });
    } catch (_) {
      return refuse('legacy_unreadable_after_history_import',{
        committed:result.committed===true,confirmedDurable:true,
        writeOutcomeUncertain:true,importedRows:selected.length
      });
    }
    return {
      checked:true,previewOnly:true, committed:result.committed===true,
      confirmedDurable:true,collectionParityVerified:fullVerified,
      fullyMirrored:fullVerified,importedRows:selected.length,
      remainingRows:Math.max(0,remainingRows),
      supportedRows:wanted.size,unsupportedCount:unsupported,
      reason:fullVerified?'task_completion_history_verified'
        :'task_completion_history_partial',
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only'
    };
  }


  // PREVIEW ONLY: reconcile previously imported Task/Work/metric completion
  // history against V1 after edits, deletions or ordering changes. No V1
  // writer, pilot row or other nonpilot collection is modified. A first
  // reconcile requires intact batch-import receipts for EVERY older scoped
  // row; later reconciles require the exact prior atomic checkpoint.
  async function rehearsePreviewTaskCompletionHistoryReconcile(sourceToken, actionId) {
    const refuse = (reason, detail = {}) => ({
      checked:true, previewOnly:true, committed:false,
      confirmedDurable:false, collectionParityVerified:false,
      canPromote:false, productionWritersFenced:false,
      readAuthority:'legacy_only', mutationAuthority:'legacy_only',
      reason, ...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof sourceToken !== 'string' || !sourceToken)
      return refuse('full_origin_token_required');
    if (typeof actionId !== 'string' || !actionId || actionId.length > 128)
      return refuse('task_completion_action_id_required');
    if (typeof core.readTaskPointsStoredState !== 'function'
      || typeof core.readPendingTaskMutations !== 'function')
      return refuse('legacy_task_reader_unavailable');
    const generation=currentGeneration({create:false});
    const modeEpoch=darkMirrorModeEpoch;
    if (!generation) return refuse('generation_unavailable');
    const sourceCurrent=()=>isDarkEnabled()
      && darkMirrorModeEpoch===modeEpoch
      && currentGeneration({create:false})===generation
      && captureReadOnlyFullStorageInventory()===sourceToken;
    let tasks, desired, taskFingerprint;
    try {
      if (!sourceCurrent()) return refuse('full_origin_changed');
      const pending=core.readPendingTaskMutations();
      if (pending?.malformed) return refuse('legacy_task_journal_malformed');
      const state=core.readTaskPointsStoredState();
      if (!state || !Array.isArray(state.tasks)
        || !Array.isArray(state.completions))
        return refuse('legacy_tasks_or_completions_missing');
      tasks=clone(state.tasks);
      const taskIds=new Set();
      for (const task of tasks) {
        if (!task || typeof task!=='object' || Array.isArray(task)
          || task.id == null || !String(task.id)
          || taskIds.has(String(task.id)))
          return refuse('legacy_task_ids_invalid');
        taskIds.add(String(task.id));
      }
      // V1 legitimately packs duplicate or ID-less Habit/vice rows. Only
      // nonpilot Task IDs must be unique; still prevent any scope collision.
      const scopedIds=new Set(),pilotIds=new Set();
      desired=[];
      for (let index=0;index<state.completions.length;index+=1) {
        const row=state.completions[index];
        if (!row || typeof row!=='object' || Array.isArray(row))
          return refuse('legacy_completion_history_invalid');
        if (isPilotCompletion(row)) {
          if (row.id!=null && String(row.id))
            pilotIds.add(String(row.id));
          continue;
        }
        if (typeof row.id!=='string' || !row.id || row.id.length>128
          || scopedIds.has(row.id))
          return refuse('legacy_completion_id_ambiguous');
        scopedIds.add(row.id);
        if (!['task','work','metric'].includes(String(row.source||''))
          || typeof row.taskId!=='string' || !row.taskId)
          return refuse('unsupported_nonpilot_completion_classes');
        if (!taskIds.has(row.taskId)) return refuse('linked_legacy_task_missing');
        const packed=withCompletionHabitIds({
          id:row.id,entries:[{value:clone(row),sequence:-(index+1)}]
        });
        if (JSON.stringify(packed).length>131072)
          return refuse('task_completion_payload_too_large');
        desired.push(packed);
      }
      if (desired.some(row=>pilotIds.has(row.id)))
        return refuse('legacy_completion_scope_collision');
      if (!sourceCurrent()) return refuse('legacy_changed_during_capture');
      taskFingerprint=await previewRecoveryFingerprint(tasks);
    } catch (_) { return refuse('legacy_completion_history_unreadable'); }

    const taskParity=await inspectPreviewTaskCollectionParity();
    if (!taskParity.match) return refuse('task_preview_parity_required',{
      prerequisiteReason:taskParity.reason
    });
    try { if (!sourceCurrent()) return refuse('legacy_changed_before_reconcile'); }
    catch (_) { return refuse('legacy_unreadable_before_reconcile'); }

    let db, beforeRows, receipts, seal, meta, taskEvidence, taskRows;
    try {
      db=await open();
      if (!db) return refuse('v2_unavailable');
      const tx=db.transaction(['tasks','completions','mutations','meta'],'readonly');
      [beforeRows,receipts,seal,meta,taskEvidence,taskRows]=await Promise.all([
        requestPromise(tx.objectStore('completions').getAll()),
        requestPromise(tx.objectStore('mutations').getAll()),
        requestPromise(tx.objectStore('meta').get('task-preview-completion-reconcile')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID)),
        requestPromise(tx.objectStore('meta').get('task-preview')),
        requestPromise(tx.objectStore('tasks').getAll())
      ]);
    } catch (_) { return refuse('task_completion_reconcile_read_unavailable'); }
    if (!meta || meta.schemaVersion!==SCHEMA_VERSION
      || meta.resetGeneration!==generation || meta.legacyMissing===true)
      return refuse('pilot_meta_not_ready');
    const signature=fnv1a(sourceToken)+':'+sourceToken.length;
    if (!taskEvidence || taskEvidence.schemaVersion!==1
      || taskEvidence.resetGeneration!==generation
      || taskEvidence.taskFingerprint!==taskFingerprint
      || taskEvidence.sourceInventory!==signature
      || taskEvidence.taskCount!==tasks.length)
      return refuse('task_preview_source_not_seeded');
    const sortedTasks=taskRows.slice().sort((a,b)=>a.legacyIndex-b.legacyIndex);
    if (sortedTasks.length!==tasks.length
      || sortedTasks.some((r,i)=>r.id!==String(tasks[i].id)
        || r.legacyIndex!==i || stableJson(r.value)!==stableJson(tasks[i])))
      return refuse('task_preview_record_mismatch');

    const oldById=new Map();
    const wanted=new Map(desired.map(row=>[row.id,row]));
    const otherRows=[];
    const rowIds=new Set();
    for (const row of beforeRows) {
      if (!row || typeof row.id!=='string' || !row.id
        || rowIds.has(row.id)) return refuse('v2_completion_pack_invalid');
      rowIds.add(row.id);
      const entries=Array.isArray(row.entries) ? row.entries :
        Object.prototype.hasOwnProperty.call(row,'value')
          ? [{value:row.value,sequence:row.sequence}] : [];
      if (!entries.length) return refuse('v2_completion_pack_invalid');
      const nonpilot=entries.filter(e=>!isPilotCompletion(e?.value));
      if (!nonpilot.length) {
        if (wanted.has(row.id)) return refuse('v2_completion_id_collides_with_pilot');
        otherRows.push(row);
        continue;
      }
      if (nonpilot.length!==1 || entries.length!==1
        || nonpilot[0].value?.id!==row.id
        || !['task','work','metric'].includes(String(nonpilot[0].value?.source||''))
        || typeof nonpilot[0].value?.taskId!=='string'
        || !nonpilot[0].value.taskId)
        return refuse('v2_nonpilot_completion_evidence_preserved',{conflictingId:row.id});
      oldById.set(row.id,row);
    }
    if (!oldById.size && desired.length && !seal)
      return refuse('task_completion_history_backfill_required');

    const ordered=rows=>rows.slice().sort((a,b)=>a.id.localeCompare(b.id));
    const oldOrdered=ordered([...oldById.values()]);
    let oldFingerprint;
    try { oldFingerprint=await previewRecoveryFingerprint(oldOrdered); }
    catch (_) { return refuse('task_completion_reconcile_digest_unavailable'); }

    if (seal) {
      // The prior reconciliation's metadata and receipt form one committed
      // provenance checkpoint. Any independent preview change makes it stale.
      const priorReceipt=receipts.find(r=>r.id===seal.receiptId);
      if (seal.schemaVersion!==1 || seal.resetGeneration!==generation
        || seal.stateFingerprint!==oldFingerprint
        || seal.count!==oldById.size
        || !priorReceipt || priorReceipt.type!=='task-preview-completion-reconcile'
        || priorReceipt.resetGeneration!==generation
        || priorReceipt.nextFingerprint!==oldFingerprint
        || priorReceipt.nextCount!==seal.count
        || priorReceipt.id!==seal.receiptId)
        return refuse('task_completion_reconcile_prior_seal_invalid');
    } else if (oldById.size) {
      // Old batch receipts include the SHA-256 of the exact ordered packed
      // rows they atomically inserted. Require nonoverlapping, complete
      // coverage before allowing any historical record to be overwritten.
      const covered=new Set();
      const batches=receipts.filter(r=>r.type==='task-preview-completion-batch'
        && r.resetGeneration===generation);
      if (!batches.length)
        return refuse('task_completion_reconcile_provenance_missing');
      try {
        for (const receipt of batches) {
          if (!Array.isArray(receipt.ids) || !receipt.ids.length
            || receipt.ids.length>64 || new Set(receipt.ids).size!==receipt.ids.length)
            return refuse('task_completion_reconcile_provenance_invalid');
          const values=[];
          for (const id of receipt.ids) {
            if (!oldById.has(id) || covered.has(id))
              return refuse('task_completion_reconcile_provenance_invalid');
            covered.add(id);
            values.push(oldById.get(id));
          }
          if (await previewRecoveryFingerprint(values)!==receipt.batchFingerprint)
            return refuse('task_completion_reconcile_provenance_mismatch');
        }
      } catch (_) { return refuse('task_completion_reconcile_provenance_unreadable'); }
      if (covered.size!==oldById.size)
        return refuse('task_completion_reconcile_provenance_missing');
    }
    try { if (!sourceCurrent()) return refuse('legacy_changed_during_reconcile'); }
    catch (_) { return refuse('legacy_unreadable_during_reconcile'); }

    const target=ordered(desired);
    const changed=target.filter(row=>stableJson(row)!==stableJson(oldById.get(row.id)));
    const removed=oldOrdered.filter(row=>!wanted.has(row.id));
    const newRows=changed.filter(row=>!oldById.has(row.id));
    const deltaCount=changed.length+removed.length;
    if (!deltaCount) {
      // A no-op still needs an independent live comparison, not just the
      // earlier read of V2 and its stored evidence.
      let parity;
      try { parity=desired.length
        ? await inspectPreviewTaskCompletionOrderParity()
        : await (async()=>{
            const tx=db.transaction('completions','readonly');
            const rows=await requestPromise(tx.objectStore('completions').getAll());
            return {match:stableJson(ordered(rows))===stableJson(ordered(beforeRows))};
          })(); }
      catch (_) { return refuse('task_completion_reconcile_noop_unreadable'); }
      if (!parity.match) return refuse('task_completion_reconcile_noop_mismatch',{
        prerequisiteReason:parity.reason
      });
      try { if (!sourceCurrent()) return refuse('legacy_changed_after_noop_check'); }
      catch (_) { return refuse('legacy_unreadable_after_noop_check'); }
      return {
        checked:true,previewOnly:true,committed:false,confirmedDurable:true,
        collectionParityVerified:true,changedRows:0,deletedRows:0,
        addedRows:0,reason:'task_completion_history_already_current',
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    }
    if (deltaCount>64)
      return refuse('task_completion_reconcile_batch_too_large',{
        changedRows:deltaCount,maxAtomicRows:64
      });
    const bytes=changed.reduce((n,r)=>n+JSON.stringify(r).length+1,2)
      +removed.reduce((n,r)=>n+JSON.stringify(r).length+1,0);
    if (bytes>240000) return refuse('task_completion_reconcile_payload_too_large');
    let nextFingerprint;
    try { nextFingerprint=await previewRecoveryFingerprint(target); }
    catch (_) { return refuse('task_completion_reconcile_digest_unavailable'); }
    try { if (!sourceCurrent()) return refuse('legacy_changed_before_write'); }
    catch (_) { return refuse('legacy_unreadable_before_write'); }
    const receiptId='task-preview-completion-reconcile:'+actionId;
    if (receipts.some(r=>r.id===receiptId))
      return refuse('task_completion_reconcile_action_id_conflict');
    const receipt={
      id:receiptId,type:'task-preview-completion-reconcile',
      resetGeneration:generation,sourceInventory:signature,
      priorFingerprint:oldFingerprint,nextFingerprint,
      priorCount:oldById.size,nextCount:target.length,
      changedIds:changed.map(r=>r.id),deletedIds:removed.map(r=>r.id)
    };
    const nextSeal={
      id:'task-preview-completion-reconcile',schemaVersion:1,
      resetGeneration:generation,sourceInventory:signature,
      stateFingerprint:nextFingerprint,count:target.length,
      receiptId,capturedAtISO:nowIso()
    };
    let failure=null;
    const abort=(tx,reason)=>{failure=reason;try{tx.abort();}catch(_){}};
    try {
      const tx=db.transaction(['tasks','completions','mutations','meta'],'readwrite');
      const reads=[
        tx.objectStore('completions').getAll(),
        tx.objectStore('tasks').getAll(),
        tx.objectStore('mutations').getAll(),
        tx.objectStore('meta').get('task-preview-completion-reconcile'),
        tx.objectStore('meta').get(RUNTIME_META_ID),
        tx.objectStore('meta').get('task-preview')
      ];
      const values=new Array(reads.length);
      let pending=reads.length;
      reads.forEach((req,i)=>{req.onsuccess=()=>{
        values[i]=req.result;
        if (--pending!==0) return;
        try {
          if (!sourceCurrent()) return abort(tx,'legacy_changed_under_transaction');
          if (stableJson(values[0])!==stableJson(beforeRows)
            || stableJson(values[1])!==stableJson(taskRows)
            || stableJson(values[2])!==stableJson(receipts)
            || stableJson(values[3])!==stableJson(seal)
            || stableJson(values[4])!==stableJson(meta)
            || stableJson(values[5])!==stableJson(taskEvidence))
            return abort(tx,'task_completion_reconcile_concurrent_change');
          const completionStore=tx.objectStore('completions');
          for (const row of removed) completionStore.delete(row.id);
          for (const row of changed) completionStore.put(row);
          tx.objectStore('mutations').add(receipt);
          tx.objectStore('meta').put(nextSeal);
        } catch (_) { abort(tx,'task_completion_reconcile_atomic_write_failed'); }
      };});
      await transactionPromise(tx);
    } catch (_) { return refuse(failure||'task_completion_reconcile_atomic_write_failed'); }

    // Durable evidence comes from a second independent read transaction.
    const expectedAll=ordered(otherRows.concat(target));
    try {
      const tx=db.transaction(['completions','mutations','meta'],'readonly');
      const [actual,storedReceipt,storedSeal,storedMeta]=await Promise.all([
        requestPromise(tx.objectStore('completions').getAll()),
        requestPromise(tx.objectStore('mutations').get(receiptId)),
        requestPromise(tx.objectStore('meta').get('task-preview-completion-reconcile')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID))
      ]);
      if (stableJson(ordered(actual))!==stableJson(expectedAll)
        || stableJson(storedReceipt)!==stableJson(receipt)
        || stableJson(storedSeal)!==stableJson(nextSeal)
        || stableJson(storedMeta)!==stableJson(meta))
        return refuse('task_completion_reconcile_readback_unverified',{
          committed:true,writeOutcomeUncertain:true
        });
      if (!sourceCurrent()) return refuse('legacy_changed_after_preview_commit',{
        committed:true,confirmedDurable:true,writeOutcomeUncertain:true
      });
      const parity=target.length
        ? await inspectPreviewTaskCompletionOrderParity()
        : {match:true};
      if (!parity.match) return refuse('task_completion_reconcile_parity_unverified',{
        committed:true,confirmedDurable:true,writeOutcomeUncertain:true,
        prerequisiteReason:parity.reason
      });
      if (!sourceCurrent()) return refuse('legacy_changed_after_parity',{
        committed:true,confirmedDurable:true,writeOutcomeUncertain:true
      });
      return {
        checked:true,previewOnly:true,committed:true,confirmedDurable:true,
        collectionParityVerified:true,
        changedRows:deltaCount,addedRows:newRows.length,
        deletedRows:removed.length,taskCompletionCount:target.length,
        reason:'task_completion_history_reconciled',
        canPromote:false,productionWritersFenced:false,
        readAuthority:'legacy_only',mutationAuthority:'legacy_only'
      };
    } catch (_) {
      return refuse('task_completion_reconcile_readback_unavailable',{
        committed:true,writeOutcomeUncertain:true
      });
    }
  }

  async function inspectPreviewTaskCompletionOrderParity() {
    const refuse = (reason, details = {}) => ({
      checked: true, previewOnly: true, match: false,
      completionOrderingVerified: false, fullCompatibilityVerified: false,
      canPromote: false, productionWritersFenced: false,
      readAuthority: 'legacy_only', mutationAuthority: 'legacy_only',
      comparisonScope: 'existing_v1_task_work_metric_completions_only',
      reason, ...details
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof core.readTaskPointsStoredState !== 'function'
      || typeof core.readPendingTaskMutations !== 'function')
      return refuse('legacy_task_reader_unavailable');
    const generation = currentGeneration({ create: false });
    if (!generation) return refuse('generation_unavailable');
    const modeEpoch = darkMirrorModeEpoch;
    let sourceInventory, tasks, expectedRows, taskFingerprint, excludedCount;
    let unsupportedNonpilotCount;
    try {
      sourceInventory = captureReadOnlyFullStorageInventory();
      const pending = core.readPendingTaskMutations();
      if (pending?.malformed) return refuse('legacy_task_journal_malformed');
      const state = core.readTaskPointsStoredState();
      if (!state || !Array.isArray(state.tasks)
        || !Array.isArray(state.completions))
        return refuse('legacy_tasks_or_completions_missing');
      tasks = clone(state.tasks);
      const taskIds = new Set();
      for (const task of tasks) {
        if (!task || typeof task !== 'object' || Array.isArray(task)
          || task.id == null || !String(task.id)
          || taskIds.has(String(task.id)))
          return refuse('legacy_task_ids_invalid');
        taskIds.add(String(task.id));
      }
      const supported = completion =>
        ['task', 'work', 'metric'].includes(String(completion?.source || ''))
        && typeof completion?.taskId === 'string' && Boolean(completion.taskId);
      const scoped = state.completions.map((value, index) => ({value, index}))
        .filter(entry => supported(entry.value));
      excludedCount = state.completions.length - scoped.length;
      unsupportedNonpilotCount = state.completions.filter(
        entry => !isPilotCompletion(entry) && !supported(entry)
      ).length;
      const seen = new Set();
      expectedRows = [];
      for (const entry of scoped) {
        const item = entry.value;
        if (typeof item.id !== 'string' || !item.id || seen.has(item.id))
          return refuse('legacy_completion_id_ambiguous');
        seen.add(item.id);
        if (!taskIds.has(item.taskId)) return refuse('linked_legacy_task_missing');
        if (isPilotCompletion(item)) return refuse('completion_scope_overlap');
        expectedRows.push(withCompletionHabitIds({
          id: item.id,
          entries: [{value: clone(item), sequence: -(entry.index + 1)}]
        }));
      }
      if (!expectedRows.length)
        return refuse('task_completion_no_supported_records', {
          scopedCompletionCount: 0, excludedCompletionCount: excludedCount,
          unsupportedNonpilotCount
        });
      if (captureReadOnlyFullStorageInventory() !== sourceInventory)
        return refuse('legacy_changed_during_capture');
      taskFingerprint = await previewRecoveryFingerprint(tasks);
    } catch (_) { return refuse('legacy_completion_order_capture_unreadable'); }

    const sourceCurrent = () => isDarkEnabled()
      && darkMirrorModeEpoch === modeEpoch
      && currentGeneration({create:false}) === generation
      && captureReadOnlyFullStorageInventory() === sourceInventory;
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_before_inspection');
    } catch (_) { return refuse('legacy_unreadable_before_inspection'); }
    let taskRows, completionRows, evidence, meta;
    try {
      const db = await open();
      if (!db) return refuse('dark_disabled');
      const tx = db.transaction(['tasks','completions','meta'], 'readonly');
      [taskRows, completionRows, evidence, meta] = await Promise.all([
        requestPromise(tx.objectStore('tasks').getAll()),
        requestPromise(tx.objectStore('completions').getAll()),
        requestPromise(tx.objectStore('meta').get('task-preview')),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID))
      ]);
    } catch (_) { return refuse('task_completion_order_read_unavailable'); }
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_during_inspection');
      if (meta?.schemaVersion !== SCHEMA_VERSION
        || meta.resetGeneration !== generation || meta.legacyMissing === true)
        return refuse('pilot_meta_not_ready');
      if (!evidence) return refuse('task_preview_missing');
      if (evidence.schemaVersion !== 1 || evidence.resetGeneration !== generation)
        return refuse('task_preview_generation_mismatch');
      const inventorySignature = `${fnv1a(sourceInventory)}:${sourceInventory.length}`;
      if (evidence.taskFingerprint !== taskFingerprint
        || evidence.sourceInventory !== inventorySignature)
        return refuse('task_preview_source_stale');
      if (evidence.taskCount !== tasks.length || taskRows.length !== tasks.length)
        return refuse('task_preview_record_mismatch');
      const orderedTasks = taskRows.slice()
        .sort((a,b)=>Number(a?.legacyIndex)-Number(b?.legacyIndex));
      for (let index=0;index<tasks.length;index++) {
        const row=orderedTasks[index],expected=tasks[index];
        if (!row || row.id !== String(expected.id)
          || row.legacyIndex !== index
          || stableJson(row.value) !== stableJson(expected))
          return refuse('task_preview_record_mismatch');
      }
      const expected = new Map(expectedRows.map(row=>[row.id,row]));
      const actual = new Map();
      for (const row of completionRows) {
        if (!row || typeof row.id !== 'string')
          return refuse('task_completion_row_malformed');
        const entries = Array.isArray(row.entries) ? row.entries
          : Object.prototype.hasOwnProperty.call(row,'value')
            ? [{value:row.value,sequence:row.sequence}] : [];
        if (!entries.length) return refuse('task_completion_row_malformed');
        const scopedEntries = entries.filter(entry =>
          ['task','work','metric'].includes(String(entry?.value?.source || ''))
          && typeof entry?.value?.taskId === 'string'
          && Boolean(entry.value.taskId));
        if (!scopedEntries.length) continue;
        // A packed row that mixes Habit and Task completions cannot be
        // safely interpreted as a single logical record.
        if (scopedEntries.length !== 1 || entries.length !== 1
          || actual.has(row.id)) return refuse('task_completion_row_collision');
        actual.set(row.id,row);
      }
      if (actual.size !== expected.size) {
        const missing = [...expected.keys()].filter(id=>!actual.has(id)).length;
        const extra = [...actual.keys()].filter(id=>!expected.has(id)).length;
        return refuse(missing ? 'task_completion_preview_missing'
          : 'task_completion_preview_extra', {
          expectedCount: expected.size, actualCount: actual.size,
          missingCount: missing, extraCount: extra
        });
      }
      for (const [id, expectedRow] of expected) {
        if (!actual.has(id)) return refuse('task_completion_preview_missing');
        if (stableJson(actual.get(id)) !== stableJson(expectedRow))
          return refuse('task_completion_preview_record_mismatch');
      }
      // Compare original V1 list order, NOT date stamps. V1 ordering may
      // contain same-timestamp entries. Negative preview sequences encode
      // the exact original array position for this isolated record class.
      const expectedOrder = expectedRows.map(row=>row.id);
      const actualOrder = [...actual.values()]
        .sort((a,b)=>b.entries[0].sequence-a.entries[0].sequence)
        .map(row=>row.id);
      if (stableJson(expectedOrder) !== stableJson(actualOrder))
        return refuse('task_completion_preview_order_mismatch');
      if (!sourceCurrent()) return refuse('legacy_changed_after_inspection');
      return {
        checked: true, previewOnly: true, match: true,
        completionOrderingVerified: true,
        fullCompatibilityVerified: false,
        comparisonScope: 'existing_v1_task_work_metric_completions_only',
        scopedCompletionCount: expectedRows.length,
        excludedCompletionCount: excludedCount,
        unsupportedNonpilotCount,
        reason: 'task_completion_scoped_order_verified',
        canPromote: false, productionWritersFenced: false,
        readAuthority: 'legacy_only', mutationAuthority: 'legacy_only'
      };
    } catch (_) { return refuse('task_completion_order_unreadable'); }
  }

  // PREVIEW HOST ONLY: independently audit the mixed completion history
  // that buildCompatibilitySnapshot would export. No call to seedFromLegacy
  // or buildCompatibilitySnapshot: both may perform IDB writes on startup.
  // This inspection opens only readonly transactions and never auto-heals.
  async function inspectPreviewMixedCompletionExport() {
    const refuse = (reason, detail = {}) => ({
      checked: true, previewOnly: true, match: false,
      mixedCompletionOrderVerified: false, fullExportVerified: false,
      canPromote: false, productionWritersFenced: false,
      readAuthority: 'legacy_only', mutationAuthority: 'legacy_only',
      comparisonScope: 'effective_v1_interleaved_completion_history',
      reason, ...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    const modeEpoch = darkMirrorModeEpoch;
    const generation = currentGeneration({ create: false });
    if (!generation) return refuse('generation_unavailable');
    let inventory, effective, v1PilotHash;
    try {
      inventory = captureReadOnlyFullStorageInventory();
      const source = parseLegacyStateWithPending();
      if (source.missing) return refuse('legacy_unavailable');
      effective = applyTaskJournalToCompatibilitySource(source.state);
      if (captureReadOnlyFullStorageInventory() !== inventory)
        return refuse('legacy_changed_during_capture');
      v1PilotHash = stableJson(paritySubset(effective));
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes('compatibility_task_journal_malformed'))
        return refuse('legacy_task_journal_malformed');
      if (message.includes('compatibility_task_journal_unavailable'))
        return refuse('legacy_task_journal_unavailable');
      return refuse('legacy_mixed_completion_unreadable');
    }
    const sourceCurrent = () => isDarkEnabled()
      && darkMirrorModeEpoch === modeEpoch
      && currentGeneration({ create: false }) === generation
      && captureReadOnlyFullStorageInventory() === inventory;
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_before_inspection');
    } catch (_) { return refuse('legacy_unreadable_before_inspection'); }
    let habits, completions, meta;
    try {
      const db = await open();
      if (!db) return refuse('dark_disabled');
      const tx = db.transaction(['habits','completions','meta'], 'readonly');
      const [habitRows, completionRows, metadata] = await Promise.all([
        requestPromise(tx.objectStore('habits').getAll()),
        requestPromise(tx.objectStore('completions').getAll()),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID))
      ]);
      habits = habitRows.slice()
        .sort((a,b)=>Number(a.legacyIndex)-Number(b.legacyIndex))
        .map(row=>clone(row.value));
      completions = unpackCompletionRows(completionRows);
      meta = metadata;
    } catch (_) { return refuse('v2_mixed_completion_read_unavailable'); }
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_during_inspection');
      if (!meta || meta.schemaVersion !== SCHEMA_VERSION
        || meta.resetGeneration !== generation || meta.legacyMissing === true)
        return refuse('pilot_meta_not_ready');
      // The compatibility function overlays pilot rows only; a V2-only
      // Task/Work completion may exist for preview but cannot enter exports.
      const v2PilotHash = stableJson(paritySubset({habits,completions}));
      if (v1PilotHash !== v2PilotHash)
        return refuse('pilot_parity_mismatch');
      const candidate = mergeCompatibilityCompletions(effective.completions, completions);
      const original = effective.completions;
      const mixedMatch = stableJson(candidate) === stableJson(original);
      if (!mixedMatch) {
        const firstDifference = candidate.findIndex((row,index)=>
          stableJson(row) !== stableJson(original[index]));
        return refuse('mixed_completion_export_mismatch', {
          expectedCount: original.length, actualCount: candidate.length,
          firstDifferenceIndex: firstDifference < 0 ? Math.min(candidate.length,original.length)
            : firstDifference
        });
      }
      if (!sourceCurrent()) return refuse('legacy_changed_after_inspection');
      return {
        checked: true, previewOnly: true, match: true,
        mixedCompletionOrderVerified: true, fullExportVerified: false,
        comparisonScope: 'effective_v1_interleaved_completion_history',
        completionCount: original.length,
        habitCompletionCount: original.filter(isPilotCompletion).length,
        legacyNonpilotCompletionCount: original.filter(row=>!isPilotCompletion(row)).length,
        // Main's intentional zero-point Calories skip must survive the
        // exact V1-to-V2 compatibility projection, not become a scored day.
        caloriesNotTrackedCount: original.filter(row =>
          row?.caloriesNotTracked === true
          && /^Calories\b/i.test(String(row?.title || ''))).length,
        // Extra V2 nonpilot rows are NOT promoted into compatibility snapshots.
        v2NonpilotPreviewRowCount: completions.filter(row=>!isPilotCompletion(row)).length,
        reason: 'mixed_completion_export_order_verified',
        canPromote: false, productionWritersFenced: false,
        readAuthority: 'legacy_only', mutationAuthority: 'legacy_only'
      };
    } catch (_) { return refuse('mixed_completion_export_unreadable'); }
  }

  // PREVIEW-HOST-ONLY snapshot projection audit. This is deliberately
  // read-only: it never invokes seedFromLegacy() or the compatibility
  // builder, and it never treats V2's nonpilot preview rows as authoritative.
  // It validates every retained V1 field and mixed completion position,
  // while comparing V2 Habit fields using existing, narrowly documented
  // parity normalization. It does NOT certify a production export or backup.
  async function inspectPreviewWholeCompatibilityProjection() {
    const refuse = (reason, detail = {}) => ({
      checked: true, previewOnly: true, match: false,
      wholeProjectionVerified: false, fullExportVerified: false,
      canPromote: false, productionWritersFenced: false,
      readAuthority: 'legacy_only', mutationAuthority: 'legacy_only',
      comparisonScope: 'effective_v1_full_snapshot_plus_v2_pilot_overlay',
      reason, ...detail
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    const generation = currentGeneration({ create: false });
    if (!generation) return refuse('generation_unavailable');
    const modeEpoch = darkMirrorModeEpoch;
    let inventory, effective;
    try {
      inventory = captureReadOnlyFullStorageInventory();
      const source = parseLegacyStateWithPending();
      if (source.missing) return refuse('legacy_unavailable');
      effective = applyTaskJournalToCompatibilitySource(source.state);
      if (!effective || !Array.isArray(effective.habits)
        || !Array.isArray(effective.tasks)
        || !Array.isArray(effective.completions))
        return refuse('legacy_snapshot_invalid');
      if (captureReadOnlyFullStorageInventory() !== inventory)
        return refuse('legacy_changed_during_capture');
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes('compatibility_task_journal_malformed'))
        return refuse('legacy_task_journal_malformed');
      if (message.includes('compatibility_task_journal_unavailable'))
        return refuse('legacy_task_journal_unavailable');
      return refuse('legacy_snapshot_unreadable');
    }
    const sourceCurrent = () => isDarkEnabled()
      && darkMirrorModeEpoch === modeEpoch
      && currentGeneration({ create: false }) === generation
      && captureReadOnlyFullStorageInventory() === inventory;
    try {
      if (!sourceCurrent()) return refuse('legacy_changed_before_inspection');
    } catch (_) { return refuse('legacy_unreadable_before_inspection'); }

    let db, habitRows, completionRows, meta;
    try {
      db = await open();
      if (!db) return refuse('dark_disabled');
      const tx = db.transaction(['habits','completions','meta'], 'readonly');
      [habitRows, completionRows, meta] = await Promise.all([
        requestPromise(tx.objectStore('habits').getAll()),
        requestPromise(tx.objectStore('completions').getAll()),
        requestPromise(tx.objectStore('meta').get(RUNTIME_META_ID))
      ]);
    } catch (_) { return refuse('v2_snapshot_projection_unreadable'); }

    try {
      if (!sourceCurrent()) return refuse('legacy_changed_during_inspection');
      if (!meta || meta.schemaVersion !== SCHEMA_VERSION
        || meta.resetGeneration !== generation || meta.legacyMissing === true)
        return refuse('pilot_meta_not_ready');
      const sorted = habitRows.slice().sort(
        (a,b) => Number(a?.legacyIndex) - Number(b?.legacyIndex)
      );
      if (sorted.length !== effective.habits.length)
        return refuse('pilot_habit_count_mismatch');
      const seenHabits = new Set();
      for (let index=0;index<sorted.length;index++) {
        const row = sorted[index], legacy = effective.habits[index];
        if (!row || row.legacyIndex !== index
          || String(row.id) !== String(legacy?.id)
          || seenHabits.has(String(row.id)))
          return refuse('pilot_habit_identity_mismatch');
        seenHabits.add(String(row.id));
      }
      const habits = sorted.map(row=>clone(row.value));
      const completions = unpackCompletionRows(completionRows);
      if (stableJson(paritySubset({habits,completions}))
        !== stableJson(paritySubset(effective)))
        return refuse('pilot_parity_mismatch');

      const candidate = {
        ...effective, habits,
        completions: mergeCompatibilityCompletions(effective.completions, completions)
      };
      const expectedKeys = Object.keys(effective).sort();
      if (stableJson(Object.keys(candidate).sort()) !== stableJson(expectedKeys))
        return refuse('snapshot_top_level_fields_mismatch');
      // Inspect all source data, not only completions. Only the established
      // Habit derived-cache/default and pilot full-fraction equivalences
      // are normalized. Nonpilot completions, Tasks, settings, and every
      // unrelated JSON field must remain exact in payload and ordering.
      const normalize = state => ({
        ...state,
        habits: state.habits.map(normalizeHabitForParity),
        completions: state.completions.map(row => isPilotCompletion(row)
          ? normalizePilotCompletionForParity(row) : row)
      });
      const expected = normalize(effective), actual = normalize(candidate);
      if (stableJson(expected) !== stableJson(actual)) {
        if (stableJson(expected.completions) !== stableJson(actual.completions))
          return refuse('mixed_completion_projection_mismatch', {
            expectedCount: expected.completions.length,
            actualCount: actual.completions.length
          });
        if (stableJson(expected.habits) !== stableJson(actual.habits))
          return refuse('habit_projection_mismatch');
        return refuse('nonpilot_source_field_mismatch');
      }
      const metaAfter = await readMeta(db);
      if (!sourceCurrent()) return refuse('legacy_changed_after_inspection');
      if (stableJson(metaAfter) !== stableJson(meta))
        return refuse('v2_revision_changed_during_inspection');
      const normalizedFingerprint = await previewRecoveryFingerprint(actual);
      if (!sourceCurrent()) return refuse('legacy_changed_after_fingerprint');
      // Re-read meta after SHA-256, since digest calculation is asynchronous.
      if (stableJson(await readMeta(db)) !== stableJson(meta))
        return refuse('v2_revision_changed_after_fingerprint');
      if (!sourceCurrent()) return refuse('legacy_changed_after_inspection');
      return {
        checked: true, previewOnly: true, match: true,
        wholeProjectionVerified: true, fullExportVerified: false,
        comparisonScope: 'effective_v1_full_snapshot_plus_v2_pilot_overlay',
        normalizedFingerprint,
        topLevelFieldCount: expectedKeys.length,
        habitCount: effective.habits.length,
        taskCount: effective.tasks.length,
        completionCount: effective.completions.length,
        nonpilotCompletionCount: effective.completions.filter(
          row=>!isPilotCompletion(row)
        ).length,
        caloriesNotTrackedCount: effective.completions.filter(row =>
          row?.caloriesNotTracked === true
          && /^Calories\b/i.test(String(row?.title || ''))).length,
        // The preview store can contain divergent Task rows; those are
        // deliberately NOT promoted into the compatibility projection.
        v2NonpilotPreviewCompletionCount: completions.filter(
          row=>!isPilotCompletion(row)
        ).length,
        reason: 'whole_compatibility_projection_verified',
        canPromote: false, productionWritersFenced: false,
        readAuthority: 'legacy_only', mutationAuthority: 'legacy_only'
      };
    } catch (_) { return refuse('whole_compatibility_projection_unreadable'); }
  }

  // A narrower stepping stone toward REQUIRED writer admission, rather
  // than relying on the caller to invoke an optional freshness callback.
  // This API is explicit, PREVIEW-HOST-ONLY and NEVER installs on the live
  // V1 Task/Work/SCWM writer. Its only sink is the existing synchronous V1
  // atomic Task completion journal; no primary-authority migration occurs.
  //
  // Every admitted action must pass the full-origin source token, generation,
  // dark-mode epoch, exclusive cooperative lock, journal writeability and
  // a synchronous durable readback. A nonparticipating old tab can still
  // race after observation: therefore NO production-wide fencing claim.
  async function rehearsePreviewAdmittedTaskCompletionBatch(rowsInput, expectedInventoryToken) {
    const refuse = (reason, details = {}) => ({
      checked: true, previewOnly: true, committed: false,
      confirmedDurable: false, canPromote: false,
      productionWritersFenced: false, mutationAuthority: 'legacy_only',
      readAuthority: 'legacy_only', reason, ...details
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (typeof expectedInventoryToken !== 'string' || !expectedInventoryToken.length)
      return refuse('full_origin_token_required');
    const locks = global.navigator?.locks;
    if (typeof locks?.request !== 'function') return refuse('lock_manager_unavailable');
    if (typeof core.journalTaskCompletionBatch !== 'function'
      || typeof core.assertTaskMutationJournalWritable !== 'function')
      return refuse('atomic_task_journal_unavailable');
    // A JSON round-trip alone can SILENTLY change caller data (Infinity to
    // null, undefined/function fields omitted, sparse array holes to null,
    // Date/toJSON transformed). Before freezing, reject any lossy input.
    // Read property DESCRIPTORS so getters never run during validation.
    function isLosslessJsonData(root) {
      const active = new WeakSet();
      let visited = 0;
      function check(value, depth) {
        if (++visited > 32768 || depth > 48) return false;
        if (value === null || typeof value === 'string'
          || typeof value === 'boolean') return true;
        if (typeof value === 'number') return Number.isFinite(value);
        if (typeof value !== 'object' || active.has(value)) return false;
        const array = Array.isArray(value);
        const prototype = Object.getPrototypeOf(value);
        if (array ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null) return false;
        if ('toJSON' in value) return false;
        const keys = Reflect.ownKeys(value);
        if (array) {
          if (value.length > 32768 || keys.length !== value.length + 1
            || Object.keys(value).length !== value.length) return false;
        }
        active.add(value);
        for (const key of keys) {
          if (array && key === 'length') continue;
          if (typeof key !== 'string') return false;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)
            || !check(descriptor.value, depth + 1)) return false;
        }
        active.delete(value);
        return true;
      }
      return check(root, 0);
    }
    // Freeze the logical action *before* acquiring an asynchronous lock:
    // changed caller objects cannot silently substitute a different write.
    let rows;
    try {
      if (!Array.isArray(rowsInput) || !rowsInput.length || rowsInput.length > 64
        || !isLosslessJsonData(rowsInput))
        return refuse('invalid_completion_batch');
      const json = JSON.stringify(rowsInput);
      if (typeof json !== 'string' || json.length > 262144)
        return refuse('invalid_completion_batch');
      rows = JSON.parse(json);
      const ids = new Set();
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)
          || typeof row.id !== 'string' || !row.id || row.id.length > 128
          || ids.has(row.id)) return refuse('invalid_completion_batch');
        ids.add(row.id);
      }
    } catch (_) { return refuse('invalid_completion_batch'); }
    const originalEpoch = darkMirrorModeEpoch;
    const expectedGeneration = currentGeneration({ create: false });
    if (!expectedGeneration) return refuse('generation_unavailable');
    let result = refuse('lock_not_available');
    try {
      await locks.request(EXCLUSIVE_WRITER_REHEARSAL_LOCK,
        { mode: 'exclusive', ifAvailable: true }, lock => {
          if (!lock) { result = refuse('lock_held_elsewhere'); return; }
          if (!isDarkEnabled() || darkMirrorModeEpoch !== originalEpoch
            || currentGeneration({ create: false }) !== expectedGeneration) {
            result = refuse('generation_or_preview_changed_under_lock');
            return;
          }
          let currentInventory;
          try { currentInventory = captureReadOnlyFullStorageInventory(); }
          catch (_) {
            result = refuse('full_origin_unreadable');
            return;
          }
          if (currentInventory !== expectedInventoryToken) {
            result = refuse('full_origin_changed');
            return;
          }
          // From here through the journal setItem/readback are synchronous.
          // Our lock excludes COOPERATING tabs but not older V1 pages.
          try { core.assertTaskMutationJournalWritable(); }
          catch (_) {
            result = refuse('task_journal_not_writable');
            return;
          }
          let priorJournal;
          try { priorJournal = global.localStorage.getItem('taskpoints_pending_task_mutations_v1'); }
          catch (_) {
            result = refuse('task_journal_unreadable');
            return;
          }
          // Production V1's normalizer intentionally tolerates old journal
          // shapes. That is NOT safe evidence for a preview admission:
          // malformed/duplicate rows and unknown top-level metadata could be
          // dropped when the batch helper serializes the normalized record.
          // Refuse those sources BEFORE any write, leaving their raw bytes for
          // diagnosis/recovery rather than acknowledging selective survival.
          function canonicalPriorJournal(raw) {
            if (raw === null) return true;
            if (typeof raw !== 'string' || !raw.length) return false;
            let value;
            try { value = JSON.parse(raw); } catch (_) { return false; }
            if (!value || typeof value !== 'object' || Array.isArray(value)
              || value.schemaVersion !== 1
              || !Array.isArray(value.tasks)
              || !Array.isArray(value.completionUpserts)
              || !Array.isArray(value.completionDeletes)
              || !(value.updatedAtISO === null || typeof value.updatedAtISO === 'string'))
              return false;
            const keys = Object.keys(value).sort();
            if (stableJson(keys) !== stableJson([
              'completionDeletes', 'completionUpserts', 'schemaVersion',
              'tasks', 'updatedAtISO'
            ])) return false;
            const uniqueRows = list => {
              const ids = new Set();
              return list.every(row => {
                if (!row || typeof row !== 'object' || Array.isArray(row)
                  || typeof row.id !== 'string' || !row.id || row.id.length > 128
                  || ids.has(row.id)) return false;
                ids.add(row.id);
                return true;
              });
            };
            if (!uniqueRows(value.tasks) || !uniqueRows(value.completionUpserts))
              return false;
            const deletes = new Set();
            for (const id of value.completionDeletes) {
              if (typeof id !== 'string' || !id || id.length > 128
                || deletes.has(id)) return false;
              deletes.add(id);
            }
            return true;
          }
          if (!canonicalPriorJournal(priorJournal)) {
            result = refuse('task_journal_source_not_canonical');
            return;
          }
          // The journal-writability check above can take time or inspect
          // storage. An older, non-cooperating tab may modify a different
          // legacy key after our first full-origin preflight. Recheck the
          // complete inventory right before the synchronous journal write.
          // This narrows the race window; it is NOT an atomic cross-tab fence.
          try {
            if (captureReadOnlyFullStorageInventory() !== expectedInventoryToken) {
              result = refuse('full_origin_changed_after_writability_check');
              return;
            }
          } catch (_) {
            result = refuse('full_origin_unreadable_after_writability_check');
            return;
          }
          if (!isDarkEnabled() || darkMirrorModeEpoch !== originalEpoch
            || currentGeneration({ create: false }) !== expectedGeneration) {
            result = refuse('generation_or_preview_changed_before_write');
            return;
          }
          try {
            core.journalTaskCompletionBatch(rows);
          } catch (_) {
            // Do not assert an unconfirmed failure rolled back a durable write:
            // a custom host or a post-write error might already have saved it.
            result = refuse('task_journal_write_failed', {
              writeOutcomeUncertain: true
            });
            return;
          }
          // A journal API return value alone does NOT prove a durable write.
          // Re-read exact synchronous storage and verify every changed row.
          let verified = false;
          try {
            const after = global.localStorage.getItem('taskpoints_pending_task_mutations_v1');
            if (typeof after === 'string' && after !== priorJournal) {
              const stored = JSON.parse(after);
              const before = priorJournal ? JSON.parse(priorJournal) : {};
              const targetIds = new Set(rows.map(row => row.id));
              const originalTasks = Array.isArray(before.tasks) ? before.tasks : [];
              const originalUpserts = Array.isArray(before.completionUpserts)
                ? before.completionUpserts : [];
              const originalDeletes = Array.isArray(before.completionDeletes)
                ? before.completionDeletes : [];
              const upserts = Array.isArray(stored.completionUpserts)
                ? stored.completionUpserts : [];
              const tasks = Array.isArray(stored.tasks) ? stored.tasks : [];
              const deletes = Array.isArray(stored.completionDeletes)
                ? stored.completionDeletes : [];
              const untouchedUpserts = list => list.filter(
                row => !targetIds.has(String(row?.id || '')));
              const untouchedDeletes = list => list.filter(
                id => !targetIds.has(String(id)));
              // Confirm both newly written rows AND all unrelated pending
              // work survived. A journal that dropped an older Task or
              // completion must not receive a clean durability acknowledgement.
              verified = stored.schemaVersion === 1
                && rows.every(row => {
                  const sameId = upserts.filter(saved => saved?.id === row.id);
                  return sameId.length === 1
                    && stableJson(sameId[0]) === stableJson(row);
                })
                && rows.every(row => !deletes.includes(row.id))
                && stableJson(tasks) === stableJson(originalTasks)
                && stableJson(untouchedUpserts(upserts))
                  === stableJson(untouchedUpserts(originalUpserts))
                && stableJson(untouchedDeletes(deletes))
                  === stableJson(untouchedDeletes(originalDeletes));
            }
          } catch (_) {}
          if (!verified) {
            result = refuse('task_journal_readback_unverified', {
              writeOutcomeUncertain: true
            });
            return;
          }
          // The journal is the ONLY expected change to the complete origin.
          // Detect a legacy writer that edits another key while the journal
          // call is running. The journal may already be durable: report an
          // uncertain commit, never pretend the action safely rolled back.
          try {
            const withoutJournal = token => {
              const entries = JSON.parse(token);
              if (!Array.isArray(entries)) throw Error('invalid_origin_inventory');
              return entries.filter(entry =>
                Array.isArray(entry)
                && entry[0] !== 'taskpoints_pending_task_mutations_v1');
            };
            const currentInventory = captureReadOnlyFullStorageInventory();
            if (stableJson(withoutJournal(currentInventory))
              !== stableJson(withoutJournal(expectedInventoryToken))) {
              result = refuse('full_origin_changed_during_journal_write', {
                committed: true, writeOutcomeUncertain: true
              });
              return;
            }
          } catch (_) {
            result = refuse('full_origin_unreadable_after_journal_write', {
              committed: true, writeOutcomeUncertain: true
            });
            return;
          }
          // A reset/opt-out after the write cannot be undone or reported as
          // a clean failure. Preserve the acknowledgement's uncertainty.
          let unchanged = false;
          try {
            unchanged = isDarkEnabled() && darkMirrorModeEpoch === originalEpoch
              && currentGeneration({ create: false }) === expectedGeneration;
          } catch (_) {}
          if (!unchanged) {
            result = refuse('generation_changed_after_write', {
              committed: true, writeOutcomeUncertain: true
            });
            return;
          }
          result = {
            checked: true, previewOnly: true, committed: true,
            confirmedDurable: true, reason: 'preview_task_batch_admitted',
            rowCount: rows.length, lockHeldAfterReturn: false,
            canPromote: false, productionWritersFenced: false,
            mutationAuthority: 'legacy_only', readAuthority: 'legacy_only'
          };
        });
    } catch (_) {
      return refuse('lock_request_failed', {
        writeOutcomeUncertain: result.writeOutcomeUncertain === true
          || result.committed === true
      });
    }
    return result;
  }

  
  // Explicit preview-only coordination for a real V1 Task journal adapter
  // and an isolated V2 writer-fence freeze. Both NEW entry points honor
  // this same-origin Web Lock. The original freeze, production V1 writers,
  // and older tabs do NOT honor it; this proves only cooperative ordering.
  const PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK =
    'taskpoints_v2_preview_task_freeze_cooperative_v1';

  async function rehearsePreviewCooperativeWriterFreeze(options = {}) {
    const refuse = (reason, extra = {}) => ({
      checked: true, previewOnly: true, cooperativeTaskFreezeLockUsed: false,
      canPromote: false, productionWritersFenced: false,
      mutationAuthority: 'legacy_only', readAuthority: 'legacy_only',
      reason, ...extra
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    const requestedEpoch = options?.expectedEpoch;
    if (!Number.isSafeInteger(requestedEpoch) || requestedEpoch < 0)
      return refuse('expected_epoch_required');
    const locks = global.navigator?.locks;
    if (typeof locks?.request !== 'function')
      return refuse('lock_manager_unavailable');
    const expectedGeneration = currentGeneration({ create: false });
    if (!expectedGeneration) return refuse('generation_unavailable');
    const originalEpoch = darkMirrorModeEpoch;
    // Capture the caller's decision BEFORE waiting on a shared browser lock.
    const freezeOptions = {
      expectedEpoch: requestedEpoch,
      requireAllKnownFamilies: options?.requireAllKnownFamilies === true
    };
    let result = refuse('cooperative_freeze_lock_not_available');
    let entered = false;
    try {
      await locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        { mode: 'exclusive', ifAvailable: true }, async lock => {
          if (!lock) {
            result = refuse('cooperative_freeze_lock_held_elsewhere');
            return;
          }
          if (!isDarkEnabled() || darkMirrorModeEpoch !== originalEpoch
            || currentGeneration({ create: false }) !== expectedGeneration) {
            result = refuse('generation_changed_under_cooperative_lock');
            return;
          }
          entered = true;
          const frozen = await rehearsePreviewDurableWriterFence(
            'freeze', freezeOptions);
          result = {
            ...frozen, cooperativeTaskFreezeLockUsed: true,
            canPromote: false, productionWritersFenced: false
          };
        });
    } catch (_) {
      // A failed lock callback may have committed the frozen fence already.
      // Never claim rollback: callers must inspect the durable control row.
      return refuse('cooperative_freeze_lock_request_failed', {
        freezeOutcomeUncertain: entered,
        inspectFenceBeforeRetry: entered
      });
    }
    return result;
  }

  // A real Task completion journal write can be guarded by the same shared
  // preview lock as the cooperative freeze. The existing V1 Task adapter
  // retains its own separate Web Lock, canonical-journal preflight, full-
  // origin checks and synchronous readback; NO production route is changed.
  async function rehearsePreviewFenceCheckedTaskCompletionBatch(rows, token) {
    const refuse = (reason, extra = {}) => ({
      checked: true, previewOnly: true, previewFenceChecked: false,
      cooperativeTaskFreezeLockUsed: false,
      committed: false, confirmedDurable: false, canPromote: false,
      productionWritersFenced: false, mutationAuthority: 'legacy_only',
      readAuthority: 'legacy_only', reason, ...extra
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    const locks = global.navigator?.locks;
    if (typeof locks?.request !== 'function')
      return refuse('lock_manager_unavailable');
    const initialGeneration = currentGeneration({ create: false });
    if (!initialGeneration) return refuse('generation_unavailable');
    const initialEpoch = darkMirrorModeEpoch;
    let result = refuse('cooperative_task_lock_not_available');
    let attemptedWrite = false;
    let writeEvidence = null;
    try {
      await locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        { mode: 'exclusive', ifAvailable: true }, async lock => {
          if (!lock) {
            result = refuse('cooperative_task_lock_held_elsewhere');
            return;
          }
          if (initialEpoch !== darkMirrorModeEpoch || !isDarkEnabled()
            || currentGeneration({ create: false }) !== initialGeneration) {
            result = refuse('generation_changed_under_cooperative_lock');
            return;
          }
          // Both the admission audit and the final acknowledgment happen
          // WHILE this shared cooperative lock is held. A participating
          // freeze cannot interleave, unlike the original unlocked preview.
          const preflight = await rehearsePreviewDurableWriterFence('audit');
          if (preflight.reason !== 'preview_writer_inventory_consistent') {
            result = refuse('preview_fence_inventory_unverified', {
              prerequisiteReason: preflight.reason
            });
            return;
          }
          if (preflight.fence?.generation !== initialGeneration
            || initialEpoch !== darkMirrorModeEpoch || !isDarkEnabled()) {
            result = refuse('preview_generation_changed_before_fence_checked_write');
            return;
          }
          if (preflight.fence.frozen) {
            result = refuse('preview_fence_frozen', {
              previewFenceChecked: true, cooperativeTaskFreezeLockUsed: true,
              fenceEpoch: preflight.fence.epoch
            });
            return;
          }
          // This adapter writes the existing durable V1 Task journal, NOT
          // V2 authority. Silent old tabs and direct preview freeze callers
          // can still interleave; the second audit diagnoses those races.
          attemptedWrite = true;
          const write = await rehearsePreviewAdmittedTaskCompletionBatch(
            rows, token);
          writeEvidence = write;
          const postflight = await rehearsePreviewDurableWriterFence('audit');
          if (postflight.reason !== 'preview_writer_inventory_consistent') {
            result = refuse('preview_fence_postwrite_unverified', {
              prerequisiteReason: postflight.reason, taskBatchReason: write.reason,
              committed: write.committed === true,
              writeOutcomeUncertain: write.committed === true
                || write.writeOutcomeUncertain === true,
              fenceReadbackRequired: true,
              cooperativeTaskFreezeLockUsed: true
            });
            return;
          }
          if (postflight.fence?.generation !== initialGeneration
            || postflight.fence.epoch !== preflight.fence.epoch
            || postflight.fence.frozen !== preflight.fence.frozen
            || initialEpoch !== darkMirrorModeEpoch || !isDarkEnabled()) {
            result = refuse('preview_fence_changed_during_task_batch', {
              taskBatchReason: write.reason,
              committed: write.committed === true,
              writeOutcomeUncertain: write.committed === true
                || write.writeOutcomeUncertain === true,
              fenceReadbackRequired: true,
              cooperativeTaskFreezeLockUsed: true,
              initialFenceEpoch: preflight.fence.epoch,
              finalFenceEpoch: postflight.fence.epoch
            });
            return;
          }
          result = {
            ...write, previewFenceChecked: true,
            previewFenceBeforeAndAfterStable: true,
            cooperativeTaskFreezeLockUsed: true,
            fenceEpoch: postflight.fence.epoch,
            canPromote: false, productionWritersFenced: false
          };
        });
    } catch (_) {
      return refuse('cooperative_task_lock_request_failed', {
        writeOutcomeUncertain: attemptedWrite,
        committed: writeEvidence?.committed === true,
        fenceReadbackRequired: attemptedWrite
      });
    }
    return result;
  }

  // READ ONLY, preview-host-only recovery inspection for a Task journal batch
  // whose outcome may have been uncertain after a tab close / lock failure.
  // A positive result means those exact rows are visible in the pending
  // V1 journal NOW; it never proves they originated from this invocation,
  // that older unrelated work survived, or that a dormant tab cannot write.
  // No retry, compaction, snapshot repair, or authority transfer is allowed.
  function inspectPreviewTaskBatchJournalEvidence(expectedRowsJson) {
    const report=(reason,details={})=>({
      checked:true,previewOnly:true,recoveryInspectionOnly:true,
      pendingJournalRowsMatched:false,safeToRetry:false,
      confirmedDurable:false,canPromote:false,
      productionWritersFenced:false,mutationAuthority:'legacy_only',
      readAuthority:'legacy_only',reason,...details
    });
    if(!isWalTestPreviewHost())return report('preview_host_required');
    if(!isDarkEnabled())return report('dark_disabled');
    if(typeof expectedRowsJson!=='string'
      ||expectedRowsJson.length<2||expectedRowsJson.length>262144)
      return report('expected_batch_json_required');
    let expected;
    try{
      expected=JSON.parse(expectedRowsJson);
      if(!Array.isArray(expected)||expected.length<1||expected.length>64)
        return report('invalid_expected_batch');
      const ids=new Set();
      for(const row of expected){
        if(!row||typeof row!=='object'||Array.isArray(row)
          ||typeof row.id!=='string'||!row.id||row.id.length>128
          ||ids.has(row.id))return report('invalid_expected_batch');
        ids.add(row.id);
      }
    }catch(_){return report('invalid_expected_batch');}
    let startingOrigin;
    try{startingOrigin=captureReadOnlyFullStorageInventory();}
    catch(_){return report('full_origin_unreadable_before_inspection');}
    let reason='task_journal_absent_or_compacted';
    let present=0;
    let missing=expected.length;
    let conflicting=0;
    let deleted=0;
    try{
      const raw=global.localStorage.getItem(
        'taskpoints_pending_task_mutations_v1');
      if(raw!==null){
        if(typeof raw!=='string'||!raw.length||raw.length>8388608)
          return report('task_journal_unreadable_or_oversized');
        const journal=JSON.parse(raw);
        if(!journal||typeof journal!=='object'||Array.isArray(journal)
          ||journal.schemaVersion!==1
          ||!Array.isArray(journal.tasks)
          ||!Array.isArray(journal.completionUpserts)
          ||!Array.isArray(journal.completionDeletes)
          || !(journal.updatedAtISO===null
            ||typeof journal.updatedAtISO==='string')
          || stableJson(Object.keys(journal).sort())!==stableJson([
            'completionDeletes','completionUpserts','schemaVersion',
            'tasks','updatedAtISO']))
          return report('task_journal_shape_invalid');
        if(!journal.completionUpserts.every(row=>row
          &&typeof row==='object'&&!Array.isArray(row)
          &&typeof row.id==='string'&&row.id.length>0)
          ||!journal.completionDeletes.every(id=>
            typeof id==='string'&&id.length>0))
          return report('task_journal_rows_invalid');
        const rowById=new Map();
        for(const row of journal.completionUpserts){
          const list=rowById.get(row.id)||[];
          list.push(row);
          rowById.set(row.id,list);
        }
        const deletes=new Set(journal.completionDeletes);
        const allDeletesDistinct=deletes.size===journal.completionDeletes.length;
        if(!allDeletesDistinct)return report('task_journal_deletions_invalid');
        for(const target of expected){
          const entries=rowById.get(target.id)||[];
          if(deletes.has(target.id)){deleted++;continue;}
          if(entries.length>1){conflicting++;continue;}
          if(entries.length===0)continue;
          if(stableJson(entries[0])!==stableJson(target)){
            conflicting++;continue;
          }
          present++;
        }
        missing=expected.length-present-conflicting-deleted;
        reason=deleted>0?'task_batch_journal_tombstoned'
          :conflicting>0?'task_batch_journal_conflict'
          :missing>0?'task_batch_journal_incomplete_or_compacted'
          :'task_batch_rows_observed_in_pending_journal';
      }
    }catch(_){return report('task_journal_inspection_unreadable');}
    try{
      if(captureReadOnlyFullStorageInventory()!==startingOrigin)
        return report('full_origin_changed_during_inspection');
    }catch(_){return report('full_origin_unreadable_after_inspection');}
    return report(reason,{
      pendingJournalRowsMatched:present===expected.length
        &&conflicting===0&&deleted===0,
      expectedRowCount:expected.length,observedRowCount:present,
      missingOrCompactedRowCount:missing,conflictingRowCount:conflicting,
      tombstonedRowCount:deleted
    });
  }


  // Read-only effective Task completion evidence across the durable V1
  // snapshot AND still-pending Task journal. Absence from the journal alone
  // is ambiguous after compaction. Never retry, merge, or alter V1 here.
  // Exact current-row visibility is NOT proof of action provenance or
  // independent off-device durability; an old tab may still write later.
  function inspectPreviewTaskBatchEffectiveEvidence(expectedRowsJson) {
    const refuse=(reason,extra={})=>({
      checked:true,previewOnly:true,recoveryInspectionOnly:true,
      effectiveRowsObserved:false,safeToRetry:false,
      confirmedDurable:false,canPromote:false,
      productionWritersFenced:false,mutationAuthority:'legacy_only',
      readAuthority:'legacy_only',reason,...extra
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(typeof expectedRowsJson!=='string'||expectedRowsJson.length<2
      ||expectedRowsJson.length>262144)
      return refuse('expected_batch_json_required');
    let expected;
    try{
      expected=JSON.parse(expectedRowsJson);
      if(!Array.isArray(expected)||!expected.length||expected.length>64)
        return refuse('invalid_expected_batch');
      const ids=new Set();
      for(const row of expected){
        if(!row||typeof row!=='object'||Array.isArray(row)
          ||typeof row.id!=='string'||!row.id||row.id.length>128
          ||ids.has(row.id))return refuse('invalid_expected_batch');
        ids.add(row.id);
      }
    }catch(_){return refuse('invalid_expected_batch');}
    let origin;
    try{origin=captureReadOnlyFullStorageInventory();}
    catch(_){return refuse('full_origin_unreadable_before_inspection');}
    let journalRows=[],deletions=[],snapshotRows=[];
    let journalPresent=false;
    try{
      const snapshotRaw=global.localStorage.getItem(
        core.STORAGE_KEY||'taskpoints_v1');
      if(typeof snapshotRaw!=='string'||!snapshotRaw.length
        ||snapshotRaw.length>16777216)
        return refuse('task_snapshot_missing_or_oversized');
      const snapshot=typeof core.parseTaskPointsStorageJson==='function'
        ?core.parseTaskPointsStorageJson(snapshotRaw,{})
        :JSON.parse(snapshotRaw);
      if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)
        ||!Array.isArray(snapshot.completions)
        ||snapshot.completions.length>100000)
        return refuse('task_snapshot_invalid');
      snapshotRows=snapshot.completions;
      const journalRaw=global.localStorage.getItem(
        'taskpoints_pending_task_mutations_v1');
      if(journalRaw!==null){
        journalPresent=true;
        if(typeof journalRaw!=='string'||!journalRaw.length
          ||journalRaw.length>8388608)
          return refuse('task_journal_unreadable_or_oversized');
        const journal=JSON.parse(journalRaw);
        if(!journal||typeof journal!=='object'||Array.isArray(journal)
          ||journal.schemaVersion!==1
          ||!Array.isArray(journal.tasks)
          ||!Array.isArray(journal.completionUpserts)
          ||!Array.isArray(journal.completionDeletes)
          ||!(journal.updatedAtISO===null
            ||typeof journal.updatedAtISO==='string')
          ||stableJson(Object.keys(journal).sort())!==stableJson([
            'completionDeletes','completionUpserts','schemaVersion',
            'tasks','updatedAtISO']))
          return refuse('task_journal_shape_invalid');
        if(journal.completionUpserts.length>100000
          ||journal.completionDeletes.length>100000)
          return refuse('task_journal_row_limit');
        journalRows=journal.completionUpserts;
        deletions=journal.completionDeletes;
      }
    }catch(_){return refuse('task_source_inspection_unreadable');}
    const asUniqueMap=(rows)=>{
      const byId=new Map();
      for(const row of rows){
        if(!row||typeof row!=='object'||Array.isArray(row)
          ||typeof row.id!=='string'||!row.id||row.id.length>128
          ||byId.has(row.id))return null;
        byId.set(row.id,row);
      }
      return byId;
    };
    const snapshotMap=asUniqueMap(snapshotRows);
    const journalMap=asUniqueMap(journalRows);
    const deletes=new Set(deletions);
    if(!snapshotMap)return refuse('task_snapshot_completion_ids_invalid');
    if(!journalMap)return refuse('task_journal_completion_ids_invalid');
    if(deletes.size!==deletions.length||deletions.some(id=>
      typeof id!=='string'||!id||id.length>128))
      return refuse('task_journal_deletions_invalid');
    let fromJournal=0,fromSnapshot=0,missing=0,conflicting=0,tombstoned=0;
    for(const target of expected){
      if(deletes.has(target.id)){tombstoned++;continue;}
      // V1's pending upsert overrides the older snapshot value. A newer
      // correction need not agree with the pre-compaction snapshot.
      const inJournal=journalMap.has(target.id);
      const actual=inJournal?journalMap.get(target.id):
        snapshotMap.get(target.id);
      if(!actual){missing++;continue;}
      if(stableJson(actual)!==stableJson(target)){conflicting++;continue;}
      if(inJournal)fromJournal++;else fromSnapshot++;
    }
    try{
      if(captureReadOnlyFullStorageInventory()!==origin)
        return refuse('full_origin_changed_during_inspection');
    }catch(_){return refuse('full_origin_unreadable_after_inspection');}
    const verified=fromJournal+fromSnapshot===expected.length
      &&missing===0&&conflicting===0&&tombstoned===0;
    const reason=tombstoned?'task_batch_effectively_tombstoned'
      :conflicting?'task_batch_effective_conflict'
      :missing?'task_batch_effective_missing_or_compacted'
      :fromJournal&&fromSnapshot?'task_batch_rows_observed_in_both_sources'
      :fromJournal?'task_batch_rows_observed_in_pending_journal'
      :'task_batch_rows_observed_in_v1_snapshot';
    return refuse(reason,{
      effectiveRowsObserved:verified,
      expectedRowCount:expected.length,
      observedJournalRowCount:fromJournal,
      observedSnapshotRowCount:fromSnapshot,
      missingRowCount:missing,conflictingRowCount:conflicting,
      tombstonedRowCount:tombstoned,
      pendingTaskJournalPresent:journalPresent
    });
  }


  // Frozen-preview origin witness. Only the SHA-256 of a full-origin V1
  // inventory is persisted; legacy bytes and key names stay in V1 storage.
  // An observed difference proves source drift, NOT who wrote it. Equal
  // fingerprints never prove old/suspended tabs are excluded.
  const FROZEN_ORIGIN_WITNESS_DB='taskpoints_v2_frozen_origin_witness_v1';
  async function openPreviewFrozenOriginWitnessDb(){
    return new Promise((resolve,reject)=>{
      if(typeof global.indexedDB?.open!=='function')
        return reject(Error('frozen_origin_witness_indexeddb_unavailable'));
      let request;
      try{request=global.indexedDB.open(FROZEN_ORIGIN_WITNESS_DB,1);}
      catch(error){reject(error);return;}
      request.onerror=()=>reject(request.error||Error('frozen_origin_open_failed'));
      request.onblocked=()=>reject(Error('frozen_origin_open_blocked'));
      request.onupgradeneeded=()=>{
        if(!isWalTestPreviewHost()||!isDarkEnabled()){
          try{request.transaction?.abort();}catch(_){}
          return;
        }
        try{
          if(!request.result.objectStoreNames.contains('witnesses'))
            request.result.createObjectStore('witnesses',{keyPath:'id'});
        }catch(_){try{request.transaction?.abort();}catch(_){}}
      };
      request.onsuccess=()=>{
        const db=request.result;
        db.onversionchange=()=>{try{db.close();}catch(_){}};
        resolve(db);
      };
    });
  }
  const previewOriginWitnessRefuse=(reason,details={})=>({
    checked:true,previewOnly:true,captured:false,
    sourceCompared:false,originDriftObserved:null,
    writerIdentityUnknown:true,silentLegacyWritersExcluded:false,
    safeToRestore:false,canPromote:false,productionWritersFenced:false,
    readAuthority:'legacy_only',mutationAuthority:'legacy_only',
    reason,...details
  });
  function validPreviewOriginWitnessId(id){
    return typeof id==='string'&&/^[a-zA-Z0-9._-]{1,128}$/.test(id);
  }
  async function readPreviewOriginWitness(db,id){
    const tx=db.transaction('witnesses','readonly');
    return requestPromise(tx.objectStore('witnesses').get('origin:'+id));
  }
  async function frozenPreviewFenceState(generation){
    const result=await rehearsePreviewDurableWriterFence('read');
    if(result.reason!=='fence_read_only'||!result.fence
      ||result.fence.generation!==generation||result.fence.frozen!==true
      ||!Number.isSafeInteger(result.fence.epoch)||result.fence.epoch<1)
      return null;
    return result.fence;
  }
  async function capturePreviewFrozenOriginWitness(witnessId){
    const refuse=previewOriginWitnessRefuse;
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(!validPreviewOriginWitnessId(witnessId))
      return refuse('witness_id_required');
    const generation=currentGeneration({create:false}),epoch=darkMirrorModeEpoch;
    if(!generation)return refuse('generation_unavailable');
    const current=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&darkMirrorModeEpoch===epoch
      &&currentGeneration({create:false})===generation;
    let db=null;
    try{
      const fence=await frozenPreviewFenceState(generation);
      if(!fence)return refuse('frozen_preview_fence_required');
      const origin=captureReadOnlyFullStorageInventory();
      const digest=await previewRecoveryFingerprint(origin);
      if(!current()||captureReadOnlyFullStorageInventory()!==origin)
        return refuse('origin_changed_before_witness');
      const sameFence=await frozenPreviewFenceState(generation);
      if(!sameFence||stableJson(sameFence)!==stableJson(fence))
        return refuse('frozen_preview_fence_changed');
      const entry={
        id:'origin:'+witnessId,schemaVersion:1,
        resetGeneration:generation,freezeEpoch:fence.epoch,
        sourceFingerprint:digest,capturedAtISO:nowIso()
      };
      const record={...entry,integrityDigest:await previewRecoveryFingerprint(entry)};
      if(!current()||captureReadOnlyFullStorageInventory()!==origin)
        return refuse('origin_changed_before_witness');
      db=await openPreviewFrozenOriginWitnessDb();
      let status='witness_write_not_started';
      const tx=db.transaction('witnesses','readwrite');
      const store=tx.objectStore('witnesses');
      const lookup=store.get(entry.id);
      lookup.onsuccess=()=>{
        if(lookup.result){status='witness_id_already_used';return;}
        try{
          if(!current()||captureReadOnlyFullStorageInventory()!==origin){
            status='origin_changed_before_witness_write';return;
          }
          status='witness_write_attempted';
          store.add(record);
        }catch(_){status='witness_write_unavailable';try{tx.abort();}catch(_){}}
      };
      await transactionPromise(tx);
      if(status!=='witness_write_attempted')
        return refuse(status);
      const stored=await readPreviewOriginWitness(db,witnessId);
      if(stableJson(stored)!==stableJson(record))
        return refuse('witness_readback_unverified',{
          captured:true,writeOutcomeUncertain:true});
      const finalFence=await frozenPreviewFenceState(generation);
      let stable=false;
      try{stable=current()&&captureReadOnlyFullStorageInventory()===origin
        &&finalFence&&stableJson(finalFence)===stableJson(fence);}
      catch(_){}
      if(!stable)return refuse('origin_or_fence_changed_after_witness',{
        captured:true,writeOutcomeUncertain:true});
      return {...refuse('frozen_origin_witness_captured'),captured:true,
        confirmedDurable:true,freezeEpoch:fence.epoch};
    }catch(_){return refuse('frozen_origin_witness_unavailable');}
    finally{try{db?.close();}catch(_){}}
  }
  async function inspectPreviewFrozenOriginWitness(witnessId){
    const refuse=previewOriginWitnessRefuse;
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(!validPreviewOriginWitnessId(witnessId))
      return refuse('witness_id_required');
    const generation=currentGeneration({create:false}),epoch=darkMirrorModeEpoch;
    if(!generation)return refuse('generation_unavailable');
    const current=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&darkMirrorModeEpoch===epoch
      &&currentGeneration({create:false})===generation;
    let db=null;
    try{
      const fence=await frozenPreviewFenceState(generation);
      if(!fence)return refuse('frozen_preview_fence_required');
      db=await openPreviewFrozenOriginWitnessDb();
      const stored=await readPreviewOriginWitness(db,witnessId);
      if(!stored)return refuse('frozen_origin_witness_missing');
      const {integrityDigest,...payload}=stored;
      if(payload.id!=='origin:'+witnessId||payload.schemaVersion!==1
        ||payload.resetGeneration!==generation
        ||payload.freezeEpoch!==fence.epoch
        ||typeof payload.capturedAtISO!=='string'
        ||typeof payload.sourceFingerprint!=='string'
        ||!/^sha256:[0-9a-f]{64}:\d+$/.test(payload.sourceFingerprint)
        ||typeof integrityDigest!=='string'
        ||await previewRecoveryFingerprint(payload)!==integrityDigest)
        return refuse('frozen_origin_witness_integrity_invalid');
      const origin=captureReadOnlyFullStorageInventory();
      const digest=await previewRecoveryFingerprint(origin);
      const final=await readPreviewOriginWitness(db,witnessId);
      const afterFence=await frozenPreviewFenceState(generation);
      if(!current()||captureReadOnlyFullStorageInventory()!==origin
        ||!afterFence||stableJson(afterFence)!==stableJson(fence)
        ||stableJson(final)!==stableJson(stored))
        return refuse('frozen_origin_inspection_changed');
      const drift=digest!==stored.sourceFingerprint;
      return {...refuse(drift
        ?'origin_drift_observed_after_preview_freeze'
        :'origin_currently_matches_frozen_witness'),
        sourceCompared:true,originDriftObserved:drift,
        freezeEpoch:fence.epoch};
    }catch(_){return refuse('frozen_origin_witness_inspection_unavailable');}
    finally{try{db?.close();}catch(_){}}
  }

  async function rehearsePreviewDurableWriterFence(action, options = {}) {
    const refuse = (reason, details = {}) => ({
      checked: true, reason, previewOnly: true, canPromote: false,
      productionWritersFenced: false, allLegacyWritersKnown: false,
      mutationAuthority: 'legacy_only', readAuthority: 'legacy_only',
      ...details
    });
    if (!isWalTestPreviewHost()) return refuse('preview_host_required');
    if (!isDarkEnabled()) return refuse('dark_disabled');
    if (!['read', 'audit', 'inspect_entity', 'writer', 'freeze', 'inspect_marker'].includes(action))
      return refuse('invalid_fence_action');
    if (!global.indexedDB?.open) return refuse('indexeddb_unavailable');
    const expectedEpoch = options?.expectedEpoch;
    if (action !== 'read' && action !== 'audit'
      && action !== 'inspect_entity' && action !== 'inspect_marker'
      && (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0))
      return refuse('expected_epoch_required');
    if ((action === 'writer' || action === 'inspect_marker')
      && (typeof options?.marker !== 'string' || !options.marker
        || options.marker.length > 128))
      return refuse('writer_marker_required');
    if (action === 'inspect_entity'
      && (!['habits','completions','tasks','notes','projects','today'].includes(options?.collection)
        || typeof options?.entityId !== 'string'
        || !options.entityId || options.entityId.length > 128))
      return refuse('preview_synthetic_entity_selector_invalid');
    const syntheticEntityKeyFor = mutation =>
      'synthetic_entity:' + mutation.collection + ':' + JSON.stringify(mutation.entityId);
    // A marker alone does not prove an idempotent retry has the same intent.
    // The optional caller-supplied SHA-256 fingerprint binds a *synthetic*
    // writer marker to its claimed payload. This preview does not hash or
    // persist a real TaskPoints mutation, and cannot authorize production.
    // Optional synthetic writer-family admission, never enabled by a real V1
    // save path. Each claim names one of the nine audited legacy writer
    // families and carries an exact in-memory full-origin V1 inventory.
    // The inventory is never persisted to the marker database.
    const familyOwned=(action==='writer'||action==='inspect_marker')
      && Object.prototype.hasOwnProperty.call(options||{},'writerFamily');
    const writerFamily=familyOwned ? options.writerFamily : null;
    if(familyOwned&&!AUTHORITY_CUTOVER_WRITER_FAMILIES.includes(writerFamily))
      return refuse('preview_writer_family_invalid');
    const familyOrigin=familyOwned&&action==='writer' ? options.fullOriginToken : null;
    if(familyOwned&&action==='writer'
      &&(typeof familyOrigin!=='string'||!familyOrigin.length
        ||familyOrigin.length>10485760))
      return refuse('preview_writer_family_full_origin_token_required');
    let familyOriginFingerprint=null;
    if(familyOwned&&action==='writer'){
      try{
        if(captureReadOnlyFullStorageInventory()!==familyOrigin)
          return refuse('preview_writer_family_origin_stale');
        familyOriginFingerprint=await previewRecoveryFingerprint(familyOrigin);
        if(captureReadOnlyFullStorageInventory()!==familyOrigin)
          return refuse('preview_writer_family_origin_stale');
      }catch(_){return refuse('preview_writer_family_origin_unreadable');}
    }
    // A read-only audit can compare sealed family claims with the *current*
    // V1 origin. Digest outside IndexedDB, then recheck the exact source
    // synchronously in the audit transaction. This never fences old tabs.
    let auditOrigin=null,auditOriginFingerprint=null;
    if(action==='audit'){
      try{
        auditOrigin=captureReadOnlyFullStorageInventory();
        auditOriginFingerprint=await previewRecoveryFingerprint(auditOrigin);
        if(captureReadOnlyFullStorageInventory()!==auditOrigin){
          auditOrigin=null;
          auditOriginFingerprint=null;
        }
      }catch(_){auditOrigin=null;auditOriginFingerprint=null;}
    }
    const strictFamilyFreeze=action==='freeze'
      &&options?.requireAllKnownFamilies===true;
    let freezeOrigin=null,freezeOriginFingerprint=null;
    if(strictFamilyFreeze){
      try{
        freezeOrigin=captureReadOnlyFullStorageInventory();
        freezeOriginFingerprint=await previewRecoveryFingerprint(freezeOrigin);
        if(captureReadOnlyFullStorageInventory()!==freezeOrigin)
          return refuse('preview_writer_family_origin_stale');
      }catch(_){return refuse('preview_writer_family_origin_unreadable');}
    }
    const hasPayloadFingerprint = (action === 'writer' || action === 'inspect_marker')
      && Object.prototype.hasOwnProperty.call(options || {}, 'payloadFingerprint');
    const payloadFingerprint = hasPayloadFingerprint ? options.payloadFingerprint : null;
    const validPayloadFingerprint = value => value === null
      || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
    if (hasPayloadFingerprint && !validPayloadFingerprint(payloadFingerprint))
      return refuse('writer_payload_fingerprint_invalid');
    // A small REAL payload, not just a caller-asserted hash, may accompany
    // the synthetic preview writer marker. Only this isolated IDB database
    // is modified. Existing marker-only callers keep their old behavior.
    const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
    const canonicalSyntheticMutation = value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || !['habits','completions','tasks','notes','projects','today'].includes(value.collection)
        || !['put','delete'].includes(value.operation)
        || typeof value.entityId !== 'string'
        || !value.entityId || value.entityId.length > 128) return null;
      const validKeys = value.operation === 'put'
        ? 'collection,entityId,operation,value' : 'collection,entityId,operation';
      if (Object.keys(value).sort().join(',') !== validKeys) return null;
      if (value.operation === 'put'
        && (value.value == null
          || !['object','string'].includes(typeof value.value))) return null;
      try {
        const json = JSON.stringify(value);
        if (!json || json.length > 8192) return null;
        const decoded = JSON.parse(json);
        if (stableJson(value) !== stableJson(decoded)) return null;
        return stableJson(decoded);
      } catch (_) { return null; }
    };
    const hasSyntheticMutation = (action === 'writer' || action === 'inspect_marker')
      && owns(options || {}, 'syntheticMutation');
    const syntheticMutationJson = hasSyntheticMutation
      ? canonicalSyntheticMutation(options.syntheticMutation) : null;
    const syntheticEntityKey = hasSyntheticMutation
      ? syntheticEntityKeyFor(options.syntheticMutation) : null;
    if (hasSyntheticMutation && !syntheticMutationJson)
      return refuse('preview_synthetic_mutation_invalid');
    const hasSyntheticBatch=(action === 'writer' || action === 'inspect_marker')
      && owns(options || {},'syntheticMutations');
    if (hasSyntheticBatch && hasSyntheticMutation)
      return refuse('preview_synthetic_batch_conflicts_with_single');
    const canonicalSyntheticBatch = batch => {
      if (!Array.isArray(batch) || batch.length<1 || batch.length>8) return null;
      const ids=new Set();
      for(const entry of batch){
        if(!canonicalSyntheticMutation(entry)) return null;
        const key=syntheticEntityKeyFor(entry);
        if(ids.has(key)) return null;
        ids.add(key);
      }
      const json=stableJson(batch);
      return json.length<=32768 ? json : null;
    };
    const syntheticBatchJson=hasSyntheticBatch
      ? canonicalSyntheticBatch(options.syntheticMutations) : null;
    if (hasSyntheticBatch && !syntheticBatchJson)
      return refuse('preview_synthetic_batch_invalid');
    const hasAnySynthetic=hasSyntheticMutation || hasSyntheticBatch;
    // Snapshot the exact validated intent *before* asynchronous hashing.
    // Callers may mutate their original objects while SubtleCrypto runs.
    // Neither the materialized rows nor the acknowledgement may use those
    // live references after the digest has captured its canonical bytes.
    const syntheticEntries=hasSyntheticMutation ? [JSON.parse(syntheticMutationJson)]
      : hasSyntheticBatch ? JSON.parse(syntheticBatchJson) : [];
    const syntheticPayloadJson=syntheticBatchJson || syntheticMutationJson;
    let effectivePayloadFingerprint = payloadFingerprint;
    if (hasAnySynthetic) {
      // Hash before opening any IDB transaction. Never await a digest from
      // inside a live readwrite transaction, which would let it auto-commit.
      if (typeof global.crypto?.subtle?.digest !== 'function'
        || typeof global.TextEncoder !== 'function')
        return refuse('preview_synthetic_digest_unavailable');
      try {
        const bytes = new global.TextEncoder().encode(syntheticPayloadJson);
        const hash = await global.crypto.subtle.digest('SHA-256', bytes);
        const digest = Array.from(new Uint8Array(hash),
          value => value.toString(16).padStart(2,'0')).join('');
        if (hasPayloadFingerprint && payloadFingerprint !== digest)
          return refuse('preview_synthetic_digest_mismatch');
        effectivePayloadFingerprint = digest;
      } catch (_) { return refuse('preview_synthetic_digest_failed'); }
    }
    const syntheticMarkerValid = row => {
      const single=owns(row,'syntheticMutationJson');
      const batch=owns(row,'syntheticMutationBatchJson');
      if (single && batch) return false;
      if (!single && !batch) return true;
      try {
        return single ? typeof row.syntheticMutationJson === 'string'
          && canonicalSyntheticMutation(JSON.parse(row.syntheticMutationJson))
            === row.syntheticMutationJson
          : typeof row.syntheticMutationBatchJson === 'string'
            && canonicalSyntheticBatch(JSON.parse(row.syntheticMutationBatchJson))
              === row.syntheticMutationBatchJson;
      } catch (_) { return false; }
    };
    const storedSyntheticEntries = row =>
      owns(row,'syntheticMutationBatchJson')
        ? JSON.parse(row.syntheticMutationBatchJson)
        : owns(row,'syntheticMutationJson')
          ? [JSON.parse(row.syntheticMutationJson)] : [];
    const initialModeEpoch = darkMirrorModeEpoch;
    let generation;
    try { generation = currentGeneration({ create: false }); }
    catch (_) { return refuse('generation_unreadable'); }
    if (!generation) return refuse('generation_unavailable');
    const DB = 'taskpoints_v2_writer_fence_preview_v1';
    const STORE = 'control';
    // A WebCrypto digest cannot be awaited while an IndexedDB transaction
    // is active: the transaction may commit during the await. For the
    // isolated PREVIEW writer rehearsal, copy the historical marker inputs
    // in a short readonly transaction, hash them after it completes, then
    // require the very same bytes + expected digest in the subsequent
    // atomic inventory transaction. A concurrent rewrite/addition of a
    // synthetic marker invalidates this proof and fails closed.
    const readPreviewMarkerDigestInputs = () => new Promise(resolve => {
      let finished=false, db=null, rows=null;
      const finish=value=>{
        if(finished)return;
        finished=true;
        try{db?.close()}catch(_){}
        resolve(value);
      };
      let opening;
      try{opening=global.indexedDB.open(DB,1)}
      catch(_){finish({error:'fence_database_open_failed'});return}
      opening.onblocked=()=>finish({error:'fence_database_upgrade_blocked'});
      opening.onerror=()=>finish({error:'fence_database_open_failed'});
      opening.onupgradeneeded=()=>{
        if(!opening.result.objectStoreNames.contains(STORE))
          opening.result.createObjectStore(STORE,{keyPath:'id'});
      };
      opening.onsuccess=()=>{
        db=opening.result;
        db.onversionchange=()=>{try{db.close()}catch(_){}};
        if(finished){try{db.close()}catch(_){};return}
        try{
          const tx=db.transaction(STORE,'readonly');
          tx.onabort=()=>finish({error:'fence_writer_digest_scan_failed'});
          tx.onerror=()=>{};
          tx.oncomplete=()=>finish({rows});
          const request=tx.objectStore(STORE).getAll();
          request.onsuccess=()=>{rows=request.result};
          request.onerror=()=>{
            try{tx.abort()}catch(_){}
            finish({error:'fence_writer_digest_scan_failed'});
          };
        }catch(_){finish({error:'fence_writer_digest_scan_failed'})}
      };
    });
    // A cooperating writer may commit after our digest snapshot and before
    // our transaction. Refresh the read+hash proof a bounded number of
    // times rather than treating legitimate serialized writes as corruption.
    // Every retry rechecks the entire inventory; exhaustion fails closed.
    for(let digestRetry=0;digestRetry<4;digestRetry++){
    let preflightMarkerCount=0;
    let historicalMarkerSnapshots=null;
    let historicalDigestProofs=null;
    if(action!=='read'){
      const snapshot=await readPreviewMarkerDigestInputs();
      if(snapshot.error)return refuse(snapshot.error);
      if(!Array.isArray(snapshot.rows))
        return refuse('fence_writer_digest_scan_failed');
      historicalMarkerSnapshots=new Map(snapshot.rows.filter(row =>
        typeof row?.id==='string' && row.id.startsWith('writer_marker:'))
        .map(row=>[row.id,stableJson(row)]));
      preflightMarkerCount=historicalMarkerSnapshots.size;
      historicalDigestProofs=new Map();
      for(const row of snapshot.rows){
        if(typeof row?.id!=='string' || !row.id.startsWith('writer_marker:'))
          continue;
        const single=owns(row,'syntheticMutationJson');
        const batch=owns(row,'syntheticMutationBatchJson');
        if(!single && !batch)continue;
        const json=single?row.syntheticMutationJson:row.syntheticMutationBatchJson;
        if(typeof json!=='string'){
          historicalDigestProofs.set(row.id,{single,batch,json,digest:null});
          continue;
        }
        if(typeof global.crypto?.subtle?.digest!=='function'
          || typeof global.TextEncoder!=='function')
          return refuse('fence_writer_digest_unavailable');
        let digest;
        try{
          const bytes=new global.TextEncoder().encode(json);
          const hash=await global.crypto.subtle.digest('SHA-256',bytes);
          digest=Array.from(new Uint8Array(hash),
            value=>value.toString(16).padStart(2,'0')).join('');
        }catch(_){return refuse('fence_writer_digest_failed')}
        historicalDigestProofs.set(row.id,{single,batch,json,digest});
      }
    }
    const attemptResult=await new Promise(resolve => {
      let settled = false;
      let db = null;
      let result = refuse('transaction_not_completed');
      const finish = value => {
        if (settled) return;
        settled = true;
        try { db?.close(); } catch (_) {}
        resolve(value);
      };
      let opening;
      try { opening = global.indexedDB.open(DB, 1); }
      catch (_) { finish(refuse('fence_database_open_failed')); return; }
      opening.onblocked = () => finish(refuse('fence_database_upgrade_blocked'));
      opening.onerror = () => finish(refuse('fence_database_open_failed'));
      opening.onupgradeneeded = () => {
        const upgradeDb = opening.result;
        if (!upgradeDb.objectStoreNames.contains(STORE))
          upgradeDb.createObjectStore(STORE, { keyPath: 'id' });
      };
      opening.onsuccess = () => {
        db = opening.result;
        db.onversionchange = () => { try { db.close(); } catch (_) {} };
        if (settled) { try { db.close(); } catch (_) {} return; }
        try {
          if (!isDarkEnabled() || darkMirrorModeEpoch !== initialModeEpoch
            || currentGeneration({ create: false }) !== generation) {
            finish(refuse('preview_or_generation_changed_before_transaction'));
            return;
          }
          const tx = db.transaction(STORE,
            (action === 'read' || action === 'audit' || action === 'inspect_entity'
              || action === 'inspect_marker') ? 'readonly' : 'readwrite');
          tx.onabort = () => finish(refuse('fence_transaction_aborted'));
          tx.onerror = () => {}; // The abort handler remains authoritative.
          tx.oncomplete = () => finish(result);
          const store = tx.objectStore(STORE);
          const request = store.get('writer_fence');
          request.onerror = () => {
            result = refuse('fence_record_unreadable');
            try { tx.abort(); } catch (_) {}
          };
          request.onsuccess = () => {
            try {
              if (!isDarkEnabled() || darkMirrorModeEpoch !== initialModeEpoch
                || currentGeneration({ create: false }) !== generation) {
                result = refuse('preview_or_generation_changed_in_transaction');
                return;
              }
              const prior = request.result;
              if (prior && (prior.id !== 'writer_fence'
                || typeof prior.generation !== 'string'
                || !Number.isSafeInteger(prior.epoch) || prior.epoch < 0
                || typeof prior.frozen !== 'boolean'
                || !Number.isSafeInteger(prior.writersCommitted)
                || prior.writersCommitted < 0
                || (prior.writersCommitted === 0 && prior.lastWriterMarker !== null)
                || (prior.writersCommitted > 0
                  && (typeof prior.lastWriterMarker !== 'string'
                    || !prior.lastWriterMarker
                    || prior.lastWriterMarker.length > 128))
                || (prior.frozen && prior.epoch === 0)
                || (Object.prototype.hasOwnProperty.call(prior,
                  'strictFreezeSourceFingerprint')
                  && (!prior.frozen
                    || typeof prior.strictFreezeSourceFingerprint !== 'string'
                    || !/^sha256:[a-f0-9]{64}:\d+$/.test(
                      prior.strictFreezeSourceFingerprint))))) {
                result = refuse('fence_record_malformed');
                return;
              }
              const state = prior || {
                id: 'writer_fence', generation, epoch: 0, frozen: false,
                writersCommitted: 0, lastWriterMarker: null
              };
              const describe = value => ({
                generation: value.generation, epoch: value.epoch,
                frozen: value.frozen, writersCommitted: value.writersCommitted,
                lastWriterMarker: value.lastWriterMarker || null
              });
              if (state.generation !== generation) {
                result = refuse('fence_generation_mismatch', {
                  fence: describe(state)
                });
                return;
              }
              // Audit the *entire* synthetic writer-marker inventory in one
              // stable IndexedDB transaction. A missing older marker is not
              // discoverable by a last-marker-only replay check.
              // This preview-only scan is not a production writer hot path.
              const inspectAllWriterMarkers = callback => {
                const scan = store.getAll();
                scan.onerror = () => {
                  result = refuse('fence_writer_inventory_unreadable', {
                    fence: describe(state)
                  });
                  try { tx.abort(); } catch (_) {}
                };
                scan.onsuccess = () => {
                  try {
                    if (!isDarkEnabled() || darkMirrorModeEpoch !== initialModeEpoch
                      || currentGeneration({ create: false }) !== generation) {
                      result = refuse('preview_or_generation_changed_in_transaction');
                      return;
                    }
                    const records = scan.result;
                    const markers = records.filter(row =>
                      typeof row?.id === 'string' && row.id.startsWith('writer_marker:'));
                    const entities = records.filter(row =>
                      typeof row?.id === 'string' && row.id.startsWith('synthetic_entity:'));
                    // Retry on *any* newly committed marker, including
                    // marker-only acknowledgements. But first prove every
                    // preflight marker still exists with identical bytes.
                    // Rewriting an older marker plus increasing the counter
                    // cannot masquerade as a harmless concurrent writer.
                    const historicalUnchanged=historicalMarkerSnapshots.size
                      ===markers.filter(row=>historicalMarkerSnapshots.has(row.id)
                        && historicalMarkerSnapshots.get(row.id)===stableJson(row)).length;
                    const freshMarkers=markers.filter(row=>
                      !historicalMarkerSnapshots.has(row.id));
                    if(historicalUnchanged && freshMarkers.length
                      && markers.length===state.writersCommitted
                      && state.writersCommitted===
                        preflightMarkerCount+freshMarkers.length){
                      result=refuse('fence_writer_digest_snapshot_stale',{
                        fence:describe(state)
                      });
                      return;
                    }
                    const markerIds = new Set();
                    const seenSyntheticSequences = new Set();
                    // All NEW markers carry a sequence, even marker-only
                    // acknowledgements. Legacy typed records have only
                    // syntheticSequence; older marker-only records remain
                    // readable without manufacturing missing history.
                    const seenKnownWriterSequences = new Set();
                    const expectedEntities = new Map();
                    const lastKey = 'writer_marker:' + state.lastWriterMarker;
                    const markersValid = markers.every(row => {
                      if (!row || typeof row.id !== 'string'
                        || row.id.length <= 'writer_marker:'.length
                        || row.id.length > 'writer_marker:'.length + 128
                        || markerIds.has(row.id)
                        || row.generation !== generation
                        || !Number.isSafeInteger(row.epoch)
                        || row.epoch < 0 || row.epoch > state.epoch
                        || !validPayloadFingerprint(row.payloadFingerprint)
                        || (owns(row,'writerFamily')
                          && !AUTHORITY_CUTOVER_WRITER_FAMILIES.includes(row.writerFamily))
                        || (owns(row,'originFingerprint')
                          && (!owns(row,'writerFamily')
                            || typeof row.originFingerprint!=='string'
                            || !/^sha256:[a-f0-9]{64}:\d+$/.test(row.originFingerprint)))
                        || !syntheticMarkerValid(row)
                        || (owns(row,'writerSequence')
                          && (!Number.isSafeInteger(row.writerSequence)
                            || row.writerSequence < 1
                            || row.writerSequence > state.writersCommitted
                            || (owns(row,'syntheticSequence')
                              && row.syntheticSequence !== row.writerSequence)))
                        || (historicalMarkerSnapshots.has(row.id)
                          && historicalMarkerSnapshots.get(row.id)!==stableJson(row))
                        || ((owns(row,'syntheticMutationJson')
                          || owns(row,'syntheticMutationBatchJson'))
                          && (!historicalDigestProofs?.has(row.id)
                            || historicalDigestProofs.get(row.id).single
                              !== owns(row,'syntheticMutationJson')
                            || historicalDigestProofs.get(row.id).batch
                              !== owns(row,'syntheticMutationBatchJson')
                            || historicalDigestProofs.get(row.id).json !==
                              (owns(row,'syntheticMutationJson')
                                ? row.syntheticMutationJson
                                : row.syntheticMutationBatchJson)
                            || historicalDigestProofs.get(row.id).digest
                              !== row.payloadFingerprint))
                        || ((owns(row,'syntheticMutationJson')
                          || owns(row,'syntheticMutationBatchJson'))
                          && row.payloadFingerprint === null))
                        return false;
                      markerIds.add(row.id);
                      const knownSequence=owns(row,'writerSequence')
                        ? row.writerSequence
                        : owns(row,'syntheticSequence') ? row.syntheticSequence : null;
                      if(knownSequence!==null){
                        if(!Number.isSafeInteger(knownSequence)
                          || knownSequence < 1
                          || knownSequence > state.writersCommitted
                          || seenKnownWriterSequences.has(knownSequence)) return false;
                        seenKnownWriterSequences.add(knownSequence);
                      }
                      const entries=storedSyntheticEntries(row);
                      if (entries.length) {
                        const keys=entries.map(syntheticEntityKeyFor);
                        const batch=owns(row,'syntheticMutationBatchJson');
                        if (!Number.isSafeInteger(row.syntheticSequence)
                          || row.syntheticSequence < 1
                          || row.syntheticSequence > state.writersCommitted
                          || seenSyntheticSequences.has(row.syntheticSequence)
                          || (batch && (owns(row,'syntheticEntityKey')
                            || !Array.isArray(row.syntheticEntityKeys)
                            || stableJson(row.syntheticEntityKeys) !== stableJson(keys)))
                          || (!batch && (row.syntheticEntityKey !== keys[0]
                            || owns(row,'syntheticEntityKeys'))))
                          return false;
                        seenSyntheticSequences.add(row.syntheticSequence);
                        // getAll() is sorted by marker ID, NOT by commit
                        // order. Reconstruct each entity from the greatest
                        // durable sequence regardless of lexical marker order.
                        for (let i=0;i<entries.length;i++) {
                          const key=keys[i],former=expectedEntities.get(key);
                          if (former && former.syntheticSequence === row.syntheticSequence)
                            return false;
                          if (!former || former.syntheticSequence < row.syntheticSequence)
                            expectedEntities.set(key,{
                              ...row,syntheticMutationJson:canonicalSyntheticMutation(entries[i])
                            });
                        }
                      } else if (owns(row,'syntheticEntityKey')
                        || owns(row,'syntheticEntityKeys')
                        || owns(row,'syntheticSequence')) {
                        return false;
                      }
                      return true;
                    });
                    const entityByKey = new Map();
                    const entitiesValid = entities.length === expectedEntities.size
                      && entities.every(row => {
                        const latest = expectedEntities.get(row.id);
                        if (!latest || entityByKey.has(row.id)
                          || row.generation !== generation
                          || row.epoch !== latest.epoch
                          || row.sequence !== latest.syntheticSequence
                          || row.lastMarker !== latest.id.slice('writer_marker:'.length)
                          || row.syntheticMutationJson !== latest.syntheticMutationJson
                          || row.payloadFingerprint !== latest.payloadFingerprint)
                          return false;
                        entityByKey.set(row.id,row);
                        return true;
                      });
                    // Every preflighted typed marker must still be present.
                    // Replacing it with a marker-only row (and deleting its
                    // entity) must not escape the two-pass digest check.
                    const typedMarkerCount = markers.filter(row =>
                      owns(row,'syntheticMutationJson')
                        || owns(row,'syntheticMutationBatchJson')).length;
                    const lastMarkerRow=markers.find(row=>row.id===lastKey);
                    const lastKnownSequence=lastMarkerRow
                      ? (owns(lastMarkerRow,'writerSequence')
                        ? lastMarkerRow.writerSequence
                        : owns(lastMarkerRow,'syntheticSequence')
                          ? lastMarkerRow.syntheticSequence : null) : null;
                    // The control pointer cannot refer to an earlier
                    // numbered marker. If a legacy marker has no sequence,
                    // it cannot supersede a known marker at the final count.
                    const finalSequenceOwner=markers.find(row=>
                      row.writerSequence===state.writersCommitted
                        || row.syntheticSequence===state.writersCommitted);
                    const lastMarkerSequenceValid=state.writersCommitted===0
                      || (lastMarkerRow
                        && (lastKnownSequence===null
                          || lastKnownSequence===state.writersCommitted)
                        && (!finalSequenceOwner
                          || finalSequenceOwner.id===lastKey));
                    // Strict freezes seal the origin in the atomic fence
                    // record as well as in nine family markers. A tampered
                    // fence-only claim cannot pass an independent audit.
                    const sealed=markers.filter(row=>
                      typeof row.writerFamily==='string'
                      &&typeof row.originFingerprint==='string');
                    const strictSealValid=!owns(state,'strictFreezeSourceFingerprint')
                      || (AUTHORITY_CUTOVER_WRITER_FAMILIES.every(family=>
                        sealed.some(row=>row.writerFamily===family))
                        &&sealed.every(row=>row.originFingerprint===
                          state.strictFreezeSourceFingerprint));
                    const inventoryValid = Array.isArray(records)
                      && strictSealValid
                      && typedMarkerCount === historicalDigestProofs.size
                      && lastMarkerSequenceValid
                      && markers.filter(row=>historicalMarkerSnapshots.has(row.id)).length
                        === historicalMarkerSnapshots.size
                      && markers.length === state.writersCommitted
                      && records.length === markers.length + entities.length + (prior ? 1 : 0)
                      && markersValid && entitiesValid
                      && (state.writersCommitted === 0 || markerIds.has(lastKey));
                    if (!inventoryValid) {
                      result = refuse('fence_writer_inventory_inconsistent', {
                        fence: describe(state),
                        observedMarkerCount: markers.length
                      });
                      return;
                    }
                    callback(markers.length,entityByKey,markers);
                  } catch (_) {
                    result = refuse('fence_writer_inventory_unreadable', {
                      fence: describe(state)
                    });
                    try { tx.abort(); } catch (_) {}
                  }
                };
              };
              if (action === 'read') {
                result = refuse('fence_read_only', {
                  initialized: !!prior, fence: describe(state)
                });
                return;
              }
              if (action === 'audit') {
                inspectAllWriterMarkers((count,entities,markers) => {
                  const observedFamilyCounts=Object.fromEntries(
                    AUTHORITY_CUTOVER_WRITER_FAMILIES.map(family=>[
                      family,markers.filter(row=>row.writerFamily===family).length
                    ]));
                  const eligible=markers.filter(row=>
                    typeof row.writerFamily==='string'
                    &&typeof row.originFingerprint==='string');
                  const missingObservedFamilies=AUTHORITY_CUTOVER_WRITER_FAMILIES
                    .filter(family=>!eligible.some(row=>row.writerFamily===family));
                  const familyFingerprints=new Set(eligible.map(row=>row.originFingerprint));
                  let originStillCurrent=false;
                  try{
                    originStillCurrent=auditOrigin!==null
                      &&captureReadOnlyFullStorageInventory()===auditOrigin;
                  }catch(_){}
                  result = refuse('preview_writer_inventory_consistent', {
                    previewWriterFamilyCounts:observedFamilyCounts,
                    missingObservedFamilies,
                    syntheticFamilyInventoryComplete:missingObservedFamilies.length===0,
                    syntheticFamilyOriginConsistent:familyFingerprints.size===1,
                    strictFreezeSourceSealed:typeof state.strictFreezeSourceFingerprint
                      ==='string',
                    strictFreezeSourceMatchesCurrent:
                      typeof state.strictFreezeSourceFingerprint==='string'
                        ? originStillCurrent&&auditOriginFingerprint===
                          state.strictFreezeSourceFingerprint : null,
                    // A matching partial roster is still NOT a production
                    // writer handoff. An old tab can change V1 immediately
                    // after this purely observational check.
                    syntheticFamilyOriginMatchesCurrent:eligible.length>0
                      &&originStillCurrent&&familyFingerprints.size===1
                      &&familyFingerprints.has(auditOriginFingerprint),
                    readOnlyInventoryAudit: true,
                    historicalPayloadDigestsVerified: true,
                    initialized: !!prior, observedMarkerCount: count,
                    observedEntityCount: entities.size,
                    fence: describe(state)
                  });
                });
                return;
              }
              if (action === 'inspect_entity') {
                inspectAllWriterMarkers((count,entities) => {
                  const key = syntheticEntityKeyFor(options);
                  const saved = entities.get(key);
                  const mutation = saved ? JSON.parse(saved.syntheticMutationJson) : null;
                  result = refuse(saved
                    ? 'preview_synthetic_entity_present'
                    : 'preview_synthetic_entity_absent', {
                    readOnlyEntityInspection: true,
                    inventoryVerified: true,
                    entity: saved ? {
                      collection: mutation.collection,
                      entityId: mutation.entityId,
                      operation: mutation.operation,
                      value: mutation.operation === 'put' ? mutation.value : null,
                      lastMarker: saved.lastMarker,
                      sequence: saved.sequence
                    } : null,
                    fence: describe(state)
                  });
                });
                return;
              }
              if (action === 'inspect_marker') {
                // Read-only recovery evidence after a test caller lost the
                // response to its writer transaction. This does not retry,
                // reconcile, unfreeze, or mutate any underlying app state.
                const markerId = 'writer_marker:' + options.marker;
                const lookup = store.get(markerId);
                lookup.onerror = () => {
                  result = refuse('fence_writer_marker_unreadable');
                  try { tx.abort(); } catch (_) {}
                };
                lookup.onsuccess = () => {
                  try {
                    if (!isDarkEnabled() || darkMirrorModeEpoch !== initialModeEpoch
                      || currentGeneration({ create: false }) !== generation) {
                      result = refuse('preview_or_generation_changed_in_transaction');
                      return;
                    }
                    const item = lookup.result;
                    if (item && (!prior || state.writersCommitted < 1
                      || item.id !== markerId || item.generation !== generation
                      || !Number.isSafeInteger(item.epoch) || item.epoch < 0
                      || item.epoch > state.epoch
                      || !validPayloadFingerprint(item.payloadFingerprint)
                      || !syntheticMarkerValid(item))) {
                      result = refuse('fence_writer_marker_conflict', {
                        fence: describe(state)
                      });
                      return;
                    }
                    if(item&&familyOwned
                      &&(item.writerFamily||null)!==writerFamily){
                      result=refuse('fence_writer_family_mismatch',{
                        fence:describe(state)
                      });
                      return;
                    }
                    if (item && hasAnySynthetic
                      && ((item.syntheticMutationJson || null) !== syntheticMutationJson
                        || (item.syntheticMutationBatchJson || null) !== syntheticBatchJson)) {
                      result = refuse('fence_writer_synthetic_mutation_mismatch', {
                        fence: describe(state)
                      });
                      return;
                    }
                    if (item && hasAnySynthetic
                      && item.payloadFingerprint !== effectivePayloadFingerprint) {
                      result = refuse('fence_writer_synthetic_digest_mismatch', {
                        fence: describe(state)
                      });
                      return;
                    }
                    if (item && hasPayloadFingerprint
                      && item.payloadFingerprint !== payloadFingerprint) {
                      result = refuse('fence_writer_payload_mismatch', {
                        fence: describe(state)
                      });
                      return;
                    }
                    // If the control's most recent committed marker is now
                    // missing, "absent" does NOT mean the write never
                    // happened. Refuse ambiguous recovery, never repair.
                    if (!item && prior && state.lastWriterMarker === options.marker) {
                      result = refuse('fence_writer_marker_missing', {
                        fence: describe(state)
                      });
                      return;
                    }
                    const finishInspection = () => {
                      result = refuse(item
                        ? 'preview_writer_marker_present'
                        : 'preview_writer_marker_absent', {
                        readOnlyMarkerInspection: true,
                        inventoryVerified: true,
                        historicalPayloadDigestsVerified: true,
                        markerEpoch: item ? item.epoch : null,
                        markerWriterSequence: item
                          ? (item.writerSequence ?? item.syntheticSequence ?? null)
                          : null,
                        markerPayloadFingerprint: item ? item.payloadFingerprint : null,
                        recordedWriterFamily:item?.writerFamily||null,
                        recordedOriginFingerprint:item?.originFingerprint||null,
                        previewFamilyClaimMatched:familyOwned&&!!item,
                        syntheticMutationPresent:
                          !!(item?.syntheticMutationJson || item?.syntheticMutationBatchJson),
                        syntheticMutationVerified: hasAnySynthetic && !!item,
                        syntheticBatchSize: item?.syntheticMutationBatchJson
                          ? storedSyntheticEntries(item).length : null,
                        fence: describe(state)
                      });
                    };
                    // A marker-only or absent-marker lookup is not a
                    // trustworthy recovery verdict if an older ledger row
                    // is missing or its synthetic evidence was altered.
                    // Validate the *whole* preview inventory for every
                    // read-only marker inspection, not just typed callers.
                    inspectAllWriterMarkers(finishInspection);
                  } catch (_) {
                    result = refuse('fence_writer_marker_inspection_failed');
                    try { tx.abort(); } catch (_) {}
                  }
                };
                return;
              }
              if (expectedEpoch !== state.epoch) {
                result = refuse('fence_epoch_stale', { fence: describe(state) });
                return;
              }
              if (state.frozen) {
                result = refuse('fence_frozen', { fence: describe(state) });
                return;
              }
              if (action === 'freeze') {
                if (!Number.isSafeInteger(state.epoch + 1)) {
                  result = refuse('fence_epoch_exhausted', { fence: describe(state) });
                  return;
                }
                // Freeze must not certify an incomplete or corrupted marker
                // ledger. The scan and frozen-control put share one IDB
                // readwrite transaction, so cooperating writers cannot
                // interleave a marker commit between these two operations.
                inspectAllWriterMarkers((count,entities,markers) => {
                  if(options?.requireAllKnownFamilies===true){
                    const eligible=markers.filter(row=>
                      typeof row.writerFamily==='string'
                      &&typeof row.originFingerprint==='string');
                    const missing=AUTHORITY_CUTOVER_WRITER_FAMILIES.filter(
                      family=>!eligible.some(row=>row.writerFamily===family));
                    if(missing.length){
                      result=refuse('preview_writer_families_incomplete',{
                        missingObservedFamilies:missing,
                        observedFamilyCount:AUTHORITY_CUTOVER_WRITER_FAMILIES.length
                          -missing.length,
                        fence:describe(state)
                      });
                      return;
                    }
                    // All nine claims must refer to ONE V1 snapshot, and
                    // the real current V1 inventory must still equal it.
                    // Even then, silent old tabs remain fully unfenced.
                    const seals=new Set(eligible.map(row=>row.originFingerprint));
                    if(seals.size!==1||!seals.has(freezeOriginFingerprint)){
                      result=refuse('preview_writer_families_origin_diverged',{
                        distinctRecordedOrigins:seals.size,fence:describe(state)
                      });
                      return;
                    }
                    try{
                      if(captureReadOnlyFullStorageInventory()!==freezeOrigin){
                        result=refuse('preview_writer_family_origin_stale',{
                          fence:describe(state)
                        });
                        return;
                      }
                    }catch(_){
                      result=refuse('preview_writer_family_origin_unreadable');
                      return;
                    }
                  }
                  const next = { ...state, frozen: true, epoch: state.epoch + 1,
                    ...(strictFamilyFreeze ? {
                      strictFreezeSourceFingerprint:freezeOriginFingerprint
                    } : {})
                  };
                  store.put(next);
                  result = refuse('preview_fence_frozen', {
                    atomicPreviewTransaction: true,
                    markerInventoryVerified: true,
                    historicalPayloadDigestsVerified: true,
                    fence: describe(next)
                  });
                });
                return;
              }
              // Keep each synthetic marker in the SAME readwrite
              // transaction as the writer count. A tab retrying a completed
              // marker must never inflate the count or silently record it
              // again, even after another marker was recorded in between.
              const markerId = 'writer_marker:' + options.marker;
              const markerRequest = store.get(markerId);
              markerRequest.onerror = () => {
                result = refuse('fence_writer_marker_unreadable');
                try { tx.abort(); } catch (_) {}
              };
              markerRequest.onsuccess = () => {
                try {
                  // Another same-origin tab can rotate the preview
                  // generation between the first control read and this
                  // independent marker lookup. Refuse before either put.
                  if (!isDarkEnabled() || darkMirrorModeEpoch !== initialModeEpoch
                    || currentGeneration({ create: false }) !== generation) {
                    result = refuse('preview_or_generation_changed_in_transaction');
                    return;
                  }
                  // This is an observational admission check; an old tab
                  // that ignores it may still write an instant later.
                  if(familyOwned){
                    try{
                      if(captureReadOnlyFullStorageInventory()!==familyOrigin){
                        result=refuse('preview_writer_family_origin_stale',{
                          fence:describe(state)
                        });
                        return;
                      }
                    }catch(_){
                      result=refuse('preview_writer_family_origin_unreadable');
                      return;
                    }
                  }
                  const marker = markerRequest.result;
                  if (marker) {
                    if (!prior || state.writersCommitted < 1
                      || marker.id !== markerId
                      || marker.generation !== generation
                      || marker.epoch !== state.epoch
                      || !validPayloadFingerprint(marker.payloadFingerprint)
                      || !syntheticMarkerValid(marker)) {
                      result = refuse('fence_writer_marker_conflict', {
                        fence: describe(state)
                      });
                      return;
                    }
                    if((marker.writerFamily||null)!==writerFamily){
                      result=refuse('fence_writer_family_mismatch',{
                        fence:describe(state)
                      });
                      return;
                    }
                    if(familyOwned&&marker.originFingerprint!==undefined
                      &&marker.originFingerprint!==familyOriginFingerprint){
                      result=refuse('fence_writer_origin_fingerprint_mismatch',{
                        fence:describe(state)
                      });
                      return;
                    }
                    if ((marker.syntheticMutationJson || null) !== syntheticMutationJson
                      || (marker.syntheticMutationBatchJson || null) !== syntheticBatchJson) {
                      result = refuse('fence_writer_synthetic_mutation_mismatch', {
                        fence: describe(state)
                      });
                      return;
                    }
                    if (marker.payloadFingerprint !== effectivePayloadFingerprint) {
                      result = refuse('fence_writer_payload_mismatch', {
                        fence: describe(state)
                      });
                      return;
                    }
                    const finishReplay = () => {
                      result = refuse('preview_writer_replayed', {
                        alreadyRecorded: true, fingerprintMatched: true,
                        syntheticMutationVerified: hasAnySynthetic,
                        fence: describe(state)
                      });
                    };
                    // Even marker-only idempotent retries must not
                    // report success over an incomplete historical ledger.
                    // The entire inventory is verified in the same IDB
                    // transaction as the replay verdict.
                    inspectAllWriterMarkers(finishReplay);
                    return;
                  }
                  // A vanished last-marker row is an inconsistency, not
                  // permission to double-count a replay with the same ID.
                  if (prior && state.lastWriterMarker === options.marker) {
                    result = refuse('fence_writer_marker_missing', {
                      fence: describe(state)
                    });
                    return;
                  }
                  if (!Number.isSafeInteger(state.writersCommitted + 1)) {
                    result = refuse('fence_writer_counter_exhausted', {
                      fence: describe(state)
                    });
                    return;
                  }
                  const next = { ...state,
                    writersCommitted: state.writersCommitted + 1,
                    lastWriterMarker: options.marker
                  };
                  // Both puts commit together or neither does. Request
                  // callbacks stay synchronous to keep the IDB tx alive.
                  const commitPreviewWriter = () => {
                    if(familyOwned){
                      try{
                        if(captureReadOnlyFullStorageInventory()!==familyOrigin){
                          result=refuse('preview_writer_family_origin_stale',{
                            fence:describe(state)
                          });
                          return;
                        }
                      }catch(_){
                        result=refuse('preview_writer_family_origin_unreadable');
                        return;
                      }
                    }
                    // Materialized put/delete (tombstone), immutable intent
                    // and acknowledgement all commit in ONE IDB transaction.
                    // Never delete an entity row: a deletion remains explicit.
                    // All entity puts/deletes, immutable intent, and one
                    // acknowledgement commit or roll back together.
                    for (const mutation of syntheticEntries) {
                      store.put({
                        id: syntheticEntityKeyFor(mutation),generation,
                        epoch: state.epoch,sequence: next.writersCommitted,
                        lastMarker: options.marker,
                        syntheticMutationJson: canonicalSyntheticMutation(mutation),
                        payloadFingerprint: effectivePayloadFingerprint
                      });
                    }
                    store.put({ id: markerId, generation, epoch: state.epoch,
                      writerSequence: next.writersCommitted,
                      payloadFingerprint: effectivePayloadFingerprint,
                      ...(familyOwned?{
                        writerFamily,originFingerprint:familyOriginFingerprint
                      }:{}),
                      ...(hasSyntheticMutation ? {
                        syntheticMutationJson, syntheticEntityKey,
                        syntheticSequence: next.writersCommitted
                      } : {}),
                      ...(hasSyntheticBatch ? {
                        syntheticMutationBatchJson: syntheticBatchJson,
                        syntheticEntityKeys: syntheticEntries.map(syntheticEntityKeyFor),
                        syntheticSequence: next.writersCommitted
                      } : {}) });
                    store.put(next);
                    result = refuse('preview_writer_recorded', {
                      atomicPreviewTransaction: true,
                      syntheticMutationDurable: hasAnySynthetic,
                      materializedSyntheticEntity: hasAnySynthetic,
                      syntheticRecordCount: syntheticEntries.length,
                      fence: describe(next)
                    });
                  };
                  // Marker-only preview acknowledgements also advance
                  // the durable writer counter. They must meet the same
                  // complete historical-evidence gate as typed mutations.
                  // Commit and inventory verification remain in one IDB
                  // readwrite transaction, with no async work in callbacks.
                  inspectAllWriterMarkers(commitPreviewWriter);
                } catch (_) {
                  result = refuse('fence_writer_marker_write_failed');
                  try { tx.abort(); } catch (_) {}
                }
              };
            } catch (_) {
              result = refuse('fence_transaction_callback_failed');
              try { tx.abort(); } catch (_) {}
            }
          };
        } catch (_) {
          finish(refuse('fence_transaction_unavailable'));
        }
      };
    });
    if(attemptResult.reason!=='fence_writer_digest_snapshot_stale'){
      // The atomic marker may have committed before a non-cooperating V1 tab
      // saved different source data. A successful IDB transaction is NOT
      // proof that the legacy source is still identical when we acknowledge.
      // Refuse a clean success but retain the durable marker for read-only
      // recovery inspection. Never undo or rewrite either storage system.
      // Strict preview freeze can race a real old-tab save after the
      // synthetic IndexedDB fence commits. Treat that outcome as uncertain,
      // not as evidence of an immutable V1 origin or production exclusion.
      // The fence may already be frozen; never attempt to undo it here.
      if(strictFamilyFreeze&&attemptResult.reason==='preview_fence_frozen'){
        const uncertain=reason=>refuse(reason,{
          fenceMayAlreadyBeFrozen:true,
          inspectFenceBeforeRetry:true,
          fence:attemptResult.fence
        });
        try{
          if(captureReadOnlyFullStorageInventory()!==freezeOrigin)
            return uncertain('preview_writer_family_freeze_origin_changed_after_transaction');
        }catch(_){
          return uncertain('preview_writer_family_freeze_origin_unreadable_after_transaction');
        }
      }
      if(familyOwned&&action==='writer'
        &&(attemptResult.reason==='preview_writer_recorded'
          ||attemptResult.reason==='preview_writer_replayed')){
        const uncertain=reason=>refuse(reason,{
          durableMarkerMayExist:true,
          inspectMarkerBeforeRetry:true,
          fence:attemptResult.fence
        });
        try{
          if(captureReadOnlyFullStorageInventory()!==familyOrigin)
            return uncertain('preview_writer_family_origin_changed_after_transaction');
        }catch(_){
          return uncertain('preview_writer_family_origin_unreadable_after_transaction');
        }
      }
      return attemptResult;
    }
    }
    return refuse('fence_writer_digest_snapshot_stale');
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
      // Use the complete origin keyspace, not recovery checkpoints' narrower
      // taskpoints_* namespace. Notes, Projects, Today and game preferences
      // are independently writable by old tabs while a Web Lock is held.
      initialInventoryFingerprint = await previewRecoveryFingerprint(
        JSON.parse(captureReadOnlyFullStorageInventory()));
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
            currentInventory = captureReadOnlyFullStorageInventory();
            currentFingerprint = await previewRecoveryFingerprint(
              JSON.parse(currentInventory));
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
            if (captureReadOnlyFullStorageInventory() !== currentInventory) {
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
    // Observe other V1 tabs' already-durable changes on preview hosts only.
    // This never blocks startup or replaces the foreground V1 save path.
    installObservedLegacyTaskPeerListener();
    const bridge = global.TaskPointsStateRuntimeV2WalBridge;
    const startup = bridge?.__installedModule && typeof bridge.start === 'function'
      ? bridge.start() : startDarkMirror();
    // V2 preview only: a page can close after V1 Task compaction but BEFORE
    // the quiet-window Task observer ran. The next preview load therefore
    // needs one background reconciliation opportunity even with no pending
    // Task journal remaining. Wait until dark startup settles and never add
    // IndexedDB/large state reads to the foreground bootstrap path.
    if (isWalTestPreviewHost()) {
      const startupGeneration = currentGeneration({ create: false });
      const startupEpoch = darkMirrorModeEpoch;
      Promise.resolve(startup).then(() => {
        if (startupGeneration !== currentGeneration({ create: false })
          || startupEpoch !== darkMirrorModeEpoch
          || !observedTaskPreviewAllowed()) return;
        const startupKey = startupGeneration + ':' + startupEpoch;
        if (observedTaskStartupKey === startupKey) return;
        observedTaskStartupKey = startupKey;
        observedTaskStartupRequests += 1;
        queueObservedLegacyTaskJournal();
      }).catch(() => {
        // A failed dark startup is not permission to touch the V1 authority.
      });
    }
    return startup;
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

  // An explicitly invoked preview-host-only real Projects localStorage writer.
  // Uses the SAME cooperative lock as Task batches and the preview freeze.
  // No production Home/Projects save route is redirected into this method.
  // New JSON is a bounded exact raw value, never normalized or trimmed; all
  // unknown Project properties remain intact. Any competing old-tab save
  // detected after the write yields an uncertain result, not a rollback.
  async function rehearsePreviewCooperativeProjectsSave(nextProjectsRaw,
    expectedInventoryToken) {
    const refuse=(reason,extra={})=>({
      checked:true,previewOnly:true,cooperativeTaskFreezeLockUsed:false,
      projectsSaved:false,confirmedDurable:false,committed:false,
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...extra
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken.length)
      return refuse('full_origin_token_required');
    const locks=global.navigator?.locks;
    if(typeof locks?.request!=='function')return refuse('lock_manager_unavailable');
    if(typeof nextProjectsRaw!=='string'||nextProjectsRaw.length<2
      ||nextProjectsRaw.length>262144)
      return refuse('projects_json_required_or_oversized');
    // Never let a lossy JSON round-trip silently rewrite unknown Project
    // fields. The caller supplies the exact canonical JSON bytes to save.
    let projects;
    try{
      projects=JSON.parse(nextProjectsRaw);
      if(!Array.isArray(projects)||JSON.stringify(projects)!==nextProjectsRaw)
        return refuse('projects_json_noncanonical');
      const ids=new Set();
      for(const project of projects){
        if(!project||typeof project!=='object'||Array.isArray(project)
          ||typeof project.id!=='string'||!project.id
          ||project.id.length>128||ids.has(project.id))
          return refuse('projects_ids_invalid');
        ids.add(project.id);
        if(project.subtasks!=null){
          if(!Array.isArray(project.subtasks))
            return refuse('projects_subtasks_invalid');
          const subIds=new Set();
          for(const sub of project.subtasks){
            if(!sub||typeof sub!=='object'||Array.isArray(sub)
              ||typeof sub.id!=='string'||!sub.id||sub.id.length>128
              ||subIds.has(sub.id))
              return refuse('projects_subtasks_invalid');
            subIds.add(sub.id);
          }
        }
      }
    }catch(_){return refuse('projects_json_invalid');}
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const originalEpoch=darkMirrorModeEpoch;
    let result=refuse('cooperative_projects_lock_not_available');
    let attemptedWrite=false;
    try{
      await locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        {mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock){
            result=refuse('cooperative_projects_lock_held_elsewhere');
            return;
          }
          if(!isDarkEnabled()||darkMirrorModeEpoch!==originalEpoch
            ||currentGeneration({create:false})!==generation){
            result=refuse('generation_changed_under_cooperative_lock');
            return;
          }
          const fence=await rehearsePreviewDurableWriterFence('audit');
          if(fence.reason!=='preview_writer_inventory_consistent'){
            result=refuse('preview_fence_inventory_unverified',{
              prerequisiteReason:fence.reason});return;
          }
          if(fence.fence?.generation!==generation
            ||!isDarkEnabled()||darkMirrorModeEpoch!==originalEpoch){
            result=refuse('preview_generation_changed_before_projects_write');
            return;
          }
          if(fence.fence.frozen){
            result=refuse('preview_fence_frozen',{
              cooperativeTaskFreezeLockUsed:true,
              fenceEpoch:fence.fence.epoch});
            return;
          }
          let before;
          try{before=captureReadOnlyFullStorageInventory();}
          catch(_){result=refuse('full_origin_unreadable');return;}
          if(before!==expectedInventoryToken){
            result=refuse('full_origin_changed');return;
          }
          const key='tp_projects_v1';
          let priorRaw;
          try{priorRaw=global.localStorage.getItem(key);}
          catch(_){result=refuse('projects_source_unreadable');return;}
          // Refuse overwriting malformed existing Projects data, even if the
          // caller captured that corruption in its supplied source token.
          if(priorRaw!==null){
            try{
              const old=JSON.parse(priorRaw);
              if(!Array.isArray(old))throw Error('not_an_array');
              const ids=new Set();
              for(const item of old){
                if(!item||typeof item!=='object'||Array.isArray(item)
                  ||typeof item.id!=='string'||!item.id
                  ||item.id.length>128||ids.has(item.id))
                  throw Error('existing_project_ids_invalid');
                ids.add(item.id);
                if(item.subtasks!=null){
                  if(!Array.isArray(item.subtasks))
                    throw Error('existing_subtasks_invalid');
                  const subs=new Set();
                  for(const sub of item.subtasks){
                    if(!sub||typeof sub!=='object'||Array.isArray(sub)
                      ||typeof sub.id!=='string'||!sub.id
                      ||sub.id.length>128||subs.has(sub.id))
                      throw Error('existing_subtask_ids_invalid');
                    subs.add(sub.id);
                  }
                }
              }
            }catch(_){result=refuse('projects_existing_source_invalid');return;}
          }
          // This last complete-source check is immediately before the
          // synchronous V1 localStorage write. A dormant old page can still
          // race it, so subsequent readback must fail closed as well.
          try{
            if(captureReadOnlyFullStorageInventory()!==expectedInventoryToken){
              result=refuse('full_origin_changed_before_projects_write');
              return;
            }
          }catch(_){
            result=refuse('full_origin_unreadable_before_projects_write');
            return;
          }
          if(!isDarkEnabled()||darkMirrorModeEpoch!==originalEpoch
            ||currentGeneration({create:false})!==generation){
            result=refuse('generation_changed_before_projects_write');
            return;
          }
          if(priorRaw===nextProjectsRaw){
            result=refuse('projects_source_already_identical',{
              cooperativeTaskFreezeLockUsed:true,projectsSaved:true,
              confirmedDurable:true,committed:false});
            return;
          }
          attemptedWrite=true;
          try{global.localStorage.setItem(key,nextProjectsRaw);}
          catch(_){
            result=refuse('projects_write_failed',{
              writeOutcomeUncertain:true});return;
          }
          let after;
          try{
            if(global.localStorage.getItem(key)!==nextProjectsRaw){
              result=refuse('projects_readback_mismatch',{
                writeOutcomeUncertain:true,committed:true});
              return;
            }
            after=captureReadOnlyFullStorageInventory();
            const filter=token=>JSON.parse(token)
              .filter(entry=>Array.isArray(entry)&&entry[0]!==key);
            if(stableJson(filter(after))!==stableJson(
              filter(expectedInventoryToken))){
              result=refuse('other_origin_changed_during_projects_write',{
                writeOutcomeUncertain:true,committed:true});return;
            }
          }catch(_){
            result=refuse('projects_readback_unreadable',{
              writeOutcomeUncertain:true,committed:true});return;
          }
          const afterFence=await rehearsePreviewDurableWriterFence('audit');
          if(afterFence.reason!=='preview_writer_inventory_consistent'
            ||afterFence.fence?.generation!==generation
            ||afterFence.fence?.epoch!==fence.fence.epoch
            ||afterFence.fence.frozen
            ||!isDarkEnabled()||darkMirrorModeEpoch!==originalEpoch
            ||currentGeneration({create:false})!==generation){
            result=refuse('projects_fence_changed_after_write',{
              writeOutcomeUncertain:true,committed:true,
              fenceReadbackRequired:true});return;
          }
          // The asynchronous postwrite fence audit can permit an older V1
          // page to write after synchronous readback. Sample again before
          // acknowledgment, still without assuming permanent exclusion.
          try{
            if(global.localStorage.getItem(key)!==nextProjectsRaw
              ||captureReadOnlyFullStorageInventory()!==after){
              result=refuse('projects_origin_changed_after_write',{
                writeOutcomeUncertain:true,committed:true});return;
            }
          }catch(_){
            result=refuse('projects_origin_unreadable_after_write',{
              writeOutcomeUncertain:true,committed:true});return;
          }
          result=refuse('preview_projects_saved',{
            cooperativeTaskFreezeLockUsed:true,projectsSaved:true,
            confirmedDurable:true,committed:true,
            fenceEpoch:afterFence.fence.epoch,projectCount:projects.length});
        });
    }catch(_){
      return refuse('cooperative_projects_lock_request_failed',{
        writeOutcomeUncertain:attemptedWrite,
        inspectV1BeforeRetry:attemptedWrite});
    }
    return result;
  }



  // Explicit preview-host-only Today view writer for the INDEPENDENT V1
  // day-map key. This uses the same cooperative Web Lock as preview Task,
  // Projects and freeze, but NEVER changes the production Today save path.
  // Exact JSON bytes are written: no implicit normalization or lossy rewrite.
  async function rehearsePreviewCooperativeTodaySave(nextTodayRaw, expectedInventoryToken) {
    const deny=(reason,details={})=>({
      checked:true,previewOnly:true,cooperativeTaskFreezeLockUsed:false,
      todaySaved:false,committed:false,confirmedDurable:false,
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...details
    });
    if(!isWalTestPreviewHost())return deny('preview_host_required');
    if(!isDarkEnabled())return deny('dark_disabled');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken.length)
      return deny('full_origin_token_required');
    const locks=global.navigator?.locks;
    if(typeof locks?.request!=='function')return deny('lock_manager_unavailable');
    if(typeof nextTodayRaw!=='string'||nextTodayRaw.length<2
      ||nextTodayRaw.length>1048576)return deny('today_json_required_or_oversized');
    const fields=['tasksByDay','notesByDay','selectedHabitIdsByDay','orderByDay'];
    function validTodayPayload(raw) {
      if(typeof raw!=='string'||raw.length<2||raw.length>1048576)
        return {reason:'today_source_oversized_or_invalid'};
      let value;
      try{value=JSON.parse(raw);}catch(_){return {reason:'today_json_invalid'};}
      if(!value||typeof value!=='object'||Array.isArray(value))
        return {reason:'today_object_required'};
      if(Object.prototype.hasOwnProperty.call(value,'version')
        &&value.version!==1)return {reason:'today_schema_unrecognized'};
      let entries=0;
      const days=new Set();
      for(const field of fields){
        if(!Object.prototype.hasOwnProperty.call(value,field))continue;
        const map=value[field];
        if(!map||typeof map!=='object'||Array.isArray(map))
          return {reason:'today_day_map_invalid'};
        for(const [day,items] of Object.entries(map)){
          if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Array.isArray(items))
            return {reason:'today_day_entries_invalid'};
          days.add(day);
          entries+=items.length;
          if(entries>100000||days.size>4096)
            return {reason:'today_day_map_too_large'};
        }
      }
      return {payload:value,dayCount:days.size,entryCount:entries};
    }
    const proposed=validTodayPayload(nextTodayRaw);
    if(proposed.reason)return deny('invalid_today_payload',{
      prerequisiteReason:proposed.reason});
    // Raw canonicality prevents an input with duplicate JSON keys or
    // whitespace padding from being silently reinterpreted in the preview.
    if(JSON.stringify(proposed.payload)!==nextTodayRaw)
      return deny('today_json_noncanonical');
    const generation=currentGeneration({create:false});
    if(!generation)return deny('generation_unavailable');
    const modeEpoch=darkMirrorModeEpoch;
    let result=deny('cooperative_today_lock_not_available');
    let attempted=false;
    try{
      await locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        {mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock){result=deny('cooperative_today_lock_held_elsewhere');return;}
          if(!isDarkEnabled()||darkMirrorModeEpoch!==modeEpoch
            ||currentGeneration({create:false})!==generation){
            result=deny('generation_changed_under_cooperative_lock');return;
          }
          const fence=await rehearsePreviewDurableWriterFence('audit');
          if(fence.reason!=='preview_writer_inventory_consistent'){
            result=deny('preview_fence_inventory_unverified',{
              prerequisiteReason:fence.reason});return;
          }
          if(fence.fence?.generation!==generation
            ||!isDarkEnabled()||darkMirrorModeEpoch!==modeEpoch){
            result=deny('preview_generation_changed_before_today_write');return;
          }
          if(fence.fence.frozen){
            result=deny('preview_fence_frozen',{
              cooperativeTaskFreezeLockUsed:true,
              fenceEpoch:fence.fence.epoch});return;
          }
          let observed;
          try{observed=captureReadOnlyFullStorageInventory();}
          catch(_){result=deny('full_origin_unreadable');return;}
          if(observed!==expectedInventoryToken){
            result=deny('full_origin_changed');return;
          }
          const key='taskpoints_today_view_v1';
          let priorRaw;
          try{priorRaw=global.localStorage.getItem(key);}
          catch(_){result=deny('today_source_unreadable');return;}
          if(priorRaw!==null){
            const existing=validTodayPayload(priorRaw);
            if(existing.reason){
              result=deny('today_existing_source_invalid',{
                prerequisiteReason:existing.reason});return;
            }
          }
          // A competing old tab is outside Web Locks; the final inventory
          // check narrows, but cannot eliminate, the prewrite race.
          try{
            if(captureReadOnlyFullStorageInventory()!==expectedInventoryToken){
              result=deny('full_origin_changed_before_today_write');return;
            }
          }catch(_){result=deny('full_origin_unreadable_before_today_write');return;}
          if(!isDarkEnabled()||darkMirrorModeEpoch!==modeEpoch
            ||currentGeneration({create:false})!==generation){
            result=deny('generation_changed_before_today_write');return;
          }
          if(priorRaw===nextTodayRaw){
            result=deny('today_source_already_identical',{
              cooperativeTaskFreezeLockUsed:true,todaySaved:true,
              confirmedDurable:true,committed:false});return;
          }
          attempted=true;
          try{global.localStorage.setItem(key,nextTodayRaw);}
          catch(_){result=deny('today_write_failed',{
            writeOutcomeUncertain:true});return;}
          let savedInventory;
          try{
            if(global.localStorage.getItem(key)!==nextTodayRaw){
              result=deny('today_readback_mismatch',{
                committed:true,writeOutcomeUncertain:true});return;
            }
            savedInventory=captureReadOnlyFullStorageInventory();
            const unrelated=token=>JSON.parse(token)
              .filter(entry=>Array.isArray(entry)&&entry[0]!==key);
            if(stableJson(unrelated(savedInventory))!==
              stableJson(unrelated(expectedInventoryToken))){
              result=deny('other_origin_changed_during_today_write',{
                committed:true,writeOutcomeUncertain:true});return;
            }
          }catch(_){result=deny('today_readback_unreadable',{
            committed:true,writeOutcomeUncertain:true});return;}
          const finalFence=await rehearsePreviewDurableWriterFence('audit');
          if(finalFence.reason!=='preview_writer_inventory_consistent'
            ||finalFence.fence?.generation!==generation
            ||finalFence.fence.epoch!==fence.fence.epoch
            ||finalFence.fence.frozen
            ||!isDarkEnabled()||darkMirrorModeEpoch!==modeEpoch
            ||currentGeneration({create:false})!==generation){
            result=deny('today_fence_changed_after_write',{
              committed:true,writeOutcomeUncertain:true,
              inspectV1BeforeRetry:true});return;
          }
          try{
            if(global.localStorage.getItem(key)!==nextTodayRaw
              ||captureReadOnlyFullStorageInventory()!==savedInventory){
              result=deny('today_origin_changed_after_write',{
                committed:true,writeOutcomeUncertain:true});return;
            }
          }catch(_){result=deny('today_origin_unreadable_after_write',{
            committed:true,writeOutcomeUncertain:true});return;}
          result=deny('preview_today_saved',{
            todaySaved:true,committed:true,confirmedDurable:true,
            cooperativeTaskFreezeLockUsed:true,
            dayCount:proposed.dayCount,entryCount:proposed.entryCount,
            fenceEpoch:finalFence.fence.epoch});
        });
    }catch(_){return deny('cooperative_today_lock_request_failed',{
      writeOutcomeUncertain:attempted,
      inspectV1BeforeRetry:attempted});}
    return result;
  }



  // One explicit, immutable recovery-intent record for FIRST Notes edits.
  // Preview-only, cooperative, and separate from all four live V1 Notes keys.
  // Never clear/replace the record, restore Notes from it or auto-enable this
  // through the production Notes page. A confirmed setItem is only evidence
  // for the intent itself, NOT proof of synchronized Notes or old-tab fencing.
  const PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY =
    'taskpoints_v2_preview_notes_first_edit_intent_v1';
  const PREVIEW_NOTES_FIRST_EDIT_LIMIT=65536;
  async function rehearsePreviewNotesFirstEditIntent(text,fullOriginToken,actionId){
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,intentOnly:true,intentRecorded:false,
      notesFullySynchronized:false,notesMultiKeySyncVerified:false,
      safeToApply:false,safeToRestore:false,confirmedNotesDurable:false,
      productionWritersFenced:false,canPromote:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(typeof text!=='string'||text.length>PREVIEW_NOTES_FIRST_EDIT_LIMIT)
      return refuse('notes_first_edit_intent_text_invalid_or_oversized');
    // The storage quota counts bytes, not just JS code units. Reject long
    // multi-byte strings and any missing encoder before touching V1 or WAL.
    if(typeof global.TextEncoder!=='function')
      return refuse('notes_first_edit_intent_encoder_unavailable');
    if(new global.TextEncoder().encode(text).byteLength
      >PREVIEW_NOTES_FIRST_EDIT_LIMIT)
      return refuse('notes_first_edit_intent_text_invalid_or_oversized');
    if(typeof fullOriginToken!=='string'||!fullOriginToken)
      return refuse('full_origin_token_required');
    if(typeof actionId!=='string'
      ||!/^[a-zA-Z0-9_:.\-]{1,96}$/.test(actionId))
      return refuse('notes_first_edit_action_id_invalid');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const locks=global.navigator?.locks;
    if(typeof locks?.request!=='function')
      return refuse('lock_manager_unavailable');
    let captured;
    try {
      if(captureReadOnlyFullStorageInventory()!==fullOriginToken)
        return refuse('full_origin_changed');
      if(global.localStorage.getItem(PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY)!==null)
        return refuse('existing_first_edit_intent_must_be_inspected');
      captured=await capturePreviewNotesBundle(fullOriginToken,generation,epoch);
      if(captured.reason)return refuse('notes_first_edit_source_unverified',{
        prerequisiteReason:captured.reason});
      if(captured.bundle.dirtyRaw==='1'||captured.bundle.authorityRaw==='1')
        return refuse('notes_authority_already_established');
    }catch(_){return refuse('notes_first_edit_source_unavailable');}
    const record={id:'notes-first-edit-intent',schemaVersion:2,
      actionId,resetGeneration:generation,
      originFingerprint:captured.bundle.originFingerprint,
      sourceFingerprint:captured.bundle.sourceFingerprint,
      // Bind the exact original V1 snapshot bytes, including unrelated
      // Tasks/Habits. A freshly recaptured token cannot authorize a save
      // over a different old-tab snapshot.
      snapshotFingerprint:captured.bundle.snapshotFingerprint,text};
    let sealed;
    try {
      sealed=JSON.stringify({...record,
        integrityFingerprint:await previewRecoveryFingerprint(record)});
      if(new global.TextEncoder().encode(sealed).byteLength
        >PREVIEW_NOTES_FIRST_EDIT_LIMIT)
        return refuse('notes_first_edit_intent_record_oversized');
      if(!captured.current())return refuse('notes_first_edit_source_changed_before_lock');
    }catch(_){return refuse('notes_first_edit_digest_unavailable');}
    let touched=false;
    let result=refuse('notes_first_edit_lock_unavailable');
    try {
      await locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        {mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock){result=refuse('cooperative_notes_lock_held_elsewhere');return;}
          if(!captured.current()){
            result=refuse('notes_first_edit_source_changed_under_lock');return;
          }
          const fence=await rehearsePreviewDurableWriterFence('audit');
          if(fence.reason!=='preview_writer_inventory_consistent'
            ||fence.fence?.generation!==generation
            ||fence.fence.frozen||epoch!==darkMirrorModeEpoch
            ||!isDarkEnabled()||currentGeneration({create:false})!==generation){
            result=refuse('notes_first_edit_fence_unverified_or_frozen');
            return;
          }
          try {
            if(!captured.current()
              ||global.localStorage.getItem(PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY)!==null){
              result=refuse('notes_first_edit_source_changed_before_write');
              return;
            }
          }catch(_){result=refuse('notes_first_edit_source_unreadable');return;}
          if(previewNotesWitnessObservedExternalChange(generation,epoch)){
            result=refuse('notes_first_edit_external_tab_event_observed');
            return;
          }
          // Exactly one synchronous write. On quota denial, preserve the
          // prior Notes and all existing recovery bytes; never retry blindly.
          touched=true;
          try {global.localStorage.setItem(PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY,sealed);}
          catch(_){
            result=refuse('notes_first_edit_intent_write_uncertain',{
              writeOutcomeUncertain:true,inspectIntentBeforeRetry:true});
            return;
          }
          try {
            if(global.localStorage.getItem(PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY)!==sealed){
              result=refuse('notes_first_edit_intent_readback_mismatch',{
                writeOutcomeUncertain:true,inspectIntentBeforeRetry:true});
              return;
            }
            const observed=captureReadOnlyFullStorageInventory();
            const withoutIntent=stableJson(JSON.parse(observed)
              .filter(([key])=>key!==PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY));
            if(withoutIntent!==fullOriginToken){
              result=refuse('notes_first_edit_other_source_changed_after_write',{
                writeOutcomeUncertain:true,inspectIntentBeforeRetry:true});
              return;
            }
            const after=await rehearsePreviewDurableWriterFence('audit');
            if(after.reason!=='preview_writer_inventory_consistent'
              ||after.fence?.generation!==generation
              ||after.fence?.epoch!==fence.fence.epoch||after.fence.frozen
              ||epoch!==darkMirrorModeEpoch||!isDarkEnabled()
              ||currentGeneration({create:false})!==generation
              ||global.localStorage.getItem(PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY)!==sealed
              ||captureReadOnlyFullStorageInventory()!==observed){
              result=refuse('notes_first_edit_postwrite_uncertain',{
                writeOutcomeUncertain:true,inspectIntentBeforeRetry:true});
              return;
            }
            result=refuse('preview_notes_first_edit_intent_recorded',{
              intentRecorded:true,verifiedIntentReadback:true,
              cooperativeLockUsed:true,savedLength:text.length});
          }catch(_){
            result=refuse('notes_first_edit_postwrite_unreadable',{
              writeOutcomeUncertain:true,inspectIntentBeforeRetry:true});
          }
        });
    }catch(_){
      return refuse('notes_first_edit_lock_request_failed',{
        writeOutcomeUncertain:touched,inspectIntentBeforeRetry:touched});
    }
    return result;
  }

  // Read-only verification survives a preview tab reload or a stopped
  // earlier first-edit sequence. Report NO text, no automatic recovery, and
  // no claim that any live Notes location was safely synchronized.
  async function inspectPreviewNotesFirstEditIntent(){
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,intentEvidenceVerified:false,
      sourceInventoryMatchesAdmission:false,notesCacheMatchesIntent:false,
      safeToApply:false,safeToRestore:false,confirmedNotesDurable:false,
      notesMultiKeySyncVerified:false,productionWritersFenced:false,
      canPromote:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...detail
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    try {
      const first=captureReadOnlyFullStorageInventory();
      const raw=global.localStorage.getItem(PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY);
      if(raw===null)return refuse('notes_first_edit_intent_absent');
      const record=JSON.parse(raw);
      if(typeof global.TextEncoder!=='function'
        ||new global.TextEncoder().encode(raw).byteLength
          >PREVIEW_NOTES_FIRST_EDIT_LIMIT)
        return refuse('notes_first_edit_intent_invalid');
      if(!record||typeof record!=='object'||Array.isArray(record)
        ||![1,2].includes(record.schemaVersion)
        ||Object.keys(record).length!==(record.schemaVersion===2?9:8)
        ||record.id!=='notes-first-edit-intent'
        ||(record.schemaVersion===2
          &&record.snapshotFingerprint!==null
          &&!/^sha256:[a-f0-9]{64}:\d+$/.test(record.snapshotFingerprint))
        ||typeof record.actionId!=='string'
        ||!/^[a-zA-Z0-9_:.\-]{1,96}$/.test(record.actionId)
        ||typeof record.resetGeneration!=='string'
        ||typeof record.text!=='string'
        ||record.text.length>PREVIEW_NOTES_FIRST_EDIT_LIMIT
        ||typeof record.originFingerprint!=='string'
        ||typeof record.sourceFingerprint!=='string'
        ||typeof record.integrityFingerprint!=='string')
        return refuse('notes_first_edit_intent_invalid');
      const {integrityFingerprint,...signed}=record;
      if(await previewRecoveryFingerprint(signed)!==integrityFingerprint)
        return refuse('notes_first_edit_intent_integrity_mismatch');
      const currentWithout=stableJson(JSON.parse(first)
        .filter(([key])=>key!==PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY));
      const initialMatches=await previewRecoveryFingerprint(currentWithout)
        ===record.originFingerprint;
      const cache=global.localStorage.getItem('taskpoints_notes_v1');
      const dirty=global.localStorage.getItem('taskpoints_notes_dirty_v1');
      const authority=global.localStorage.getItem(
        'taskpoints_notes_authoritative_v1');
      // Diagnose the observed crash stage using the same V1 Notes selection
      // rules, without repairing any data. An intact sealed intent remains
      // independently inspectable even when the current snapshot is corrupt.
      let snapshotValid=false,snapshotNotes='';
      try{
        const snapshotRaw=global.localStorage.getItem(
          core.STORAGE_KEY||'taskpoints_v1');
        if(typeof snapshotRaw==='string'&&snapshotRaw
          &&typeof core.parseTaskPointsStorageJson==='function'){
          const decoded=core.parseTaskPointsStorageJson(snapshotRaw);
          if(decoded&&typeof decoded==='object'&&!Array.isArray(decoded)
            &&(decoded.notes===undefined
              ||typeof decoded.notes==='string')){
            snapshotNotes=decoded.notes||'';
            snapshotValid=true;
          }
        }
      }catch(_){}
      const markerValid=[null,'0','1'].includes(dirty)
        &&[null,'0','1'].includes(authority);
      const cacheMatches=cache===record.text;
      const snapshotMatches=snapshotValid&&snapshotNotes===record.text;
      const cacheMarked=dirty==='1'||authority==='1';
      const stage=!snapshotValid?'snapshot_unavailable_or_invalid'
        :!markerValid?'notes_markers_invalid'
        :cache===null&&cacheMarked?'marked_cache_missing'
        :!cacheMatches?initialMatches?'intent_recorded_source_unchanged'
          :'intent_not_in_current_cache'
        :!cacheMarked?snapshotMatches?'unmarked_cache_snapshot_equal'
          :'unmarked_cache_snapshot_diverged'
        :dirty==='1'&&authority!=='1'?'dirty_without_authority'
        :dirty==='1'?snapshotMatches?'snapshot_synced_dirty_pending'
          :'dirty_cache_snapshot_pending'
        :snapshotMatches?'snapshot_and_cache_match_dirty_cleared'
          :'authority_marker_snapshot_pending';
      const legacySelection=(!snapshotValid||!markerValid)
        ?null
        :cache!==null&&cacheMarked?cache
        :cache===null?snapshotNotes
        :cache.trim()&&!snapshotNotes.trim()?cache
        :snapshotNotes.trim()&&!cache.trim()?snapshotNotes
        :cache.length>=snapshotNotes.length?cache:snapshotNotes;
      if(!isWalTestPreviewHost()||!isDarkEnabled()
        ||currentGeneration({create:false})!==generation
        ||captureReadOnlyFullStorageInventory()!==first
        ||global.localStorage.getItem(PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY)!==raw)
        return refuse('notes_first_edit_intent_source_changed_during_inspection');
      if(record.resetGeneration!==generation)
        return refuse('notes_first_edit_intent_generation_mismatch');
      return {
        ...refuse('preview_notes_first_edit_intent_verified'),
        intentEvidenceVerified:true,
        sourceInventoryMatchesAdmission:initialMatches,
        notesCacheMatchesIntent:cacheMatches,
        notesCacheAuthorityEstablished:cacheMarked,
        currentSnapshotReadable:snapshotValid,
        currentMarkersValid:markerValid,
        snapshotMatchesIntent:snapshotMatches,
        legacySelectsIntendedText:legacySelection===record.text,
        observedRecoveryStage:stage,
        // These are point-in-time facts, not authority to replay intent,
        // clear dirty state, or exclude an older suspended Notes tab.
        canAutomaticallyResume:false,safeToClearDirtyMarker:false,
        savedLength:record.text.length,
        // The intent is an independent diagnostic copy, NOT a complete
        // app backup, a new Notes read path or authorized rescue.
        safeToApply:false,safeToRestore:false,confirmedNotesDurable:false
      };
    }catch(_){return refuse('notes_first_edit_intent_inspection_unavailable');}
  }



  // Opt-in, page-lifetime witness of cross-tab storage *events*. A legacy
  // tab can change V1 Notes and change them back (A -> B -> A) while a
  // before/after origin checksum still matches. Unlike stored plaintext
  // snapshots, this witness retains only a digest and event counters.
  // Old pages are NOT obliged to notify us, and suspended pages may miss
  // events. This evidence NEVER grants writer admission or authority.
  let previewLegacyStorageEventWitness=null;
  // A transient cross-tab A -> B -> A storage change may escape a final
  // origin-token comparison. If a page-lifetime witness is active, treat
  // *any* observed external event or invalidated witness as a hard denial.
  // Absence of a witness/event is NOT proof that old tabs are excluded.
  function previewNotesWitnessObservedExternalChange(generation,epoch){
    const witness=previewLegacyStorageEventWitness;
    return !!witness&&(witness.invalidated
      ||witness.generation!==generation
      ||witness.epoch!==epoch
      ||witness.totalEvents!==0);
  }
  async function beginPreviewLegacyStorageEventWitness(expectedOriginToken){
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,observing:false,
      productionWritersFenced:false,oldTabsExcluded:false,
      canPromote:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...detail
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(typeof expectedOriginToken!=='string'||!expectedOriginToken)
      return refuse('full_origin_token_required');
    if(previewLegacyStorageEventWitness)
      return refuse('storage_event_witness_already_active');
    if(typeof global.addEventListener!=='function'
      ||typeof global.removeEventListener!=='function')
      return refuse('storage_event_listener_unavailable');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    try{
      if(captureReadOnlyFullStorageInventory()!==expectedOriginToken)
        return refuse('full_origin_changed');
    }catch(_){return refuse('full_origin_unreadable');}
    const witness={
      generation,epoch,baselineFingerprint:null,
      totalEvents:0,notesEvents:0,otherEvents:0,clearEvents:0,
      invalidated:false,handler:null
    };
    witness.handler=event=>{
      // No event values, keys or user content are copied or retained.
      if(previewLegacyStorageEventWitness!==witness)return;
      if(!isWalTestPreviewHost()||!isDarkEnabled()
        ||darkMirrorModeEpoch!==epoch
        ||currentGeneration({create:false})!==generation)
        witness.invalidated=true;
      witness.totalEvents=Math.min(1000000,witness.totalEvents+1);
      const key=event?.key;
      if(key===null)witness.clearEvents=Math.min(1000000,witness.clearEvents+1);
      else if(key==='taskpoints_notes_v1'
        ||key==='taskpoints_notes_dirty_v1'
        ||key==='taskpoints_notes_authoritative_v1'
        ||key===(core.STORAGE_KEY||'taskpoints_v1'))
        witness.notesEvents=Math.min(1000000,witness.notesEvents+1);
      else witness.otherEvents=Math.min(1000000,witness.otherEvents+1);
      if(witness.totalEvents>=1000000)witness.invalidated=true;
    };
    try{global.addEventListener('storage',witness.handler);}
    catch(_){return refuse('storage_event_listener_install_failed');}
    previewLegacyStorageEventWitness=witness;
    try{
      witness.baselineFingerprint=await previewRecoveryFingerprint(expectedOriginToken);
      if(!isWalTestPreviewHost()||!isDarkEnabled()
        ||darkMirrorModeEpoch!==epoch
        ||currentGeneration({create:false})!==generation
        ||captureReadOnlyFullStorageInventory()!==expectedOriginToken
        ||witness.invalidated||witness.totalEvents!==0){
        global.removeEventListener('storage',witness.handler);
        previewLegacyStorageEventWitness=null;
        return refuse('storage_event_witness_source_changed_during_start');
      }
    }catch(_){
      try{global.removeEventListener('storage',witness.handler);}catch(_){}
      previewLegacyStorageEventWitness=null;
      return refuse('storage_event_witness_digest_unavailable');
    }
    return {...refuse('preview_legacy_storage_event_witness_started'),
      observing:true,storageEventsObserved:0,
      oldTabsExcluded:false,canPromote:false};
  }

  async function inspectPreviewLegacyStorageEventWitness(){
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,observing:false,
      observedStorageEvents:0,notesRelatedEvents:0,
      otherOriginEvents:0,originClearEvents:0,
      originMatchesStart:false,
      transientCrossTabChangeObserved:false,
      oldTabsExcluded:false,missedEventsRuledOut:false,
      productionWritersFenced:false,canPromote:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    const w=previewLegacyStorageEventWitness;
    if(!w)return refuse('storage_event_witness_not_active');
    if(w.invalidated||currentGeneration({create:false})!==w.generation
      ||darkMirrorModeEpoch!==w.epoch)
      return refuse('storage_event_witness_generation_changed');
    try{
      const before=captureReadOnlyFullStorageInventory();
      const count=w.totalEvents;
      const counters=[w.notesEvents,w.otherEvents,w.clearEvents];
      const digest=await previewRecoveryFingerprint(before);
      if(previewLegacyStorageEventWitness!==w||w.invalidated
        ||!isWalTestPreviewHost()||!isDarkEnabled()
        ||currentGeneration({create:false})!==w.generation
        ||darkMirrorModeEpoch!==w.epoch
        ||captureReadOnlyFullStorageInventory()!==before
        ||w.totalEvents!==count
        ||w.notesEvents!==counters[0]||w.otherEvents!==counters[1]
        ||w.clearEvents!==counters[2])
        return refuse('storage_event_witness_changed_during_inspection');
      const matches=digest===w.baselineFingerprint;
      return {...refuse(matches
        ?count?'origin_matches_but_cross_tab_events_observed'
          :'origin_matches_no_events_observed'
        :'origin_changed_since_witness_started'),
        observing:true,observedStorageEvents:count,
        notesRelatedEvents:counters[0],otherOriginEvents:counters[1],
        originClearEvents:counters[2],originMatchesStart:matches,
        transientCrossTabChangeObserved:matches&&count>0,
        // No event => no observed event, NOT a quiet-tab proof.
        oldTabsExcluded:false,missedEventsRuledOut:false,
        productionWritersFenced:false,canPromote:false};
    }catch(_){return refuse('storage_event_witness_inspection_unavailable');}
  }

  function stopPreviewLegacyStorageEventWitness(){
    const w=previewLegacyStorageEventWitness;
    if(!w)return {checked:true,stopped:false,
      reason:'storage_event_witness_not_active',canPromote:false};
    previewLegacyStorageEventWitness=null;
    try{global.removeEventListener('storage',w.handler);}
    catch(_){return {checked:true,stopped:false,
      reason:'storage_event_listener_removal_uncertain',canPromote:false};}
    return {checked:true,stopped:true,reason:'storage_event_witness_stopped',
      canPromote:false};
  }

  // Cooperative cross-tab FIRST Notes edit inspection. This shares the
  // preview freeze's Web Lock, but old V1 pages may ignore Web Locks entirely.
  // The result is a bounded diagnostic, NEVER an exclusive writer lease,
  // proof of a quiet browser origin, or permission to resume/restore Notes.
  async function inspectPreviewCooperativeNotesFirstEditConflict(
    expectedInventoryToken) {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,cooperativeLockUsed:false,
      intentEvidenceVerified:false,stableOriginObserved:false,
      oldTabsExcluded:false,productionWritersFenced:false,
      notesMultiKeySyncVerified:false,canAutomaticallyResume:false,
      safeToRestore:false,safeToClearDirtyMarker:false,
      canPromote:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...detail
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken)
      return refuse('full_origin_token_required');
    const locks=global.navigator?.locks;
    if(typeof locks?.request!=='function')
      return refuse('lock_manager_unavailable');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const modeEpoch=darkMirrorModeEpoch;
    let result=refuse('cooperative_notes_conflict_lock_unavailable');
    try{
      await locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        {mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock){
            result=refuse('cooperative_notes_conflict_lock_held_elsewhere');
            return;
          }
          const current=()=>isWalTestPreviewHost()&&isDarkEnabled()
            &&modeEpoch===darkMirrorModeEpoch
            &&currentGeneration({create:false})===generation;
          if(!current()){
            result=refuse('notes_conflict_generation_changed_under_lock');
            return;
          }
          let before;
          try{
            before=captureReadOnlyFullStorageInventory();
            if(before!==expectedInventoryToken){
              result=refuse('full_origin_changed_under_cooperative_lock');
              return;
            }
          }catch(_){
            result=refuse('notes_conflict_origin_unreadable');
            return;
          }
          // The V2 preview freeze is separate from the live Notes writer.
          // Honor its state, and never mistake the successful audit for
          // proof that a suspended pre-V2 tab has been fenced.
          const fence=await rehearsePreviewDurableWriterFence('audit');
          if(!current()||fence.reason!=='preview_writer_inventory_consistent'
            ||fence.fence?.generation!==generation||fence.fence.frozen){
            result=refuse('notes_conflict_preview_fence_unverified_or_frozen');
            return;
          }
          try{
            if(captureReadOnlyFullStorageInventory()!==before){
              result=refuse('notes_conflict_origin_changed_during_fence');
              return;
            }
          }catch(_){
            result=refuse('notes_conflict_origin_unreadable');
            return;
          }
          const evidence=await inspectPreviewNotesFirstEditIntent();
          if(!evidence.intentEvidenceVerified){
            result=refuse('notes_conflict_intent_unverified',{
              prerequisiteReason:evidence.reason});
            return;
          }
          let after;
          try{after=captureReadOnlyFullStorageInventory();}
          catch(_){
            result=refuse('notes_conflict_origin_unreadable_after_evidence');
            return;
          }
          if(!current()||after!==before){
            result=refuse('notes_conflict_origin_changed_during_evidence');
            return;
          }
          const afterFence=await rehearsePreviewDurableWriterFence('audit');
          if(!current()
            ||afterFence.reason!=='preview_writer_inventory_consistent'
            ||afterFence.fence?.generation!==generation
            ||afterFence.fence?.epoch!==fence.fence.epoch
            ||afterFence.fence.frozen){
            result=refuse('notes_conflict_fence_changed_during_evidence');
            return;
          }
          try{
            if(captureReadOnlyFullStorageInventory()!==after){
              result=refuse('notes_conflict_origin_changed_after_evidence');
              return;
            }
          }catch(_){
            result=refuse('notes_conflict_origin_unreadable_after_evidence');
            return;
          }
          const originSame=evidence.sourceInventoryMatchesAdmission;
          const cacheSame=evidence.notesCacheMatchesIntent;
          // Source divergence is an observation, not attribution: it may be
          // the intended first edit, an older tab, an import or a reset.
          const conflictSignal=originSame?'no_current_origin_change'
            :cacheSame?'origin_changed_intent_cache_matches'
            :'origin_changed_intent_cache_mismatch';
          result=refuse('notes_cooperative_conflict_evidence_observed',{
            cooperativeLockUsed:true,intentEvidenceVerified:true,
            stableOriginObserved:true,previewFenceEpoch:afterFence.fence.epoch,
            conflictSignal,sourceInventoryMatchesAdmission:originSame,
            notesCacheMatchesIntent:cacheSame,
            observedRecoveryStage:evidence.observedRecoveryStage,
            // A successful preview lock does not fence the actual V1 writer.
            oldTabsExcluded:false,productionWritersFenced:false,
            canAutomaticallyResume:false,safeToRestore:false,
            safeToClearDirtyMarker:false,canPromote:false
          });
        });
    }catch(_){return refuse('notes_conflict_lock_request_failed');}
    return result;
  }


  // Prototype a safer FIRST Notes edit order without writing any V1 key.
  // Independent intent -> seed cache with current EFFECTIVE V1 Notes ->
  // authority marker -> proposed cache -> dirty marker -> snapshot ->
  // clear dirty. Seeding the baseline before the authority marker matters:
  // the unmarked legacy reader may prefer an older, longer snapshot over
  // a shorter stale cache. Simply setting the marker first can regress.
  async function inspectPreviewNotesBaselineFirstProtocol(expectedInventoryToken){
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,prototypeOnly:true,
      intentEvidenceVerified:false,sourceVerified:false,
      allCrashPrefixesPreserveExpectedSelection:false,
      liveWriterActivated:false,canApply:false,
      notesMultiKeySyncVerified:false,oldTabsExcluded:false,
      productionWritersFenced:false,safeToRestore:false,
      canPromote:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...detail
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken)
      return refuse('full_origin_token_required');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    try{
      if(captureReadOnlyFullStorageInventory()!==expectedInventoryToken)
        return refuse('full_origin_changed');
      const proof=await inspectPreviewNotesFirstEditIntent();
      if(!proof.intentEvidenceVerified)
        return refuse('notes_first_edit_intent_unverified',{
          prerequisiteReason:proof.reason});
      if(!proof.sourceInventoryMatchesAdmission)
        return refuse('notes_source_changed_since_intent');
      if(captureReadOnlyFullStorageInventory()!==expectedInventoryToken)
        return refuse('notes_source_changed_during_intent_validation');
      const raw=global.localStorage.getItem(
        PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY);
      const sealed=JSON.parse(raw);
      if(!sealed||typeof sealed.text!=='string'
        ||typeof sealed.integrityFingerprint!=='string')
        return refuse('notes_first_edit_intent_unverified');
      const {integrityFingerprint,...record}=sealed;
      if(await previewRecoveryFingerprint(record)!==integrityFingerprint)
        return refuse('notes_first_edit_intent_unverified');
      const source=await capturePreviewNotesBundle(
        expectedInventoryToken,generation,epoch);
      if(source.reason)return refuse('notes_source_preflight_failed',{
        prerequisiteReason:source.reason});
      const original=source.bundle;
      if(original.dirtyRaw==='1'||original.authorityRaw==='1')
        return refuse('first_edit_already_marked');
      const snapshot=original.stateNotes;
      const cache=original.cacheNotes;
      const proposed=sealed.text;
      const pick=(cacheText,hasCache,dirty,authority,snapshotText)=>{
        if(hasCache&&(dirty==='1'||authority==='1'))
          return {value:cacheText,source:'marked_cache'};
        if(cacheText.trim()&&!snapshotText.trim())
          return {value:cacheText,source:'unmarked_cache_only'};
        if(snapshotText.trim()&&!cacheText.trim())
          return {value:snapshotText,source:'unmarked_snapshot_only'};
        if(cacheText===snapshotText)
          return {value:cacheText,source:'unmarked_equal'};
        return cacheText.length>=snapshotText.length
          ?{value:cacheText,source:'unmarked_cache_longer'}
          :{value:snapshotText,source:'unmarked_snapshot_longer'};
      };
      const baseline=pick(cache,original.cachePresent,
        original.dirtyRaw,original.authorityRaw,snapshot).value;
      const prefix=[
        {stage:'sealed_intent_before_v1_change',
          cache,hasCache:original.cachePresent,
          authority:original.authorityRaw,dirty:original.dirtyRaw,
          snapshot,expected:baseline},
        {stage:'baseline_seeded_in_cache',
          cache:baseline,hasCache:true,
          authority:original.authorityRaw,dirty:original.dirtyRaw,
          snapshot,expected:baseline},
        {stage:'authority_marker_before_new_cache',
          cache:baseline,hasCache:true,authority:'1',
          dirty:original.dirtyRaw,snapshot,expected:baseline},
        {stage:'new_cache_after_authority_marker',
          cache:proposed,hasCache:true,authority:'1',
          dirty:original.dirtyRaw,snapshot,expected:proposed},
        {stage:'dirty_marker_after_new_cache',
          cache:proposed,hasCache:true,authority:'1',
          dirty:'1',snapshot,expected:proposed},
        {stage:'snapshot_synced_before_dirty_clear',
          cache:proposed,hasCache:true,authority:'1',
          dirty:'1',snapshot:proposed,expected:proposed},
        {stage:'dirty_marker_cleared',
          cache:proposed,hasCache:true,authority:'1',
          dirty:null,snapshot:proposed,expected:proposed}
      ];
      const stages=prefix.map(p=>{
        const chosen=pick(p.cache,p.hasCache,p.dirty,p.authority,p.snapshot);
        return {
          stage:p.stage,selectedSource:chosen.source,
          expectedTextWouldBeSelected:chosen.value===p.expected,
          proposedTextWouldBeSelected:chosen.value===proposed,
          previousEffectiveNotesPreserved:chosen.value===baseline,
          cacheMarked:p.authority==='1'||p.dirty==='1'
        };
      });
      // A tempting but WRONG shortcut: authority='1' before seeding
      // baseline cache. It may select stale cache and hide the old snapshot.
      const unsafeShortcut=pick(cache,original.cachePresent,
        original.dirtyRaw,'1',snapshot);
      if(!source.current()
        ||global.localStorage.getItem(
          PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY)!==raw)
        return refuse('notes_source_changed_during_protocol_audit');
      return {
        ...refuse('notes_baseline_first_protocol_inspected'),
        intentEvidenceVerified:true,sourceVerified:true,
        allCrashPrefixesPreserveExpectedSelection:
          stages.every(s=>s.expectedTextWouldBeSelected),
        previousNotesPreservedUntilNewCache:
          stages.slice(0,3).every(s=>s.previousEffectiveNotesPreserved),
        proposedNotesSelectedAfterNewCache:
          stages.slice(3).every(s=>s.proposedTextWouldBeSelected),
        shortcutAuthorityFirstWouldHideBaseline:
          unsafeShortcut.value!==baseline,
        baselineCacheAlreadyCanonical:
          original.cachePresent&&cache===baseline,
        simulatedStages:stages,
        // This is a model of the V1 reader, NOT a safe-to-apply
        // authorization. Pre-V2 tabs can still overwrite any V1 key.
        liveWriterActivated:false,canApply:false,oldTabsExcluded:false,
        notesMultiKeySyncVerified:false,safeToRestore:false,
        canPromote:false
      };
    }catch(_){return refuse('notes_baseline_first_audit_unavailable');}
  }


  // This is an ACTUAL, explicitly invoked V1 Notes cache+marker writer for
  // a disposable developer-preview origin, not merely a state simulator.
  // Production Notes inputs never call it and V1 remains sole authority.
  // All first-edit writes use the same lock and existing sealed intent.
  // The baseline comes FIRST so a failure cannot resurrect stale cache.
  async function rehearsePreviewAdmittedNotesFirstEditCacheWrite(
    expectedInventoryToken, actionId) {
    const refuse=(reason,extra={})=>({
      checked:true,previewOnly:true,v1CacheWriteOnly:true,
      firstEditApplied:false,committed:false,
      readbackVerified:false,cooperativeLockUsed:false,
      writeOutcomeUncertain:false,inspectIntentBeforeRetry:false,
      notesFullySynchronized:false,notesMultiKeySyncVerified:false,
      confirmedNotesDurable:false,productionWritersFenced:false,
      oldTabsExcluded:false,canAutomaticallyResume:false,
      safeToClearDirtyMarker:false,safeToRestore:false,
      canPromote:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...extra
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken)
      return refuse('full_origin_token_required');
    if(typeof actionId!=='string'
      ||!/^[a-zA-Z0-9_:.-]{1,96}$/.test(actionId))
      return refuse('first_edit_action_id_invalid');
    const locks=global.navigator?.locks;
    if(typeof locks?.request!=='function')
      return refuse('lock_manager_unavailable');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    let result=refuse('first_edit_cooperative_lock_unavailable');
    let attempted=false;
    const key='taskpoints_notes_v1';
    const authorityKey='taskpoints_notes_authoritative_v1';
    const dirtyKey='taskpoints_notes_dirty_v1';
    const allowed=new Set([key,authorityKey,dirtyKey]);
    const withoutNotes=token=>stableJson(JSON.parse(token)
      .filter(row=>Array.isArray(row)&&!allowed.has(row[0])));
    try{
      await locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        {mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock){
            result=refuse('first_edit_cooperative_lock_held_elsewhere');
            return;
          }
          const stableMode=()=>isWalTestPreviewHost()&&isDarkEnabled()
            &&epoch===darkMirrorModeEpoch
            &&currentGeneration({create:false})===generation;
          if(!stableMode()){
            result=refuse('first_edit_generation_changed_under_lock');
            return;
          }
          let before;
          try{
            before=captureReadOnlyFullStorageInventory();
            if(before!==expectedInventoryToken){
              result=refuse('full_origin_changed_under_lock');return;
            }
          }catch(_){
            result=refuse('first_edit_source_unreadable');return;
          }
          const fence=await rehearsePreviewDurableWriterFence('audit');
          if(!stableMode()
            ||fence.reason!=='preview_writer_inventory_consistent'
            ||fence.fence?.generation!==generation||fence.fence.frozen){
            result=refuse('first_edit_preview_fence_unverified_or_frozen');
            return;
          }
          const intent=await inspectPreviewNotesFirstEditIntent();
          if(!intent.intentEvidenceVerified
            ||!intent.sourceInventoryMatchesAdmission){
            result=refuse('first_edit_intent_not_current',{
              prerequisiteReason:intent.reason});
            return;
          }
          const rawIntent=global.localStorage.getItem(
            PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY);
          let sealed;
          try{
            sealed=JSON.parse(rawIntent);
            if(!sealed||sealed.actionId!==actionId
              ||sealed.resetGeneration!==generation
              ||typeof sealed.text!=='string'
              ||sealed.text.length>PREVIEW_NOTES_FIRST_EDIT_LIMIT)
              throw Error('invalid_action');
            const {integrityFingerprint,...payload}=sealed;
            if(await previewRecoveryFingerprint(payload)!==integrityFingerprint)
              throw Error('invalid_integrity');
          }catch(_){
            result=refuse('first_edit_intent_or_action_invalid');return;
          }
          const captured=await capturePreviewNotesBundle(
            expectedInventoryToken,generation,epoch);
          if(captured.reason){
            result=refuse('first_edit_legacy_source_invalid',{
              prerequisiteReason:captured.reason});
            return;
          }
          const bundle=captured.bundle;
          if(bundle.authorityRaw==='1'||bundle.dirtyRaw==='1'){
            result=refuse('first_edit_markers_already_established');return;
          }
          const chosenFromCache=['unmarked_cache_only',
            'unmarked_cache_longer','unmarked_equal'].includes(
              bundle.selectedSource);
          const baseline=chosenFromCache?bundle.cacheNotes:bundle.stateNotes;
          const nextText=sealed.text;
          if(baseline===nextText){
            result=refuse('first_edit_intent_does_not_change_notes');return;
          }
          try{
            if(!stableMode()||!captured.current()
              ||global.localStorage.getItem(
                PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY)!==rawIntent){
              result=refuse('first_edit_source_changed_before_write');
              return;
            }
          }catch(_){
            result=refuse('first_edit_source_unreadable_before_write');
            return;
          }
          if(previewNotesWitnessObservedExternalChange(generation,epoch)){
            result=refuse('first_edit_external_tab_event_observed');
            return;
          }
          // There is deliberately NO await between these writes. A tab
          // stopped after any prefix still has the previous Notes or the
          // new cache marked authoritative. This is not cross-tab atomic:
          // pre-V2 tabs do not acquire this cooperative lock.
          const write=(k,value)=>{
            attempted=true;
            global.localStorage.setItem(k,value);
            if(global.localStorage.getItem(k)!==value)
              throw Error('notes_first_edit_readback_mismatch');
          };
          try{
            if(global.localStorage.getItem(key)!==baseline)
              write(key,baseline);
            write(authorityKey,'1');
            write(key,nextText);
            write(dirtyKey,'1');
          }catch(_){
            result=refuse('first_edit_cache_write_uncertain',{
              committed:attempted,writeOutcomeUncertain:attempted,
              inspectIntentBeforeRetry:attempted,
              cooperativeLockUsed:true});
            return;
          }
          let saved;
          try{
            saved=captureReadOnlyFullStorageInventory();
            if(!stableMode()
              ||withoutNotes(saved)!==withoutNotes(expectedInventoryToken)
              ||global.localStorage.getItem(key)!==nextText
              ||global.localStorage.getItem(authorityKey)!=='1'
              ||global.localStorage.getItem(dirtyKey)!=='1'
              ||global.localStorage.getItem(
                PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY)!==rawIntent){
              result=refuse('first_edit_other_origin_changed_during_write',{
                committed:true,writeOutcomeUncertain:true,
                inspectIntentBeforeRetry:true,cooperativeLockUsed:true});
              return;
            }
          }catch(_){
            result=refuse('first_edit_postwrite_readback_unavailable',{
              committed:true,writeOutcomeUncertain:true,
              inspectIntentBeforeRetry:true,cooperativeLockUsed:true});
            return;
          }
          const afterFence=await rehearsePreviewDurableWriterFence('audit');
          try{
            if(!stableMode()
              ||afterFence.reason!=='preview_writer_inventory_consistent'
              ||afterFence.fence?.generation!==generation
              ||afterFence.fence?.epoch!==fence.fence.epoch
              ||afterFence.fence?.frozen
              ||previewNotesWitnessObservedExternalChange(generation,epoch)
              ||captureReadOnlyFullStorageInventory()!==saved){
              result=refuse('first_edit_postwrite_fence_or_origin_changed',{
                committed:true,writeOutcomeUncertain:true,
                inspectIntentBeforeRetry:true,cooperativeLockUsed:true});
              return;
            }
          }catch(_){
            result=refuse('first_edit_postwrite_evidence_unavailable',{
              committed:true,writeOutcomeUncertain:true,
              inspectIntentBeforeRetry:true,cooperativeLockUsed:true});
            return;
          }
          result=refuse('preview_first_edit_cache_and_markers_recorded',{
            firstEditApplied:true,committed:true,
            readbackVerified:true,cooperativeLockUsed:true,
            baselineSeededBeforeAuthority:true,
            notesCacheLength:nextText.length,
            // The V1 snapshot remains unchanged and its dirty marker
            // deliberately stays set pending the existing V1 sync path.
            notesFullySynchronized:false,notesMultiKeySyncVerified:false,
            confirmedNotesDurable:false,oldTabsExcluded:false,
            canAutomaticallyResume:false,canPromote:false
          });
        });
    }catch(_){
      return refuse('first_edit_cooperative_lock_request_failed',{
        committed:attempted,writeOutcomeUncertain:attempted,
        inspectIntentBeforeRetry:attempted});
    }
    return result;
  }

  // Explicit developer-preview continuation AFTER an admitted first Notes
  // cache edit. Write only taskpoints_v1.notes, leaving the dirty marker
  // SET. A separate future protocol must prove safe marker clearing.
  // This cannot authorize a live Notes listener or exclude pre-V2 tabs.
  async function rehearsePreviewAdmittedNotesSnapshotSync(
    expectedInventoryToken,actionId) {
    const deny=(reason,extra={})=>({
      checked:true,previewOnly:true,snapshotOnly:true,
      snapshotWriteAttempted:false,notesSnapshotSynchronized:false,
      notesMultiKeySyncVerified:false,dirtyMarkerPreserved:false,
      confirmedNotesDurable:false,writeOutcomeUncertain:false,
      inspectIntentBeforeRetry:false,oldTabsExcluded:false,
      productionWritersFenced:false,canAutomaticallyResume:false,
      safeToClearDirtyMarker:false,safeToRestore:false,
      canPromote:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...extra
    });
    if(!isWalTestPreviewHost())return deny('preview_host_required');
    if(!isDarkEnabled())return deny('dark_disabled');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken)
      return deny('full_origin_token_required');
    if(typeof actionId!=='string'
      ||!/^[a-zA-Z0-9_:.-]{1,96}$/.test(actionId))
      return deny('snapshot_sync_action_id_invalid');
    const locks=global.navigator?.locks;
    if(typeof locks?.request!=='function')
      return deny('lock_manager_unavailable');
    const generation=currentGeneration({create:false});
    if(!generation)return deny('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const snapshotKey=core.STORAGE_KEY||'taskpoints_v1';
    const cacheKey='taskpoints_notes_v1';
    const authorityKey='taskpoints_notes_authoritative_v1';
    const dirtyKey='taskpoints_notes_dirty_v1';
    let attempted=false,result=deny('snapshot_sync_lock_unavailable');
    const stableMode=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&epoch===darkMirrorModeEpoch
      &&currentGeneration({create:false})===generation;
    const withoutSnapshot=token=>stableJson(JSON.parse(token)
      .filter(row=>Array.isArray(row)&&row[0]!==snapshotKey));
    const uncertain=(reason)=>deny(reason,{
      snapshotWriteAttempted:attempted,writeOutcomeUncertain:attempted,
      inspectIntentBeforeRetry:attempted
    });
    try {
      await locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        {mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock){result=deny('snapshot_sync_lock_held_elsewhere');return;}
          let before;
          try{
            before=captureReadOnlyFullStorageInventory();
            if(!stableMode()||before!==expectedInventoryToken){
              result=deny('snapshot_sync_origin_changed');return;
            }
          }catch(_){result=deny('snapshot_sync_origin_unreadable');return;}
          const fence=await rehearsePreviewDurableWriterFence('audit');
          if(!stableMode()
            ||fence.reason!=='preview_writer_inventory_consistent'
            ||fence.fence?.generation!==generation||fence.fence.frozen){
            result=deny('snapshot_sync_fence_unverified_or_frozen');return;
          }
          const evidence=await inspectPreviewNotesFirstEditIntent();
          if(!evidence.intentEvidenceVerified
            ||!evidence.notesCacheMatchesIntent
            ||!evidence.currentMarkersValid
            ||!evidence.currentSnapshotReadable
            ||!evidence.legacySelectsIntendedText
            ||evidence.observedRecoveryStage!=='dirty_cache_snapshot_pending'){
            result=deny('snapshot_sync_first_edit_not_verified',{
              prerequisiteReason:evidence.reason,
              observedRecoveryStage:evidence.observedRecoveryStage||null});
            return;
          }
          let sealed,sourceRaw,proposedRaw;
          try{
            const rawIntent=global.localStorage.getItem(
              PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY);
            sealed=JSON.parse(rawIntent);
            if(sealed.actionId!==actionId
              ||sealed.resetGeneration!==generation
              ||typeof sealed.text!=='string'
              ||sealed.text.length>PREVIEW_NOTES_FIRST_EDIT_LIMIT)
              throw Error('invalid_intent');
            if(sealed.schemaVersion!==2
              ||typeof sealed.snapshotFingerprint!=='string'
              ||!/^sha256:[a-f0-9]{64}:\d+$/.test(
                sealed.snapshotFingerprint)){
              result=deny('snapshot_sync_baseline_attestation_required');
              return;
            }
            const {integrityFingerprint,...signed}=sealed;
            if(await previewRecoveryFingerprint(signed)!==integrityFingerprint)
              throw Error('intent_integrity_changed');
            sourceRaw=global.localStorage.getItem(snapshotKey);
            if(await previewRecoveryFingerprint(sourceRaw)
                !==sealed.snapshotFingerprint){
              result=deny('snapshot_sync_original_snapshot_changed');
              return;
            }
            // Never re-serialize an encoded/opaque legacy snapshot in this
            // limited preview prototype. The real V1 codec must be used for
            // the eventual production handoff.
            const source=JSON.parse(sourceRaw);
            // A JSON.parse/stringify round-trip can silently collapse
            // duplicate keys, normalize numeric and escaped-string bytes,
            // or discard original formatting. The preview-only writer is
            // allowed to edit Notes, NOT normalize other legacy fields.
            // Require the exact canonical V1 JSON.stringify representation;
            // noncanonical imports must remain V1-owned until the actual
            // production serializer can safely update them.
            if(JSON.stringify(source)!==sourceRaw){
              result=deny('snapshot_sync_noncanonical_legacy_json');
              return;
            }
            if(!source||typeof source!=='object'||Array.isArray(source)
              ||(source.notes!==undefined&&typeof source.notes!=='string')
              ||typeof core.parseTaskPointsStorageJson!=='function'
              ||stableJson(core.parseTaskPointsStorageJson(sourceRaw))
                !==stableJson(source)
              ||source.notes===sealed.text)
              throw Error('snapshot_format_or_state_incompatible');
            const next={...source,notes:sealed.text};
            proposedRaw=JSON.stringify(next);
            if(stableJson(core.parseTaskPointsStorageJson(proposedRaw))
                !==stableJson(next))
              throw Error('preview_codec_roundtrip_mismatch');
            if(!stableMode()
              ||captureReadOnlyFullStorageInventory()!==before
              ||global.localStorage.getItem(cacheKey)!==sealed.text
              ||global.localStorage.getItem(authorityKey)!=='1'
              ||global.localStorage.getItem(dirtyKey)!=='1'
              ||global.localStorage.getItem(snapshotKey)!==sourceRaw
              ||global.localStorage.getItem(
                PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY)!==rawIntent){
              result=deny('snapshot_sync_source_changed_before_write');
              return;
            }
          }catch(_){
            result=deny('snapshot_sync_unverified_or_incompatible_snapshot');
            return;
          }
          if(previewNotesWitnessObservedExternalChange(generation,epoch)){
            result=deny('snapshot_sync_external_tab_event_observed');
            return;
          }
          // One synchronous snapshot write. Never clear dirty, rewrite
          // the immutable intent, or automatically retry uncertain writes.
          attempted=true;
          try{global.localStorage.setItem(snapshotKey,proposedRaw);}
          catch(_){result=uncertain('snapshot_sync_write_uncertain');return;}
          let after;
          try{
            after=captureReadOnlyFullStorageInventory();
            if(!stableMode()
              ||global.localStorage.getItem(snapshotKey)!==proposedRaw
              ||global.localStorage.getItem(cacheKey)!==sealed.text
              ||global.localStorage.getItem(authorityKey)!=='1'
              ||global.localStorage.getItem(dirtyKey)!=='1'
              ||withoutSnapshot(after)!==withoutSnapshot(before)){
              result=uncertain('snapshot_sync_readback_or_origin_changed');
              return;
            }
          }catch(_){
            result=uncertain('snapshot_sync_postwrite_unreadable');return;
          }
          const afterFence=await rehearsePreviewDurableWriterFence('audit');
          try{
            if(!stableMode()
              ||afterFence.reason!=='preview_writer_inventory_consistent'
              ||afterFence.fence?.generation!==generation
              ||afterFence.fence?.epoch!==fence.fence.epoch
              ||afterFence.fence?.frozen
              ||previewNotesWitnessObservedExternalChange(generation,epoch)
              ||captureReadOnlyFullStorageInventory()!==after){
              result=uncertain('snapshot_sync_postwrite_fence_changed');
              return;
            }
          }catch(_){
            result=uncertain('snapshot_sync_postwrite_fence_unreadable');
            return;
          }
          result=deny('preview_notes_snapshot_written_dirty_retained',{
            snapshotWriteAttempted:true,notesSnapshotSynchronized:true,
            dirtyMarkerPreserved:true,readbackVerified:true,
            cooperativeLockUsed:true,notesMultiKeySyncVerified:false,
            confirmedNotesDurable:false,oldTabsExcluded:false,
            safeToClearDirtyMarker:false,canPromote:false
          });
        });
    }catch(_){return uncertain('snapshot_sync_lock_request_failed');}
    return result;
  }


  // Read-only final Notes snapshot/dirty-marker audit on a disposable
  // preview origin. An observed sync is NOT permission to clear dirty:
  // old deployed V1 tabs do not participate in the cooperative lock.
  // Check intent, live V1 selection, both data locations and generation
  // across two durable-fence inspections; never write or return Notes text.
  async function inspectPreviewNotesSnapshotCompletionEvidence(
    expectedInventoryToken,actionId) {
    const deny=(reason,detail={})=>({
      checked:true,previewOnly:true,readOnly:true,
      completionPointInTimeVerified:false,
      snapshotAndCacheMatchIntent:false,
      dirtyMarkerRetained:false,
      externalStorageEventsObserved:false,
      missedStorageEventsRuledOut:false,
      oldTabsExcluded:false,productionWritersFenced:false,
      canAutomaticallyResume:false,safeToClearDirtyMarker:false,
      safeToRestore:false,notesMultiKeySyncVerified:false,
      confirmedNotesDurable:false,canPromote:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if(!isWalTestPreviewHost())return deny('preview_host_required');
    if(!isDarkEnabled())return deny('dark_disabled');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken)
      return deny('full_origin_token_required');
    if(typeof actionId!=='string'
      ||!/^[a-zA-Z0-9_:.-]{1,96}$/.test(actionId))
      return deny('notes_completion_action_id_invalid');
    const locks=global.navigator?.locks;
    if(typeof locks?.request!=='function')
      return deny('lock_manager_unavailable');
    const generation=currentGeneration({create:false});
    if(!generation)return deny('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const stableMode=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&currentGeneration({create:false})===generation
      &&darkMirrorModeEpoch===epoch;
    const eventCount=()=>{
      const witness=previewLegacyStorageEventWitness;
      if(!witness)return {active:false,unsafe:false,count:0};
      return {active:true,
        unsafe:witness.invalidated||witness.generation!==generation
          ||witness.epoch!==epoch||witness.totalEvents>0,
        count:witness.totalEvents};
    };
    let result=deny('notes_completion_lock_unavailable');
    try{
      await locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        {mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock){
            result=deny('notes_completion_lock_held_elsewhere');return;
          }
          let before;
          try{
            before=captureReadOnlyFullStorageInventory();
            if(!stableMode()||before!==expectedInventoryToken){
              result=deny('notes_completion_origin_changed');return;
            }
          }catch(_){result=deny('notes_completion_origin_unreadable');return;}
          const startWitness=eventCount();
          if(startWitness.unsafe){
            result=deny('notes_completion_external_storage_event_observed',{
              externalStorageEventsObserved:true});return;
          }
          const fence=await rehearsePreviewDurableWriterFence('audit');
          if(!stableMode()
            ||fence.reason!=='preview_writer_inventory_consistent'
            ||fence.fence?.generation!==generation
            ||fence.fence?.frozen){
            result=deny('notes_completion_fence_unverified_or_frozen');
            return;
          }
          const proof=await inspectPreviewNotesFirstEditIntent();
          if(!proof.intentEvidenceVerified){
            result=deny('notes_completion_intent_unverified',{
              prerequisiteReason:proof.reason});return;
          }
          let intentRaw,cache,dirty,authority,snapshotNotes;
          try{
            intentRaw=global.localStorage.getItem(
              PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY);
            const sealed=JSON.parse(intentRaw);
            if(!sealed||sealed.actionId!==actionId
              ||sealed.resetGeneration!==generation
              ||typeof sealed.text!=='string')
              throw Error('intent_wrong_action');
            const {integrityFingerprint,...record}=sealed;
            if(await previewRecoveryFingerprint(record)!==integrityFingerprint)
              throw Error('intent_integrity_mismatch');
            cache=global.localStorage.getItem('taskpoints_notes_v1');
            dirty=global.localStorage.getItem('taskpoints_notes_dirty_v1');
            authority=global.localStorage.getItem(
              'taskpoints_notes_authoritative_v1');
            const raw=global.localStorage.getItem(
              core.STORAGE_KEY||'taskpoints_v1');
            const state=core.parseTaskPointsStorageJson(raw);
            if(!state||typeof state!=='object'||Array.isArray(state)
              ||(state.notes!==undefined&&typeof state.notes!=='string'))
              throw Error('snapshot_unreadable');
            snapshotNotes=state.notes||'';
            if(captureReadOnlyFullStorageInventory()!==before
              ||global.localStorage.getItem(
                PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY)!==intentRaw)
              throw Error('source_changed_during_audit');
            if(!proof.notesCacheMatchesIntent
              ||!proof.snapshotMatchesIntent
              ||!proof.legacySelectsIntendedText
              ||proof.observedRecoveryStage!=='snapshot_synced_dirty_pending'
              ||cache!==sealed.text||snapshotNotes!==sealed.text
              ||dirty!=='1'||authority!=='1'){
              result=deny('notes_completion_not_synchronized',{
                observedRecoveryStage:proof.observedRecoveryStage,
                dirtyMarkerRetained:dirty==='1',
                snapshotAndCacheMatchIntent:cache===sealed.text
                  &&snapshotNotes===sealed.text});
              return;
            }
          }catch(_){
            result=deny('notes_completion_evidence_unreadable_or_invalid');
            return;
          }
          const afterFence=await rehearsePreviewDurableWriterFence('audit');
          let endWitness;
          try{
            endWitness=eventCount();
            if(!stableMode()
              ||afterFence.reason!=='preview_writer_inventory_consistent'
              ||afterFence.fence?.generation!==generation
              ||afterFence.fence?.epoch!==fence.fence.epoch
              ||afterFence.fence?.frozen
              ||captureReadOnlyFullStorageInventory()!==before
              ||global.localStorage.getItem(
                PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY)!==intentRaw
              ||endWitness.unsafe
              ||endWitness.active!==startWitness.active){
              result=deny('notes_completion_fence_origin_or_witness_changed',{
                externalStorageEventsObserved:endWitness.unsafe,
                dirtyMarkerRetained:true});
              return;
            }
          }catch(_){
            result=deny('notes_completion_postaudit_unreadable');return;
          }
          result=deny('notes_snapshot_completion_point_in_time_observed',{
            completionPointInTimeVerified:true,
            snapshotAndCacheMatchIntent:true,
            dirtyMarkerRetained:true,
            cooperativeLockUsed:true,
            storageEventWitnessActive:endWitness.active,
            observedRecoveryStage:'snapshot_synced_dirty_pending',
            // This is only a point-in-time observation; old tabs and
            // unobserved storage events remain possible.
            missedStorageEventsRuledOut:false,oldTabsExcluded:false,
            safeToClearDirtyMarker:false,canPromote:false
          });
        });
    }catch(_){return deny('notes_completion_lock_request_failed');}
    return result;
  }



  // One additional, sealed Notes editing action after the *first* preview
  // Notes snapshot is synchronized. The source first-edit evidence remains
  // untouched. Repeated edits are not allowed to silently replace a pending
  // action or rely on an unversioned cache value for recovery.
  const PREVIEW_NOTES_FOLLOWUP_INTENT_KEY =
    'taskpoints_v2_preview_notes_followup_intent_v1';
  async function rehearsePreviewNotesFollowupIntent(
    text,expectedInventoryToken,actionId) {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,followupIntentOnly:true,
      intentRecorded:false,writeOutcomeUncertain:false,
      inspectIntentBeforeRetry:false,notesFullySynchronized:false,
      confirmedNotesDurable:false,notesMultiKeySyncVerified:false,
      safeToClearDirtyMarker:false,oldTabsExcluded:false,
      safeToRestore:false,productionWritersFenced:false,canPromote:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken)
      return refuse('full_origin_token_required');
    if(typeof actionId!=='string'
      ||!/^[a-zA-Z0-9_:.\-]{1,96}$/.test(actionId))
      return refuse('followup_action_id_invalid');
    if(typeof text!=='string'||text.length>PREVIEW_NOTES_FIRST_EDIT_LIMIT
      ||typeof global.TextEncoder!=='function'
      ||new global.TextEncoder().encode(text).byteLength>
        PREVIEW_NOTES_FIRST_EDIT_LIMIT)
      return refuse('followup_text_invalid_or_oversized');
    const locks=global.navigator?.locks;
    if(typeof locks?.request!=='function')
      return refuse('lock_manager_unavailable');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const stableMode=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&currentGeneration({create:false})===generation
      &&darkMirrorModeEpoch===epoch;
    let attempted=false,result=refuse('followup_intent_lock_unavailable');
    try{
      await locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        {mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock){result=refuse('followup_intent_lock_held_elsewhere');return;}
          let before,rawSnapshot,rawCache,firstActionId;
          try{
            before=captureReadOnlyFullStorageInventory();
            if(!stableMode()||before!==expectedInventoryToken){
              result=refuse('followup_origin_changed');return;
            }
            if(global.localStorage.getItem(
              PREVIEW_NOTES_FOLLOWUP_INTENT_KEY)!==null){
              result=refuse('existing_followup_intent_requires_inspection');
              return;
            }
            rawSnapshot=global.localStorage.getItem(
              core.STORAGE_KEY||'taskpoints_v1');
            rawCache=global.localStorage.getItem('taskpoints_notes_v1');
            const first=global.localStorage.getItem(
              PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY);
            firstActionId=JSON.parse(first).actionId;
            if(typeof firstActionId!=='string'
              ||!rawSnapshot||rawCache===null
              ||global.localStorage.getItem(
                'taskpoints_notes_authoritative_v1')!=='1'
              ||global.localStorage.getItem('taskpoints_notes_dirty_v1')!=='1')
              throw Error('followup_source_invalid');
          }catch(_){
            result=refuse('followup_source_unreadable_or_incompatible');return;
          }
          const fence=await rehearsePreviewDurableWriterFence('audit');
          if(!stableMode()||fence.reason!=='preview_writer_inventory_consistent'
            ||fence.fence?.generation!==generation||fence.fence?.frozen){
            result=refuse('followup_fence_unverified_or_frozen');return;
          }
          const original=await inspectPreviewNotesFirstEditIntent();
          if(!original.intentEvidenceVerified
            ||!original.notesCacheMatchesIntent
            ||!original.snapshotMatchesIntent
            ||!original.legacySelectsIntendedText
            ||original.observedRecoveryStage!=='snapshot_synced_dirty_pending'){
            result=refuse('followup_first_edit_not_synchronized');return;
          }
          if(rawCache===text){
            result=refuse('followup_text_unchanged');return;
          }
          let sealed;
          try{
            const state=core.parseTaskPointsStorageJson(rawSnapshot);
            if(!state||typeof state!=='object'||Array.isArray(state)
              ||typeof state.notes!=='string'||state.notes!==rawCache)
              throw Error('followup_snapshot_cache_diverged');
            const signed={
              id:'notes-followup-intent',schemaVersion:1,
              actionId,firstActionId,resetGeneration:generation,
              originFingerprint:await previewRecoveryFingerprint(before),
              snapshotFingerprint:await previewRecoveryFingerprint(rawSnapshot),
              cacheFingerprint:await previewRecoveryFingerprint(rawCache),text
            };
            sealed=JSON.stringify({...signed,
              integrityFingerprint:await previewRecoveryFingerprint(signed)});
            if(new global.TextEncoder().encode(sealed).byteLength>
              PREVIEW_NOTES_FIRST_EDIT_LIMIT)
              throw Error('followup_intent_oversized');
            if(!stableMode()
              ||previewNotesWitnessObservedExternalChange(generation,epoch)
              ||captureReadOnlyFullStorageInventory()!==before){
              result=refuse('followup_source_changed_or_event_observed');
              return;
            }
          }catch(_){
            result=refuse('followup_intent_seal_unavailable');return;
          }
          attempted=true;
          try{
            global.localStorage.setItem(
              PREVIEW_NOTES_FOLLOWUP_INTENT_KEY,sealed);
            if(global.localStorage.getItem(
              PREVIEW_NOTES_FOLLOWUP_INTENT_KEY)!==sealed)
              throw Error('followup_readback_mismatch');
            const after=captureReadOnlyFullStorageInventory();
            if(stableJson(JSON.parse(after).filter(
              row=>Array.isArray(row)&&row[0]!==
                PREVIEW_NOTES_FOLLOWUP_INTENT_KEY))!==before)
              throw Error('followup_other_origin_changed');
            const finalFence=await rehearsePreviewDurableWriterFence('audit');
            if(!stableMode()
              ||finalFence.reason!=='preview_writer_inventory_consistent'
              ||finalFence.fence?.generation!==generation
              ||finalFence.fence?.epoch!==fence.fence.epoch
              ||finalFence.fence?.frozen
              ||previewNotesWitnessObservedExternalChange(generation,epoch)
              ||captureReadOnlyFullStorageInventory()!==after)
              throw Error('followup_postwrite_origin_changed');
          }catch(_){
            result=refuse('followup_intent_write_uncertain',{
              writeOutcomeUncertain:true,inspectIntentBeforeRetry:true});
            return;
          }
          result=refuse('preview_notes_followup_intent_recorded',{
            intentRecorded:true,readbackVerified:true,
            cooperativeLockUsed:true});
        });
    }catch(_){
      return refuse('followup_intent_lock_request_failed',{
        writeOutcomeUncertain:attempted,inspectIntentBeforeRetry:attempted});
    }
    return result;
  }

  // Guarded SECOND Notes cache write. One synchronous key update. The
  // cache is already dirty and authoritative, so interruption leaves the
  // new content selectable by V1. Do not update or delete either intent.
  async function rehearsePreviewAdmittedNotesFollowupCacheWrite(
    expectedInventoryToken,actionId) {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,followupCacheOnly:true,
      cacheWriteAttempted:false,cacheReadbackVerified:false,
      writeOutcomeUncertain:false,inspectIntentBeforeRetry:false,
      dirtyMarkerPreserved:false,notesMultiKeySyncVerified:false,
      confirmedNotesDurable:false,oldTabsExcluded:false,
      productionWritersFenced:false,safeToClearDirtyMarker:false,
      safeToRestore:false,canPromote:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken)
      return refuse('full_origin_token_required');
    if(typeof actionId!=='string'
      ||!/^[a-zA-Z0-9_:.\-]{1,96}$/.test(actionId))
      return refuse('followup_action_id_invalid');
    const locks=global.navigator?.locks;
    if(typeof locks?.request!=='function')
      return refuse('lock_manager_unavailable');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const cacheKey='taskpoints_notes_v1';
    let attempted=false,result=refuse('followup_cache_lock_unavailable');
    const stableMode=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&currentGeneration({create:false})===generation
      &&darkMirrorModeEpoch===epoch;
    const withoutCache=token=>stableJson(JSON.parse(token)
      .filter(row=>Array.isArray(row)&&row[0]!==cacheKey));
    try{
      await locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        {mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock){result=refuse('followup_cache_lock_held_elsewhere');return;}
          let before,rawIntent,signed,cacheRaw,snapshotRaw;
          try{
            before=captureReadOnlyFullStorageInventory();
            if(!stableMode()||before!==expectedInventoryToken){
              result=refuse('followup_cache_origin_changed');return;
            }
            rawIntent=global.localStorage.getItem(
              PREVIEW_NOTES_FOLLOWUP_INTENT_KEY);
            signed=JSON.parse(rawIntent);
            if(!signed||signed.id!=='notes-followup-intent'
              ||signed.schemaVersion!==1
              ||Object.keys(signed).length!==10
              ||signed.actionId!==actionId
              ||signed.resetGeneration!==generation
              ||typeof signed.text!=='string'
              ||signed.text.length>PREVIEW_NOTES_FIRST_EDIT_LIMIT)
              throw Error('followup_intent_invalid');
            const {integrityFingerprint,...record}=signed;
            if(await previewRecoveryFingerprint(record)!==integrityFingerprint)
              throw Error('followup_intent_integrity');
            const baseToken=stableJson(JSON.parse(before).filter(
              row=>Array.isArray(row)&&row[0]!==
                PREVIEW_NOTES_FOLLOWUP_INTENT_KEY));
            if(await previewRecoveryFingerprint(baseToken)!==
              signed.originFingerprint){
              result=refuse('followup_original_origin_changed');return;
            }
            cacheRaw=global.localStorage.getItem(cacheKey);
            snapshotRaw=global.localStorage.getItem(
              core.STORAGE_KEY||'taskpoints_v1');
            if(cacheRaw===null||!snapshotRaw
              ||await previewRecoveryFingerprint(cacheRaw)!==
                signed.cacheFingerprint
              ||await previewRecoveryFingerprint(snapshotRaw)!==
                signed.snapshotFingerprint
              ||global.localStorage.getItem('taskpoints_notes_dirty_v1')!=='1'
              ||global.localStorage.getItem(
                'taskpoints_notes_authoritative_v1')!=='1'
              ||cacheRaw===signed.text)
              throw Error('followup_source_not_at_admission');
          }catch(_){
            result=refuse('followup_cache_intent_or_source_invalid');return;
          }
          const fence=await rehearsePreviewDurableWriterFence('audit');
          if(!stableMode()||fence.reason!=='preview_writer_inventory_consistent'
            ||fence.fence?.generation!==generation||fence.fence?.frozen){
            result=refuse('followup_cache_fence_unverified_or_frozen');
            return;
          }
          try{
            const state=core.parseTaskPointsStorageJson(snapshotRaw);
            if(!state||typeof state!=='object'||Array.isArray(state)
              ||state.notes!==cacheRaw
              ||previewNotesWitnessObservedExternalChange(generation,epoch)
              ||captureReadOnlyFullStorageInventory()!==before
              ||global.localStorage.getItem(
                PREVIEW_NOTES_FOLLOWUP_INTENT_KEY)!==rawIntent){
              result=refuse('followup_cache_source_changed_before_write');
              return;
            }
          }catch(_){
            result=refuse('followup_cache_source_unreadable');return;
          }
          attempted=true;
          try{global.localStorage.setItem(cacheKey,signed.text);}
          catch(_){
            result=refuse('followup_cache_write_uncertain',{
              cacheWriteAttempted:true,writeOutcomeUncertain:true,
              inspectIntentBeforeRetry:true});
            return;
          }
          let after;
          try{
            after=captureReadOnlyFullStorageInventory();
            if(!stableMode()
              ||global.localStorage.getItem(cacheKey)!==signed.text
              ||global.localStorage.getItem('taskpoints_notes_dirty_v1')!=='1'
              ||global.localStorage.getItem(
                'taskpoints_notes_authoritative_v1')!=='1'
              ||withoutCache(after)!==withoutCache(before)){
              result=refuse('followup_cache_readback_or_origin_changed',{
                cacheWriteAttempted:true,writeOutcomeUncertain:true,
                inspectIntentBeforeRetry:true});
              return;
            }
          }catch(_){
            result=refuse('followup_cache_readback_unavailable',{
              cacheWriteAttempted:true,writeOutcomeUncertain:true,
              inspectIntentBeforeRetry:true});
            return;
          }
          const finalFence=await rehearsePreviewDurableWriterFence('audit');
          try{
            if(!stableMode()
              ||finalFence.reason!=='preview_writer_inventory_consistent'
              ||finalFence.fence?.generation!==generation
              ||finalFence.fence?.epoch!==fence.fence.epoch
              ||finalFence.fence?.frozen
              ||previewNotesWitnessObservedExternalChange(generation,epoch)
              ||captureReadOnlyFullStorageInventory()!==after){
              result=refuse('followup_cache_postwrite_evidence_changed',{
                cacheWriteAttempted:true,writeOutcomeUncertain:true,
                inspectIntentBeforeRetry:true});
              return;
            }
          }catch(_){
            result=refuse('followup_cache_postaudit_unavailable',{
              cacheWriteAttempted:true,writeOutcomeUncertain:true,
              inspectIntentBeforeRetry:true});
            return;
          }
          result=refuse('preview_notes_followup_cache_written_dirty_retained',{
            cacheWriteAttempted:true,cacheReadbackVerified:true,
            dirtyMarkerPreserved:true,cooperativeLockUsed:true,
            // No proof the V1 snapshot has been updated yet.
            notesMultiKeySyncVerified:false,confirmedNotesDurable:false,
            safeToClearDirtyMarker:false,canPromote:false
          });
        });
    }catch(_){
      return refuse('followup_cache_lock_request_failed',{
        cacheWriteAttempted:attempted,writeOutcomeUncertain:attempted,
        inspectIntentBeforeRetry:attempted});
    }
    return result;
  }

  // Explicit second-edit snapshot continuation. Cache has already been
  // written and remains dirty + authoritative. This writes only V1 Notes.
  // Reconstruct the signed original inventory using the intact first
  // intent's text, so a newly captured token CANNOT bless older-tab edits
  // to unrelated Tasks, Projects or Habits since admission.
  async function rehearsePreviewAdmittedNotesFollowupSnapshotSync(
    expectedInventoryToken,actionId) {
    const deny=(reason,detail={})=>({
      checked:true,previewOnly:true,followupSnapshotOnly:true,
      snapshotWriteAttempted:false,notesSnapshotSynchronized:false,
      writeOutcomeUncertain:false,inspectIntentBeforeRetry:false,
      dirtyMarkerPreserved:false,notesMultiKeySyncVerified:false,
      confirmedNotesDurable:false,oldTabsExcluded:false,
      productionWritersFenced:false,safeToClearDirtyMarker:false,
      safeToRestore:false,canPromote:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if(!isWalTestPreviewHost())return deny('preview_host_required');
    if(!isDarkEnabled())return deny('dark_disabled');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken)
      return deny('full_origin_token_required');
    if(typeof actionId!=='string'
      ||!/^[a-zA-Z0-9_:.\-]{1,96}$/.test(actionId))
      return deny('followup_action_id_invalid');
    const locks=global.navigator?.locks;
    if(typeof locks?.request!=='function')
      return deny('lock_manager_unavailable');
    const generation=currentGeneration({create:false});
    if(!generation)return deny('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const cacheKey='taskpoints_notes_v1';
    const snapshotKey=core.STORAGE_KEY||'taskpoints_v1';
    const stableMode=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&currentGeneration({create:false})===generation
      &&darkMirrorModeEpoch===epoch;
    const withoutSnapshot=token=>stableJson(JSON.parse(token)
      .filter(row=>Array.isArray(row)&&row[0]!==snapshotKey));
    let attempted=false,result=deny('followup_snapshot_lock_unavailable');
    try{
      await locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        {mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock){result=deny('followup_snapshot_lock_held_elsewhere');return;}
          let before,rawIntent,sealed,firstRaw,first,
            snapshotRaw,proposedRaw;
          try{
            before=captureReadOnlyFullStorageInventory();
            if(!stableMode()||before!==expectedInventoryToken){
              result=deny('followup_snapshot_origin_changed');return;
            }
            rawIntent=global.localStorage.getItem(
              PREVIEW_NOTES_FOLLOWUP_INTENT_KEY);
            sealed=JSON.parse(rawIntent);
            firstRaw=global.localStorage.getItem(
              PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY);
            first=JSON.parse(firstRaw);
            if(!sealed||sealed.id!=='notes-followup-intent'
              ||sealed.schemaVersion!==1
              ||Object.keys(sealed).length!==10
              ||sealed.actionId!==actionId
              ||sealed.resetGeneration!==generation
              ||typeof sealed.text!=='string'
              ||sealed.text.length>PREVIEW_NOTES_FIRST_EDIT_LIMIT
              ||!first||first.actionId!==sealed.firstActionId
              ||typeof first.text!=='string')
              throw Error('followup_intents_invalid');
            const {integrityFingerprint,...signed}=sealed;
            const {integrityFingerprint:firstDigest,...firstSigned}=first;
            if(await previewRecoveryFingerprint(signed)!==integrityFingerprint
              ||await previewRecoveryFingerprint(firstSigned)!==firstDigest)
              throw Error('followup_intent_digest_invalid');
            // The follow-up cache is the ONLY key permitted to change
            // after the follow-up intent was admitted.
            const reconstructed=stableJson(JSON.parse(before)
              .filter(row=>Array.isArray(row)
                &&row[0]!==PREVIEW_NOTES_FOLLOWUP_INTENT_KEY)
              .map(row=>row[0]===cacheKey?[cacheKey,first.text]:row));
            if(await previewRecoveryFingerprint(reconstructed)!==
              sealed.originFingerprint){
              result=deny('followup_snapshot_original_origin_changed');
              return;
            }
            snapshotRaw=global.localStorage.getItem(snapshotKey);
            if(!snapshotRaw
              ||await previewRecoveryFingerprint(snapshotRaw)!==
                sealed.snapshotFingerprint
              ||global.localStorage.getItem(cacheKey)!==sealed.text
              ||global.localStorage.getItem('taskpoints_notes_dirty_v1')!=='1'
              ||global.localStorage.getItem(
                'taskpoints_notes_authoritative_v1')!=='1'){
              result=deny('followup_snapshot_source_diverged');
              return;
            }
          }catch(_){
            result=deny('followup_snapshot_intent_or_source_invalid');
            return;
          }
          const fence=await rehearsePreviewDurableWriterFence('audit');
          if(!stableMode()||fence.reason!=='preview_writer_inventory_consistent'
            ||fence.fence?.generation!==generation||fence.fence?.frozen){
            result=deny('followup_snapshot_fence_unverified_or_frozen');
            return;
          }
          const evidence=await inspectPreviewNotesFollowupIntent();
          if(!evidence.intentEvidenceVerified
            ||!evidence.cacheMatchesIntent
            ||!evidence.legacySelectsIntendedText
            ||evidence.observedRecoveryStage!==
              'followup_cache_written_snapshot_pending'){
            result=deny('followup_snapshot_cache_stage_unverified');
            return;
          }
          try{
            const source=JSON.parse(snapshotRaw);
            if(!source||typeof source!=='object'||Array.isArray(source)
              ||typeof source.notes!=='string'
              ||source.notes!==first.text)
              throw Error('followup_source_state_incompatible');
            if(JSON.stringify(source)!==snapshotRaw){
              result=deny('followup_snapshot_noncanonical_legacy_json');
              return;
            }
            if(typeof core.parseTaskPointsStorageJson!=='function'
              ||stableJson(core.parseTaskPointsStorageJson(snapshotRaw))
                !==stableJson(source))
              throw Error('followup_codec_incompatible');
            const next={...source,notes:sealed.text};
            proposedRaw=JSON.stringify(next);
            if(stableJson(core.parseTaskPointsStorageJson(proposedRaw))
              !==stableJson(next))
              throw Error('followup_codec_roundtrip_mismatch');
            if(!stableMode()
              ||previewNotesWitnessObservedExternalChange(generation,epoch)
              ||captureReadOnlyFullStorageInventory()!==before
              ||global.localStorage.getItem(
                PREVIEW_NOTES_FOLLOWUP_INTENT_KEY)!==rawIntent
              ||global.localStorage.getItem(
                PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY)!==firstRaw){
              result=deny('followup_snapshot_origin_or_witness_changed');
              return;
            }
          }catch(_){
            result=deny('followup_snapshot_codec_or_source_invalid');
            return;
          }
          attempted=true;
          try{global.localStorage.setItem(snapshotKey,proposedRaw);}
          catch(_){
            result=deny('followup_snapshot_write_uncertain',{
              snapshotWriteAttempted:true,writeOutcomeUncertain:true,
              inspectIntentBeforeRetry:true});
            return;
          }
          let after;
          try{
            after=captureReadOnlyFullStorageInventory();
            if(!stableMode()
              ||global.localStorage.getItem(snapshotKey)!==proposedRaw
              ||global.localStorage.getItem(cacheKey)!==sealed.text
              ||global.localStorage.getItem(
                'taskpoints_notes_dirty_v1')!=='1'
              ||global.localStorage.getItem(
                'taskpoints_notes_authoritative_v1')!=='1'
              ||withoutSnapshot(after)!==withoutSnapshot(before)){
              result=deny('followup_snapshot_readback_or_origin_changed',{
                snapshotWriteAttempted:true,writeOutcomeUncertain:true,
                inspectIntentBeforeRetry:true});
              return;
            }
          }catch(_){
            result=deny('followup_snapshot_readback_unavailable',{
              snapshotWriteAttempted:true,writeOutcomeUncertain:true,
              inspectIntentBeforeRetry:true});
            return;
          }
          const finalFence=await rehearsePreviewDurableWriterFence('audit');
          try{
            if(!stableMode()
              ||finalFence.reason!=='preview_writer_inventory_consistent'
              ||finalFence.fence?.generation!==generation
              ||finalFence.fence?.epoch!==fence.fence.epoch
              ||finalFence.fence?.frozen
              ||previewNotesWitnessObservedExternalChange(generation,epoch)
              ||captureReadOnlyFullStorageInventory()!==after){
              result=deny('followup_snapshot_postwrite_evidence_changed',{
                snapshotWriteAttempted:true,writeOutcomeUncertain:true,
                inspectIntentBeforeRetry:true});
              return;
            }
          }catch(_){
            result=deny('followup_snapshot_postaudit_unavailable',{
              snapshotWriteAttempted:true,writeOutcomeUncertain:true,
              inspectIntentBeforeRetry:true});
            return;
          }
          result=deny('preview_notes_followup_snapshot_written_dirty_retained',{
            snapshotWriteAttempted:true,notesSnapshotSynchronized:true,
            readbackVerified:true,dirtyMarkerPreserved:true,
            cooperativeLockUsed:true,safeToClearDirtyMarker:false,
            confirmedNotesDurable:false,canPromote:false
          });
        });
    }catch(_){
      return deny('followup_snapshot_lock_request_failed',{
        snapshotWriteAttempted:attempted,writeOutcomeUncertain:attempted,
        inspectIntentBeforeRetry:attempted});
    }
    return result;
  }

  // Read-only diagnosis of the follow-up cache stage, surviving reload.
  // Never apply saved text or replace an earlier first-edit intent.
  async function inspectPreviewNotesFollowupIntent(){
    const deny=(reason,detail={})=>({
      checked:true,previewOnly:true,readOnly:true,
      intentEvidenceVerified:false,cacheMatchesIntent:false,
      snapshotMatchesIntent:false,legacySelectsIntendedText:false,
      safeToApply:false,safeToRestore:false,
      safeToClearDirtyMarker:false,oldTabsExcluded:false,
      notesMultiKeySyncVerified:false,confirmedNotesDurable:false,
      canPromote:false,readAuthority:'legacy_only',
      mutationAuthority:'legacy_only',reason,...detail
    });
    if(!isWalTestPreviewHost())return deny('preview_host_required');
    if(!isDarkEnabled())return deny('dark_disabled');
    const generation=currentGeneration({create:false});
    if(!generation)return deny('generation_unavailable');
    try{
      const before=captureReadOnlyFullStorageInventory();
      const raw=global.localStorage.getItem(
        PREVIEW_NOTES_FOLLOWUP_INTENT_KEY);
      if(raw===null)return deny('followup_intent_absent');
      const signed=JSON.parse(raw);
      if(!signed||signed.id!=='notes-followup-intent'
        ||signed.schemaVersion!==1
        ||Object.keys(signed).length!==10
        ||typeof signed.actionId!=='string'
        ||typeof signed.firstActionId!=='string'
        ||typeof signed.text!=='string'
        ||signed.text.length>PREVIEW_NOTES_FIRST_EDIT_LIMIT)
        return deny('followup_intent_invalid');
      const {integrityFingerprint,...record}=signed;
      if(await previewRecoveryFingerprint(record)!==integrityFingerprint)
        return deny('followup_intent_integrity_mismatch');
      if(signed.resetGeneration!==generation)
        return deny('followup_intent_generation_changed');
      const first=await inspectPreviewNotesFirstEditIntent();
      if(!first.intentEvidenceVerified)
        return deny('followup_first_intent_unverified');
      const firstRaw=global.localStorage.getItem(
        PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY);
      if(JSON.parse(firstRaw).actionId!==signed.firstActionId)
        return deny('followup_first_action_mismatch');
      const cache=global.localStorage.getItem('taskpoints_notes_v1');
      const dirty=global.localStorage.getItem('taskpoints_notes_dirty_v1');
      const authority=global.localStorage.getItem(
        'taskpoints_notes_authoritative_v1');
      const snapshotRaw=global.localStorage.getItem(
        core.STORAGE_KEY||'taskpoints_v1');
      const snapshot=core.parseTaskPointsStorageJson(snapshotRaw);
      if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)
        ||typeof snapshot.notes!=='string')
        return deny('followup_snapshot_invalid');
      const cacheMatches=cache===signed.text;
      const snapshotMatches=snapshot.notes===signed.text;
      // Never label a snapshot as "dirty pending" when the actual
      // recovery marker or cache authority has disappeared.
      const markersIntact=dirty==='1'&&authority==='1';
      const stage=!markersIntact?'followup_recovery_markers_missing'
        :cacheMatches
          ?snapshotMatches?'followup_snapshot_synced_dirty_pending'
            :'followup_cache_written_snapshot_pending'
          :'followup_intent_recorded_cache_pending';
      if(!isWalTestPreviewHost()||!isDarkEnabled()
        ||currentGeneration({create:false})!==generation
        ||captureReadOnlyFullStorageInventory()!==before
        ||global.localStorage.getItem(
          PREVIEW_NOTES_FOLLOWUP_INTENT_KEY)!==raw)
        return deny('followup_intent_origin_changed_during_inspection');
      return {...deny('preview_notes_followup_intent_verified'),
        intentEvidenceVerified:true,
        cacheMatchesIntent:cacheMatches,
        snapshotMatchesIntent:snapshotMatches,
        legacySelectsIntendedText:cacheMatches&&dirty==='1'
          &&authority==='1',
        currentMarkersValid:dirty==='1'&&authority==='1',
        observedRecoveryStage:stage,
        savedLength:signed.text.length
      };
    }catch(_){return deny('followup_intent_evidence_unavailable');}
  }


  // Bounded append-only *preview* Notes edit journal. The first two
  // separately signed intents are preserved. This journal can admit several
  // additional strictly sequential edits without discarding recovery data.
  // All three writers below are opt-in and NEVER called by live Notes UI.
  const PREVIEW_NOTES_REPEAT_JOURNAL_KEY =
    'taskpoints_v2_preview_notes_repeat_journal_v1';
  const PREVIEW_NOTES_REPEAT_LIMIT=16;
  const PREVIEW_NOTES_REPEAT_MAX_BYTES=262144;
  const previewNotesRepeatDeny=(reason,details={})=>({
    checked:true,previewOnly:true,repeatNotesOnly:true,
    intentRecorded:false,cacheReadbackVerified:false,
    notesSnapshotSynchronized:false,writeAttempted:false,
    writeOutcomeUncertain:false,inspectIntentBeforeRetry:false,
    safeToClearDirtyMarker:false,notesMultiKeySyncVerified:false,
    confirmedNotesDurable:false,oldTabsExcluded:false,
    productionWritersFenced:false,safeToRestore:false,
    canAutomaticallyResume:false,canPromote:false,
    readAuthority:'legacy_only',mutationAuthority:'legacy_only',
    reason,...details
  });
  function previewNotesRepeatOriginWithoutJournal(token,cacheOverride) {
    const entries=JSON.parse(token);
    if(!Array.isArray(entries))throw Error('origin_inventory_invalid');
    const rows=entries.filter(row=>Array.isArray(row)
      &&row.length===2
      &&row[0]!==PREVIEW_NOTES_REPEAT_JOURNAL_KEY)
      .map(row=>cacheOverride!==undefined
        &&row[0]==='taskpoints_notes_v1'
        ?[row[0],cacheOverride]:row);
    return stableJson(rows);
  }
  async function readPreviewNotesRepeatJournal(generation){
    const raw=global.localStorage.getItem(
      PREVIEW_NOTES_REPEAT_JOURNAL_KEY);
    if(raw===null)return {raw:null,journal:null,last:null};
    if(typeof raw!=='string'
      ||new global.TextEncoder().encode(raw).byteLength>
        PREVIEW_NOTES_REPEAT_MAX_BYTES)
      throw Error('repeat_journal_oversized');
    const record=JSON.parse(raw);
    if(!record||typeof record!=='object'||Array.isArray(record)
      ||Object.keys(record).length!==7
      ||record.id!=='notes-repeat-journal'
      ||record.schemaVersion!==1
      ||record.resetGeneration!==generation
      ||typeof record.firstActionId!=='string'
      ||typeof record.followupActionId!=='string'
      ||!Array.isArray(record.entries)
      ||record.entries.length<1
      ||record.entries.length>PREVIEW_NOTES_REPEAT_LIMIT)
      throw Error('repeat_journal_schema_invalid');
    const {integrityFingerprint,...signed}=record;
    if(await previewRecoveryFingerprint(signed)!==integrityFingerprint)
      throw Error('repeat_journal_integrity_mismatch');
    const first=JSON.parse(global.localStorage.getItem(
      PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY));
    const second=JSON.parse(global.localStorage.getItem(
      PREVIEW_NOTES_FOLLOWUP_INTENT_KEY));
    const {integrityFingerprint:firstHash,...firstFields}=first;
    const {integrityFingerprint:secondHash,...secondFields}=second;
    if(await previewRecoveryFingerprint(firstFields)!==firstHash
      ||await previewRecoveryFingerprint(secondFields)!==secondHash
      ||first.actionId!==record.firstActionId
      ||second.actionId!==record.followupActionId
      ||second.firstActionId!==first.actionId)
      throw Error('repeat_journal_ancestor_intents_invalid');
    const unique=new Set([record.firstActionId,record.followupActionId]);
    let prior=record.followupActionId;
    let priorText=second.text;
    for(const item of record.entries){
      if(!item||typeof item!=='object'||Array.isArray(item)
        ||Object.keys(item).length!==7
        ||typeof item.actionId!=='string'
        ||!/^[a-zA-Z0-9_:.\-]{1,96}$/.test(item.actionId)
        ||unique.has(item.actionId)
        ||item.previousActionId!==prior
        ||typeof item.previousText!=='string'
        ||item.previousText!==priorText
        ||typeof item.text!=='string'
        ||item.text.length>PREVIEW_NOTES_FIRST_EDIT_LIMIT
        ||item.previousText===item.text
        ||typeof item.sourceOriginFingerprint!=='string'
        ||typeof item.sourceSnapshotFingerprint!=='string'
        ||typeof item.sourceCacheFingerprint!=='string')
        throw Error('repeat_journal_action_invalid');
      for(const digest of [item.sourceOriginFingerprint,
        item.sourceSnapshotFingerprint,item.sourceCacheFingerprint]){
        if(!/^sha256:[a-f0-9]{64}:\d+$/.test(digest))
          throw Error('repeat_journal_action_digest_invalid');
      }
      // Even a correctly re-signed record must describe a coherent edit
      // history and a truthful cached starting value for each action.
      if(await previewRecoveryFingerprint(item.previousText)
          !==item.sourceCacheFingerprint)
        throw Error('repeat_journal_prior_cache_digest_mismatch');
      prior=item.actionId;priorText=item.text;unique.add(prior);
    }
    return {raw,journal:record,last:record.entries.at(-1)};
  }
  async function rehearsePreviewNotesRepeatEditIntent(
    text,expectedInventoryToken,actionId){
    const deny=previewNotesRepeatDeny;
    if(!isWalTestPreviewHost())return deny('preview_host_required');
    if(!isDarkEnabled())return deny('dark_disabled');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken)
      return deny('full_origin_token_required');
    if(typeof actionId!=='string'
      ||!/^[a-zA-Z0-9_:.\-]{1,96}$/.test(actionId))
      return deny('repeat_action_id_invalid');
    if(typeof text!=='string'
      ||text.length>PREVIEW_NOTES_FIRST_EDIT_LIMIT
      ||typeof global.TextEncoder!=='function'
      ||new global.TextEncoder().encode(text).byteLength>
        PREVIEW_NOTES_FIRST_EDIT_LIMIT)
      return deny('repeat_text_invalid_or_oversized');
    const locks=global.navigator?.locks;
    if(typeof locks?.request!=='function')
      return deny('lock_manager_unavailable');
    const generation=currentGeneration({create:false});
    if(!generation)return deny('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const stableMode=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&currentGeneration({create:false})===generation
      &&darkMirrorModeEpoch===epoch;
    let touched=false,result=deny('repeat_intent_lock_unavailable');
    try{
      await locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        {mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock){result=deny('repeat_intent_lock_held_elsewhere');return;}
          let before,previous,cache,rawSnapshot,ancestors;
          try{
            before=captureReadOnlyFullStorageInventory();
            if(!stableMode()||before!==expectedInventoryToken){
              result=deny('repeat_intent_origin_changed');return;
            }
            previous=await readPreviewNotesRepeatJournal(generation);
            if(previous.journal
              &&previous.journal.entries.length>=PREVIEW_NOTES_REPEAT_LIMIT){
              result=deny('repeat_journal_capacity_reached');return;
            }
            cache=global.localStorage.getItem('taskpoints_notes_v1');
            rawSnapshot=global.localStorage.getItem(
              core.STORAGE_KEY||'taskpoints_v1');
            if(cache===null||!rawSnapshot
              ||global.localStorage.getItem(
                'taskpoints_notes_authoritative_v1')!=='1'
              ||global.localStorage.getItem(
                'taskpoints_notes_dirty_v1')!=='1'){
              result=deny('repeat_intent_notes_markers_missing');return;
            }
            const state=core.parseTaskPointsStorageJson(rawSnapshot);
            if(!state||typeof state!=='object'||Array.isArray(state)
              ||state.notes!==cache){
              result=deny('repeat_intent_snapshot_cache_diverged');return;
            }
            if(previous.last){
              if(previous.last.text!==cache){
                result=deny('repeat_previous_edit_not_synchronized');return;
              }
              ancestors={firstActionId:previous.journal.firstActionId,
                followupActionId:previous.journal.followupActionId};
            }else{
              const original=await inspectPreviewNotesFollowupIntent();
              if(!original.intentEvidenceVerified
                ||original.observedRecoveryStage!==
                  'followup_snapshot_synced_dirty_pending'
                ||!original.legacySelectsIntendedText){
                result=deny('repeat_second_edit_not_synchronized');return;
              }
              const first=JSON.parse(global.localStorage.getItem(
                PREVIEW_NOTES_FIRST_EDIT_INTENT_KEY));
              const followup=JSON.parse(global.localStorage.getItem(
                PREVIEW_NOTES_FOLLOWUP_INTENT_KEY));
              if(!first||!followup
                ||followup.firstActionId!==first.actionId){
                result=deny('repeat_ancestor_actions_invalid');return;
              }
              ancestors={firstActionId:first.actionId,
                followupActionId:followup.actionId};
            }
            // A reused ID would make the newly sealed append-only journal
            // fail its own ancestry validation. Reject before touching it.
            if(actionId===ancestors.firstActionId
              ||actionId===ancestors.followupActionId
              ||(previous.journal?.entries||[]).some(
                item=>item.actionId===actionId)){
              result=deny('repeat_action_id_already_recorded');return;
            }
            if(cache===text){
              result=deny('repeat_text_unchanged');return;
            }
          }catch(_){
            result=deny('repeat_intent_source_unavailable_or_invalid');return;
          }
          const fence=await rehearsePreviewDurableWriterFence('audit');
          if(!stableMode()
            ||fence.reason!=='preview_writer_inventory_consistent'
            ||fence.fence?.generation!==generation||fence.fence?.frozen){
            result=deny('repeat_intent_fence_unverified_or_frozen');return;
          }
          let sealed;
          try{
            const action={
              actionId,
              previousActionId:previous.last?.actionId
                ||ancestors.followupActionId,
              previousText:cache,text,
              sourceOriginFingerprint:await previewRecoveryFingerprint(
                previewNotesRepeatOriginWithoutJournal(before)),
              sourceSnapshotFingerprint:await previewRecoveryFingerprint(
                rawSnapshot),
              sourceCacheFingerprint:await previewRecoveryFingerprint(cache)
            };
            const signed={id:'notes-repeat-journal',schemaVersion:1,
              resetGeneration:generation,...ancestors,
              entries:[...(previous.journal?.entries||[]),action]};
            sealed=JSON.stringify({...signed,
              integrityFingerprint:await previewRecoveryFingerprint(signed)});
            if(new global.TextEncoder().encode(sealed).byteLength>
                PREVIEW_NOTES_REPEAT_MAX_BYTES){
              result=deny('repeat_journal_size_limit_reached');return;
            }
            if(!stableMode()
              ||previewNotesWitnessObservedExternalChange(generation,epoch)
              ||captureReadOnlyFullStorageInventory()!==before
              ||global.localStorage.getItem(
                PREVIEW_NOTES_REPEAT_JOURNAL_KEY)!==previous.raw){
              result=deny('repeat_intent_origin_or_witness_changed');
              return;
            }
          }catch(_){result=deny('repeat_intent_seal_unavailable');return;}
          touched=true;
          try{
            global.localStorage.setItem(
              PREVIEW_NOTES_REPEAT_JOURNAL_KEY,sealed);
            if(global.localStorage.getItem(
              PREVIEW_NOTES_REPEAT_JOURNAL_KEY)!==sealed)
              throw Error('repeat_intent_readback_mismatch');
            const after=captureReadOnlyFullStorageInventory();
            if(previewNotesRepeatOriginWithoutJournal(after)
              !==previewNotesRepeatOriginWithoutJournal(before))
              throw Error('repeat_origin_changed');
            const finalFence=await rehearsePreviewDurableWriterFence('audit');
            if(!stableMode()
              ||finalFence.reason!=='preview_writer_inventory_consistent'
              ||finalFence.fence?.generation!==generation
              ||finalFence.fence?.epoch!==fence.fence.epoch
              ||finalFence.fence?.frozen
              ||previewNotesWitnessObservedExternalChange(generation,epoch)
              ||captureReadOnlyFullStorageInventory()!==after)
              throw Error('repeat_intent_postaudit_changed');
          }catch(_){
            result=deny('repeat_intent_write_uncertain',{
              writeAttempted:true,writeOutcomeUncertain:true,
              inspectIntentBeforeRetry:true});return;
          }
          result=deny('preview_notes_repeat_intent_recorded',{
            intentRecorded:true,writeAttempted:true,
            journalEntryCount:(previous.journal?.entries.length||0)+1,
            cooperativeLockUsed:true,readbackVerified:true});
        });
    }catch(_){
      return deny('repeat_intent_lock_request_failed',{
        writeAttempted:touched,writeOutcomeUncertain:touched,
        inspectIntentBeforeRetry:touched});
    }
    return result;
  }

  async function rehearsePreviewAdmittedNotesRepeatCacheWrite(
    expectedInventoryToken,actionId){
    const deny=previewNotesRepeatDeny;
    if(!isWalTestPreviewHost())return deny('preview_host_required');
    if(!isDarkEnabled())return deny('dark_disabled');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken)
      return deny('full_origin_token_required');
    if(typeof actionId!=='string'
      ||!/^[a-zA-Z0-9_:.\-]{1,96}$/.test(actionId))
      return deny('repeat_action_id_invalid');
    const locks=global.navigator?.locks;
    if(typeof locks?.request!=='function')
      return deny('lock_manager_unavailable');
    const generation=currentGeneration({create:false});
    if(!generation)return deny('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const stableMode=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&currentGeneration({create:false})===generation
      &&darkMirrorModeEpoch===epoch;
    const cacheKey='taskpoints_notes_v1';
    const withoutCache=token=>stableJson(JSON.parse(token)
      .filter(row=>Array.isArray(row)&&row[0]!==cacheKey));
    let touched=false,result=deny('repeat_cache_lock_unavailable');
    try{
      await locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        {mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock){result=deny('repeat_cache_lock_held_elsewhere');return;}
          let before,journal,entry,snapshotRaw;
          try{
            before=captureReadOnlyFullStorageInventory();
            if(!stableMode()||before!==expectedInventoryToken){
              result=deny('repeat_cache_origin_changed');return;
            }
            journal=await readPreviewNotesRepeatJournal(generation);
            entry=journal.last;
            if(!entry||entry.actionId!==actionId){
              result=deny('repeat_cache_action_not_current');return;
            }
            if(await previewRecoveryFingerprint(
              previewNotesRepeatOriginWithoutJournal(before))
                !==entry.sourceOriginFingerprint){
              result=deny('repeat_cache_original_origin_changed');return;
            }
            snapshotRaw=global.localStorage.getItem(
              core.STORAGE_KEY||'taskpoints_v1');
            const cache=global.localStorage.getItem(cacheKey);
            if(!snapshotRaw||cache!==entry.previousText
              ||await previewRecoveryFingerprint(snapshotRaw)
                !==entry.sourceSnapshotFingerprint
              ||await previewRecoveryFingerprint(cache)
                !==entry.sourceCacheFingerprint
              ||global.localStorage.getItem(
                'taskpoints_notes_authoritative_v1')!=='1'
              ||global.localStorage.getItem(
                'taskpoints_notes_dirty_v1')!=='1'){
              result=deny('repeat_cache_source_diverged');return;
            }
          }catch(_){
            result=deny('repeat_cache_intent_or_origin_invalid');return;
          }
          const fence=await rehearsePreviewDurableWriterFence('audit');
          if(!stableMode()
            ||fence.reason!=='preview_writer_inventory_consistent'
            ||fence.fence?.generation!==generation||fence.fence?.frozen){
            result=deny('repeat_cache_fence_unverified_or_frozen');return;
          }
          try{
            const snapshot=core.parseTaskPointsStorageJson(snapshotRaw);
            if(!snapshot||typeof snapshot!=='object'
              ||Array.isArray(snapshot)
              ||snapshot.notes!==entry.previousText
              ||previewNotesWitnessObservedExternalChange(generation,epoch)
              ||captureReadOnlyFullStorageInventory()!==before
              ||global.localStorage.getItem(
                PREVIEW_NOTES_REPEAT_JOURNAL_KEY)!==journal.raw){
              result=deny('repeat_cache_source_changed_before_write');
              return;
            }
          }catch(_){result=deny('repeat_cache_source_unreadable');return;}
          touched=true;
          try{global.localStorage.setItem(cacheKey,entry.text);}
          catch(_){
            result=deny('repeat_cache_write_uncertain',{
              writeAttempted:true,writeOutcomeUncertain:true,
              inspectIntentBeforeRetry:true});return;
          }
          let after;
          try{
            after=captureReadOnlyFullStorageInventory();
            if(!stableMode()
              ||global.localStorage.getItem(cacheKey)!==entry.text
              ||global.localStorage.getItem(
                'taskpoints_notes_authoritative_v1')!=='1'
              ||global.localStorage.getItem(
                'taskpoints_notes_dirty_v1')!=='1'
              ||withoutCache(after)!==withoutCache(before)){
              result=deny('repeat_cache_readback_or_origin_changed',{
                writeAttempted:true,writeOutcomeUncertain:true,
                inspectIntentBeforeRetry:true});return;
            }
          }catch(_){
            result=deny('repeat_cache_readback_unavailable',{
              writeAttempted:true,writeOutcomeUncertain:true,
              inspectIntentBeforeRetry:true});return;
          }
          const finalFence=await rehearsePreviewDurableWriterFence('audit');
          try{
            if(!stableMode()
              ||finalFence.reason!=='preview_writer_inventory_consistent'
              ||finalFence.fence?.generation!==generation
              ||finalFence.fence?.epoch!==fence.fence.epoch
              ||finalFence.fence?.frozen
              ||previewNotesWitnessObservedExternalChange(generation,epoch)
              ||captureReadOnlyFullStorageInventory()!==after){
              result=deny('repeat_cache_postwrite_evidence_changed',{
                writeAttempted:true,writeOutcomeUncertain:true,
                inspectIntentBeforeRetry:true});return;
            }
          }catch(_){
            result=deny('repeat_cache_postaudit_unavailable',{
              writeAttempted:true,writeOutcomeUncertain:true,
              inspectIntentBeforeRetry:true});return;
          }
          result=deny('preview_notes_repeat_cache_written_dirty_retained',{
            cacheReadbackVerified:true,writeAttempted:true,
            dirtyMarkerPreserved:true,cooperativeLockUsed:true});
        });
    }catch(_){
      return deny('repeat_cache_lock_request_failed',{
        writeAttempted:touched,writeOutcomeUncertain:touched,
        inspectIntentBeforeRetry:touched});
    }
    return result;
  }

  async function rehearsePreviewAdmittedNotesRepeatSnapshotSync(
    expectedInventoryToken,actionId){
    const deny=previewNotesRepeatDeny;
    if(!isWalTestPreviewHost())return deny('preview_host_required');
    if(!isDarkEnabled())return deny('dark_disabled');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken)
      return deny('full_origin_token_required');
    if(typeof actionId!=='string'
      ||!/^[a-zA-Z0-9_:.\-]{1,96}$/.test(actionId))
      return deny('repeat_action_id_invalid');
    const locks=global.navigator?.locks;
    if(typeof locks?.request!=='function')
      return deny('lock_manager_unavailable');
    const generation=currentGeneration({create:false});
    if(!generation)return deny('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const stableMode=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&currentGeneration({create:false})===generation
      &&darkMirrorModeEpoch===epoch;
    const snapshotKey=core.STORAGE_KEY||'taskpoints_v1';
    const cacheKey='taskpoints_notes_v1';
    const withoutSnapshot=token=>stableJson(JSON.parse(token)
      .filter(row=>Array.isArray(row)&&row[0]!==snapshotKey));
    let touched=false,result=deny('repeat_snapshot_lock_unavailable');
    try{
      await locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        {mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock){result=deny('repeat_snapshot_lock_held_elsewhere');return;}
          let before,journal,entry,snapshotRaw,proposedRaw;
          try{
            before=captureReadOnlyFullStorageInventory();
            if(!stableMode()||before!==expectedInventoryToken){
              result=deny('repeat_snapshot_origin_changed');return;
            }
            journal=await readPreviewNotesRepeatJournal(generation);
            entry=journal.last;
            if(!entry||entry.actionId!==actionId){
              result=deny('repeat_snapshot_action_not_current');return;
            }
            if(await previewRecoveryFingerprint(
              previewNotesRepeatOriginWithoutJournal(
                before,entry.previousText))
                !==entry.sourceOriginFingerprint){
              result=deny('repeat_snapshot_original_origin_changed');return;
            }
            snapshotRaw=global.localStorage.getItem(snapshotKey);
            if(!snapshotRaw
              ||await previewRecoveryFingerprint(snapshotRaw)
                !==entry.sourceSnapshotFingerprint
              ||global.localStorage.getItem(cacheKey)!==entry.text
              ||global.localStorage.getItem(
                'taskpoints_notes_authoritative_v1')!=='1'
              ||global.localStorage.getItem(
                'taskpoints_notes_dirty_v1')!=='1'){
              result=deny('repeat_snapshot_source_diverged');return;
            }
          }catch(_){
            result=deny('repeat_snapshot_intent_or_source_invalid');return;
          }
          const fence=await rehearsePreviewDurableWriterFence('audit');
          if(!stableMode()
            ||fence.reason!=='preview_writer_inventory_consistent'
            ||fence.fence?.generation!==generation||fence.fence?.frozen){
            result=deny('repeat_snapshot_fence_unverified_or_frozen');
            return;
          }
          try{
            const source=JSON.parse(snapshotRaw);
            if(!source||typeof source!=='object'
              ||Array.isArray(source)
              ||typeof source.notes!=='string'
              ||source.notes!==entry.previousText)
              throw Error('repeat_snapshot_source_state_incompatible');
            if(JSON.stringify(source)!==snapshotRaw){
              result=deny('repeat_snapshot_noncanonical_legacy_json');
              return;
            }
            if(typeof core.parseTaskPointsStorageJson!=='function'
              ||stableJson(core.parseTaskPointsStorageJson(snapshotRaw))
                !==stableJson(source))
              throw Error('repeat_snapshot_codec_incompatible');
            const next={...source,notes:entry.text};
            proposedRaw=JSON.stringify(next);
            if(stableJson(core.parseTaskPointsStorageJson(proposedRaw))
              !==stableJson(next))
              throw Error('repeat_snapshot_codec_roundtrip_mismatch');
            if(!stableMode()
              ||previewNotesWitnessObservedExternalChange(generation,epoch)
              ||captureReadOnlyFullStorageInventory()!==before
              ||global.localStorage.getItem(
                PREVIEW_NOTES_REPEAT_JOURNAL_KEY)!==journal.raw){
              result=deny('repeat_snapshot_origin_or_witness_changed');
              return;
            }
          }catch(_){
            result=deny('repeat_snapshot_codec_or_source_invalid');return;
          }
          touched=true;
          try{global.localStorage.setItem(snapshotKey,proposedRaw);}
          catch(_){
            result=deny('repeat_snapshot_write_uncertain',{
              writeAttempted:true,writeOutcomeUncertain:true,
              inspectIntentBeforeRetry:true});return;
          }
          let after;
          try{
            after=captureReadOnlyFullStorageInventory();
            if(!stableMode()
              ||global.localStorage.getItem(snapshotKey)!==proposedRaw
              ||global.localStorage.getItem(cacheKey)!==entry.text
              ||global.localStorage.getItem(
                'taskpoints_notes_authoritative_v1')!=='1'
              ||global.localStorage.getItem(
                'taskpoints_notes_dirty_v1')!=='1'
              ||withoutSnapshot(after)!==withoutSnapshot(before)){
              result=deny('repeat_snapshot_readback_or_origin_changed',{
                writeAttempted:true,writeOutcomeUncertain:true,
                inspectIntentBeforeRetry:true});return;
            }
          }catch(_){
            result=deny('repeat_snapshot_readback_unavailable',{
              writeAttempted:true,writeOutcomeUncertain:true,
              inspectIntentBeforeRetry:true});return;
          }
          const finalFence=await rehearsePreviewDurableWriterFence('audit');
          try{
            if(!stableMode()
              ||finalFence.reason!=='preview_writer_inventory_consistent'
              ||finalFence.fence?.generation!==generation
              ||finalFence.fence?.epoch!==fence.fence.epoch
              ||finalFence.fence?.frozen
              ||previewNotesWitnessObservedExternalChange(generation,epoch)
              ||captureReadOnlyFullStorageInventory()!==after){
              result=deny('repeat_snapshot_postwrite_evidence_changed',{
                writeAttempted:true,writeOutcomeUncertain:true,
                inspectIntentBeforeRetry:true});return;
            }
          }catch(_){
            result=deny('repeat_snapshot_postaudit_unavailable',{
              writeAttempted:true,writeOutcomeUncertain:true,
              inspectIntentBeforeRetry:true});return;
          }
          result=deny('preview_notes_repeat_snapshot_written_dirty_retained',{
            writeAttempted:true,notesSnapshotSynchronized:true,
            dirtyMarkerPreserved:true,cooperativeLockUsed:true,
            readbackVerified:true});
        });
    }catch(_){
      return deny('repeat_snapshot_lock_request_failed',{
        writeAttempted:touched,writeOutcomeUncertain:touched,
        inspectIntentBeforeRetry:touched});
    }
    return result;
  }

  async function inspectPreviewNotesRepeatEditJournal(){
    const deny=previewNotesRepeatDeny;
    if(!isWalTestPreviewHost())return deny('preview_host_required');
    if(!isDarkEnabled())return deny('dark_disabled');
    const generation=currentGeneration({create:false});
    if(!generation)return deny('generation_unavailable');
    try{
      const before=captureReadOnlyFullStorageInventory();
      const read=await readPreviewNotesRepeatJournal(generation);
      if(!read.journal)return deny('repeat_journal_absent');
      const entry=read.last;
      const cache=global.localStorage.getItem('taskpoints_notes_v1');
      const rawSnapshot=global.localStorage.getItem(
        core.STORAGE_KEY||'taskpoints_v1');
      const decoded=core.parseTaskPointsStorageJson(rawSnapshot);
      if(!decoded||typeof decoded!=='object'||Array.isArray(decoded)
        ||typeof decoded.notes!=='string')
        return deny('repeat_snapshot_unreadable');
      const dirty=global.localStorage.getItem(
        'taskpoints_notes_dirty_v1');
      const authority=global.localStorage.getItem(
        'taskpoints_notes_authoritative_v1');
      const cacheMatches=cache===entry.text;
      const snapshotMatches=decoded.notes===entry.text;
      const markersValid=dirty==='1'&&authority==='1';
      const snapshotKey=core.STORAGE_KEY||'taskpoints_v1';
      const cacheKey='taskpoints_notes_v1';
      // The journal digest authenticates recorded history but cannot by
      // itself prove the CURRENT origin still corresponds to that history.
      // Reconstruct the latest admission inventory for all three stages.
      // In the synced stage the real writer changed Notes inside the V1
      // snapshot, so undo only that field *in memory* for its SHA check.
      const atIntent=cache===entry.previousText
        &&decoded.notes===entry.previousText;
      const atCache=cacheMatches
        &&decoded.notes===entry.previousText;
      const atSnapshot=cacheMatches&&snapshotMatches;
      let sourceOriginMatchesAdmission=false;
      if(atIntent||atCache||atSnapshot){
        let originalSnapshot=rawSnapshot;
        if(atSnapshot){
          const snapshot=JSON.parse(rawSnapshot);
          // Only the canonical plain-JSON codec qualifies for the
          // synthetic snapshot continuation. Other legacy representations
          // remain intact, with no source-consistency claim.
          if(JSON.stringify(snapshot)===rawSnapshot)
            originalSnapshot=JSON.stringify({
              ...snapshot,notes:entry.previousText});
          else originalSnapshot=null;
        }
        if(typeof originalSnapshot==='string'){
          const reconstructed=stableJson(JSON.parse(before)
            .filter(row=>Array.isArray(row)
              &&row[0]!==PREVIEW_NOTES_REPEAT_JOURNAL_KEY)
            .map(row=>row[0]===cacheKey
              ?[cacheKey,entry.previousText]
              :row[0]===snapshotKey
                ?[snapshotKey,originalSnapshot]:row));
          sourceOriginMatchesAdmission=
            await previewRecoveryFingerprint(originalSnapshot)
              ===entry.sourceSnapshotFingerprint
            &&await previewRecoveryFingerprint(reconstructed)
              ===entry.sourceOriginFingerprint;
        }
      }
      const stage=!markersValid?'repeat_recovery_markers_missing'
        :!sourceOriginMatchesAdmission?'repeat_source_diverged'
        :atSnapshot?'repeat_snapshot_synced_dirty_pending'
        :atCache?'repeat_cache_written_snapshot_pending'
        :'repeat_intent_recorded_cache_pending';
      if(!isWalTestPreviewHost()||!isDarkEnabled()
        ||currentGeneration({create:false})!==generation
        ||captureReadOnlyFullStorageInventory()!==before
        ||global.localStorage.getItem(
          PREVIEW_NOTES_REPEAT_JOURNAL_KEY)!==read.raw)
        return deny('repeat_origin_changed_during_inspection');
      return {...deny('preview_notes_repeat_journal_verified'),
        journalEvidenceVerified:true,
        journalEntryCount:read.journal.entries.length,
        lastActionId:entry.actionId,
        cacheMatchesLastAction:cacheMatches,
        snapshotMatchesLastAction:snapshotMatches,
        sourceOriginMatchesAdmission,
        lastActionProvenanceVerified:markersValid
          &&sourceOriginMatchesAdmission,
        dirtyMarkerPreserved:dirty==='1',
        notesCacheAuthorityEstablished:authority==='1',
        observedRecoveryStage:stage};
    }catch(_){return deny('repeat_journal_unreadable_or_invalid');}
  }

  // V2-only Notes keystroke rehearsal: participate in the same preview Web
  // Lock as Task / Projects / Today / freeze, but mutate ONLY the existing
  // V1 Notes cache after BOTH durable authority/dirty markers already equal
  // "1". First-edit marker initialization, snapshot sync and marker clearing
  // require a multi-key recovery protocol and are intentionally REFUSED.
  // No production Notes event listener calls this explicit developer API.
  async function rehearsePreviewCooperativeDirtyNotesCacheSave(nextText,
    expectedInventoryToken) {
    const deny=(reason,extra={})=>({
      checked:true,previewOnly:true,cacheOnly:true,
      cacheWriteObserved:false,cacheReadbackVerified:false,
      notesFullySynchronized:false,confirmedDurable:false,
      committed:false,cooperativeTaskFreezeLockUsed:false,
      canPromote:false,productionWritersFenced:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...extra
    });
    if(!isWalTestPreviewHost())return deny('preview_host_required');
    if(!isDarkEnabled())return deny('dark_disabled');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken.length)
      return deny('full_origin_token_required');
    if(typeof nextText!=='string'||nextText.length>1048576)
      return deny('notes_text_invalid_or_oversized');
    const locks=global.navigator?.locks;
    if(typeof locks?.request!=='function')return deny('lock_manager_unavailable');
    const generation=currentGeneration({create:false});
    if(!generation)return deny('generation_unavailable');
    const modeEpoch=darkMirrorModeEpoch;
    const key='taskpoints_notes_v1';
    let attempted=false;
    let result=deny('cooperative_notes_lock_not_available');
    try{
      await locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        {mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock){result=deny('cooperative_notes_lock_held_elsewhere');return;}
          if(!isDarkEnabled()||modeEpoch!==darkMirrorModeEpoch
            ||currentGeneration({create:false})!==generation){
            result=deny('generation_changed_under_cooperative_lock');return;
          }
          const fence=await rehearsePreviewDurableWriterFence('audit');
          if(fence.reason!=='preview_writer_inventory_consistent'){
            result=deny('preview_fence_inventory_unverified',{
              prerequisiteReason:fence.reason});return;
          }
          if(fence.fence?.generation!==generation
            ||!isDarkEnabled()||modeEpoch!==darkMirrorModeEpoch){
            result=deny('preview_generation_changed_before_notes_write');return;
          }
          if(fence.fence.frozen){
            result=deny('preview_fence_frozen',{
              cooperativeTaskFreezeLockUsed:true,fenceEpoch:fence.fence.epoch});
            return;
          }
          let before,prior,originalState;
          try{
            before=captureReadOnlyFullStorageInventory();
            if(before!==expectedInventoryToken){
              result=deny('full_origin_changed');return;
            }
            prior=global.localStorage.getItem(key);
            const authoritative=global.localStorage.getItem(
              'taskpoints_notes_authoritative_v1');
            const dirty=global.localStorage.getItem(
              'taskpoints_notes_dirty_v1');
            if(prior===null||authoritative!=='1'||dirty!=='1'){
              result=deny('notes_dirty_authority_not_established');return;
            }
            if(prior.length>1048576){
              result=deny('notes_cache_too_large');return;
            }
            const rawState=global.localStorage.getItem(
              core.STORAGE_KEY||'taskpoints_v1');
            if(typeof rawState!=='string'||!rawState.length){
              result=deny('notes_snapshot_missing');return;
            }
            originalState=typeof core.parseTaskPointsStorageJson==='function'
              ?core.parseTaskPointsStorageJson(rawState,{})
              :JSON.parse(rawState);
            if(!originalState||typeof originalState!=='object'
              ||Array.isArray(originalState)
              ||(originalState.notes!==undefined
                &&typeof originalState.notes!=='string')){
              result=deny('notes_snapshot_invalid');return;
            }
          }catch(_){result=deny('notes_source_unreadable');return;}
          // Prevent Notes cache from receiving a fresh value if any older
          // page edited Projects, Tasks, Notes markers or the V1 snapshot
          // while the preview was validating the source.
          try{
            if(captureReadOnlyFullStorageInventory()!==expectedInventoryToken
              ||global.localStorage.getItem(key)!==prior){
              result=deny('full_origin_changed_before_notes_write');return;
            }
          }catch(_){
            result=deny('full_origin_unreadable_before_notes_write');return;
          }
          if(!isDarkEnabled()||modeEpoch!==darkMirrorModeEpoch
            ||currentGeneration({create:false})!==generation){
            result=deny('generation_changed_before_notes_write');return;
          }
          if(prior===nextText){
            result=deny('notes_cache_already_identical',{
              cooperativeTaskFreezeLockUsed:true,
              cacheReadbackVerified:true});return;
          }
          attempted=true;
          try{global.localStorage.setItem(key,nextText);}
          catch(_){
            result=deny('notes_cache_write_failed',{
              writeOutcomeUncertain:true,inspectV1BeforeRetry:true});return;
          }
          let savedOrigin;
          try{
            if(global.localStorage.getItem(key)!==nextText){
              result=deny('notes_cache_readback_mismatch',{
                committed:true,writeOutcomeUncertain:true});return;
            }
            savedOrigin=captureReadOnlyFullStorageInventory();
            const withoutCache=token=>JSON.parse(token)
              .filter(row=>Array.isArray(row)&&row[0]!==key);
            if(stableJson(withoutCache(savedOrigin))
              !==stableJson(withoutCache(expectedInventoryToken))){
              result=deny('other_origin_changed_during_notes_write',{
                committed:true,writeOutcomeUncertain:true});return;
            }
          }catch(_){
            result=deny('notes_cache_readback_unreadable',{
              committed:true,writeOutcomeUncertain:true});return;
          }
          const finalFence=await rehearsePreviewDurableWriterFence('audit');
          if(finalFence.reason!=='preview_writer_inventory_consistent'
            ||finalFence.fence?.generation!==generation
            ||finalFence.fence?.epoch!==fence.fence.epoch
            ||finalFence.fence.frozen
            ||!isDarkEnabled()||modeEpoch!==darkMirrorModeEpoch
            ||currentGeneration({create:false})!==generation){
            result=deny('notes_fence_changed_after_cache_write',{
              committed:true,writeOutcomeUncertain:true,
              inspectV1BeforeRetry:true});return;
          }
          try{
            if(global.localStorage.getItem(key)!==nextText
              ||captureReadOnlyFullStorageInventory()!==savedOrigin){
              result=deny('notes_origin_changed_after_cache_write',{
                committed:true,writeOutcomeUncertain:true});return;
            }
          }catch(_){
            result=deny('notes_origin_unreadable_after_cache_write',{
              committed:true,writeOutcomeUncertain:true});return;
          }
          result=deny('preview_notes_dirty_cache_saved',{
            cacheWriteObserved:true,cacheReadbackVerified:true,
            committed:true,cooperativeTaskFreezeLockUsed:true,
            savedLength:nextText.length,fenceEpoch:finalFence.fence.epoch});
        });
    }catch(_){
      return deny('cooperative_notes_lock_request_failed',{
        writeOutcomeUncertain:attempted,inspectV1BeforeRetry:attempted
      });
    }
    return result;
  }


  // Explicit developer-preview-only recovery *coverage* inventory.
  // Browser origin data lives in multiple independent stores: the full
  // localStorage namespace, V2 runtime/WAL, shadow migration, and images.
  // Never mistake a count-only census for a portable, off-device backup.
  // The inspection enumerates *existing* IDBs only and uses readonly counts;
  // it must neither create absent databases nor read/serialize user records.
  async function inspectPreviewIndependentBackupCoverage(expectedInventoryToken){
    const deny=(reason,detail={})=>({
      checked:true,previewOnly:true,readOnly:true,
      localStorageInventoryStable:false,
      indexedDbCatalogStable:false,recordContentVerified:false,
      binaryImageBytesVerified:false,offDeviceBackupVerified:false,
      independentRecoveryVerified:false,backupPackageCreated:false,
      backupComplete:false,canRestore:false,canPromote:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if(!isWalTestPreviewHost())return deny('preview_host_required');
    if(!isDarkEnabled())return deny('dark_disabled');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken)
      return deny('full_origin_token_required');
    if(typeof global.TextEncoder!=='function'
      ||typeof global.crypto?.subtle?.digest!=='function')
      return deny('sha256_or_text_encoder_unavailable');
    const idb=global.indexedDB;
    if(typeof idb?.databases!=='function')
      return deny('indexeddb_database_catalog_unavailable');
    const locks=global.navigator?.locks;
    if(typeof locks?.request!=='function')
      return deny('lock_manager_unavailable');
    const generation=currentGeneration({create:false});
    if(!generation)return deny('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const stableMode=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&currentGeneration({create:false})===generation
      &&darkMirrorModeEpoch===epoch;
    const normalizedCatalog=rows=>{
      if(!Array.isArray(rows)||rows.length>64)
        throw Error('invalid_database_catalog');
      const seen=new Set();
      return rows.map(row=>{
        const name=row?.name;
        const version=row?.version;
        if(typeof name!=='string'||!name||name.length>256
          ||seen.has(name)
          ||!Number.isSafeInteger(version)||version<1)
          throw Error('invalid_database_identity');
        seen.add(name);
        return {name,version};
      }).sort((a,b)=>a.name.localeCompare(b.name));
    };
    let result=deny('backup_coverage_lock_unavailable');
    try{
      await locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        {mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock){result=deny('backup_coverage_lock_held_elsewhere');return;}
          let before,catalogBefore,inventory,originFingerprint;
          try{
            before=captureReadOnlyFullStorageInventory();
            if(!stableMode()||before!==expectedInventoryToken){
              result=deny('backup_coverage_origin_changed');return;
            }
            catalogBefore=normalizedCatalog(await idb.databases());
            originFingerprint=await previewRecoveryFingerprint(before);
            const entries=JSON.parse(before);
            if(!Array.isArray(entries)||entries.length>100000)
              throw Error('too_many_origin_keys');
            const encoder=new global.TextEncoder();
            let totalBytes=0;
            for(const row of entries){
              if(!Array.isArray(row)||row.length!==2
                ||typeof row[0]!=='string'||typeof row[1]!=='string')
                throw Error('invalid_origin_entry');
              totalBytes+=encoder.encode(row[0]).byteLength
                +encoder.encode(row[1]).byteLength;
            }
            inventory={keyCount:entries.length,utf8Bytes:totalBytes};
          }catch(_){result=deny('backup_coverage_source_unavailable');return;}
          if(!stableMode()
            ||previewNotesWitnessObservedExternalChange(generation,epoch)
            ||captureReadOnlyFullStorageInventory()!==before){
            result=deny('backup_coverage_source_changed_before_catalog');
            return;
          }
          const databases=[];
          let storeCount=0;
          try{
            for(const item of catalogBefore){
              // Opening without a version avoids upgrades to EXISTING DBs.
              // If deleted between catalog and open(), abort onupgradeneeded
              // rather than accidentally resurrecting a missing database.
              const db=await new Promise((resolve,reject)=>{
                const request=idb.open(item.name);
                request.onupgradeneeded=()=>{
                  try{request.transaction?.abort?.();}catch(_){}
                  reject(Error('backup_coverage_database_recreated'));
                };
                request.onerror=()=>reject(request.error||Error('db_open_failed'));
                request.onblocked=()=>reject(Error('db_open_blocked'));
                request.onsuccess=()=>resolve(request.result);
              });
              try{
                if(db.version!==item.version)
                  throw Error('backup_coverage_database_version_changed');
                const stores=Array.from(db.objectStoreNames);
                if(stores.length>64||storeCount+stores.length>256)
                  throw Error('backup_coverage_store_limit_exceeded');
                if(stores.some(name=>typeof name!=='string'||!name))
                  throw Error('backup_coverage_store_name_invalid');
                storeCount+=stores.length;
                const counts=[];
                if(stores.length){
                  // Queue every count() synchronously in one readonly tx.
                  // Safari may deactivate a transaction between awaits.
                  const tx=db.transaction(stores,'readonly');
                  const completed=transactionPromise(tx);
                  const requests=stores.map(name=>
                    requestPromise(tx.objectStore(name).count()));
                  // Observe request AND transaction failures together.
                  // A rejected count aborts the transaction and must never
                  // leave its completion rejection unhandled.
                  const values=await Promise.all([...requests,completed]);
                  for(let i=0;i<stores.length;i++){
                    if(!Number.isSafeInteger(values[i])||values[i]<0)
                      throw Error('backup_coverage_count_invalid');
                    counts.push({name:stores[i],recordCount:values[i]});
                  }
                }
                databases.push({
                  name:item.name,version:item.version,
                  stores:counts,
                  recordCount:counts.reduce((sum,v)=>sum+v.recordCount,0)
                });
              }finally{try{db.close();}catch(_){}}
              if(!stableMode()
                ||previewNotesWitnessObservedExternalChange(generation,epoch)
                ||captureReadOnlyFullStorageInventory()!==before)
                throw Error('backup_coverage_origin_changed_during_scan');
            }
          }catch(_){
            result=deny('backup_coverage_database_scan_unavailable');
            return;
          }
          // A catalog can stay unchanged while an older tab adds or
          // deletes records during this scan. Recount each existing store
          // before reporting the inventory, without reading payload bytes.
          // This detects count drift, NOT same-count edits or safe backups.
          try{
            for(const prior of databases){
              const db=await new Promise((resolve,reject)=>{
                const request=idb.open(prior.name);
                request.onupgradeneeded=()=>{
                  try{request.transaction?.abort?.();}catch(_){}
                  reject(Error('backup_coverage_database_recreated'));
                };
                request.onerror=()=>reject(request.error||Error('db_reopen_failed'));
                request.onblocked=()=>reject(Error('db_reopen_blocked'));
                request.onsuccess=()=>resolve(request.result);
              });
              try{
                if(db.version!==prior.version)
                  throw Error('backup_coverage_database_version_changed');
                const stores=Array.from(db.objectStoreNames);
                if(stores.length!==prior.stores.length
                  ||stores.some((name,i)=>name!==prior.stores[i].name))
                  throw Error('backup_coverage_store_structure_changed');
                if(stores.length){
                  const tx=db.transaction(stores,'readonly');
                  const completed=transactionPromise(tx);
                  // Queue requests before awaiting so WebKit cannot
                  // deactivate the transaction between store counts.
                  const requests=stores.map(name=>
                    requestPromise(tx.objectStore(name).count()));
                  const values=await Promise.all([...requests,completed]);
                  if(stores.some((_,i)=>
                    values[i]!==prior.stores[i].recordCount))
                    throw Error('backup_coverage_record_count_changed');
                }
              }finally{try{db.close();}catch(_){}}
            }
          }catch(error){
            result=deny(error?.message==='backup_coverage_record_count_changed'
              ?'backup_coverage_record_count_changed'
              :'backup_coverage_recount_unavailable');
            return;
          }
          let catalogAfter;
          try{
            catalogAfter=normalizedCatalog(await idb.databases());
            if(!stableMode()
              ||previewNotesWitnessObservedExternalChange(generation,epoch)
              ||captureReadOnlyFullStorageInventory()!==before
              ||stableJson(catalogAfter)!==stableJson(catalogBefore)
              ||await previewRecoveryFingerprint(
                captureReadOnlyFullStorageInventory())!==originFingerprint){
              result=deny('backup_coverage_inventory_changed');
              return;
            }
          }catch(_){result=deny('backup_coverage_final_audit_unavailable');return;}
          const imageName=core.IMAGE_DB_NAME||'taskpoints';
          const imageStore=core.IMAGE_STORE_NAME||'images';
          const image=databases.find(db=>db.name===imageName);
          const imageRows=image?.stores.find(store=>store.name===imageStore);
          const knownDbNames=[DB_NAME,PREVIEW_RECOVERY_DB,imageName,
            core.SHADOW_MIGRATION_DB_NAME].filter(Boolean);
          const unexpectedDatabases=databases
            .filter(db=>!knownDbNames.includes(db.name))
            .map(db=>db.name);
          result=deny('backup_coverage_inventory_readonly_observed',{
            localStorageInventoryStable:true,
            indexedDbCatalogStable:true,
            indexedDbRecordCountsRechecked:true,
            // A same-count mutation can still escape this census.
            indexedDbRecordContentStable:false,
            cooperativeLockUsed:true,
            localStorage:inventory,
            originFingerprint,
            databaseCount:databases.length,
            objectStoreCount:storeCount,
            databaseInventory:databases,
            unexpectedDatabases,
            imageDatabasePresent:!!image,
            imageStorePresent:!!imageRows,
            imageRecordCount:imageRows?.recordCount??null,
            // A count-only scan says nothing about Blob bytes, the
            // consistency of concurrent IDB content edits, or off-device
            // preservation of the records.
            imageBytesIncludedInBackup:false,
            allDatabaseRecordsExported:false,
            fullOriginBackupRestorable:false,
            canPromote:false
          });
        });
    }catch(_){return deny('backup_coverage_lock_or_catalog_failed');}
    return result;
  }

  // C01/M01 preview stepping stone: inventory *every* legacy image Blob,
  // including unreferenced images, rather than trusting only the current
  // players' imageIds or an IndexedDB count. This is a local, read-only
  // two-pass fingerprint audit, NOT an export or independently recoverable
  // backup. V1's image store remains the source of truth.
  async function inspectPreviewLegacyImageBytes(expectedInventoryToken) {
    const refuse=(reason,detail={})=>({
      checked:true,previewOnly:true,readOnly:true,
      binaryImageBytesVerified:false,allLegacyImageRowsVerified:false,
      imageReferencesCovered:false,offDeviceBackupVerified:false,
      independentRecoveryVerified:false,backupPackageCreated:false,
      backupComplete:false,canRestore:false,canPromote:false,
      readAuthority:'legacy_only',mutationAuthority:'legacy_only',
      reason,...detail
    });
    if(!isWalTestPreviewHost())return refuse('preview_host_required');
    if(!isDarkEnabled())return refuse('dark_disabled');
    if(typeof expectedInventoryToken!=='string'||!expectedInventoryToken)
      return refuse('full_origin_token_required');
    if(typeof global.crypto?.subtle?.digest!=='function'
      ||typeof global.TextEncoder!=='function')
      return refuse('sha256_unavailable');
    if(typeof global.indexedDB?.databases!=='function')
      return refuse('indexeddb_database_catalog_unavailable');
    if(typeof global.navigator?.locks?.request!=='function')
      return refuse('lock_manager_unavailable');
    const generation=currentGeneration({create:false});
    if(!generation)return refuse('generation_unavailable');
    const epoch=darkMirrorModeEpoch;
    const current=()=>isWalTestPreviewHost()&&isDarkEnabled()
      &&currentGeneration({create:false})===generation
      &&darkMirrorModeEpoch===epoch
      &&!previewNotesWitnessObservedExternalChange(generation,epoch)
      &&captureReadOnlyFullStorageInventory()===expectedInventoryToken;
    const idb=global.indexedDB;
    const imageName=core.IMAGE_DB_NAME||'taskpoints';
    const storeName=core.IMAGE_STORE_NAME||'images';
    const maxRows=512, maxBytes=64*1024*1024;
    let report=refuse('legacy_image_audit_lock_unavailable');
    try {
      await global.navigator.locks.request(PREVIEW_COOPERATIVE_TASK_FREEZE_LOCK,
        {mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock){report=refuse('legacy_image_audit_lock_held');return;}
          let db=null;
          try {
            if(!current()){
              report=refuse('legacy_image_origin_changed');return;
            }
            const initialCatalog=await idb.databases();
            if(!Array.isArray(initialCatalog)){
              report=refuse('legacy_image_catalog_invalid');return;
            }
            const matches=initialCatalog.filter(item=>item?.name===imageName);
            if(matches.length!==1
              ||!Number.isSafeInteger(matches[0].version)
              ||matches[0].version<1){
              report=refuse('legacy_image_database_missing_or_ambiguous');return;
            }
            if(!current()){
              report=refuse('legacy_image_origin_changed');return;
            }
            db=await new Promise((resolve,reject)=>{
              const request=idb.open(imageName);
              // Never create a missing database during an inspection.
              request.onupgradeneeded=()=>{
                try{request.transaction?.abort();}catch(_){}
                reject(Error('legacy_image_database_recreated'));
              };
              request.onerror=()=>reject(request.error||Error('image_open_failed'));
              request.onblocked=()=>reject(Error('image_open_blocked'));
              request.onsuccess=()=>resolve(request.result);
            });
            if(db.version!==matches[0].version
              ||!db.objectStoreNames?.contains(storeName)){
              report=refuse('legacy_image_store_missing_or_changed');return;
            }
            const countTx=db.transaction(storeName,'readonly');
            const countDone=transactionPromise(countTx);
            const [count]=await Promise.all([
              requestPromise(countTx.objectStore(storeName).count()),
              countDone
            ]);
            if(!Number.isSafeInteger(count)||count<0||count>maxRows){
              report=refuse('legacy_image_count_budget_exceeded',{imageCount:count});
              return;
            }
            // Queue all reads synchronously before any await to preserve
            // IndexedDB transaction activity on Safari/WebKit.
            const capture=async()=>{
              const tx=db.transaction(storeName,'readonly');
              const done=transactionPromise(tx);
              const store=tx.objectStore(storeName);
              const [keys,values]=await Promise.all([
                requestPromise(store.getAllKeys()),
                requestPromise(store.getAll()),done
              ]);
              if(!Array.isArray(keys)||!Array.isArray(values)
                ||keys.length!==count||values.length!==count)
                throw Error('legacy_image_count_changed');
              const rows=[],seen=new Set();
              let bytes=0;
              for(let i=0;i<keys.length;i++){
                const id=keys[i],blob=values[i];
                if(typeof id!=='string'||!id||id.length>256
                  ||seen.has(id))throw Error('legacy_image_key_invalid');
                seen.add(id);
                if(!blob||typeof blob.arrayBuffer!=='function'
                  ||!Number.isSafeInteger(blob.size)||blob.size<0)
                  throw Error('legacy_image_blob_invalid');
                bytes+=blob.size;
                if(bytes>maxBytes)throw Error('legacy_image_byte_budget_exceeded');
                const data=await blob.arrayBuffer();
                if(data.byteLength!==blob.size)
                  throw Error('legacy_image_blob_size_changed');
                const hashed=await global.crypto.subtle.digest('SHA-256',data);
                const hex=Array.from(new Uint8Array(hashed),
                  value=>value.toString(16).padStart(2,'0')).join('');
                rows.push([id,blob.size,blob.type||'',hex]);
              }
              return {rows,bytes};
            };
            const first=await capture();
            if(!current()){
              report=refuse('legacy_image_origin_changed_during_audit');return;
            }
            const second=await capture();
            if(stableJson(first)!==stableJson(second)){
              report=refuse('legacy_image_bytes_changed_during_audit');return;
            }
            const finalCatalog=await idb.databases();
            const finalMatches=Array.isArray(finalCatalog)
              ?finalCatalog.filter(item=>item?.name===imageName):[];
            if(finalMatches.length!==1
              ||finalMatches[0].version!==matches[0].version
              ||!current()){
              report=refuse('legacy_image_origin_or_database_changed');return;
            }
            const fingerprint=await previewRecoveryFingerprint(first.rows);
            if(!current()){
              report=refuse('legacy_image_origin_changed_after_digest');return;
            }
            report=refuse('legacy_image_bytes_double_read_verified',{
              binaryImageBytesVerified:true,allLegacyImageRowsVerified:true,
              imageCount:count,totalImageBytes:first.bytes,
              imageFingerprint:fingerprint,
              // This includes orphaned records; it does not prove that
              // image references in every legacy format are intact.
              imageReferencesCovered:false,
              cooperativeLockUsed:true
            });
          }catch(error){
            const known=new Set([
              'legacy_image_count_changed','legacy_image_key_invalid',
              'legacy_image_blob_invalid','legacy_image_byte_budget_exceeded',
              'legacy_image_blob_size_changed']);
            const message=String(error?.message||'');
            report=refuse(known.has(message)?message:'legacy_image_audit_unavailable');
          }finally{
            try{db?.close();}catch(_){}
          }
        });
    }catch(_){return refuse('legacy_image_audit_lock_failed');}
    return report;
  }

  // V2 PREVIEW ONLY: observe real, already-durable V1 Task journal edits.
  // Never put IndexedDB work on the foreground Task save path: the real
  // synchronous V1 journal is still authoritative and durable before paint.
  // A cooperative preview mirror is not an atomic old-tab fence or cutover.
  const OBSERVED_TASK_IDLE_MS = 7000;
  const OBSERVED_TASK_TIMER_MS = 9000;
  let observedTaskRequested = false;
  // Tracks one low-priority catch-up opportunity per preview startup epoch.
  // No persistence, no V1 writes, no authority handoff.
  let observedTaskStartupKey = null;
  let observedTaskStartupRequests = 0;
  let observedTaskPeerListenerInstalled = false;
  let observedTaskVisibilityListenerInstalled = false;
  let observedTaskVisibilityResumes = 0;
  let observedTaskPeerNotifications = 0;
  let observedTaskPeerCatchupRequests = 0;
  let observedTaskTimer = null;
  let observedTaskTimerGeneration = 0;
  let observedTaskRun = null;
  let observedTaskAttempts = 0;
  let observedTaskVerified = 0;
  let observedTaskRefused = 0;
  let observedTaskLastReason = 'not_started';
  let observedTaskIdleDeferrals = 0;

  function observeTaskResult(reason, verified = false) {
    observedTaskLastReason = reason;
    if (verified) observedTaskVerified += 1;
    else observedTaskRefused += 1;
    return {
      checked:true, previewOnly:true, verified, reason,
      canPromote:false, productionWritersFenced:false,
      readAuthority:'legacy_only', mutationAuthority:'legacy_only'
    };
  }

  function observedTaskPreviewAllowed() {
    return isWalTestPreviewHost() && isDarkEnabled()
      && Boolean(currentGeneration({create:false}));
  }

  async function flushObservedLegacyTaskJournal() {
    if (!observedTaskPreviewAllowed())
      return observeTaskResult('preview_not_admitted');
    if (observedTaskRun) return observedTaskRun;
    if (!observedTaskRequested)
      return {
        checked:true,previewOnly:true,verified:false,
        reason:'no_pending_task_observation',canPromote:false,
        productionWritersFenced:false
      };
    observedTaskRequested = false;
    observedTaskAttempts += 1;
    const generation = currentGeneration({create:false});
    const epoch = darkMirrorModeEpoch;
    observedTaskRun = (async () => {
      try {
        if (!observedTaskPreviewAllowed()
          || currentGeneration({create:false}) !== generation
          || darkMirrorModeEpoch !== epoch)
          return observeTaskResult('preview_generation_changed');
        // Do not copy unreadable or malformed V1 pending Task evidence.
        const pending = core.readPendingTaskMutations?.();
        if (!pending || pending.malformed
          || !Array.isArray(pending.record?.tasks)
          || !Array.isArray(pending.record?.completionUpserts)
          || !Array.isArray(pending.record?.completionDeletes))
          return observeTaskResult('legacy_task_journal_unreadable');
        const seeded = await rehearsePreviewTaskCollectionSeed();
        let result = seeded;
        if (!seeded.verified && seeded.reason === 'task_preview_existing_evidence_preserved') {
          if (!observedTaskPreviewAllowed()
            || currentGeneration({create:false}) !== generation
            || darkMirrorModeEpoch !== epoch)
            return observeTaskResult('preview_generation_changed');
          let token;
          try { token = captureReadOnlyFullStorageInventory(); }
          catch (_) { return observeTaskResult('full_origin_unreadable'); }
          const id = 'observed-task-'+String(global.crypto?.randomUUID?.()
            || (Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)));
          result = await rehearsePreviewTaskCollectionReconcile(token,id);
        }
        if (!(result?.verified === true
          || (result?.confirmedDurable === true && result?.collectionParityVerified === true)))
          return observeTaskResult(result?.reason || 'task_preview_reconcile_refused');
        // Independent post-action parity; V1 journal may have changed again
        // during the async mirror. Never count a stale preview as verified.
        const parity = await inspectPreviewTaskCollectionParity();
        if (parity?.match !== true)
          return observeTaskResult(parity?.reason || 'task_preview_parity_unverified');
        if (!observedTaskPreviewAllowed()
          || currentGeneration({create:false}) !== generation
          || darkMirrorModeEpoch !== epoch)
          return observeTaskResult('preview_generation_changed');
        return observeTaskResult('observed_legacy_task_parity_verified',true);
      } catch (_) {
        return observeTaskResult('task_preview_observation_failed');
      }
    })().finally(() => {
      observedTaskRun = null;
      if (observedTaskRequested) scheduleObservedTaskMirror();
    });
    return observedTaskRun;
  }

  function scheduleObservedTaskMirror() {
    if (!observedTaskPreviewAllowed() || !observedTaskRequested
      || typeof global.setTimeout !== 'function') return false;
    const serial = ++observedTaskTimerGeneration;
    if (observedTaskTimer != null) global.clearTimeout?.(observedTaskTimer);
    observedTaskTimer = global.setTimeout(() => {
      if (serial !== observedTaskTimerGeneration) return;
      observedTaskTimer = null;
      if (!observedTaskPreviewAllowed() || !observedTaskRequested) return;
      // Background-only. If the user is active, allow a few additional
      // quiet-window checks, but never create unbounded background polling.
      const idle = core.getStorageMaintenanceIdleStatus?.() || null;
      if (global.document?.hidden || global.document?.visibilityState === 'hidden'
        || idle?.pageLeaving === true || idle?.activeEditor === true
        || (idle && Number(idle.lastInteractionAgoMs || 0) < OBSERVED_TASK_IDLE_MS)
        || (typeof core.isStorageMaintenanceQuiet === 'function'
          && core.isStorageMaintenanceQuiet() !== true)) {
        observedTaskLastReason = 'waiting_for_idle';
        observedTaskIdleDeferrals += 1;
        if (observedTaskIdleDeferrals < 4
          && !global.document?.hidden
          && global.document?.visibilityState !== 'hidden')
          scheduleObservedTaskMirror();
        return;
      }
      observedTaskIdleDeferrals = 0;
      void flushObservedLegacyTaskJournal();
    },OBSERVED_TASK_TIMER_MS);
    return true;
  }

  // When a second tab writes/compacts V1 Tasks, this page receives a
  // storage event (never fired in the writing tab). The event handler must
  // remain O(1): it does not parse a full V1 snapshot, touch IndexedDB, or
  // acknowledge a Task save. The existing bounded idle mirror later reads
  // the authoritative source and checks generation, receipts and parity.
  function installObservedLegacyTaskPeerListener() {
    if (observedTaskPeerListenerInstalled || !isWalTestPreviewHost()
      || typeof global.addEventListener !== 'function') return false;
    global.addEventListener('storage', event => {
      if (!event || !observedTaskPreviewAllowed()) return;
      if (event.key !== 'taskpoints_v1'
        && event.key !== 'taskpoints_pending_task_mutations_v1') return;
      if (event.oldValue === event.newValue) return;
      if (event.storageArea != null && event.storageArea !== global.localStorage)
        return;
      observedTaskPeerNotifications += 1;
      if (queueObservedLegacyTaskJournal()) observedTaskPeerCatchupRequests += 1;
    });
    observedTaskPeerListenerInstalled = true;
    // A hidden preview page intentionally does not run its expensive idle
    // mirror. A missed timer must not strand that pending request forever:
    // resume only the delayed, bounded preflight after the page is visible.
    // The event callback never parses V1 data or opens IndexedDB.
    if (!observedTaskVisibilityListenerInstalled
      && typeof global.document?.addEventListener === 'function') {
      global.document.addEventListener('visibilitychange', () => {
        if (global.document?.hidden
          || global.document?.visibilityState === 'hidden'
          || !observedTaskRequested || observedTaskRun
          || observedTaskTimer != null || !observedTaskPreviewAllowed()) return;
        if (scheduleObservedTaskMirror()) observedTaskVisibilityResumes += 1;
      });
      observedTaskVisibilityListenerInstalled = true;
    }
    return true;
  }

  function queueObservedLegacyTaskJournal() {
    if (!observedTaskPreviewAllowed()) return false;
    observedTaskRequested = true;
    observedTaskIdleDeferrals = 0;
    scheduleObservedTaskMirror();
    return true;
  }

  function getObservedLegacyTaskStatus() {
    return {
      previewOnly:true,productionWritersFenced:false,
      pending:observedTaskRequested,running:Boolean(observedTaskRun),
      startupCatchupRequests:observedTaskStartupRequests,
      peerStorageListenerInstalled:observedTaskPeerListenerInstalled,
      visibilityResumeListenerInstalled:observedTaskVisibilityListenerInstalled,
      visibilityResumeRequests:observedTaskVisibilityResumes,
      peerStorageNotifications:observedTaskPeerNotifications,
      peerStorageCatchupRequests:observedTaskPeerCatchupRequests,
      attempts:observedTaskAttempts,verified:observedTaskVerified,
      refused:observedTaskRefused,lastReason:observedTaskLastReason,
      idleDeferrals:observedTaskIdleDeferrals,
      automaticIdleMs:OBSERVED_TASK_IDLE_MS
    };
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
      const db = await open();
      if (!db) return [];
      // A one-Habit preview lookup need not deserialize every Habit. Keep
      // the full completion scan fallback until the V2 completion index is
      // independently verified; using a merely present index could silently
      // omit older rows that predate its backfill.
      const candidate = await readPilotHabitRowsFromDb(db, String(habitId), false);
      // Match the original public API's native-array shape without cloning
      // the already-cloned completion payloads a second time.
      return global.Array.from(candidate.completions);
    },
    buildCompatibilitySnapshot,
    verifyParity,
    inspectPilotReadiness,
    inspectPilotCompletionIndexCoverage,
    rehearsePreviewCompletionIndexBackfill,
    inspectPreviewHabitCompletionIndexParity,
    readPreviewIndexedHabitCompletions,
    inspectMutationHandoffPrerequisites,
    inspectAuthorityCutoverBarriers,
    inspectPreviewWriterPeers,
    exercisePreviewCooperativeWriterLease,
    exercisePreviewSerializedSnapshotLease,
    rehearsePreviewAdmittedTaskCompletionBatch,
    rehearsePreviewFenceCheckedTaskCompletionBatch,
    rehearsePreviewCooperativeWriterFreeze,
    rehearsePreviewCooperativeProjectsSave,
    rehearsePreviewCooperativeTodaySave,
    rehearsePreviewCooperativeDirtyNotesCacheSave,
    rehearsePreviewNotesFirstEditIntent,
    rehearsePreviewAdmittedNotesFirstEditCacheWrite,
    rehearsePreviewAdmittedNotesSnapshotSync,
    rehearsePreviewNotesFollowupIntent,
    rehearsePreviewAdmittedNotesFollowupCacheWrite,
    rehearsePreviewAdmittedNotesFollowupSnapshotSync,
    inspectPreviewNotesFollowupIntent,
    rehearsePreviewNotesRepeatEditIntent,
    rehearsePreviewAdmittedNotesRepeatCacheWrite,
    rehearsePreviewAdmittedNotesRepeatSnapshotSync,
    inspectPreviewNotesRepeatEditJournal,
    inspectPreviewIndependentBackupCoverage,
    inspectPreviewLegacyImageBytes,
    inspectPreviewNotesSnapshotCompletionEvidence,
    inspectPreviewNotesFirstEditIntent,
    inspectPreviewCooperativeNotesFirstEditConflict,
    beginPreviewLegacyStorageEventWitness,
    inspectPreviewLegacyStorageEventWitness,
    stopPreviewLegacyStorageEventWitness,
    inspectPreviewNotesBaselineFirstProtocol,
    inspectPreviewTaskBatchJournalEvidence,
    inspectPreviewTaskBatchEffectiveEvidence,
    inspectPreviewNotesSource,
    rehearsePreviewNotesBundleSeed,
    rehearsePreviewNotesBundleReconcile,
    inspectPreviewNotesBundleParity,
    inspectPreviewNotesRecoveryEvidence,
    inspectPreviewNotesCheckpointCoverage,
    inspectPreviewNotesTransitionSafety,
    inspectPreviewNotesInterruptedSaveWindows,
    inspectPreviewGamePreferencesSource,
    rehearsePreviewHabitOrderSidecarSeed,
    rehearsePreviewHabitOrderSidecarReconcile,
    inspectPreviewHabitOrderSidecarParity,
    inspectPreviewHabitOrderSidecarRecoveryEvidence,
    rehearsePreviewGameCollectionSeed,
    rehearsePreviewGameCollectionReconcile,
    inspectPreviewGameCollectionParity,
    inspectPreviewGameRecoveryEvidence,
    inspectPreviewGameCompatibilityProjection,
    inspectPreviewGameCheckpointCoverage,
    inspectPreviewGameImageCoverage,
    inspectPreviewGameBackupZip,
    rehearsePreviewGameZipRestoreInMemory,
    inspectPreviewWholeBackupRestoreCoverage,
    inspectPreviewTodaySource,
    rehearsePreviewTodayCollectionSeed,
    inspectPreviewTodayCollectionParity,
    inspectPreviewTodayDayRecord,
    buildPreviewTodayCompatibilitySnapshot,
    buildPreviewTodayDetachedRecoveryCandidate,
    preparePreviewTodayDetachedRestorePackage,
    inspectPreviewTodayRecoveryEvidence,
    rehearsePreviewTodayCollectionReconcile,
    rehearsePreviewTodayRowSeal,
    inspectPreviewProjectsSource,
    rehearsePreviewGoldLedgerSeed,
    rehearsePreviewGoldLedgerReconcile,
    inspectPreviewGoldLedgerParity,
    inspectPreviewGoldRecoveryEvidence,
    inspectPreviewGoldTransactionIntegrity,
    rehearsePreviewTaskCollectionSeed,
    rehearsePreviewTaskCollectionReconcile,
    queueObservedLegacyTaskJournal,
    flushObservedLegacyTaskJournal,
    getObservedLegacyTaskStatus,
    inspectPreviewTaskCollectionParity,
    inspectPreviewTaskRecord,
    rehearsePreviewTaskRecordUpdate,
    rehearsePreviewTaskLifecycleMutation,
    rehearsePreviewTaskLinkedCompletion,
    rehearsePreviewTaskLinkedCompletionBatch,
    rehearsePreviewTaskCompletionHistoryCatchUp,
    inspectPreviewTaskCompletionOrderParity,
    inspectPreviewMixedCompletionExport,
    inspectPreviewWholeCompatibilityProjection,
    rehearsePreviewDurableWriterFence,
    capturePreviewFrozenOriginWitness,
    inspectPreviewFrozenOriginWitness,
    inspectPreservedParityMismatch,
    inspectLegacyRollbackSource,
    createPreviewRecoveryCheckpoint,
    inspectPreviewRecoveryCheckpoint,
    inspectPreviewRollbackPlan,
    rehearseExclusiveWriterLease,
    readPilotHabitCandidate,
    setPilotReadProbeEnabled,
    probePilotHabitRead,
    rehearsePreviewTaskCompletionHistoryReconcile,
    rehearsePreviewProjectsCollectionSeed,
    inspectPreviewProjectsCollectionParity,
    inspectPreviewProjectsRecoveryEvidence,
    rehearsePreviewProjectsCollectionReconcile,
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
