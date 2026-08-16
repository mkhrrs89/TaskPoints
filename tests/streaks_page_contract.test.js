const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'streaks.html'), 'utf8');
const nav = fs.readFileSync(path.join(ROOT, 'streaks_nav_link.js'), 'utf8');
const guard = fs.readFileSync(path.join(ROOT, 'habit_completion_source_guard.js'), 'utf8');

test('streaks page exposes the requested sortable columns in order', () => {
  for (const key of ['name', 'bonus', 'streak', 'points']) {
    assert.match(page, new RegExp(`data-sort=["']${key}["']`));
  }
  assert.doesNotMatch(page, /data-sort=["']type["']/);
  assert.doesNotMatch(page, /<th[^>]*>.*\bType\b/s);
  assert.match(page, />Bonus\s*</);
  assert.match(page, />Days\s*</);
  assert.match(page, />Pts\s*</);
  assert.match(
    page,
    /data-sort=["']name["'][\s\S]*data-sort=["']bonus["'][\s\S]*data-sort=["']streak["'][\s\S]*data-sort=["']points["']/
  );
  assert.match(page, /filter\(\(habit\) => habit && !habit\.retired\)/);
});

test('current bonus reuses canonical completion scoring and subtracts base value', () => {
  assert.match(page, /core\.pointsForCompletion\(synthetic, state\)/);
  assert.match(page, /adjusted - base/);
  assert.match(page, /streakMultiplierEnabled !== true/);
});

test('current streak keeps yesterday alive until today is explicitly marked', () => {
  assert.match(page, /diffToToday === 1 && isMarkedToday/);
  assert.match(page, /doneKeys\.includes\(todayKey\) \|\| failedKeys\.includes\(todayKey\)/);
});

test('mobile Streaks link is inserted directly after Today without replacing it', () => {
  assert.match(nav, /href = 'streaks\.html'/);
  assert.match(nav, /today\.html/);
  assert.match(nav, /today\.insertAdjacentElement\('afterend', link\)/);
  assert.match(nav, /textContent = 'Streaks'/);
});

test('shared bundled guard loads the Streaks nav helper', () => {
  assert.match(guard, /streaks_nav_link\.js\?v=20260815-1/);
  assert.match(guard, /data-taskpoints-streaks-nav-link/);
});
