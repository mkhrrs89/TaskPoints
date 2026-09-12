(function installTaskPointsStateRuntimeV2TraceReview(global) {
  'use strict';

  if (!global || global.TaskPointsStateRuntimeV2TraceReview?.installed) return;

  const MUTATION_KINDS = ['completion', 'order', 'edit', 'presence'];
  const ENQUEUE_PREFIX = 'stateV2.enqueue.';
  const TXN_PREFIX = 'stateV2.txn.';
  const CAPTURE_PREFIX = 'stateV2.capture.';
  const COMMIT_MARKS = Object.freeze({
    completion: 'stateV2.darkMutationCommitted',
    order: 'stateV2.darkOrderMutationCommitted',
    edit: 'stateV2.darkHabitEditCommitted',
    presence: 'stateV2.darkHabitPresenceCommitted'
  });
  const V2_DB_NAME = 'taskpoints_state_v2';

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
    if (!report || typeof report !== 'object') return [];
    const rows = [];
    const pages = Array.isArray(report.pages) ? report.pages : [];
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

  function eventMatchesKind(event, prefix, kind, suffix = '') {
    return String(event?.name || '') === `${prefix}${kind}${suffix}`;
  }

  function durableRuntimeCommitCount(kind, status) {
    const total = Math.max(0, finiteNumber(status?.mirroredMutations) || 0);
    const order = Math.max(0, finiteNumber(status?.mirroredOrderMutations) || 0);
    const edit = Math.max(0, finiteNumber(status?.mirroredEditMutations) || 0);
    const presence = Math.max(0, finiteNumber(status?.mirroredPresenceMutations) || 0);
    if (kind === 'order') return order;
    if (kind === 'edit') return edit;
    if (kind === 'presence') return presence;
    if (kind === 'completion') {
      const explicit = finiteNumber(status?.mirroredCompletionMutations);
      return explicit === null ? Math.max(0, total - order - edit - presence) : Math.max(0, explicit);
    }
    return 0;
  }

  function observedMutationClasses(events, status) {
    const statusClasses = status?.traceDiagnostics?.perf?.mutationClasses
      || status?.traceDiagnostics?.acceptance?.mutationClasses
      || {};
    const out = {};
    for (const kind of MUTATION_KINDS) {
      const enqueueEvents = events.filter((event) => eventMatchesKind(event, ENQUEUE_PREFIX, kind, '.sync'));
      const txnEvents = events.filter((event) => eventMatchesKind(event, TXN_PREFIX, kind));
      const captureEvents = events.filter((event) => eventMatchesKind(event, CAPTURE_PREFIX, kind, '.sync'));
      const commitEvents = events.filter((event) => String(event?.name || '') === COMMIT_MARKS[kind]);
      const statusRow = statusClasses?.[kind] || {};
      const enqueueDurations = enqueueEvents.map((event) => finiteNumber(event.durationMs)).filter((value) => value !== null);
      const txnDurations = txnEvents.map((event) => finiteNumber(event.durationMs)).filter((value) => value !== null);
      const captureDurations = captureEvents.map((event) => finiteNumber(event.durationMs)).filter((value) => value !== null);
      const statusEnqueues = finiteNumber(statusRow.syncEnqueues) || 0;
      const statusTransactions = finiteNumber(statusRow.asyncMutations) || 0;
      const statusFailures = finiteNumber(statusRow.asyncFailures) || 0;
      const enqueueCount = Math.max(enqueueEvents.length, statusEnqueues);
      const transactionCount = Math.max(txnEvents.length, statusTransactions);
      const durableCommits = durableRuntimeCommitCount(kind, status);
      const commitCount = Math.max(commitEvents.length, durableCommits);
      const maxSyncEnqueueMs = enqueueDurations.length ? Math.max(...enqueueDurations) : finiteNumber(statusRow.maxSyncEnqueueMs);
      const maxCaptureMs = captureDurations.length ? Math.max(...captureDurations) : null;
      const foregroundSync = [maxSyncEnqueueMs, maxCaptureMs].filter((value) => value !== null);
      out[kind] = {
        enqueueCount,
        transactionCount,
        commitCount,
        durableCommitCount: durableCommits,
        captureCount: captureEvents.length,
        failureCount: statusFailures + txnEvents.filter((event) => detailObject(event).failed === true).length,
        maxSyncEnqueueMs,
        maxCaptureMs,
        maxForegroundSyncMs: foregroundSync.length ? Math.max(...foregroundSync) : null,
        maxTransactionMs: txnDurations.length ? Math.max(...txnDurations) : finiteNumber(statusRow.maxMutationMs),
        observed: enqueueCount > 0 && (transactionCount > 0 || commitCount > 0)
      };
    }
    return out;
  }

  function maintenanceEvidence(events, status) {
    const maintenanceStatus = status?.traceDiagnostics?.maintenanceIdle || {};
    const directEvents = events.filter((event) => {
      const name = String(event?.name || '');
      if (name !== 'stateV2.maintenance.parity' && name !== 'stateV2.maintenance.compatibility') return false;
      const detail = detailObject(event);
      return detail.foregroundBlocking === true && detail.scheduled !== true;
    });
    const scheduledParity = events.filter((event) => (
      String(event?.name || '') === 'stateV2.maintenance.parity'
      && detailObject(event).scheduled === true
      && detailObject(event).foregroundBlocking === false
    ));
    const deepDeferred = events.filter((event) => String(event?.name || '') === 'stateV2.maintenance.parity.deepDeferred');
    const deepReleased = events.filter((event) => String(event?.name || '') === 'stateV2.maintenance.parity.deepReleased');
    const statusAcceptance = status?.traceDiagnostics?.acceptance || {};

    let scheduledAfterDeepRelease = false;
    for (const release of deepReleased) {
      const releaseTime = eventTime(release);
      if (releaseTime === null) continue;
      if (scheduledParity.some((event) => {
        const time = eventTime(event);
        return time !== null && time >= releaseTime;
      })) {
        scheduledAfterDeepRelease = true;
        break;
      }
    }

    return {
      directForegroundMaintenanceCount: Math.max(
        directEvents.length,
        finiteNumber(statusAcceptance.directForegroundMaintenanceCalls) || 0
      ),
      scheduledParityCount: scheduledParity.length,
      deepDeferredCount: Math.max(deepDeferred.length, finiteNumber(maintenanceStatus.deepQuietDeferrals) || 0),
      deepReleasedCount: Math.max(deepReleased.length, finiteNumber(maintenanceStatus.deepQuietReleases) || 0),
      deepPreemptionCount: Math.max(
        events.filter((event) => String(event?.name || '') === 'stateV2.maintenance.parity.preempted').length,
        finiteNumber(maintenanceStatus.deepQuietPreemptions) || 0
      ),
      deepQuietMs: finiteNumber(maintenanceStatus.deepQuietMs) ?? finiteNumber(statusAcceptance.deepQuietMs),
      scheduledAfterDeepRelease,
      automaticParityDeepIdleObserved: scheduledAfterDeepRelease
        || statusAcceptance.automaticParityDeepIdleObserved === true
    };
  }

  function preemptionEvidence(events, deepQuietMs) {
    const interactions = events.filter((event) => String(event?.name || '').startsWith('interaction.'));
    const deferred = events.filter((event) => String(event?.name || '') === 'stateV2.maintenance.parity.deepDeferred');
    const released = events.filter((event) => String(event?.name || '') === 'stateV2.maintenance.parity.deepReleased');
    const requiredQuietMs = finiteNumber(deepQuietMs);

    for (const release of released) {
      const detail = detailObject(release);
      const preservedPreemptionCount = Math.max(0, finiteNumber(detail.preemptionCount) || 0);
      if (preservedPreemptionCount <= 0) continue;
      const quietAfterInteractionMs = finiteNumber(detail.lastInteractionAgoMs);
      const quietSatisfied = requiredQuietMs === null
        || (quietAfterInteractionMs !== null && quietAfterInteractionMs >= Math.max(0, requiredQuietMs - 1000));
      return {
        observed: quietSatisfied,
        interactionCount: preservedPreemptionCount,
        quietAfterLastInteractionMs: quietAfterInteractionMs,
        requiredQuietMs,
        evidenceSource: 'maintenance_release'
      };
    }

    for (const start of deferred) {
      const startTime = eventTime(start);
      if (startTime === null) continue;
      const release = released.find((candidate) => {
        const time = eventTime(candidate);
        return time !== null && time >= startTime;
      });
      if (!release) continue;
      const releaseTime = eventTime(release);
      const between = interactions.filter((event) => {
        const time = eventTime(event);
        return time !== null && time > startTime && time < releaseTime;
      });
      if (!between.length) continue;
      const lastInteractionTime = Math.max(...between.map(eventTime).filter((value) => value !== null));
      const quietAfterInteractionMs = releaseTime - lastInteractionTime;
      return {
        observed: requiredQuietMs === null ? true : quietAfterInteractionMs >= Math.max(0, requiredQuietMs - 1000),
        interactionCount: between.length,
        quietAfterLastInteractionMs: Number(quietAfterInteractionMs.toFixed(2)),
        requiredQuietMs,
        evidenceSource: 'generic_interaction_trace'
      };
    }

    return {
      observed: false,
      interactionCount: 0,
      quietAfterLastInteractionMs: null,
      requiredQuietMs,
      evidenceSource: null
    };
  }

  function parityEvidence(events, status) {
    const checks = events.filter((event) => event.name === 'stateV2.parityChecked').map(detailObject);
    const last = status?.lastParity;
    if (last?.checked === true) checks.push(last);
    const mismatches = checks.filter((check) => check.match === false);
    return {
      observed: checks.some((check) => check.checked === true),
      mismatchObserved: mismatches.length > 0,
      matchConfirmed: checks.some((check) => check.checked === true && check.match === true) && mismatches.length === 0,
      lastCheck: last || checks[checks.length - 1] || null
    };
  }

  function failureEvidence(events, status, mutationClasses, parity) {
    const failedEvents = events.filter((event) => {
      const name = String(event?.name || '');
      if (!name.startsWith('stateV2.')) return false;
      return detailObject(event).failed === true || /(?:failed|failure)$/i.test(name);
    });
    const acceptance = status?.traceDiagnostics?.acceptance || {};
    const maintenance = status?.traceDiagnostics?.maintenanceIdle || {};
    const serialization = status?.traceDiagnostics?.serialization || {};
    const classFailures = MUTATION_KINDS.reduce((sum, kind) => sum + Number(mutationClasses[kind]?.failureCount || 0), 0);
    const runtimeMirrorFailures = Number(status?.mirrorFailures || 0);
    const subsystemFailures = Number(maintenance.failures || 0)
      + Number(serialization.failures || 0)
      + runtimeMirrorFailures;
    return {
      failedEventCount: failedEvents.length,
      failedEvents: failedEvents.slice(-20).map((event) => ({ name: event.name, page: event.__pagePath, epochMs: event.epochMs, detail: detailObject(event) })),
      parityMismatchObserved: parity.mismatchObserved,
      mutationFailureCount: classFailures,
      subsystemFailureCount: subsystemFailures,
      runtimeMirrorFailureCount: runtimeMirrorFailures,
      noV2FailuresObserved: failedEvents.length === 0
        && !parity.mismatchObserved
        && classFailures === 0
        && subsystemFailures === 0
        && acceptance.noV2FailuresObserved !== false
    };
  }

  function durationRow(event) {
    return {
      name: String(event.name || ''),
      durationMs: Number(event.durationMs),
      page: String(event.__pagePath || ''),
      detail: detailObject(event)
    };
  }

  function legacyForegroundDurations(events) {
    return events
      .filter((event) => {
        if (!Number.isFinite(Number(event?.durationMs))) return false;
        const name = String(event?.name || '').toLowerCase();
        return name.includes('phase2') || name.includes('phase4') || name.includes('phase5')
          || name.includes('verifiedsecondary') || name.includes('compatibility') || name.includes('snapshot');
      })
      .sort((a, b) => Number(b.durationMs) - Number(a.durationMs))
      .slice(0, 20)
      .map(durationRow);
  }

  function legacyFullStateCandidates(events) {
    return events
      .filter((event) => {
        if (!Number.isFinite(Number(event?.durationMs))) return false;
        const name = String(event?.name || '');
        const lower = name.toLowerCase();
        const detail = detailObject(event);
        if (lower.includes('phase2') || lower.includes('phase4') || lower.includes('phase5')
          || lower.includes('verifiedsecondary') || lower.includes('snapshot')) return true;
        if (name === 'storage.setItem' && String(detail.key || '') === 'taskpoints_v1') return true;
        if (name === 'json.stringify' || name === 'structuredClone') return true;
        if (name === 'core.saveStateSnapshot' || name === 'core.saveValidatedSnapshot'
          || name === 'core.shadowSourceSummary' || name === 'core.shadowCanonicalJson') return true;
        if (name === 'indexedDB.transaction') {
          const db = String(detail.db || '');
          return Boolean(db) && db !== V2_DB_NAME;
        }
        return false;
      })
      .sort((a, b) => Number(b.durationMs) - Number(a.durationMs))
      .slice(0, 40)
      .map(durationRow);
  }

  function review(report) {
    const events = flattenEvents(report);
    const status = report?.stateRuntimeV2Status || null;
    const mutationClasses = observedMutationClasses(events, status);
    const maintenance = maintenanceEvidence(events, status);
    const preemption = preemptionEvidence(events, maintenance.deepQuietMs);
    const parity = parityEvidence(events, status);
    const failures = failureEvidence(events, status, mutationClasses, parity);
    const legacyCandidates = legacyFullStateCandidates(events);
    const allMutationClassesObserved = MUTATION_KINDS.every((kind) => mutationClasses[kind].observed === true);
    const noDirectForegroundMaintenanceObserved = maintenance.directForegroundMaintenanceCount === 0;

    return {
      schemaVersion: 4,
      reportGeneratedAtISO: report?.generatedAtISO || null,
      pageCount: Array.isArray(report?.pages) ? report.pages.length : 0,
      eventCount: events.length,
      mutationClasses,
      allMutationClassesObserved,
      maintenance,
      preemption,
      failures,
      parity,
      noDirectForegroundMaintenanceObserved,
      automaticParityDeepIdleObserved: maintenance.automaticParityDeepIdleObserved,
      interactionPreemptionObserved: preemption.observed,
      legacyForegroundDurations: legacyForegroundDurations(events),
      legacyFullStateCandidates: legacyCandidates,
      maxLegacyFullStateCandidateMs: legacyCandidates.length ? legacyCandidates[0].durationMs : null,
      legacyForegroundCorrelationStillRequired: legacyCandidates.length > 0,
      evidenceCompleteForDeviceTrace: allMutationClassesObserved
        && noDirectForegroundMaintenanceObserved
        && maintenance.automaticParityDeepIdleObserved
        && preemption.observed
        && failures.noV2FailuresObserved
        && parity.matchConfirmed,
      physicalDeviceEvidenceMustBeConfirmedByTester: true
    };
  }

  const api = {
    installed: true,
    version: 5,
    review,
    flattenEvents
  };

  global.TaskPointsStateRuntimeV2TraceReview = api;
  if (typeof module !== 'undefined' && module?.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
