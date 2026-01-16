function closeAllDropdowns(exception) {
  document.querySelectorAll('.dropdown.open').forEach((dropdown) => {
    if (dropdown === exception) return;
    dropdown.classList.remove('open');
    const toggle = dropdown.querySelector('[data-dropdown-toggle]');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  });
}

window.TP_DEBUG_PERF = window.TP_DEBUG_PERF ?? false;

const scheduleRender = window.scheduleRender || (() => {
  const queue = new Set();
  let scheduled = false;

  return (fn) => {
    if (typeof fn !== 'function') return;
    queue.add(fn);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const toRun = Array.from(queue);
      queue.clear();
      toRun.forEach((cb) => cb());
    });
  };
})();

window.scheduleRender = scheduleRender;

let toolbarHeightResizeObserver = null;
let toolbarHeightListenersAdded = false;

function updateToolbarStackHeight(nav) {
  if (!nav) return;
  const height = Math.round(nav.getBoundingClientRect().height);
  if (!Number.isFinite(height) || height <= 0) return;
  document.documentElement.style.setProperty('--tp-toolbar-stack-height', `${height}px`);
}

function setupToolbarStackHeightTracking(nav) {
  if (!nav) return;

  updateToolbarStackHeight(nav);
  requestAnimationFrame(() => updateToolbarStackHeight(nav));

  if (toolbarHeightResizeObserver) toolbarHeightResizeObserver.disconnect();
  if (typeof ResizeObserver !== 'undefined') {
    toolbarHeightResizeObserver = new ResizeObserver(() => updateToolbarStackHeight(nav));
    toolbarHeightResizeObserver.observe(nav);
  }

  if (!toolbarHeightListenersAdded) {
    toolbarHeightListenersAdded = true;
    window.addEventListener('resize', () => updateToolbarStackHeight(nav));
    window.addEventListener('orientationchange', () => updateToolbarStackHeight(nav));
  }
}

