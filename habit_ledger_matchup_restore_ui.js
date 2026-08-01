;(function installHabitLedgerStoredScoreRestoreUi(global) {
  'use strict';

  if (global.__habitLedgerStoredScoreRestoreUiInstalled) return;
  global.__habitLedgerStoredScoreRestoreUiInstalled = true;

  function numeric(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function patchRestorationRows() {
    const wrapper = global.document?.getElementById('habitLedgerMatchupImpact');
    if (!wrapper) return false;
    const rows = wrapper.querySelector('#habitLedgerMatchupImpactRows');
    const status = wrapper.querySelector('#habitLedgerMatchupImpactStatus');
    const count = wrapper.querySelector('#habitLedgerMatchupImpactCount');
    if (!rows) return false;

    let restored = 0;
    rows.querySelectorAll('li').forEach((item) => {
      const text = item.textContent || '';
      const match = text.match(/stored score\s+(-?\d+(?:\.\d+)?)\s+→\s+(-?\d+(?:\.\d+)?)/i);
      if (!match) return;
      const stored = numeric(match[1]);
      const projected = numeric(match[2]);
      if (stored === null || projected === null || Math.abs(stored - projected) > 0.0001) return;
      const strong = [...item.querySelectorAll('strong')]
        .find((node) => /BLOCKED/i.test(node.textContent || ''));
      if (strong) strong.textContent = 'SAFE RESTORATION';
      item.dataset.matchupImpactStatus = 'restores-stored-score';
      restored += 1;
    });

    if (restored > 0) {
      const blockedMatch = (count?.textContent || '').match(/(\d+) blocked/i);
      const blocked = blockedMatch ? Number(blockedMatch[1]) : 0;
      if (status) {
        status.textContent = blocked > 0
          ? `${restored} day(s) safely restore the finalized matchup score; ${blocked} other day(s) remain blocked.`
          : `${restored} day(s) safely restore the finalized matchup score without changing the stored W/L/tie result.`;
      }
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

  global.TaskPointsHabitLedgerStoredScoreRestoreUi = { patchRestorationRows };
})(typeof window !== 'undefined' ? window : globalThis);
