const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'season_series_upset_notifications.js'), 'utf8');

function completedUpsetSeries() {
  const winners = ['underdog', 'favorite', 'underdog', 'underdog'];
  return {
    id: 'round_of_32_3',
    roundId: 'round_of_32',
    roundName: 'Round of 32',
    name: 'Match 3',
    playerAId: 'favorite',
    playerAName: 'Favorite Player',
    playerASeed: 5,
    playerBId: 'underdog',
    playerBName: 'Underdog Player',
    playerBSeed: 21,
    bestOf: 5,
    winsNeeded: 3,
    winsA: 1,
    winsB: 3,
    winnerId: 'underdog',
    loserId: 'favorite',
    status: 'complete',
    gameResults: winners.map((winnerId, index) => ({
      gameNumber: index + 1,
      dateKey: `2026-08-0${index + 4}`,
      winnerId
    }))
  };
}

function noChangeState() {
  return {
    players: [],
    inboxStartedDateKey: '2026-08-01',
    inboxMessages: [],
    inboxProcessedEventIds: {}
  };
}

function upsetState() {
  const series = completedUpsetSeries();
  return {
    players: [
      { id: 'favorite', name: 'Favorite Player' },
      { id: 'underdog', name: 'Underdog Player' }
    ],
    currentSeason: {
      id: 'season_2_august_2026',
      series: { [series.id]: series }
    },
    inboxStartedDateKey: '2026-08-01',
    inboxMessages: [],
    inboxProcessedEventIds: {}
  };
}

function loadHarness(initialState, options = {}) {
  const listeners = new Map();
  const timers = new Map();
  const loadCalls = [];
  const mergeCalls = [];
  let nextTimerId = 1;
  let state = initialState;

  const emit = (type, detail = {}) => {
    for (const listener of listeners.get(type) || []) listener({ type, detail });
  };

  const core = {
    loadAppState(loadOptions) {
      loadCalls.push(loadOptions);
      return { state };
    },
    mergeAndSaveState(patch, saveOptions) {
      mergeCalls.push({ patch, options: saveOptions });
      state = { ...state, ...patch };
      if (options.emitRevisionDuringSave) {
        emit('taskpoints:state-revision', { revision: `self-${mergeCalls.length}` });
      }
      return { state };
    }
  };

  const context = {
    window: null,
    globalThis: null,
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    JSON,
    module: { exports: {} },
    document: {},
    localStorage: {},
    TaskPointsCore: core,
    TaskPointsInbox: {
      populate() {
        return { changed: false, addedMessages: [], updatedMessages: [] };
      }
    },
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    dispatchEvent(event) {
      emit(event.type, event.detail);
      return true;
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    setTimeout(callback, delay = 0) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    }
  };
  context.window = context;
  context.globalThis = context;

  vm.runInNewContext(source, context, { filename: 'season_series_upset_notifications.js' });

  // Discard the module's one-time startup reconciliation. Each test below
  // exercises only the behavior it explicitly triggers.
  timers.clear();

  return {
    api: context.module.exports,
    loadCalls,
    mergeCalls,
    timers,
    emit,
    runOnlyTimer() {
      assert.equal(timers.size, 1);
      const [[id, timer]] = timers.entries();
      timers.delete(id);
      timer.callback();
      return timer;
    }
  };
}

test('an ordinary reconciliation check never persists derived-state sync', () => {
  const harness = loadHarness(noChangeState());
  const result = harness.api.reconcileStored({ now: new Date('2026-08-08T06:00:00-04:00') });

  assert.equal(result.changed, false);
  assert.equal(harness.loadCalls.length, 1);
  assert.equal(harness.loadCalls[0].syncDerived, true);
  assert.equal(harness.loadCalls[0].persistSync, false);
  assert.equal(harness.mergeCalls.length, 0);
});

test('a real upset persists once and its own state revision cannot queue another reconciliation', () => {
  const harness = loadHarness(upsetState(), { emitRevisionDuringSave: true });
  const result = harness.api.reconcileStored({ now: new Date('2026-08-08T06:00:00-04:00') });

  assert.equal(result.changed, true);
  assert.equal(result.addedMessages.length, 1);
  assert.equal(harness.loadCalls.length, 1);
  assert.equal(harness.loadCalls[0].persistSync, false);
  assert.equal(harness.mergeCalls.length, 1);
  assert.equal(harness.mergeCalls[0].options.savePath, 'season-series-upset-inbox');
  assert.equal(harness.mergeCalls[0].options.immediateWrite, true);
  assert.equal(harness.mergeCalls[0].patch.inboxMessages.length, 1);
  assert.equal(harness.timers.size, 0, 'the module must ignore the revision emitted by its own save');
});

test('rapid external state revisions coalesce into one delayed reconciliation', () => {
  const harness = loadHarness(noChangeState());

  harness.emit('taskpoints:state-revision', { revision: 'a' });
  harness.emit('taskpoints:state-revision', { revision: 'b' });
  harness.emit('taskpoints:state-revision', { revision: 'c' });

  assert.equal(harness.timers.size, 1);
  const timer = harness.runOnlyTimer();
  assert.equal(timer.delay, 100);
  assert.equal(harness.loadCalls.length, 1);
  assert.equal(harness.loadCalls[0].persistSync, false);
  assert.equal(harness.mergeCalls.length, 0);
});
