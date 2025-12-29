function closeAllDropdowns(exception) {
  document.querySelectorAll('.dropdown.open').forEach((dropdown) => {
    if (dropdown === exception) return;
    dropdown.classList.remove('open');
    const toggle = dropdown.querySelector('[data-dropdown-toggle]');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.dropdown').forEach((dropdown) => {
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

      const isOpening = !dropdown.classList.contains('open');
      closeAllDropdowns(isOpening ? dropdown : null);

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
  const onIndex = /(^|\/)index\.html$/.test(window.location.pathname) || window.location.pathname === '/' || window.location.pathname === '';
  const linkFor = (anchor) => (onIndex ? `#${anchor}` : `index.html#${anchor}`);

  return `
    <a href="${linkFor('sleepAnchor')}" class="flex flex-col items-center gap-0.5 opacity-80 hover:opacity-100">
      <span class="text-lg">💤</span>
      <span class="uppercase tracking-wide text-[10px]">Sleep</span>
    </a>

    <a href="${linkFor('habitsAnchor')}" class="flex flex-col items-center gap-0.5 opacity-80 hover:opacity-100">
      <span class="text-lg">🔗</span>
      <span class="uppercase tracking-wide text-[10px]">Habits</span>
    </a>

    <div class="mobile-task-dropdown">
      <button
        id="mobileTasksToggle"
        type="button"
        class="flex flex-col items-center gap-0.5 opacity-80 hover:opacity-100"
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

    <a href="game.html" class="flex flex-col items-center gap-0.5 opacity-80 hover:opacity-100">
      <span class="text-lg">👥</span>
      <span class="uppercase tracking-wide text-[10px]">Players</span>
    </a>

    <a href="settings.html" class="flex flex-col items-center gap-0.5 opacity-80 hover:opacity-100">
      <span class="text-lg">⚙️</span>
      <span class="uppercase tracking-wide text-[10px]">Settings</span>
    </a>
  `;
}

function ensureMobileBottomNav() {
  let nav = document.getElementById('mobileBottomNav');
  if (!nav) {
    nav = document.createElement('nav');
    nav.id = 'mobileBottomNav';
    nav.className =
      'mobile-bottom-nav-shell fixed inset-x-0 bottom-0 z-40 md:hidden border-t border-slate-800 backdrop-blur text-slate-100 drop-shadow-sm';
    nav.style.background = 'linear-gradient(180deg, #0f4d4d, #0a2f2f)';

    const inner = document.createElement('div');
    inner.className = 'max-w-6xl mx-auto flex justify-center py-3 pb-4 text-[11px] mobile-bottom-nav';
    inner.innerHTML = buildMobileBottomNavLinks();
    nav.appendChild(inner);

    document.body.appendChild(nav);
  } else {
    const inner = nav.querySelector('.mobile-bottom-nav');
    if (inner) inner.innerHTML = buildMobileBottomNavLinks();
  }

}

function setupMobileTasksMenu() {
  const toggle = document.getElementById('mobileTasksToggle');
  const menu = document.getElementById('mobileTasksMenu');
  const addBtn = document.getElementById('mobileAddTaskBtn');
  const goBtn = document.getElementById('mobileGoTasksBtn');

  if (!toggle || !menu) return;

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

  document.addEventListener('pointerdown', (e) => {
    if (menu.classList.contains('hidden')) return;
    if (e.target.closest('.mobile-task-dropdown')) return;
    closeMenu();
  });

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

  window.addEventListener('resize', () => {
    if (window.innerWidth >= 768) closeMenu();
  });

  toggle.addEventListener('keyup', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleMenu();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  ensureMobileBottomNav();
  setupMobileTasksMenu();
});

// ---------- Shared mobile chrome helpers ----------
const STORAGE_KEY_FALLBACK = (window.TaskPointsCore && TaskPointsCore.STORAGE_KEY) || 'taskpoints_v1';
const PROJECTS_STORAGE_KEY_FALLBACK = (window.TaskPointsCore && TaskPointsCore.PROJECTS_STORAGE_KEY) || 'tp_projects_v1';

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

function saveStateSnapshotFallback(next) {
  try {
    if (window.TaskPointsCore?.mergeAndSaveState) {
      const { trimmed } = TaskPointsCore.mergeAndSaveState(next, { storageKey: STORAGE_KEY_FALLBACK });
      if (trimmed) {
        console.warn('Storage nearing capacity. Older history items were trimmed to keep saves working.');
      }
      return;
    }
    localStorage.setItem(STORAGE_KEY_FALLBACK, JSON.stringify(next));
  } catch (e) {
    console.error('Failed to save imported state (toolbar.js)', e);
  }
}

function exportDataFallback() {
  const snapshot = stripLegacyImageFields(normalizeStateGlobal({ ...loadRawStateFallback(), projects: loadProjectsFromStorageFallback() }));
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

async function exportBackupWithImagesFallback() {
  const snapshot = stripLegacyImageFields(normalizeStateGlobal({ ...loadRawStateFallback(), projects: loadProjectsFromStorageFallback() }));
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

function importFileFallback(ev) {
  const f = ev.target.files?.[0];
  if (!f) return;

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

document.addEventListener('DOMContentLoaded', () => {
  const exportHandler = getHandler('exportData', exportDataFallback);
  const exportImagesHandler = getHandler('exportBackupWithImages', exportBackupWithImagesFallback);
  const fileHandler = getHandler('importFile', importFileFallback);
  const pasteHandler = getHandler('importPaste', importPasteFallback);

  document.querySelectorAll('[data-export-button]').forEach((btn) => {
    btn.addEventListener('click', exportHandler);
  });
  document.querySelectorAll('[data-export-images]').forEach((btn) => {
    btn.addEventListener('click', exportImagesHandler);
  });

  document.querySelectorAll('[data-import-input]').forEach((input) => {
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
