const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'indexeddb_requalification.js'), 'utf8');

function functionBody(name) {
  const start = source.indexOf(`async function ${name}()`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = source.indexOf('\n  async function ', start + 1);
  return source.slice(start, next >= 0 ? next : source.length);
}

test('refresh remains read-only and cannot hang on background write flushes', () => {
  const refresh = functionBody('refresh');
  assert.doesNotMatch(refresh, /flushPhase4PrimaryWrites/);
  assert.doesNotMatch(refresh, /flushPhase5ANativeSnapshotWrites/);
  assert.doesNotMatch(refresh, /flushPhase5CVerifiedSecondaryWrites/);
  assert.match(refresh, /render\(await collect\(\)\)/);
  assert.match(refresh, /finally \{ setBusy\(false\); \}/);
});

test('Start and Finish retain their explicit write verification steps', () => {
  const start = functionBody('startTest');
  const finish = functionBody('finishTest');
  assert.match(start, /flushPhase4PrimaryWrites/);
  assert.match(finish, /flushPhase4PrimaryWrites/);
});
