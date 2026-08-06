const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const worker = [
  fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8'),
  fs.readFileSync(path.join(__dirname, '..', 'mobile_boot_gate.js'), 'utf8')
].join('\n');

test('Home response installs a matching dark iPhone launch image', () => {
  assert.match(worker, /rel=\"apple-touch-startup-image\"/);
  assert.match(worker, /taskpoints-startup-1170x2532\.png/);
  assert.match(worker, /device-width: 390px/);
  assert.match(worker, /device-height: 844px/);
  assert.match(worker, /-webkit-device-pixel-ratio: 3/);
});

test('heavy Home runtime scripts are inert until the matrix reaches its final title', () => {
  assert.match(worker, /scoring_core\\\.js\$\/\.test\(src\)\) deferRuntimeScripts = true/);
  assert.match(worker, /data-tp-boot-deferred/);
  assert.match(worker, /application\/x-taskpoints-boot-deferred/);
  assert.match(worker, /titleEl\.textContent\.trim\(\) === WORD/);
  assert.match(worker, /markFinalTitle[\s\S]*startRuntime\(\)/);
});

test('final TASKPOINTS title holds for one second before normal reveal', () => {
  assert.match(worker, /const FINAL_HOLD_MS = 1000/);
  assert.match(worker, /FINAL_HOLD_MS - \(performance\.now\(\) - finalAt\)/);
  assert.match(worker, /shouldGateBoot && !skipRequested/);
});

test('tap skip is captured before the old splash handler and starts runtime safely', () => {
  assert.match(worker, /splash\.addEventListener\(type, captureSkip, \{[\s\S]*capture: true/);
  assert.match(worker, /event\.stopImmediatePropagation\(\)/);
  assert.match(worker, /window\.__tpForceMatrixCompletion\?\.\(\)/);
  assert.match(worker, /revealRequested = \{ skipped: true \}/);
});

test('deferred scripts replay serially and request reveal only after replay', () => {
  assert.match(worker, /for \(const node of deferred\) \{\s+await replayScript\(node\)/);
  assert.match(worker, /await replayDeferredRuntime\(\);[\s\S]*coordinator\.requestReveal/);
});

test('late DOM ready listeners still run after deferred replay', () => {
  assert.match(worker, /lateReadyListeners/);
  assert.match(worker, /document\.readyState !== \"loading\"/);
  assert.match(worker, /coordinator\.flushLateReadyListeners\(\)/);
  assert.match(worker, /await Promise\.resolve\(\);\s+await Promise\.resolve\(\)/);
});
