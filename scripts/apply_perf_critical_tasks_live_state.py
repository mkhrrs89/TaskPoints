from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one target, found {count}")
    return text.replace(old, new, 1)


toolbar = Path("toolbar.js")
text = toolbar.read_text()
text = replace_once(
    text,
    """    updateCriticalTasksIsland();
    let criticalRefreshQueued = false;
    const queueCriticalRefresh = () => {
""",
    """    const updateCriticalTasksIslandFromBestState = () => {
      let liveState = null;
      try { liveState = window.TaskPointsHomeLiveState?.getState?.() || null; } catch (_) {}
      if (liveState && typeof liveState === 'object') {
        return updateCriticalTasksIsland(liveState);
      }
      return updateCriticalTasksIsland();
    };

    updateCriticalTasksIslandFromBestState();
    let criticalRefreshQueued = false;
    const queueCriticalRefresh = () => {
""",
    "Critical Tasks initial refresh",
)
text = replace_once(
    text,
    """      requestAnimationFrame(() => {
        criticalRefreshQueued = false;
        updateCriticalTasksIsland();
      });
""",
    """      requestAnimationFrame(() => {
        criticalRefreshQueued = false;
        updateCriticalTasksIslandFromBestState();
      });
""",
    "Critical Tasks queued refresh",
)
toolbar.write_text(text)

targeted = Path("home_targeted_render_control.js")
text = targeted.read_text()
text = replace_once(
    text,
    """          global.renderTasks();
          global.updateCriticalTasksIsland?.();
""",
    """          const liveState = global.TaskPointsHomeLiveState?.getState?.();
          global.renderTasks(liveState && typeof liveState === 'object' ? liveState : null);
""",
    "targeted task refresh",
)
targeted.write_text(text)

testfile = Path("tests/home_targeted_render_control.test.js")
text = testfile.read_text()
text = replace_once(
    text,
    """    criticalIsland: 0
  };

  const context = {
""",
    """    criticalIsland: 0,
    lastRenderTasksState: null
  };
  const homeLiveState = { tasks: [{ id: 'task-1' }] };

  const context = {
""",
    "targeted test calls state",
)
text = replace_once(
    text,
    """    renderTasks: () => { calls.renderTasks += 1; },
    updateCriticalTasksIsland: () => { calls.criticalIsland += 1; },
""",
    """    TaskPointsHomeLiveState: { getState: () => homeLiveState },
    renderTasks: (stateInput = null) => {
      calls.renderTasks += 1;
      calls.lastRenderTasksState = stateInput;
      if (stateInput) calls.criticalIsland += 1;
    },
    updateCriticalTasksIsland: () => { calls.criticalIsland += 1; },
""",
    "targeted test render mock",
)
text = replace_once(
    text,
    """  assert.equal(calls.renderTasks, 1);
  assert.equal(calls.renderToday, 1);
  assert.equal(calls.renderAll, 0);
  assert.equal(calls.criticalIsland, 1);
""",
    """  assert.equal(calls.renderTasks, 1);
  assert.equal(calls.renderToday, 1);
  assert.equal(calls.renderAll, 0);
  assert.equal(calls.criticalIsland, 1);
  assert.deepEqual(calls.lastRenderTasksState, { tasks: [{ id: 'task-1' }] });
""",
    "targeted test assertion",
)
testfile.write_text(text)

Path("tests/critical_tasks_home_live_state_contract.test.js").write_text(r'''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const toolbar = fs.readFileSync('toolbar.js', 'utf8');
const targeted = fs.readFileSync('home_targeted_render_control.js', 'utf8');

function between(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `missing ${endNeedle}`);
  return source.slice(start, end);
}

test('Critical Tasks queued Home refresh prefers live state and preserves stored fallback', () => {
  const body = between(toolbar, 'function ensureCriticalTasksIsland', 'function getCriticalDueList');
  assert.match(body, /TaskPointsHomeLiveState\?\.getState\?\.\(\)/);
  assert.match(body, /updateCriticalTasksIsland\(liveState\)/);
  assert.match(body, /return updateCriticalTasksIsland\(\)/);
  assert.match(body, /updateCriticalTasksIslandFromBestState\(\)/);
});

test('targeted task refresh passes live Home state through renderTasks without a second island call', () => {
  assert.match(targeted, /TaskPointsHomeLiveState\?\.getState\?\.\(\)/);
  assert.match(targeted, /global\.renderTasks\(liveState && typeof liveState === 'object' \? liveState : null\)/);
  const start = targeted.indexOf('function targetedScheduleRender');
  const end = targeted.indexOf('function targetedAnimateTaskCompletion', start);
  const body = targeted.slice(start, end);
  assert.doesNotMatch(body, /global\.updateCriticalTasksIsland/);
});
''')
