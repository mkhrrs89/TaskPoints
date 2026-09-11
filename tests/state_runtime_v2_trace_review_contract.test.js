const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const reviewer = require(path.join(__dirname, '..', 'state_runtime_v2_trace_review.js'));

function baseReport(extraEvents = []) {
  return {
    generatedAtISO: '2026-09-11T16:00:00.000Z',
    stateRuntimeV2Status: {
      traceDiagnostics: {
        maintenanceIdle: {
          deepQuietMs: 20000,
          deepQuietDeferrals: 1,
          deepQuietReleases: 1,
          executed: 1,
          failures: 0
        },
        serialization: { failures: 0 },
        acceptance: {
          directForegroundMaintenanceCalls: 0,
          automaticParityDeepIdleObserved: true,
          noV2FailuresObserved: true,
          deepQuietMs: 20000
        }
      }
    },
    pages: [{
      path: '/',
      events: [
        { epochMs: 1000, type: 'duration', name: 'stateV2.enqueue.completion.sync', durationMs: 0.5, detail: { foregroundBlocking: true } },
        { epochMs: 1010, type: 'duration', name: 'stateV2.txn.completion', durationMs: 4, detail: { committed: true } },
        { epochMs: 2000, type: 'duration', name: 'stateV2.enqueue.order.sync', durationMs: 0.6, detail: { foregroundBlocking: true } },
        { epochMs: 2010, type: 'duration', name: 'stateV2.txn.order', durationMs: 5, detail: { committed: true } },
        { epochMs: 3000, type: 'duration', name: 'stateV2.enqueue.edit.sync', durationMs: 0.7, detail: { foregroundBlocking: true } },
        { epochMs: 3010, type: 'duration', name: 'stateV2.txn.edit', durationMs: 6, detail: { committed: true } },
        { epochMs: 4000, type: 'duration', name: 'stateV2.enqueue.presence.sync', durationMs: 0.8, detail: { foregroundBlocking: true } },
        { epochMs: 4010, type: 'duration', name: 'stateV2.txn.presence', durationMs: 7, detail: { committed: true } },
        { epochMs: 5000, type: 'mark', name: 'stateV2.maintenance.parity.deepDeferred', detail: { foregroundBlocking: false } },
        { epochMs: 9000, type: 'mark', name: 'interaction.pointerdown', detail: { target: 'button' } },
        { epochMs: 29000, type: 'mark', name: 'stateV2.maintenance.parity.deepReleased', detail: { foregroundBlocking: false } },
        { epochMs: 29010, type: 'duration', name: 'stateV2.maintenance.parity', durationMs: 12, detail: { scheduled: true, foregroundBlocking: false } },
        ...extraEvents
      ]
    }]
  };
}

test('review recognizes complete four-class device trace evidence and deep-idle preemption', () => {
  const result = reviewer.review(baseReport());

  assert.equal(result.schemaVersion, 2);
  assert.equal(result.allMutationClassesObserved, true);
  assert.equal(result.mutationClasses.completion.observed, true);
  assert.equal(result.mutationClasses.order.observed, true);
  assert.equal(result.mutationClasses.edit.observed, true);
  assert.equal(result.mutationClasses.presence.observed, true);
  assert.equal(result.mutationClasses.presence.maxSyncEnqueueMs, 0.8);
  assert.equal(result.maintenance.directForegroundMaintenanceCount, 0);
  assert.equal(result.noDirectForegroundMaintenanceObserved, true);
  assert.equal(result.maintenance.scheduledAfterDeepRelease, true);
  assert.equal(result.automaticParityDeepIdleObserved, true);
  assert.equal(result.preemption.interactionCount, 1);
  assert.equal(result.preemption.quietAfterLastInteractionMs, 20000);
  assert.equal(result.interactionPreemptionObserved, true);
  assert.equal(result.failures.noV2FailuresObserved, true);
  assert.equal(result.evidenceCompleteForDeviceTrace, true);
  assert.equal(result.physicalDeviceEvidenceMustBeConfirmedByTester, true);
});

test('direct foreground parity is called out and blocks evidence-complete verdict', () => {
  const report = baseReport([
    { epochMs: 30000, type: 'duration', name: 'stateV2.maintenance.parity', durationMs: 9, detail: { foregroundBlocking: true } }
  ]);
  const result = reviewer.review(report);

  assert.equal(result.maintenance.directForegroundMaintenanceCount, 1);
  assert.equal(result.noDirectForegroundMaintenanceObserved, false);
  assert.equal(result.evidenceCompleteForDeviceTrace, false);
});

test('failed V2 events or subsystem failures block evidence-complete verdict', () => {
  const report = baseReport([
    { epochMs: 30500, type: 'duration', name: 'stateV2.txn.completion', durationMs: 3, detail: { failed: true } }
  ]);
  report.stateRuntimeV2Status.traceDiagnostics.serialization.failures = 1;
  const result = reviewer.review(report);

  assert.equal(result.failures.failedEventCount, 1);
  assert.equal(result.failures.mutationFailureCount, 1);
  assert.equal(result.failures.subsystemFailureCount, 1);
  assert.equal(result.failures.runtimeMirrorFailureCount, 0);
  assert.equal(result.failures.noV2FailuresObserved, false);
  assert.equal(result.evidenceCompleteForDeviceTrace, false);
});

