from pathlib import Path

root = Path('.')
js_path = root / 'task_mutation_journal.js'
test_path = root / 'tests' / 'task_mutation_journal_contract.test.js'

src = js_path.read_text()

old = """  let preflightDeferrals = 0;\n  let compactionsStarted = 0;\n  let compactionsCompleted = 0;\n"""
new = """  let preflightDeferrals = 0;\n  let compactionsStarted = 0;\n  let compactionsCompleted = 0;\n  // Advances on every new user journal mutation. A pending preflight captures\n  // this generation so a newer mutation can invalidate an older countdown.\n  let mutationGeneration = 0;\n"""
assert old in src
src = src.replace(old, new, 1)

old = """    record.updatedAtISO = new Date().toISOString();\n    const saved = writeRecord(record);\n    try { core.noteStorageUserInteraction?.(); } catch (_) {}\n    scheduleCompaction('mutation');\n"""
new = """    record.updatedAtISO = new Date().toISOString();\n    const saved = writeRecord(record);\n    mutationGeneration += 1;\n    try { core.noteStorageUserInteraction?.(); } catch (_) {}\n    scheduleCompaction('mutation');\n"""
assert old in src
src = src.replace(old, new, 1)

old = """  function snapshotVerified(savedState, record) {\n    if (!savedState || typeof savedState !== 'object') return false;\n    for (const patch of record.tasks) {\n      const saved = (savedState.tasks || []).find((task) => String(task?.id || '') === String(patch.id));\n      if (!saved) return false;\n      for (const [key, value] of Object.entries(patch)) {\n        if (!valueMatches(saved[key], value)) return false;\n      }\n    }\n    for (const patch of record.completionUpserts) {\n      const saved = (savedState.completions || []).find((entry) => String(entry?.id || '') === String(patch.id));\n      if (!saved) return false;\n      for (const [key, value] of Object.entries(patch)) {\n        if (!valueMatches(saved[key], value)) return false;\n      }\n    }\n    for (const id of record.completionDeletes) {\n      if ((savedState.completions || []).some((entry) => String(entry?.id || '') === String(id))) return false;\n    }\n    return true;\n  }\n"""
new = """  function rowMatchesExpected(saved, expected) {\n    if (!saved || !expected) return false;\n    for (const [key, value] of Object.entries(expected)) {\n      if (!valueMatches(saved[key], value)) return false;\n    }\n    return true;\n  }\n\n  function snapshotVerified(savedState, record, normalizedExpectedState = null) {\n    if (!savedState || typeof savedState !== 'object') return false;\n    for (const patch of record.tasks) {\n      const id = String(patch.id);\n      const saved = (savedState.tasks || []).find((task) => String(task?.id || '') === id);\n      const expected = normalizedExpectedState\n        ? (normalizedExpectedState.tasks || []).find((task) => String(task?.id || '') === id)\n        : patch;\n      if (!rowMatchesExpected(saved, expected || patch)) return false;\n    }\n    for (const patch of record.completionUpserts) {\n      const id = String(patch.id);\n      const saved = (savedState.completions || []).find((entry) => String(entry?.id || '') === id);\n      const expected = normalizedExpectedState\n        ? (normalizedExpectedState.completions || []).find((entry) => String(entry?.id || '') === id)\n        : patch;\n      if (!rowMatchesExpected(saved, expected || patch)) return false;\n    }\n    for (const id of record.completionDeletes) {\n      if ((savedState.completions || []).some((entry) => String(entry?.id || '') === String(id))) return false;\n      if (normalizedExpectedState && (normalizedExpectedState.completions || []).some((entry) => String(entry?.id || '') === String(id))) return false;\n    }\n    return true;\n  }\n"""
assert old in src
src = src.replace(old, new, 1)

