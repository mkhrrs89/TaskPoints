const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const zoom = fs.readFileSync(path.join(root, 'tournament_bracket_zoom.js'), 'utf8');
const diagnostics = fs.readFileSync(path.join(root, 'phase4_diagnostics.js'), 'utf8');

test('Tournament bracket supports pinch zoom and two-axis panning', () => {
  assert.match(zoom, /const MIN_SCALE = 0\.18;/);
  assert.match(zoom, /const MAX_SCALE = 2\.5;/);
  assert.match(zoom, /overflow: auto !important;/);
  assert.match(zoom, /touch-action: none;/);
  assert.match(zoom, /addEventListener\('touchstart'/);
  assert.match(zoom, /addEventListener\('touchmove'/);
  assert.match(zoom, /addEventListener\('touchend'/);
  assert.match(zoom, /event\.preventDefault\(\)/);
  assert.match(zoom, /pendingPanX \+= dx;/);
  assert.match(zoom, /pendingPanY \+= dy;/);
  assert.match(zoom, /translate3d\(0, 0, 0\) scale\(\$\{scale\}\)/);
});

test('Tournament pinch/pan work is coalesced to animation frames without observing its own style writes', () => {
  assert.match(zoom, /function scheduleFrame\(\)/);
  assert.match(zoom, /requestAnimationFrame\?\.\(applyQueuedFrame\)/);
  assert.match(zoom, /function expandStageForPinch\(\)/);
  assert.match(zoom, /updateStageSize\(scale\);/);
  assert.match(zoom, /noteStorageUserInteraction/);
  assert.match(zoom, /characterData: true/);
  assert.doesNotMatch(zoom, /attributes:\s*true/);
});

test('Tournament bracket zoom module is loaded only on the tournament page', () => {
  assert.match(diagnostics, /loadTaskPointsTournamentBracketZoom/);
  assert.match(diagnostics, /tournament_bracket_zoom\.js\?v=20260820-2/);
  assert.match(diagnostics, /pathname === '\/tournament'/);
  assert.match(diagnostics, /pathname === '\/tournament\.html'/);
});
