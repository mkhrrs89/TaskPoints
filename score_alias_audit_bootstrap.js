;(function installTaskPointsScoreAliasAuditBootstrap(global) {
  'use strict';

  const document = global.document;
  const location = global.location;
  if (!document || !location) return;
  if (!/(^|\/)audit(?:\.html)?\/?$/.test(String(location.pathname || ''))) return;

  let attempts = 0;
  function install() {
    if (document.getElementById('scoreAliasRepairPanel')) return;
    const api = global.TaskPointsScoreAliasConsistency;
    if (!api?.installAuditRepairPanel) {
      attempts += 1;
      if (attempts < 120) global.setTimeout?.(install, 50);
      return;
    }

    const originalUrl = `${location.pathname}${location.search}${location.hash}`;
    const path = String(location.pathname || '');
    const auditHtmlPath = path.replace(/audit(?:\.html)?\/?$/, 'audit.html');
    const needsCompatibilityPath = !path.endsWith('/audit.html') && path !== 'audit.html';

    try {
      if (needsCompatibilityPath && global.history?.replaceState) {
        global.history.replaceState(global.history.state, '', `${auditHtmlPath}${location.search}${location.hash}`);
      }
      api.installAuditRepairPanel();
    } finally {
      if (needsCompatibilityPath && global.history?.replaceState) {
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
