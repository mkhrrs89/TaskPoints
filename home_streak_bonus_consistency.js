(function installTaskPointsHomeStreakBonusConsistency(global) {
  'use strict';

  if (global.__taskPointsHomeStreakBonusConsistencyInstalled) return;
  global.__taskPointsHomeStreakBonusConsistencyInstalled = true;

  function localDateKey(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseDisplayedBonus(row) {
    const streakPill = row?.querySelector?.('.streak-pill');
    const text = String(streakPill?.textContent || '');
    const match = text.match(/\(([-+]?\d+(?:\.\d+)?)\)/);
    const value = match ? Number(match[1]) : 0;
    return Number.isFinite(value) ? value : 0;
  }

  // Home already renders the same current-streak bonus used by the Streak Table
  // beside each Habit/Vice. Sum only rows completed today. This deliberately
  // avoids reloading/cloning the full TaskPoints state during a Habit tap.
  function computeFromRenderedCompletedRows() {
    const document = global.document;
    if (!document?.querySelectorAll) return 0;
    const today = typeof global.todayKey === 'function'
      ? global.todayKey()
      : localDateKey(new Date());
    if (!today) return 0;

    let total = 0;
    const seen = new Set();
    document.querySelectorAll('.habitRow[data-habit-row-id]').forEach((row) => {
      const id = String(row.dataset?.habitRowId || '');
      if (!id || seen.has(id)) return;
      const bubble = row.querySelector(`.habitDay[data-day="${today}"]`);
      // Streak Table treats both full and half Habit completions as completed
      // for the current streak row, so any non-off completed bubble qualifies.
      const completed = bubble && (
        bubble.classList.contains('on') ||
        bubble.classList.contains('half') ||
        bubble.classList.contains('habit-half')
      );
      if (!completed) return;
      seen.add(id);
      total += parseDisplayedBonus(row);
    });

    return Math.round((total + Number.EPSILON) * 100) / 100;
  }

  global.computeTodayStreakMultiplierBonusTotal = computeFromRenderedCompletedRows;

  // Repaint the existing card immediately after installation so a cached/stale
  // value cannot remain visible until the next Home render.
  try { global.renderHomeStreakBonusSidecar?.(); } catch (_) {}

  global.TaskPointsHomeStreakBonusConsistency = Object.freeze({
    version: 1,
    computeTodayTotal: computeFromRenderedCompletedRows
  });
})(typeof window !== 'undefined' ? window : globalThis);
