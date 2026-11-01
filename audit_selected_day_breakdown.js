;(function (global) {
  'use strict';

  // Selected-day counterpart to the legacy all-history buildDailyBreakdowns.
  // Keep an independent completion/category calculation for Audit parity checks.
  function buildSelectedDayBreakdown(stateInput, selectedDateKey, options = {}) {
    const core = options.core || global.TaskPointsCore;
    if (!core) throw new Error('TaskPointsCore is required for selected-day Audit');
    const normalized = options.normalizedState || core.normalizeState(stateInput || {});
    const completions = Array.isArray(normalized.completions) ? normalized.completions : [];
    const key = core.dateKey(selectedDateKey);
    const definitions = core.CATEGORY_DEFS;
    const fallbackCategory = definitions[definitions.length - 1].key;
    const validCategories = new Set(definitions.map(def => def.key));
    const categories = Object.fromEntries(definitions.map(def => [def.key, 0]));
    categories.inertia = 0;

    const dayEntries = [];
    let firstDay = null;
    let lastDay = null;
    let baseTotal = 0;
    const add = (value, points) => core.roundPoints((Number(value) || 0) + (Number(points) || 0), 2);

    for (const entry of completions) {
      if (!entry || !entry.completedAtISO) continue;
      const completed = new Date(entry.completedAtISO);
      if (!Number.isFinite(completed.getTime())) continue;
      const entryKey = core.dateKey(completed);
      if (!firstDay || entryKey < firstDay) firstDay = entryKey;
      if (!lastDay || entryKey > lastDay) lastDay = entryKey;
      if (entryKey !== key) continue;
      dayEntries.push(entry);
      const rawCategory = core.categorizeCompletion(entry);
      const category = validCategories.has(rawCategory) ? rawCategory : fallbackCategory;
      const points = core.pointsForCompletion(entry, normalized);
      categories[category] = add(categories[category], points);
      baseTotal = add(baseTotal, points);
    }

    // The legacy routine only generates dates from its first valid completion
    // through the later of the last completion and today.
    const latestIncludedDay = lastDay > core.todayKey() ? lastDay : core.todayKey();
    if (!firstDay || key < firstDay || key > latestIncludedDay) {
      return { total: 0, categories: {} };
    }

    // This helper applies the same one-per-day bonus rules as the core.
    const bonus = core.computeCalLogBonusPoints(dayEntries, normalized);
    if (bonus) {
      const category = validCategories.has('calLogBonus') ? 'calLogBonus' : fallbackCategory;
      categories[category] = add(categories[category], bonus);
      baseTotal = add(baseTotal, bonus);
    }

    // Normal Audit already computed this map in buildDaySnapshot; reuse it
    // rather than scanning the full history again.
    const dailyTotals = options.dailyTotals || core.aggregateCompletionsByDate(completions, normalized).dailyTotals;
    const inertia = Number(core.computeInertia(dailyTotals, key, normalized).inertia) || 0;
    if (inertia) categories.inertia = add(categories.inertia, inertia);
    const total = core.roundPoints(baseTotal + inertia, 2);
    const hasItems = dayEntries.length > 0 || Boolean(bonus);
    if (!hasItems && Math.abs(inertia) <= 0.01 && Math.abs(total) <= 0.01) {
      return { total: 0, categories: {} };
    }
    return { total, categories };
  }

  const api = { buildSelectedDayBreakdown };
  global.TaskPointsAuditSelectedDay = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
