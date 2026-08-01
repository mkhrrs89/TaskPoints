;(function preventUnsafeHabitLedgerInstaller(global) {
  'use strict';
  const core = global.TaskPointsCore;
  if (core) core.__habitLedgerConsistencyRepairInstalled = true;
})(typeof window !== 'undefined' ? window : globalThis);
