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

// ---------- Shared mobile chrome helpers ----------
const STORAGE_KEY_FALLBACK = (window.TaskPointsCore && TaskPointsCore.STORAGE_KEY) || 'taskpoints_v1';
const PROJECTS_STORAGE_KEY_FALLBACK = (window.TaskPointsCore && TaskPointsCore.PROJECTS_STORAGE_KEY) || 'tp_projects_v1';

const normalizeStateFallback = (s) => {
  const src = s && typeof s === 'object' ? s : {};
  return {
    tasks: Array.isArray(src.tasks) ? src.tasks : [],
    completions: Array.isArray(src.completions) ? src.completions : [],
    players: Array.isArray(src.players) ? src.players : [],
    habits: Array.isArray(src.habits) ? src.habits : [],
    flexActions: Array.isArray(src.flexActions) ? src.flexActions : [],
    gameHistory: Array.isArray(src.gameHistory) ? src.gameHistory : [],
    matchups: Array.isArray(src.matchups) ? src.matchups : [],
    schedule: Array.isArray(src.schedule) ? src.schedule : [],
    opponentDripSchedules: Array.isArray(src.opponentDripSchedules) ? src.opponentDripSchedules : [],
    workHistory: Array.isArray(src.workHistory) ? src.workHistory : [],
    youImage: typeof src.youImage === 'string' ? src.youImage : '',
    projects: Array.isArray(src.projects) ? src.projects : [],
  };
};

const normalizeStateGlobal = window.TaskPointsCore?.normalizeState || normalizeStateFallback;

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
    localStorage.setItem(STORAGE_KEY_FALLBACK, JSON.stringify(next));
  } catch (e) {
    console.error('Failed to save imported state (toolbar.js)', e);
  }
}

function exportDataFallback() {
  const snapshot = normalizeStateGlobal({ ...loadRawStateFallback(), projects: loadProjectsFromStorageFallback() });
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

function applyImportedStateFallback(root) {
  if (typeof window.applyImportedState === 'function') {
    window.applyImportedState(root);
    return;
  }

  const normalized = normalizeStateGlobal({
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
    youImage: typeof root?.youImage === 'string' ? root.youImage : '',
    projects: Array.isArray(root?.projects) ? root.projects : loadProjectsFromStorageFallback(),
  });

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

      applyImportedStateFallback(root);
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

    applyImportedStateFallback(root);
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
  const fileHandler = getHandler('importFile', importFileFallback);
  const pasteHandler = getHandler('importPaste', importPasteFallback);

  document.querySelectorAll('[data-export-button]').forEach((btn) => {
    btn.addEventListener('click', exportHandler);
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
});
