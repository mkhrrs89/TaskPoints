;(function installTaskPointsAuditRunHabitCompletion(global) {
  'use strict';

  // Audit diagnostics remain read-only. Successfully completed manual
  // and page-open audits call this small, journal-backed habit update.
  // Internal diagnostic re-runs are not credited.
  const JOURNAL_SOURCE = 'audit-run-habit-completion';
  const nameKey = value => String(value == null ? '' : value)
    .trim().replace(/\s+/g, ' ').toLowerCase();

  function markForToday() {
    const core = global.TaskPointsCore;
    if (!core || typeof core.todayKey !== 'function'
      || typeof core.loadAppState !== 'function'
      || typeof core.writePendingHabitDelta !== 'function'
      || typeof core.readPendingHabitDeltas !== 'function') {
      return { status: 'error', message: 'Habit storage is not available.' };
    }

    try {
      // Re-read current authoritative state, including queued habit journals.
      // Do not use a snapshot captured before the Audit started.
      const loaded = core.loadAppState({
        syncDerived: false, persistSync: false,
        persistConfirmedHistoricalRepairs: false
      });
      const state = loaded?.state || loaded;
      if (!state || !Array.isArray(state.habits) || !Array.isArray(state.completions)) {
        return { status: 'error', message: 'Current habits or completions could not be read.' };
      }

      const matching = state.habits.filter(h => h
        && (h.category || 'habit') === 'habit'
        && h.retired !== true
        && nameKey(h.name) === 'run audit');
      if (!matching.length) return { status: 'missing' };
      if (matching.length !== 1) {
        return { status: 'ambiguous', message: 'More than one active Run Audit habit exists.' };
      }

      // Choose the current TaskPoints day at the moment of completion, NOT
      // the historical day selected in the Audit date picker.
      const dayKey = String(core.todayKey() || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
        return { status: 'error', message: 'Current TaskPoints day is unavailable.' };
      }
      const habit = matching[0], habitId = String(habit.id || '');
      if (!habitId) return { status: 'error', message: 'Run Audit habit has no valid ID.' };

      const completionId = typeof core.habitCompletionId === 'function'
        ? core.habitCompletionId(habitId, dayKey)
        : 'habit:' + habitId + ':' + dayKey;
      const existing = state.completions.find(row => row
        && row.source === 'habit' && String(row.habitId || '') === habitId
        && (String(row.dayKey || '') === dayKey || String(row.id || '') === completionId));
      const fraction = existing
        ? (existing.completionFraction == null ? 1 : Number(existing.completionFraction))
        : 0;
      if (Array.isArray(habit.doneKeys) && habit.doneKeys.includes(dayKey)
        && existing && fraction >= 1) {
        return { status: 'already-complete', habitId, dayKey };
      }

      const timestamp = new Date().toISOString();
      const points = Number(habit.pointsPerDay);
      if (!Number.isFinite(points) || points < 0) {
        return { status: 'error', message: 'Run Audit habit has invalid daily points.' };
      }

      // Use the SAME crash-safe write-ahead journal as the Home habit bubbles.
      // This merges by habit/day, prevents duplicate completion entries, and
      // survives navigation/crashes until the normal protected compaction.
      const delta = {
        id: completionId, habitId, dayKey, source: 'habit',
        status: 'full', completionFraction: 1, done: true,
        failed: false, icy: false, completionPoints: points,
        updatedAtISO: timestamp, createdAtISO: timestamp,
        reason: JOURNAL_SOURCE
      };
      core.writePendingHabitDelta(delta);
      const persisted = core.readPendingHabitDeltas()
        .find(row => row && row.id === completionId && row.habitId === habitId
          && row.dayKey === dayKey && row.source === 'habit');
      if (!persisted || persisted.status !== 'full' || persisted.done !== true
        || Number(persisted.completionPoints) !== points) {
        return { status: 'error', message: 'Habit journal read-back could not verify completion.' };
      }

      // Background compaction uses the existing guarded save/verification path;
      // no destructive direct save or clearing of other pending habit changes.
      if (typeof core.schedulePendingHabitDeltaCompaction === 'function') {
        try { core.schedulePendingHabitDeltaCompaction(state, { delayMs: 500 }); }
        catch (error) { console.warn('Run Audit habit compaction deferred; verified journal preserved.', error); }
      }
      return { status: 'completed', habitId, dayKey };
    } catch (error) {
      console.warn('Could not credit Run Audit habit; audit report remains complete.', error);
      return { status: 'error', message: error?.message || String(error) };
    }
  }

  global.TaskPointsAuditRunHabitCompletion = { markForToday };
  if (typeof module !== 'undefined' && module.exports) module.exports = { markForToday };
})(typeof window !== 'undefined' ? window : globalThis);
