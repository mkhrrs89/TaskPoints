from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 target, found {count}')
    p.write_text(text.replace(old, new, 1))


# Let the critical-task island consume a current in-memory state when the caller
# has one, while preserving its canonical storage fallback for all other callers.
replace_once(
    'toolbar.js',
    """  function getCriticalDueList() {\n    const state = loadRawStateFallback();""",
    """  function getCriticalDueList(stateInput = null) {\n    const hasProvidedState = Boolean(\n      stateInput && typeof stateInput === 'object' && Array.isArray(stateInput.tasks)\n    );\n    const resolveStartedAt = window.performance?.now?.() ?? 0;\n    const state = hasProvidedState ? stateInput : loadRawStateFallback();\n    try {\n      const endedAt = window.performance?.now?.() ?? resolveStartedAt;\n      window.TaskPointsPerf?.mark?.('criticalTasksIsland.stateResolved', {\n        source: hasProvidedState ? 'provided-state' : 'stored-state',\n        durationMs: Math.round((endedAt - resolveStartedAt) * 100) / 100\n      });\n    } catch (_) {}""",
    'critical list state handoff'
)
replace_once(
    'toolbar.js',
    """  function updateCriticalTasksIsland() {\n    const island = document.getElementById('criticalTasksIsland');""",
    """  function updateCriticalTasksIsland(stateInput = null) {\n    const island = document.getElementById('criticalTasksIsland');""",
    'critical island optional state argument'
)
replace_once(
    'toolbar.js',
    """    const list = getCriticalDueList();""",
    """    const list = getCriticalDueList(stateInput);""",
    'critical island forwards state argument'
)

# The three Step 5E interaction fast paths already hold the authoritative
# in-memory Home state. Hand it directly to the island instead of reparsing the
# entire stored application snapshot immediately after the tap.
replace_once(
    'index.html',
    """  persistTaskActionMutation(t, 'bump-one-day');\n  renderTasks();\n  window.updateCriticalTasksIsland?.();""",
    """  persistTaskActionMutation(t, 'bump-one-day');\n  renderTasks();\n  window.updateCriticalTasksIsland?.(state);""",
    '+1 day critical island state handoff'
)
replace_once(
    'index.html',
    """  persistTaskActionMutation(t, 'wont-do');\n  renderTasks();\n  window.updateCriticalTasksIsland?.();""",
    """  persistTaskActionMutation(t, 'wont-do');\n  renderTasks();\n  window.updateCriticalTasksIsland?.(state);""",
    "Won't Do critical island state handoff"
)
replace_once(
    'index.html',
    """  persistTaskActionMutation(t, 'edit-save');\n  renderTasks();\n  window.updateCriticalTasksIsland?.();""",
    """  persistTaskActionMutation(t, 'edit-save');\n  renderTasks();\n  window.updateCriticalTasksIsland?.(state);""",
    'Edit Save critical island state handoff'
)

Path('tests/step5f_critical_tasks_state_handoff.test.js').write_text(r'''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const toolbar = fs.readFileSync('toolbar.js', 'utf8');
const home = fs.readFileSync('index.html', 'utf8');

function between(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `missing ${endNeedle}`);
  return source.slice(start, end);
}

test('critical task list accepts a task-bearing state and preserves stored-state fallback', () => {
  const body = between(toolbar, 'function getCriticalDueList', 'function updateCriticalTasksIsland');
  assert.match(body, /Array\.isArray\(stateInput\.tasks\)/);
  assert.match(body, /hasProvidedState \? stateInput : loadRawStateFallback\(\)/);
  assert.match(body, /criticalTasksIsland\.stateResolved/);
  assert.match(body, /provided-state/);
  assert.match(body, /stored-state/);
});

test('critical island forwards only validated optional state to its list builder', () => {
  const body = between(toolbar, 'function updateCriticalTasksIsland', 'window.tpUpdateCriticalIsland');
  assert.match(body, /function updateCriticalTasksIsland\(stateInput = null\)/);
  assert.match(body, /getCriticalDueList\(stateInput\)/);
});

test('Edit Save hands current Home state to the critical island', () => {
  const body = between(home, 'function saveTaskEdit', 'function hideTask');
  assert.match(body, /persistTaskActionMutation\(t, 'edit-save'\)/);
  assert.match(body, /updateCriticalTasksIsland\?\.\(state\)/);
});

test('+1 Day hands current Home state to the critical island', () => {
  const body = between(home, 'function bumpTaskOneDay', 'function applyPostponeToTask');
  assert.match(body, /persistTaskActionMutation\(t, 'bump-one-day'\)/);
  assert.match(body, /updateCriticalTasksIsland\?\.\(state\)/);
});

test("Won't Do hands current Home state to the critical island", () => {
  const body = between(home, 'function wontDoMain', 'function prefersReducedTaskMotion');
  assert.match(body, /persistTaskActionMutation\(t, 'wont-do'\)/);
  assert.match(body, /updateCriticalTasksIsland\?\.\(state\)/);
});
''')
