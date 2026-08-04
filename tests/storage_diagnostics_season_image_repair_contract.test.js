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
  assert.match(html, /storage_season_image_reference_repair\.js\?v=20260804-1/);
  assert.match(html, /storage_diagnostics_season_image_repair_controller\.js\?v=20260804-1/);
  assert.match(html, /Only separately confirmed repair or cleanup actions can modify storage/);
});

test('repair is dynamic and never hardcodes the five observed player names or image IDs', () => {
  for (const forbidden of ['Fletcher', 'Carl', 'Seraphine', 'Verrick', 'Poppy', '1782aceb', '278acd38', '8f651407', 'df4f6d65', 'ed993abc']) {
    assert.doesNotMatch(helper, new RegExp(forbidden, 'i'));
    assert.doesNotMatch(controller, new RegExp(forbidden, 'i'));
  }
  assert.match(helper, /currentByPlayerId/);
  assert.match(helper, /duplicate-current-player-id/);
  assert.match(helper, /replacement-blob-missing/);
  assert.match(helper, /reference-paths-unavailable/);
});

test('controller requires native confirmation and stale-preview revalidation', () => {
  assert.match(controller, /window\.confirm\(/);
  assert.match(controller, /validatedState\.raw !== previewState\.raw/);
  assert.match(controller, /validatedPlan\.fingerprint !== previewPlan\.fingerprint/);
  assert.match(controller, /Nothing was changed/);
});

test('controller saves only currentSeason and seasonHistory through the normal save pipeline', () => {
  assert.match(controller, /const patch = \{[\s\S]*currentSeason:[\s\S]*seasonHistory:/);
  assert.match(controller, /core\.saveAppState\(patch/);
  assert.match(controller, /immediateWrite: true/);
  assert.match(controller, /userInitiated: true/);
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

test('final operation message survives the controls refresh', () => {
  assert.match(controller, /updateControls\(preserveStatus = false\)/);
  assert.match(controller, /updateControls\(true\)/);
  assert.match(controller, /Repaired and verified/);
});
