from pathlib import Path

root = Path('.')
js_path = root / 'task_mutation_journal.js'
test_path = root / 'tests' / 'task_mutation_journal_contract.test.js'

src = js_path.read_text()
old = """  const RETRY_BASE_DELAY_MS = 1500;\n  const RETRY_MAX_DELAY_MS = 15000;\n  const MAX_RETRIES = 5;\n"""
new = """  const RETRY_BASE_DELAY_MS = 1500;\n  const RETRY_MAX_DELAY_MS = 15000;\n  const MAX_RETRIES = 5;\n  // The shared storage gate considers 1.4 s of inactivity quiet enough for\n  // ordinary maintenance. Full-state LZ compression can still block the main\n  // thread for ~0.6-1.0 s on large histories, so task-journal compaction gets\n  // an additional sustained-quiet grace period before it may start.\n  const COMPACTION_EXTRA_QUIET_MS = 3000;\n"""
assert old in src
src = src.replace(old, new, 1)

old = """  let compactionScheduled = false;\n  let compactionRunning = false;\n  let retryTimer = 0;\n  let retryCount = 0;\n"""
new = """  let compactionScheduled = false;\n  let compactionRunning = false;\n  let retryTimer = 0;\n  let retryCount = 0;\n  let preflightDeferrals = 0;\n  let compactionsStarted = 0;\n  let compactionsCompleted = 0;\n"""
assert old in src
src = src.replace(old, new, 1)

old = """  function persistPending(reason = 'quiet') {\n    if (compactionRunning || !originalSaveStateSnapshot) return false;\n    const current = readRecord();\n    if (current.malformed || isEmpty(current.record)) return false;\n    compactionRunning = true;\n    const snapshot = clone(current.record);\n"""
new = """  function persistPending(reason = 'quiet') {\n    if (compactionRunning || !originalSaveStateSnapshot) return false;\n    const current = readRecord();\n    if (current.malformed || isEmpty(current.record)) return false;\n    compactionRunning = true;\n    compactionsStarted += 1;\n    try { global.TaskPointsPerf?.mark?.('taskMutation.compactionStart', { reason }); } catch (_) {}\n    const snapshot = clone(current.record);\n"""
assert old in src
src = src.replace(old, new, 1)

old = """      clearVerifiedSnapshot(snapshot);\n      retryCount = 0;\n      return true;\n"""
new = """      clearVerifiedSnapshot(snapshot);\n      retryCount = 0;\n      compactionsCompleted += 1;\n      try { global.TaskPointsPerf?.mark?.('taskMutation.compactionComplete', { reason }); } catch (_) {}\n      return true;\n"""
assert old in src
src = src.replace(old, new, 1)

old = """  function runWhenQuiet(reason) {\n    const run = () => persistPending(reason);\n    const gate = core.whenStorageMaintenanceQuiet;\n    if (typeof gate === 'function') return Promise.resolve(gate(run, { reason: SAVE_PATH }));\n    return new Promise((resolve) => {\n      global.setTimeout?.(() => {\n        if (typeof global.requestIdleCallback === 'function') {\n          global.requestIdleCallback(() => resolve(run()), { timeout: 1500 });\n        } else resolve(run());\n      }, 1500);\n    });\n  }\n"""
new = """  function delay(ms) {\n    return new Promise((resolve) => {\n      if (typeof global.setTimeout === 'function') global.setTimeout(resolve, Math.max(0, Number(ms) || 0));\n      else resolve();\n    });\n  }\n\n  function maintenanceStillQuiet() {\n    try {\n      return typeof core.isStorageMaintenanceQuiet !== 'function' || core.isStorageMaintenanceQuiet() === true;\n    } catch (_) {\n      return false;\n    }\n  }\n\n  function runInIdleSlot(run) {\n    return new Promise((resolve) => {\n      const invoke = () => {\n        if (!maintenanceStillQuiet()) {\n          preflightDeferrals += 1;\n          try { global.TaskPointsPerf?.mark?.('taskMutation.compactionDeferred', { stage: 'idle-preflight' }); } catch (_) {}\n          resolve(false);\n          return;\n        }\n        resolve(run());\n      };\n      if (typeof global.requestIdleCallback === 'function') {\n        global.requestIdleCallback(invoke, { timeout: 1200 });\n      } else if (typeof global.requestAnimationFrame === 'function') {\n        global.requestAnimationFrame(() => global.setTimeout?.(invoke, 0));\n      } else {\n        global.setTimeout?.(invoke, 0);\n      }\n    });\n  }\n\n  async function runWhenQuiet(reason) {\n    const gate = core.whenStorageMaintenanceQuiet;\n    if (typeof gate === 'function') {\n      const gateReady = await Promise.resolve(gate(() => true, { reason: SAVE_PATH }));\n      if (gateReady !== true) return false;\n    } else {\n      await delay(1500);\n      if (!maintenanceStillQuiet()) return false;\n    }\n\n    // Do not launch a long, non-yielding compression immediately after the\n    // generic 1.4 s gate. Give the user a wider chance to keep interacting,\n    // then verify quiet again immediately before entering compression.\n    await delay(COMPACTION_EXTRA_QUIET_MS);\n    if (!maintenanceStillQuiet()) {\n      preflightDeferrals += 1;\n      try { global.TaskPointsPerf?.mark?.('taskMutation.compactionDeferred', { stage: 'sustained-quiet' }); } catch (_) {}\n      return false;\n    }\n    return runInIdleSlot(() => persistPending(reason));\n  }\n"""
assert old in src
src = src.replace(old, new, 1)

