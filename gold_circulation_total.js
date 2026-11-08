;(function installTaskPointsGoldCirculation(global) {
  'use strict';

  // Gold balances are the sum of each wallet's append-only ledger entries.
  // Summing signed entries (including both sides of theft) counts each Gold
  // unit once. An empty/malformed load must never masquerade as 0 in circulation.
  function calculate(state) {
    if (Number(state?.goldEconomy?.version) !== 1 || !Array.isArray(state?.goldLedger)) {
      return { ok: false, reason: 'Gold Ledger is unavailable' };
    }

    const walletIds = new Set(['YOU']);
    (Array.isArray(state.players) ? state.players : []).forEach(player => {
      const id = String(player?.id || player?.playerId || '').trim();
      if (id) walletIds.add(id);
    });

    let totalTenths = 0;
    for (const row of state.goldLedger) {
      const id = String(row?.playerId || '').trim();
      const amount = row?.amount;
      const value = amount === '' || amount == null ? NaN : Number(amount);
      if (!id || !Number.isFinite(value) || Math.abs(value * 10 - Math.round(value * 10)) > 0.00001) {
        return { ok: false, reason: 'Some Gold transactions need review' };
      }
      walletIds.add(id); // Inactive, retired, or no-longer-rostered players still own Gold.
      totalTenths += Math.round(value * 10);
      if (!Number.isSafeInteger(totalTenths)) {
        return { ok: false, reason: 'Gold total is outside the supported range' };
      }
    }

    if (totalTenths < 0) {
      return { ok: false, reason: 'Gold balances need review' };
    }
    return { ok: true, total: totalTenths / 10, walletCount: walletIds.size };
  }

  global.TaskPointsGoldCirculation = { calculate };
  if (typeof module !== 'undefined' && module.exports) module.exports = { calculate };
})(typeof window !== 'undefined' ? window : globalThis);
