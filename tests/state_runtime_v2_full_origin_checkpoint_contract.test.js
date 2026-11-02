'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');

test('full-origin checkpoint scope is opt-in and its authenticity covers scope and entries',()=>{
  const runtime=read('state_runtime_v2.js');
  const digest=runtime.slice(
    runtime.indexOf('function previewRecoveryDigestPayload(record)'),
    runtime.indexOf('async function openPreviewRecoveryDb()'));
  const create=runtime.slice(
    runtime.indexOf('async function createPreviewRecoveryCheckpoint(options = {})'),
    runtime.indexOf('// Developer-only cooperative-writer prototype.',runtime.indexOf('async function createPreviewRecoveryCheckpoint(options = {})')));
  assert.match(digest,/record\.integrityVersion === 3 && record\.captureScope === 'full_origin'/);
  assert.match(digest,/captureScope: record\.captureScope/);
  assert.match(digest,/record\.integrityVersion === 2/);
  assert.match(digest,/!fullOrigin && !entry\[0\]\.toLowerCase\(\)\.startsWith\('taskpoints_'\)/);
  assert.match(digest,/await previewRecoveryFingerprint\(payload\)/);
  assert.match(create,/options\?\.scope === 'full_origin'/);
  assert.match(create,/captureLegacyNamespace\(\)/);
  assert.match(create,/captureReadOnlyFullStorageInventory\(\)/);
  assert.match(create,/captureScope === 'full_origin' \? 3 : 2/);
  assert.match(create,/legacy_changed_during_capture/);
  assert.match(create,/checkpoint_saved_but_source_changed/);
  assert.match(create,/canAutoRestore: false/);
});

test('full-origin rollback rehearsal accounts for non-taskpoints keys but never writes or promotes',()=>{
  const runtime=read('state_runtime_v2.js');
  const inspect=runtime.slice(runtime.indexOf('async function inspectPreviewRecoveryCheckpoint(idInput)'),
    runtime.indexOf('async function createPreviewRecoveryCheckpoint(options = {})'));
  assert.match(inspect,/captureScope: record\.integrityVersion === 3/);
  assert.match(inspect,/captureForPlan = \(\) => captureScope === 'full_origin'/);
  assert.match(inspect,/if \(!await validPreviewRecoveryRecord\(record\)\)/);
  assert.doesNotMatch(inspect,/await inspectPreviewRecoveryCheckpoint\(id\)/);
  assert.equal((inspect.match(/openPreviewRecoveryDb\(\)/g)||[]).length,2,
    'checkpoint inspection and rollback plan each open the database once');
  assert.match(inspect,/JSON\.parse\(captureReadOnlyFullStorageInventory\(\)\)/);
  assert.match(inspect,/fullOriginLocalStorageCovered: verdict\.captureScope === 'full_origin'/);
  assert.match(inspect,/rollback_checkpoint_excludes_non_taskpoints_keys/);
  assert.match(inspect,/canApply: false/);
  assert.match(inspect,/production_writer_fencing_not_implemented/);
  assert.match(inspect,/external_checkpoint_backup_unverified/);
  assert.doesNotMatch(inspect,/localStorage\.(?:setItem|removeItem|clear)\(/);
});

test('weighted milestones sum to 100, count only completed milestones and keep promotion blocked',()=>{
  const doc=read('docs/state-runtime-v2-weighted-milestones.md');
  const rows=doc.split('\n').filter(line=>/^\| [^|]+ \|\s*\d+\s*\|\s*\d+\s*\|/.test(line));
  assert.equal(rows.length,10);
  const credits=rows.map(row=>{
    const parts=row.split('|').map(value=>value.trim());
    const weight=Number(parts[2]),credited=Number(parts[3]);
    assert.ok(weight>0&&weight<=20);
    assert.ok(credited===0||credited===weight,'gate must earn all or none');
    return {weight,credited};
  });
  assert.equal(credits.reduce((sum,row)=>sum+row.weight,0),100);
  assert.equal(credits.reduce((sum,row)=>sum+row.credited,0),67);
  const runtime=read('state_runtime_v2.js');
  assert.match(runtime,/async function inspectAuthorityCutoverBarriers\(\)/);
  assert.match(runtime,/allLegacyWritersFenced: false/);
  assert.match(runtime,/canPromote: false/);
});
