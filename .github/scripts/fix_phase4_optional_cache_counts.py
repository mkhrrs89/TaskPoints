from pathlib import Path

path = Path('phase4_primary_read_path.js')
text = path.read_text(encoding='utf-8')
old = """        && core.shadowCanonicalJson(primaryCache.sourceCounts) === core.shadowCanonicalJson(mirrorSummary.counts)
        && core.shadowCanonicalJson(primaryCache.destinationCounts) === core.shadowCanonicalJson(primarySummary.counts)
"""
new = """        && (primaryCache.sourceCounts == null
          || core.shadowCanonicalJson(primaryCache.sourceCounts) === core.shadowCanonicalJson(mirrorSummary.counts))
        && (primaryCache.destinationCounts == null
          || core.shadowCanonicalJson(primaryCache.destinationCounts) === core.shadowCanonicalJson(primarySummary.counts))
"""
if text.count(old) != 1:
    raise SystemExit(f'expected one strict count comparison, found {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
