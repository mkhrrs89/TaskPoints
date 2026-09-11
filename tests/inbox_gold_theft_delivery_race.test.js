const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'gold_theft_top50_notifications.js'), 'utf8');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeHarness() {
  let state = {
    youName: 'Mike',
    players: [
      { id: 'p1', name: 'Alex Stone' },
      { id: 'p2', name: 'Jordan Vale' }
    ],
    goldLedger: [{
      id: 'gold-sep10',
      transferId: 'transfer-sep10',
      type: 'matchup_theft',
      playerId: 'p1',
      opponentId: 'p2',
      matchupId: 'match-sep10',
      dateKey: '2026-09-10',
      createdAtISO: '2026-09-10T12:00:00.000Z',
      amount: 8.4
    }],
    inboxMessages: [],
    inboxProcessedEventIds: {},
    goldTheftTop50InboxStartedDateKey: '2026-09-10'
  };
  let storedReads = 0;
  let fullLoads = 0;
  const events = [];
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    readTaskPointsStoredState() {
      storedReads += 1;
      return clone(state);
    },
    loadAppState() {
      fullLoads += 1;
      throw new Error('Gold notification reconciliation should not require a derived full-state load');
    },
    mergeAndSaveState(patch) {
      state = { ...state, ...clone(patch) };
      return { state: clone(state) };
    }
  };
  class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const context = vm.createContext({
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
    TaskPointsCore: core,
    TaskPointsInbox: { populate() { return { changed: false, state: clone(state) }; } },
    document: {},
    localStorage: {},
    location: { pathname: '/inbox.html' },
    CustomEvent,
    dispatchEvent(event) { events.push(event); return true; },
    addEventListener() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    requestIdleCallback() { return 1; }
  });
  context.window = context;
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'gold_theft_top50_notifications.js' });
  return {
    api: context.TaskPointsGoldTheftTop50Notifications,
    events,
    counts: () => ({ storedReads, fullLoads }),
    state: () => clone(state)
  };
}

test('Gold Theft reconciliation uses the persisted read-only snapshot instead of a derived full-state load', () => {
  const harness = makeHarness();
  const result = harness.api.reconcileStored({ now: new Date(2026, 8, 11, 9, 0, 0) });

  assert.equal(result.changed, true);
  assert.equal(result.addedMessages.length, 1);
  assert.equal(result.addedMessages[0].id, 'gold-theft-top50:gold-sep10');
  assert.equal(harness.counts().storedReads, 1);
  assert.equal(harness.counts().fullLoads, 0);
});

test('same-tab Gold Theft save emits an inbox snapshot so the open Inbox repaints immediately', () => {
  const harness = makeHarness();
  harness.api.reconcileStored({ now: new Date(2026, 8, 11, 9, 0, 0) });

  const updated = harness.events.find((event) => event.type === 'taskpoints:inbox-updated');
  const snapshot = harness.events.find((event) => event.type === 'taskpoints:inbox-state-snapshot');
  assert.ok(updated);
  assert.ok(snapshot);
  assert.equal(updated.detail.count, 1);
  assert.equal(snapshot.detail.count, 1);
  assert.equal(snapshot.detail.inboxMessages.length, 1);
  assert.equal(snapshot.detail.inboxMessages[0].title, 'Top-50 Gold Theft');
});

test('Inbox-page Gold reconciliation bypasses the multi-second storage-maintenance startup gate', () => {
  assert.match(source, /if \(isInboxPage\(\)\) \{[\s\S]*requestIdleCallback\(run, \{ timeout: 250 \}\)/);
  assert.match(source, /const gate = global\.TaskPointsCore\?\.whenStorageMaintenanceQuiet/);
  assert.doesNotMatch(source, /loadAppState\(\{ syncDerived: true, persistSync: false \}\)/);
});