function setupDropdowns(root = document) {
  root.querySelectorAll('.dropdown').forEach((dropdown) => {
    if (dropdown.dataset.dropdownReady) return;
    dropdown.dataset.dropdownReady = 'true';
    const toggle = dropdown.querySelector('[data-dropdown-toggle]');
    if (!toggle) return;

    const menu = dropdown.querySelector('.dropdown-menu');

    // Prevent taps inside menu from closing it
    if (menu) {
      menu.addEventListener('pointerdown', (e) => e.stopPropagation());
      menu.addEventListener('click', (e) => e.stopPropagation());
    }

    function setExpanded(isOpen) {
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }

    function doToggle(e) {
      e.preventDefault();
      e.stopPropagation();

// close other dropdowns, but DO NOT close this one before toggling
closeAllDropdowns(dropdown);

dropdown.classList.toggle('open');
setExpanded(dropdown.classList.contains('open'));

    }

    // Use pointerdown for mobile reliability
    toggle.addEventListener('pointerdown', (e) => {
      // mark that this tap already handled, so the synthetic click is ignored
      toggle.dataset.ignoreClick = '1';
      doToggle(e);
      setTimeout(() => delete toggle.dataset.ignoreClick, 350);
    });

    // Keep click for desktop keyboards/etc, but ignore if it followed a pointer tap
    toggle.addEventListener('click', (e) => {
      if (toggle.dataset.ignoreClick) return;
      doToggle(e);
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setupDropdowns();

  // Close when tapping/clicking outside
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.dropdown')) return;
    closeAllDropdowns();
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Escape') closeAllDropdowns();
  });
});

// ---------- Shared mobile bottom nav ----------
function buildMobileBottomNavLinks() {
  return `
    <a href="index.html" class="mobile-bottom-nav-btn flex flex-col items-center gap-0.5 opacity-80 hover:opacity-100">
      <span class="text-lg">🏠</span>
      <span class="uppercase tracking-wide text-[10px]">Home</span>
    </a>

    <a href="today.html" class="mobile-bottom-nav-btn flex flex-col items-center gap-0.5 opacity-80 hover:opacity-100">
      <span class="text-lg">📅</span>
      <span class="uppercase tracking-wide text-[10px]">Today</span>
    </a>

    <div class="mobile-task-dropdown">
      <button
        id="mobileTasksToggle"
        type="button"
        class="mobile-bottom-nav-btn mobile-task-toggle flex flex-col items-center gap-0.5 opacity-80 hover:opacity-100"
        aria-expanded="false"
        aria-haspopup="true">
        <span class="text-lg">✔️</span>
        <span class="uppercase tracking-wide text-[10px]">Tasks</span>
      </button>

      <div id="mobileTasksMenu" class="mobile-task-menu hidden">
        <button type="button" id="mobileAddTaskBtn" class="btn btn-teal btn-toolbar w-full">Add a Task</button>
        <button type="button" id="mobileGoTasksBtn" class="btn btn-teal btn-toolbar w-full">Go To Tasks</button>
      </div>
    </div>

    <div class="dropdown mobile-bottom-dropdown">
      <button
        type="button"
        class="mobile-bottom-nav-btn dropdown-toggle flex flex-col items-center gap-0.5 opacity-80 hover:opacity-100"
        data-dropdown-toggle
        aria-expanded="false"
        aria-haspopup="true"
      >
        <span class="text-lg">🎮</span>
        <span class="uppercase tracking-wide text-[10px]">Game</span>
      </button>

      <div class="dropdown-menu">
        <a href="gamehub.html" class="btn btn-teal btn-toolbar nav-btn">Game Hub</a>
        <a href="game.html" class="btn btn-teal btn-toolbar nav-btn">Players</a>
        <a href="game_ratings.html" class="btn btn-teal btn-toolbar nav-btn">Ratings</a>
        <a href="matchups.html" class="btn btn-teal btn-toolbar nav-btn">Matchups</a>
        <a href="schedule.html" class="btn btn-teal btn-toolbar nav-btn">Schedule</a>
        <a href="standings.html" class="btn btn-teal btn-toolbar nav-btn">Standings</a>
      </div>
    </div>

    <a href="settings.html" class="mobile-bottom-nav-btn flex flex-col items-center gap-0.5 opacity-80 hover:opacity-100">
      <span class="text-lg">⚙️</span>
      <span class="uppercase tracking-wide text-[10px]">Settings</span>
    </a>
  `;
}

function ensureBottomToolbarMount() {
  const mounts = Array.from(document.querySelectorAll('#bottomToolbarMount'));
  let mount = mounts.find((item) => item.parentElement === document.body) || mounts[0];

  if (!mount) {
    mount = document.createElement('div');
    mount.id = 'bottomToolbarMount';
    document.body.appendChild(mount);
  } else if (mount.parentElement !== document.body) {
    document.body.appendChild(mount);
  }

  mounts.forEach((item) => {
    if (item !== mount) item.remove();
  });

  return mount;
}

function renderBottomToolbar() {
  const mount = ensureBottomToolbarMount();
  const existingNavs = Array.from(document.querySelectorAll('#mobileBottomNav'));
  existingNavs.forEach((nav) => {
    if (nav.parentElement !== mount) nav.remove();
  });

  mount.innerHTML = `
    <nav
      id="mobileBottomNav"
      class="mobile-bottom-nav-shell fixed inset-x-0 bottom-0 z-40 md:hidden border-t border-slate-800 text-slate-100 drop-shadow-sm"
      style="background: linear-gradient(180deg, #0f4d4d, #0a2f2f);"
    >
      <div class="max-w-6xl mx-auto flex justify-center py-3 pb-4 text-[11px] mobile-bottom-nav">
        ${buildMobileBottomNavLinks()}
      </div>
    </nav>
  `;

  const duplicateNavs = Array.from(document.querySelectorAll('#mobileBottomNav'));
  duplicateNavs.forEach((nav) => {
    if (nav.parentElement !== mount) nav.remove();
  });

  const nav = mount.querySelector('#mobileBottomNav');
  if (nav) {
    setupDropdowns(nav);
    setupBottomNavPressAnimation(nav);
    setupBottomNavDragExpand(nav);
    setupToolbarStackHeightTracking(nav);
  }
}

function setupMobileTasksMenu() {
  const toggle = document.getElementById('mobileTasksToggle');
  const menu = document.getElementById('mobileTasksMenu');
  const addBtn = document.getElementById('mobileAddTaskBtn');
  const goBtn = document.getElementById('mobileGoTasksBtn');

  if (!toggle || !menu) return;
  if (toggle.dataset.tpTasksReady) return;
  toggle.dataset.tpTasksReady = 'true';

  const onIndex = /(^|\/)index\.html$/.test(window.location.pathname) || window.location.pathname === '/' || window.location.pathname === '';
  const tasksLink = onIndex ? '#tasksAnchor' : 'index.html#tasksAnchor';

  const closeMenu = () => {
    menu.classList.add('hidden');
    toggle.setAttribute('aria-expanded', 'false');
  };

  const toggleMenu = () => {
    menu.classList.toggle('hidden');
    toggle.setAttribute('aria-expanded', String(!menu.classList.contains('hidden')));
  };

  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    toggleMenu();
  });

  if (!window.__tpTasksMenuPointerListener) {
    window.__tpTasksMenuPointerListener = true;
    document.addEventListener('pointerdown', (e) => {
      if (menu.classList.contains('hidden')) return;
      if (e.target.closest('.mobile-task-dropdown')) return;
      closeMenu();
    });
  }

  addBtn?.addEventListener('click', () => {
    closeMenu();
    if (typeof window.openAddTaskModal === 'function') {
      window.openAddTaskModal();
      return;
    }
    window.location.href = tasksLink;
  });

  goBtn?.addEventListener('click', () => {
    closeMenu();
    const tasksAnchor = document.getElementById('tasksAnchor');
    if (tasksAnchor) {
      tasksAnchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    window.location.href = tasksLink;
  });

  if (!window.__tpTasksMenuResizeListener) {
    window.__tpTasksMenuResizeListener = true;
    window.addEventListener('resize', () => {
      if (window.innerWidth >= 768) closeMenu();
    });
  }

  toggle.addEventListener('keyup', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleMenu();
    }
  });
}

function setupBottomNavPressAnimation(root = document) {
  const nav = root.querySelector('.mobile-bottom-nav');
  if (!nav) return;
  if (nav.dataset.navPressReady) return;
  nav.dataset.navPressReady = 'true';

  nav.addEventListener('pointerdown', (event) => {
    const target = event.target.closest('.mobile-bottom-nav-btn');
    if (!target || !nav.contains(target)) return;
    target.classList.remove('is-pressed');
    void target.offsetWidth;
    target.classList.add('is-pressed');
    window.setTimeout(() => target.classList.remove('is-pressed'), 300);
  });
}

