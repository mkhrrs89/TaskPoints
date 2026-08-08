const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../you_score_alias_alignment.js'), 'utf8');

test('non-Home persisted alias repair has a long eligibility delay before the quiet gate', () => {
  assert.ok(source.includes('const NON_HOME_ALIAS_REPAIR_DELAY_MS = 14000;'));
  assert.ok(source.includes('global.setTimeout(scheduleGate, NON_HOME_ALIAS_REPAIR_DELAY_MS);'));
  assert.ok(source.includes('const gate = core.whenStorageMaintenanceQuiet;'));
  assert.ok(source.includes("gate(run, { reason: `you_score_alias_alignment_${reason}` })"));
});

test('the delayed job still performs the same persisted repair rather than removing it', () => {
  assert.match(source, /const run = \(\) => \{[\s\S]*return repairPersistedState\(\);[\s\S]*\};/);
  assert.ok(source.includes("function repairPersistedState(options = {})"));
  assert.ok(source.includes("savePath: 'you-score-alias-alignment-repair'"));
});
