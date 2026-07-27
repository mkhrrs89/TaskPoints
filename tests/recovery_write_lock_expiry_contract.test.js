const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'home_yesterday_result_consistency.js'), 'utf8');

test('normal TaskPoints pages clear expired uncommitted recovery locks before enforcing them', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /const UNCOMMITTED_LOCK_TTL_MS = 2 \* 60 \* 1000/);
  assert.match(source, /committedAtMs === 0 && createdAtMs > 0 && Date\.now\(\) - createdAtMs > UNCOMMITTED_LOCK_TTL_MS/);
  assert.match(source, /storage\.removeItem\(LOCK_KEY\)/);
  assert.match(source, /const installed = installInstanceHooks\(\) \|\| installPrototypeHooks\(\);\n  readLock\(\);/);
});
