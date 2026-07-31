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

  function completionDay(row) {
    if (!row || typeof row !== 'object') return '';
    for (const value of [row.dayKey, row.dateKey]) {
      if (validDayKey(value)) return value;
    }
    for (const value of [row.completedAtISO, row.createdAtISO]) {
      if (!populated(value)) continue;
      const direct = String(value).slice(0, 10);
      if (validDayKey(direct)) return direct;
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        const key = parsed.toISOString().slice(0, 10);
        if (validDayKey(key)) return key;
      }
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
      id: String(row?.id || ''),
      source: String(row?.source || ''),
      habitId: completionHabitId(row),
      dayKey: completionDay(row),
      points: finite(row?.points) ? Number(row.points) : row?.points,
      taskId: String(row?.taskId || ''),
      title: String(row?.title || ''),
      completedAtISO: String(row?.completedAtISO || '')
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
    const entries = [];
    const duplicateCompletionIds = new Set();
    const seenCompletionIds = new Set();

    const addManual = (item) => {
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
      addManual({
        type: 'duplicate-completion-id',
        completionId: id,
        reason: `More than one completion row uses ID ${id}.`
      });
    });

    const failedDateRemovals = [];
    const duplicateRemovals = [];
    const removalIndexes = new Set();

    entries.forEach((entry) => {
      if (!entry.failed) return;
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

    const activeGroups = new Map();
    entries.forEach((entry) => {
      if (removalIndexes.has(entry.index)) return;
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
        });
      }
    });

    const sourceUpdates = [];
    entries.forEach((entry) => {
      if (removalIndexes.has(entry.index)) return;
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

      if (!entry.done && !entry.failed) {
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

  function readStoredState() {
    const raw = global.localStorage?.getItem(STORAGE_KEY);
    if (!raw) throw new Error('No TaskPoints state was found in local storage.');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('The stored TaskPoints state is invalid.');
    return parsed;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatPoints(value) {
    return finite(value) ? String(Number(Number(value).toFixed(2))) : String(value ?? '');
  }

  function renderRows(items, formatter) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return '<div class="muted text-sm mt-1">None.</div>';
    const shown = list.slice(0, MAX_SAMPLE_ROWS)
      .map((item) => `<li>${formatter(item)}</li>`)
      .join('');
    const omitted = list.length > MAX_SAMPLE_ROWS
      ? `<li class="muted">… ${list.length - MAX_SAMPLE_ROWS} more</li>`
      : '';
    return `<ul class="text-sm space-y-1 mt-2" style="padding-left:1.25rem;list-style:disc">${shown}${omitted}</ul>`;
  }

  function installFutureSourceGuard(core) {
    if (!core || core.__habitCompletionSourceGuardInstalled || typeof core.saveStateSnapshot !== 'function') return;
    core.__habitCompletionSourceGuardInstalled = true;
    const originalSave = core.saveStateSnapshot.bind(core);

    core.saveStateSnapshot = function guardedHabitCompletionSave(nextState, options) {
      let adjusted = nextState;
      try {
        const rawPrevious = global.localStorage?.getItem(STORAGE_KEY);
        const previous = rawPrevious ? JSON.parse(rawPrevious) : null;
        const previousIds = new Set(
          (Array.isArray(previous?.completions) ? previous.completions : [])
            .map((row) => String(row?.id || '').trim())
            .filter(Boolean)
        );
        const habitsById = new Map(
          (Array.isArray(nextState?.habits) ? nextState.habits : [])
            .filter((habit) => habit && populated(habit.id))
            .map((habit) => [String(habit.id), habit])
        );
        let changed = false;
        const completions = (Array.isArray(nextState?.completions) ? nextState.completions : []).map((row) => {
          if (!row || (row.source !== 'habit' && row.source !== 'vice')) return row;
          const id = String(row.id || '').trim();
          if (id && previousIds.has(id)) return row;
          const habitId = completionHabitId(row);
          const habit = habitsById.get(habitId);
          if (!habit) return row;
          const desired = expectedSource(habit);
          if (row.source === desired && (populated(row.habitId) || !populated(row.viceId))) return row;
          changed = true;
          const next = { ...row, source: desired };
          if (!populated(next.habitId) && populated(next.viceId)) next.habitId = next.viceId;
          return next;
        });
        if (changed) adjusted = { ...nextState, completions };
      } catch (error) {
        console.warn('Habit completion source guard skipped normalization', error);
      }
      return originalSave(adjusted, options);
    };
  }

  function installAuditPanel(core) {
    const auditChecks = global.document?.getElementById('auditChecks');
    const main = auditChecks?.closest('main') || global.document?.querySelector('main');
    if (!main || global.document.getElementById('habitLedgerRepairPanel')) return false;

    const panel = global.document.createElement('section');
    panel.id = 'habitLedgerRepairPanel';
    panel.className = 'glass space-y-3';
    panel.innerHTML = `
      <div>
        <div class="text-lg font-semibold">Habit-Ledger Consistency Repair</div>
        <p class="muted text-sm mt-1">
          Preview safe completion-ledger repairs. The repair can correct vice source labels,
          remove completion rows on dates explicitly marked failed, and remove exact duplicate rows.
          Neutral completion/doneKey disagreements remain manual review.
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button id="previewHabitLedgerRepairBtn" type="button" class="btn btn-primary">Preview Habit-Ledger Repair</button>
        <button id="applyHabitLedgerRepairBtn" type="button" class="btn btn-ghost" disabled>Repair Confirmed Habit Rows</button>
      </div>
      <label class="flex items-start gap-2 text-sm">
        <input id="habitLedgerBackupConfirmed" type="checkbox" class="mt-1">
        <span>I exported a fresh full backup of the current phone data.</span>
      </label>
      <div id="habitLedgerRepairStatus" class="muted text-sm">Run the preview before making changes.</div>
      <div class="grid gap-3">
        <div>
          <div id="habitLedgerSourceCount" class="font-semibold">Vice source labels to correct: 0</div>
          <div id="habitLedgerSourceRows"></div>
        </div>
        <div>
          <div id="habitLedgerFailedCount" class="font-semibold">Failed-date completion rows to remove: 0</div>
          <div id="habitLedgerFailedRows"></div>
        </div>
        <div>
          <div id="habitLedgerDuplicateCount" class="font-semibold">Exact duplicate rows to remove: 0</div>
          <div id="habitLedgerDuplicateRows"></div>
        </div>
        <div>
          <div id="habitLedgerManualCount" class="font-semibold">Needs manual review: 0</div>
          <div id="habitLedgerManualRows"></div>
        </div>
        <div id="habitLedgerPointsImpact" class="muted text-sm">Completion points removed by confirmed cleanup: 0.</div>
      </div>
    `;

    main.appendChild(panel);

    const previewButton = panel.querySelector('#previewHabitLedgerRepairBtn');
    const repairButton = panel.querySelector('#applyHabitLedgerRepairBtn');
    const backupCheckbox = panel.querySelector('#habitLedgerBackupConfirmed');
    const status = panel.querySelector('#habitLedgerRepairStatus');
    let previewPlan = null;

    const updateRepairEnabled = () => {
      const confirmedCount = (previewPlan?.sourceUpdates?.length || 0)
        + (previewPlan?.failedDateRemovals?.length || 0)
        + (previewPlan?.duplicateRemovals?.length || 0);
      repairButton.disabled = !(confirmedCount > 0 && backupCheckbox.checked);
    };

    const renderPlan = (plan) => {
      panel.querySelector('#habitLedgerSourceCount').textContent =
        `Vice source labels to correct: ${plan.sourceUpdates.length}`;
      panel.querySelector('#habitLedgerFailedCount').textContent =
        `Failed-date completion rows to remove: ${plan.failedDateRemovals.length}`;
      panel.querySelector('#habitLedgerDuplicateCount').textContent =
        `Exact duplicate rows to remove: ${plan.duplicateRemovals.length}`;
      panel.querySelector('#habitLedgerManualCount').textContent =
        `Needs manual review: ${plan.manualReview.length}`;
      panel.querySelector('#habitLedgerPointsImpact').textContent =
        `Completion points removed by confirmed cleanup: ${formatPoints(plan.pointsRemoved)}. ` +
        'Matchups, game history, Gold, and Season records are not directly edited.';

      panel.querySelector('#habitLedgerSourceRows').innerHTML = renderRows(
        plan.sourceUpdates,
        (item) => `${escapeHtml(item.habitName)} on ${escapeHtml(item.dayKey)}: ` +
          `${escapeHtml(item.fromSource)} → ${escapeHtml(item.toSource)}`
      );
      panel.querySelector('#habitLedgerFailedRows').innerHTML = renderRows(
        plan.failedDateRemovals,
        (item) => `${escapeHtml(item.habitName)} on ${escapeHtml(item.dayKey)}: ` +
          `remove ${formatPoints(item.points)}-point completion ${escapeHtml(item.completionId)}`
      );
      panel.querySelector('#habitLedgerDuplicateRows').innerHTML = renderRows(
        plan.duplicateRemovals,
        (item) => `${escapeHtml(item.habitName)} on ${escapeHtml(item.dayKey)}: ` +
          `remove duplicate ${escapeHtml(item.completionId)}; keep ${escapeHtml(item.keepCompletionId)}`
      );
      panel.querySelector('#habitLedgerManualRows').innerHTML = renderRows(
        plan.manualReview,
        (item) => `${escapeHtml(item.habitName || item.habitId || 'Completion')} ` +
          `${item.dayKey ? `on ${escapeHtml(item.dayKey)}: ` : ''}${escapeHtml(item.reason)}`
      );
    };

    previewButton.addEventListener('click', () => {
      try {
        previewPlan = buildHabitLedgerRepairPlan(readStoredState());
        renderPlan(previewPlan);
        const confirmedCount = previewPlan.sourceUpdates.length
          + previewPlan.failedDateRemovals.length
          + previewPlan.duplicateRemovals.length;
        status.textContent = confirmedCount
          ? `Preview ready: ${confirmedCount} confirmed change(s). Manual-review rows will not be changed.`
          : 'No confirmed automatic habit-ledger repairs are currently needed.';
      } catch (error) {
        console.error('Habit-ledger repair preview failed', error);
        previewPlan = null;
        status.textContent = `Preview failed: ${error.message || error}`;
      }
      updateRepairEnabled();
    });

    backupCheckbox.addEventListener('change', updateRepairEnabled);

    repairButton.addEventListener('click', () => {
      if (!previewPlan || !backupCheckbox.checked) return;
      repairButton.disabled = true;
      try {
        if (typeof core.saveStateSnapshot !== 'function') {
          throw new Error('The centralized TaskPoints save helper is unavailable.');
        }
        const liveState = readStoredState();
        const result = applyHabitLedgerRepairPlan(liveState, previewPlan);
        const changed = result.sourceRowsUpdated + result.failedRowsRemoved + result.duplicateRowsRemoved;
        if (!changed) {
          status.textContent = 'No rows changed. The preview may already have been repaired.';
          return;
        }
        if (result.skippedStale) {
          throw new Error(`${result.skippedStale} row(s) changed after preview. Nothing was saved.`);
        }
        const saved = core.saveStateSnapshot(result.state, {
          savePath: 'audit-habit-ledger-consistency-repair',
          userInitiated: true,
          interactive: true,
          immediateWrite: true
        });
        if (saved?.blocked || saved?.ok === false) {
          throw new Error(saved?.reason || saved?.error || 'The save was blocked.');
        }
        status.textContent =
          `Repair saved: ${result.sourceRowsUpdated} source label(s) corrected, ` +
          `${result.failedRowsRemoved} failed-date completion row(s) removed, and ` +
          `${result.duplicateRowsRemoved} exact duplicate row(s) removed. ` +
          `${result.manualReviewCount} row(s) remain manual review. Rerun the Audit.`;
        previewPlan = buildHabitLedgerRepairPlan(readStoredState());
        renderPlan(previewPlan);
        backupCheckbox.checked = false;
        if (typeof global.runAudit === 'function') {
          try { global.runAudit(); } catch (_) {}
        }
      } catch (error) {
        console.error('Habit-ledger repair failed', error);
        status.textContent = `Repair failed: ${error.message || error}`;
      } finally {
        updateRepairEnabled();
      }
    });

    return true;
  }

  const api = {
    buildHabitLedgerRepairPlan,
    applyHabitLedgerRepairPlan,
    planFingerprint,
    semanticCompletionSignature
  };
  global.TaskPointsHabitLedgerRepair = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  const core = global.TaskPointsCore;
  if (!core || core.__habitLedgerConsistencyRepairInstalled) return;
  core.__habitLedgerConsistencyRepairInstalled = true;
  installFutureSourceGuard(core);

  const tryInstall = () => {
    if (global.document) installAuditPanel(core);
  };
  if (global.document?.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', tryInstall, { once: true });
  } else {
    tryInstall();
  }
})(typeof window !== 'undefined' ? window : globalThis);
