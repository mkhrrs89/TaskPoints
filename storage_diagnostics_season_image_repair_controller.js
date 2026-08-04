(() => {
  'use strict';

  const STORAGE_KEY = window.TaskPointsCore?.STORAGE_KEY || 'taskpoints_v1';
  let busy = false;
  let lastPlanFingerprint = '';
  let terminalStatusLocked = false;

  const $ = (id) => document.getElementById(id);

  function api() {
    const diagnostics = window.TaskPointsStorageDiagnostics;
    const repair = window.TaskPointsSeasonImageReferenceRepair;
    if (!diagnostics?.readCurrentState || !diagnostics?.getImageDatabaseReport || !diagnostics?.runDiagnostics) {
      throw new Error('Storage Diagnostics is not ready. Reload TaskPoints and try again.');
    }
    if (!repair?.buildRepairPlan || !repair?.applyRepairPlan || !repair?.nonImageSnapshot || !repair?.seasonImageSnapshot) {
      throw new Error('The Season image repair module did not load. Reload TaskPoints and try again.');
    }
    return { diagnostics, repair };
  }

  function shortId(value) {
    const text = String(value || '');
    return text.length > 12 ? `${text.slice(0, 8)}…` : text;
  }

  function setStatus(message) {
    const status = $('seasonImageRepairStatus');
    if (status) status.textContent = message;
  }

  function setTerminalStatus(message) {
    terminalStatusLocked = true;
    setStatus(message);
  }

  function clearTerminalStatus() {
    terminalStatusLocked = false;
    lastPlanFingerprint = '';
  }

  function currentPlan() {
    const { diagnostics, repair } = api();
    const report = diagnostics.getLatestReport?.();
    if (!report?.images?.available) return null;
    const state = diagnostics.readCurrentState().state;
    return repair.buildRepairPlan(state, report.images);
  }

  function updateControls() {
    const button = $('repairMissingSeasonImagesBtn');
    if (!button) return;
    let plan = null;
    try { plan = currentPlan(); } catch (_) {}

    if (busy) {
      button.disabled = true;
      return;
    }
    if (!plan || !plan.missingIds.length) {
      button.disabled = true;
      button.textContent = plan ? 'No Missing Season Images' : 'Run Diagnostics First';
      if (!terminalStatusLocked && plan && lastPlanFingerprint !== plan.fingerprint) {
        setStatus('No missing Season image references were found.');
      }
      lastPlanFingerprint = plan?.fingerprint || '';
      return;
    }
    if (!plan.safe) {
      button.disabled = true;
      button.textContent = 'Season Image Repair Blocked';
      if (!terminalStatusLocked && lastPlanFingerprint !== plan.fingerprint) {
        const reason = plan.externalPaths.length
          ? `${plan.externalPaths.length} missing reference(s) are outside Season data.`
          : `${plan.unresolved.length} missing Season reference(s) do not have a verified current replacement image.`;
        setStatus(`${reason} No records can be changed from this screen.`);
      }
      lastPlanFingerprint = plan.fingerprint;
      return;
    }

    button.disabled = false;
    button.textContent = `Repair ${plan.missingIds.length} Missing Season Image${plan.missingIds.length === 1 ? '' : 's'}`;
    if (!terminalStatusLocked && lastPlanFingerprint !== plan.fingerprint) {
      setStatus(`${plan.missingIds.length} missing image ID(s) across ${plan.repairs.length} Season record(s) can be replaced with verified current player images.`);
    }
    lastPlanFingerprint = plan.fingerprint;
  }

  async function flushPendingWrites() {
    const core = window.TaskPointsCore || {};
    if (typeof core.flushPendingSaves === 'function') {
      await Promise.resolve(core.flushPendingSaves());
    }
  }

  function persistSeasonRepairExact(nextState, expectedPreviousRaw) {
    const core = window.TaskPointsCore || {};
    if (typeof core.writeTaskPointsStoredState !== 'function') {
      throw new Error('The exact TaskPoints storage writer is unavailable.');
    }
    const currentRaw = localStorage.getItem(STORAGE_KEY) || '';
    if (currentRaw !== expectedPreviousRaw) {
      throw new Error('The TaskPoints state changed immediately before the exact write.');
    }
    const writtenRaw = core.writeTaskPointsStoredState(nextState, {
      storageKey: STORAGE_KEY,
      reason: 'storage-diagnostics-season-image-reference-repair'
    });
    if ((localStorage.getItem(STORAGE_KEY) || '') !== writtenRaw) {
      throw new Error('TaskPoints did not retain the exact repaired state.');
    }
    return { previousRaw: expectedPreviousRaw, writtenRaw };
  }

  function restoreRawState(previousRaw) {
    localStorage.setItem(STORAGE_KEY, previousRaw);
    if ((localStorage.getItem(STORAGE_KEY) || '') !== previousRaw) {
      throw new Error('Automatic rollback could not restore the previous TaskPoints snapshot.');
    }
  }

  async function repairMissingSeasonImages() {
    if (busy) return;
    busy = true;
    clearTerminalStatus();
    const button = $('repairMissingSeasonImagesBtn');
    const runButton = $('runDiagnosticsBtn');
    if (button) button.disabled = true;
    if (runButton) runButton.disabled = true;

    let rollbackRaw = '';
    let exactWriteCompleted = false;

    try {
      const { diagnostics, repair } = api();
      await flushPendingWrites();
      if (button) button.textContent = 'Rechecking…';
      setStatus('Re-reading the current state and image database before showing confirmation…');

      const previewState = diagnostics.readCurrentState();
      const previewReport = await diagnostics.getImageDatabaseReport(previewState.state);
      if (!previewReport.available) throw new Error(previewReport.reason || 'Image database is unavailable.');
      const previewPlan = repair.buildRepairPlan(previewState.state, previewReport);
      if (!previewPlan.missingIds.length) {
        await diagnostics.runDiagnostics();
        setTerminalStatus('No missing Season image references remain.');
        return;
      }
      if (!previewPlan.safe) {
        throw new Error('The missing references do not all have unambiguous, existing current-player replacements.');
      }

      const lines = previewPlan.replacementGroups.map((group) =>
        `• ${group.playerName}: ${shortId(group.oldImageId)} → ${shortId(group.newImageId)} (${group.paths.length} Season record${group.paths.length === 1 ? '' : 's'})`
      );
      const confirmed = window.confirm(
        `Repair ${previewPlan.missingIds.length} missing image ID(s) across ${previewPlan.repairs.length} Season record(s)?\n\n` +
        `${lines.join('\n')}\n\n` +
        'Only imageId fields in current or archived Season copies will change. Player records, names, seeds, scores, results, standings, and all other fields will remain unchanged.'
      );
      if (!confirmed) {
        setTerminalStatus('Season image repair canceled. No records were changed.');
        return;
      }

      if (button) button.textContent = 'Revalidating…';
      setStatus('Checking that the state and complete image database report did not change after confirmation…');
      await flushPendingWrites();
      const validatedState = diagnostics.readCurrentState();
      const validatedReport = await diagnostics.getImageDatabaseReport(validatedState.state);
      if (!validatedReport.available) throw new Error(validatedReport.reason || 'Image database is unavailable.');
      const validatedPlan = repair.buildRepairPlan(validatedState.state, validatedReport);
      if (validatedState.raw !== previewState.raw
        || validatedReport.fingerprint !== previewReport.fingerprint
        || validatedPlan.fingerprint !== previewPlan.fingerprint
        || !validatedPlan.safe) {
        await diagnostics.runDiagnostics();
        setTerminalStatus('The TaskPoints state or image database changed after the preview. Nothing was repaired; review the refreshed report and try again.');
        window.alert('The repair preview became stale. Nothing was changed. Review the refreshed report before trying again.');
        return;
      }

      const applied = repair.applyRepairPlan(validatedState.state, validatedPlan);
      if (!applied.ok || applied.updatedCount !== validatedPlan.repairs.length) {
        throw new Error('The repair could not reproduce the exact confirmed paths and record count.');
      }
      if (repair.nonImageSnapshot(validatedState.state) !== repair.nonImageSnapshot(applied.state)) {
        throw new Error('Safety check failed: a non-image or non-Season field would change.');
      }
      const expectedSeasonImages = repair.seasonImageSnapshot(applied.state);
      if ((localStorage.getItem(STORAGE_KEY) || '') !== validatedState.raw) {
        await diagnostics.runDiagnostics();
        setTerminalStatus('The TaskPoints state changed immediately before saving. Nothing was repaired; review the refreshed report.');
        return;
      }

      if (button) button.textContent = 'Saving Repair…';
      setStatus(`Replacing ${validatedPlan.missingIds.length} missing image ID(s) across ${validatedPlan.repairs.length} exact Season path(s)…`);
      rollbackRaw = validatedState.raw;
      persistSeasonRepairExact(applied.state, rollbackRaw);
      exactWriteCompleted = true;

      if (button) button.textContent = 'Verifying…';
      setStatus('Verifying the exact saved state and every replacement blob…');
      const finalState = diagnostics.readCurrentState();
      const finalReport = await diagnostics.getImageDatabaseReport(finalState.state);
      if (!finalReport.available) throw new Error(finalReport.reason || 'Image database became unavailable during verification.');
      if (repair.nonImageSnapshot(validatedState.state) !== repair.nonImageSnapshot(finalState.state)) {
        throw new Error('Verification failed: data outside the confirmed Season imageId fields changed.');
      }
      if (repair.seasonImageSnapshot(finalState.state) !== expectedSeasonImages) {
        throw new Error('Verification failed: the saved Season image references do not exactly match the confirmed replacements.');
      }
      const remainingOldIds = validatedPlan.missingIds.filter((imageId) => finalReport.referencedIds.includes(imageId));
      if (remainingOldIds.length) {
        throw new Error(`Verification failed: ${remainingOldIds.length} old missing image ID(s) are still referenced.`);
      }
      if (finalReport.missingReferences.length) {
        throw new Error(`Verification failed: ${finalReport.missingReferences.length} missing image reference(s) remain.`);
      }

      exactWriteCompleted = false;
      rollbackRaw = '';
      await diagnostics.runDiagnostics();
      setTerminalStatus(`Repaired and verified ${validatedPlan.missingIds.length} missing image ID(s) across ${validatedPlan.repairs.length} exact Season path(s). No other data changed. The orphan cleanup can now be reviewed.`);
    } catch (error) {
      console.error('Season image reference repair failed', error);
      let rollbackMessage = '';
      if (exactWriteCompleted && rollbackRaw) {
        try {
          restoreRawState(rollbackRaw);
          rollbackMessage = ' The previous TaskPoints snapshot was restored automatically.';
        } catch (rollbackError) {
          console.error('Season image repair rollback failed', rollbackError);
          rollbackMessage = ` Automatic rollback failed: ${rollbackError?.message || String(rollbackError)} Restore the fresh ZIP backup before making further changes.`;
        }
      }
      setTerminalStatus(`Repair failed: ${error?.message || String(error)}${rollbackMessage} No orphan images were deleted.`);
      window.alert(`Season image repair failed:\n\n${error?.message || String(error)}${rollbackMessage}`);
      try { await window.TaskPointsStorageDiagnostics?.runDiagnostics?.(); } catch (_) {}
    } finally {
      busy = false;
      if (runButton) runButton.disabled = false;
      updateControls();
    }
  }

  function install() {
    const button = $('repairMissingSeasonImagesBtn');
    if (!button || button.dataset.repairControllerReady === 'true') return;
    button.dataset.repairControllerReady = 'true';
    button.addEventListener('click', repairMissingSeasonImages);

    const runButton = $('runDiagnosticsBtn');
    runButton?.addEventListener('click', () => {
      if (busy) return;
      clearTerminalStatus();
      setStatus('Running a fresh diagnostic scan…');
    }, { capture: true });

    updateControls();
    const diagnosticStatus = $('diagnosticStatus');
    if (diagnosticStatus && typeof MutationObserver !== 'undefined') {
      new MutationObserver(() => setTimeout(updateControls, 0)).observe(diagnosticStatus, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }
    window.setInterval(updateControls, 1000);
  }

  window.TaskPointsSeasonImageRepairController = {
    updateControls,
    repairMissingSeasonImages,
    getCurrentPlan: currentPlan,
    clearTerminalStatus
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
