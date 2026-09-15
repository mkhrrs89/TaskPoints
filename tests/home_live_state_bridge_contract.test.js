const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const home = fs.readFileSync('index.html', 'utf8');
const recurring = fs.readFileSync('home_season_slate_long_quiet.js', 'utf8');
const featured = fs.readFileSync('home_featured_matchup_visibility.js', 'utf8');

test('Home exposes its current lexical state through a lightweight getter', () => {
  assert.match(home, /window\.TaskPointsHomeLiveState\s*=\s*\{\s*getState\(\) \{ return state; \}\s*\};/s);
});

test('Home UI-only decorators prefer live state before persisted-state fallbacks', () => {
  assert.match(recurring, /TaskPointsHomeLiveState\?\.getState\?\.\(\)/);
  assert.match(featured, /TaskPointsHomeLiveState\?\.getState\?\.\(\)/);
  assert.match(recurring, /core\.loadAppState\?\.\(\{ syncDerived: false, persistSync: false \}\)/);
  assert.match(featured, /core\.loadAppState\(\{ syncDerived: false, persistSync: false \}\)/);
});
