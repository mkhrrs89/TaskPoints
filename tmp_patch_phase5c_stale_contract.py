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
