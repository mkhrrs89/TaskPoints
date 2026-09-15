from pathlib import Path

path = Path('tests/phase5c_cross_tab_contract.test.js')
text = path.read_text()
text = text.replace(
    r"/function promoteCandidate\(db, candidate, raw, verifiedAtISO\)/",
    r"/function promoteCandidate\(db, candidate, raw, verifiedAtISO, nativeRecord\)/",
    1,
)
text = text.replace(
    r"/if \(event\.newValue && get\(KEY\) === event\.newValue\)/",
    r"/if \(event\?\.key === KEY && event\.newValue && get\(KEY\) === event\.newValue\) queue\(event\.newValue\)/",
    1,
)
path.write_text(text)

nav_path = Path('tests/phase5c_navigation_status_contract.test.js')
nav = nav_path.read_text()
nav = nav.replace(
    r"/existingStatus\.phase5cLastVerifiedRawHash === hash\(currentRaw\)/",
    r"/const currentRawHash = currentRaw \? hash\(currentRaw\) : '';/",
    1,
)
nav = nav.replace(
    "  assert.match(source, /verifiedStillCurrent \\? 'passed_verification' : 'waiting_for_successful_save'/);\n",
    "  assert.match(source, /existingStatus\\.phase5cLastVerifiedRawHash === currentRawHash/);\n  assert.match(source, /verifiedStillCurrent \\? 'passed_verification' : 'waiting_for_successful_save'/);\n",
    1,
)
nav_path.write_text(nav)

interrupted_path = Path('tests/phase5c_interrupted_and_removal_contract.test.js')
interrupted_path.write_text(r'''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'phase5b_deferred_mirror.js'), 'utf8');

test('a missing current Home-native mirror is backfilled from the latest authoritative save without becoming a read source', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /const homeNativeKnownCurrent = Boolean\(currentRaw/);
  assert.match(source, /if \(hookInstalled && currentRaw && !homeNativeKnownCurrent && journalCount\(\) === 0\)/);
  assert.match(source, /const backfill = \(\) => \{/);
  assert.match(source, /if \(latestRaw && journalCount\(\) === 0\) queue\(latestRaw\)/);
  assert.match(source, /requestIdleCallback\(backfill, \{ timeout: 5000 \}\)/);
  assert.match(source, /indexedDbReadsEnabled: false/);
  assert.match(source, /indexedDbWriteBackEnabled: false/);
});

test('authoritative absence cannot be reported as a current verified secondary and does not delete recovery data', () => {
  assert.match(source, /const currentRaw = get\(KEY\)/);
  assert.match(source, /const verifiedStillCurrent = Boolean\(hookInstalled[\s\S]*?&& currentRaw/);
  assert.match(source, /phase5cMirrorsCurrentSave: verifiedStillCurrent/);
  assert.match(source, /verifiedStillCurrent \? 'passed_verification' : 'waiting_for_successful_save'/);
  assert.doesNotMatch(source, /deleteDatabase\s*\(/);
});
''')
