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
