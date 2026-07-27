(function keepTaskPointsRequalificationChecksReadOnly(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const document = global.document;
  if (!core || !document || core.__indexedDbRequalificationReadOnlyGuardInstalled) return;
  core.__indexedDbRequalificationReadOnlyGuardInstalled = true;

  const flushNames = [
    'flushPhase5CVerifiedSecondaryWrites',
    'flushPhase4PrimaryWrites',
    'flushPhase5ANativeSnapshotWrites'
  ];
  const originals = new Map();
  let permittedCalls = 0;
  let permissionTimer = null;

  flushNames.forEach((name) => {
    const original = core[name];
    if (typeof original !== 'function') return;
    originals.set(name, original);
    core[name] = function guardedExplicitFlush(...args) {
      if (permittedCalls <= 0) return Promise.resolve(false);
      permittedCalls -= 1;
      return original.apply(core, args);
    };
  });

  function allowExplicitAction() {
    permittedCalls = originals.size;
    if (permissionTimer != null) clearTimeout(permissionTimer);
    permissionTimer = setTimeout(() => { permittedCalls = 0; permissionTimer = null; }, 30000);
  }

  ['startTestBtn', 'finishTestBtn'].forEach((id) => {
    document.getElementById(id)?.addEventListener('click', allowExplicitAction, { capture: true });
  });

  core.getIndexedDbRequalificationReadOnlyStatus = () => ({
    installed: true,
    protectedFlushes: [...originals.keys()],
    explicitCallsRemaining: permittedCalls
  });
})(typeof window !== 'undefined' ? window : globalThis);
