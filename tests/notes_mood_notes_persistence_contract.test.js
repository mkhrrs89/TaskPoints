const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'notes.html'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} not found`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} closing brace not found`);
}

test('opening or leaving Notes without editing General Notes is read-only', () => {
  const saveNotes = extractFunction('saveNotes');
  const flushDirtyNotes = extractFunction('flushDirtyNotes');

  assert.match(saveNotes, /if \(!force && !notesDirty && value === loadedNotesValue\) return false;/);
  assert.match(flushDirtyNotes, /if \(!notesDirty\) return false;/);
  assert.match(source, /window\.addEventListener\("beforeunload", flushDirtyNotes\)/);
  assert.match(source, /window\.addEventListener\("pagehide", flushDirtyNotes\)/);
  assert.doesNotMatch(source, /window\.addEventListener\("pagehide", \(\) => saveNotes\(true\)\)/);
});

test('General Notes synchronization patches only the notes field from latest storage', () => {
  const sync = extractFunction('syncNotesStorageLocations');
  const save = extractFunction('saveNotes');

  assert.match(sync, /TaskPointsCore\.saveAppState\(\{ notes: notesText \}/);
  assert.match(sync, /userInitiated:\s*true/);
  assert.match(sync, /savePath:\s*"notes-storage-sync"/);
  assert.doesNotMatch(sync, /state\.notes\s*=\s*notesText;[\s\S]*writeTaskPointsStoredState\(state/);

  assert.match(save, /TaskPointsCore\.saveAppState\(\{ notes: value \}/);
  assert.match(save, /savePath:\s*"general-notes-edit"/);
  assert.match(save, /notesDirty\s*=\s*false/);
});

test('Mood Notes tab remains a read-only view of completion moodNotes', () => {
  const build = extractFunction('buildMoodNotesText');
  const render = extractFunction('renderMoodNotes');
  const setActiveTab = extractFunction('setActiveTab');

  assert.match(build, /entry\.moodNotes/);
  assert.match(build, /title\.startsWith\("Mood Score"\)/);
  assert.match(setActiveTab, /if \(!showGeneral\) renderMoodNotes\(\)/);
  assert.doesNotMatch(`${build}\n${render}\n${setActiveTab}`, /saveAppState|saveStateSnapshot|writeTaskPointsStoredState|localStorage\.setItem/);
});