function setupBottomNavDragExpand(nav) {
  if (!nav) return;
  if (nav.dataset.navDragReady) return;
  nav.dataset.navDragReady = 'true';

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const collapsedHeight = nav.getBoundingClientRect().height;
  const expandedHeight = collapsedHeight * 3;
  let currentHeight = collapsedHeight;
  let startY = null;
  let startHeight = collapsedHeight;
  let isDragging = false;
  let isExpanded = false;

  const applyHeight = (height, { dragging = false } = {}) => {
    currentHeight = clamp(height, collapsedHeight, expandedHeight);
    nav.style.height = `${currentHeight}px`;
    nav.style.setProperty('--mobile-bottom-nav-offset', `${currentHeight - collapsedHeight}px`);
    nav.classList.toggle('is-dragging', dragging);
    updateToolbarStackHeight(nav);
  };

  applyHeight(collapsedHeight);

  const onPointerMove = (event) => {
    if (startY === null) return;
    const delta = startY - event.clientY;
    if (!isDragging && Math.abs(delta) > 6) {
      isDragging = true;
      nav.dataset.ignoreClick = '1';
    }
    if (!isDragging) return;
    event.preventDefault();
    applyHeight(startHeight + delta, { dragging: true });
  };

  const settle = () => {
    const midpoint = collapsedHeight + (expandedHeight - collapsedHeight) / 2;
    isExpanded = currentHeight >= midpoint;
    applyHeight(isExpanded ? expandedHeight : collapsedHeight, { dragging: false });
    window.setTimeout(() => delete nav.dataset.ignoreClick, 200);
  };

  nav.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    startY = event.clientY;
    startHeight = currentHeight;
    isDragging = false;
    nav.setPointerCapture(event.pointerId);
  });

  nav.addEventListener('pointermove', onPointerMove);

  nav.addEventListener('pointerup', (event) => {
    if (startY === null) return;
    if (isDragging) event.preventDefault();
    startY = null;
    nav.releasePointerCapture(event.pointerId);
    settle();
  });

  nav.addEventListener('pointercancel', (event) => {
    if (startY === null) return;
    startY = null;
    nav.releasePointerCapture(event.pointerId);
    settle();
  });

  nav.addEventListener('click', (event) => {
    if (!nav.dataset.ignoreClick) return;
    event.preventDefault();
    event.stopPropagation();
  });
}

function initToolbarNow() {
  renderBottomToolbar();
  setupMobileTasksMenu();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initToolbarNow, { once: true });
} else {
  initToolbarNow();
}

// ---------- Modal viewport + iOS focus zoom fix ----------
// iOS Safari zooms when focusing inputs under 16px and can lose scroll when closing fixed-body modals.
(() => {
  let modalLockCount = 0;
  let savedScrollY = 0;

  function lockScrollForModal() {
    if (modalLockCount === 0) {
      savedScrollY = window.scrollY || 0;
      document.body.style.position = 'fixed';
      document.body.style.top = `-${savedScrollY}px`;
      document.body.style.width = '100%';
    }
    modalLockCount += 1;
  }

  function unlockScrollForModal() {
    if (modalLockCount === 0) return;
    modalLockCount -= 1;
    if (modalLockCount > 0) return;

    document.activeElement?.blur?.();

    const restoreY = savedScrollY;
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.scrollTo(0, restoreY);
      });
    });
  }

  window.lockScrollForModal = lockScrollForModal;
  window.unlockScrollForModal = unlockScrollForModal;
})();

// ---------- Shared mobile chrome helpers ----------
const STORAGE_KEY_FALLBACK = (window.TaskPointsCore && TaskPointsCore.STORAGE_KEY) || 'taskpoints_v1';
const PROJECTS_STORAGE_KEY_FALLBACK = (window.TaskPointsCore && TaskPointsCore.PROJECTS_STORAGE_KEY) || 'tp_projects_v1';

const TP_PERSIST_DEBOUNCE_MS = 900;

function setupDebouncedPersistence() {
  const core = window.TaskPointsCore;
  if (!core || core.__tpDebouncedPersistence) return;
  if (typeof core.mergeState !== 'function' || typeof core.saveStateSnapshot !== 'function') return;

  core.__tpDebouncedPersistence = true;
  const originalMergeAndSave = core.mergeAndSaveState.bind(core);
  const pendingByKey = new Map();
  const timers = new Map();

const scheduleFlush = (storageKey) => {
  const existingId = timers.get(storageKey);
  if (existingId) {
    clearTimeout(existingId); // trailing debounce: push the flush out
  }

  const id = window.setTimeout(() => {
    timers.delete(storageKey);

    // Try to flush when the browser is idle (helps iOS Safari feel less janky)
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => flushKey(storageKey), { timeout: 1500 });
    } else {
      flushKey(storageKey);
    }
  }, TP_PERSIST_DEBOUNCE_MS);

  timers.set(storageKey, id);
};


  const flushKey = (storageKey) => {
    const timerId = timers.get(storageKey);
    if (timerId) {
      clearTimeout(timerId);
      timers.delete(storageKey);
    }
    const pending = pendingByKey.get(storageKey);
    if (!pending) return;
    pendingByKey.delete(storageKey);
    const merged = core.mergeState(pending.state, { ...pending.options, storageKey, assumeNormalized: true });
    core.saveStateSnapshot(merged.state, { ...pending.options, storageKey });
  };

  const flushAll = () => {
    Array.from(pendingByKey.keys()).forEach((storageKey) => flushKey(storageKey));
  };

  core.flushPendingSaves = flushAll;

  const debouncedMerge = (nextState, options = {}) => {
    if (window.TP_DEBUG_PERF) {
      console.count('TaskPointsCore.mergeAndSaveState');
    }
    if (options.immediateWrite) {
      flushAll();
      return originalMergeAndSave(nextState, options);
    }
    const storageKey = options.storageKey || core.STORAGE_KEY || STORAGE_KEY_FALLBACK;
    const pending = pendingByKey.get(storageKey);
    const merged = core.mergeState(nextState, {
  ...options,
  storageKey,
  existing: pending?.state,
  assumeNormalized: true
});
    pendingByKey.set(storageKey, { state: merged.state, options: { ...options, storageKey } });
    scheduleFlush(storageKey);
    return { state: merged.state, trimmed: false };
  };

  const debouncedSave = (nextState, options = {}, maybeOptions = {}) => {
    if (window.TP_DEBUG_PERF) {
      console.count('TaskPointsCore.saveAppState');
    }
    if (typeof nextState === 'string') {
      return debouncedMerge(options || {}, { ...maybeOptions, storageKey: nextState });
    }
    return debouncedMerge(nextState || {}, options || {});
  };

  const queueStateSnapshot = (nextState, options = {}) => {
    if (window.TP_DEBUG_PERF) {
      console.count('TaskPointsCore.queueStateSnapshot');
    }
    if (options.immediateWrite) {
      flushAll();
      return core.saveStateSnapshot(nextState, options);
    }
    const storageKey = options.storageKey || core.STORAGE_KEY || STORAGE_KEY_FALLBACK;
    pendingByKey.set(storageKey, { state: nextState, options: { ...options, storageKey } });
    scheduleFlush(storageKey);
    return { state: nextState, trimmed: false };
  };

  core.saveAppState = debouncedSave;
  core.mergeAndSaveState = debouncedMerge;
  core.queueStateSnapshot = queueStateSnapshot;

  if (!window.__tpDebouncedPersistenceListeners) {
    window.__tpDebouncedPersistenceListeners = true;
    window.addEventListener('beforeunload', flushAll);
    // iOS Safari can skip beforeunload; pagehide/freeze ensures a final flush.
    window.addEventListener('pagehide', flushAll, { capture: true });
    window.addEventListener('freeze', flushAll, { capture: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushAll();
    });
  }
}

