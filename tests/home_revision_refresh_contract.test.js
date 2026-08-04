const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const toolbar = fs.readFileSync(path.join(root, 'toolbar.js'), 'utf8');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${signature}`);
}

function createStorageRuntime() {
  class FakeStorage {
    constructor() {
      this.values = new Map();
      this.failRevisionWrites = false;
    }
    getItem(key) {
      const normalized = String(key);
      return this.values.has(normalized) ? this.values.get(normalized) : null;
    }
    setItem(key, value) {
      const normalized = String(key);
      if (normalized === 'taskpoints_state_revision_v1' && this.failRevisionWrites) {
        throw new Error('quota');
      }
      this.values.set(normalized, String(value));
    }
    removeItem(key) { this.values.delete(String(key)); }
    clear() { this.values.clear(); }
  }

  class FakeCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  const localStorage = new FakeStorage();
  const events = [];
  const window = {
    Storage: FakeStorage,
    localStorage,
    CustomEvent: FakeCustomEvent,
    dispatchEvent(event) { events.push(event); return true; }
  };
  const context = {
    window,
    CustomEvent: FakeCustomEvent,
    console,
    Date,
    Math,
    String,
    Set,
    Array,
    Object,
    Error
  };

  const revisionStart = toolbar.indexOf('(function installTaskPointsStateRevision(global) {');
  const revisionEnd = toolbar.indexOf('})(window);', revisionStart) + '})(window);'.length;
  assert.ok(revisionStart >= 0 && revisionEnd > revisionStart, 'missing revision installer');
  const revisionSource = toolbar.slice(revisionStart, revisionEnd);
  const bridgeSource = extractFunction(toolbar, 'function installToolbarStorageBridge()');
  vm.runInNewContext(`${revisionSource}\n${bridgeSource}\ninstallToolbarStorageBridge();`, context);

  return { window, localStorage, events };
}

test('revision stamping stays inside the existing storage-change bridge', () => {
  assert.doesNotMatch(toolbar, /storage\.setItem = wrappedSetItem/);
  assert.doesNotMatch(toolbar, /storage\.removeItem = wrappedRemoveItem/);
  assert.doesNotMatch(toolbar, /storage\.clear = wrappedClear/);
  assert.match(toolbar, /function installToolbarStorageBridge\(\)/);
  assert.match(toolbar, /revision\?\.shouldTrack\?\.\(normalizedKey\)/);
  assert.match(toolbar, /markHookInstalled/);

  const { window, localStorage, events } = createStorageRuntime();
  assert.equal(Object.hasOwn(localStorage, 'setItem'), false);
  assert.equal(window.TaskPointsStateRevision.hookInstalled, true);

  const priorRevision = window.TaskPointsStateRevision.read();
  localStorage.setItem('taskpoints_v1', 'state-one');
  assert.equal(localStorage.getItem('taskpoints_v1'), 'state-one');
  assert.notEqual(window.TaskPointsStateRevision.read(), priorRevision);
  assert.equal(events.filter((event) => event.type === 'tp:local-storage-change').length, 1);
  assert.equal(events[0].detail.key, 'taskpoints_v1');
});

test('revision stamp failure never fails an authoritative storage write', () => {
  const { window, localStorage, events } = createStorageRuntime();
  const priorRevision = window.TaskPointsStateRevision.read();
  localStorage.failRevisionWrites = true;

  assert.doesNotThrow(() => localStorage.setItem('taskpoints_v1', 'state-two'));
  assert.equal(localStorage.getItem('taskpoints_v1'), 'state-two');
  assert.equal(window.TaskPointsStateRevision.read(), priorRevision);
  assert.equal(events.filter((event) => event.type === 'tp:local-storage-change').length, 1);
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
