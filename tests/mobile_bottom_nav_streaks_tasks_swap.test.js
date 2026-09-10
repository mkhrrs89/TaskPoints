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

test('expanded mobile nav fills the next three slots with Sources, Log, then Week', () => {
  assert.match(nav, /href: 'daily_sources\.html', label: 'Sources'/);
  assert.match(nav, /href: 'log\.html', label: 'Log'/);
  assert.match(nav, /href: 'week\.html', label: 'Week'/);
  assert.match(nav, /let previous = taskDropdown/);
  assert.match(nav, /previous\.insertAdjacentElement\('afterend', shortcut\)/);
});

test('mobile header nav buttons are visually removed while their row footprint is preserved', () => {
  assert.match(nav, /\.header-nav > a\[href="index\.html"\]/);
  assert.match(nav, /\.header-nav > a\[href="daily_sources\.html"\]/);
  assert.match(nav, /\.header-nav > a\[href="log\.html"\]/);
  assert.match(nav, /\.header-nav > a\[href="week\.html"\]/);
  assert.match(nav, /\.header-nav > a\[href="season\.html"\]/);
  assert.match(nav, /visibility: hidden !important/);
  assert.match(nav, /pointer-events: none !important/);
  assert.doesNotMatch(nav, /\.header-nav[\s\S]{0,500}display:\s*none\s*!important/);
});

test('moving Tasks preserves its existing popup and actions', () => {
  assert.match(toolbar, /id="mobileTasksToggle"/);
  assert.match(toolbar, /id="mobileTasksMenu"/);
  assert.match(toolbar, /id="mobileAddTaskBtn"/);
  assert.match(toolbar, /id="mobileGoTasksBtn"/);
  assert.match(toolbar, /function setupMobileTasksMenu\(\)/);
  assert.doesNotMatch(nav, /\.remove\(\)/);
});
