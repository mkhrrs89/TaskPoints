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
  const closeParen = source.indexOf(')', start);
  const braceStart = source.indexOf('{', closeParen);
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

test('Home refreshes when the TaskPoints game day changes', () => {
  assert.match(home, /let loadedHomeGameDayKey = '';/);
  assert.match(home, /function readHomeGameDayKey\(now = new Date\(\)\)/);
  assert.match(home, /currentGameDayKey === loadedHomeGameDayKey/);
  assert.match(home, /revisionUnchanged && gameDayUnchanged/);

  const guardSource = extractFunction(home, "function refreshMainPageIfChanged(reason = 'lifecycle')");
  const context = {
    window: { TP_DEBUG_PERF: false },
    loadedStateRevision: 'revision-one',
    loadedHomeGameDayKey: '2026-08-04',
    currentRevision: 'revision-one',
    currentGameDayKey: '2026-08-04',
    refreshCount: 0,
    Boolean,
    console
  };
  vm.runInNewContext(`
    function readHomeStateRevision() { return currentRevision; }
    function readHomeGameDayKey() { return currentGameDayKey; }
    function refreshMainPageFromStorage() { refreshCount += 1; return true; }
    ${guardSource}
    resultSame = refreshMainPageIfChanged('same-day');
  `, context);
  assert.equal(context.resultSame, false);
  assert.equal(context.refreshCount, 0);

  context.currentGameDayKey = '2026-08-05';
  vm.runInNewContext(`resultNextDay = refreshMainPageIfChanged('day-rollover');`, context);
  assert.equal(context.resultNextDay, true);
  assert.equal(context.refreshCount, 1);
});

test('Home baselines revisions only after successful saves', () => {
  const saveSource = extractFunction(home, 'function save(savePath, extraOptions = {})');
  assert.doesNotMatch(saveSource, /finally\s*\{[\s\S]*markHomeStateRevisionCurrent/);

  const flexBlock = saveSource.match(/if \(result\?\.flexFastPathDrained && result\?\.state\) \{[\s\S]*?\n\s*\}/)?.[0] || '';
  const skippedBlock = saveSource.match(/if \(result\?\.skipped \|\| result\?\.blockedByQuotaCircuit\) \{[\s\S]*?\n\s*\}/)?.[0] || '';
  assert.ok(flexBlock);
  assert.ok(skippedBlock);
  assert.doesNotMatch(flexBlock, /markHomeStateRevisionCurrent/);
  assert.doesNotMatch(skippedBlock, /markHomeStateRevisionCurrent/);

  assert.match(saveSource, /if \(result\?\.state\) \{[\s\S]*?\}\s*markHomeStateRevisionCurrent\(\);\s*return;/);
  assert.match(saveSource, /writeCachedStorageState\(merged\);[\s\S]*?markHomeStateRevisionCurrent\(\);/);
  assert.match(saveSource, /writeCachedStorageState\(state\);\s*markHomeStateRevisionCurrent\(\);/);
});

test('Home records full lifecycle baselines after boot and real refreshes', () => {
  assert.match(home, /function markHomeLifecycleBaseline\(\)/);
  assert.match(home, /state = syncStateWithMatchups\(state\);\s*markHomeLifecycleBaseline\(\);\s*renderHabitWeekLabels/);
  assert.match(home, /scheduleRender\(renderAll\);\s*markHomeLifecycleBaseline\(\);\s*return true;/);
  assert.match(home, /refreshMainPageIfChanged\('initial-bfcache-pageshow'\)/);
  assert.match(home, /refreshMainPageIfChanged\('pageshow'\)/);
  assert.match(home, /refreshMainPageIfChanged\('visibilitychange'\)/);
});
