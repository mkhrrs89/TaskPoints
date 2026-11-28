(function setupCollectionRecovery() {
  const input = document.getElementById('collectionPackage');
  const restore = document.getElementById('restoreCollection');
  const forward = document.getElementById('forwardCollection');
  const forwardKey = document.getElementById('forwardCollectionKey');
  const readmit = document.getElementById('readmitCollection');
  const requestCode = document.getElementById('showDestinationCode');
  const destinationCode = document.getElementById('destinationCode');
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
    forward.hidden = true;
    forwardKey.value = '';
    destinationCode.textContent = '';
    status.textContent = '';
    const file = input.files[0];
    if (!file) return;
    try {
      const selected = JSON.parse(await file.text());
      const proof = await runtime.verifyIsolatedCollectionPackage(selected);
      if (input.files[0] !== file) return;
      if (proof.restorable) checkpoint = selected;
      restore.disabled = !proof.restorable;
      forward.hidden = !proof.restorable || !selected.authority?.publicKey;
      status.textContent = `Verified ${proof.tasks} Tasks and ${proof.completions} completions. ${proof.restorable ? 'Ready to restore.' : 'This is a read-only backup.'}`;
    } catch (error) {
      if (input.files[0] === file) status.textContent = `Package refused. ${error.message}`;
    }
  });

  requestCode.addEventListener('click', async () => {
    if (!checkpoint) return;
    try {
      destinationCode.textContent = await runtime.getIsolatedCollectionDestination(checkpoint);
    } catch (error) { status.textContent = `Destination code unavailable. ${error.message}`; }
  });
  restore.addEventListener('click', async () => {
    if (!checkpoint || !confirm('Restore the verified checkpoint into this disposable V1 profile?')) return;
    readmit.disabled = restore.disabled = input.disabled = true;
    status.textContent = 'Restoring…';
    try {
      const proof = await runtime.restoreIsolatedTaskCompletionRollback(checkpoint);
      if (!proof.verified) throw new Error('Restore could not be verified.');
      status.textContent = 'Restore verified. You can open TaskPoints in this profile.';
    } catch (error) {
      status.textContent = `Restore did not complete. ${error.message}`;
    } finally { readmit.disabled = restore.disabled = input.disabled = false; }
  });

  readmit.addEventListener('click', async () => {
    if (!checkpoint || !confirm('Return this restored synthetic collection to V2? Close all other editing tabs before continuing.')) return;
    readmit.disabled = restore.disabled = input.disabled = true;
    status.textContent = 'Verifying the restored collection…';
    try {
      const proof = await runtime.readmitIsolatedDetachedCollection(checkpoint,forwardKey.value.trim());
      if (!proof.confirmedDurable) throw new Error('The new V2 owner could not be verified.');
      status.textContent = 'V2 ownership verified. You can open TaskPoints in this profile.';
      forwardKey.value = '';
    } catch (error) {
      status.textContent = `V2 handoff stopped. ${error.message}`;
    } finally { readmit.disabled = restore.disabled = input.disabled = false; }
  });
})();
