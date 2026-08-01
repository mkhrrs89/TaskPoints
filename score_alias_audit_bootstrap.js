;(function installTaskPointsScoreAliasAuditBootstrap(global) {
  'use strict';

  const document = global.document;
  const location = global.location;
  if (!document || !location) return;

  const OMITTED_VARIABLE_SEED_AUDIT_IDS = new Set([
    'season-seed-count-34',
    'season-seeds-continuous',
    'season-play-in-pairings'
  ]);
  let variableSeedFilterAttempts = 0;

  function filterVariableSeedAudits(checks) {
    if (!Array.isArray(checks)) return checks;
    return checks.filter((check) => !OMITTED_VARIABLE_SEED_AUDIT_IDS.has(String(check?.id || '')));
  }

  function installVariableSeedAuditFilter() {
    if (global.__taskpointsVariableSeedAuditFilterInstalled) return true;
    const original = global.buildSeasonChampionshipAuditChecks;
    if (typeof original !== 'function') {
      variableSeedFilterAttempts += 1;
      if (variableSeedFilterAttempts < 120) global.setTimeout?.(installVariableSeedAuditFilter, 50);
      return false;
    }

    function buildVariableSeedSeasonChampionshipAuditChecks(...args) {
      return filterVariableSeedAudits(original.apply(this, args));
    }
    Object.defineProperty(buildVariableSeedSeasonChampionshipAuditChecks, '__taskpointsVariableSeedAuditFilterInstalled', {
      value: true,
      configurable: true
    });
    global.buildSeasonChampionshipAuditChecks = buildVariableSeedSeasonChampionshipAuditChecks;
    global.__taskpointsVariableSeedAuditFilterInstalled = true;
    return true;
  }

  installVariableSeedAuditFilter();

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

  function installOnReady() {
    installVariableSeedAuditFilter();
    install();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installOnReady, { once: true });
  } else {
    installOnReady();
  }
})(typeof window !== 'undefined' ? window : globalThis);
