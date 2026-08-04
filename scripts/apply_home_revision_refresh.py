from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'Expected exactly one {label}; found {count}')
    return text.replace(old, new, 1)


toolbar_path = Path('toolbar.js')
toolbar = toolbar_path.read_text(encoding='utf-8')
toolbar_marker = "window.TP_DEBUG_PERF = window.TP_DEBUG_PERF ?? false;\n\nconst scheduleRender"
toolbar_insert = r'''window.TP_DEBUG_PERF = window.TP_DEBUG_PERF ?? false;

(function installTaskPointsStateRevision(global) {
  if (global.TaskPointsStateRevision?.installed) return;

  const storage = global.localStorage;
  if (!storage) return;

  const REVISION_KEY = 'taskpoints_state_revision_v1';
  const TRACKED_KEYS = new Set([
    global.TaskPointsCore?.STORAGE_KEY || 'taskpoints_v1',
    global.TaskPointsCore?.PENDING_HABIT_DELTAS_KEY || 'taskpoints_pending_habit_deltas_v1',
    'tp_projects_v1'
  ]);
  const baseSetItem = storage.setItem.bind(storage);
  const baseRemoveItem = storage.removeItem.bind(storage);
  const baseClear = storage.clear.bind(storage);
  let sequence = 0;

  const read = () => {
    try { return storage.getItem(REVISION_KEY) || ''; }
    catch (_) { return ''; }
  };

  const createRevision = () => {
    sequence += 1;
    return `${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  };

  const publishRevision = (reason = 'state-write', emitEvent = true) => {
    const revision = createRevision();
    baseSetItem(REVISION_KEY, revision);
    if (emitEvent && typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
      global.dispatchEvent(new CustomEvent('taskpoints:state-revision', {
        detail: { revision, reason }
      }));
    }
    return revision;
  };

  const installOnStorageObject = () => {
    try {
      const wrappedSetItem = function taskPointsRevisionSetItem(key, value) {
        const result = baseSetItem(key, value);
        if (TRACKED_KEYS.has(String(key))) publishRevision(`set:${String(key)}`);
        return result;
      };
      const wrappedRemoveItem = function taskPointsRevisionRemoveItem(key) {
        const result = baseRemoveItem(key);
        if (TRACKED_KEYS.has(String(key))) publishRevision(`remove:${String(key)}`);
        return result;
      };
      const wrappedClear = function taskPointsRevisionClear() {
        const result = baseClear();
        publishRevision('clear');
        return result;
      };

      storage.setItem = wrappedSetItem;
      storage.removeItem = wrappedRemoveItem;
      storage.clear = wrappedClear;
      return storage.setItem === wrappedSetItem
        && storage.removeItem === wrappedRemoveItem
        && storage.clear === wrappedClear;
    } catch (_) {
      return false;
    }
  };

  const installOnStoragePrototype = () => {
    const prototype = global.Storage?.prototype;
    if (!prototype || prototype.__taskPointsStateRevisionHookInstalled) return false;

    try {
      const originalSetItem = prototype.setItem;
      const originalRemoveItem = prototype.removeItem;
      const originalClear = prototype.clear;

      Object.defineProperty(prototype, '__taskPointsStateRevisionHookInstalled', {
        value: true,
        configurable: true
      });

      prototype.setItem = function taskPointsRevisionSetItem(key, value) {
        const result = originalSetItem.call(this, key, value);
        if (this === storage && TRACKED_KEYS.has(String(key))) publishRevision(`set:${String(key)}`);
        return result;
      };
      prototype.removeItem = function taskPointsRevisionRemoveItem(key) {
        const result = originalRemoveItem.call(this, key);
        if (this === storage && TRACKED_KEYS.has(String(key))) publishRevision(`remove:${String(key)}`);
        return result;
      };
      prototype.clear = function taskPointsRevisionClear() {
        const result = originalClear.call(this);
        if (this === storage) publishRevision('clear');
        return result;
      };
      return true;
    } catch (_) {
      return false;
    }
  };

  const installed = installOnStorageObject() || installOnStoragePrototype();
  global.TaskPointsStateRevision = {
    installed,
    key: REVISION_KEY,
    trackedKeys: Array.from(TRACKED_KEYS),
    read,
    bump: publishRevision,
    ensure: () => read() || publishRevision('bootstrap', false)
  };
  global.TaskPointsStateRevision.ensure();
})(window);

const scheduleRender'''
if 'installTaskPointsStateRevision' not in toolbar:
    toolbar = replace_once(toolbar, toolbar_marker, toolbar_insert, 'toolbar insertion marker')
    toolbar_path.write_text(toolbar, encoding='utf-8')

