from pathlib import Path

js_path = Path('task_mutation_journal.js')
test_path = Path('tests/task_mutation_journal_contract.test.js')

src = js_path.read_text()
src = src.replace("const COMPACTION_EXTRA_QUIET_MS = 3000;", "const COMPACTION_MIN_IDLE_MS = 7000;")
src = src.replace("await delay(COMPACTION_EXTRA_QUIET_MS);\n    if (!maintenanceStillQuiet()) {", "const idleStatus = core.getStorageMaintenanceIdleStatus?.() || null;\n    const idleAgo = Math.max(0, Number(idleStatus?.lastInteractionAgoMs) || 0);\n    await delay(Math.max(0, COMPACTION_MIN_IDLE_MS - idleAgo));\n    const finalIdleStatus = core.getStorageMaintenanceIdleStatus?.() || null;\n    const finalIdleAgo = Math.max(0, Number(finalIdleStatus?.lastInteractionAgoMs) || 0);\n    if (!maintenanceStillQuiet() || finalIdleAgo < COMPACTION_MIN_IDLE_MS) {")
src = src.replace("extraQuietMs: COMPACTION_EXTRA_QUIET_MS,", "minIdleBeforeCompactionMs: COMPACTION_MIN_IDLE_MS,")
src = src.replace("// an additional sustained-quiet grace period before it may start.", "// a minimum sustained-idle interval before it may start.")
src = src.replace("// generic 1.4 s gate. Give the user a wider chance to keep interacting,\n    // then verify quiet again immediately before entering compression.", "// generic 1.4 s gate. Require a full 7 s since the most recent interaction,\n    // then verify quiet again immediately before entering compression.")
assert "COMPACTION_EXTRA_QUIET_MS" not in src
assert "COMPACTION_MIN_IDLE_MS = 7000" in src
assert "finalIdleAgo < COMPACTION_MIN_IDLE_MS" in src
js_path.write_text(src)

test = test_path.read_text()
test = test.replace("let maintenanceQuiet = true;", "let maintenanceQuiet = true;\n  let lastInteractionAgoMs = 10000;")
test = test.replace("isStorageMaintenanceQuiet() { return maintenanceQuiet; },", "isStorageMaintenanceQuiet() { return maintenanceQuiet; },\n    getStorageMaintenanceIdleStatus() { return { lastInteractionAgoMs }; },")
test = test.replace("setMaintenanceQuiet(value) { maintenanceQuiet = Boolean(value); }", "setMaintenanceQuiet(value) { maintenanceQuiet = Boolean(value); },\n    setLastInteractionAgoMs(value) { lastInteractionAgoMs = Number(value) || 0; }")
test = test.replace("assert.equal(h.core.getTaskMutationJournalStatus().extraQuietMs, 3000);", "assert.equal(h.core.getTaskMutationJournalStatus().minIdleBeforeCompactionMs, 7000);")
test = test.replace("test('scheduled compaction waits through the additional sustained-quiet grace period'", "test('scheduled compaction waits until at least seven seconds since the latest interaction'")
test = test.replace("await runNextTimer(h); // scheduleCompaction -> shared quiet gate -> extra grace timer", "h.setLastInteractionAgoMs(1400);\n  await runNextTimer(h); // startup-replay timer\n  await runNextTimer(h); // scheduleCompaction -> shared quiet gate -> remaining idle timer")
test = test.replace("await runNextTimer(h); // extra grace -> idle callback -> compaction", "h.setLastInteractionAgoMs(7000);\n  await runNextTimer(h); // remaining sustained-idle wait -> idle callback -> compaction")
test = test.replace("await runNextTimer(h); // shared gate passes; extra quiet timer is now pending\n  h.setMaintenanceQuiet(false);\n  await runNextTimer(h); // extra grace expires while interaction state is not quiet", "h.setLastInteractionAgoMs(1400);\n  await runNextTimer(h); // startup-replay timer\n  await runNextTimer(h); // shared gate passes; remaining idle timer is pending\n  h.setLastInteractionAgoMs(200);\n  h.setMaintenanceQuiet(false);\n  await runNextTimer(h); // sustained-idle wait expires after a newer interaction")
assert "extraQuietMs" not in test
assert "minIdleBeforeCompactionMs, 7000" in test
assert "setLastInteractionAgoMs" in test
test_path.write_text(test)
