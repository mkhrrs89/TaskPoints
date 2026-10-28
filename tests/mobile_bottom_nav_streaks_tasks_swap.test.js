const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const nav = fs.readFileSync(path.join(ROOT, 'streaks_nav_link.js'), 'utf8');
const toolbar = fs.readFileSync(path.join(ROOT, 'toolbar.js'), 'utf8');
const styles = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');

function section(source, from, to) {
  const a = source.indexOf(from);
  const b = source.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `Missing section: ${from}`);
  return source.slice(a, b);
}

test('Main toolbar no longer renders Tasks button or its Add a Task / Go To Tasks submenu', () => {
  const topRow = section(toolbar, 'function buildMobileBottomNavLinks() {', 'function ensureBottomToolbarMount() {');
  assert.doesNotMatch(topRow, /mobileTasksToggle|mobileTasksMenu|mobileAddTaskBtn|mobileGoTasksBtn/);
  assert.doesNotMatch(topRow, /mobile-task-dropdown|mobile-task-toggle|mobile-task-menu/);
  assert.doesNotMatch(topRow, />Tasks<|>Add a Task<|>Go To Tasks</);
  assert.doesNotMatch(toolbar, /setupMobileTasksMenu|__tpTasksMenuPointerListener|__tpTasksMenuResizeListener/);
});

test('Primary row still contains Home, Inbox, Game and Settings, with Streaks inserted after Inbox', () => {
  const topRow = section(toolbar, 'function buildMobileBottomNavLinks() {', 'function ensureBottomToolbarMount() {');
  for (const page of ['index.html', 'inbox.html', 'gamehub.html', 'settings.html']) {
    assert.match(topRow, new RegExp(page.replace('.', '\\.') ));
  }
  assert.match(nav, /href = 'streaks\.html'/);
  assert.match(nav, /textContent = 'Streaks'/);
  assert.match(nav, /inbox\.insertAdjacentElement\('afterend', link\)/);
  assert.doesNotMatch(nav, /taskDropdown|mobile-task-dropdown/);
});

test('Expanded shortcuts follow Today directly: Sources, Log, Week', () => {
  assert.match(nav, /href === 'today\.html'/);
  assert.match(nav, /let previous = today/);
  assert.match(nav, /href: 'daily_sources\.html', label: 'Sources'/);
  assert.match(nav, /href: 'log\.html', label: 'Log'/);
  assert.match(nav, /href: 'week\.html', label: 'Week'/);
  assert.match(nav, /previous\.insertAdjacentElement\('afterend', shortcut\)/);
  assert.match(styles, /\.mobile-bottom-nav-secondary\s*\{[^}]*grid-template-columns:\s*repeat\(5/);
});

test('All existing expanded toolbar destinations remain intact', () => {
  const expanded = section(toolbar, '<div class="mobile-bottom-nav-expanded">', '</nav>');
  for (const href of ['projects.html', 'notes.html', 'achievements.html', 'skills.html',
    'tournament.html', 'season.html', 'today.html']) {
    assert.ok(expanded.includes('href="' + href + '"'), `Missing existing expanded shortcut: ${href}`);
  }
  assert.match(nav, /EXPANDED_SHORTCUTS\.map/);
});

test('Game popup and its animation remain functional', () => {
  assert.match(toolbar, /data-dropdown-toggle/);
  assert.match(toolbar, /class="dropdown-menu"/);
  assert.match(toolbar, /setupDropdowns\(nav\)/);
  assert.match(toolbar, /setupPopupMenuPressAnimation\(\)/);
  assert.match(toolbar, /const selector = '\.mobile-bottom-dropdown \.dropdown-menu \.btn'/);
  assert.match(styles, /\.mobile-bottom-dropdown \.dropdown-menu\s*\{/);
  assert.doesNotMatch(styles, /\.mobile-task-menu|\.mobile-task-dropdown|\.mobile-task-toggle/);
});

test('Shared mobile drag expansion, press effects and toolbar height remain installed', () => {
  assert.match(toolbar, /setupBottomNavPressAnimation\(nav\)/);
  assert.match(toolbar, /setupBottomNavDragExpand\(nav\)/);
  assert.match(toolbar, /setupToolbarStackHeightTracking\(nav\)/);
  assert.match(toolbar, /function setupBottomNavDragExpand\(nav\)/);
  assert.match(toolbar, /if \(event\.target\.closest\('\.dropdown-menu'\)\) return/);
  assert.doesNotMatch(toolbar, /mobileTasksMenu/);
});

test('Mobile header buttons remain visually hidden without collapsing the row', () => {
  assert.match(nav, /\.header-nav > a\[href="index\.html"\]/);
  assert.match(nav, /\.header-nav > a\[href="daily_sources\.html"\]/);
  assert.match(nav, /\.header-nav > a\[href="log\.html"\]/);
  assert.match(nav, /\.header-nav > a\[href="week\.html"\]/);
  assert.match(nav, /\.header-nav > a\[href="season\.html"\]/);
  assert.match(nav, /visibility: hidden !important/);
  assert.match(nav, /pointer-events: none !important/);
  assert.doesNotMatch(nav, /\.header-nav[\s\S]{0,500}display:\s*none\s*!important/);
});

test('Bottom menu motion remains composited and avoids filtered shell animation', () => {
  assert.match(nav, /MOTION_STYLE_ID = 'taskpoints-mobile-bottom-nav-motion-style'/);
  assert.match(nav, /will-change: height, transform/);
  assert.match(nav, /filter: none !important/);
  assert.match(nav, /box-shadow: 0 -3px 10px rgba\(0, 0, 0, 0\.16\)/);
  assert.match(nav, /transform: translate3d\(0, 10px, 0\)/);
  assert.match(nav, /transform: translate3d\(0, 0, 0\)/);
  assert.match(nav, /cubic-bezier\(0\.22, 1, 0\.36, 1\)/);
  assert.match(nav, /\.mobile-bottom-nav-shell\.is-dragging[\s\S]*transition: none !important/);
});

test('Task editing and adding features outside the retired toolbar are unaffected', () => {
  const home = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(home, /function openAddTaskModal\(\)/);
  assert.match(home, /function scrollToTasks\(\)/);
  assert.match(home, /id="homeTabTasks"/);
  assert.match(home, /id="homePanelTasks"/);
  assert.match(styles, /#mobileAddTaskFab/);
});