index_path = Path('index.html')
index = index_path.read_text(encoding='utf-8')

constants_marker = '''const PROJECTS_STORAGE_KEY="tp_projects_v1";
const TODAY_STORE_KEY="taskpoints_today_view_v1";'''
constants_insert = '''const PROJECTS_STORAGE_KEY="tp_projects_v1";
const TODAY_STORE_KEY="taskpoints_today_view_v1";
let loadedStateRevision = '';

function readHomeStateRevision() {
  try {
    return String(
      window.TaskPointsStateRevision?.read?.()
      || localStorage.getItem('taskpoints_state_revision_v1')
      || ''
    );
  } catch (_) {
    return '';
  }
}

function markHomeStateRevisionCurrent() {
  loadedStateRevision = readHomeStateRevision();
  return loadedStateRevision;
}'''
if 'function readHomeStateRevision()' not in index:
    index = replace_once(index, constants_marker, constants_insert, 'Home constants marker')

save_marker = '''    } catch (e2) {
      console.error("Last-ditch save failed (index.html)", e2);
    }
  }
}
'''
save_insert = '''    } catch (e2) {
      console.error("Last-ditch save failed (index.html)", e2);
    }
  } finally {
    markHomeStateRevisionCurrent();
  }
}
'''
if 'finally {\n    markHomeStateRevisionCurrent();' not in index:
    index = replace_once(index, save_marker, save_insert, 'Home save finalizer marker')

initial_marker = '''// Preserve first-load daily initialization without re-reading storage.
maybeAutoSimToday();
state = syncStateWithMatchups(state);

renderHabitWeekLabels();'''
initial_insert = '''// Preserve first-load daily initialization without re-reading storage.
maybeAutoSimToday();
state = syncStateWithMatchups(state);
markHomeStateRevisionCurrent();

renderHabitWeekLabels();'''
if 'state = syncStateWithMatchups(state);\nmarkHomeStateRevisionCurrent();' not in index:
    index = replace_once(index, initial_marker, initial_insert, 'Home initial revision marker')

