from pathlib import Path

path = Path('tests/habit_ledger_history_preservation.test.js')
text = path.read_text()
text = text.replace(
    r"/habit_ledger_matchup_impact_stale_guard\.js\?v=20260803-2/",
    r"/habit_ledger_matchup_impact_stale_guard\.js\?v=20260803-3/",
    1,
)
text = text.replace(
    r"/habit_ledger_completion_backed_repair\.js\?v=20260803-2/",
    r"/habit_ledger_completion_backed_repair\.js\?v=20260803-3/",
    1,
)
path.write_text(text)
