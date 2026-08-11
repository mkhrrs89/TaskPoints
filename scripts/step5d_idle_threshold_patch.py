from pathlib import Path

js_path = Path('task_mutation_journal.js')
test_path = Path('tests/task_mutation_journal_contract.test.js')

src = js_path.read_text()
assert "const COMPACTION_EXTRA_QUIET_MS = 3000;" in src
src = src.replace("const COMPACTION_EXTRA_QUIET_MS = 3000;", "const COMPACTION_MIN_IDLE_MS = 7000;", 1)
src = src.replace("// an additional sustained-quiet grace period before it may start.", "// a minimum sustained-idle interval before it may start.", 1)
old_wait = """    await delay(COMPACTION_EXTRA_QUIET_MS);\n    if (scheduledGeneration !== mutationGeneration) {\n      preflightDeferrals += 1;\n      try { global.TaskPointsPerf?.mark?.('taskMutation.compactionDeferred', { stage: 'journal-mutated' }); } catch (_) {}\n      return false;\n    }\n    if (!maintenanceStillQuiet()) {\n"""
new_wait = """    const idleStatus = core.getStorageMaintenanceIdleStatus?.() || null;\n    const idleAgo = Math.max(0, Number(idleStatus?.lastInteractionAgoMs) || 0);\n    await delay(Math.max(0, COMPACTION_MIN_IDLE_MS - idleAgo));\n    const finalIdleStatus = core.getStorageMaintenanceIdleStatus?.() || null;\n    const finalIdleAgo = Math.max(0, Number(finalIdleStatus?.lastInteractionAgoMs) || 0);\n    if (scheduledGeneration !== mutationGeneration) {\n      preflightDeferrals += 1;\n      try { global.TaskPointsPerf?.mark?.('taskMutation.compactionDeferred', { stage: 'journal-mutated' }); } catch (_) {}\n      return false;\n    }\n    if (!maintenanceStillQuiet() || finalIdleAgo < COMPACTION_MIN_IDLE_MS) {\n"""
assert old_wait in src
src = src.replace(old_wait, new_wait, 1)
src = src.replace("// generic 1.4 s gate. Give the user a wider chance to keep interacting,\n    // then verify quiet again immediately before entering compression. A new", "// generic 1.4 s gate. Require a full 7 s since the most recent interaction,\n    // then verify quiet again immediately before entering compression. A new", 1)
assert "extraQuietMs: COMPACTION_EXTRA_QUIET_MS," in src
src = src.replace("extraQuietMs: COMPACTION_EXTRA_QUIET_MS,", "minIdleBeforeCompactionMs: COMPACTION_MIN_IDLE_MS,", 1)
assert "COMPACTION_EXTRA_QUIET_MS" not in src
assert "COMPACTION_MIN_IDLE_MS = 7000" in src
assert "finalIdleAgo < COMPACTION_MIN_IDLE_MS" in src
js_path.write_text(src)

test = test_path.read_text()
assert "let maintenanceQuiet = true;" in test
test = test.replace("let maintenanceQuiet = true;", "let maintenanceQuiet = true;\n  let lastInteractionAgoMs = 10000;", 1)
assert "isStorageMaintenanceQuiet() { return maintenanceQuiet; }," in test
test = test.replace("isStorageMaintenanceQuiet() { return maintenanceQuiet; },", "isStorageMaintenanceQuiet() { return maintenanceQuiet; },\n    getStorageMaintenanceIdleStatus() { return { lastInteractionAgoMs }; },", 1)
assert "setMaintenanceQuiet(value) { maintenanceQuiet = Boolean(value); }" in test
test = test.replace("setMaintenanceQuiet(value) { maintenanceQuiet = Boolean(value); }", "setMaintenanceQuiet(value) { maintenanceQuiet = Boolean(value); },\n    setLastInteractionAgoMs(value) { lastInteractionAgoMs = Number(value) || 0; }", 1)

test = test.replace("test('scheduled compaction waits through the additional sustained-quiet grace period'", "test('scheduled compaction waits until at least seven seconds since the latest interaction'", 1)
old_first = """  const h = makeHarness();\n  h.core.journalTaskMutation({ completionDeleteId: 'old' });\n\n  await runNextTimer(h); // module startup-replay timer; compaction is already scheduled\n  await runNextTimer(h); // scheduled compaction -> shared quiet gate -> extra grace timer\n  assert.equal(h.getSaveCalls(), 0, 'shared quiet alone must not start full-state compression');\n  assert.ok(h.timers.length >= 1, 'the extra sustained-quiet timer should be pending');\n\n  await runNextTimer(h); // extra grace -> idle callback -> compaction\n  await Promise.resolve();\n  assert.equal(h.getSaveCalls(), 1);\n  assert.equal(h.storage.getItem(JOURNAL_KEY), null);\n  assert.equal(h.core.getTaskMutationJournalStatus().extraQuietMs, 3000);\n"""
new_first = """  const h = makeHarness();\n  h.setLastInteractionAgoMs(1400);\n  h.core.journalTaskMutation({ completionDeleteId: 'old' });\n\n  await runNextTimer(h); // module startup-replay timer; compaction is already scheduled\n  await runNextTimer(h); // shared quiet gate -> remaining time to seven seconds idle\n  assert.equal(h.getSaveCalls(), 0, 'shared quiet alone must not start full-state compression');\n  assert.ok(h.timers.length >= 1, 'the sustained-idle timer should be pending');\n\n  h.setLastInteractionAgoMs(7000);\n  await runNextTimer(h); // seven seconds idle -> idle callback -> compaction\n  await Promise.resolve();\n  assert.equal(h.getSaveCalls(), 1);\n  assert.equal(h.storage.getItem(JOURNAL_KEY), null);\n  assert.equal(h.core.getTaskMutationJournalStatus().minIdleBeforeCompactionMs, 7000);\n"""
assert old_first in test
test = test.replace(old_first, new_first, 1)

old_second = """  const h = makeHarness();\n  h.core.journalTaskMutation({ completionDeleteId: 'old' });\n\n  await runNextTimer(h); // module startup-replay timer\n  await runNextTimer(h); // shared gate passes; extra quiet timer is now pending\n  h.setMaintenanceQuiet(false);\n  await runNextTimer(h); // extra grace expires while interaction state is not quiet\n"""
new_second = """  const h = makeHarness();\n  h.setLastInteractionAgoMs(1400);\n  h.core.journalTaskMutation({ completionDeleteId: 'old' });\n\n  await runNextTimer(h); // module startup-replay timer\n  await runNextTimer(h); // shared gate passes; sustained-idle timer is now pending\n  h.setLastInteractionAgoMs(200);\n  h.setMaintenanceQuiet(false);\n  await runNextTimer(h); // wait expires after a newer interaction\n"""
assert old_second in test
test = test.replace(old_second, new_second, 1)
assert "extraQuietMs" not in test
assert "minIdleBeforeCompactionMs, 7000" in test
assert "setLastInteractionAgoMs" in test
test_path.write_text(test)
