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

test('Old upper navigation is removed from mobile layout before first paint', () => {
  const toolbar = fs.readFileSync(path.join(ROOT, 'toolbar.js'), 'utf8');
  assert.match(styles, /@media \\(max-width: 767px\\)\\s*\\{\\s*header \\.header-nav\\s*\\{\\s*display: none !important;/);
  assert.match(toolbar, /function syncRetiredMobileHeaderNavigation\\(\\)/);
  assert.match(toolbar, /document\\.querySelectorAll\\('header \\.header-nav'\\)/);
  assert.match(toolbar, /replaceChild\\(placeholder, nav\\)/);
  assert.match(toolbar, /placeholder\\.replaceWith\\(nav\\)/);
  assert.match(toolbar, /syncRetiredMobileHeaderNavigation\\(\\);\\s*const mobileHeaderQuery/);
  assert.doesNotMatch(nav, /visibility: hidden !important|HEADER_SPACER_STYLE_ID/);
  for (const page of ['index.html', 'settings.html', 'audit.html', 'projects.html']) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.match(html, /href="styles\\.css"/, page + ' loads the pre-paint rule');
    assert.match(html, /class="[^"]*header-nav/, page + ' retains desktop navigation');
  }
});

test('Mobile nav detaches and desktop resize restores the same header node', () => {
  const toolbar = fs.readFileSync(path.join(ROOT, 'toolbar.js'), 'utf8');
  const begin = toolbar.indexOf('const detachedMobileHeaderNavs = [];');
  const end = toolbar.indexOf("document.addEventListener('DOMContentLoaded', () => {", begin);
  assert.ok(begin >= 0 && end > begin, 'shared header navigation lifecycle exists');
  const snippet = toolbar.slice(begin, end);
  const vm = require('node:vm');
  let mobile = true;
  let connected = true;
  const parent = {
    replaceChild(placeholder, nav) {
      assert.equal(connected, true);
      connected = false;
      nav.parentNode = null;
      placeholder.isConnected = true;
    }
  };
  const original = { parentNode: parent };
  const doc = {
    querySelectorAll(selector) {
      assert.equal(selector, 'header .header-nav');
      return connected ? [original] : [];
    },
    createComment() {
      return {
        isConnected: false,
        replaceWith(nav) {
          nav.parentNode = parent;
          connected = true;
          this.isConnected = false;
        }
      };
    }
  };
  const context = { window: { matchMedia: () => ({ matches: mobile }) }, document: doc };
  vm.runInNewContext(snippet + ';this.sync = syncRetiredMobileHeaderNavigation;', context);
  context.sync();
  assert.equal(connected, false, 'mobile removes header from DOM');
  context.sync();
  assert.equal(connected, false, 'repeat mobile sync remains idempotent');
  mobile = false;
  context.sync();
  assert.equal(connected, true, 'desktop restores exact same header node');
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


test('Gold Ledger is a permanent, nonduplicating Game dropdown shortcut on mobile and desktop', () => {
  const home = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const game = fs.readFileSync(path.join(ROOT, 'game.html'), 'utf8');
  const mobileMenu = section(toolbar, '<div class="dropdown-menu">', '</div>');
  for (const [name, content] of [['mobile', mobileMenu], ['Home desktop', home], ['Players desktop', game]]) {
    assert.match(content, /href="game_ratings\.html"[\s\S]*?href="gold_ledger\.html"[\s\S]*?href="records\.html"|href="game_ratings\.html"[\s\S]*?href="gold_ledger\.html"/,
      name + ' menu keeps Gold Ledger after Ratings');
  }
  assert.equal((mobileMenu.match(/href="gold_ledger\.html"/g) || []).length, 1,
    'mobile toolbar template includes exactly one Gold Ledger shortcut');
  assert.match(toolbar, /function ensureGoldLedgerGameMenuLink\(menu\)/);
  assert.match(toolbar, /menu\.querySelector\('a\[href="gold_ledger\.html"\]'\)/,
    'shared dropdown setup must avoid a duplicate if the Gold runtime already inserted the link');
  assert.match(toolbar, /ensureGoldLedgerGameMenuLink\(menu\)/);
});
