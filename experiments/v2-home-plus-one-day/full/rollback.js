(function setupCollectionRecovery() {
  const input = document.getElementById('collectionPackage');
  const restore = document.getElementById('restoreCollection');
  const status = document.getElementById('collectionRecoveryStatus');
  const runtime = window.TaskPointsStateRuntimeV2;
  let checkpoint;
  if (window.__TASKPOINTS_OWNED_TASK_SYNTHETIC__ !== true || !runtime) {
    input.disabled = true;
    status.textContent = 'This page requires the isolated synthetic environment.';
    return;
  }
  input.addEventListener('change', async () => {
    checkpoint = null;
    restore.disabled = true;
    status.textContent = '';
    const file = input.files[0];
    if (!file) return;
    try {
      const selected = JSON.parse(await file.text());
      const proof = await runtime.verifyIsolatedCollectionPackage(selected);
      if (input.files[0] !== file) return;
      if (proof.restorable) checkpoint = selected;
      restore.disabled = !proof.restorable;
      status.textContent = `Verified ${proof.tasks} Tasks and ${proof.completions} completions. ${proof.restorable ? 'Ready to restore.' : 'This is a read-only backup.'}`;
    } catch (error) {
      if (input.files[0] === file) status.textContent = `Package refused. ${error.message}`;
    }
  });
  restore.addEventListener('click', async () => {
    if (!checkpoint || !confirm('Restore the verified checkpoint into this disposable V1 profile?')) return;
    restore.disabled = input.disabled = true;
    status.textContent = 'Restoring…';
    try {
      const proof = await runtime.restoreIsolatedTaskCompletionRollback(checkpoint);
      if (!proof.verified) throw new Error('Restore could not be verified.');
      status.textContent = 'Restore verified. You can open TaskPoints in this profile.';
    } catch (error) {
      status.textContent = `Restore did not complete. ${error.message}`;
    } finally { restore.disabled = input.disabled = false; }
  });
})();
