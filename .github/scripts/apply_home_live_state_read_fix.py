from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one replacement target, found {count}')
    p.write_text(text.replace(old, new, 1))


# Expose the already-current Home in-memory state through a read-only-by-convention
# getter. The getter follows later `state = ...` assignments because it closes over
# the Home page's lexical state variable instead of snapshotting it.
replace_once(
    'index.html',
    """  return s;\n})();\n\n  // ---------- Derived cache (speeds up iOS renders) ----------\n""",
    """  return s;\n})();\n\nwindow.TaskPointsHomeLiveState = {\n  getState() { return state; }\n};\n\n  // ---------- Derived cache (speeds up iOS renders) ----------\n"""
)

# The recurring-task decorator reruns after task-list DOM mutations. Prefer the
# live Home state so a UI-only rerender does not decode/repair/clone the entire
# saved app state. Keep the existing journal-aware core load as a fallback.
replace_once(
    'home_season_slate_long_quiet.js',
    """  let installAttempts = 0;\n  let refreshFrame = 0;\n  let midnightTimer = 0;\n  let lastDecoratedCount = -1;\n""",
    """  let installAttempts = 0;\n  let refreshFrame = 0;\n  let midnightTimer = 0;\n  let lastDecoratedCount = -1;\n  let liveStateReads = 0;\n  let fallbackStateReads = 0;\n"""
)

replace_once(
    'home_season_slate_long_quiet.js',
    """  function loadJournalAwareState() {\n    try {\n      const loaded = core.loadAppState?.({ syncDerived: false, persistSync: false });\n      if (loaded?.state && typeof loaded.state === 'object') return loaded.state;\n      if (loaded && typeof loaded === 'object') return loaded;\n    } catch (_) {}\n    return null;\n  }\n""",
    """  function loadJournalAwareState() {\n    try {\n      const live = global.TaskPointsHomeLiveState?.getState?.();\n      if (live && typeof live === 'object') {\n        liveStateReads += 1;\n        return live;\n      }\n    } catch (_) {}\n\n    fallbackStateReads += 1;\n    try {\n      const loaded = core.loadAppState?.({ syncDerived: false, persistSync: false });\n      if (loaded?.state && typeof loaded.state === 'object') return loaded.state;\n      if (loaded && typeof loaded === 'object') return loaded;\n    } catch (_) {}\n    return null;\n  }\n"""
)

replace_once(
    'home_season_slate_long_quiet.js',
    """    global.TaskPointsRecurringTaskDoneTodayUi = {\n      installed: true,\n      refresh: scheduleRefresh,\n      observer,\n      get decoratedCount() { return Math.max(0, lastDecoratedCount); }\n    };\n""",
    """    global.TaskPointsRecurringTaskDoneTodayUi = {\n      installed: true,\n      refresh: scheduleRefresh,\n      observer,\n      get decoratedCount() { return Math.max(0, lastDecoratedCount); },\n      get liveStateReads() { return liveStateReads; },\n      get fallbackStateReads() { return fallbackStateReads; }\n    };\n"""
)

# The featured matchup helper is another render-time reader. Use the same live
# Home state first, with the old persisted read path retained as fallback.
replace_once(
    'home_featured_matchup_visibility.js',
    """  let observer = null;\n  let observedMount = null;\n  let renderScheduled = false;\n""",
    """  let observer = null;\n  let observedMount = null;\n  let renderScheduled = false;\n  let liveStateReads = 0;\n  let fallbackStateReads = 0;\n"""
)

replace_once(
    'home_featured_matchup_visibility.js',
    """  function loadState() {\n    const core = global.TaskPointsCore;\n    try {\n      if (typeof core?.loadAppState === 'function') {\n        const loaded = core.loadAppState({ syncDerived: false, persistSync: false });\n        return loaded?.state || loaded || {};\n      }\n      if (typeof core?.readTaskPointsStoredState === 'function') {\n        return core.readTaskPointsStoredState(core.STORAGE_KEY || 'taskpoints_v1', {}) || {};\n      }\n    } catch (error) {\n      console.warn('Home featured matchup state could not be loaded', error);\n    }\n    return {};\n  }\n""",
    """  function loadState() {\n    const core = global.TaskPointsCore;\n    try {\n      const live = global.TaskPointsHomeLiveState?.getState?.();\n      if (live && typeof live === 'object') {\n        liveStateReads += 1;\n        return live;\n      }\n    } catch (_) {}\n\n    fallbackStateReads += 1;\n    try {\n      if (typeof core?.loadAppState === 'function') {\n        const loaded = core.loadAppState({ syncDerived: false, persistSync: false });\n        return loaded?.state || loaded || {};\n      }\n      if (typeof core?.readTaskPointsStoredState === 'function') {\n        return core.readTaskPointsStoredState(core.STORAGE_KEY || 'taskpoints_v1', {}) || {};\n      }\n    } catch (error) {\n      console.warn('Home featured matchup state could not be loaded', error);\n    }\n    return {};\n  }\n"""
)

replace_once(
    'home_featured_matchup_visibility.js',
    """    renderCurrentSeriesBestOf,\n    render: renderHomeFeaturedMatchup,\n    install\n  };\n""",
    """    renderCurrentSeriesBestOf,\n    render: renderHomeFeaturedMatchup,\n    install,\n    get liveStateReads() { return liveStateReads; },\n    get fallbackStateReads() { return fallbackStateReads; }\n  };\n"""
)

