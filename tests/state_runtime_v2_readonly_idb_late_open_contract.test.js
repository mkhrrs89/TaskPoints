'use strict';

// A rejected IDB open can still finish later (notably after onblocked).
// Read-only M01/C01 inspection must release the late connection instead of
// accidentally holding an image/recovery database schema lock. No authority
// handoff is being certified by these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2.js'), 'utf8');
const backupStart = source.indexOf('async function inspectPreviewIndependentBackupCoverage(');
const imageStart = source.indexOf('async function inspectPreviewLegacyImageBytes(');
const nextSection = source.indexOf('// V2 PREVIEW ONLY: observe real', imageStart);
assert.ok(backupStart > 0 && imageStart > backupStart && nextSection > imageStart);

const opens = [
  {
    label: 'first independent-backup census',
    marker: 'const request=idb.open(item.name);',
    start: backupStart,
    end: imageStart
  },
  {
    label: 'second independent-backup census',
    marker: 'const request=idb.open(prior.name);',
    start: backupStart,
    end: imageStart
  },
  {
    label: 'legacy image bytes audit',
    marker: 'const request=idb.open(imageName);',
    start: imageStart,
    end: nextSection
  }
];

function auditedOpenExpression({ label, marker, start, end }) {
  const occurrence = source.indexOf(marker, start);
  assert.ok(occurrence > start && occurrence < end, label + ' missing');
  assert.equal(source.indexOf(marker, occurrence + 1) < 0
    || source.indexOf(marker, occurrence + 1) >= end, true,
  label + ' is unexpectedly ambiguous');
  const promiseStart = source.lastIndexOf('new Promise((resolve,reject)=>{', occurrence);
  assert.ok(promiseStart > start, label + ' promise missing');
  const promiseEnd = source.indexOf('});', occurrence);
  assert.ok(promiseEnd > occurrence && promiseEnd < end, label + ' promise not closed');
  const expression = source.slice(promiseStart, promiseEnd + 2);
  for (const required of [
    'request.onupgradeneeded=', 'request.onblocked=',
    'request.onerror=', 'request.onsuccess=', 'request.result?.close()',
    'rejected=true', 'request.transaction?.abort'
  ]) assert.ok(expression.includes(required), label + ' lost ' + required);
  assert.doesNotMatch(expression,
    /\b(?:storage|localStorage|store|db)\.(?:setItem|removeItem|put|add|delete|clear)\s*\(/,
    label + ' open must remain read-only');
  return expression;
}

for (const entry of opens) {
  const expression = auditedOpenExpression(entry);
  for (const event of ['onblocked', 'onupgradeneeded', 'onerror']) {
    test(entry.label + ' closes late connection after ' + event, async () => {
      let opensCount = 0, aborts = 0, closes = 0;
      const fakeDb = { close() { closes += 1; } };
      const idb = {
        open(name) {
          assert.equal(name, entry.label === 'legacy image bytes audit'
            ? 'taskpoints' : 'recovery-example');
          opensCount += 1;
          const request = {
            transaction: { abort() { aborts += 1; } },
            error: new Error('synthetic_idb_open_error')
          };
          queueMicrotask(() => {
            request[event]();
            // Deliver a late success despite an already-rejected request.
            // This is specifically the connection leak we must prevent.
            request.result = fakeDb;
            request.onsuccess();
          });
          return request;
        }
      };
      const run = vm.runInNewContext(
        '(async()=>await ' + expression + ')',
        { idb, item:{name:'recovery-example'},
          prior:{name:'recovery-example'}, imageName:'taskpoints' });
      await assert.rejects(() => run(), error =>
        error instanceof Error || !!error?.message);
      await Promise.resolve();
      assert.equal(opensCount, 1);
      assert.equal(aborts, event === 'onupgradeneeded' ? 1 : 0,
        'unintended database creation must be aborted');
      assert.equal(closes, 1, 'rejected audit must close a late IDB handle');
    });
  }

  test(entry.label + ' leaves successful open in caller ownership', async () => {
    let closes = 0;
    const fakeDb = { close() { closes += 1; } };
    const idb = {
      open() {
        const request = { transaction:{ abort(){ throw Error('unexpected upgrade'); } } };
        queueMicrotask(() => {
          request.result = fakeDb;
          request.onsuccess();
        });
        return request;
      }
    };
    const run = vm.runInNewContext('(async()=>await ' + expression + ')',
      {idb,item:{name:'recovery-example'},prior:{name:'recovery-example'},
        imageName:'taskpoints'});
    const obtained = await run();
    assert.equal(obtained, fakeDb);
    assert.equal(closes, 0, 'normal success must not be closed before caller uses it');
    obtained.close();
    assert.equal(closes, 1);
  });
}
