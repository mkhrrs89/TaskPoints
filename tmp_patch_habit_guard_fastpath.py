from pathlib import Path

path = Path('habit_completion_source_guard.js')
src = path.read_text()

src = src.replace(
"  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';\n  const originalSave = core.saveStateSnapshot.bind(core);\n",
"""  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const JOURNAL_KEY = core.PENDING_HABIT_DELTAS_KEY || 'taskpoints_pending_habit_deltas_v1';
  const REVISION_KEY = 'taskpoints_state_revision_v1';
  const originalSave = core.saveStateSnapshot.bind(core);
  const originalLoad = typeof core.loadAppState === 'function' ? core.loadAppState.bind(core) : null;
  let completionTracker = null;
  let trackerSeeds = 0;
  let trackerInvalidations = 0;
  let countFastSkips = 0;
  let nonHabitAddFastSkips = 0;
  let fullPreviousStateReads = 0;
""",
1,
)

marker = """  const populated = (value) =>
    value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');

"""
if marker not in src:
    raise SystemExit('populated marker not found')
helpers = marker + """  function currentVersionToken() {
    try {
      const hot = core.getStateHotCacheStatus?.();
      if (hot && Number.isFinite(Number(hot.generation))) return `hot:${Number(hot.generation)}`;
    } catch (_) {}
    try {
      const revision = global.localStorage?.getItem?.(REVISION_KEY);
      return revision ? `revision:${String(revision)}` : null;
    } catch (_) { return null; }
  }

  function pendingJournalCount() {
    try {
      if (typeof core.readPendingHabitDeltas === 'function') {
        return Number(core.readPendingHabitDeltas()?.length) || 0;
      }
      const raw = global.localStorage?.getItem?.(JOURNAL_KEY);
      if (!raw) return 0;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.length : 1;
    } catch (_) { return 1; }
  }

  function invalidateCompletionTracker() {
    if (completionTracker) trackerInvalidations += 1;
    completionTracker = null;
  }

  function buildCompletionTracker(state) {
    const rows = Array.isArray(state?.completions) ? state.completions : null;
    const token = currentVersionToken();
    if (!rows || !token) return null;
    const ids = new Set();
    let idsUsable = true;
    for (const row of rows) {
      const id = String(row?.id || '').trim();
      if (!id || ids.has(id)) {
        idsUsable = false;
        break;
      }
      ids.add(id);
    }
    return {
      token,
      count: rows.length,
      ids: idsUsable ? ids : null
    };
  }

  function rememberCompletionState(state) {
    const next = buildCompletionTracker(state);
    if (!next) {
      invalidateCompletionTracker();
      return false;
    }
    completionTracker = next;
    trackerSeeds += 1;
    return true;
  }

  function currentCompletionTracker() {
    if (!completionTracker) return null;
    const token = currentVersionToken();
    if (!token || token !== completionTracker.token) {
      invalidateCompletionTracker();
      return null;
    }
    return completionTracker;
  }

  function isAuthoritativeSave(options = {}) {
    const storageKey = options?.storageKey || STORAGE_KEY;
    return storageKey === STORAGE_KEY && options?.persistSync !== false;
  }

  function uniqueAddedRow(nextRows, tracker) {
    if (!tracker?.ids || nextRows.length !== tracker.count + 1) return null;
    let addition = null;
    const seenPrevious = new Set();
    for (const row of nextRows) {
      const id = String(row?.id || '').trim();
      if (!id) return null;
      if (tracker.ids.has(id)) {
        seenPrevious.add(id);
        continue;
      }
      if (addition) return null;
      addition = row;
    }
    if (!addition || seenPrevious.size !== tracker.count) return null;
    return addition;
  }

  function saveAndRefreshTracker(state, options, trackerBefore = null) {
    const beforeToken = currentVersionToken();
    const result = originalSave(state, options);
    if (!isAuthoritativeSave(options)) return result;

    const afterToken = currentVersionToken();
    const resultState = result?.state && typeof result.state === 'object' ? result.state : state;
    if (result?.noOp === true) {
      rememberCompletionState(resultState);
      return result;
    }
    if (afterToken && beforeToken && afterToken !== beforeToken) {
      rememberCompletionState(resultState);
      return result;
    }

    // If no observable authoritative revision changed, only keep an existing
    // tracker when its completion count is still exactly unchanged. Any
    // uncertain completion mutation falls back to a full read on the next save.
    const rows = Array.isArray(resultState?.completions) ? resultState.completions : null;
    if (!trackerBefore || !rows || rows.length !== trackerBefore.count) invalidateCompletionTracker();
    return result;
  }

  if (originalLoad) {
    core.loadAppState = function habitCompletionGuardLoadTracker(...args) {
      const result = originalLoad(...args);
      try {
        if (result?.state && pendingJournalCount() === 0 && global.localStorage?.getItem?.(STORAGE_KEY) !== null) {
          rememberCompletionState(result.state);
        }
      } catch (_) {}
      return result;
    };
  }

  global.addEventListener?.('storage', (event) => {
    if (event?.key === null || [STORAGE_KEY, JOURNAL_KEY, REVISION_KEY].includes(String(event?.key || ''))) {
      invalidateCompletionTracker();
    }
  });
  global.addEventListener?.('taskpoints:state-revision', invalidateCompletionTracker);

"""
src = src.replace(marker, helpers, 1)

