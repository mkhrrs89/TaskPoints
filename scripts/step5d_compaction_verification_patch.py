from pathlib import Path

journal_path = Path('task_mutation_journal.js')
test_path = Path('tests/task_mutation_journal_contract.test.js')

src = journal_path.read_text()
old = """  function taskPatchVerified(saved, patch, normalizedExpectedState) {\n    if (!saved || !patch) return false;\n    const id = String(patch.id || '');\n    const normalized = normalizedExpectedState\n      ? (normalizedExpectedState.tasks || []).find((task) => String(task?.id || '') === id)\n      : null;\n    if (normalizedExpectedState && !normalized) return false;\n    for (const [key, patchValue] of Object.entries(patch)) {\n      // `deletedAt` is a legacy alias. The canonical save path may retain only\n      // `deletedAtISO`; that omission is safe only when the normalized output\n      // still carries the canonical deletion timestamp. All other journaled\n      // task semantics remain mandatory.\n      if (key === 'deletedAt' && normalized && !Object.prototype.hasOwnProperty.call(normalized, key)) {\n        if (!Object.prototype.hasOwnProperty.call(normalized, 'deletedAtISO')) return false;\n        continue;\n      }\n      const expectedValue = normalized && Object.prototype.hasOwnProperty.call(normalized, key)\n        ? normalized[key]\n        : patchValue;\n      if (!valueMatches(saved[key], expectedValue)) return false;\n    }\n    return true;\n  }\n\n  function snapshotVerified(savedState, record, normalizedExpectedState = null) {\n    if (!savedState || typeof savedState !== 'object') return false;\n    for (const patch of record.tasks) {\n      const id = String(patch.id);\n      const saved = (savedState.tasks || []).find((task) => String(task?.id || '') === id);\n      if (!taskPatchVerified(saved, patch, normalizedExpectedState)) return false;\n    }\n"""
new = """  function compactedTaskOmissionMatches(saved, key, expectedValue, compactedStorage) {\n    if (!compactedStorage || Object.prototype.hasOwnProperty.call(saved, key)) return false;\n    if (key === 'originalDueDateISO') return valueMatches(saved.dueDateISO, expectedValue);\n    if (key === 'recurrence') return valueMatches(expectedValue, { mode: 'none' });\n    if (key === 'tags' || key === 'skipDates') return Array.isArray(expectedValue) && expectedValue.length === 0;\n    if (key === 'skills') {\n      return valueMatches(expectedValue, [{ skill: '', pts: '' }, { skill: '', pts: '' }]);\n    }\n    if (key === 'hidden') return expectedValue === false;\n    if (key === 'deletedAt' || key === 'deletedFrom' || key === 'prevStatus' || key === 'completedAtISO') {\n      return expectedValue == null;\n    }\n    if (key === 'postponedDays') return Number(expectedValue) === 0;\n    return false;\n  }\n\n  function taskPatchVerified(saved, patch, normalizedExpectedState, compactedStorage = false) {\n    if (!saved || !patch) return false;\n    const id = String(patch.id || '');\n    const normalized = normalizedExpectedState\n      ? (normalizedExpectedState.tasks || []).find((task) => String(task?.id || '') === id)\n      : null;\n    if (normalizedExpectedState && !normalized) return false;\n    for (const [key, patchValue] of Object.entries(patch)) {\n      // `deletedAt` is a legacy alias. The canonical save path may retain only\n      // `deletedAtISO`; that omission is safe only when the normalized output\n      // still carries the canonical deletion timestamp.\n      if (key === 'deletedAt' && normalized && !Object.prototype.hasOwnProperty.call(normalized, key)) {\n        if (!Object.prototype.hasOwnProperty.call(normalized, 'deletedAtISO')) return false;\n        continue;\n      }\n      const expectedValue = normalized && Object.prototype.hasOwnProperty.call(normalized, key)\n        ? normalized[key]\n        : patchValue;\n      if (valueMatches(saved[key], expectedValue)) continue;\n      // Large snapshots are intentionally compacted before localStorage write.\n      // That representation omits only canonical defaults that the load path\n      // reconstructs (empty arrays, false/null defaults, zero postponements,\n      // and originalDueDateISO when it equals dueDateISO). Treat only those\n      // documented omissions as equivalent; every substantive field remains\n      // mandatory for journal verification.\n      if (compactedTaskOmissionMatches(saved, key, expectedValue, compactedStorage)) continue;\n      return false;\n    }\n    return true;\n  }\n\n  function snapshotVerified(savedState, record, normalizedExpectedState = null) {\n    if (!savedState || typeof savedState !== 'object') return false;\n    const compactedStorage = Number(savedState.__storageCompactVersion) === 1;\n    for (const patch of record.tasks) {\n      const id = String(patch.id);\n      const saved = (savedState.tasks || []).find((task) => String(task?.id || '') === id);\n      if (!taskPatchVerified(saved, patch, normalizedExpectedState, compactedStorage)) return false;\n    }\n"""
assert old in src, 'task verification block changed unexpectedly'
src = src.replace(old, new, 1)
assert 'COMPACTION_MIN_IDLE_MS = 7000' in src, '7-second idle gate must remain intact'
journal_path.write_text(src)