old = """      const saved = persistedState();\n      if (!snapshotVerified(saved, snapshot)) throw new Error('Task mutation journal compaction verification failed.');\n      clearVerifiedSnapshot(snapshot);\n"""
new = """      const saved = persistedState();\n      // saveStateSnapshot may intentionally normalize task rows. Verify the\n      // canonical snapshot against the normalized state it actually committed,\n      // rather than requiring byte-for-byte equality with the pre-save patch.\n      if (!snapshotVerified(saved, snapshot, result.state)) throw new Error('Task mutation journal compaction verification failed.');\n      clearVerifiedSnapshot(snapshot);\n"""
assert old in src
src = src.replace(old, new, 1)

old = """    } catch (error) {\n      console.warn('TaskPoints retained pending task changes for a later compaction retry.', error);\n      return false;\n"""
new = """    } catch (error) {\n      try { global.TaskPointsPerf?.mark?.('taskMutation.compactionFailed', { reason, message: String(error?.message || error) }); } catch (_) {}\n      console.warn('TaskPoints retained pending task changes for a later compaction retry.', error);\n      return false;\n"""
assert old in src
src = src.replace(old, new, 1)

old = """  function runInIdleSlot(run) {\n    return new Promise((resolve) => {\n      const invoke = () => {\n        if (!maintenanceStillQuiet()) {\n          preflightDeferrals += 1;\n          try { global.TaskPointsPerf?.mark?.('taskMutation.compactionDeferred', { stage: 'idle-preflight' }); } catch (_) {}\n          resolve(false);\n          return;\n        }\n        resolve(run());\n      };\n"""
new = """  function runInIdleSlot(run, scheduledGeneration) {\n    return new Promise((resolve) => {\n      const invoke = () => {\n        if (scheduledGeneration !== mutationGeneration) {\n          preflightDeferrals += 1;\n          try { global.TaskPointsPerf?.mark?.('taskMutation.compactionDeferred', { stage: 'journal-mutated' }); } catch (_) {}\n          resolve(false);\n          return;\n        }\n        if (!maintenanceStillQuiet()) {\n          preflightDeferrals += 1;\n          try { global.TaskPointsPerf?.mark?.('taskMutation.compactionDeferred', { stage: 'idle-preflight' }); } catch (_) {}\n          resolve(false);\n          return;\n        }\n        resolve(run());\n      };\n"""
assert old in src
src = src.replace(old, new, 1)

old = """  async function runWhenQuiet(reason) {\n    const gate = core.whenStorageMaintenanceQuiet;\n"""
new = """  async function runWhenQuiet(reason, scheduledGeneration) {\n    const gate = core.whenStorageMaintenanceQuiet;\n"""
assert old in src
src = src.replace(old, new, 1)

old = """    // Do not launch a long, non-yielding compression immediately after the\n    // generic 1.4 s gate. Give the user a wider chance to keep interacting,\n    // then verify quiet again immediately before entering compression.\n    await delay(COMPACTION_EXTRA_QUIET_MS);\n    if (!maintenanceStillQuiet()) {\n"""
new = """    // Do not launch a long, non-yielding compression immediately after the\n    // generic 1.4 s gate. Give the user a wider chance to keep interacting,\n    // then verify quiet again immediately before entering compression. A new\n    // journal mutation also invalidates this countdown even if an older\n    // startup-replay attempt had already passed the generic quiet gate.\n    await delay(COMPACTION_EXTRA_QUIET_MS);\n    if (scheduledGeneration !== mutationGeneration) {\n      preflightDeferrals += 1;\n      try { global.TaskPointsPerf?.mark?.('taskMutation.compactionDeferred', { stage: 'journal-mutated' }); } catch (_) {}\n      return false;\n    }\n    if (!maintenanceStillQuiet()) {\n"""
assert old in src
src = src.replace(old, new, 1)

old = """    return runInIdleSlot(() => persistPending(reason));\n  }\n\n  function scheduleCompaction(reason = 'scheduled') {\n"""
new = """    return runInIdleSlot(() => persistPending(reason), scheduledGeneration);\n  }\n\n  function scheduleCompaction(reason = 'scheduled') {\n"""
assert old in src
src = src.replace(old, new, 1)

