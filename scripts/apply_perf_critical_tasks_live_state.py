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

contract = Path("tests/home_targeted_render_contract.test.js")
text = contract.read_text()
text = replace_once(
    text,
    """  assert.match(controllerSource, /global\\.renderTasks\\s*\\(\\s*\\)/);
""",
    """  assert.match(controllerSource, /TaskPointsHomeLiveState\\?\\.getState/);
  assert.match(controllerSource, /global\\.renderTasks\\(liveState && typeof liveState === 'object' \\? liveState : null\\)/);
""",
    "targeted render static contract",
)
text = replace_once(
    text,
    """test('controller loader is Home-only and preserves original rendering if loading fails', () => {
  assert.match(loaderSource, /home_targeted_render_control\\.js\\?v=20260802-1/);
  assert.match(loaderSource, /path\\s*!==\\s*'\\/'/);
  assert.match(loaderSource, /original rendering remains active/);
});
""",
    """test('controller preserves original rendering as its fallback and retains a kill switch', () => {
  assert.match(controllerSource, /originals\\.renderAll\\.call\\(global\\)/);
  assert.match(controllerSource, /taskpoints_home_targeted_render_disabled_v1/);
  assert.match(controllerSource, /function disable\\s*\\(/);
  assert.match(loaderSource, /taskpoints_habit_fast_path_disabled_v1/);
});
""",
    "stale targeted-render loader contract",
)
contract.write_text(text)
