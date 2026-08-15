;(function installHabitCompletionSourceGuard(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__habitCompletionSourceGuardInstalled || typeof core.saveStateSnapshot !== 'function') return;
  core.__habitCompletionSourceGuardInstalled = true;
  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const originalSave = core.saveStateSnapshot.bind(core);

  const populated = (value) =>
    value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');

  function readPreviousState() {
    if (typeof core.readTaskPointsStoredState === 'function') {
      const decoded = core.readTaskPointsStoredState(STORAGE_KEY, null);
      return decoded && typeof decoded === 'object' ? decoded : null;
    }
    const raw = global.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    if (typeof core.parseTaskPointsStorageJson === 'function') {
      const decoded = core.parseTaskPointsStorageJson(raw, {});
      return decoded && typeof decoded === 'object' ? decoded : null;
    }
    const parsed = JSON.parse(raw);
    if (parsed?.__taskpointsStorageEncoding || parsed?.__taskpointsPacked) return null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  }

  function completionHabitId(row) {
    return String(row?.habitId || row?.viceId || '').trim();
  }

  function validDayKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
  }

  function completionDay(row) {
    for (const value of [row?.dayKey, row?.dateKey]) {
      if (validDayKey(value)) return value;
    }
    for (const value of [row?.completedAtISO, row?.createdAtISO]) {
      if (!populated(value)) continue;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) continue;
      if (typeof core.dateKey === 'function') {
        try {
          const shared = core.dateKey(date);
          if (validDayKey(shared)) return shared;
        } catch (_) {}
      }
      const direct = date.toISOString().slice(0, 10);
      if (validDayKey(direct)) return direct;
    }
    return '';
  }

  core.saveStateSnapshot = function guardedHabitCompletionSave(nextState, options) {
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
})(typeof window !== 'undefined' ? window : globalThis);

;(function loadHabitLedgerScoreReconciliation(global) {
  'use strict';

  const SCRIPT_ID = 'tpHabitLedgerScoreReconciliationScript';
  const SCRIPT_SRC = '/habit_ledger_score_reconciliation.js?v=20260803-1';

  function load() {
    if (global.TaskPointsHabitLedgerScoreReconciliation?.installed) return true;
    const document = global.document;
    if (!document?.getElementById?.('auditChecks') || !document.createElement) return false;
    if (document.getElementById(SCRIPT_ID)) return true;
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = false;
    script.setAttribute?.('data-taskpoints-habit-score-reconciliation', 'true');
    (document.body || document.head || document.documentElement)?.appendChild?.(script);
    return true;
  }

  if (!load()) {
    global.addEventListener?.('DOMContentLoaded', load, { once: true });
  }
})(typeof window !== 'undefined' ? window : globalThis);

;(function loadHabitLedgerScoreReconciliationHardening(global) {
  'use strict';

  const SCRIPT_ID = 'tpHabitLedgerScoreReconciliationHardeningScript';
  const SCRIPT_SRC = '/habit_ledger_score_reconciliation_hardening.js?v=20260803-1';
  let attempts = 0;

  function load() {
    if (global.TaskPointsHabitLedgerScoreReconciliationCopyDomainHardening?.installed) return true;
    const document = global.document;
    if (!document?.getElementById?.('auditChecks') || !document.createElement) return false;
    if (!global.TaskPointsHabitLedgerScoreReconciliation?.installed) {
      if (++attempts < 240) global.setTimeout?.(load, 50);
      return false;
    }
    if (document.getElementById(SCRIPT_ID)) return true;
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = false;
    script.setAttribute?.('data-taskpoints-habit-score-reconciliation-hardening', 'true');
    (document.body || document.head || document.documentElement)?.appendChild?.(script);
    return true;
  }

  if (!load()) {
    global.addEventListener?.('DOMContentLoaded', load, { once: true });
  }
})(typeof window !== 'undefined' ? window : globalThis);

;(function loadTaskPointsWorkEntryFastPath(global) {
  'use strict';

  const SCRIPT_ID = 'tpWorkEntryFastPathScript';
  const SCRIPT_SRC = '/work_entry_fast_path.js?v=20260815-2';

  function isHomePage() {
    const pathname = String(global.location?.pathname || '');
    return pathname === '/' || pathname === '' || pathname.endsWith('/index.html');
  }

  function load() {
    if (!isHomePage()) return false;
    if (global.TaskPointsWorkEntryFastPath?.installed) {
      global.TaskPointsWorkEntryFastPath.install?.();
      return true;
    }
    const document = global.document;
    if (!document?.createElement) return false;
    if (document.getElementById?.(SCRIPT_ID)) return true;
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = false;
    script.setAttribute?.('data-taskpoints-work-entry-fast-path', 'true');
    (document.body || document.head || document.documentElement)?.appendChild?.(script);
    return true;
  }

  if (!load()) {
    global.addEventListener?.('DOMContentLoaded', load, { once: true });
  }
})(typeof window !== 'undefined' ? window : globalThis);

;(function loadTaskPointsStreaksNavLink(global) {
  'use strict';

  const SCRIPT_ID = 'tpStreaksNavLinkScript';
  const SCRIPT_SRC = '/streaks_nav_link.js?v=20260815-1';

  function load() {
    if (global.TaskPointsStreaksNavLink?.installed) {
      global.TaskPointsStreaksNavLink.install?.();
      return true;
    }
    const document = global.document;
    if (!document?.createElement) return false;
    if (document.getElementById?.(SCRIPT_ID)) return true;
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = false;
    script.setAttribute?.('data-taskpoints-streaks-nav-link', 'true');
    (document.body || document.head || document.documentElement)?.appendChild?.(script);
    return true;
  }

  if (!load()) {
    global.addEventListener?.('DOMContentLoaded', load, { once: true });
  }
})(typeof window !== 'undefined' ? window : globalThis);