old = """    compactionScheduled = true;\n    global.setTimeout?.(() => {\n      runWhenQuiet(reason)\n"""
new = """    compactionScheduled = true;\n    const scheduledGeneration = mutationGeneration;\n    global.setTimeout?.(() => {\n      runWhenQuiet(reason, scheduledGeneration)\n"""
assert old in src
src = src.replace(old, new, 1)

old = """          const saved = persistedState();\n          if (snapshotVerified(saved, current.record)) clearVerifiedSnapshot(current.record);\n"""
new = """          const saved = persistedState();\n          if (snapshotVerified(saved, current.record, result.state)) clearVerifiedSnapshot(current.record);\n"""
assert old in src
src = src.replace(old, new, 1)

old = """      compactionsStarted,\n      compactionsCompleted\n"""
new = """      compactionsStarted,\n      compactionsCompleted,\n      mutationGeneration\n"""
assert old in src
src = src.replace(old, new, 1)

js_path.write_text(src)

test = test_path.read_text()

old = "function makeHarness(storageRows = {}) {"
new = "function makeHarness(storageRows = {}, options = {}) {"
assert old in test
test = test.replace(old, new, 1)

old = """    saveStateSnapshot(candidate) {\n      saveCalls += 1;\n      storage.setItem(STORAGE_KEY, JSON.stringify(candidate));\n      return { state: clone(candidate) };\n    },\n"""
new = """    saveStateSnapshot(candidate) {\n      saveCalls += 1;\n      const committed = typeof options.saveTransform === 'function'\n        ? options.saveTransform(clone(candidate))\n        : clone(candidate);\n      storage.setItem(STORAGE_KEY, JSON.stringify(committed));\n      return { state: clone(committed) };\n    },\n"""
assert old in test
test = test.replace(old, new, 1)

append = r'''

test('a newer journal mutation invalidates an older startup preflight countdown', async () => {
  const h = makeHarness();
  h.core.journalTaskMutation({ completionDeleteId: 'old' });

  await runNextTimer(h); // module startup timer cannot replace the already scheduled mutation run
  await runNextTimer(h); // existing run passes shared quiet and begins extra grace

  h.core.journalTaskMutation({ task: { id: 't1', title: 'Task', status: 'trashed', counts: 0 } });
  await runNextTimer(h); // old grace expires; generation mismatch must abort it
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(h.getSaveCalls(), 0, 'an older preflight must not compact a newer mutation');
  assert.ok(h.storage.getItem(JOURNAL_KEY), 'newer mutation must remain durable in the journal');
  assert.equal(h.core.getTaskMutationJournalStatus().preflightDeferrals, 1);
  assert.equal(h.core.getTaskMutationJournalStatus().mutationGeneration, 2);
});

test('verification accepts the save pipeline normalized task row and clears the journal', () => {
  const h = makeHarness({}, {
    saveTransform(candidate) {
      const task = candidate.tasks.find((row) => row.id === 't1');
      if (task) delete task.deletedAt; // representative legacy alias stripped by normalization
      return candidate;
    }
  });
  const task = {
    id: 't1', title: 'Task', status: 'trashed', counts: 0,
    deletedAtISO: '2026-08-11T12:00:00.000Z',
    deletedAt: '2026-08-11T12:00:00.000Z',
    completedAtISO: null,
    hidden: false
  };
  h.core.journalTaskMutation({ task, completionDeleteId: 'old' });

  assert.equal(h.core.flushPendingTaskMutations(), true);
  assert.equal(h.getSaveCalls(), 1);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null, 'verified normalized persistence should not retry forever');
  const persisted = JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(persisted.tasks[0].status, 'trashed');
  assert.equal(persisted.tasks[0].deletedAtISO, task.deletedAtISO);
  assert.equal('deletedAt' in persisted.tasks[0], false);
  assert.equal(persisted.completions.length, 0);
});
'''
assert "a newer journal mutation invalidates an older startup preflight countdown" not in test
test_path.write_text(test + append)
