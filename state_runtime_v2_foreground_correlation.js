(function installTaskPointsStateRuntimeV2ForegroundCorrelation(global) {
  'use strict';

  if (!global || global.TaskPointsStateRuntimeV2ForegroundCorrelation?.installed) return;

  const MUTATION_KINDS = Object.freeze(['completion', 'order', 'edit', 'presence']);
  const V2_DB_NAME = 'taskpoints_state_v2';
  const MAX_WINDOW_MS = 5000;
  const MAX_WINDOWS = 40;
  const MAX_CANDIDATES_PER_WINDOW = 12;
  const LEGACY_WHOLE_STATE_CORE_CALLS = new Set([
    'core.loadAppState',
    'core.readTaskPointsStoredState',
    'core.parseTaskPointsStorageJson',
    'core.saveStateSnapshot',
    'core.saveValidatedSnapshot',
    'core.shadowSourceSummary',
    'core.shadowCanonicalJson'
  ]);

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function eventTime(event) {
    return finiteNumber(event?.epochMs) ?? finiteNumber(event?.atMs) ?? null;
  }

  function detailObject(event) {
    const detail = event?.detail;
    return detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : {};
  }

  function flattenEvents(report) {
    const rows = [];
    const pages = Array.isArray(report?.pages) ? report.pages : [];
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const page = pages[pageIndex] || {};
      const events = Array.isArray(page.events) ? page.events : [];
      for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
        const event = events[eventIndex];
        if (!event || typeof event !== 'object') continue;
        rows.push({
          ...event,
          __pageIndex: pageIndex,
          __eventIndex: eventIndex,
          __pagePath: String(page.path || '')
        });
      }
    }
    rows.sort((a, b) => {
      const aTime = eventTime(a);
      const bTime = eventTime(b);
      if (aTime !== null && bTime !== null && aTime !== bTime) return aTime - bTime;
      if (a.__pageIndex !== b.__pageIndex) return a.__pageIndex - b.__pageIndex;
      return a.__eventIndex - b.__eventIndex;
    });
    return rows;
  }

  function mutationKind(event) {
    const match = /^stateV2\.enqueue\.(completion|order|edit|presence)\.sync$/.exec(String(event?.name || ''));
    return match ? match[1] : '';
  }

  function isInteraction(event) {
    return String(event?.name || '').startsWith('interaction.');
  }

  function isLegacyFullStateCandidate(event) {
    const durationMs = finiteNumber(event?.durationMs);
    if (durationMs === null || durationMs < 0) return false;
    const name = String(event?.name || '');
    const lower = name.toLowerCase();
    const detail = detailObject(event);

    if (name.startsWith('stateV2.')) return false;
    if (lower.includes('phase2') || lower.includes('phase4') || lower.includes('phase5')
      || lower.includes('verifiedsecondary') || lower.includes('snapshot')) return true;
    if ((name === 'storage.setItem' || name === 'storage.getItem') && String(detail.key || '') === 'taskpoints_v1') return true;
    if (name === 'json.stringify' || name === 'structuredClone') return true;
    if (LEGACY_WHOLE_STATE_CORE_CALLS.has(name)) return true;
    if (name === 'indexedDB.transaction') {
      const db = String(detail.db || '');
      return Boolean(db) && db !== V2_DB_NAME;
    }
    return false;
  }

  function interval(event) {
    const end = eventTime(event);
    const durationMs = Math.max(0, finiteNumber(event?.durationMs) || 0);
    if (end === null) return null;
    return { start: end - durationMs, end, durationMs };
  }

  function overlaps(candidate, start, end) {
    const span = interval(candidate);
    if (!span) return false;
    return span.end >= start && span.start <= end;
  }

  function boundedCandidate(event) {
    return {
      name: String(event?.name || ''),
      durationMs: finiteNumber(event?.durationMs),
      page: String(event?.__pagePath || ''),
      epochMs: eventTime(event)
    };
  }

  function latestInteractionBefore(events, anchor) {
    const anchorTime = eventTime(anchor);
    if (anchorTime === null) return null;
    const pageIndex = anchor.__pageIndex;
    let best = null;
    for (const event of events) {
      if (event.__pageIndex !== pageIndex || !isInteraction(event)) continue;
      const time = eventTime(event);
      if (time === null || time > anchorTime) continue;
      if (anchorTime - time > MAX_WINDOW_MS) continue;
      if (!best || time > eventTime(best) || (time === eventTime(best) && event.__eventIndex > best.__eventIndex)) best = event;
    }
    return best;
  }

  function summarizeClass(windows, kind) {
    const rows = windows.filter((window) => window.kind === kind);
    const correlated = rows.filter((window) => window.correlated === true);
    const withLegacy = correlated.filter((window) => window.candidateCount > 0);
    const candidateCount = withLegacy.reduce((sum, window) => sum + window.candidateCount, 0);
    const maxCandidateMs = withLegacy.reduce((max, window) => Math.max(max, finiteNumber(window.maxCandidateMs) || 0), 0);
    return {
      enqueueCount: rows.length,
      correlatedWindowCount: correlated.length,
      windowsWithLegacyWork: withLegacy.length,
      candidateCount,
      maxCandidateMs: withLegacy.length ? maxCandidateMs : null,
      fullyCorrelated: rows.length > 0 && correlated.length === rows.length
    };
  }

  function review(report) {
    const events = flattenEvents(report);
    const candidates = events.filter(isLegacyFullStateCandidate);
    const anchors = events.filter((event) => Boolean(mutationKind(event)));
    const windows = [];

    for (const anchor of anchors.slice(-MAX_WINDOWS)) {
      const kind = mutationKind(anchor);
      const end = eventTime(anchor);
      const interaction = latestInteractionBefore(events, anchor);
      const start = interaction ? eventTime(interaction) : null;
      const pagePath = String(anchor.__pagePath || '');
      const matching = start === null || end === null
        ? []
        : candidates.filter((candidate) => candidate.__pageIndex === anchor.__pageIndex && overlaps(candidate, start, end));
      matching.sort((a, b) => (finiteNumber(b.durationMs) || 0) - (finiteNumber(a.durationMs) || 0));
      const bounded = matching.slice(0, MAX_CANDIDATES_PER_WINDOW).map(boundedCandidate);
      windows.push({
        kind,
        page: pagePath,
        enqueueEpochMs: end,
        interactionEpochMs: start,
        interactionName: interaction ? String(interaction.name || '') : null,
        interactionToEnqueueMs: start !== null && end !== null ? Math.max(0, end - start) : null,
        correlated: start !== null && end !== null,
        candidateCount: matching.length,
        maxCandidateMs: matching.length ? finiteNumber(matching[0].durationMs) : null,
        candidates: bounded
      });
    }

    const byMutationClass = Object.fromEntries(MUTATION_KINDS.map((kind) => [kind, summarizeClass(windows, kind)]));
    const correlated = windows.filter((window) => window.correlated);
    const withLegacy = correlated.filter((window) => window.candidateCount > 0);
    const maxLegacyForegroundCandidateMs = withLegacy.reduce((max, window) => Math.max(max, finiteNumber(window.maxCandidateMs) || 0), 0);
    const allObservedEnqueuesCorrelated = windows.length > 0 && correlated.length === windows.length;

    return {
      schemaVersion: 1,
      maxInteractionWindowMs: MAX_WINDOW_MS,
      enqueueCount: windows.length,
      correlatedMutationWindowCount: correlated.length,
      uncorrelatedMutationWindowCount: windows.length - correlated.length,
      allObservedEnqueuesCorrelated,
      foregroundLegacyWorkObserved: withLegacy.length > 0,
      windowsWithLegacyWork: withLegacy.length,
      legacyForegroundCandidateCount: withLegacy.reduce((sum, window) => sum + window.candidateCount, 0),
      maxLegacyForegroundCandidateMs: withLegacy.length ? maxLegacyForegroundCandidateMs : null,
      byMutationClass,
      mutationWindows: windows
    };
  }

  const api = {
    installed: true,
    version: 2,
    review,
    flattenEvents,
    isLegacyFullStateCandidate
  };

  global.TaskPointsStateRuntimeV2ForegroundCorrelation = api;
  if (typeof module !== 'undefined' && module?.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
