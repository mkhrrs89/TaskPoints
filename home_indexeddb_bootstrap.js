(function installTaskPointsSequentialMatrixBoot(global) {
  'use strict';

  if (!global || global.__tpSequentialMatrixBootInstalled) return;
  global.__tpSequentialMatrixBootInstalled = true;

  const document = global.document;
  if (!document) return;

  const WORD = 'TASKPOINTS';
  const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+?@';
  const INITIAL_BLANK_MS = 35;
  const SCRAMBLE_MS = 70;
  const GLYPH_TICK_MS = 14;
  const BETWEEN_LETTERS_MS = 0;
  const FINAL_HOLD_MS = 70;

  let started = false;
  let stopped = false;
  let stage = null;
  let titleObserver = null;
  let removeSkipListeners = null;

  const sleep = (ms) => new Promise((resolve) => global.setTimeout(resolve, ms));
  const nextFrame = () => new Promise((resolve) => {
    const raf = global.requestAnimationFrame || ((callback) => global.setTimeout(callback, 16));
    raf.call(global, resolve);
  });
  const randomGlyph = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];

  const overrideStyle = document.createElement('style');
  overrideStyle.id = 'tp-sequential-matrix-override';
  overrideStyle.textContent = `
    #matrixTitle.tp-matrix-running .tp-matrix-char-strip,
    #matrixTitle .tp-matrix-char-strip {
      animation: none !important;
      transform: none !important;
    }

    #matrixTitle .tp-sequential-matrix-stage {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.08em;
      height: 1.15em;
      line-height: 1.15em;
      white-space: nowrap;
      letter-spacing: 0;
      contain: layout paint;
      transform: translateZ(0);
    }

    #matrixTitle .tp-sequential-matrix-char {
      display: inline-block;
      width: 0.85em;
      height: 1.15em;
      line-height: 1.15em;
      text-align: center;
      letter-spacing: 0;
      white-space: nowrap;
      color: #c8ffd8;
    }

    #matrixTitle .tp-sequential-matrix-char.is-scrambling {
      color: #b7ffc9;
      text-shadow:
        0 0 8px rgba(60,255,120,0.34),
        0 0 18px rgba(60,255,120,0.18);
    }

    #matrixTitle .tp-sequential-matrix-char.is-locked {
      color: #eafff1;
    }
  `;
  (document.head || document.documentElement).appendChild(overrideStyle);

  function isBootPending() {
    return document.documentElement.classList.contains('tp-boot-pending');
  }

  function finishSequence({ skipped = false } = {}) {
    if (stopped) return;
    stopped = true;

    titleObserver?.disconnect();
    titleObserver = null;
    if (typeof removeSkipListeners === 'function') removeSkipListeners();

    const titleEl = document.getElementById('matrixTitle');
    if (titleEl) {
      titleEl.classList.remove('tp-matrix-running', 'tp-matrix-skip');
      titleEl.textContent = WORD;
    }

    global.__tpBootViewFinished = false;

    let revealed = false;
    if (typeof global.__tpCompleteBootView === 'function') {
      try {
        revealed = Boolean(global.__tpCompleteBootView({ skipped }));
      } catch (_) {}
    }

    if (typeof global.__tpForceMatrixCompletion === 'function') {
      try { global.__tpForceMatrixCompletion(); } catch (_) {}
    } else if (!revealed) {
      try { global.dispatchEvent(new Event('tp:matrixFinished')); } catch (_) {}
    }
  }

  function bindSkipControls(splash) {
    const requestSkip = (event) => {
      if (stopped) return;
      if (event?.cancelable) event.preventDefault();
      event?.stopImmediatePropagation?.();
      finishSequence({ skipped: true });
    };

    const requestSkipFromKey = (event) => {
      if (!['Enter', ' ', 'Escape'].includes(event.key)) return;
      requestSkip(event);
    };

    const pointerOptions = { capture: true, passive: false };
    splash.addEventListener('pointerdown', requestSkip, pointerOptions);
    splash.addEventListener('touchstart', requestSkip, pointerOptions);
    splash.addEventListener('click', requestSkip, pointerOptions);
    splash.addEventListener('keydown', requestSkipFromKey, true);

    removeSkipListeners = () => {
      splash.removeEventListener('pointerdown', requestSkip, pointerOptions);
      splash.removeEventListener('touchstart', requestSkip, pointerOptions);
      splash.removeEventListener('click', requestSkip, pointerOptions);
      splash.removeEventListener('keydown', requestSkipFromKey, true);
    };
  }

  async function runSequentialAnimation(titleEl, splash) {
    if (started || !isBootPending()) return;
    if (global.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    started = true;
    global.__tpBootViewFinished = true;
    bindSkipControls(splash);

    titleEl.classList.remove('tp-matrix-running', 'tp-matrix-skip');
    document.getElementById('tp-early-matrix-animation-style')?.remove();
    titleEl.replaceChildren();

    stage = document.createElement('span');
    stage.className = 'tp-sequential-matrix-stage';

    const slots = Array.from(WORD, () => {
      const slot = document.createElement('span');
      slot.className = 'tp-sequential-matrix-char';
      slot.textContent = '\u00a0';
      stage.appendChild(slot);
      return slot;
    });
    titleEl.appendChild(stage);

    titleObserver = new MutationObserver(() => {
      if (stopped || !titleEl.isConnected || titleEl.contains(stage)) return;
      titleEl.replaceChildren(stage);
    });
    titleObserver.observe(titleEl, { childList: true });

    await nextFrame();
    await nextFrame();
    await sleep(INITIAL_BLANK_MS);

    for (let index = 0; index < slots.length; index += 1) {
      if (stopped) return;

      const slot = slots[index];
      slot.classList.add('is-scrambling');
      const scrambleUntil = (global.performance?.now?.() ?? Date.now()) + SCRAMBLE_MS;

      while (!stopped && (global.performance?.now?.() ?? Date.now()) < scrambleUntil) {
        slot.textContent = randomGlyph();
        await sleep(GLYPH_TICK_MS);
      }
      if (stopped) return;

      slot.textContent = WORD[index];
      slot.classList.remove('is-scrambling');
      slot.classList.add('is-locked');
      await sleep(BETWEEN_LETTERS_MS);
    }

    await sleep(FINAL_HOLD_MS);
    finishSequence({ skipped: false });
  }

  function attemptStart() {
    if (started || !isBootPending()) return;
    const splash = document.getElementById('bootSplash');
    const titleEl = document.getElementById('matrixTitle');
    if (!splash || !titleEl) return;

    global.setTimeout(() => runSequentialAnimation(titleEl, splash), 0);
  }

  const domObserver = new MutationObserver(() => {
    attemptStart();
    if (started || !isBootPending()) domObserver.disconnect();
  });
  domObserver.observe(document.documentElement, { childList: true, subtree: true });
  attemptStart();
})(typeof window !== 'undefined' ? window : globalThis);