refresh_marker = '''function refreshMainPageFromStorage() {
  storageCache.raw = null;
  storageCache.parsed = null;
  state = normalizeState(load());

  const autoSimRan = maybeAutoSimToday();

  if (autoSimRan) {
    storageCache.raw = null;
    storageCache.parsed = null;
    state = normalizeState(load());
  }

  state = syncStateWithMatchups(state);
  scheduleRender(renderAll);
}

let hasCompletedInitialPageShow = false;

window.addEventListener('pageshow', (event) => {
  if (!hasCompletedInitialPageShow) {
    hasCompletedInitialPageShow = true;

    if (event.persisted) {
      refreshMainPageFromStorage();
    }

    return;
  }

  refreshMainPageFromStorage();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshMainPageFromStorage();
});'''
refresh_insert = '''function refreshMainPageFromStorage() {
  storageCache.raw = null;
  storageCache.parsed = null;
  state = normalizeState(load());

  const autoSimRan = maybeAutoSimToday();

  if (autoSimRan) {
    storageCache.raw = null;
    storageCache.parsed = null;
    state = normalizeState(load());
  }

  state = syncStateWithMatchups(state);
  scheduleRender(renderAll);
  markHomeStateRevisionCurrent();
  return true;
}

function refreshMainPageIfChanged(reason = 'lifecycle') {
  const currentRevision = readHomeStateRevision();
  if (currentRevision && loadedStateRevision && currentRevision === loadedStateRevision) {
    if (window.TP_DEBUG_PERF) {
      console.log(`[TP home refresh] skipped unchanged ${reason} revision=${currentRevision}`);
    }
    return false;
  }

  return refreshMainPageFromStorage();
}

let hasCompletedInitialPageShow = false;

window.addEventListener('pageshow', (event) => {
  if (!hasCompletedInitialPageShow) {
    hasCompletedInitialPageShow = true;

    if (event.persisted) {
      refreshMainPageIfChanged('initial-bfcache-pageshow');
    }

    return;
  }

  refreshMainPageIfChanged('pageshow');
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshMainPageIfChanged('visibilitychange');
});'''
if 'function refreshMainPageIfChanged(' not in index:
    index = replace_once(index, refresh_marker, refresh_insert, 'Home lifecycle refresh block')

index_path.write_text(index, encoding='utf-8')

test_path = Path('tests/home_revision_refresh_contract.test.js')
test_path.write_text(r'''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const toolbar = fs.readFileSync(path.join(root, 'toolbar.js'), 'utf8');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('shared toolbar stamps a small revision for authoritative Home data writes', () => {
  assert.match(toolbar, /installTaskPointsStateRevision/);
  assert.match(toolbar, /taskpoints_state_revision_v1/);
  assert.match(toolbar, /taskpoints_v1/);
  assert.match(toolbar, /taskpoints_pending_habit_deltas_v1/);
  assert.match(toolbar, /tp_projects_v1/);
  assert.match(toolbar, /storage\.setItem = wrappedSetItem/);
  assert.match(toolbar, /storage\.removeItem = wrappedRemoveItem/);
  assert.match(toolbar, /storage\.clear = wrappedClear/);
});

test('Home skips lifecycle reloads when its loaded revision is current', () => {
  assert.match(home, /let loadedStateRevision = '';/);
  assert.match(home, /function readHomeStateRevision\(\)/);
  assert.match(home, /function refreshMainPageIfChanged\(reason = 'lifecycle'\)/);
  assert.match(home, /currentRevision === loadedStateRevision/);
  assert.match(home, /refreshMainPageIfChanged\('initial-bfcache-pageshow'\)/);
  assert.match(home, /refreshMainPageIfChanged\('pageshow'\)/);
  assert.match(home, /refreshMainPageIfChanged\('visibilitychange'\)/);
});

test('Home updates its revision after initial load, saves, and real refreshes', () => {
  const marks = home.match(/markHomeStateRevisionCurrent\(\);/g) || [];
  assert.ok(marks.length >= 3, `expected at least 3 revision baseline updates, found ${marks.length}`);
  assert.match(home, /state = syncStateWithMatchups\(state\);\s*markHomeStateRevisionCurrent\(\);\s*renderHabitWeekLabels/);
  assert.match(home, /finally \{\s*markHomeStateRevisionCurrent\(\);\s*\}/);
  assert.match(home, /scheduleRender\(renderAll\);\s*markHomeStateRevisionCurrent\(\);\s*return true;/);
});
''', encoding='utf-8')

required = [
    'installTaskPointsStateRevision',
    'taskpoints_state_revision_v1',
    'function refreshMainPageIfChanged(',
    "refreshMainPageIfChanged('pageshow')",
    "refreshMainPageIfChanged('visibilitychange')",
]
combined = toolbar_path.read_text(encoding='utf-8') + '\n' + index_path.read_text(encoding='utf-8')
for item in required:
    if item not in combined:
        raise SystemExit(f'Missing required revision-refresh contract: {item}')
