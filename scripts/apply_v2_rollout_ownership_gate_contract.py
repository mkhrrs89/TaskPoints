from pathlib import Path

path = Path('tests/state_runtime_v2_rollout_gate_contract.test.js')
text = path.read_text()
old = """  assert.match(workflow, /Run V2 core storage contracts/);
  assert.match(workflow, /Run V2 Habit mutation contracts/);"""
new = """  assert.match(workflow, /Run V2 core storage contracts/);
  assert.match(workflow, /state_runtime_v2_pilot_compatibility_boundary_contract\\.test\\.js/);
  assert.match(workflow, /state_runtime_v2_pilot_parity_scope_contract\\.test\\.js/);
  assert.match(workflow, /Run V2 Habit mutation contracts/);"""
if old not in text:
    raise SystemExit('rollout ownership-gate insertion target not found')
text = text.replace(old, new, 1)
path.write_text(text)
