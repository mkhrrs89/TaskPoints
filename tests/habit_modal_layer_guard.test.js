const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'home_rank_percentile_line.js'), 'utf8');

test('Create Habit modal stays above floating home controls', () => {
  assert.match(source, /installTaskPointsHabitModalLayerGuard/);
  assert.match(source, /#addHabitModal\s*\{[\s\S]*?z-index:\s*1000000\s*!important;/);
});