(function installTaskPointsHomeNativeBoot(global) {
  'use strict';

  if (!global || global.TaskPointsHomeNativeBoot) return;

  const STORAGE_KEY = 'taskpoints_v1';
  const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
  const REVISION_KEY = 'taskpoints_state_revision_v1';
  const DB_NAME = 'taskpoints_verified_secondary_v1';
  const STORE_NAME = 'snapshots';
  const RECORD_ID = 'home_native_latest';
  const SNAPSHOT_FORMAT = 'home_structured_clone_v1';
  const startedAt = global.performance?.now?.() ?? Date.now();
  const perfEnabled = Boolean(
    global.TP_DEBUG_PERF
    || (() => {
      try { return new URLSearchParams(global.location?.search || '').has('perf'); }
      catch (_) { return false; }
    })()
  );

  let resolveReady;
  const readyPromise = new Promise((resolve) => { resolveReady = resolve; });

  const api = {
    status: 'warming',
    reason: null,
    state: null,
    revision: '',
    authoritativeRaw: null,
    recordMeta: null,
    elapsedMs: 0,
    promise: readyPromise,
    takeReadyState: null
  };
  global.TaskPointsHomeNativeBoot = api;

  function safeGet(key) {
    try { return global.localStorage?.getItem?.(key) ?? null; }
    catch (_) { return null; }
  }

  function pendingJournalIsEmpty(raw) {
    if (!raw) return true;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.length === 0;
      if (Array.isArray(parsed?.operations)) return parsed.operations.length === 0;
      return parsed && typeof parsed === 'object'
        ? Object.keys(parsed).length === 0
        : false;
    } catch (_) {
      return false;
    }
  }

  function hashRaw(raw) {
    const text = String(raw || '');
    let value = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    return `${(value >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
  }

  function fingerprint(raw) {
    const text = String(raw || '');
    return {
      rawHash: hashRaw(text),
      rawLength: text.length,
      rawHead: text.slice(0, 64),
      rawTail: text.slice(-64)
    };
  }

  function finish(status, reason = null, patch = {}) {
    api.status = status;
    api.reason = reason;
    Object.assign(api, patch);
    api.elapsedMs = (global.performance?.now?.() ?? Date.now()) - startedAt;
    if (status !== 'ready') {
      api.state = null;
      api.authoritativeRaw = null;
    }
    if (perfEnabled) {
      console.log('[TP home native boot]', {
        status: api.status,
        reason: api.reason,
        elapsedMs: Number(api.elapsedMs.toFixed?.(1) ?? api.elapsedMs),
        recordMeta: api.recordMeta
      });
    }
    resolveReady(api);
    return api;
  }

  function currentSourceStillMatches() {
    const currentRaw = safeGet(STORAGE_KEY);
    if (currentRaw === null || currentRaw !== api.authoritativeRaw) return false;
    if (!pendingJournalIsEmpty(safeGet(JOURNAL_KEY))) return false;
    const currentRevision = String(safeGet(REVISION_KEY) || '');
    if ((api.revision || currentRevision) && currentRevision !== api.revision) return false;
    return true;
  }

  api.takeReadyState = function takeReadyState() {
    if (api.status !== 'ready' || !api.state) return null;
    if (!currentSourceStillMatches()) {
      finish('fallback', 'authoritative_changed_after_native_read');
      return null;
    }
    const state = api.state;
    api.state = null;
    api.authoritativeRaw = null;
    api.status = 'consumed';
    return state;
  };

  const authoritativeRaw = safeGet(STORAGE_KEY);
  if (authoritativeRaw === null) {
    finish('fallback', 'authoritative_missing');
    return;
  }
  if (!pendingJournalIsEmpty(safeGet(JOURNAL_KEY))) {
    finish('fallback', 'pending_habit_journal');
    return;
  }
  if (!global.indexedDB) {
    finish('fallback', 'indexeddb_unavailable');
    return;
  }

  api.authoritativeRaw = authoritativeRaw;
  api.revision = String(safeGet(REVISION_KEY) || '');

  let databaseWasMissing = false;
  let request;
  try {
    request = global.indexedDB.open(DB_NAME);
  } catch (_) {
    finish('fallback', 'indexeddb_open_exception');
    return;
  }

  request.onupgradeneeded = () => {
    databaseWasMissing = true;
    try { request.transaction?.abort?.(); } catch (_) {}
  };
  request.onblocked = () => finish('fallback', 'indexeddb_open_blocked');
  request.onerror = () => finish(
    'fallback',
    databaseWasMissing ? 'native_database_missing' : 'indexeddb_open_failed'
  );
  request.onsuccess = () => {
    const db = request.result;
    if (!db?.objectStoreNames?.contains?.(STORE_NAME)) {
      try { db?.close?.(); } catch (_) {}
      finish('fallback', 'native_store_missing');
      return;
    }

    let transaction;
    try {
      transaction = db.transaction(STORE_NAME, 'readonly');
    } catch (_) {
      try { db?.close?.(); } catch (_) {}
      finish('fallback', 'native_transaction_failed');
      return;
    }

    const readRequest = transaction.objectStore(STORE_NAME).get(RECORD_ID);
    readRequest.onerror = () => finish('fallback', 'native_record_read_failed');
    readRequest.onsuccess = () => {
      const record = readRequest.result;
      const sourceFingerprint = fingerprint(authoritativeRaw);
      const revisionMatches = !((record?.revision || api.revision)
        && String(record?.revision || '') !== api.revision);
      const recordMatches = Boolean(
        record
        && record.id === RECORD_ID
        && record.schemaVersion === 1
        && record.snapshotFormat === SNAPSHOT_FORMAT
        && record.status === 'passed_verification'
        && record.state
        && typeof record.state === 'object'
        && !Array.isArray(record.state)
        && record.rawHash === sourceFingerprint.rawHash
        && Number(record.rawLength) === sourceFingerprint.rawLength
        && String(record.rawHead || '') === sourceFingerprint.rawHead
        && String(record.rawTail || '') === sourceFingerprint.rawTail
        && revisionMatches
      );

      if (!recordMatches) {
        finish('fallback', record ? 'native_snapshot_stale' : 'native_snapshot_missing');
        return;
      }

      finish('ready', null, {
        state: record.state,
        recordMeta: {
          verifiedAtISO: record.verifiedAtISO || '',
          rawHash: record.rawHash,
          stateHash: record.stateHash || '',
          revision: record.revision || ''
        }
      });
    };
    transaction.oncomplete = () => { try { db.close(); } catch (_) {} };
    transaction.onabort = () => {
      try { db.close(); } catch (_) {}
      if (api.status === 'warming') finish('fallback', 'native_transaction_aborted');
    };
    transaction.onerror = () => undefined;
  };
})(typeof window !== 'undefined' ? window : globalThis);

(function installTaskPointsAddTaskMobileLayout(global) {
  'use strict';

  const document = global?.document;
  if (!document || document.getElementById('tp-add-task-mobile-layout')) return;

  const style = document.createElement('style');
  style.id = 'tp-add-task-mobile-layout';
  style.textContent = `
    #createTaskSkillsEditor {
      display: none !important;
    }

    @media (max-width: 640px) {
      #addTaskModal {
        z-index: 70 !important;
      }

      #addTaskModal .addTaskModalPanel {
        padding-top: 72px !important;
      }

      body:has(#addTaskModal:not(.hidden)) #mobileBottomNav {
        z-index: 80 !important;
      }

      body:has(#addTaskModal:not(.hidden)) #criticalTasksIsland {
        visibility: hidden !important;
        pointer-events: none !important;
      }

      #addTaskModalBody {
        display: grid !important;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) !important;
        column-gap: 10px !important;
        row-gap: 10px !important;
        align-items: stretch !important;
      }

      #addTaskModalBody > #titleInput {
        grid-column: 1 / -1 !important;
        grid-row: 1 !important;
      }

      #addTaskRow2,
      #addTaskRow3 {
        display: contents !important;
      }

      #importanceInput {
        grid-column: 1 !important;
        grid-row: 2 !important;
      }

      #dueDateInput {
        grid-column: 2 !important;
        grid-row: 2 !important;
        width: 100% !important;
        min-width: 0 !important;
        max-width: 100% !important;
        margin: 0 !important;
      }

      #pointsInput {
        grid-column: 1 !important;
        grid-row: 3 !important;
        width: 100% !important;
        min-width: 0 !important;
      }

      #addTaskQuickDueRow {
        grid-column: 2 !important;
        grid-row: 3 !important;
        display: grid !important;
        grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
        gap: 8px !important;
        align-items: stretch !important;
        margin: 0 !important;
        min-width: 0 !important;
      }

      #addTaskQuickDueRow .addTaskTodayBtn {
        width: 100% !important;
        min-width: 0 !important;
        margin: 0 !important;
      }

      #repeatInput {
        grid-column: 1 / -1 !important;
        grid-row: 4 !important;
        width: 100% !important;
        min-width: 0 !important;
      }

      #repeatCustomRow {
        grid-column: 1 / -1 !important;
        grid-row: 5 !important;
      }

      #tagsInput {
        grid-column: 1 / -1 !important;
        grid-row: 6 !important;
      }

      #addBtn {
        grid-column: 1 / -1 !important;
        grid-row: 7 !important;
      }

      #addTaskModalBody .input,
      #addTaskModalBody select {
        height: 48px !important;
        min-height: 48px !important;
        max-height: 48px !important;
        box-sizing: border-box !important;
      }

      #addTaskQuickDueRow button {
        height: 48px !important;
        min-height: 48px !important;
        max-height: 48px !important;
        box-sizing: border-box !important;
      }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
})(typeof window !== 'undefined' ? window : globalThis);