setupDebouncedPersistence();

const normalizeHexColorFallback = (value) => {
  if (!value) return null;
  let hex = String(value).trim();
  if (!hex) return null;
  if (!hex.startsWith('#')) hex = `#${hex}`;
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) return null;
  if (hex.length === 4) {
    hex = `#${hex.slice(1).split('').map((c) => c + c).join('')}`;
  }
  return hex.toLowerCase();
};

const normalizeHabitTagColorsFallback = (value) => {
  if (!value || typeof value !== 'object') return {};
  const next = {};
  Object.entries(value).forEach(([tag, color]) => {
    const normalized = normalizeHexColorFallback(color);
    if (normalized) next[String(tag)] = normalized;
  });
  return next;
};

const normalizeHabitFallback = (habit) => {
  if (!habit || typeof habit !== 'object') return habit;
  return {
    ...habit,
    tag: typeof habit.tag === 'string' ? habit.tag.trim() : ''
  };
};

const normalizeStateFallback = (s) => {
  const src = s && typeof s === 'object' ? s : {};
  return {
    tasks: Array.isArray(src.tasks) ? src.tasks : [],
    completions: Array.isArray(src.completions) ? src.completions : [],
    players: Array.isArray(src.players) ? src.players : [],
    habits: Array.isArray(src.habits) ? src.habits.map(normalizeHabitFallback) : [],
    flexActions: Array.isArray(src.flexActions) ? src.flexActions : [],
    gameHistory: Array.isArray(src.gameHistory) ? src.gameHistory : [],
    matchups: Array.isArray(src.matchups) ? src.matchups : [],
    schedule: Array.isArray(src.schedule) ? src.schedule : [],
    opponentDripSchedules: Array.isArray(src.opponentDripSchedules) ? src.opponentDripSchedules : [],
    workHistory: Array.isArray(src.workHistory) ? src.workHistory : [],
    youImageId: typeof src.youImageId === 'string' ? src.youImageId : '',
    projects: Array.isArray(src.projects) ? src.projects : [],
    habitTagColors: normalizeHabitTagColorsFallback(src.habitTagColors)
  };
};

const normalizeStateGlobal = window.TaskPointsCore?.normalizeState || normalizeStateFallback;

const IMAGE_DB_NAME_FALLBACK = window.TaskPointsCore?.IMAGE_DB_NAME || 'taskpoints';
const IMAGE_STORE_NAME_FALLBACK = window.TaskPointsCore?.IMAGE_STORE_NAME || 'images';
let imageDbPromiseFallback = null;

