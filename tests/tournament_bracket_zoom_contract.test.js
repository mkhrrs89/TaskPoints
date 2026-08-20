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
  assert.match(zoom, /viewport\.scrollLeft -= dx;/);
  assert.match(zoom, /viewport\.scrollTop -= dy;/);
  assert.match(zoom, /bracket\.style\.transform = `scale\(\$\{scale\}\)`/);
});

test('Tournament bracket zoom module is loaded only on the tournament page', () => {
  assert.match(diagnostics, /loadTaskPointsTournamentBracketZoom/);
  assert.match(diagnostics, /tournament_bracket_zoom\.js\?v=20260820-1/);
  assert.match(diagnostics, /pathname === '\/tournament'/);
  assert.match(diagnostics, /pathname === '\/tournament\.html'/);
});
