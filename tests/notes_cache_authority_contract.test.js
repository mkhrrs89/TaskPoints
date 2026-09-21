const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

const core = read('scoring_core.js');
const notes = read('notes.html');
const toolbar = read('toolbar.js');
const settings = read('settings.html');
const audit = read('audit.html');
const responsiveExport = read('home_export_responsiveness.js');
const inboxBadge = read('inbox_count_badge.js');

test('shared storage guard protects canonical Notes cache from stale routine saves', () => {
  assert.match(core, /const NOTES_AUTHORITY_KEY = "taskpoints_notes_authoritative_v1"/);
  assert.match(core, /function preserveAuthoritativeNotesBeforeSave/);
  assert.match(core, /authority\.dirty \|\| authority\.authoritative/);
  assert.match(core, /next\.notes = authority\.cacheNotes/);
  assert.match(core, /allowDestructiveOverwrite === true/);
  assert.match(core, /const protectedState = preserveAuthoritativeNotesBeforeSave\(nextState, storageKey, options\)/);
  assert.match(core, /return preserveAuthoritativeNotesBeforeSave\(next, storageKey, options\)/);
});

test('Notes page establishes cache authority for edits, sync, and intentional clearing', () => {
  assert.match(notes, /const NOTES_AUTHORITY_KEY = "taskpoints_notes_authoritative_v1"/);
  assert.match(notes, /cachePresent && \(cacheDirty \|\| cacheAuthoritative\)/);
  assert.match(notes, /localStorage\.setItem\(NOTES_AUTHORITY_KEY, "1"\)/);
  assert.match(notes, /localStorage\.setItem\(NOTES_STORAGE_KEY, notesInput\?\.value \|\| ""\)/);
});

test('shared export and settings paths respect an established Notes cache authority', () => {
  for (const [name, source] of [
    ['toolbar', toolbar],
    ['settings', settings],
    ['responsive export', responsiveExport],
    ['secondary export', inboxBadge]
  ]) {
    assert.match(
      source,
      /taskpoints_notes_authoritative_v1/,
      `${name} must recognize the canonical Notes cache marker`
    );
  }
  assert.match(toolbar, /localStorage\.removeItem\('taskpoints_notes_dirty_v1'\)/);
  assert.match(settings, /localStorage\.removeItem\("taskpoints_notes_dirty_v1"\)/);
});

test('Notes audit does not warn merely because an authoritative cache and state mirror differ', () => {
  assert.match(audit, /NOTES_AUTHORITY_KEY_FOR_AUDIT = "taskpoints_notes_authoritative_v1"/);
  assert.match(audit, /cached !== stateNotes && !cacheDirty && !cacheAuthoritative/);
  assert.match(audit, /Dedicated Notes cache is canonical; stale state mirror cannot overwrite it/);
  assert.match(audit, /Legacy Notes copies disagree and no canonical cache has been established yet/);
});

test('responsive export loader cache-busts the authority-aware export script', () => {
  assert.match(inboxBadge, /\/home_export_responsiveness\.js\?v=20260921-1/);
});
