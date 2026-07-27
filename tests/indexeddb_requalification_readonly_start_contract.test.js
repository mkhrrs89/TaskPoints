const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const runtime = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification.js'), 'utf8');
const page = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification.html'), 'utf8');

test('opening the faster-storage page only checks data and cannot switch modes automatically', () => {
  assert.match(runtime, /global\.addEventListener\('load', refresh, \{ once: true \}\)/);
  assert.match(runtime, /\$\('startTestBtn'\)\.addEventListener\('click', startTest\)/);
  assert.match(runtime, /\$\('finishTestBtn'\)\.addEventListener\('click', finishTest\)/);
  const loadAt = runtime.indexOf("global.addEventListener('load', refresh");
  const startAt = runtime.indexOf('async function startTest()');
  const finishAt = runtime.indexOf('async function finishTest()');
  assert.ok(startAt >= 0 && finishAt > startAt && loadAt > finishAt);
  assert.match(page, /Nothing will switch automatically/);
  assert.doesNotMatch(page, /player images?[^<]*(?:delete|remove)/i);
});