src = src.replace(
"""  function readPreviousState() {
    if (typeof core.readTaskPointsStoredState === 'function') {
""",
"""  function readPreviousState() {
    fullPreviousStateReads += 1;
    if (typeof core.readTaskPointsStoredState === 'function') {
""",
1,
)

old_save = """  core.saveStateSnapshot = function guardedHabitCompletionSave(nextState, options) {
    let adjusted = nextState;
    try {
      const previous = readPreviousState();
      const previousRows = Array.isArray(previous?.completions) ? previous.completions : null;
      const nextRows = Array.isArray(nextState?.completions) ? nextState.completions : null;
      if (!previousRows || !nextRows || nextRows.length !== previousRows.length + 1) {
        return originalSave(nextState, options);
      }

      const previousIds = new Set(
        previousRows.map((row) => String(row?.id || '').trim()).filter(Boolean)
      );
      const additions = nextRows.filter((row) => {
        const id = String(row?.id || '').trim();
        return id && !previousIds.has(id);
      });
      if (additions.length !== 1) return originalSave(nextState, options);

      const added = additions[0];
      if (added.source !== 'habit' && added.source !== 'vice') {
        return originalSave(nextState, options);
      }
      const habitId = completionHabitId(added);
      const habitIndex = (Array.isArray(nextState?.habits) ? nextState.habits : [])
        .findIndex((item) => item && String(item.id) === habitId);
      if (habitIndex < 0) return originalSave(nextState, options);
      const habit = nextState.habits[habitIndex];
      const expected = habit.category === 'vice' ? 'vice' : 'habit';
      const dayKey = completionDay(added);
      let changed = false;

      let completions = nextRows;
      if (added.source !== expected || (!populated(added.habitId) && populated(added.viceId))) {
        completions = nextRows.map((row) => {
          if (row !== added) return row;
          const next = { ...row, source: expected };
          if (!populated(next.habitId) && populated(next.viceId)) next.habitId = next.viceId;
          return next;
        });
        changed = true;
      }

      let habits = nextState.habits;
      if (validDayKey(dayKey)) {
        const doneKeys = habit.doneKeys == null
          ? []
          : (Array.isArray(habit.doneKeys) ? habit.doneKeys : null);
        const failedKeys = habit.failedKeys == null
          ? []
          : (Array.isArray(habit.failedKeys) ? habit.failedKeys : null);

        if (doneKeys && failedKeys) {
          const hasDone = doneKeys.includes(dayKey);
          const hasFailed = failedKeys.includes(dayKey);
          if (!hasDone || hasFailed) {
            habits = nextState.habits.map((item, index) => {
              if (index !== habitIndex) return item;
              const nextHabit = { ...item };
              if (!hasDone) nextHabit.doneKeys = doneKeys.concat(dayKey);
              if (hasFailed) nextHabit.failedKeys = failedKeys.filter((key) => key !== dayKey);
              return nextHabit;
            });
            changed = true;
          }
        }
      }

      if (changed) adjusted = { ...nextState, completions, habits };
    } catch (error) {
      console.warn('Habit completion source/status guard skipped normalization', error);
    }
    return originalSave(adjusted, options);
  };
"""
new_save = """  core.saveStateSnapshot = function guardedHabitCompletionSave(nextState, options = {}) {
    let adjusted = nextState;
    const nextRows = Array.isArray(nextState?.completions) ? nextState.completions : null;
    const tracker = isAuthoritativeSave(options) ? currentCompletionTracker() : null;

    // Most saves cannot possibly be the one-row Habit/Vice insertion this guard
    // exists to repair. When a current tracker proves that up front, preserve
    // the guard while avoiding a multi-megabyte previous-state decode/clone.
    if (tracker && nextRows && nextRows.length !== tracker.count + 1) {
      countFastSkips += 1;
      return saveAndRefreshTracker(nextState, options, tracker);
    }

    if (tracker && nextRows && nextRows.length === tracker.count + 1) {
      const addedFromTracker = uniqueAddedRow(nextRows, tracker);
      if (addedFromTracker && addedFromTracker.source !== 'habit' && addedFromTracker.source !== 'vice') {
        nonHabitAddFastSkips += 1;
        return saveAndRefreshTracker(nextState, options, tracker);
      }
    }

    try {
      const previous = readPreviousState();
      const previousRows = Array.isArray(previous?.completions) ? previous.completions : null;
      if (!previousRows || !nextRows || nextRows.length !== previousRows.length + 1) {
        return saveAndRefreshTracker(nextState, options, tracker);
      }

      const previousIds = new Set(
        previousRows.map((row) => String(row?.id || '').trim()).filter(Boolean)
      );
      const additions = nextRows.filter((row) => {
        const id = String(row?.id || '').trim();
        return id && !previousIds.has(id);
      });
      if (additions.length !== 1) return saveAndRefreshTracker(nextState, options, tracker);

      const added = additions[0];
      if (added.source !== 'habit' && added.source !== 'vice') {
        return saveAndRefreshTracker(nextState, options, tracker);
      }
      const habitId = completionHabitId(added);
      const habitIndex = (Array.isArray(nextState?.habits) ? nextState.habits : [])
        .findIndex((item) => item && String(item.id) === habitId);
      if (habitIndex < 0) return saveAndRefreshTracker(nextState, options, tracker);
      const habit = nextState.habits[habitIndex];
      const expected = habit.category === 'vice' ? 'vice' : 'habit';
      const dayKey = completionDay(added);
      let changed = false;

      let completions = nextRows;
      if (added.source !== expected || (!populated(added.habitId) && populated(added.viceId))) {
        completions = nextRows.map((row) => {
          if (row !== added) return row;
          const next = { ...row, source: expected };
          if (!populated(next.habitId) && populated(next.viceId)) next.habitId = next.viceId;
          return next;
        });
        changed = true;
      }

      let habits = nextState.habits;
      if (validDayKey(dayKey)) {
        const doneKeys = habit.doneKeys == null
          ? []
          : (Array.isArray(habit.doneKeys) ? habit.doneKeys : null);
        const failedKeys = habit.failedKeys == null
          ? []
          : (Array.isArray(habit.failedKeys) ? habit.failedKeys : null);

        if (doneKeys && failedKeys) {
          const hasDone = doneKeys.includes(dayKey);
          const hasFailed = failedKeys.includes(dayKey);
          if (!hasDone || hasFailed) {
            habits = nextState.habits.map((item, index) => {
              if (index !== habitIndex) return item;
              const nextHabit = { ...item };
              if (!hasDone) nextHabit.doneKeys = doneKeys.concat(dayKey);
              if (hasFailed) nextHabit.failedKeys = failedKeys.filter((key) => key !== dayKey);
              return nextHabit;
            });
            changed = true;
          }
        }
      }

      if (changed) adjusted = { ...nextState, completions, habits };
    } catch (error) {
      console.warn('Habit completion source/status guard skipped normalization', error);
    }
    return saveAndRefreshTracker(adjusted, options, tracker);
  };

  core.getHabitCompletionSourceGuardStatus = () => ({
    installed: true,
    trackerReady: Boolean(currentCompletionTracker()),
    trackerCount: completionTracker?.count ?? null,
    trackerIdsUsable: completionTracker?.ids instanceof Set,
    trackerSeeds,
    trackerInvalidations,
    countFastSkips,
    nonHabitAddFastSkips,
    fullPreviousStateReads
  });
"""
if old_save not in src:
    raise SystemExit('guard save block not found')