old = """      compactionScheduled,\n      compactionRunning,\n      retryCount\n"""
new = """      compactionScheduled,\n      compactionRunning,\n      retryCount,\n      extraQuietMs: COMPACTION_EXTRA_QUIET_MS,\n      preflightDeferrals,\n      compactionsStarted,\n      compactionsCompleted\n"""
assert old in src
src = src.replace(old, new, 1)
js_path.write_text(src)

test = test_path.read_text()
old = """  const timers = [];\n  const quietRuns = [];\n  let saveCalls = 0;\n"""
new = """  const timers = [];\n  const quietRuns = [];\n  let saveCalls = 0;\n  let maintenanceQuiet = true;\n"""
assert old in test
test = test.replace(old, new, 1)

old = """    whenStorageMaintenanceQuiet(run) { quietRuns.push(run); return Promise.resolve(false); },\n    noteStorageUserInteraction() {},\n"""
new = """    whenStorageMaintenanceQuiet(run) { quietRuns.push(run); return Promise.resolve(run()); },\n    isStorageMaintenanceQuiet() { return maintenanceQuiet; },\n    noteStorageUserInteraction() {},\n"""
assert old in test
test = test.replace(old, new, 1)

old = """  return { context, core, storage, timers, quietRuns, getSaveCalls: () => saveCalls };\n}\n"""
new = """  return {\n    context, core, storage, timers, quietRuns,\n    getSaveCalls: () => saveCalls,\n    setMaintenanceQuiet(value) { maintenanceQuiet = Boolean(value); }\n  };\n}\n\nasync function runNextTimer(harness) {\n  const callback = harness.timers.shift();\n  assert.ok(callback, 'expected a scheduled timer');\n  callback();\n  await Promise.resolve();\n  await Promise.resolve();\n}\n"""
assert old in test
test = test.replace(old, new, 1)

append = r'''\n\ntest('scheduled compaction waits through the additional sustained-quiet grace period', async () => {\n  const h = makeHarness();\n  h.core.journalTaskMutation({ completionDeleteId: 'old' });\n\n  await runNextTimer(h); // scheduleCompaction -> shared quiet gate -> extra grace timer\n  assert.equal(h.getSaveCalls(), 0, 'shared quiet alone must not start full-state compression');\n  assert.ok(h.timers.length >= 1, 'the extra sustained-quiet timer should be pending');\n\n  await runNextTimer(h); // extra grace -> idle callback -> compaction\n  await Promise.resolve();\n  assert.equal(h.getSaveCalls(), 1);\n  assert.equal(h.storage.getItem(JOURNAL_KEY), null);\n  assert.equal(h.core.getTaskMutationJournalStatus().extraQuietMs, 3000);\n});\n\ntest('a user interaction during the extra grace period defers compaction instead of entering compression', async () => {\n  const h = makeHarness();\n  h.core.journalTaskMutation({ completionDeleteId: 'old' });\n\n  await runNextTimer(h); // shared gate passes; extra quiet timer is now pending\n  h.setMaintenanceQuiet(false);\n  await runNextTimer(h); // extra grace expires while interaction state is not quiet\n  await Promise.resolve();\n\n  assert.equal(h.getSaveCalls(), 0, 'full-state save must yield when quiet was broken');\n  assert.ok(h.storage.getItem(JOURNAL_KEY), 'durable journal must remain pending');\n  assert.equal(h.core.getTaskMutationJournalStatus().preflightDeferrals, 1);\n});\n'''
assert "scheduled compaction waits through the additional sustained-quiet grace period" not in test
test_path.write_text(test + append)
