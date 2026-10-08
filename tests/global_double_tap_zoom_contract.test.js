const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const taskFastPath = fs.readFileSync(path.join(__dirname, '..', 'task_create_fast_path.js'), 'utf8');

test('app root disables double-tap zoom without disabling pinch zoom', () => {
  assert.match(styles, /html,\s*\nbody\{[\s\S]*?touch-action:\s*manipulation;/);
  assert.match(taskFastPath, /maximum-scale=5/);
  assert.match(taskFastPath, /user-scalable=yes/);
});

test('specialized gesture surfaces can keep their more specific touch-action behavior', () => {
  assert.match(styles, /touch-action:\s*none !important;/);
});
