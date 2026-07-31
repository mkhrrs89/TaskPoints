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
      const habit = (Array.isArray(nextState?.habits) ? nextState.habits : [])
        .find((item) => item && String(item.id) === habitId);
      if (!habit) return originalSave(nextState, options);

      const expected = habit.category === 'vice' ? 'vice' : 'habit';
      if (added.source === expected && (populated(added.habitId) || !populated(added.viceId))) {
        return originalSave(nextState, options);
      }

      const completions = nextRows.map((row) => {
        if (row !== added) return row;
        const next = { ...row, source: expected };
        if (!populated(next.habitId) && populated(next.viceId)) next.habitId = next.viceId;
        return next;
      });
      adjusted = { ...nextState, completions };
    } catch (error) {
      console.warn('Habit completion source guard skipped normalization', error);
    }
    return originalSave(adjusted, options);
  };
})(typeof window !== 'undefined' ? window : globalThis);
