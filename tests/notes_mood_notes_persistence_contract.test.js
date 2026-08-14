const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'notes.html'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} not found`);

  const paramsStart = source.indexOf('(', start);
  assert.notEqual(paramsStart, -1, `${name} parameter list not found`);

  let parenDepth = 0;
  let paramsEnd = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    if (source[index] === '(') parenDepth += 1;
    if (source[index] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        paramsEnd = index;
        break;
      }
    }
  }
  assert.notEqual(paramsEnd, -1, `${name} parameter list did not close`);

  const braceStart = source.indexOf('{', paramsEnd);
  assert.notEqual(braceStart, -1, `${name} body not found`);

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
  assert.doesNotMatch(save, /flushPendingSaves/);
});

test('typing General Notes stays on the lightweight crash-safe cache path', () => {
  const schedule = extractFunction('scheduleSave');

  assert.match(source, /const NOTES_DIRTY_KEY = "taskpoints_notes_dirty_v1";/);
  assert.match(schedule, /localStorage\.setItem\(NOTES_STORAGE_KEY, notesInput\?\.value \|\| ""\)/);
  assert.match(schedule, /localStorage\.setItem\(NOTES_DIRTY_KEY, "1"\)/);
  assert.doesNotMatch(schedule, /saveNotes\(/);
  assert.doesNotMatch(schedule, /saveAppState/);
  assert.doesNotMatch(schedule, /flushPendingSaves/);
  assert.doesNotMatch(schedule, /setTimeout/);

  assert.match(source, /notesInput\?\.addEventListener\("change", flushDirtyNotes\)/);
  assert.match(source, /document\.visibilityState === "hidden"\) flushDirtyNotes\(\)/);
});

test('dirty lightweight Notes cache wins even when an edit shortened the note', () => {
  const getBest = extractFunction('getBestNotesTextFromStorage');
  const save = extractFunction('saveNotes');
  const sync = extractFunction('syncNotesStorageLocations');

  assert.match(getBest, /cacheDirty = localStorage\.getItem\(NOTES_DIRTY_KEY\) === "1"/);
  assert.match(getBest, /if \(cacheDirty\) return cacheNotes;/);
  assert.match(save, /localStorage\.removeItem\(NOTES_DIRTY_KEY\)/);
  assert.match(sync, /localStorage\.removeItem\(NOTES_DIRTY_KEY\)/);
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