test = test_path.read_text()
old_harness = """      storage.setItem(STORAGE_KEY, JSON.stringify(committed));\n      return { state: clone(committed) };\n"""
new_harness = """      storage.setItem(STORAGE_KEY, JSON.stringify(committed));\n      const returnedState = typeof options.returnedStateTransform === 'function'\n        ? options.returnedStateTransform(clone(committed), clone(candidate))\n        : clone(committed);\n      return { state: returnedState };\n"""
assert old_harness in test, 'save harness block changed unexpectedly'
test = test.replace(old_harness, new_harness, 1)

regression = r'''

test('verification accepts canonical task defaults omitted by compact localStorage', () => {
  const h = makeHarness({}, {
    saveTransform(candidate) {
      candidate.__storageCompactVersion = 1;
      const task = candidate.tasks.find((row) => row.id === 't1');
      if (!task) return candidate;
      if (task.originalDueDateISO === task.dueDateISO) delete task.originalDueDateISO;
      if (task.recurrence?.mode === 'none' && Object.keys(task.recurrence).length === 1) delete task.recurrence;
      if (Array.isArray(task.tags) && task.tags.length === 0) delete task.tags;
      if (Array.isArray(task.skipDates) && task.skipDates.length === 0) delete task.skipDates;
      if (Array.isArray(task.skills) && task.skills.length === 2 && task.skills.every((slot) => slot?.skill === '' && slot?.pts === '')) delete task.skills;
      if (task.hidden === false) delete task.hidden;
      ['deletedAt', 'deletedFrom', 'prevStatus', 'completedAtISO'].forEach((key) => {
        if (task[key] == null) delete task[key];
      });
      if (Number(task.postponedDays) === 0) delete task.postponedDays;
      return candidate;
    },
    returnedStateTransform(_committed, candidate) {
      return candidate;
    }
  });
  const task = {
    id: 't1',
    title: 'Task',
    status: 'active',
    counts: 0,
    dueDateISO: '2026-08-12',
    originalDueDateISO: '2026-08-12',
    recurrence: { mode: 'none' },
    tags: [],
    skipDates: [],
    skills: [{ skill: '', pts: '' }, { skill: '', pts: '' }],
    hidden: false,
    deletedAt: null,
    deletedAtISO: null,
    deletedFrom: null,
    prevStatus: null,
    completedAtISO: null,
    postponedDays: 0
  };
  h.core.journalTaskMutation({ task, completionDeleteId: 'old' });

  assert.equal(h.core.flushPendingTaskMutations(), true);
  assert.equal(h.getSaveCalls(), 1);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null, 'canonical compact omissions must verify and clear the journal');
  const persisted = JSON.parse(h.storage.getItem(STORAGE_KEY));
  assert.equal(persisted.__storageCompactVersion, 1);
  assert.equal(persisted.tasks[0].dueDateISO, task.dueDateISO);
  assert.equal('originalDueDateISO' in persisted.tasks[0], false);
  assert.equal('hidden' in persisted.tasks[0], false);
  assert.equal('postponedDays' in persisted.tasks[0], false);
  assert.equal(persisted.completions.length, 0);
});

test('compact task verification still rejects substantive field corruption', () => {
  const h = makeHarness({}, {
    saveTransform(candidate) {
      candidate.__storageCompactVersion = 1;
      const task = candidate.tasks.find((row) => row.id === 't1');
      if (task) task.status = 'trashed';
      return candidate;
    },
    returnedStateTransform(_committed, candidate) {
      return candidate;
    }
  });
  h.core.journalTaskMutation({
    task: { id: 't1', title: 'Task', status: 'active', counts: 0 },
    completionDeleteId: 'old'
  });

  assert.equal(h.core.flushPendingTaskMutations(), false);
  assert.equal(h.getSaveCalls(), 1);
  assert.ok(h.storage.getItem(JOURNAL_KEY), 'journal must remain durable after substantive verification failure');
});
'''
assert "verification accepts canonical task defaults omitted by compact localStorage" not in test
test += regression
test_path.write_text(test)
