const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const toolbar = fs.readFileSync(path.join(__dirname, '..', 'toolbar.js'), 'utf8');
const start = toolbar.indexOf('  function revealCriticalTasksOnHome(');
const end = toolbar.indexOf('  function persistCriticalIslandNavigationIntent(', start);
assert.ok(start !== -1 && end > start, 'Critical task jump handler must be present');

function runJump({ collapsed = false, setTabAvailable = true, cardsAvailable = true } = {}) {
  const events = [];
  const callbacks = [];
  let activeTab = 'habits';
  let isCollapsed = collapsed;
  const groupBody = {
    get hidden() { return isCollapsed; },
    classList: { contains: (name) => name === 'hidden' && isCollapsed }
  };
  const group = {
    querySelector(selector) {
      if (selector === '[data-task-group-body]') return groupBody;
      if (selector === '[data-task-group-toggle]') return {
        click() {
          events.push('expand-group');
          isCollapsed = false;
        }
      };
      return null;
    }
  };
  const card = {
    getAttribute(name) { return name === 'data-task-id' ? 'critical-1' : null; },
    closest(selector) { return selector === '.task-date-group' ? group : null; },
    scrollIntoView(opts) {
      assert.equal(activeTab, 'tasks', 'Tasks panel must be visible before card scrolling');
      assert.equal(isCollapsed, false, 'Task group must be expanded');
      events.push('scroll-card:' + opts.block);
    }
  };
  const section = {
    scrollIntoView(opts) {
      assert.equal(activeTab, 'tasks', 'Tasks panel must be visible before section scrolling');
      events.push('scroll-section:' + opts.block);
    }
  };
  const context = {
    window: setTabAvailable ? {
      setHomeTab(tab) { activeTab = tab; events.push('activate:' + tab); }
    } : {},
    document: {
      querySelector(selector) {
        if (selector === '[data-home-tab="tasks"]') return {
          click() { activeTab = 'tasks'; events.push('tab-click'); }
        };
        return null;
      },
      querySelectorAll(selector) {
        assert.equal(selector, '#taskList .critical-card[data-task-id]');
        return cardsAvailable ? [card] : [];
      }
    },
    getCriticalTasksSectionTarget: () => section,
    pulseTaskCardsByIds(ids) {
      assert.deepEqual(Array.from(ids), ['critical-1']);
      events.push('pulse');
      return cardsAvailable ? 1 : 0;
    },
    getCriticalDueList: () => [{ id: 'critical-1' }],
    setTimeout(fn) { callbacks.push(fn); }
  };
  vm.runInNewContext(toolbar.slice(start, end) + '\nthis.jump = revealCriticalTasksOnHome;', context);
  context.jump(['critical-1']);
  return { events, callbacks, getTab: () => activeTab };
}

test('critical alert activates Tasks tab before highlighting and centering its due card', () => {
  const { events, getTab } = runJump();
  assert.equal(getTab(), 'tasks');
  assert.deepEqual(events, ['activate:tasks', 'scroll-card:center', 'pulse']);
});

test('critical alert opens a collapsed task group before scrolling to its task', () => {
  const { events, callbacks } = runJump({ collapsed: true });
  assert.deepEqual(events, ['activate:tasks', 'expand-group']);
  assert.equal(callbacks.length, 1);
  callbacks.shift()();
  assert.deepEqual(events, ['activate:tasks', 'expand-group', 'activate:tasks', 'scroll-card:center', 'pulse']);
});

test('critical alert can activate Tasks through the existing tab button while tab API initializes', () => {
  const { events } = runJump({ setTabAvailable: false });
  assert.deepEqual(events, ['tab-click', 'scroll-card:center', 'pulse']);
});

test('critical alert falls back to Tasks section until the matching card renders', () => {
  const { events, callbacks } = runJump({ cardsAvailable: false });
  assert.deepEqual(events, ['activate:tasks', 'scroll-section:start', 'pulse']);
  assert.equal(callbacks.length, 1);
});

test('critical island preserves same-page and cross-page navigation intent', () => {
  const handlerStart = toolbar.indexOf('  function ensureCriticalTasksIsland()');
  const handlerEnd = toolbar.indexOf('  function getCriticalDueList(', handlerStart);
  const handler = toolbar.slice(handlerStart, handlerEnd);
  assert.match(handler, /revealCriticalTasksOnHome\(matchingIds\)/);
  assert.match(handler, /persistCriticalIslandNavigationIntent\(matchingIds\)/);
  assert.match(handler, /window\.location\.href = 'index\.html'/);
  assert.match(toolbar, /consumeCriticalIslandNavigationIntent\(\)/);
});
