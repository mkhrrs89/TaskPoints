(function installTaskPointsRequalificationVaultGate(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__indexedDbRequalificationVaultGateInstalled || typeof core.setPhase4StorageMode !== 'function') return;
  core.__indexedDbRequalificationVaultGateInstalled = true;

  const originalSetMode = core.setPhase4StorageMode.bind(core);
  core.setPhase4StorageMode = function setModeWithVerifiedVault(mode) {
    const requested = String(mode || 'off');
    if (requested !== 'off' && !global.__TASKPOINTS_REQUALIFICATION_VERIFIED_VAULT_HASH__) {
      try { return originalSetMode('off'); } catch (_) { return 'off'; }
    }
    return originalSetMode(requested);
  };

  core.getIndexedDbRequalificationVaultGateStatus = () => ({
    installed: true,
    verifiedVaultHashPresent: Boolean(global.__TASKPOINTS_REQUALIFICATION_VERIFIED_VAULT_HASH__)
  });
})(typeof window !== 'undefined' ? window : globalThis);
