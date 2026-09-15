from pathlib import Path

path = Path('state_runtime_v2.js')
text = path.read_text()
old = '''    const completionEntries = [];
    const completions = source.state.completions;
    completions.forEach((completion, index) => {'''
new = '''    const completionEntries = [];
    // V2 sequences are defined inside the pilot-owned Habit/Vice completion set.
    // Using the full legacy completion array here lets unrelated task/manual rows
    // shift sequence numbers and makes a future-only Habit edit look like it must
    // rewrite unchanged historical Habit completions.
    const completions = pilotCompletions(source.state);
    completions.forEach((completion, index) => {'''
if old not in text:
    raise SystemExit('Habit edit completion capture block not found')
text = text.replace(old, new, 1)
path.write_text(text)
