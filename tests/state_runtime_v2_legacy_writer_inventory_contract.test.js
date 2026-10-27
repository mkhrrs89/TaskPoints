'use strict';

// This is a deliberately conservative source audit, NOT a complete parser or
// a production write fence. In particular, indirect aliases/dynamic calls and
// older open tabs can evade a source scan. Keep V2 nonauthoritative until all
// legacy writers are truly integrated with a verified cross-tab protocol.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = filename => fs.readFileSync(path.join(ROOT, filename), 'utf8');

// Candidate scan intentionally looks across all top-level runtime .js/.html
// files, not merely the existing V2 modules. A writer can live in any page.
const STORAGE_CALL = /\b(?:localStorage|storage)\s*\.\s*(?:setItem|removeItem|clear)\s*\(/;
const CORE_CALL = /\b(?:TaskPointsCore|core)\s*\.\s*(?:saveStateSnapshot|saveValidatedSnapshot|safeReplaceTaskPointsStorage|writePendingHabitDelta)\s*\(/;

function findLegacyWriterCandidates() {
  const findings = [];
  for (const item of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!item.isFile() || !/\.(?:js|html)$/.test(item.name)) continue;
    const lines = read(item.name).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!STORAGE_CALL.test(line) && !CORE_CALL.test(line)) return;
      findings.push({
        file: item.name,
        line: index + 1,
        kind: CORE_CALL.test(line) ? 'core-state-entry' : 'potential-browser-storage-write',
        text: line.trim().slice(0, 200)
      });
    });
  }
  return findings;
}

const REQUIRED_WRITERS = Object.freeze([
  { file: 'scoring_core.js', text: 'localStorage.setItem(storageKey' },
  { file: 'index.html', text: 'TaskPointsCore.saveStateSnapshot(' },
  { file: 'index.html', text: 'localStorage.removeItem(STORAGE_KEY)' },
  { file: 'today.html', text: 'TaskPointsCore.saveStateSnapshot(' },
  { file: 'settings.html', text: 'TaskPointsCore.saveStateSnapshot(' },
  { file: 'settings.html', text: 'localStorage.setItem(storageKey, plan.chosenRaw)' },
  { file: 'notes.html', text: 'localStorage.setItem(NOTES_STORAGE_KEY' },
  { file: 'emergency_recovery.html', text: 'core.safeReplaceTaskPointsStorage(' },
  { file: 'task_mutation_journal.js', text: 'storage.setItem(JOURNAL_KEY' }
]);

test('legacy writer candidate audit includes nonpilot pages, replacement, recovery and journal writes', () => {
  const findings = findLegacyWriterCandidates();
  for (const expected of REQUIRED_WRITERS) {
    assert.ok(findings.some(item => item.file === expected.file && item.text.includes(expected.text)),
      'Legacy write surface missing or changed: ' + expected.file + ' / ' + expected.text
      + '. Review the new path before treating writer coverage as established.');
  }
  const files = new Set(findings.map(item => item.file));
  assert.ok(files.size >= 9, 'Unexpectedly narrow writer scan; check file selection and aliases');
  assert.ok(findings.length >= REQUIRED_WRITERS.length,
    'Writer scan did not capture all documented candidate sinks');
});

test('V2 WAL interception remains limited; it cannot imply universal V1 writer fencing', () => {
  const bridge = read('state_runtime_v2_wal_bridge.js');
  assert.match(bridge, /wrapSnapshotReplacement\(core, 'saveStateSnapshot'\)/);
  assert.match(bridge, /wrapSnapshotReplacement\(core, 'saveValidatedSnapshot'\)/);
  assert.match(bridge, /core\.safeReplaceTaskPointsStorage = wrappedSafeReplaceTaskPointsStorage/);
  // The above wrappers are useful recovery/migration mechanisms, but note
  // that Notes and other direct-key pages bypass them.
  for (const file of ['notes.html', 'settings.html', 'index.html', 'emergency_recovery.html']) {
    assert.ok(read(file).includes('localStorage.'), file + ' no longer exposes its expected direct storage paths');
  }
});

test('shared writer rehearsal cannot be mistaken for a production writer lease or authority cutover', () => {
  const runtime = read('state_runtime_v2.js');
  const start = runtime.indexOf('async function exercisePreviewCooperativeWriterLease(');
  const end = runtime.indexOf('async function rehearseExclusiveWriterLease()', start);
  assert.ok(start >= 0 && end > start, 'Developer-only lease rehearsal is missing');
  const rehearsal = runtime.slice(start, end);
  assert.match(rehearsal, /isWalTestPreviewHost\(\)/);
  assert.match(rehearsal, /productionWritersFenced:\s*false/);
  assert.match(rehearsal, /allLegacyWritersKnown:\s*false/);
  assert.match(rehearsal, /canPromote:\s*false/);
  assert.doesNotMatch(rehearsal, /canPromote:\s*true\b/);
  // Preview callback writers must be able to voluntarily recheck the
  // generation after an await and before any fixture side effect. This
  // reduces a TOCTOU window but does not fence legacy writers globally.
  assert.match(rehearsal, /const assertPreviewGenerationCurrent = \(\) =>/);
  assert.match(rehearsal, /STATE_RUNTIME_V2_PREVIEW_GENERATION_CHANGED/);
  assert.match(rehearsal, /await operation\(previewGuard\)/);
  assert.match(rehearsal, /cooperative_operation_generation_invalidated/);

  // Normal V1 writers do not yet participate in the prototype. Before any
  // handoff this must be replaced by actual writer fencing, not a test tweak.
  for (const file of [
    'index.html', 'today.html', 'settings.html', 'notes.html',
    'emergency_recovery.html', 'scoring_core.js', 'task_mutation_journal.js'
  ]) {
    assert.ok(!read(file).includes('exercisePreviewCooperativeWriterLease('),
      file + ' began calling the prototype: perform a full writer/rollback safety review.');
  }
});
