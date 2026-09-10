const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const nav = fs.readFileSync(path.join(ROOT, 'streaks_nav_link.js'), 'utf8');
const toolbar = fs.readFileSync(path.join(ROOT, 'toolbar.js'), 'utf8');

test('Streaks takes the primary slot vacated by Tasks', () => {
  assert.match(nav, /const taskDropdown = nav\.querySelector\('\.mobile-task-dropdown'\)/);
  assert.match(nav, /taskDropdown\.insertAdjacentElement\('beforebegin', link\)/);
  assert.match(nav, /href = 'streaks\.html'/);
  assert.match(nav, /textContent = 'Streaks'/);
});

test('Tasks moves to Streaks former expanded position immediately after Today', () => {
  assert.match(nav, /href === 'today\.html'/);
  assert.match(nav, /today\.insertAdjacentElement\('afterend', taskDropdown\)/);
  assert.match(nav, /taskDropdown\.parentElement === secondary/);
  assert.match(nav, /taskDropdown\.previousElementSibling === today/);
});

test('moving Tasks preserves its existing popup and actions', () => {
  assert.match(toolbar, /id="mobileTasksToggle"/);
  assert.match(toolbar, /id="mobileTasksMenu"/);
  assert.match(toolbar, /id="mobileAddTaskBtn"/);
  assert.match(toolbar, /id="mobileGoTasksBtn"/);
  assert.match(toolbar, /function setupMobileTasksMenu\(\)/);
  assert.doesNotMatch(nav, /\.remove\(\)/);
});
