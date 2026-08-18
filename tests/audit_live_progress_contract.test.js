const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'habit_ledger_matchup_impact_attestation.js'), 'utf8');

test('Audit live progress uses compositor-friendly fill movement and phase feedback', () => {
  assert.match(source, /installTaskPointsAuditLiveProgress/);
  assert.match(source, /taskpointsAuditLiveFill 16s/);
  assert.match(source, /transform:\s*scaleX\(0\.06\)/);
  assert.match(source, /transform:\s*scaleX\(0\.92\)/);
  assert.match(source, /Loading state & rebuilding daily totals/);
  assert.match(source, /Checking scoring, history & records/);
  assert.match(source, /Checking Season, matchups & game history/);
  assert.match(source, /Testing page save paths & sticky data/);
  assert.match(source, /Finalizing audit report/);
});

test('Audit live progress does not replace the existing habit-ledger attestation feature', () => {
  assert.match(source, /installHabitLedgerImpactAttestation/);
  assert.match(source, /planner\.buildHabitLedgerRepairPlan = function attestedImpactBuild/);
  assert.match(source, /TaskPointsHabitLedgerImpactAttestation/);
});
