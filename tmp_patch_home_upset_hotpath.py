from pathlib import Path

src_path = Path('season_series_upset_notifications.js')
src = src_path.read_text()

src = src.replace(
"  let executionQuietDeferred = false;\n",
"  let executionQuietDeferred = false;\n  let homePreloadedReads = 0;\n  let persistedStateReads = 0;\n  let quietQueueGeneration = 0;\n",
1,
)

old_load = """      const loaded = core.loadAppState({ syncDerived: true, persistSync: false });
      const state = loaded?.state || loaded;
"""
new_load = """      const loadOptions = { syncDerived: true, persistSync: false };
      if (isHomePage()) {
        try {
          const liveState = global.TaskPointsHomeLiveState?.getState?.();
          if (liveState && typeof liveState === 'object') {
            loadOptions.preloadedState = liveState;
            homePreloadedReads += 1;
          } else {
            persistedStateReads += 1;
          }
        } catch (_) {
          persistedStateReads += 1;
        }
      } else {
        persistedStateReads += 1;
      }
      const loaded = core.loadAppState(loadOptions);
      const state = loaded?.state || loaded;
"""
if old_load not in src:
    raise SystemExit('load block not found')
src = src.replace(old_load, new_load, 1)

old_queue = """  function queueReconcileWhenQuiet(reason = 'startup', delayMs = 0) {
    if (!global.document || !global.localStorage) return;
    const schedule = () => {
      if (reason === 'home_state_revision') {
"""
new_queue = """  function queueReconcileWhenQuiet(reason = 'startup', delayMs = 0) {
    if (!global.document || !global.localStorage) return;
    const requestGeneration = ++quietQueueGeneration;
    const schedule = () => {
      if (requestGeneration !== quietQueueGeneration) return;
      if (reason === 'home_state_revision') {
"""
if old_queue not in src:
    raise SystemExit('quiet queue block not found')
src = src.replace(old_queue, new_queue, 1)

old_api = """    reconcileState,
    reconcileStored,
    installPopulateWrapper
  };
"""
new_api = """    reconcileState,
    reconcileStored,
    installPopulateWrapper,
    getReadHotpathStatus: () => ({
      homePreloadedReads,
      persistedStateReads,
      quietQueueGeneration
    })
  };
"""
if old_api not in src:
    raise SystemExit('api block not found')
src = src.replace(old_api, new_api, 1)
src_path.write_text(src)


test_path = Path('tests/season_series_upset_reconciliation_loop.test.js')
test = test_path.read_text()

test = test.replace(
"  const marks = [];\n  let nextTimerId = 1;\n",
"  const marks = [];\n  const quietCallbacks = [];\n  let nextTimerId = 1;\n",
1,
)

test = test.replace(
"""    loadAppState(loadOptions) {
      loadCalls.push(loadOptions);
      return { state };
    },
""",
"""    loadAppState(loadOptions) {
      loadCalls.push(loadOptions);
      return { state: loadOptions?.preloadedState || state };
    },
""",
1,
)

test = test.replace(
"""  if (idleStatus) {
    core.getStorageMaintenanceIdleStatus = () => ({ ...idleStatus });
  }

  const context = {
""",
"""  if (idleStatus) {
    core.getStorageMaintenanceIdleStatus = () => ({ ...idleStatus });
  }
  if (options.captureQuietGates) {
    core.whenStorageMaintenanceQuiet = (run) => {
      quietCallbacks.push(run);
      return new Promise(() => {});
    };
  }

  const context = {
""",
1,
)

test = test.replace(
"""    TaskPointsCore: core,
    TaskPointsPerf: {
""",
"""    TaskPointsCore: core,
    ...(options.homeLiveState ? { TaskPointsHomeLiveState: { getState: () => options.homeLiveState } } : {}),
    TaskPointsPerf: {
""",
1,
)

test = test.replace(
"""  timers.clear();

  return {
    api: context.module.exports,
""",
"""  timers.clear();
  quietCallbacks.length = 0;

  return {
    api: context.module.exports,
""",
1,
)

test = test.replace(
"""    marks,
    timers,
    idleStatus,
""",
"""    marks,
    timers,
    quietCallbacks,
    idleStatus,
""",
1,
)

append = r'''

test('Home reconciliation preserves derived sync while reusing the live Home state as preloaded input', () => {
  const liveState = noChangeState();
  const harness = loadHarness(liveState, { pathname: '/', homeLiveState: liveState });
  const result = harness.api.reconcileStored({ now: new Date('2026-08-08T06:00:00-04:00') });

  assert.equal(result.changed, false);
  assert.equal(harness.loadCalls.length, 1);
  assert.equal(harness.loadCalls[0].syncDerived, true);
  assert.equal(harness.loadCalls[0].persistSync, false);
  assert.equal(harness.loadCalls[0].preloadedState, liveState);
  assert.equal(harness.api.getReadHotpathStatus().homePreloadedReads, 1);
  assert.equal(harness.api.getReadHotpathStatus().persistedStateReads, 0);
});

test('superseded Home quiet reconciliation gates cannot schedule stale duplicate checks', () => {
  const liveState = noChangeState();
  const harness = loadHarness(liveState, {
    pathname: '/',
    homeLiveState: liveState,
    captureQuietGates: true
  });

  harness.emit('taskpoints:state-revision', { revision: 'a' });
  harness.emit('taskpoints:state-revision', { revision: 'b' });
  harness.emit('taskpoints:state-revision', { revision: 'c' });
  assert.equal(harness.quietCallbacks.length, 3);

  harness.quietCallbacks[0]();
  harness.quietCallbacks[1]();
  assert.equal(harness.timers.size, 0, 'older quiet gates should be ignored once superseded');

  harness.quietCallbacks[2]();
  assert.equal(harness.timers.size, 1, 'only the newest quiet gate may schedule reconciliation');
  harness.runOnlyTimer();
  assert.equal(harness.loadCalls.length, 1);
  assert.equal(harness.loadCalls[0].preloadedState, liveState);
});
'''

test += append
test_path.write_text(test)