function openImageDbFallback() {
  if (imageDbPromiseFallback) return imageDbPromiseFallback;
  imageDbPromiseFallback = new Promise((resolve, reject) => {
    const request = indexedDB.open(IMAGE_DB_NAME_FALLBACK, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IMAGE_STORE_NAME_FALLBACK)) {
        db.createObjectStore(IMAGE_STORE_NAME_FALLBACK);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return imageDbPromiseFallback;
}

function requestToPromiseFallback(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dataUrlToBlobFallback(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/);
  if (!match) return null;
  const mime = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const data = match[3] || '';

  if (isBase64) {
    const binary = atob(data);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  }

  return new Blob([decodeURIComponent(data)], { type: mime });
}

function generateImageIdFallback() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `img_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function saveImageBlobFallback(imageId, blob) {
  if (!imageId || !blob) return;
  const db = await openImageDbFallback();
  const tx = db.transaction(IMAGE_STORE_NAME_FALLBACK, 'readwrite');
  const store = tx.objectStore(IMAGE_STORE_NAME_FALLBACK);
  await requestToPromiseFallback(store.put(blob, imageId));
}

async function getImageBlobFallback(imageId) {
  if (!imageId) return null;
  const db = await openImageDbFallback();
  const tx = db.transaction(IMAGE_STORE_NAME_FALLBACK, 'readonly');
  const store = tx.objectStore(IMAGE_STORE_NAME_FALLBACK);
  const result = await requestToPromiseFallback(store.get(imageId));
  return result || null;
}

async function deleteImageBlobFallback(imageId) {
  if (!imageId) return;
  const db = await openImageDbFallback();
  const tx = db.transaction(IMAGE_STORE_NAME_FALLBACK, 'readwrite');
  const store = tx.objectStore(IMAGE_STORE_NAME_FALLBACK);
  await requestToPromiseFallback(store.delete(imageId));
}

function isImageDataUrlFallback(value) {
  return typeof value === 'string' && value.startsWith('data:image/');
}

async function migrateLegacyImagesFromStateFallback(rawState) {
  if (!rawState || typeof rawState !== 'object') return { state: normalizeStateGlobal(rawState || {}), migrated: false };

  const next = { ...rawState };
  let migrated = false;

  if (isImageDataUrlFallback(next.youImage) && !next.youImageId) {
    const blob = dataUrlToBlobFallback(next.youImage);
    if (blob) {
      const imageId = generateImageIdFallback();
      await saveImageBlobFallback(imageId, blob);
      next.youImageId = imageId;
      migrated = true;
    }
  }
  if (next.youImage) {
    delete next.youImage;
    migrated = true;
  }

  if (Array.isArray(next.players)) {
    const updatedPlayers = [];
    for (const player of next.players) {
      if (!player || typeof player !== 'object') {
        updatedPlayers.push(player);
        continue;
      }
      let updated = { ...player };
      if (isImageDataUrlFallback(updated.imageData) && !updated.imageId) {
        const blob = dataUrlToBlobFallback(updated.imageData);
        if (blob) {
          const imageId = generateImageIdFallback();
          await saveImageBlobFallback(imageId, blob);
          updated.imageId = imageId;
          migrated = true;
        }
      }
      if (updated.imageData) {
        delete updated.imageData;
        migrated = true;
      }
      updatedPlayers.push(updated);
    }
    next.players = updatedPlayers;
  }

  return { state: next, migrated };
}

async function migrateLegacyImagesInStorageFallback() {
  let parsed = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY_FALLBACK);
    parsed = raw ? (JSON.parse(raw) || {}) : {};
  } catch (e) {
    console.error('Failed to parse stored state for image migration (toolbar.js)', e);
    parsed = {};
  }

  const { state: migratedState, migrated } = await migrateLegacyImagesFromStateFallback(parsed);
  if (!migrated) return { state: normalizeStateGlobal(parsed), migrated: false };

  saveStateSnapshotFallback(normalizeStateGlobal(migratedState));
  return { state: normalizeStateGlobal(migratedState), migrated: true };
}

function stripLegacyImageFields(snapshot) {
  const next = { ...snapshot };
  if (next.youImage) delete next.youImage;
  if (Array.isArray(next.players)) {
    next.players = next.players.map((player) => {
      if (!player || typeof player !== 'object') return player;
      const { imageData, ...rest } = player;
      return rest;
    });
  }
  return next;
}

function loadProjectsFromStorageFallback() {
  try {
    const raw = localStorage.getItem(PROJECTS_STORAGE_KEY_FALLBACK);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('Failed to load projects from storage (toolbar.js)', e);
    return [];
  }
}

function saveProjectsToStorageFallback(list) {
  try {
    if (Array.isArray(list)) {
      localStorage.setItem(PROJECTS_STORAGE_KEY_FALLBACK, JSON.stringify(list));
    }
  } catch (e) {
    console.error('Failed to save projects to storage (toolbar.js)', e);
  }
}

function loadRawStateFallback() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_FALLBACK);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch (e) {
    console.error('Failed to load stored state (toolbar.js)', e);
    return {};
  }
}

function dateKeyFallback(dateLike) {
  if (window.TaskPointsCore?.dateKey) return TaskPointsCore.dateKey(dateLike);
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayKeyFallback() {
  if (window.TaskPointsCore?.todayKey) return TaskPointsCore.todayKey();
  return dateKeyFallback(new Date());
}

function shuffleFallback(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function isPlayerActiveFallback(player) {
  return !!player && player.active !== false;
}

function getAllParticipantIdsFallback(state) {
  const ids = ['YOU'];
  (state.players || []).forEach((p) => {
    if (p && p.id && isPlayerActiveFallback(p)) ids.push(p.id);
  });
  return ids;
}

function participantSignatureFallback(ids) {
  return ids.slice().sort().join('|');
}

function buildDailyScheduleFallback(dateKeyStr, participantIds, signature) {
  const pool = participantIds.slice();
  shuffleFallback(pool);

  const matchups = [];
  const byeIds = [];

  for (let i = 0; i + 1 < pool.length; i += 2) {
    matchups.push({ playerAId: pool[i], playerBId: pool[i + 1] });
  }

  if (pool.length % 2 === 1) {
    byeIds.push(pool[pool.length - 1]);
  }

  return {
    date: dateKeyStr,
    matchups,
    byeIds,
    participantSignature: signature
  };
}

function buildDayFromExistingFallback(dateKeyStr, participantIds, signature, matchups) {
  const safeMatchups = (matchups || []).map((m) => ({
    playerAId: m.playerAId,
    playerBId: m.playerBId
  }));
  const used = new Set();
  safeMatchups.forEach((m) => {
    if (m.playerAId) used.add(m.playerAId);
    if (m.playerBId) used.add(m.playerBId);
  });

  const byeIds = participantIds.filter((id) => !used.has(id));

  return {
    date: dateKeyStr,
    matchups: safeMatchups,
    byeIds,
    participantSignature: signature
  };
}

function matchupDateKeyFallback(matchup) {
  if (!matchup) return '';
  if (matchup.dateKey) return matchup.dateKey;
  if (matchup.date) return matchup.date;
  if (matchup.dateISO) return dateKeyFallback(matchup.dateISO);
  return '';
}

function ensureUpcomingScheduleFallback(state, days = 7) {
  const todayKey = todayKeyFallback();
  const participants = getAllParticipantIdsFallback(state);
  const signature = participantSignatureFallback(participants);
  const participantSet = new Set(participants);

  let schedule = Array.isArray(state.schedule)
    ? state.schedule.filter((d) => d && d.date >= todayKey)
    : [];
  let changed = false;

  if (!schedule.every((d) => d.participantSignature === signature)) {
    schedule = [];
    changed = true;
  }

  const neededDates = [];
  const today = new Date(`${todayKey}T00:00:00`);
  for (let i = 0; i < days; i += 1) {
    const dt = new Date(today);
    dt.setDate(dt.getDate() + i);
    neededDates.push(dateKeyFallback(dt));
  }

  const byDate = new Map();
  schedule.forEach((d) => {
    if (d && d.date) byDate.set(d.date, d);
  });

  const existingMatchupsByDate = new Map();
  (state.matchups || []).forEach((m) => {
    if (!m) return;
    const aId = m.playerAId;
    const bId = m.playerBId;
    if (!participantSet.has(aId) || !participantSet.has(bId)) return;
    const key = matchupDateKeyFallback(m);
    if (!key) return;
    if (!existingMatchupsByDate.has(key)) existingMatchupsByDate.set(key, []);
    existingMatchupsByDate.get(key).push({ playerAId: aId, playerBId: bId });
  });

  const rebuilt = neededDates.map((key) => {
    const existing = byDate.get(key);
    if (existing) return existing;
    const syncedFromMatchups = existingMatchupsByDate.get(key);
    if (syncedFromMatchups && syncedFromMatchups.length) {
      return buildDayFromExistingFallback(key, participants, signature, syncedFromMatchups);
    }
    changed = true;
    return buildDailyScheduleFallback(key, participants, signature);
  });

  if (rebuilt.length !== schedule.length) changed = true;

  state.schedule = rebuilt;
  return changed;
}

function saveStateSnapshotFallback(next) {
  try {
    if (window.TaskPointsCore?.saveAppState) {
      const { trimmed } = TaskPointsCore.saveAppState(next, { storageKey: STORAGE_KEY_FALLBACK, immediateWrite: true });
      if (trimmed) {
        console.warn('Storage nearing capacity. Older history items were trimmed to keep saves working.');
      }
      return;
    }
    if (window.TaskPointsCore?.mergeAndSaveState) {
      const { trimmed } = TaskPointsCore.mergeAndSaveState(next, { storageKey: STORAGE_KEY_FALLBACK, immediateWrite: true });
      if (trimmed) {
        console.warn('Storage nearing capacity. Older history items were trimmed to keep saves working.');
      }
      return;
    }
    console.warn('toolbar saveStateSnapshotFallback skipped localStorage write; TaskPointsCore missing.');
  } catch (e) {
    console.error('Failed to save imported state (toolbar.js)', e);
  }
}

function exportDataFallback() {
  window.TaskPointsCore?.flushPendingSaves?.();
  const snapshot = stripLegacyImageFields(normalizeStateGlobal({ ...loadRawStateFallback(), projects: loadProjectsFromStorageFallback() }));
  const scheduleChanged = ensureUpcomingScheduleFallback(snapshot);
  if (scheduleChanged) {
    saveStateSnapshotFallback(snapshot);
  }
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const now = new Date();

  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');

  const filename = `taskpoints-backup-${y}-${mo}-${d}_${hh}-${mm}-${ss}.json`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const CRC32_TABLE_FALLBACK = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Fallback(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC32_TABLE_FALLBACK[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeUint32LE(buffer, offset, value) {
  buffer[offset] = value & 0xFF;
  buffer[offset + 1] = (value >>> 8) & 0xFF;
  buffer[offset + 2] = (value >>> 16) & 0xFF;
  buffer[offset + 3] = (value >>> 24) & 0xFF;
}

function writeUint16LE(buffer, offset, value) {
  buffer[offset] = value & 0xFF;
  buffer[offset + 1] = (value >>> 8) & 0xFF;
}

async function buildZipBlobFallback(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.path);
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const crc = crc32Fallback(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    writeUint32LE(localHeader, 0, 0x04034b50);
    writeUint16LE(localHeader, 4, 20);
    writeUint16LE(localHeader, 6, 0);
    writeUint16LE(localHeader, 8, 0);
    writeUint16LE(localHeader, 10, 0);
    writeUint16LE(localHeader, 12, 0);
    writeUint32LE(localHeader, 14, crc);
    writeUint32LE(localHeader, 18, data.length);
    writeUint32LE(localHeader, 22, data.length);
    writeUint16LE(localHeader, 26, nameBytes.length);
    writeUint16LE(localHeader, 28, 0);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    writeUint32LE(centralHeader, 0, 0x02014b50);
    writeUint16LE(centralHeader, 4, 20);
    writeUint16LE(centralHeader, 6, 20);
    writeUint16LE(centralHeader, 8, 0);
    writeUint16LE(centralHeader, 10, 0);
    writeUint16LE(centralHeader, 12, 0);
    writeUint16LE(centralHeader, 14, 0);
    writeUint32LE(centralHeader, 16, crc);
    writeUint32LE(centralHeader, 20, data.length);
    writeUint32LE(centralHeader, 24, data.length);
    writeUint16LE(centralHeader, 28, nameBytes.length);
    writeUint16LE(centralHeader, 30, 0);
    writeUint16LE(centralHeader, 32, 0);
    writeUint16LE(centralHeader, 34, 0);
    writeUint16LE(centralHeader, 36, 0);
    writeUint32LE(centralHeader, 38, 0);
    writeUint32LE(centralHeader, 42, offset);
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = new Uint8Array(22);
  writeUint32LE(endRecord, 0, 0x06054b50);
  writeUint16LE(endRecord, 4, 0);
  writeUint16LE(endRecord, 6, 0);
  writeUint16LE(endRecord, 8, files.length);
  writeUint16LE(endRecord, 10, files.length);
  writeUint32LE(endRecord, 12, centralSize);
  writeUint32LE(endRecord, 16, offset);
  writeUint16LE(endRecord, 20, 0);

  return new Blob([...localParts, ...centralParts, endRecord], { type: 'application/zip' });
}

function extensionForImageBlob(blob) {
  const type = blob?.type || '';
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  return 'bin';
}

function isZipFileFallback(file) {
  if (!file) return false;
  const name = file.name || '';
  return file.type === 'application/zip' || name.toLowerCase().endsWith('.zip');
}

function mimeForImageExtension(ext) {
  const normalized = ext.toLowerCase();
  if (normalized === 'png') return 'image/png';
  if (normalized === 'webp') return 'image/webp';
  if (normalized === 'gif') return 'image/gif';
  if (normalized === 'jpg' || normalized === 'jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

function readZipEntriesFallback(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const decoder = new TextDecoder();
  const entries = new Map();
  let offset = 0;

  while (offset + 30 <= bytes.length) {
    const signature = view.getUint32(offset, true);
    if (signature !== 0x04034b50) break;
    const flags = view.getUint16(offset + 6, true);
    const compression = view.getUint16(offset + 8, true);
    if (flags & 0x08) {
      throw new Error('Zip entries with data descriptors are not supported.');
    }
    if (compression !== 0) {
      throw new Error('Only stored (uncompressed) zip entries are supported.');
    }
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);

    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    const extraEnd = nameEnd + extraLength;
    const dataStart = extraEnd;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > bytes.length) {
      throw new Error('Zip entry is truncated.');
    }

    const name = decoder.decode(bytes.slice(nameStart, nameEnd));
    const data = bytes.slice(dataStart, dataEnd);
    entries.set(name, { data });
    offset = dataEnd;
  }

  return entries;
}

async function importBackupZipFallback(file) {
  const entries = readZipEntriesFallback(await file.arrayBuffer());
  let manifestEntry = entries.get('manifest.json');
  if (!manifestEntry) {
    for (const [name, entry] of entries.entries()) {
      if (name.endsWith('/manifest.json')) {
        manifestEntry = entry;
        break;
      }
    }
  }
  if (!manifestEntry) {
    throw new Error('manifest.json not found in zip.');
  }

  const manifestText = new TextDecoder().decode(manifestEntry.data);
  const manifest = JSON.parse(manifestText);

  const saveImageBlob = window.TaskPointsCore?.saveImageBlob || saveImageBlobFallback;

  for (const [name, entry] of entries.entries()) {
    if (name.endsWith('/')) continue;
    const normalized = name.replace(/\\/g, '/');
    if (!normalized.includes('/images/') && !normalized.startsWith('images/')) continue;
    const fileName = normalized.split('/').pop() || '';
    if (!fileName) continue;
    const dotIndex = fileName.lastIndexOf('.');
    const imageId = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
    const ext = dotIndex > 0 ? fileName.slice(dotIndex + 1) : '';
    if (!imageId) continue;
    const blob = new Blob([entry.data], { type: mimeForImageExtension(ext) });
    await saveImageBlob(imageId, blob);
  }

  return manifest;
}

async function exportBackupWithImagesFallback() {
  window.TaskPointsCore?.flushPendingSaves?.();
  const snapshot = stripLegacyImageFields(normalizeStateGlobal({ ...loadRawStateFallback(), projects: loadProjectsFromStorageFallback() }));
  const scheduleChanged = ensureUpcomingScheduleFallback(snapshot);
  if (scheduleChanged) {
    saveStateSnapshotFallback(snapshot);
  }
  const imageIds = new Set();
  if (snapshot.youImageId) imageIds.add(snapshot.youImageId);
  if (Array.isArray(snapshot.players)) {
    snapshot.players.forEach((player) => {
      if (player?.imageId) imageIds.add(player.imageId);
    });
  }

  const files = [
    { path: 'manifest.json', blob: new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }) }
  ];

  const getImageBlob = window.TaskPointsCore?.getImageBlob || getImageBlobFallback;

  for (const imageId of imageIds) {
    const blob = await getImageBlob(imageId);
    if (!blob) continue;
    const ext = extensionForImageBlob(blob);
    files.push({ path: `images/${imageId}.${ext}`, blob });
  }

  const zipBlob = await buildZipBlobFallback(files);
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const filename = `taskpoints-backup-with-images-${y}-${mo}-${d}_${hh}-${mm}-${ss}.zip`;

  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function applyImportedStateFallback(root) {
  if (typeof window.applyImportedState === 'function') {
    await window.applyImportedState(root);
    return;
  }

  let normalized = normalizeStateGlobal({
    tasks: Array.isArray(root?.tasks) ? root.tasks : [],
    completions: Array.isArray(root?.completions) ? root.completions : [],
    players: Array.isArray(root?.players) ? root.players : [],
    habits: Array.isArray(root?.habits) ? root.habits : [],
    flexActions: Array.isArray(root?.flexActions) ? root.flexActions : [],
    gameHistory: Array.isArray(root?.gameHistory) ? root.gameHistory : [],
    matchups: Array.isArray(root?.matchups) ? root.matchups : [],
    schedule: Array.isArray(root?.schedule) ? root.schedule : [],
    opponentDripSchedules: Array.isArray(root?.opponentDripSchedules) ? root.opponentDripSchedules : [],
    workHistory: Array.isArray(root?.workHistory) ? root.workHistory : [],
    youImageId: typeof root?.youImageId === 'string' ? root.youImageId : '',
    projects: Array.isArray(root?.projects) ? root.projects : loadProjectsFromStorageFallback(),
    habitTagColors: root?.habitTagColors ?? {}
  });

  const migrate = window.TaskPointsCore?.migrateLegacyImages || migrateLegacyImagesFromStateFallback;
  if (typeof migrate === 'function') {
    const migrated = await migrate(root);
    if (migrated?.migrated) {
      normalized = stripLegacyImageFields(normalizeStateGlobal({
        ...migrated.state,
        projects: normalized.projects
      }));
    }
  }

  saveProjectsToStorageFallback(normalized.projects || []);
  saveStateSnapshotFallback(normalized);
  window.location.reload();
}

async function importFileFallback(ev) {
  const f = ev.target.files?.[0];
  if (!f) return;

  if (isZipFileFallback(f)) {
    try {
      const manifest = await importBackupZipFallback(f);
      const root =
        (manifest && Array.isArray(manifest.tasks) && Array.isArray(manifest.completions)) ? manifest :
        (manifest && manifest.state && Array.isArray(manifest.state.tasks) && Array.isArray(manifest.state.completions)) ? manifest.state :
        null;

      if (!root) {
        throw new Error('Root object missing tasks/completions arrays');
      }

      await applyImportedStateFallback(root);
    } catch (err) {
      console.error('Failed to import zip backup', err);
      alert('Import failed. Make sure the zip was exported from TaskPoints.');
    } finally {
      ev.target.value = '';
    }
    return;
  }

  const r = new FileReader();
  r.onload = () => {
    let data;
    try {
      data = JSON.parse(String(r.result));
      console.log('JSON parsed OK (file import):', data);
    } catch (err) {
      console.error('ACTUAL PARSE ERROR (file import):', err);
      alert('The file is not valid JSON. Check console for details.');
      return;
    }

    try {
      const root =
        (data && Array.isArray(data.tasks) && Array.isArray(data.completions)) ? data :
        (data && data.state && Array.isArray(data.state.tasks) && Array.isArray(data.state.completions)) ? data.state :
        null;

      if (!root) {
        throw new Error('Root object missing tasks/completions arrays');
      }

      applyImportedStateFallback(root).catch((err) => {
        console.error('Failed to apply imported state (file)', err);
        alert('Failed to apply imported data. Check console for details.');
      });
    } catch (logicErr) {
      console.error('LOGIC ERROR during import (file):', logicErr);
      alert('JSON was valid, but the app crashed trying to load it. Check console.');
    }
  };

  r.readAsText(f);
  ev.target.value = '';
}

function importPasteFallback() {
  const txt = prompt('Paste TaskPoints JSON:');
  if (!txt) return;

  let data;
  try {
    data = JSON.parse(txt);
    console.log('JSON parsed OK (paste):', data);
  } catch (err) {
    console.error('ACTUAL PARSE ERROR (paste):', err);
    alert('The text is not valid JSON. Check console for details.');
    return;
  }

  try {
    const root =
      (data && Array.isArray(data.tasks) && Array.isArray(data.completions)) ? data :
      (data && data.state && Array.isArray(data.state.tasks) && Array.isArray(data.state.completions)) ? data.state :
      null;

    if (!root) {
      throw new Error('Root object missing tasks/completions arrays');
    }

    applyImportedStateFallback(root).catch((err) => {
      console.error('Failed to apply imported state (paste)', err);
      alert('Failed to apply imported data. Check console for details.');
    });
  } catch (logicErr) {
    console.error('LOGIC ERROR during import (paste):', logicErr);
    alert('JSON was valid, but the app crashed trying to load it. Check console.');
  }
}

function getHandler(name, fallback) {
  if (typeof window[name] === 'function') return window[name];
  return fallback;
}

function exportOGDataOnly() {
  window.TaskPointsCore?.flushPendingSaves?.();
  if (typeof window.exportData === 'function' && window.exportData !== exportOGDataOnly) {
    return window.exportData();
  }
  return exportDataFallback();
}

function exportBackupWithImages() {
  window.TaskPointsCore?.flushPendingSaves?.();
  if (typeof window.exportBackupWithImages === 'function' && window.exportBackupWithImages !== exportBackupWithImages) {
    return window.exportBackupWithImages();
  }
  return exportBackupWithImagesFallback();
}

if (typeof window.exportOGDataOnly !== 'function') {
  window.exportOGDataOnly = exportOGDataOnly;
}

if (typeof window.exportBackupWithImages !== 'function') {
  window.exportBackupWithImages = exportBackupWithImages;
}

document.addEventListener('DOMContentLoaded', () => {
  const fileHandler = getHandler('importFile', importFileFallback);
  const pasteHandler = getHandler('importPaste', importPasteFallback);

  document.querySelectorAll('[data-export-button]').forEach((btn) => {
    btn.addEventListener('click', exportBackupWithImages);
  });
  document.querySelectorAll('[data-export-images]').forEach((btn) => {
    btn.addEventListener('click', exportOGDataOnly);
  });

  document.querySelectorAll('[data-import-input]').forEach((input) => {
    if (input instanceof HTMLInputElement) {
      input.accept = 'application/json,application/zip,.zip';
    }
    input.addEventListener('change', fileHandler);
  });

  document.querySelectorAll('[data-import-paste]').forEach((btn) => {
    btn.addEventListener('click', pasteHandler);
  });

  const scrollButtons = Array.from(document.querySelectorAll('[data-scroll-top]'));
  if (scrollButtons.length) {
    const updateVisibility = () => {
      const shouldShow = window.scrollY > 40;
      scrollButtons.forEach((btn) => {
        if (shouldShow) btn.classList.remove('hidden');
        else btn.classList.add('hidden');
      });
    };

    window.addEventListener('scroll', updateVisibility, { passive: true });
    window.addEventListener('load', updateVisibility);

    scrollButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

  const migrate = window.TaskPointsCore?.migrateLegacyImagesInStorage || migrateLegacyImagesInStorageFallback;
  if (typeof migrate === 'function') {
    migrate();
  }
});
