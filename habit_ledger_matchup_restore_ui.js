;(function installHabitLedgerStoredScoreRestoreUi(global) {
  'use strict';

  if (global.__habitLedgerStoredScoreRestoreUiInstalled) return;
  global.__habitLedgerStoredScoreRestoreUiInstalled = true;

  function restorationDates() {
    const impact = global.__latestHabitLedgerMatchupImpact;
    return new Set(
      (Array.isArray(impact?.days) ? impact.days : [])
        .filter((day) => day?.status === 'restores-stored-score')
        .map((day) => String(day.dayKey || ''))
        .filter(Boolean)
    );
  }

  function patchRestorationRows() {
    const wrapper = global.document?.getElementById('habitLedgerMatchupImpact');
    if (!wrapper) return false;
    const rows = wrapper.querySelector('#habitLedgerMatchupImpactRows');
    const status = wrapper.querySelector('#habitLedgerMatchupImpactStatus');
    const count = wrapper.querySelector('#habitLedgerMatchupImpactCount');
    if (!rows) return false;

    const safeDates = restorationDates();
    let restored = 0;
    rows.querySelectorAll('li').forEach((item) => {
      const dateMatch = (item.textContent || '').match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch || !safeDates.has(dateMatch[1])) return;
      const strong = [...item.querySelectorAll('strong')]
        .find((node) => /BLOCKED/i.test(node.textContent || ''));
      if (strong) strong.textContent = 'SAFE RESTORATION';
      item.dataset.matchupImpactStatus = 'restores-stored-score';
      restored += 1;
    });

    if (restored > 0) {
      const blockedMatch = (count?.textContent || '').match(/(\d+) blocked/i);
      const blocked = blockedMatch ? Number(blockedMatch[1]) : 0;
      const message = blocked > 0
        ? `${restored} day(s) safely restore the finalized matchup score; ${blocked} other day(s) remain blocked.`
        : `${restored} day(s) safely restore the finalized matchup score without changing the stored W/L/tie result.`;
      if (status && status.textContent !== message) status.textContent = message;
    }
    return true;
  }

  function install() {
    const wrapper = global.document?.getElementById('habitLedgerMatchupImpact');
    if (!wrapper) return false;
    patchRestorationRows();
    const observer = new MutationObserver(() => patchRestorationRows());
    observer.observe(wrapper, { childList: true, subtree: true, characterData: true });
    return true;
  }

  const tryInstall = () => {
    if (install()) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (install() || attempts >= 50) clearInterval(timer);
    }, 100);
  };

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', tryInstall, { once: true });
  } else if (global.document) {
    tryInstall();
  }

  global.TaskPointsHabitLedgerStoredScoreRestoreUi = { patchRestorationRows, restorationDates };
})(typeof window !== 'undefined' ? window : globalThis);
