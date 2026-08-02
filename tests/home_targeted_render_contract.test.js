const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const controllerSource = fs.readFileSync(path.join(root, 'home_targeted_render_control.js'), 'utf8');
const loaderSource = fs.readFileSync(path.join(root, 'habit_fast_path_control.js'), 'utf8');

function functionBlock(source, functionName, nextMarker) {
  const start = source.indexOf(`function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} must exist`);
  const end = source.indexOf(nextMarker, start);
  assert.notEqual(end, -1, `${functionName} end marker must exist`);
  return source.slice(start, end);
}

test('task completion keeps existing mutation and save logic while controller replaces only its broad render', () => {
  const block = functionBlock(indexSource, 'completeTask', '\n\n\nfunction editTask');
  assert.match(block, /addCompletion\s*\(/);
  assert.match(block, /computeNextDueDate\s*\(/);
  assert.match(block, /removeTaskFromTodayView\s*\(/);
  assert.match(block, /\bsave\s*\(\s*\)/);
  assert.match(block, /scheduleRender\s*\(\s*renderAll\s*\)/);

  assert.match(controllerSource, /taskCompletionCallbackDepth\s*>\s*0/);
  assert.match(controllerSource, /callback\s*===\s*originals\.renderAll/);
  assert.match(controllerSource, /global\.renderTasks\s*\(\s*\)/);
  assert.match(controllerSource, /originals\.renderAll\.call\(global\)/);
});

test('habit immediate paint and journal path remain owned by Home code', () => {
  const start = indexSource.indexOf('function handleHabitBubbleTap');
  const end = indexSource.indexOf('\n\n\n/* ---------- FLEX ACTIONS ---------- */', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = indexSource.slice(start, end);

  const journal = block.indexOf('TaskPointsCore.writePendingHabitDelta');
  const bubblePaint = block.indexOf('applyCanonicalHabitBubbleVisual');
  const deferredSave = block.indexOf('scheduleHabitSave();');
  assert.ok(journal >= 0 && bubblePaint > journal, 'journal must precede bubble paint');
  assert.ok(deferredSave > bubblePaint, 'full save remains deferred until after immediate paint');
  assert.match(controllerSource, /pendingHabitCategories/);
  assert.match(controllerSource, /global\.renderHabits\s*\(\s*\)/);
  assert.match(controllerSource, /global\.renderVices\s*\(\s*\)/);
});

test('expensive stats remain available as a delayed canonical reconciliation and emergency fallback', () => {
  assert.match(controllerSource, /canonicalStatsDelayMs:\s*6500/);
  assert.match(controllerSource, /requestIdleCallback/);
  assert.match(controllerSource, /originals\.renderStats/);
  assert.match(controllerSource, /function disable\s*\(/);
  assert.match(controllerSource, /taskpoints_home_targeted_render_disabled_v1/);
});

test('normal task creation remains targeted and does not use renderAll', () => {
  const block = functionBlock(indexSource, 'addTask', '\n\n\nfunction setDueToday');
  assert.match(block, /state\.tasks\.unshift\s*\(/);
  assert.match(block, /\bsave\s*\(\s*\)/);
  assert.match(block, /renderTasks\s*\(\s*\)/);
  assert.doesNotMatch(block, /renderAll/);
});

test('controller loader is Home-only and preserves original rendering if loading fails', () => {
  assert.match(loaderSource, /home_targeted_render_control\.js\?v=20260802-1/);
  assert.match(loaderSource, /path\s*!==\s*'\/'/);
  assert.match(loaderSource, /original rendering remains active/);
});
