const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const guard = fs.readFileSync(path.join(root, 'home_season_slate_long_quiet.js'), 'utf8');
const diagnostics = fs.readFileSync(path.join(root, 'phase4_diagnostics.js'), 'utf8');

test('Home season slate materialization requires eight seconds of sustained quiet', () => {
  assert.match(guard, /const TARGET_JOB = 'home-season-materialization';/);
  assert.match(guard, /const REQUIRED_QUIET_MS = 8000;/);
  assert.match(guard, /lastInteractionAgoMs \|\| 0\) >= REQUIRED_QUIET_MS/);
  assert.match(guard, /homeSeason\.longQuietDeferred/);
  assert.match(guard, /homeSeason\.longQuietReleased/);
  assert.match(guard, /originalEnqueue\(name, \(\) => waitForLongQuiet\(run\), options\)/);
});

test('Home season quiet guard is loaded only on Home', () => {
  assert.match(diagnostics, /loadTaskPointsHomeSeasonSlateLongQuiet/);
  assert.match(diagnostics, /home_season_slate_long_quiet\.js\?v=20260820-1/);
  assert.match(diagnostics, /if \(!isHome\) return;/);
});