# Cache-bust both independently loaded Home helpers so existing iPhone sessions
# cannot keep the pre-fix helper code under the old long-lived query key.
replace_once(
    'phase4_diagnostics.js',
    "/home_season_slate_long_quiet.js?v=20260820-1",
    "/home_season_slate_long_quiet.js?v=20260915-1"
)
replace_once(
    'inbox_count_badge.js',
    "/home_featured_matchup_visibility.js?v=20260807-1",
    "/home_featured_matchup_visibility.js?v=20260915-1"
)

# Update source-level contracts for the new cache-bust versions and live-state
# preference while keeping the persisted-state fallback explicitly covered.
replace_once(
    'tests/home_season_slate_long_quiet_contract.test.js',
    r"home_season_slate_long_quiet\.js\?v=20260820-1",
    r"home_season_slate_long_quiet\.js\?v=20260915-1"
)
replace_once(
    'tests/diagnostics_asset_cache_versions.test.js',
    r"/\/home_featured_matchup_visibility\.js\?v=20260807-1/",
    r"/\/home_featured_matchup_visibility\.js\?v=20260915-1/"
)

replace_once(
    'tests/recurring_task_done_today_ui_contract.test.js',
    """test('done-today UI reads journal-aware state without derived-state persistence', () => {\n  assert.match(source, /core\\.loadAppState\\?\\.\\(\\{ syncDerived: false, persistSync: false \\}\\)/);\n});\n""",
    """test('done-today UI prefers live Home state and retains journal-aware persisted fallback', () => {\n  assert.match(source, /global\\.TaskPointsHomeLiveState\\?\\.getState\\?\\.\\(\\)/);\n  assert.match(source, /core\\.loadAppState\\?\\.\\(\\{ syncDerived: false, persistSync: false \\}\\)/);\n  assert.match(source, /liveStateReads \+= 1/);\n  assert.match(source, /fallbackStateReads \+= 1/);\n});\n"""
)

# Make the existing featured-hotpath harness provide a live Home state and prove
# repeated UI renders no longer call the heavyweight core loader.
p = Path('tests/step3c_home_read_hotpath.test.js')
text = p.read_text()
old = """  const core = {\n    STORAGE_KEY: 'taskpoints_v1',\n    loadAppState(options) {\n      loadCalls += 1;\n      assert.equal(options?.syncDerived, false);\n      assert.equal(options?.persistSync, false);\n      return {\n        state: {\n          currentSeason: { status: 'active', series: {} },\n          matchups: []\n        }\n      };\n    },\n"""
new = """  const liveState = {\n    currentSeason: { status: 'active', series: {} },\n    matchups: []\n  };\n\n  const core = {\n    STORAGE_KEY: 'taskpoints_v1',\n    loadAppState(options) {\n      loadCalls += 1;\n      assert.equal(options?.syncDerived, false);\n      assert.equal(options?.persistSync, false);\n      return { state: liveState };\n    },\n"""
if text.count(old) != 1:
    raise SystemExit('step3c: core harness target missing')
text = text.replace(old, new, 1)
old = """  const context = {\n    TaskPointsCore: core,\n    document,\n"""
new = """  const context = {\n    TaskPointsCore: core,\n    TaskPointsHomeLiveState: { getState() { return liveState; } },\n    document,\n"""
if text.count(old) != 1:
    raise SystemExit('step3c: context target missing')
text = text.replace(old, new, 1)
text = text.replace("assert.equal(harness.loadCalls, 1, 'initial install should load state once');", "assert.equal(harness.loadCalls, 0, 'initial install should use the live Home state without a full-state load');", 1)
text = text.replace("assert.equal(harness.loadCalls, 2);", "assert.equal(harness.loadCalls, 0, 'direct rerenders should keep using the live Home state');", 1)
text = text.replace("assert.equal(harness.loadCalls, 3, 'external mutation should cause exactly one state-backed rerender');", "assert.equal(harness.loadCalls, 0, 'external mutation should rerender from live Home state without a core load');", 1)
p.write_text(text)

# Add a direct contract for the bridge itself.
p = Path('tests/home_live_state_bridge_contract.test.js')
p.write_text(r'''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const home = fs.readFileSync('index.html', 'utf8');
const recurring = fs.readFileSync('home_season_slate_long_quiet.js', 'utf8');
const featured = fs.readFileSync('home_featured_matchup_visibility.js', 'utf8');

test('Home exposes its current lexical state through a lightweight getter', () => {
  assert.match(home, /window\.TaskPointsHomeLiveState\s*=\s*\{\s*getState\(\) \{ return state; \}\s*\};/s);
});

test('Home UI-only decorators prefer live state before persisted-state fallbacks', () => {
  assert.match(recurring, /TaskPointsHomeLiveState\?\.getState\?\.\(\)/);
  assert.match(featured, /TaskPointsHomeLiveState\?\.getState\?\.\(\)/);
  assert.match(recurring, /core\.loadAppState\?\.\(\{ syncDerived: false, persistSync: false \}\)/);
  assert.match(featured, /core\.loadAppState\(\{ syncDerived: false, persistSync: false \}\)/);
});
''')
