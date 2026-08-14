const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const toolbar = fs.readFileSync('toolbar.js', 'utf8');

function between(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `missing ${endNeedle}`);
  return source.slice(start, end);
}

test('resize updates Critical Tasks layout without rebuilding its task list', () => {
  const body = between(toolbar, 'function updateCritIslandStacking', 'const scrollButtons');
  assert.match(body, /addEventListener\('resize', updateCritIslandStacking/);
  assert.doesNotMatch(body, /addEventListener\('resize', updateCriticalTasksIsland/);
});

test('task-data refreshes remain wired to storage and lifecycle changes', () => {
  const body = between(toolbar, 'function ensureCriticalTasksIsland', 'function getCriticalDueList');
  assert.match(body, /addEventListener\('storage'/);
  assert.match(body, /tp:local-storage-change/);
  assert.match(body, /addEventListener\('pageshow', queueCriticalRefresh\)/);
  assert.match(body, /visibilitychange/);
  assert.match(body, /updateCriticalTasksIsland\(\)/);
});
