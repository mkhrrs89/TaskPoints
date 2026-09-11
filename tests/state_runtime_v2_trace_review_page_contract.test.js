const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'state_v2_trace_review.html'), 'utf8');

test('trace review page loads the V2 reviewer and accepts JSON files', () => {
  assert.match(source, /id="traceFile"[^>]+type="file"[^>]+accept="application\/json,\.json"/);
  assert.match(source, /<script src="\/state_runtime_v2_trace_review\.js"><\/script>/);
  assert.match(source, /TaskPointsStateRuntimeV2TraceReview/);
  assert.match(source, /reviewer\.review\(report\)/);
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
});

test('trace review page can copy only the derived review JSON', () => {
  assert.match(source, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(source, /JSON\.stringify\(lastReview, null, 2\)/);
  assert.doesNotMatch(source, /fetch\s*\(/);
});
