from pathlib import Path
import re

CORE = Path('scoring_core.js')
INDEX = Path('index.html')
PHASE5C = Path('phase5b_deferred_mirror.js')
TEST = Path('tests/home_indexeddb_first_boot_contract.test.js')

core = CORE.read_text(encoding='utf-8')
index = INDEX.read_text(encoding='utf-8')
phase5c = PHASE5C.read_text(encoding='utf-8')
test = TEST.read_text(encoding='utf-8')

load_old = '''    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        parsed = parseTaskPointsStorageJson(raw, {}) || {};
        storageKeysFound.push(STORAGE_KEY);
      }
    } catch (e) {
      console.error("Failed to parse stored state", e);
    }'''
load_new = '''    try {
      const preloadedState = options.preloadedState;
      if (preloadedState && typeof preloadedState === 'object' && !Array.isArray(preloadedState)) {
        // A caller may provide a state object that was already verified against
        // the authoritative mirror. Continue through the ordinary normalization,
        // journal replay, pruning, repair, and wrapper pipeline without reparsing
        // the compressed localStorage payload.
        parsed = preloadedState;
        storageKeysFound.push(STORAGE_KEY);
      } else {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          parsed = parseTaskPointsStorageJson(raw, {}) || {};
          storageKeysFound.push(STORAGE_KEY);
        }
      }
    } catch (e) {
      console.error("Failed to parse stored state", e);
    }'''
if 'const preloadedState = options.preloadedState;' not in core:
    if core.count(load_old) != 1:
        raise SystemExit(f'Expected one loadAppState storage block, found {core.count(load_old)}')
    core = core.replace(load_old, load_new, 1)

native_pattern = re.compile(
    r"  if \(nativeCandidate && window\.TaskPointsCore\?\.prepareHomeNativeState\) \{.*?\n  \}\n\n  window\.__TP_HOME_BOOT_SOURCE",
    re.DOTALL,
)
native_replacement = '''  if (nativeCandidate && window.TaskPointsCore?.loadAppState) {
    if (__TP_PERF_BOOT) console.time('LOAD: IndexedDB native prepare');
    const loaded = TaskPointsCore.loadAppState({
      preloadedState: nativeCandidate,
      syncDerived: false,
      persistSync: false
    });
    if (__TP_PERF_BOOT) console.timeEnd('LOAD: IndexedDB native prepare');

    if (loaded?.state) {
      const s = normalizeState(loaded.state);
      storageCache.parsed = s;
      storageCache.raw = null;
      window.__TP_HOME_BOOT_SOURCE = 'indexeddb-native';
      if (window.TP_DEBUG_PERF) {
        const completions = Array.isArray(s?.completions) ? s.completions.length : 0;
        console.log(`[TP home boot] source=indexeddb-native completions=${completions}`, nativeBoot.recordMeta || null);
      }
      return s;
    }
  }

  window.__TP_HOME_BOOT_SOURCE'''
if 'preloadedState: nativeCandidate' not in index:
    index, replacements = native_pattern.subn(native_replacement, index, count=1)
    if replacements != 1:
        raise SystemExit(f'Expected one Home native prepare block, found {replacements}')

prepare_pattern = re.compile(
    r"\n  function prepareHomeNativeState\(sourceState\) \{.*?\n  \}\n\n  core\.PHASE5C_VERIFIED_SECONDARY_DB_NAME",
    re.DOTALL,
)
if 'function prepareHomeNativeState(sourceState)' in phase5c:
    phase5c, replacements = prepare_pattern.subn('\n  core.PHASE5C_VERIFIED_SECONDARY_DB_NAME', phase5c, count=1)
    if replacements != 1:
        raise SystemExit(f'Expected one native prepare helper, found {replacements}')
phase5c = phase5c.replace('  core.prepareHomeNativeState = prepareHomeNativeState;\n', '')

if "const scoringCore = fs.readFileSync(path.join(root, 'scoring_core.js'), 'utf8');" not in test:
    test = test.replace(
        "const phase5c = fs.readFileSync(path.join(root, 'phase5b_deferred_mirror.js'), 'utf8');",
        "const phase5c = fs.readFileSync(path.join(root, 'phase5b_deferred_mirror.js'), 'utf8');\nconst scoringCore = fs.readFileSync(path.join(root, 'scoring_core.js'), 'utf8');",
        1,
    )
test = test.replace(
    r"assert.match(home, /TaskPointsCore\.prepareHomeNativeState\(nativeCandidate/);",
    r"assert.match(home, /TaskPointsCore\.loadAppState\(\{\s*preloadedState: nativeCandidate/);",
)
test = test.replace(
    "  assert.match(phase5c, /core\\.prepareHomeNativeState = prepareHomeNativeState;/);\n  assert.match(phase5c, /core\\.readPendingHabitDeltas\\?\\.\\(\\) \\|\\| \\[\\]/);",
    "  assert.doesNotMatch(phase5c, /core\\.prepareHomeNativeState = prepareHomeNativeState;/);\n  assert.match(scoringCore, /const preloadedState = options\\.preloadedState;/);\n  assert.match(scoringCore, /parsed = preloadedState;[\\s\\S]*storageKeysFound\\.push\\(STORAGE_KEY\\);/);\n  assert.match(scoringCore, /let pendingHabitDeltas = \\[\\];[\\s\\S]*readPendingHabitDeltas\\(\\)/);",
)

CORE.write_text(core, encoding='utf-8')
INDEX.write_text(index, encoding='utf-8')
PHASE5C.write_text(phase5c, encoding='utf-8')
TEST.write_text(test, encoding='utf-8')
