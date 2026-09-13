const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'state_v2_trace_review.html'), 'utf8');
const correlator = require(path.join(__dirname, '..', 'state_runtime_v2_foreground_correlation.js'));

test('trace review page loads the V2 reviewer, foreground correlator, and accepts JSON files', () => {
  assert.match(source, /id="traceFile"[^>]+type="file"[^>]+accept="application\/json,\.json"/);
  assert.match(source, /<script src="\/state_runtime_v2_trace_review\.js"><\/script>/);
  assert.match(source, /<script src="\/state_runtime_v2_foreground_correlation\.js"><\/script>/);
  assert.match(source, /TaskPointsStateRuntimeV2TraceReview/);
  assert.match(source, /TaskPointsStateRuntimeV2ForegroundCorrelation/);
  assert.match(source, /reviewer\.review\(report\)/);
  assert.match(source, /correlator\.review\(report\)/);
});

test('trace review page is read-only with respect to TaskPoints persistence', () => {
  assert.doesNotMatch(source, /localStorage\.(?:setItem|removeItem|clear)/);
  assert.doesNotMatch(source, /sessionStorage\.(?:setItem|removeItem|clear)/);
  assert.doesNotMatch(source, /indexedDB\.(?:open|deleteDatabase)/);
  assert.doesNotMatch(source, /taskpoints_v1/);
  assert.match(source, /only reads the selected file and does not write TaskPoints state/);
});

test('trace review page keeps physical-device confirmation explicit', () => {
  assert.match(source, /tester still has to confirm the trace came from the intended physical iPhone\/PWA scenario/);
  assert.match(source, /Core device-trace evidence complete/);
  assert.match(source, /Interaction postponement observed/);
  assert.match(source, /Automatic parity crossed deep-idle gate/);
  assert.match(source, /Foreground windows correlated/);
  assert.match(source, /Legacy\/full-state work overlapped a mutation foreground window/);
});

test('trace review page can copy only the derived review JSON', () => {
  assert.match(source, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(source, /JSON\.stringify\(lastReview, null, 2\)/);
  assert.doesNotMatch(source, /fetch\s*\(/);
});

test('foreground correlator ties legacy full-state work to the interaction-to-enqueue window', () => {
  const report = {
    pages: [{
      path: '/',
      events: [
        { epochMs: 1000, name: 'interaction.pointerdown', type: 'mark', detail: { target: 'button' } },
        { epochMs: 1040, name: 'phase2.persist', type: 'duration', durationMs: 35, detail: {} },
        { epochMs: 1050, name: 'storage.setItem', type: 'duration', durationMs: 20, detail: { key: 'taskpoints_v1' } },
        { epochMs: 1060, name: 'core.loadAppState', type: 'duration', durationMs: 45, detail: { syncDerived: false } },
        { epochMs: 1070, name: 'storage.getItem', type: 'duration', durationMs: 18, detail: { key: 'taskpoints_v1' } },
        { epochMs: 1100, name: 'stateV2.enqueue.completion.sync', type: 'duration', durationMs: 0.5, detail: {} },
        { epochMs: 1200, name: 'indexedDB.transaction', type: 'duration', durationMs: 80, detail: { db: 'taskpoints_state_v2' } }
      ]
    }]
  };

  const result = correlator.review(report);
  assert.equal(result.enqueueCount, 1);
  assert.equal(result.correlatedMutationWindowCount, 1);
  assert.equal(result.foregroundLegacyWorkObserved, true);
  assert.equal(result.windowsWithLegacyWork, 1);
  assert.equal(result.legacyForegroundCandidateCount, 4);
  assert.equal(result.maxLegacyForegroundCandidateMs, 45);
  assert.equal(result.byMutationClass.completion.fullyCorrelated, true);
  assert.deepEqual(result.mutationWindows[0].candidates.map((row) => row.name), [
    'core.loadAppState',
    'phase2.persist',
    'storage.setItem',
    'storage.getItem'
  ]);
});

test('foreground correlator recognizes legacy state parsing and stored-state reads', () => {
  const names = [
    'core.readTaskPointsStoredState',
    'core.parseTaskPointsStorageJson',
    'core.saveValidatedSnapshot',
    'core.shadowSourceSummary',
    'core.shadowCanonicalJson'
  ];
  for (const name of names) {
    assert.equal(correlator.isLegacyFullStateCandidate({ name, durationMs: 1, detail: {} }), true, name);
  }
});

test('foreground correlator excludes unrelated history and V2 IndexedDB work', () => {
  const report = {
    pages: [{
      path: '/',
      events: [
        { epochMs: 100, name: 'phase4.storage.verifySnapshot', type: 'duration', durationMs: 50, detail: {} },
        { epochMs: 1000, name: 'interaction.click', type: 'mark', detail: {} },
        { epochMs: 1040, name: 'indexedDB.transaction', type: 'duration', durationMs: 30, detail: { db: 'taskpoints_state_v2' } },
        { epochMs: 1050, name: 'unrelated.fastThing', type: 'duration', durationMs: 999, detail: {} },
        { epochMs: 1100, name: 'stateV2.enqueue.edit.sync', type: 'duration', durationMs: 0.7, detail: {} }
      ]
    }]
  };

  const result = correlator.review(report);
  assert.equal(result.correlatedMutationWindowCount, 1);
  assert.equal(result.foregroundLegacyWorkObserved, false);
  assert.equal(result.legacyForegroundCandidateCount, 0);
  assert.equal(result.maxLegacyForegroundCandidateMs, null);
});

test('foreground correlator counts a long legacy operation spanning the user interaction', () => {
  const report = {
    pages: [{
      path: '/',
      events: [
        { epochMs: 1000, name: 'interaction.pointerdown', type: 'mark', detail: {} },
        { epochMs: 1030, name: 'core.saveStateSnapshot', type: 'duration', durationMs: 80, detail: {} },
        { epochMs: 1080, name: 'stateV2.enqueue.order.sync', type: 'duration', durationMs: 0.5, detail: {} }
      ]
    }]
  };

  const result = correlator.review(report);
  assert.equal(result.foregroundLegacyWorkObserved, true);
  assert.equal(result.maxLegacyForegroundCandidateMs, 80);
  assert.equal(result.mutationWindows[0].candidateCount, 1);
});

test('foreground correlator reports missing interaction anchors conservatively', () => {
  const report = {
    pages: [{
      path: '/',
      events: [
        { epochMs: 1100, name: 'phase2.persist', type: 'duration', durationMs: 20, detail: {} },
        { epochMs: 1200, name: 'stateV2.enqueue.presence.sync', type: 'duration', durationMs: 0.5, detail: {} }
      ]
    }]
  };

  const result = correlator.review(report);
  assert.equal(result.enqueueCount, 1);
  assert.equal(result.correlatedMutationWindowCount, 0);
  assert.equal(result.uncorrelatedMutationWindowCount, 1);
  assert.equal(result.allObservedEnqueuesCorrelated, false);
  assert.equal(result.foregroundLegacyWorkObserved, false);
});
