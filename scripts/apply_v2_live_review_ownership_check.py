from pathlib import Path

live_path = Path('state_runtime_v2_live_review.js')
live = live_path.read_text()
live = live.replace(
    "const REVIEWER_SRC = '/state_runtime_v2_trace_review.js?v=20260912-1';",
    "const REVIEWER_SRC = '/state_runtime_v2_trace_review.js?v=20260915-1';",
    1,
)
old_rows = """      { key: 'preemption', label: 'Interaction postponed pending maintenance', ok: review?.interactionPreemptionObserved === true },
      { key: 'parity', label: 'V2 data matches legacy data', ok: review?.parity?.matchConfirmed === true },
      { key: 'failures', label: 'No V2 failures observed', ok: review?.failures?.noV2FailuresObserved === true }"""
new_rows = """      { key: 'preemption', label: 'Interaction postponed pending maintenance', ok: review?.interactionPreemptionObserved === true },
      { key: 'ownership', label: 'V2 stores only Habit/Vice pilot completions', ok: review?.pilotOwnership?.v2StoreContainsOnlyPilotCompletions === true },
      { key: 'parity', label: 'V2 data matches legacy data', ok: review?.parity?.matchConfirmed === true },
      { key: 'failures', label: 'No V2 failures observed', ok: review?.failures?.noV2FailuresObserved === true }"""
if old_rows not in live:
    raise SystemExit('live-review checkRows insertion target not found')
live = live.replace(old_rows, new_rows, 1)
live_path.write_text(live)

bridge_path = Path('state_runtime_v2_habit_structure_bridge.js')
bridge = bridge_path.read_text()
old_bridge = "script.src = '/state_runtime_v2_live_review.js?v=20260913-2';"
new_bridge = "script.src = '/state_runtime_v2_live_review.js?v=20260915-1';"
if old_bridge not in bridge:
    raise SystemExit('live-review bridge cache version target not found')
bridge = bridge.replace(old_bridge, new_bridge, 1)
bridge_path.write_text(bridge)

test_path = Path('tests/state_runtime_v2_live_review_contract.test.js')
test = test_path.read_text()
test = test.replace(
    r"assert.match(structureBridge, /state_runtime_v2_live_review\.js\?v=20260913-2/);",
    r"assert.match(structureBridge, /state_runtime_v2_live_review\.js\?v=20260915-1/);",
    1,
)
test = test.replace(
    r"assert.match(source, /state_runtime_v2_trace_review\.js\?v=20260912-1/);",
    r"assert.match(source, /state_runtime_v2_trace_review\.js\?v=20260915-1/);",
    1,
)
old_label = "    'Interaction postponed pending maintenance',\n    'V2 data matches legacy data',"
new_label = "    'Interaction postponed pending maintenance',\n    'V2 stores only Habit/Vice pilot completions',\n    'V2 data matches legacy data',"
if old_label not in test:
    raise SystemExit('live-review evidence label list target not found')
test = test.replace(old_label, new_label, 1)
old_tail = "  assert.match(source, /Legacy\\/full-state timing candidates/);\n});"
new_tail = "  assert.match(source, /Legacy\\/full-state timing candidates/);\n  assert.match(source, /pilotOwnership\\?\\.v2StoreContainsOnlyPilotCompletions/);\n});"
if old_tail not in test:
    raise SystemExit('live-review ownership assertion target not found')
test = test.replace(old_tail, new_tail, 1)
test_path.write_text(test)