test('legacy failures do not masquerade as V2 failures', () => {
  const report = baseReport([
    { epochMs: 30500, type: 'duration', name: 'phase2.persist', durationMs: 5, detail: { failed: true } }
  ]);
  const result = reviewer.review(report);

  assert.equal(result.failures.failedEventCount, 0);
  assert.equal(result.failures.noV2FailuresObserved, true);
  assert.equal(result.evidenceCompleteForDeviceTrace, true);
});

test('named V2 failure marks and runtime mirror failures block acceptance', () => {
  const report = baseReport([
    { epochMs: 30500, type: 'mark', name: 'stateV2.walBridgeFailed', detail: { phase: 'confirm' } }
  ]);
  report.stateRuntimeV2Status.mirrorFailures = 1;
  const result = reviewer.review(report);

  assert.equal(result.failures.failedEventCount, 1);
  assert.equal(result.failures.runtimeMirrorFailureCount, 1);
  assert.equal(result.failures.subsystemFailureCount, 1);
  assert.equal(result.failures.noV2FailuresObserved, false);
  assert.equal(result.evidenceCompleteForDeviceTrace, false);
});

test('legacy Phase 2/4/5 and generic full-state durations are surfaced for foreground correlation', () => {
  const report = baseReport([
    { epochMs: 31000, type: 'duration', name: 'phase4.storage.verifySnapshot', durationMs: 44, detail: { source: 'habit' } },
    { epochMs: 32000, type: 'duration', name: 'phase2.persist', durationMs: 88, detail: { source: 'habit' } },
    { epochMs: 32500, type: 'duration', name: 'storage.setItem', durationMs: 31, detail: { key: 'taskpoints_v1', valueLength: 500000 } },
    { epochMs: 32600, type: 'duration', name: 'json.stringify', durationMs: 27, detail: { outputLength: 500000 } },
    { epochMs: 32700, type: 'duration', name: 'structuredClone', durationMs: 22, detail: { completions: 9000 } },
    { epochMs: 32800, type: 'duration', name: 'core.saveStateSnapshot', durationMs: 36, detail: { savePath: 'habit' } },
    { epochMs: 32900, type: 'duration', name: 'indexedDB.transaction', durationMs: 19, detail: { db: 'taskpoints_shadow_migration', mode: 'readwrite' } },
    { epochMs: 32950, type: 'duration', name: 'indexedDB.transaction', durationMs: 200, detail: { db: 'taskpoints_state_v2', mode: 'readwrite' } },
    { epochMs: 33000, type: 'duration', name: 'unrelated.fastThing', durationMs: 999, detail: {} }
  ]);
  const result = reviewer.review(report);

  assert.equal(result.legacyForegroundDurations.length, 3);
  assert.equal(result.legacyForegroundDurations[0].name, 'phase2.persist');
  assert.equal(result.legacyForegroundDurations[0].durationMs, 88);
  assert.equal(result.legacyForegroundDurations[1].name, 'phase4.storage.verifySnapshot');
  assert.equal(result.legacyFullStateCandidates.some((row) => row.name === 'storage.setItem' && row.detail.key === 'taskpoints_v1'), true);
  assert.equal(result.legacyFullStateCandidates.some((row) => row.name === 'json.stringify'), true);
  assert.equal(result.legacyFullStateCandidates.some((row) => row.name === 'structuredClone'), true);
  assert.equal(result.legacyFullStateCandidates.some((row) => row.name === 'core.saveStateSnapshot'), true);
  assert.equal(result.legacyFullStateCandidates.some((row) => row.name === 'indexedDB.transaction' && row.detail.db === 'taskpoints_shadow_migration'), true);
  assert.equal(result.legacyFullStateCandidates.some((row) => row.name === 'indexedDB.transaction' && row.detail.db === 'taskpoints_state_v2'), false);
  assert.equal(result.maxLegacyFullStateCandidateMs, 88);
  assert.equal(result.legacyForegroundCorrelationStillRequired, true);
});

test('otherwise complete trace is not accepted without interaction preemption evidence', () => {
  const report = baseReport();
  report.pages[0].events = report.pages[0].events.filter((event) => event.name !== 'interaction.pointerdown');
  const result = reviewer.review(report);

  assert.equal(result.allMutationClassesObserved, true);
  assert.equal(result.automaticParityDeepIdleObserved, true);
  assert.equal(result.noDirectForegroundMaintenanceObserved, true);
  assert.equal(result.failures.noV2FailuresObserved, true);
  assert.equal(result.interactionPreemptionObserved, false);
  assert.equal(result.evidenceCompleteForDeviceTrace, false);
});

test('review remains conservative when mutation classes or deep-idle evidence are absent', () => {
  const report = {
    stateRuntimeV2Status: { traceDiagnostics: { maintenanceIdle: { deepQuietMs: 20000 }, serialization: { failures: 0 } } },
    pages: [{ path: '/', events: [
      { epochMs: 100, type: 'duration', name: 'stateV2.enqueue.completion.sync', durationMs: 0.4, detail: {} },
      { epochMs: 110, type: 'duration', name: 'stateV2.txn.completion', durationMs: 3, detail: {} }
    ] }]
  };
  const result = reviewer.review(report);

  assert.equal(result.allMutationClassesObserved, false);
  assert.equal(result.automaticParityDeepIdleObserved, false);
  assert.equal(result.interactionPreemptionObserved, false);
  assert.equal(result.evidenceCompleteForDeviceTrace, false);
  assert.equal(result.legacyFullStateCandidates.length, 0);
  assert.equal(result.legacyForegroundCorrelationStillRequired, false);
});
