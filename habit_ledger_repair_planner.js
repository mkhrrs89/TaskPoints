;(function installTaskPointsHabitLedgerRepair(global) {
  'use strict';

  const STORAGE_KEY = global.TaskPointsCore?.STORAGE_KEY || 'taskpoints_v1';
  const MAX_SAMPLE_ROWS = 18;

  const populated = (value) =>
    value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');

  const finite = (value) => {
    if (!populated(value)) return false;
    const numeric = Number(value);
    return Number.isFinite(numeric);
  };

  const validDayKey = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
  };

  function clone(value) {
    if (value == null) return value;
    if (typeof global.structuredClone === 'function') {
      try { return global.structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  }

  function localDateKey(value) {
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    if (typeof global.TaskPointsCore?.dateKey === 'function') {
      try {
        const shared = global.TaskPointsCore.dateKey(parsed);
        if (validDayKey(shared)) return shared;
      } catch (_) {}
    }
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    const key = `${year}-${month}-${day}`;
    return validDayKey(key) ? key : '';
  }

  function completionDay(row) {
    if (!row || typeof row !== 'object') return '';
    for (const value of [row.dayKey, row.dateKey]) {
      if (validDayKey(value)) return value;
    }
    for (const value of [row.completedAtISO, row.createdAtISO]) {
      if (!populated(value)) continue;
      const key = localDateKey(value);
      if (key) return key;
    }
    return '';
  }

  function completionHabitId(row) {
    return String(row?.habitId || row?.viceId || '').trim();
  }

  function expectedSource(habit) {
    return habit?.category === 'vice' ? 'vice' : 'habit';
  }

  function habitName(habit, fallbackId) {
    return habit?.name || habit?.title || habit?.label || String(fallbackId || 'Unknown habit');
  }

  function completionId(row, index) {
    return String(row?.id || `#${index + 1}`);
  }

  function numericPoints(row) {
    return finite(row?.points) ? Number(row.points) : 0;
  }

  function stableObject(value) {
    if (Array.isArray(value)) return value.map(stableObject);
    if (!value || typeof value !== 'object') return value;
    const next = {};
    Object.keys(value).sort().forEach((key) => {
      next[key] = stableObject(value[key]);
    });
    return next;
  }

  function semanticCompletionSignature(row, habitId, day, source) {
    const copy = clone(row || {});
    [
      'id',
      'completedAtISO',
      'createdAtISO',
      'updatedAtISO',
      'modifiedAtISO',
      'syncedAtISO'
    ].forEach((field) => delete copy[field]);

    copy.habitId = habitId;
    delete copy.viceId;
    copy.dayKey = day;
    delete copy.dateKey;
    copy.source = source;
    if (!populated(copy.completionFraction)) copy.completionFraction = 1;
    if (finite(copy.points)) copy.points = Number(copy.points);
    return JSON.stringify(stableObject(copy));
  }

  function rowFingerprint(row, index) {
    return JSON.stringify(stableObject({
      index,
      row: clone(row || {})
    }));
  }

  function latestRow(rows) {
    return rows.slice().sort((left, right) => {
      const leftTime = Date.parse(left.row?.completedAtISO || left.row?.createdAtISO || '') || 0;
      const rightTime = Date.parse(right.row?.completedAtISO || right.row?.createdAtISO || '') || 0;
      if (rightTime !== leftTime) return rightTime - leftTime;
      return right.index - left.index;
    })[0];
  }

  function manualKey(item) {
    return [
      item.type,
      item.habitId || '',
      item.dayKey || '',
      item.completionId || '',
      item.reason || ''
    ].join('|');
  }

  function buildHabitLedgerRepairPlan(stateInput) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const habits = Array.isArray(state.habits) ? state.habits : [];
    const completions = Array.isArray(state.completions) ? state.completions : [];
    const habitsById = new Map();
    const manualReview = [];
    const manualSeen = new Set();
    const manualOnlyIndexes = new Set();
    const entries = [];
    const duplicateCompletionIds = new Set();
    const seenCompletionIds = new Set();

    const addManual = (item, indexes = []) => {
      const affected = new Set(indexes);
      if (Number.isInteger(item?.completionIndex)) affected.add(item.completionIndex);
      affected.forEach((index) => manualOnlyIndexes.add(index));
      const key = manualKey(item);
      if (manualSeen.has(key)) return;
      manualSeen.add(key);
      manualReview.push(item);
    };

    habits.forEach((habit) => {
      if (!habit || !populated(habit.id)) return;
      habitsById.set(String(habit.id), habit);
    });

    completions.forEach((row, index) => {
      if (!row || (row.source !== 'habit' && row.source !== 'vice')) return;
      const id = String(row.id || '').trim();
      if (id) {
        if (seenCompletionIds.has(id)) duplicateCompletionIds.add(id);
        seenCompletionIds.add(id);
      }

      const habitId = completionHabitId(row);
      const habit = habitsById.get(habitId);
      const dayKey = completionDay(row);
      if (!habitId || !habit) {
        addManual({
          type: 'missing-habit',
          completionIndex: index,
          completionId: completionId(row, index),
          habitId,
          dayKey,
          reason: habitId
            ? 'The completion references a habit that no longer exists.'
            : 'The completion has no usable habitId or viceId.'
        });
        return;
      }
      if (!dayKey) {
        addManual({
          type: 'missing-day',
          completionIndex: index,
          completionId: completionId(row, index),
          habitId,
          habitName: habitName(habit, habitId),
          reason: 'The completion has no usable dayKey, dateKey, or completion timestamp.'
        });
        return;
      }

      entries.push({
        row,
        index,
        fingerprint: rowFingerprint(row, index),
        completionId: completionId(row, index),
        habit,
        habitId,
        habitName: habitName(habit, habitId),
        dayKey,
        expectedSource: expectedSource(habit),
        currentSource: String(row.source || ''),
        points: numericPoints(row),
        done: new Set(Array.isArray(habit.doneKeys) ? habit.doneKeys : []).has(dayKey),
        failed: new Set(Array.isArray(habit.failedKeys) ? habit.failedKeys : []).has(dayKey),
        iced: new Set(Array.isArray(habit.iceKeys) ? habit.iceKeys : []).has(dayKey)
      });
    });

    duplicateCompletionIds.forEach((id) => {
      const indexes = entries
        .filter((entry) => String(entry.row?.id || '').trim() === id)
        .map((entry) => entry.index);
      addManual({
        type: 'duplicate-completion-id',
        completionId: id,
        reason: `More than one completion row uses ID ${id}.`
      }, indexes);
    });

    const failedDateRemovals = [];
    const duplicateRemovals = [];
    const removalIndexes = new Set();

    entries.forEach((entry) => {
      if (manualOnlyIndexes.has(entry.index) || !entry.failed) return;
      if (entry.done || entry.iced) {
        addManual({
          type: 'conflicting-ledger-status',
          completionIndex: entry.index,
          completionId: entry.completionId,
          habitId: entry.habitId,
          habitName: entry.habitName,
          dayKey: entry.dayKey,
          points: entry.points,
          reason: 'This date is failed but is also present in doneKeys or iceKeys.'
        });
        return;
      }
      failedDateRemovals.push({
        completionIndex: entry.index,
        completionId: entry.completionId,
        fingerprint: entry.fingerprint,
        habitId: entry.habitId,
        habitName: entry.habitName,
        dayKey: entry.dayKey,
        points: entry.points,
        reason: 'The failed ledger status is authoritative, so this stale completion row will be removed.'
      });
      removalIndexes.add(entry.index);
    });

    entries.forEach((entry) => {
      if (removalIndexes.has(entry.index) || entry.done || entry.failed) return;
      addManual({
        type: 'completion-without-ledger-status',
        completionIndex: entry.index,
        completionId: entry.completionId,
        habitId: entry.habitId,
        habitName: entry.habitName,
        dayKey: entry.dayKey,
        points: entry.points,
        reason: 'A completion exists, but the date is in neither doneKeys nor failedKeys.'
      });
    });

    const activeGroups = new Map();
    entries.forEach((entry) => {
      if (removalIndexes.has(entry.index) || manualOnlyIndexes.has(entry.index)) return;
      const key = `${entry.habitId}|${entry.dayKey}`;
      if (!activeGroups.has(key)) activeGroups.set(key, []);
      activeGroups.get(key).push(entry);
    });

    activeGroups.forEach((group) => {
      if (group.length < 2) return;
      const signatures = new Map();
      group.forEach((entry) => {
        const signature = semanticCompletionSignature(
          entry.row,
          entry.habitId,
          entry.dayKey,
          entry.expectedSource
        );
        if (!signatures.has(signature)) signatures.set(signature, []);
        signatures.get(signature).push(entry);
      });

      signatures.forEach((sameRows) => {
        if (sameRows.length < 2) return;
        const keep = latestRow(sameRows);
        sameRows.forEach((entry) => {
          if (entry === keep) return;
          duplicateRemovals.push({
            completionIndex: entry.index,
            completionId: entry.completionId,
            fingerprint: entry.fingerprint,
            keepCompletionId: keep.completionId,
            habitId: entry.habitId,
            habitName: entry.habitName,
            dayKey: entry.dayKey,
            points: entry.points,
            reason: 'This is a semantic duplicate; the newest equivalent row will be retained.'
          });
          removalIndexes.add(entry.index);
        });
      });

      const survivors = group.filter((entry) => !removalIndexes.has(entry.index));
      if (survivors.length > 1) {
        addManual({
          type: 'nonidentical-duplicate',
          habitId: survivors[0].habitId,
          habitName: survivors[0].habitName,
          dayKey: survivors[0].dayKey,
          completionIds: survivors.map((entry) => entry.completionId),
          reason: 'Multiple nonidentical completion rows remain for the same habit and date.'
        }, survivors.map((entry) => entry.index));
      }
    });

    const sourceUpdates = [];
    entries.forEach((entry) => {
      if (removalIndexes.has(entry.index) || manualOnlyIndexes.has(entry.index)) return;
      if (entry.currentSource !== entry.expectedSource) {
        sourceUpdates.push({
          completionIndex: entry.index,
          completionId: entry.completionId,
          fingerprint: entry.fingerprint,
          habitId: entry.habitId,
          habitName: entry.habitName,
          dayKey: entry.dayKey,
          fromSource: entry.currentSource,
          toSource: entry.expectedSource
        });
      }
    });

    const sortRows = (left, right) =>
      String(left.dayKey || '').localeCompare(String(right.dayKey || ''))
      || String(left.habitName || '').localeCompare(String(right.habitName || ''))
      || Number(left.completionIndex || 0) - Number(right.completionIndex || 0);

    sourceUpdates.sort(sortRows);
    failedDateRemovals.sort(sortRows);
    duplicateRemovals.sort(sortRows);
    manualReview.sort(sortRows);

    const pointsRemoved = failedDateRemovals
      .concat(duplicateRemovals)
      .reduce((sum, item) => sum + (finite(item.points) ? Number(item.points) : 0), 0);

    return {
      scannedHabits: habits.length,
      scannedHabitCompletions: entries.length,
      sourceUpdates,
      failedDateRemovals,
      duplicateRemovals,
      manualReview,
      pointsRemoved: Number(pointsRemoved.toFixed(4))
    };
  }

  function planFingerprint(plan) {
    return JSON.stringify(stableObject({
      sourceUpdates: (plan?.sourceUpdates || []).map((item) => ({
        completionIndex: item.completionIndex,
        completionId: item.completionId,
        fingerprint: item.fingerprint,
        toSource: item.toSource
      })),
      failedDateRemovals: (plan?.failedDateRemovals || []).map((item) => ({
        completionIndex: item.completionIndex,
        completionId: item.completionId,
        fingerprint: item.fingerprint
      })),
      duplicateRemovals: (plan?.duplicateRemovals || []).map((item) => ({
        completionIndex: item.completionIndex,
        completionId: item.completionId,
        fingerprint: item.fingerprint,
        keepCompletionId: item.keepCompletionId
      })),
      manualReview: (plan?.manualReview || []).map((item) => ({
        type: item.type,
        completionIndex: item.completionIndex,
        completionId: item.completionId,
        habitId: item.habitId,
        dayKey: item.dayKey,
        reason: item.reason
      }))
    }));
  }

  function nonCompletionSnapshot(state) {
    const copy = clone(state || {});
    delete copy.completions;
    return JSON.stringify(stableObject(copy));
  }

  function applyHabitLedgerRepairPlan(stateInput, previewPlan) {
    const livePlan = buildHabitLedgerRepairPlan(stateInput);
    if (planFingerprint(livePlan) !== planFingerprint(previewPlan)) {
      throw new Error('The habit/completion state changed after the preview. Run the preview again.');
    }

    const state = clone(stateInput || {});
    const beforeOtherDomains = nonCompletionSnapshot(state);
    const original = Array.isArray(state.completions) ? state.completions : [];
    const sourceByIndex = new Map((livePlan.sourceUpdates || []).map((item) => [item.completionIndex, item]));
    const removalByIndex = new Map();

    (livePlan.failedDateRemovals || []).forEach((item) => removalByIndex.set(item.completionIndex, item));
    (livePlan.duplicateRemovals || []).forEach((item) => removalByIndex.set(item.completionIndex, item));

    let sourceRowsUpdated = 0;
    let failedRowsRemoved = 0;
    let duplicateRowsRemoved = 0;
    let skippedStale = 0;

    state.completions = original.flatMap((row, index) => {
      const removal = removalByIndex.get(index);
      if (removal) {
        if (rowFingerprint(row, index) !== removal.fingerprint) {
          skippedStale += 1;
          return [row];
        }
        if ((livePlan.failedDateRemovals || []).some((item) => item.completionIndex === index)) {
          failedRowsRemoved += 1;
        } else {
          duplicateRowsRemoved += 1;
        }
        return [];
      }

      const update = sourceByIndex.get(index);
      if (!update) return [row];
      if (rowFingerprint(row, index) !== update.fingerprint) {
        skippedStale += 1;
        return [row];
      }
      const next = { ...row, source: update.toSource };
      if (!populated(next.habitId) && populated(next.viceId)) next.habitId = next.viceId;
      sourceRowsUpdated += 1;
      return [next];
    });

    if (nonCompletionSnapshot(state) !== beforeOtherDomains) {
      throw new Error('The repair attempted to change data outside state.completions.');
    }

    return {
      state,
      sourceRowsUpdated,
      failedRowsRemoved,
      duplicateRowsRemoved,
      skippedStale,
      pointsRemoved: livePlan.pointsRemoved,
      manualReviewCount: livePlan.manualReview.length
    };
  }

  const api = {
    buildHabitLedgerRepairPlan,
    applyHabitLedgerRepairPlan,
    planFingerprint,
    semanticCompletionSignature
  };
  global.TaskPointsHabitLedgerRepair = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
