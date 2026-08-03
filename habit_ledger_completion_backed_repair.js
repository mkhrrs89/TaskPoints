;(function installCompletionBackedHabitRepair(g) {
  'use strict';
  const core = g.TaskPointsCore;
  const planner = g.TaskPointsHabitLedgerRepair;
  if (!core || !planner || g.__completionBackedHabitRepairInstalled) return;
  g.__completionBackedHabitRepairInstalled = true;
  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const populated = (v) => v !== null && v !== undefined && (typeof v !== 'string' || v.trim() !== '');
  const validDay = (v) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number); const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  };
  const clone = (v) => {
    if (v == null) return v;
    if (typeof g.structuredClone === 'function') { try { return g.structuredClone(v); } catch (_) {} }
    return JSON.parse(JSON.stringify(v));
  };
  const stable = (v) => {
    if (Array.isArray(v)) return v.map(stable);
    if (!v || typeof v !== 'object') return v;
    const out = {}; Object.keys(v).sort().forEach((key) => { out[key] = stable(v[key]); }); return out;
  };
  const dayOf = (row) => {
    for (const value of [row?.dayKey, row?.dateKey]) {
      const direct = String(value || '').slice(0, 10); if (validDay(direct)) return direct;
    }
    for (const value of [row?.completedAtISO, row?.createdAtISO]) {
      if (!populated(value)) continue;
      const date = new Date(value); if (Number.isNaN(date.getTime())) continue;
      if (typeof core.dateKey === 'function') { try { const key = core.dateKey(date); if (validDay(key)) return key; } catch (_) {} }
      const key = date.toISOString().slice(0, 10); if (validDay(key)) return key;
    }
    return '';
  };
  const habitIdOf = (row) => String(row?.habitId || row?.viceId || '').trim();
  const completionIdOf = (row) => String(row?.id || '').trim();
  const habitName = (habit, id) => String(habit?.name || habit?.title || habit?.label || id || 'Unknown habit');
  const expectedSource = (habit) => habit?.category === 'vice' ? 'vice' : 'habit';
  const uniqueDays = (rows) => [...new Set((Array.isArray(rows) ? rows : []).filter(validDay))].sort();
  const baseCount = (plan) => (plan?.sourceUpdates?.length || 0) + (plan?.failedDateRemovals?.length || 0) + (plan?.duplicateRemovals?.length || 0);
  const totalCount = (plan) => baseCount(plan?.basePlan) + (plan?.doneKeyAdditions?.length || 0) + (plan?.failedKeyRemovals?.length || 0) + (plan?.sourceFixes?.length || 0);

  function buildPlan(stateInput) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const basePlan = planner.buildHabitLedgerRepairPlan(state);
    const habits = Array.isArray(state.habits) ? state.habits : [];
    const completions = Array.isArray(state.completions) ? state.completions : [];
    const habitsById = new Map(habits.filter((h) => h && populated(h.id)).map((h) => [String(h.id), h]));
    const removed = new Set([...(basePlan.failedDateRemovals || []), ...(basePlan.duplicateRemovals || [])].map((x) => x.completionIndex));
    const baseSource = new Set((basePlan.sourceUpdates || []).map((x) => x.completionIndex));
    const blockedIndexes = new Set(); const blockedGroups = new Set(); const idCounts = new Map();
    completions.forEach((row) => { const id = completionIdOf(row); if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1); });
    (basePlan.manualReview || []).forEach((item) => {
      const type = String(item?.type || '');
      if (type === 'completion-without-ledger-status' || type === 'conflicting-ledger-status') return;
      if (Number.isInteger(item?.completionIndex)) blockedIndexes.add(item.completionIndex);
      if (type === 'duplicate-completion-id' && item?.completionId) completions.forEach((row, i) => { if (completionIdOf(row) === String(item.completionId)) blockedIndexes.add(i); });
      if (type === 'nonidentical-duplicate' && item?.habitId && item?.dayKey) blockedGroups.add(`${item.habitId}|${item.dayKey}`);
    });
    const entries = [];
    completions.forEach((row, index) => {
      if (!row || !['habit', 'vice'].includes(row.source) || removed.has(index) || blockedIndexes.has(index)) return;
      const habitId = habitIdOf(row); const dayKey = dayOf(row); const id = completionIdOf(row); const habit = habitsById.get(habitId);
      if (!habit || !validDay(dayKey) || !id || idCounts.get(id) !== 1 || blockedGroups.has(`${habitId}|${dayKey}`)) return;
      entries.push({ row, index, id, habit, habitId, dayKey, key: `${habitId}|${dayKey}` });
    });
    const groupCounts = new Map(); entries.forEach((e) => groupCounts.set(e.key, (groupCounts.get(e.key) || 0) + 1));
    const done = new Map(); const failed = new Map(); const sourceFixes = [];
    entries.forEach((e) => {
      if (groupCounts.get(e.key) !== 1) return;
      const doneKeys = new Set(Array.isArray(e.habit.doneKeys) ? e.habit.doneKeys : []);
      const failedKeys = new Set(Array.isArray(e.habit.failedKeys) ? e.habit.failedKeys : []);
      const iceKeys = new Set(Array.isArray(e.habit.iceKeys) ? e.habit.iceKeys : []);
      const isDone = doneKeys.has(e.dayKey), isFailed = failedKeys.has(e.dayKey), isIced = iceKeys.has(e.dayKey);
      if (isFailed && (isDone || isIced)) failed.set(e.key, { habitId: e.habitId, habitName: habitName(e.habit, e.habitId), dayKey: e.dayKey });
      if (!isDone && (!isFailed || isIced)) done.set(e.key, { habitId: e.habitId, habitName: habitName(e.habit, e.habitId), dayKey: e.dayKey, completionId: e.id });
      const toSource = expectedSource(e.habit);
      if (e.row.source !== toSource && !baseSource.has(e.index)) sourceFixes.push({ completionId: e.id, habitId: e.habitId, dayKey: e.dayKey, fromSource: e.row.source, toSource });
    });
    const doneKeyAdditions = [...done.values()]; const failedKeyRemovals = [...failed.values()];
    const resolved = new Set();
    doneKeyAdditions.forEach((x) => resolved.add(`completion-without-ledger-status|${x.habitId}|${x.dayKey}`));
    failedKeyRemovals.forEach((x) => resolved.add(`conflicting-ledger-status|${x.habitId}|${x.dayKey}`));
    const manualReview = (basePlan.manualReview || []).filter((x) => !resolved.has(`${x?.type || ''}|${x?.habitId || ''}|${x?.dayKey || ''}`));
    const sort = (a, b) => String(a.dayKey || '').localeCompare(String(b.dayKey || '')) || String(a.habitName || '').localeCompare(String(b.habitName || ''));
    doneKeyAdditions.sort(sort); failedKeyRemovals.sort(sort); sourceFixes.sort(sort);
    return { basePlan, doneKeyAdditions, failedKeyRemovals, sourceFixes, manualReview };
  }

  function fingerprint(plan) {
    const base = typeof planner.planFingerprint === 'function' ? planner.planFingerprint(plan?.basePlan || {}) : JSON.stringify(stable(plan?.basePlan || {}));
    return JSON.stringify(stable({ base, doneKeyAdditions: plan?.doneKeyAdditions || [], failedKeyRemovals: plan?.failedKeyRemovals || [], sourceFixes: plan?.sourceFixes || [], manualReview: (plan?.manualReview || []).map((x) => ({ type: x?.type, habitId: x?.habitId, dayKey: x?.dayKey, completionId: x?.completionId })) }));
  }
  const outsideLedger = (state) => { const copy = clone(state || {}); delete copy.habits; delete copy.completions; return JSON.stringify(stable(copy)); };
  function blocked(plan) {
    const removals = (plan?.basePlan?.failedDateRemovals?.length || 0) + (plan?.basePlan?.duplicateRemovals?.length || 0);
    if (!removals) return false;
    const impact = plan?.basePlan?.matchupImpact;
    return !impact || impact.completeImpactChain !== true || impact.hasBlockingImpact === true;
  }

  function applyPlan(stateInput, preview) {
    const live = buildPlan(stateInput);
    if (fingerprint(live) !== fingerprint(preview)) throw new Error('The habit/completion state changed after preview. Run it again.');
    const before = outsideLedger(stateInput);
    const result = planner.applyHabitLedgerRepairPlan(stateInput, preview.basePlan);
    const state = clone(result?.state || stateInput || {});
    let sourceRowsUpdated = 0;
    (live.sourceFixes || []).forEach((fix) => {
      const matches = (state.completions || []).filter((row) => completionIdOf(row) === fix.completionId);
      if (matches.length !== 1 || habitIdOf(matches[0]) !== fix.habitId || dayOf(matches[0]) !== fix.dayKey) throw new Error(`Completion ${fix.completionId} changed after preview.`);
      if (matches[0].source !== fix.toSource) { matches[0].source = fix.toSource; if (!populated(matches[0].habitId) && populated(matches[0].viceId)) matches[0].habitId = matches[0].viceId; sourceRowsUpdated += 1; }
    });
    const additions = new Map(), removals = new Map();
    live.doneKeyAdditions.forEach((x) => { if (!additions.has(x.habitId)) additions.set(x.habitId, new Set()); additions.get(x.habitId).add(x.dayKey); });
    live.failedKeyRemovals.forEach((x) => { if (!removals.has(x.habitId)) removals.set(x.habitId, new Set()); removals.get(x.habitId).add(x.dayKey); });
    let doneKeysAdded = 0, failedKeysRemoved = 0;
    state.habits = (state.habits || []).map((habit) => {
      const id = String(habit?.id || ''); const add = additions.get(id), remove = removals.get(id); if (!add && !remove) return habit;
      const doneKeys = new Set(Array.isArray(habit.doneKeys) ? habit.doneKeys : []); const failedKeys = new Set(Array.isArray(habit.failedKeys) ? habit.failedKeys : []);
      (add || []).forEach((day) => { if (!doneKeys.has(day)) doneKeysAdded += 1; doneKeys.add(day); });
      (remove || []).forEach((day) => { if (failedKeys.delete(day)) failedKeysRemoved += 1; });
      return { ...habit, doneKeys: uniqueDays([...doneKeys]), failedKeys: uniqueDays([...failedKeys]), iceKeys: uniqueDays(habit.iceKeys) };
    });
    if (outsideLedger(state) !== before) throw new Error('The repair attempted to change data outside habits and completions.');
    return { ...result, state, completionBackedSourceRowsUpdated: sourceRowsUpdated, doneKeysAdded, failedKeysRemoved, manualReviewCount: live.manualReview.length };
  }

  function readState(fallback = null) {
    if (typeof core.readTaskPointsStoredState === 'function') return core.readTaskPointsStoredState(STORAGE_KEY, fallback);
    const raw = g.localStorage?.getItem(STORAGE_KEY); if (!raw) return fallback;
    return typeof core.parseTaskPointsStorageJson === 'function' ? core.parseTaskPointsStorageJson(raw, fallback || {}) : JSON.parse(raw);
  }
  function installPanel() {
    const parent = g.document?.getElementById('habitLedgerRepairPanel');
    if (!parent || g.document.getElementById('completionBackedHabitRepair')) return false;
    const backup = parent.querySelector('#habitLedgerBackupConfirmed'); if (!backup) return false;
    const section = g.document.createElement('div'); section.id = 'completionBackedHabitRepair'; section.className = 'border-t border-zinc-700/60 pt-4 space-y-3';
    section.innerHTML = '<div class="font-semibold">Full completion-backed reconciliation</div><p class="muted text-sm">Restores missing doneKeys from existing point-bearing completion rows, clears corroborated stray failedKeys, and never invents completion/point rows.</p><div class="flex flex-wrap gap-2"><button id="previewCompletionBackedRepairBtn" type="button" class="btn btn-primary">Preview Full Habit Repair</button><button id="applyCompletionBackedRepairBtn" type="button" class="btn btn-ghost" disabled>Apply Full Habit Repair</button></div><div id="completionBackedRepairStatus" class="muted text-sm">Run the preview first.</div><div id="completionBackedRepairSummary" class="text-sm"></div>';
    parent.appendChild(section);
    const previewButton = section.querySelector('#previewCompletionBackedRepairBtn'), applyButton = section.querySelector('#applyCompletionBackedRepairBtn'), status = section.querySelector('#completionBackedRepairStatus'), summary = section.querySelector('#completionBackedRepairSummary');
    let preview = null;
    const enable = () => { applyButton.disabled = !(preview && totalCount(preview) > 0 && backup.checked && !blocked(preview)); };
    previewButton.addEventListener('click', () => {
      backup.checked = false; preview = null; enable();
      try {
        const state = readState(null); if (!state) throw new Error('No TaskPoints state was found.'); preview = buildPlan(state);
        const impactBlocks = preview.basePlan?.matchupImpact?.blockingDays?.length || 0;
        summary.innerHTML = `Source corrections: <strong>${(preview.basePlan.sourceUpdates?.length || 0) + preview.sourceFixes.length}</strong><br>Completion removals: <strong>${(preview.basePlan.failedDateRemovals?.length || 0) + (preview.basePlan.duplicateRemovals?.length || 0)}</strong><br>doneKeys to restore: <strong>${preview.doneKeyAdditions.length}</strong><br>failedKeys to clear: <strong>${preview.failedKeyRemovals.length}</strong><br>Manual review remaining: <strong>${preview.manualReview.length}</strong><br>Matchup-impact blocks: <strong>${impactBlocks}</strong>`;
        status.textContent = !totalCount(preview) ? 'No deterministic completion-backed repairs remain.' : blocked(preview) ? 'Preview ready, but point removals are blocked by matchup-impact safety.' : `Preview ready: ${totalCount(preview)} deterministic change(s). Confirm the fresh backup to apply.`;
      } catch (error) { status.textContent = `Preview failed: ${error.message || error}`; }
      enable();
    });
    backup.addEventListener('change', enable);
    applyButton.addEventListener('click', () => {
      if (!preview || !backup.checked || blocked(preview)) return;
      applyButton.disabled = true;
      try {
        const live = readState(null); if (!live) throw new Error('No TaskPoints state was found.'); const result = applyPlan(live, preview);
        const saved = core.saveStateSnapshot(result.state, { savePath: 'audit-habit-ledger-completion-backed-repair', userInitiated: true, interactive: true, immediateWrite: true, replaceCompletions: true, allowDestructiveOverwrite: true });
        if (saved?.blocked || saved?.ok === false || saved?.skipped || saved?.blockedByQuotaCircuit || !saved?.state) throw new Error(saved?.reason || saved?.error || 'The repaired state could not be saved.');
        const persisted = readState(null); if (!persisted) throw new Error('The repaired state could not be verified.');
        const remaining = buildPlan(persisted); if (totalCount(remaining)) throw new Error(`${totalCount(remaining)} deterministic repair(s) did not persist.`);
        status.textContent = `Repair saved: ${(Number(result.sourceRowsUpdated) || 0) + (Number(result.completionBackedSourceRowsUpdated) || 0)} source correction(s), ${result.failedRowsRemoved || 0} failed-date row(s) removed, ${result.duplicateRowsRemoved || 0} duplicate row(s) removed, ${result.doneKeysAdded} doneKey(s) restored, and ${result.failedKeysRemoved} failedKey(s) cleared. Rerun the Audit.`;
        preview = remaining; backup.checked = false; if (typeof g.runAudit === 'function') { try { g.runAudit(); } catch (_) {} }
      } catch (error) { status.textContent = `Repair failed: ${error.message || error}`; }
      enable();
    });
    return true;
  }

  const api = { buildPlan, applyPlan, fingerprint, totalCount, blocked, installPanel, buildCompletionBackedPlan: buildPlan, applyCompletionBackedPlan: applyPlan, planFingerprint: fingerprint, fullConfirmedCount: totalCount, impactBlocked: blocked };
  g.TaskPointsCompletionBackedHabitRepair = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  let attempts = 0; const install = () => { if (installPanel()) return; if (++attempts < 120) g.setTimeout?.(install, 50); }; install();
})(typeof window !== 'undefined' ? window : globalThis);
