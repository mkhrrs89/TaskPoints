(function installTaskPointsRequalificationVaultGate(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__indexedDbRequalificationVaultGateInstalled || typeof core.setPhase4StorageMode !== 'function') return;
  core.__indexedDbRequalificationVaultGateInstalled = true;

  const originalSetMode = core.setPhase4StorageMode.bind(core);
  const recoveryHoldGuardReady = core.__indexedDbRecoveryHoldGuardInstalled === true;

  if (!recoveryHoldGuardReady) {
    core.__indexedDbRequalificationGuardInstalled = false;
    try { originalSetMode('off'); } catch (_) {}
  }

  core.setPhase4StorageMode = function setModeWithVerifiedSafetyProof(mode) {
    const requested = String(mode || 'off');
    const vaultReady = Boolean(global.__TASKPOINTS_REQUALIFICATION_VERIFIED_VAULT_HASH__);
    const holdGuardReady = core.__indexedDbRecoveryHoldGuardInstalled === true;
    if (requested !== 'off' && (!vaultReady || !holdGuardReady)) {
      try { return originalSetMode('off'); } catch (_) { return 'off'; }
    }
    return originalSetMode(requested);
  };

  core.getIndexedDbRequalificationVaultGateStatus = () => ({
    installed: true,
    verifiedVaultHashPresent: Boolean(global.__TASKPOINTS_REQUALIFICATION_VERIFIED_VAULT_HASH__),
    recoveryHoldGuardReady: core.__indexedDbRecoveryHoldGuardInstalled === true
  });
})(typeof window !== 'undefined' ? window : globalThis);
