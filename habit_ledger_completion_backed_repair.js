;(function installCompletionBackedHabitRepair(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const planner = global.TaskPointsHabitLedgerRepair;
  if (!core || !planner || global.__completionBackedHabitRepairInstalled) return;
  global.__completionBackedHabitRepairInstalled = true;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';

  const populated = (value) =>
    value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');

  function validDayKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
  }

  function clone(value) {
    if (value == null) return value;
    if (typeof global.structuredClone === 'function') {
      try { return global.structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
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

  function completionHabitId(row) {
    return String(row?.habitId || row?.viceId || '').trim();
  }

  function completionId(row) {
    return String(row?.id || '').trim();
  }

  function habitName(habit, fallbackId) {
    return String(habit?.name || habit?.title || habit?.label || fallbackId || 'Unknown habit');
  }

  function expectedSource(habit) {
    return habit?.category === 'vice' ? 'vice' : 'habit';
  }

  function ledgerArray(habit, field) {
    const value = habit?.[field];
    if (value == null) return [];
    return Array.isArray(value) ? value : null;
  }

  function baseConfirmedCount(plan) {
    return (plan?.sourceUpdates?.length || 0)
      + (plan?.failedDateRemovals?.length || 0)
      + (plan?.duplicateRemovals?.length || 0);
  }

  function totalConfirmedCount(plan) {
    return baseConfirmedCount(plan?.basePlan)
      + (plan?.doneKeyAdditions?.length || 0)
      + (plan?.failedKeyRemovals?.length || 0)
      + (plan?.sourceFixes?.length || 0);
  }

  function buildCompletionBackedPlan(stateInput) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const basePlan = planner.buildHabitLedgerRepairPlan(state);
    const habits = Array.isArray(state.habits) ? state.habits : [];
    const completions = Array.isArray(state.completions) ? state.completions : [];
    const habitsById = new Map(
      habits
        .filter((habit) => habit && populated(habit.id))
        .map((habit) => [String(habit.id), habit])
    );

    const removedIndexes = new Set(
      [...(basePlan.failedDateRemovals || []), ...(basePlan.duplicateRemovals || [])]
        .map((item) => item.completionIndex)
    );
    const baseSourceIndexes = new Set(
      (basePlan.sourceUpdates || []).map((item) => item.completionIndex)
    );
    const blockedIndexes = new Set();
    const blockedGroups = new Set();
    const completionIdCounts = new Map();

    completions.forEach((row) => {
      const id = completionId(row);
      if (id) completionIdCounts.set(id, (completionIdCounts.get(id) || 0) + 1);
    });

    (basePlan.manualReview || []).forEach((item) => {
      const type = String(item?.type || '');
      if (type === 'completion-without-ledger-status' || type === 'conflicting-ledger-status') return;
      if (Number.isInteger(item?.completionIndex)) blockedIndexes.add(item.completionIndex);
      if (type === 'duplicate-completion-id' && item?.completionId) {
        completions.forEach((row, index) => {
          if (completionId(row) === String(item.completionId)) blockedIndexes.add(index);
        });
      }
      if (type === 'nonidentical-duplicate' && item?.habitId && item?.dayKey) {
        blockedGroups.add(`${item.habitId}|${item.dayKey}`);
      }
    });

    const entries = [];
    completions.forEach((row, index) => {
      if (!row || !['habit', 'vice'].includes(row.source)) return;
      if (removedIndexes.has(index) || blockedIndexes.has(index)) return;

      const habitId = completionHabitId(row);
      const dayKey = completionDay(row);
      const id = completionId(row);
      const habit = habitsById.get(habitId);
      if (!habit || !validDayKey(dayKey) || !id || completionIdCounts.get(id) !== 1) return;
      if (blockedGroups.has(`${habitId}|${dayKey}`)) return;

      entries.push({
        row,
        index,
        id,
        habit,
        habitId,
        dayKey,
        key: `${habitId}|${dayKey}`
      });
    });

    const groupCounts = new Map();
    entries.forEach((entry) => {
      groupCounts.set(entry.key, (groupCounts.get(entry.key) || 0) + 1);
    });

    const doneAdditions = new Map();
    const failedRemovals = new Map();
    const sourceFixes = [];
    const shapeManual = [];
    const shapeManualSeen = new Set();

    entries.forEach((entry) => {
      if (groupCounts.get(entry.key) !== 1) return;

      const toSource = expectedSource(entry.habit);
      if (entry.row.source !== toSource && !baseSourceIndexes.has(entry.index)) {
        sourceFixes.push({
          completionId: entry.id,
          habitId: entry.habitId,
          dayKey: entry.dayKey,
          fromSource: entry.row.source,
          toSource
        });
      }

      const doneKeys = ledgerArray(entry.habit, 'doneKeys');
      const failedKeys = ledgerArray(entry.habit, 'failedKeys');
      const iceKeys = ledgerArray(entry.habit, 'iceKeys');
      if (!doneKeys || !failedKeys || !iceKeys) {
        const shapeKey = String(entry.habitId);
        if (!shapeManualSeen.has(shapeKey)) {
          shapeManualSeen.add(shapeKey);
          shapeManual.push({
            type: 'malformed-ledger-container',
            habitId: entry.habitId,
            habitName: habitName(entry.habit, entry.habitId),
            dayKey: entry.dayKey,
            reason: 'At least one of doneKeys, failedKeys, or iceKeys is not an array; automatic status repair is skipped.'
          });
        }
        return;
      }

      const isDone = doneKeys.includes(entry.dayKey);
      const isFailed = failedKeys.includes(entry.dayKey);
      const isIced = iceKeys.includes(entry.dayKey);

      if (isFailed && (isDone || isIced)) {
        failedRemovals.set(entry.key, {
          habitId: entry.habitId,
          habitName: habitName(entry.habit, entry.habitId),
          dayKey: entry.dayKey
        });
      }
      if (!isDone && (!isFailed || isIced)) {
        doneAdditions.set(entry.key, {
          habitId: entry.habitId,
          habitName: habitName(entry.habit, entry.habitId),
          dayKey: entry.dayKey,
          completionId: entry.id
        });
      }
    });

    const doneKeyAdditions = [...doneAdditions.values()];
    const failedKeyRemovals = [...failedRemovals.values()];
    const resolvedManual = new Set();
    doneKeyAdditions.forEach((item) => {
      resolvedManual.add(`completion-without-ledger-status|${item.habitId}|${item.dayKey}`);
    });
    failedKeyRemovals.forEach((item) => {
      resolvedManual.add(`conflicting-ledger-status|${item.habitId}|${item.dayKey}`);
    });

    const manualReview = (basePlan.manualReview || [])
      .filter((item) => !resolvedManual.has(`${item?.type || ''}|${item?.habitId || ''}|${item?.dayKey || ''}`))
      .concat(shapeManual);

    const sortRows = (left, right) =>
      String(left.dayKey || '').localeCompare(String(right.dayKey || ''))
      || String(left.habitName || '').localeCompare(String(right.habitName || ''));
    doneKeyAdditions.sort(sortRows);
    failedKeyRemovals.sort(sortRows);
    sourceFixes.sort(sortRows);
    manualReview.sort(sortRows);

    return {
      basePlan,
      doneKeyAdditions,
      failedKeyRemovals,
      sourceFixes,
      manualReview
    };
  }

  function planFingerprint(plan) {
    const base = typeof planner.planFingerprint === 'function'
      ? planner.planFingerprint(plan?.basePlan || {})
      : JSON.stringify(stableObject(plan?.basePlan || {}));
    return JSON.stringify(stableObject({
      base,
      doneKeyAdditions: plan?.doneKeyAdditions || [],
      failedKeyRemovals: plan?.failedKeyRemovals || [],
      sourceFixes: plan?.sourceFixes || [],
      manualReview: (plan?.manualReview || []).map((item) => ({
        type: item?.type,
        habitId: item?.habitId,
        dayKey: item?.dayKey,
        completionId: item?.completionId,
        reason: item?.reason
      }))
    }));
  }

  function outsideLedgerSnapshot(state) {
    const copy = clone(state || {});
    delete copy.habits;
    delete copy.completions;
    return JSON.stringify(stableObject(copy));
  }

  function impactBlocked(plan) {
    const removals = (plan?.basePlan?.failedDateRemovals?.length || 0)
      + (plan?.basePlan?.duplicateRemovals?.length || 0);
    if (!removals) return false;
    const impact = plan?.basePlan?.matchupImpact;
    return !impact
      || impact.completeImpactChain !== true
      || impact.hasBlockingImpact === true;
  }

  function applyCompletionBackedPlan(stateInput, previewPlan) {
    const livePlan = buildCompletionBackedPlan(stateInput);
    if (planFingerprint(livePlan) !== planFingerprint(previewPlan)) {
      throw new Error('The habit/completion state changed after preview. Run it again.');
    }

    const beforeOtherDomains = outsideLedgerSnapshot(stateInput);
    const baseResult = planner.applyHabitLedgerRepairPlan(stateInput, previewPlan.basePlan);
    const state = clone(baseResult?.state || stateInput || {});

    let sourceRowsUpdated = 0;
    (livePlan.sourceFixes || []).forEach((fix) => {
      const matches = (state.completions || [])
        .filter((row) => completionId(row) === fix.completionId);
      if (matches.length !== 1
        || completionHabitId(matches[0]) !== fix.habitId
        || completionDay(matches[0]) !== fix.dayKey) {
        throw new Error(`Completion ${fix.completionId} changed after preview.`);
      }
      if (matches[0].source !== fix.toSource) {
        matches[0].source = fix.toSource;
        if (!populated(matches[0].habitId) && populated(matches[0].viceId)) {
          matches[0].habitId = matches[0].viceId;
        }
        sourceRowsUpdated += 1;
      }
    });

    const additionsByHabit = new Map();
    const removalsByHabit = new Map();
    livePlan.doneKeyAdditions.forEach((item) => {
      if (!additionsByHabit.has(item.habitId)) additionsByHabit.set(item.habitId, []);
      additionsByHabit.get(item.habitId).push(item.dayKey);
    });
    livePlan.failedKeyRemovals.forEach((item) => {
      if (!removalsByHabit.has(item.habitId)) removalsByHabit.set(item.habitId, []);
      removalsByHabit.get(item.habitId).push(item.dayKey);
    });

    let doneKeysAdded = 0;
    let failedKeysRemoved = 0;
    state.habits = (state.habits || []).map((habit) => {
      const habitId = String(habit?.id || '');
      const additions = additionsByHabit.get(habitId) || [];
      const removals = removalsByHabit.get(habitId) || [];
      if (!additions.length && !removals.length) return habit;

      const originalDoneKeys = ledgerArray(habit, 'doneKeys');
      const originalFailedKeys = ledgerArray(habit, 'failedKeys');
      if (!originalDoneKeys || !originalFailedKeys) {
        throw new Error(`Habit ${habitId || '(unknown)'} ledger shape changed after preview.`);
      }

      let nextDoneKeys = originalDoneKeys;
      additions.forEach((dayKey) => {
        if (nextDoneKeys.includes(dayKey)) return;
        if (nextDoneKeys === originalDoneKeys) nextDoneKeys = originalDoneKeys.slice();
        nextDoneKeys.push(dayKey);
        doneKeysAdded += 1;
      });

      let nextFailedKeys = originalFailedKeys;
      const removalSet = new Set(removals);
      const presentRemovalDays = removals.filter((dayKey) => originalFailedKeys.includes(dayKey));
      if (presentRemovalDays.length) {
        // Remove only occurrences of the exact previewed dates. Every unrelated value,
        // duplicate, malformed key, and original relative order is preserved.
        nextFailedKeys = originalFailedKeys.filter((value) => !removalSet.has(value));
        failedKeysRemoved += presentRemovalDays.length;
      }

      if (nextDoneKeys === originalDoneKeys && nextFailedKeys === originalFailedKeys) return habit;
      const nextHabit = { ...habit };
      if (nextDoneKeys !== originalDoneKeys) nextHabit.doneKeys = nextDoneKeys;
      if (nextFailedKeys !== originalFailedKeys) nextHabit.failedKeys = nextFailedKeys;
      return nextHabit;
    });

    if (outsideLedgerSnapshot(state) !== beforeOtherDomains) {
      throw new Error('The repair attempted to change data outside habits and completions.');
    }

    return {
      ...baseResult,
      state,
      completionBackedSourceRowsUpdated: sourceRowsUpdated,
      doneKeysAdded,
      failedKeysRemoved,
      manualReviewCount: livePlan.manualReview.length
    };
  }

  function readStoredState(fallback = null) {
    if (typeof core.readTaskPointsStoredState === 'function') {
      return core.readTaskPointsStoredState(STORAGE_KEY, fallback);
    }
    const raw = global.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    return typeof core.parseTaskPointsStorageJson === 'function'
      ? core.parseTaskPointsStorageJson(raw, fallback || {})
      : JSON.parse(raw);
  }

  function installPanel() {
    const parent = global.document?.getElementById('habitLedgerRepairPanel');
    if (!parent || global.document.getElementById('completionBackedHabitRepair')) return false;
    const backupCheckbox = parent.querySelector('#habitLedgerBackupConfirmed');
    if (!backupCheckbox) return false;

    const section = global.document.createElement('div');
    section.id = 'completionBackedHabitRepair';
    section.className = 'border-t border-zinc-700/60 pt-4 space-y-3';
    section.innerHTML = `
      <div class="font-semibold">Full completion-backed reconciliation</div>
      <p class="muted text-sm">
        Restores missing doneKeys from existing point-bearing completion rows, clears
        corroborated stray failedKeys, and never invents completion/point rows.
      </p>
      <div class="flex flex-wrap gap-2">
        <button id="previewCompletionBackedRepairBtn" type="button" class="btn btn-primary">Preview Full Habit Repair</button>
        <button id="applyCompletionBackedRepairBtn" type="button" class="btn btn-ghost" disabled>Apply Full Habit Repair</button>
      </div>
      <div id="completionBackedRepairStatus" class="muted text-sm">Run the preview first.</div>
      <div id="completionBackedRepairSummary" class="text-sm"></div>
    `;
    parent.appendChild(section);

    const previewButton = section.querySelector('#previewCompletionBackedRepairBtn');
    const applyButton = section.querySelector('#applyCompletionBackedRepairBtn');
    const status = section.querySelector('#completionBackedRepairStatus');
    const summary = section.querySelector('#completionBackedRepairSummary');
    let previewPlan = null;

    const updateEnabled = () => {
      applyButton.disabled = !(
        previewPlan
        && totalConfirmedCount(previewPlan) > 0
        && backupCheckbox.checked
        && !impactBlocked(previewPlan)
      );
    };

    previewButton.addEventListener('click', () => {
      backupCheckbox.checked = false;
      previewPlan = null;
      updateEnabled();
      try {
        const state = readStoredState(null);
        if (!state) throw new Error('No TaskPoints state was found.');
        previewPlan = buildCompletionBackedPlan(state);
        const impactBlocks = previewPlan.basePlan?.matchupImpact?.blockingDays?.length || 0;
        summary.innerHTML =
          `Source corrections: <strong>${(previewPlan.basePlan.sourceUpdates?.length || 0) + previewPlan.sourceFixes.length}</strong><br>`
          + `Completion removals: <strong>${(previewPlan.basePlan.failedDateRemovals?.length || 0) + (previewPlan.basePlan.duplicateRemovals?.length || 0)}</strong><br>`
          + `doneKeys to restore: <strong>${previewPlan.doneKeyAdditions.length}</strong><br>`
          + `failedKeys to clear: <strong>${previewPlan.failedKeyRemovals.length}</strong><br>`
          + `Manual review remaining: <strong>${previewPlan.manualReview.length}</strong><br>`
          + `Matchup-impact blocks: <strong>${impactBlocks}</strong>`;
        status.textContent = !totalConfirmedCount(previewPlan)
          ? 'No deterministic completion-backed repairs remain.'
          : impactBlocked(previewPlan)
            ? 'Preview ready, but point removals are blocked by matchup-impact safety.'
            : `Preview ready: ${totalConfirmedCount(previewPlan)} deterministic change(s). Confirm the fresh backup to apply.`;
      } catch (error) {
        status.textContent = `Preview failed: ${error.message || error}`;
      }
      updateEnabled();
    });

    backupCheckbox.addEventListener('change', updateEnabled);

    applyButton.addEventListener('click', () => {
      if (!previewPlan || !backupCheckbox.checked || impactBlocked(previewPlan)) return;
      applyButton.disabled = true;
      try {
        const liveState = readStoredState(null);
        if (!liveState) throw new Error('No TaskPoints state was found.');
        const result = applyCompletionBackedPlan(liveState, previewPlan);
        const saved = core.saveStateSnapshot(result.state, {
          savePath: 'audit-habit-ledger-completion-backed-repair',
          userInitiated: true,
          interactive: true,
          immediateWrite: true,
          replaceCompletions: true,
          allowDestructiveOverwrite: true
        });
        if (saved?.blocked || saved?.ok === false || saved?.skipped
          || saved?.blockedByQuotaCircuit || !saved?.state) {
          throw new Error(saved?.reason || saved?.error || 'The repaired state could not be saved.');
        }

        const persisted = readStoredState(null);
        if (!persisted) throw new Error('The repaired state could not be verified.');
        const remaining = buildCompletionBackedPlan(persisted);
        if (totalConfirmedCount(remaining)) {
          throw new Error(`${totalConfirmedCount(remaining)} deterministic repair(s) did not persist.`);
        }

        status.textContent =
          `Repair saved: ${(Number(result.sourceRowsUpdated) || 0) + (Number(result.completionBackedSourceRowsUpdated) || 0)} source correction(s), `
          + `${result.failedRowsRemoved || 0} failed-date row(s) removed, `
          + `${result.duplicateRowsRemoved || 0} duplicate row(s) removed, `
          + `${result.doneKeysAdded} doneKey(s) restored, and `
          + `${result.failedKeysRemoved} failedKey(s) cleared. Rerun the Audit.`;
        previewPlan = remaining;
        backupCheckbox.checked = false;
        if (typeof global.runAudit === 'function') {
          try { global.runAudit(); } catch (_) {}
        }
      } catch (error) {
        status.textContent = `Repair failed: ${error.message || error}`;
      }
      updateEnabled();
    });

    return true;
  }

  const api = {
    buildPlan: buildCompletionBackedPlan,
    applyPlan: applyCompletionBackedPlan,
    fingerprint: planFingerprint,
    totalCount: totalConfirmedCount,
    blocked: impactBlocked,
    installPanel,
    buildCompletionBackedPlan,
    applyCompletionBackedPlan,
    planFingerprint,
    fullConfirmedCount: totalConfirmedCount,
    impactBlocked
  };
  global.TaskPointsCompletionBackedHabitRepair = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  let attempts = 0;
  const install = () => {
    if (installPanel()) return;
    if (++attempts < 120) global.setTimeout?.(install, 50);
  };
  install();
})(typeof window !== 'undefined' ? window : globalThis);
