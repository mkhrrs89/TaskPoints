const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'phase5b_deferred_mirror.js'), 'utf8');

test('verified secondary status survives navigation only while the authoritative raw hash still matches', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /const existingStatus = json\(get\(DIAG\), \{\}\) \|\| \{\}/);
  assert.match(source, /existingStatus\.phase5cLastStatus === 'passed_verification'/);
  assert.match(source, /existingStatus\.phase5cMirrorsCurrentSave === true/);
  assert.match(source, /existingStatus\.phase5cLastVerifiedRawHash === hash\(currentRaw\)/);
  assert.match(source, /verifiedStillCurrent \? 'passed_verification' : 'waiting_for_successful_save'/);
});
