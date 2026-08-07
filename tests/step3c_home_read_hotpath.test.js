const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HOT_CACHE = fs.readFileSync(path.join(ROOT, 'state_hot_cache.js'), 'utf8');
const FEATURED = fs.readFileSync(path.join(ROOT, 'home_featured_matchup_visibility.js'), 'utf8');

class FakeStorage {
  constructor(initial = {}) {
    this.rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

test('state hot cache reuses the exact read-only load form without changing other explicit-option semantics', () => {
  const STORAGE_KEY = 'taskpoints_v1';
  const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
  const localStorage = new FakeStorage({
    [STORAGE_KEY]: '{"v":1}',
    [JOURNAL_KEY]: '[]',
    taskpoints_state_revision_v1: 'r1'
  });
  let loadCalls = 0;
  const core = {
    STORAGE_KEY,
    PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY,
    loadAppState(options) {
      loadCalls += 1;
      return {
        state: { value: loadCalls, nested: { x: 1 } },
        options: options || null,
        storageKeysFound: [STORAGE_KEY]
      };
    }
  };
  const listeners = new Map();
  const context = {
    TaskPointsCore: core,
    localStorage,
    Storage: FakeStorage,
    structuredClone,
    addEventListener(name, fn) { listeners.set(name, fn); },
    JSON, Date, Math, Object, Array, String, Number, Boolean, Promise, Error, Set, Map, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(HOT_CACHE, context, { filename: 'state_hot_cache.js' });

  const readOnly = { syncDerived: false, persistSync: false };
  const first = core.loadAppState(readOnly);
  const second = core.loadAppState(readOnly);
  assert.equal(loadCalls, 1, 'unchanged read-only UI loads should reuse the cached decoded state');
  assert.notEqual(first, second, 'each caller still receives an isolated result object');
  second.state.nested.x = 99;
  assert.equal(core.loadAppState(readOnly).state.nested.x, 1, 'read-only cache hits must be defensively cloned');
  assert.equal(loadCalls, 1);

  core.loadAppState();
  core.loadAppState();
  assert.equal(loadCalls, 2, 'default reads retain their own independent cache entry');

  core.loadAppState({ persistSync: false });
  core.loadAppState({ persistSync: false });
  assert.equal(loadCalls, 4, 'other explicit option combinations must retain their original behavior');

  const status = core.getStateHotCacheStatus();
  assert.ok(status.readOnlyHits >= 2);
  assert.ok(status.defaultHits >= 1);
  assert.deepEqual(new Set(status.cachedModes), new Set(['read-only', 'default']));

  localStorage.setItem(STORAGE_KEY, '{"v":2}');
  core.loadAppState(readOnly);
  assert.equal(loadCalls, 5, 'authoritative state writes must immediately invalidate every cache mode');
});

function createFeaturedHarness() {
  const rafQueue = [];
  const globalListeners = new Map();
  const documentListeners = new Map();
  const styleNodes = new Map();
  let loadCalls = 0;

  class FakeMutationObserver {
    static instances = [];
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
      this.target = null;
      FakeMutationObserver.instances.push(this);
    }
    observe(target) {
      this.target = target;
      this.connected = true;
    }
    disconnect() { this.connected = false; }
    notify(target) {
      if (this.connected && this.target === target) this.callback([{ target }], this);
    }
  }

  const notifyMountMutation = () => {
    FakeMutationObserver.instances.forEach((observer) => observer.notify(mount));
  };

  const classValues = new Set(['hidden']);
  const classList = {
    contains(name) { return classValues.has(name); },
    toggle(name, force) {
      const before = classValues.has(name);
      const after = force === undefined ? !before : Boolean(force);
      if (after) classValues.add(name); else classValues.delete(name);
      if (before !== after) notifyMountMutation();
      return after;
    },
    add(name) {
      if (!classValues.has(name)) { classValues.add(name); notifyMountMutation(); }
    },
    remove(name) {
      if (classValues.delete(name)) notifyMountMutation();
    }
  };

  const attributes = new Map();
  let innerHTML = '';
  const mount = {
    id: 'homeSeasonChampionshipMount',
    classList,
    get innerHTML() { return innerHTML; },
    set innerHTML(value) {
      innerHTML = String(value);
      notifyMountMutation();
    },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    setAttribute(name, value) { attributes.set(name, String(value)); notifyMountMutation(); },
    removeAttribute(name) { if (attributes.delete(name)) notifyMountMutation(); },
    externalMutation() { notifyMountMutation(); }
  };

  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    head: {
      appendChild(node) { if (node?.id) styleNodes.set(node.id, node); }
    },
    getElementById(id) {
      if (id === mount.id) return mount;
      return styleNodes.get(id) || null;
    },
    createElement(tagName) {
      return {
        tagName: String(tagName).toUpperCase(),
        id: '', className: '', textContent: '', style: {},
        setAttribute() {}, insertAdjacentElement() {}
      };
    },
    querySelector(selector) {
      if (selector === '.home-scoreboard-card') return null;
      return null;
    },
    addEventListener(name, fn) { documentListeners.set(name, fn); }
  };

  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    loadAppState(options) {
      loadCalls += 1;
      assert.equal(options?.syncDerived, false);
      assert.equal(options?.persistSync, false);
      return {
        state: {
          currentSeason: { status: 'active', series: {} },
          matchups: []
        }
      };
    },
    getFeaturedSeasonMatchup() {
      return {
        title: 'YOU vs Test',
        roundName: 'Final',
        gameNumber: 1,
        statusText: 'Series tied',
        isEliminationGame: false
      };
    }
  };

  const context = {
    TaskPointsCore: core,
    document,
    MutationObserver: FakeMutationObserver,
    requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; },
    setTimeout(fn) { rafQueue.push(fn); return rafQueue.length; },
    addEventListener(name, fn) { globalListeners.set(name, fn); },
    Date, Math, Object, Array, String, Number, Boolean, Promise, Error, Set, Map, console
  };
  context.window = context;
  context.globalThis = context;

  return {
    context,
    mount,
    rafQueue,
    FakeMutationObserver,
    get loadCalls() { return loadCalls; }
  };
}

test('Home featured matchup observes external changes without observing its own render writes', () => {
  const harness = createFeaturedHarness();
  vm.runInNewContext(FEATURED, harness.context, { filename: 'home_featured_matchup_visibility.js' });

  assert.equal(harness.loadCalls, 1, 'initial install should load state once');
  assert.equal(harness.rafQueue.length, 0, 'initial DOM writes must not schedule a self-rerender');
  assert.equal(harness.FakeMutationObserver.instances.length, 1);
  assert.equal(harness.FakeMutationObserver.instances[0].connected, true, 'external mutation observation remains enabled');

  harness.context.TaskPointsHomeFeaturedMatchup.render();
  assert.equal(harness.loadCalls, 2);
  assert.equal(harness.rafQueue.length, 0, 'direct renders must not recursively enqueue another render');

  harness.mount.externalMutation();
  assert.equal(harness.rafQueue.length, 1, 'an external Home mutation should still schedule one corrective render');
  harness.rafQueue.shift()();
  assert.equal(harness.loadCalls, 3, 'external mutation should cause exactly one state-backed rerender');
  assert.equal(harness.rafQueue.length, 0, 'the corrective render must not observe its own DOM repair');
  assert.equal(harness.FakeMutationObserver.instances[0].connected, true, 'observer reconnects after the guarded render');
});
