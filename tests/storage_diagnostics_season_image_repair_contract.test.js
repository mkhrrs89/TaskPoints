const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'storage_diagnostics.html'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'storage_diagnostics_season_image_repair_controller.js'), 'utf8');
const helper = fs.readFileSync(path.join(root, 'storage_season_image_reference_repair.js'), 'utf8');

test('Storage Diagnostics loads versioned Season repair assets and exposes a separate disabled action', () => {
  assert.match(html, /id="repairMissingSeasonImagesBtn"[^>]*disabled/);
  assert.match(html, /id="seasonImageRepairStatus"/);
  assert.match(html, /storage_season_image_reference_repair\.js\?v=20260804-3/);
  assert.match(html, /storage_diagnostics_season_image_repair_controller\.js\?v=20260804-3/);
  assert.match(html, /Only the separately confirmed image-cleanup action can delete storage/);
  assert.match(html, /separate confirmed Season repair changes only verified Season imageId references/);
});

test('repair is dynamic and never hardcodes the five observed player names or image IDs', () => {
  for (const forbidden of ['Fletcher', 'Carl', 'Seraphine', 'Verrick', 'Poppy', '1782aceb', '278acd38', '8f651407', 'df4f6d65', 'ed993abc']) {
    assert.doesNotMatch(helper, new RegExp(forbidden, 'i'));
    assert.doesNotMatch(controller, new RegExp(forbidden, 'i'));
  }
  assert.match(helper, /currentByPlayerId/);
  assert.match(helper, /currentPlayerIdFor/);
  assert.match(helper, /seasonPlayerIdFor/);
  assert.match(helper, /duplicate-current-player-id/);
  assert.match(helper, /replacement-blob-missing/);
  assert.match(helper, /reference-paths-unavailable/);
  assert.match(helper, /ambiguous-missing-image-reference/);
});

test('controller flushes deferred writes and requires complete stale-preview revalidation', () => {
  assert.match(controller, /flushPendingSaves/);
  assert.match(controller, /flushPendingInteractiveRecompresses/);
  assert.match(controller, /requireImageReportFingerprint\(previewReport\)/);
  assert.match(controller, /requireImageReportFingerprint\(validatedReport\)/);
  assert.match(controller, /window\.confirm\(/);
  assert.match(controller, /validatedState\.raw !== previewState\.raw/);
  assert.match(controller, /validatedReport\.fingerprint !== previewReport\.fingerprint/);
  assert.match(controller, /validatedPlan\.fingerprint !== previewPlan\.fingerprint/);
  assert.match(controller, /Nothing was changed/);
});

test('controller bypasses mutating save pipelines and uses the exact full-state writer', () => {
  assert.match(controller, /core\.writeTaskPointsStoredState\(nextState/);
  assert.match(controller, /expectedPreviousRaw/);
  assert.match(controller, /localStorage\.getItem\(STORAGE_KEY\).*expectedPreviousRaw/s);
  assert.doesNotMatch(controller, /core\.saveAppState\(/);
  assert.doesNotMatch(controller, /core\.mergeAndSaveState\(/);
  assert.doesNotMatch(controller, /indexedDB\.deleteDatabase|objectStore\([^)]*\)\.delete/);
});

test('runtime verifies whole-state parity, exact Season images, and zero missing references after saving', () => {
  assert.match(controller, /repair\.nonImageSnapshot\(validatedState\.state\) !== repair\.nonImageSnapshot\(applied\.state\)/);
  assert.match(controller, /repair\.nonImageSnapshot\(validatedState\.state\) !== repair\.nonImageSnapshot\(finalState\.state\)/);
  assert.match(controller, /expectedSeasonImages = repair\.seasonImageSnapshot\(applied\.state\)/);
  assert.match(controller, /repair\.seasonImageSnapshot\(finalState\.state\) !== expectedSeasonImages/);
  assert.match(controller, /remainingOldIds/);
  assert.match(controller, /finalReport\.missingReferences\.length/);
  assert.match(controller, /No other data changed/);
});

test('post-write failure never performs a non-atomic automatic rollback', () => {
  assert.match(controller, /automatic rollback was not attempted because localStorage cannot provide an atomic cross-tab compare-and-swap/);
  assert.match(controller, /A newer TaskPoints state was detected and preserved/);
  assert.doesNotMatch(controller, /restoreRawState/);
  assert.doesNotMatch(controller, /safeReplaceTaskPointsStorage/);
  assert.doesNotMatch(controller, /localStorage\.setItem\(STORAGE_KEY/);
});

test('terminal operation messages survive observer and interval refreshes', () => {
  assert.match(controller, /let terminalStatusLocked = false/);
  assert.match(controller, /function setTerminalStatus/);
  assert.match(controller, /if \(!terminalStatusLocked/);
  assert.match(controller, /setInterval\(updateControls, 1000\)/);
  assert.match(controller, /Repaired and verified/);
  assert.match(controller, /addEventListener\('click',[\s\S]*clearTerminalStatus\(\)/);
});
