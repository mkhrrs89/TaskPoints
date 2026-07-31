;(function installTaskPointsScoreAliasAuditBootstrap(global) {
  'use strict';

  const document = global.document;
  const location = global.location;
  if (!document || !location) return;

  let attempts = 0;
  function install() {
    if (!document.getElementById('auditChecks')) return;
    if (document.getElementById('scoreAliasRepairPanel')) return;
    const api = global.TaskPointsScoreAliasConsistency;
    if (!api?.installAuditRepairPanel) {
      attempts += 1;
      if (attempts < 120) global.setTimeout?.(install, 50);
      return;
    }

    const originalUrl = `${location.pathname}${location.search}${location.hash}`;
    const pathAlreadyCompatible = String(location.pathname || '').endsWith('/audit.html') || location.pathname === 'audit.html';

    try {
      if (!pathAlreadyCompatible && global.history?.replaceState) {
        global.history.replaceState(global.history.state, '', `/audit.html${location.search}${location.hash}`);
      }
      api.installAuditRepairPanel();
    } finally {
      if (!pathAlreadyCompatible && global.history?.replaceState) {
        global.history.replaceState(global.history.state, '', originalUrl);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})(typeof window !== 'undefined' ? window : globalThis);
