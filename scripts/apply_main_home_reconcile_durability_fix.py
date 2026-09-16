from pathlib import Path

# 1) Keep season-series Inbox reconciliation off the foreground interaction path.
season_path = Path('season_series_upset_notifications.js')
season = season_path.read_text()

season = season.replace(
    "  const LOG_RECONCILE_QUIET_MS = 8000;\n",
    "  const LOG_RECONCILE_QUIET_MS = 8000;\n  const HOME_RECONCILE_QUIET_MS = 8000;\n",
    1,
)
season = season.replace(
    "  let executionQuietDeferred = false;\n",
    "  let executionQuietDeferred = false;\n  let homeExecutionQuietDeferred = false;\n",
    1,
)

needle = """  function reconcileStored(options = {}) {\n    const core = global.TaskPointsCore;\n    if (!core?.loadAppState || !core?.mergeAndSaveState || reconciliationRunning) return null;\n    if (deferLogReconcileAtExecution()) return null;\n    reconciliationRunning = true;\n"""
replacement = """  function homeReconcileReadyAtExecution() {\n    if (!isHomePage()) return true;\n    const status = global.TaskPointsCore?.getStorageMaintenanceIdleStatus?.();\n    if (!status || typeof status !== 'object') return false;\n    if (global.document?.visibilityState === 'hidden') return false;\n    if (status.pageLeaving === true || status.activeEditor === true) return false;\n    if (Number(status.navigationQuietForMs || 0) > 0) return false;\n    return Number(status.lastInteractionAgoMs || 0) >= HOME_RECONCILE_QUIET_MS;\n  }\n\n  function deferHomeReconcileAtExecution() {\n    if (!isHomePage() || homeReconcileReadyAtExecution()) {\n      if (homeExecutionQuietDeferred) {\n        const status = global.TaskPointsCore?.getStorageMaintenanceIdleStatus?.();\n        homeExecutionQuietDeferred = false;\n        try {\n          global.TaskPointsPerf?.mark?.('upset.homeExecutionGuardReleased', {\n            requiredQuietMs: HOME_RECONCILE_QUIET_MS,\n            lastInteractionAgoMs: Number(status?.lastInteractionAgoMs || 0)\n          });\n        } catch (_) {}\n      }\n      return false;\n    }\n\n    if (!homeExecutionQuietDeferred) {\n      homeExecutionQuietDeferred = true;\n      const status = global.TaskPointsCore?.getStorageMaintenanceIdleStatus?.();\n      try {\n        global.TaskPointsPerf?.mark?.('upset.homeExecutionGuardDeferred', {\n          requiredQuietMs: HOME_RECONCILE_QUIET_MS,\n          lastInteractionAgoMs: Number(status?.lastInteractionAgoMs || 0),\n          navigationQuietForMs: Number(status?.navigationQuietForMs || 0)\n        });\n      } catch (_) {}\n    }\n    // Poll only the cheap idle status. Never start the full reconciliation until\n    // a fresh execution-time check confirms a sustained quiet window.\n    queueReconcile(500);\n    return true;\n  }\n\n  function reconcileStored(options = {}) {\n    const core = global.TaskPointsCore;\n    if (!core?.loadAppState || !core?.mergeAndSaveState || reconciliationRunning) return null;\n    if (deferLogReconcileAtExecution() || deferHomeReconcileAtExecution()) return null;\n    reconciliationRunning = true;\n"""
if needle not in season:
    raise SystemExit('season reconcileStored insertion point not found')
season = season.replace(needle, replacement, 1)

old_load = "      const loadOptions = { syncDerived: true, persistSync: false };"
new_load = "      const loadOptions = { syncDerived: false, persistSync: false };"
if old_load not in season:
    raise SystemExit('season reconciliation load options not found')
season = season.replace(old_load, new_load, 1)
season_path.write_text(season)

# 2) Make a task completion durable before its dust animation begins. Previously
# the actual task/completion mutation lived inside the animation callback, so a
# blocked main thread or app close could delay/prevent the journal write.
index_path = Path('index.html')
index = index_path.read_text()
start = index.find('function completeTask(id){')
end = index.find('\n\n\nfunction editTask(id){', start)
if start < 0 or end < 0:
    raise SystemExit('completeTask block not found')

new_complete = r'''function completeTask(id){
  return tpPerfTime('completeTask total', () => {
    const liveTask = state.tasks.find(x => x.id === id);
    if (!liveTask || taskCompletionAnimations.has(id)) return;

    const now = new Date().toISOString();
    const completedDayKey = dateKey(now);

    const alreadyCompletedToday = Array.isArray(state.completions)
      ? state.completions.some(c => c && c.taskId === id && dateKey(c.completedAtISO) === completedDayKey)
      : false;

    if (alreadyCompletedToday || !assertTaskActionMutationWritable()) return;

    const completion = {
      id: crypto.randomUUID(),
      taskId: id,
      title: liveTask.title,
      points: liveTask.points,
      completedAtISO: now
    };
    addCompletion(completion);

    const rec = liveTask.recurrence || {};
    const mode = rec.mode || 'none';

    if (mode === 'none') {
      liveTask.completedAtISO = now;
      liveTask.status = 'done';
    } else {
      const nextKey = computeNextDueDate(liveTask);
      if (nextKey) liveTask.dueDateISO = nextKey;
      liveTask.postponedDays = 0;
      liveTask.completedAtISO = null;
    }

    liveTask.updatedAtISO = now;

    // Durability comes before animation/paint. The tiny task journal survives an
    // app close and overlays canonical reads until its verified idle compaction.
    // Keep the full-save fallback for environments where the journal is absent.
    if (TaskPointsCore?.journalTaskMutation) {
      TaskPointsCore.journalTaskMutation({ task: liveTask, completionUpsert: completion });
      try {
        window.TaskPointsPerf?.mark?.('taskAction.completionDurable', {
          taskId: id,
          completionId: completion.id,
          recurring: mode !== 'none'
        });
      } catch (_) {}
    } else {
      save();
    }

    removeTaskFromTodayView(id, completedDayKey);
    window.updateCriticalTasksIsland?.(state);

    // Preserve the existing dust animation, but it is now purely visual. A slow
    // or interrupted animation can no longer prevent the completion from being
    // written to the durable journal.
    animateTaskCompletion(id, () => {
      scheduleRender(renderAll);
    });
  });
}
'''
index = index[:start] + new_complete + index[end:]
index_path.write_text(index)