src = src.replace(old_save, new_save, 1)
path.write_text(src)

# Upgrade the focused harness with a revision generation and load path so the
# fast-path behavior can be tested without weakening existing correction tests.
test_path = Path('tests/habit_completion_status_guard.test.js')
test_src = test_path.read_text()
old_install = """function install(previous) {
  let saved = null;
  const context = {
    console,
    JSON,
    Date,
    Set,
    structuredClone: clone,
    localStorage: { getItem() { return JSON.stringify({ packed: true }); } },
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      readTaskPointsStoredState(key, fallback) {
        return key === 'taskpoints_v1' ? clone(previous) : fallback;
      },
      saveStateSnapshot(state, options) {
        saved = { state: clone(state), options: clone(options || {}) };
        return { state };
      }
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'habit_completion_source_guard.js' });
  return { core: context.TaskPointsCore, getSaved: () => saved };
}
"""
new_install = """function install(previous) {
  let saved = null;
  let persisted = clone(previous);
  let storedReads = 0;
  let generation = 1;
  const listeners = new Map();
  const context = {
    console,
    JSON,
    Date,
    Set,
    Map,
    Number,
    structuredClone: clone,
    addEventListener(name, callback) { listeners.set(name, callback); },
    localStorage: {
      getItem(key) {
        if (String(key) === 'taskpoints_v1') return JSON.stringify(persisted);
        if (String(key) === 'taskpoints_pending_habit_deltas_v1') return '[]';
        if (String(key) === 'taskpoints_state_revision_v1') return String(generation);
        return null;
      }
    },
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      PENDING_HABIT_DELTAS_KEY: 'taskpoints_pending_habit_deltas_v1',
      getStateHotCacheStatus() { return { generation }; },
      loadAppState() { return { state: clone(persisted), pendingHabitDeltas: [] }; },
      readTaskPointsStoredState(key, fallback) {
        if (key !== 'taskpoints_v1') return fallback;
        storedReads += 1;
        return clone(persisted);
      },
      saveStateSnapshot(state, options) {
        persisted = clone(state);
        generation += 1;
        saved = { state: clone(state), options: clone(options || {}) };
        return { state };
      }
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'habit_completion_source_guard.js' });
  return {
    core: context.TaskPointsCore,
    getSaved: () => saved,
    getStoredReads: () => storedReads,
    bumpGeneration() { generation += 1; },
    emit(name, detail = {}) { listeners.get(name)?.({ key: detail.key, detail }); }
  };
}
"""
if old_install not in test_src:
    raise SystemExit('habit guard install harness not found')
