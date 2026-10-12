const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const settings = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');

test('both habit and vice editors expose independent Time of Day fields', () => {
  for (const id of ['habitTimeOfDay', 'viceTimeOfDay']) assert.ok(home.includes('id="' + id + '"'));
  assert.equal((home.match(/data-field="time-of-day"/g) || []).length, 2);
  assert.match(home, /if \(timeOfDayInput\) h\.timeOfDay = timeOfDayInput\.value\.trim\(\)/);
  assert.match(home, /timeOfDay: typeof habit\.timeOfDay/);
});

test('both lists support tag and time of day grouping without dropping custom ordering', () => {
  for (const id of ['habitsSortSelect', 'vicesSortSelect']) assert.ok(home.includes('id="' + id + '"'));
  assert.match(home, /function buildHabitRenderEntries\(habits, sortMode\)/);
  assert.match(home, /function getViceSortMode\(\)/);
  assert.match(home, /timeOfDayColors\?\.\[section\.tag\]/);
});

test('settings manages Time of Day names and colors independently of tag colors', () => {
  assert.match(settings, /id="timeOfDayColorsSection"/);
  assert.match(settings, /function renderTimeOfDayColors\(\)/);
  assert.match(settings, /function saveTimeOfDayConfiguration\(state, reason\)/);
  assert.match(settings, /timeOfDayGroups: Array\.isArray\(src\.timeOfDayGroups\)/);
  assert.match(settings, /timeOfDayColors: normalizeHabitTagColors\(src\.timeOfDayColors\)/);
  assert.match(settings, /scheduleRender\(renderHabitTagColors\)/);
  assert.match(settings, /scheduleRender\(renderTimeOfDayColors\)/);
});
