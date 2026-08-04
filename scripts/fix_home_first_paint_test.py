from pathlib import Path

path = Path('tests/home_first_paint_maintenance.test.js')
text = path.read_text(encoding='utf-8')
old = "  assert.match(scheduler, /HOME_SEASON_MATERIALIZATION_SESSION_KEY/);\n"
new = "  assert.match(home, /const HOME_SEASON_MATERIALIZATION_SESSION_KEY = 'tp_home_season_materialization_v1';/);\n"
if old in text:
    text = text.replace(old, new, 1)
elif new not in text:
    raise SystemExit('Could not locate materialization session-key assertion')
path.write_text(text, encoding='utf-8')
