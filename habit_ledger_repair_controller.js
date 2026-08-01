;(function installSafeHabitLedgerRepairController(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const repair = global.TaskPointsHabitLedgerRepair;
  if (!core || !repair || core.__habitLedgerRepairControllerInstalled) return;
  core.__habitLedgerRepairControllerInstalled = true;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const MAX_SAMPLE_ROWS = 18;

  const populated = (value) =>
    value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');

  function readStoredState() {
    if (typeof core.readTaskPointsStoredState === 'function') {
      const state = core.readTaskPointsStoredState(STORAGE_KEY, null);
      if (state && typeof state === 'object') return state;
      throw new Error('The shared TaskPoints reader returned no usable state.');
    }

    const raw = global.localStorage?.getItem(STORAGE_KEY);
    if (!raw) throw new Error('No TaskPoints state was found in local storage.');
    if (typeof core.parseTaskPointsStorageJson === 'function') {
      const state = core.parseTaskPointsStorageJson(raw, null);
      if (state && typeof state === 'object') return state;
      throw new Error('The shared TaskPoints parser returned no usable state.');
    }

    throw new Error('The shared TaskPoints storage decoder is unavailable.');
  }

  function completionHabitId(row) {
    return String(row?.habitId || row?.viceId || '').trim();
  }

  function expectedSource(habit) {
    return habit?.category === 'vice' ? 'vice' : 'habit';
  }

  function confirmedCount(plan) {
    return (plan?.sourceUpdates?.length || 0)
      + (plan?.failedDateRemovals?.length || 0)
      + (plan?.duplicateRemovals?.length || 0);
  }

  function installFutureSourceGuard() {
    if (core.__safeHabitCompletionSourceGuardInstalled || typeof core.saveStateSnapshot !== 'function') return;
    core.__safeHabitCompletionSourceGuardInstalled = true;
    const originalSave = core.saveStateSnapshot.bind(core);

    core.saveStateSnapshot = function safeHabitCompletionSave(nextState, options) {
      let adjusted = nextState;
      try {
        const previous = readStoredState();
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
        const completions = (Array.isArray(nextState?.completions) ? nextState.completions : [])
          .map((row) => {
            if (!row || (row.source !== 'habit' && row.source !== 'vice')) return row;
            const id = String(row.id || '').trim();
            if (!id || previousIds.has(id)) return row;
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
        console.warn('Safe habit completion source guard skipped normalization', error);
      }
      return originalSave(adjusted, options);
    };
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
    const number = Number(value);
    return Number.isFinite(number) ? String(Number(number.toFixed(2))) : String(value ?? '');
  }

  function renderRows(items, formatter) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return '<div class="muted text-sm mt-1">None.</div>';
    const shown = list.slice(0, MAX_SAMPLE_ROWS).map((item) => `<li>${formatter(item)}</li>`).join('');
    const omitted = list.length > MAX_SAMPLE_ROWS
      ? `<li class="muted">… ${list.length - MAX_SAMPLE_ROWS} more</li>`
      : '';
    return `<ul class="text-sm space-y-1 mt-2" style="padding-left:1.25rem;list-style:disc">${shown}${omitted}</ul>`;
  }

  function installAuditPanel() {
    const auditChecks = global.document?.getElementById('auditChecks');
    if (!auditChecks || global.document.getElementById('habitLedgerRepairPanel')) return false;
    const main = auditChecks.closest('main');
    if (!main) return false;

    const panel = global.document.createElement('section');
    panel.id = 'habitLedgerRepairPanel';
    panel.className = 'glass space-y-3';
    panel.innerHTML = `
      <div>
        <div class="text-lg font-semibold">Habit-Ledger Consistency Repair</div>
        <p class="muted text-sm mt-1">
          Preview safe completion-ledger repairs. Confirmed changes can correct vice source labels,
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
        <div><div id="habitLedgerSourceCount" class="font-semibold">Vice source labels to correct: 0</div><div id="habitLedgerSourceRows"></div></div>
        <div><div id="habitLedgerFailedCount" class="font-semibold">Failed-date completion rows to remove: 0</div><div id="habitLedgerFailedRows"></div></div>
        <div><div id="habitLedgerDuplicateCount" class="font-semibold">Exact duplicate rows to remove: 0</div><div id="habitLedgerDuplicateRows"></div></div>
        <div><div id="habitLedgerManualCount" class="font-semibold">Needs manual review: 0</div><div id="habitLedgerManualRows"></div></div>
        <div id="habitLedgerPointsImpact" class="muted text-sm">Completion points removed by confirmed cleanup: 0.</div>
      </div>
    `;
    main.appendChild(panel);

    const previewButton = panel.querySelector('#previewHabitLedgerRepairBtn');
    const repairButton = panel.querySelector('#applyHabitLedgerRepairBtn');
    const backupCheckbox = panel.querySelector('#habitLedgerBackupConfirmed');
    const status = panel.querySelector('#habitLedgerRepairStatus');
    let previewPlan = null;

    const updateEnabled = () => {
      repairButton.disabled = !(confirmedCount(previewPlan) > 0 && backupCheckbox.checked);
    };

    const renderPlan = (plan) => {
      panel.querySelector('#habitLedgerSourceCount').textContent = `Vice source labels to correct: ${plan.sourceUpdates.length}`;
      panel.querySelector('#habitLedgerFailedCount').textContent = `Failed-date completion rows to remove: ${plan.failedDateRemovals.length}`;
      panel.querySelector('#habitLedgerDuplicateCount').textContent = `Exact duplicate rows to remove: ${plan.duplicateRemovals.length}`;
      panel.querySelector('#habitLedgerManualCount').textContent = `Needs manual review: ${plan.manualReview.length}`;
      panel.querySelector('#habitLedgerPointsImpact').textContent =
        `Completion points removed by confirmed cleanup: ${formatPoints(plan.pointsRemoved)}. ` +
        'Habits, matchups, game history, Gold, and Season records are not edited.';

      panel.querySelector('#habitLedgerSourceRows').innerHTML = renderRows(
        plan.sourceUpdates,
        (item) => `${escapeHtml(item.habitName)} on ${escapeHtml(item.dayKey)}: ${escapeHtml(item.fromSource)} → ${escapeHtml(item.toSource)}`
      );
      panel.querySelector('#habitLedgerFailedRows').innerHTML = renderRows(
        plan.failedDateRemovals,
        (item) => `${escapeHtml(item.habitName)} on ${escapeHtml(item.dayKey)}: remove ${formatPoints(item.points)}-point completion ${escapeHtml(item.completionId)}`
      );
      panel.querySelector('#habitLedgerDuplicateRows').innerHTML = renderRows(
        plan.duplicateRemovals,
        (item) => `${escapeHtml(item.habitName)} on ${escapeHtml(item.dayKey)}: remove duplicate ${escapeHtml(item.completionId)}; keep ${escapeHtml(item.keepCompletionId)}`
      );
      panel.querySelector('#habitLedgerManualRows').innerHTML = renderRows(
        plan.manualReview,
        (item) => `${escapeHtml(item.habitName || item.habitId || 'Completion')} ${item.dayKey ? `on ${escapeHtml(item.dayKey)}: ` : ''}${escapeHtml(item.reason)}`
      );
    };

    previewButton.addEventListener('click', () => {
      try {
        previewPlan = repair.buildHabitLedgerRepairPlan(readStoredState());
        renderPlan(previewPlan);
        status.textContent = confirmedCount(previewPlan)
          ? `Preview ready: ${confirmedCount(previewPlan)} confirmed change(s). Manual-review rows will not be changed.`
          : 'No confirmed automatic habit-ledger repairs are currently needed.';
      } catch (error) {
        console.error('Habit-ledger repair preview failed', error);
        previewPlan = null;
        status.textContent = `Preview failed: ${error.message || error}`;
      }
      updateEnabled();
    });

    backupCheckbox.addEventListener('change', updateEnabled);

    repairButton.addEventListener('click', () => {
      if (!previewPlan || !backupCheckbox.checked) return;
      repairButton.disabled = true;
      try {
        if (typeof core.saveStateSnapshot !== 'function') {
          throw new Error('The centralized TaskPoints save helper is unavailable.');
        }
        const liveState = readStoredState();
        const result = repair.applyHabitLedgerRepairPlan(liveState, previewPlan);
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
          immediateWrite: true,
          replaceCompletions: true
        });
        if (saved?.blocked || saved?.ok === false || saved?.skipped || saved?.blockedByQuotaCircuit) {
          throw new Error(saved?.reason || saved?.error || 'The save was blocked or skipped.');
        }

        const persistedState = readStoredState();
        const persistedPlan = repair.buildHabitLedgerRepairPlan(persistedState);
        if (confirmedCount(persistedPlan) !== 0) {
          throw new Error('The saved state did not retain all confirmed repairs. No success was reported.');
        }
        const intendedCount = Array.isArray(result.state.completions) ? result.state.completions.length : 0;
        const persistedCount = Array.isArray(persistedState.completions) ? persistedState.completions.length : 0;
        if (persistedCount !== intendedCount) {
          throw new Error(`Completion count verification failed: expected ${intendedCount}, found ${persistedCount}.`);
        }

        status.textContent =
          `Repair saved and verified: ${result.sourceRowsUpdated} source label(s) corrected, ` +
          `${result.failedRowsRemoved} failed-date completion row(s) removed, and ` +
          `${result.duplicateRowsRemoved} exact duplicate row(s) removed. ` +
          `${result.manualReviewCount} row(s) remain manual review. Rerun the Audit.`;
        previewPlan = persistedPlan;
        renderPlan(previewPlan);
        backupCheckbox.checked = false;
        if (typeof global.runAudit === 'function') {
          try { global.runAudit(); } catch (_) {}
        }
      } catch (error) {
        console.error('Habit-ledger repair failed', error);
        status.textContent = `Repair failed: ${error.message || error}`;
      } finally {
        updateEnabled();
      }
    });

    return true;
  }

  global.TaskPointsHabitLedgerRepairController = {
    readStoredState,
    installFutureSourceGuard,
    installAuditPanel,
    confirmedCount
  };

  installFutureSourceGuard();
  const tryInstallPanel = () => installAuditPanel();
  if (global.document?.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', tryInstallPanel, { once: true });
  } else if (global.document) {
    tryInstallPanel();
  }
})(typeof window !== 'undefined' ? window : globalThis);
