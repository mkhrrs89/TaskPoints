from pathlib import Path
path = Path('phase4_storage_coordinator.js')
text = path.read_text()
old = "        snapshot: null,\n        phase2Snapshot,\n        phase2DualMetadata: dualMetadata,\n"
new = "        snapshot: null,\n        phase2Snapshot: dualSnapshot,\n        phase2DualMetadata: dualMetadata,\n"
if old not in text:
    raise SystemExit('Phase 4 alias block not found')
path.write_text(text.replace(old, new, 1))
