const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'verified_secondary_restore.js'), 'utf8');

test('the committed recovery generation is finalized only after restore verification succeeds', () => {
  assert.match(source, /restoreVerified = true;/);
  assert.match(source, /if \(restoreVerified\) finalizeRecoveryLock\(\);/);
  assert.doesNotMatch(source, /if \(authoritativeWriteOccurred\) finalizeRecoveryLock\(\);/);
  const catchAt = source.indexOf('} catch (error) {');
  const verifiedGateAt = source.indexOf('if (restoreVerified) finalizeRecoveryLock();', catchAt);
  const failedWriteBranchAt = source.indexOf('} else if (authoritativeWriteOccurred) {', catchAt);
  assert.ok(catchAt >= 0 && verifiedGateAt > catchAt && failedWriteBranchAt > verifiedGateAt);
});
