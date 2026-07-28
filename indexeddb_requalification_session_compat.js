(function connectTaskPointsRestartCheckerToSetup(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__indexedDbRequalificationSessionCompatInstalled) return;
  const readStatus = core.getIndexedDbBrowserSessionStatus;
  if (typeof readStatus !== 'function') return;

  core.__indexedDbRequalificationSessionCompatInstalled = true;
  core.getIndexedDbBrowserSessionStatus = function getCompatibleRestartStatus() {
    const status = readStatus.call(core) || {};
    return {
      ...status,
      broadcastSupported: status.lockSupported === true
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
