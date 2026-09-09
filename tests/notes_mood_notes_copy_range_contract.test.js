const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'mood_notes_copy_range.js'), 'utf8');
const notesSource = fs.readFileSync(path.join(__dirname, '..', 'notes.html'), 'utf8');

function loadApi() {
  const context = {
    console,
    Date,
    JSON,
    globalThis: null,
    window: null,
    navigator: {},
    document: { readyState: 'complete', getElementById() { return null; } },
    setTimeout() {},
    module: { exports: {} }
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'mood_notes_copy_range.js' });
  return context.module.exports;
}

function completion(date, note, title = 'Mood Score 7') {
  return { title, moodNotes: note, completedAtISO: `${date}T12:00:00.000Z` };
}

test('Notes page loads the Mood Notes copy-range tool', () => {
  assert.match(notesSource, /<script src="mood_notes_copy_range\.js" defer><\/script>/);
  assert.match(source, /moodNotesCopyFrom/);
  assert.match(source, /moodNotesCopyTo/);
  assert.match(source, /Copy Range/);
});

test('range copy includes only Mood Score notes inside the inclusive date range', () => {
  const api = loadApi();
  const result = api.buildRangeCopy('2026-09-03', '2026-09-05', {
    completions: [
      completion('2026-09-02', 'too early'),
      completion('2026-09-03', 'start day'),
      completion('2026-09-04', 'middle day'),
      completion('2026-09-05', 'end day'),
      completion('2026-09-06', 'too late'),
      completion('2026-09-04', 'not mood', 'Habit completion')
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.count, 3);
  assert.match(result.text, /Mood Notes — 9\/3\/26 to 9\/5\/26/);
  assert.match(result.text, /start day/);
  assert.match(result.text, /middle day/);
  assert.match(result.text, /end day/);
  assert.doesNotMatch(result.text, /too early|too late|not mood/);
});

test('invalid or empty ranges do not produce clipboard text', () => {
  const api = loadApi();
  const backwards = api.buildRangeCopy('2026-09-06', '2026-09-05', { completions: [] });
  assert.equal(backwards.ok, false);
  assert.match(backwards.reason, /Start date/);

  const empty = api.buildRangeCopy('2026-09-03', '2026-09-05', {
    completions: [completion('2026-09-02', 'outside')]
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.text, '');
});

test('copy feature remains read-only with respect to TaskPoints persistence', () => {
  assert.doesNotMatch(source, /saveAppState|saveStateSnapshot|writeTaskPointsStoredState|localStorage\.setItem|localStorage\.removeItem/);
  assert.match(source, /navigator\?\.clipboard\?\.writeText/);
  assert.match(source, /execCommand\('copy'\)/);
});
