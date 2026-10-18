const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'notes.html'), 'utf8');

function functionText(name, nextName) {
  const start = source.indexOf('    function ' + name + '(');
  const end = source.indexOf('    function ' + nextName + '(', start + 1);
  assert.ok(start >= 0 && end > start, name + ' source must be found');
  return source.slice(start, end);
}

function makeHarness({ markerFailsOnce = false } = {}) {
  const values = new Map([['taskpoints_notes_v1', 'Initial']]);
  const calls = { writes: [], removals: [], statusUpdates: 0, stateSaves: 0, dispatched: 0 };
  let failMarker = markerFailsOnce;
  const context = {
    localStorage: {
      setItem(key, value) {
        calls.writes.push({ key, value });
        if (key === 'taskpoints_notes_dirty_v1' && failMarker) {
          failMarker = false;
          throw Error('Simulated marker storage failure');
        }
        values.set(key, String(value));
      },
      removeItem(key) { calls.removals.push(key); values.delete(key); }
    },
    notesInput: { value: 'Initial' },
    notesStatus: {
      _text: 'Saved',
      get textContent() { return this._text; },
      set textContent(next) { this._text = next; calls.statusUpdates++; }
    },
    NOTES_STORAGE_KEY: 'taskpoints_notes_v1',
    NOTES_AUTHORITY_KEY: 'taskpoints_notes_authoritative_v1',
    NOTES_DIRTY_KEY: 'taskpoints_notes_dirty_v1',
    STORAGE_KEY: 'taskpoints_v1',
    TaskPointsCore: {
      saveAppState(patch) { assert.equal(patch.notes, context.notesInput.value); calls.stateSaves++; return {}; }
    },
    window: {
      TaskPointsCore: null,
      clearTimeout() {},
      dispatchEvent() { calls.dispatched++; }
    },
    CustomEvent: class {
      constructor(type, options) { this.type = type; this.detail = options.detail; }
    },
    console: { error() {} }
  };
  context.window.TaskPointsCore = context.TaskPointsCore;
  vm.createContext(context);
  vm.runInContext([
    'let saveTimer = null;',
    'let notesDirty = false;',
    'let loadedNotesValue = "Initial";',
    'let notesCacheMarkersEstablished = false;',
    functionText('setStatus', 'getBestNotesTextFromStorage'),
    functionText('saveNotes', 'scheduleSave'),
    functionText('scheduleSave', 'flushDirtyNotes'),
    'globalThis.actions = { scheduleSave, saveNotes };'
  ].join('\n'), context);
  return { ...context, values, calls, actions: context.actions };
}

test('every character remains synchronously crash-durable, but markers are written only once per editing session', () => {
  const h = makeHarness();
  for (let i = 0; i < 100; i++) {
    h.notesInput.value += String(i % 10);
    h.actions.scheduleSave();
    assert.equal(h.values.get('taskpoints_notes_v1'), h.notesInput.value);
  }
  assert.equal(h.calls.writes.filter(x => x.key === 'taskpoints_notes_v1').length, 100);
  assert.equal(h.calls.writes.filter(x => x.key === 'taskpoints_notes_authoritative_v1').length, 1);
  assert.equal(h.calls.writes.filter(x => x.key === 'taskpoints_notes_dirty_v1').length, 1);
  assert.equal(h.values.get('taskpoints_notes_dirty_v1'), '1');
  assert.equal(h.values.get('taskpoints_notes_authoritative_v1'), '1');
  assert.equal(h.calls.statusUpdates, 0, 'unchanged Saved label must not trigger DOM updates');
  assert.equal(h.calls.stateSaves, 0, 'full state remains off the keystroke path');
});

test('the normal sync preserves notes and restores a fresh dirty transition for the next edit', () => {
  const h = makeHarness();
  h.notesInput.value = 'First edit';
  h.actions.scheduleSave();
  assert.equal(h.actions.saveNotes(true), true);
  assert.equal(h.calls.stateSaves, 1);
  assert.equal(h.values.get('taskpoints_notes_dirty_v1'), undefined);
  h.notesInput.value = 'Second edit';
  h.actions.scheduleSave();
  assert.equal(h.values.get('taskpoints_notes_v1'), 'Second edit');
  assert.equal(h.values.get('taskpoints_notes_dirty_v1'), '1');
  assert.equal(h.calls.writes.filter(x => x.key === 'taskpoints_notes_dirty_v1').length, 2);
  assert.equal(h.actions.saveNotes(true), true);
});

test('failed marker establishment is retried and current notes are still saved', () => {
  const h = makeHarness({ markerFailsOnce: true });
  h.notesInput.value = 'First character';
  h.actions.scheduleSave();
  assert.equal(h.values.get('taskpoints_notes_v1'), 'First character');
  assert.equal(h.notesStatus.textContent, 'Save pending');
  assert.equal(h.values.get('taskpoints_notes_dirty_v1'), undefined);
  h.notesInput.value = 'Second character';
  h.actions.scheduleSave();
  assert.equal(h.values.get('taskpoints_notes_v1'), 'Second character');
  assert.equal(h.values.get('taskpoints_notes_dirty_v1'), '1');
  assert.equal(h.notesStatus.textContent, 'Saved');
  assert.equal(h.calls.statusUpdates, 2);
});

test('existing crash flush and canonical authority contracts remain wired', () => {
  assert.match(source, /notesInput\?\.addEventListener\("input", scheduleSave\)/);
  assert.match(source, /notesInput\?\.addEventListener\("change", flushDirtyNotes\)/);
  assert.match(source, /window\.addEventListener\("beforeunload", flushDirtyNotes\)/);
  assert.match(source, /window\.addEventListener\("pagehide", flushDirtyNotes\)/);
  assert.match(source, /document\.visibilityState === "hidden"\) flushDirtyNotes\(\)/);
  assert.match(source, /cachePresent && \(cacheDirty \|\| cacheAuthoritative\)/);
  assert.match(source, /TaskPointsCore\.saveAppState\(\{ notes: value \}/);
});
