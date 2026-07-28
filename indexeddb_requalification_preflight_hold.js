(function captureTaskPointsRecoveryHoldBeforeSetup(global) {
  'use strict';

  const HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
  let raw = null;
  let available = true;
  try {
    raw = global.localStorage?.getItem?.(HOLD_KEY) ?? null;
  } catch (_) {
    available = false;
  }

  global.__TASKPOINTS_REQUALIFICATION_PREFLIGHT_HOLD_CAPTURE__ = {
    available,
    raw,
    capturedAtISO: new Date().toISOString()
  };
})(typeof window !== 'undefined' ? window : globalThis);
