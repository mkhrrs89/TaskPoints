;(function installHabitViceScoringDateAudit(global) {
  'use strict';
  // Read-only cross-check: the selected tracker day must be the local day the scorer sees.
  // Scan saved records too because normalizeState can hide their original timestamp errors.
  const validDay = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y,m,d] = value.split('-').map(Number);
    const date = new Date(Date.UTC(y,m-1,d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m-1 && date.getUTCDate() === d;
  };
  function inspect(completions, dayKey) {
    const issues = [];
    for (const [i, entry] of (Array.isArray(completions) ? completions : []).entries()) {
      if (!entry || (entry.source !== 'habit' && entry.source !== 'vice')) continue;
      const selected = validDay(entry.dayKey) ? entry.dayKey : (validDay(entry.dateKey) ? entry.dateKey : '');
      // The ledger audit covers older entries that have no explicit selected day.
      if (!selected) continue;
      const timestamp = entry.completedAtISO && new Date(entry.completedAtISO);
      let scored = '';
      if (timestamp && Number.isFinite(timestamp.getTime())) {
        try { const date = dayKey(timestamp); if (validDay(date)) scored = date; } catch (_) {}
      }
      if (selected === scored) continue;
      const points = Number(entry.points);
      issues.push({
        selected, scored,
        label: String(entry.title || entry.name || entry.habitId || entry.viceId || entry.id || `row #${i+1}`),
        points: entry.points != null && Number.isFinite(points) ? points : null
      });
    }
    return issues;
  }
  function buildHabitViceScoringDateAudit(state, options = {}) {
    const toDayKey = typeof options.dateKey === 'function' ? options.dateKey : date => {
      const d = date instanceof Date ? date : new Date(date);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    };
    const active = inspect(state?.completions, toDayKey);
    const hasSaved = Array.isArray(options.savedCompletions);
    const saved = hasSaved ? inspect(options.savedCompletions, toDayKey) : [];
    const readError = String(options.savedReadError || '').trim();
    const day = validDay(options.selectedDateKey) ? options.selectedDateKey : '';
    const related = issue => day && (issue.selected === day || issue.scored === day);
    const prioritized = issues => issues.slice().sort((a,b)=>Number(related(b))-Number(related(a)));
    const describe = (kind, issue) =>
      `${kind}: ${issue.label} (${issue.points === null ? 'unknown points' : Number(issue.points.toFixed(2)) + ' pts'}) belongs to ${issue.selected}, but scoring timestamp is ${issue.scored || 'missing/invalid'}`;
    const details = [
      ...prioritized(active).map(issue=>describe('ACTIVE ERROR',issue)),
      ...prioritized(saved).map(issue=>describe('SAVED RECORD',issue))
    ];
    if (readError) details.push(`Saved snapshot could not be inspected: ${readError}`);
    const limit = Number.isInteger(options.detailLimit) && options.detailLimit >= 0 ? options.detailLimit : 75;
    const visible = details.slice(0,limit);
    if (details.length > limit) visible.push(`… ${details.length-limit} additional issue(s) omitted.`);
    const relatedCount = [...active,...saved].filter(related).length;
    return {
      id: 'habit-vice-scoring-date-parity',
      title: 'Habit/Vice scoring dates match selected days',
      section: 'Habit Ledger Integrity',
      status: active.length ? 'FAIL' : (saved.length || readError ? 'WARN' : 'PASS'),
      expected: 'Every Habit/Vice completion scores on its selected day in the active state and saved snapshot',
      actual: `Active mismatches: ${active.length}`
        + (hasSaved ? ` • Saved mismatches: ${saved.length}` : ' • Saved snapshot: not available')
        + (day ? ` • Affecting ${day}: ${relatedCount}` : '')
        + (readError ? ' • Saved scan unavailable' : ''),
      details: visible,
      trace: 'Habit/Vice completion dayKey/dateKey ↔ completedAtISO local scoring date (active and saved)',
      tips: 'ACTIVE ERROR means points can appear on the wrong date. SAVED RECORD means the load-time correction may already show correct totals, but the saved timestamp still disagrees. Read-only: no changes to completions, matchups, or recovery journals.'
    };
  }
  const api = {buildHabitViceScoringDateAudit, inspectCompletions: inspect};
  global.TaskPointsAuditHabitViceScoringDates = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