test_src = test_src.replace(old_install, new_install, 1)

test_src += """

test('loaded completion tracker skips the full previous-state read for saves that cannot add one completion', () => {
  const previous = {
    tasks: [{ id: 't1', title: 'One' }],
    habits: [{ id: 'habit-1', category: 'habit', doneKeys: [], failedKeys: [] }],
    completions: [{ id: 'existing', source: 'task', taskId: 't1', points: 1 }]
  };
  const harness = install(previous);
  harness.core.loadAppState();
  const next = clone(previous);
  next.tasks[0].title = 'Renamed';

  harness.core.saveStateSnapshot(next, { savePath: 'task-edit' });

  assert.equal(harness.getStoredReads(), 0);
  const status = harness.core.getHabitCompletionSourceGuardStatus();
  assert.equal(status.countFastSkips, 1);
  assert.equal(status.fullPreviousStateReads, 0);
});

test('loaded completion tracker skips the full previous-state read for one clearly non-habit completion', () => {
  const previous = {
    tasks: [{ id: 't1' }, { id: 't2' }],
    habits: [],
    completions: [{ id: 'existing', source: 'task', taskId: 't1', points: 1 }]
  };
  const harness = install(previous);
  harness.core.loadAppState();
  const next = clone(previous);
  next.completions.push({ id: 'new-task-completion', source: 'task', taskId: 't2', points: 2 });

  harness.core.saveStateSnapshot(next, { savePath: 'task-complete' });

  assert.equal(harness.getStoredReads(), 0);
  assert.deepEqual(harness.getSaved().state.completions, next.completions);
  const status = harness.core.getHabitCompletionSourceGuardStatus();
  assert.equal(status.nonHabitAddFastSkips, 1);
  assert.equal(status.fullPreviousStateReads, 0);
});

test('possible habit completion still performs the full previous-state read and preserves correction behavior', () => {
  const previous = {
    habits: [{ id: 'vice-1', category: 'vice', doneKeys: [], failedKeys: ['2026-08-03'], iceKeys: [] }],
    completions: [{ id: 'existing', source: 'task', taskId: 't1', points: 1 }]
  };
  const harness = install(previous);
  harness.core.loadAppState();
  const next = clone(previous);
  next.completions.push({ id: 'new-habit', source: 'habit', viceId: 'vice-1', dayKey: '2026-08-03', points: 3 });

  harness.core.saveStateSnapshot(next, { savePath: 'habit-toggle' });

  assert.equal(harness.getStoredReads(), 1);
  assert.equal(harness.getSaved().state.completions[1].source, 'vice');
  assert.equal(harness.getSaved().state.completions[1].habitId, 'vice-1');
  assert.deepEqual(Array.from(harness.getSaved().state.habits[0].doneKeys), ['2026-08-03']);
  const status = harness.core.getHabitCompletionSourceGuardStatus();
  assert.equal(status.fullPreviousStateReads, 1);
});

test('stale completion tracker fails closed to the existing full-read guard', () => {
  const previous = {
    tasks: [{ id: 't1' }],
    habits: [],
    completions: [{ id: 'existing', source: 'task', taskId: 't1', points: 1 }]
  };
  const harness = install(previous);
  harness.core.loadAppState();
  harness.bumpGeneration();
  const next = clone(previous);
  next.tasks.push({ id: 't2' });

  harness.core.saveStateSnapshot(next, { savePath: 'task-create' });

  assert.equal(harness.getStoredReads(), 1,
    'uncertain/stale tracking must use the original full previous-state check');
  assert.equal(harness.core.getHabitCompletionSourceGuardStatus().fullPreviousStateReads, 1);
});
"""
test_path.write_text(test_src)
