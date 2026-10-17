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


function createHomeTimeOfDayHarness() {
  const vm = require('node:vm');
  const extract = (start, next) => {
    const i = home.indexOf(start);
    const j = home.indexOf(next, i);
    assert.ok(i >= 0 && j > i, 'expected a complete Home function: ' + start);
    return home.slice(i, j);
  };
  const state = {
    timeOfDayGroups: ['First Thing', 'Evening'],
    timeOfDayColors: { 'First Thing': '#ffe600' },
    habits: [
      { id: 'login', name: 'Logging In', timeOfDay: 'First Thing', tag: 'Daily', order: 1 },
      { id: 'teeth', name: 'Teeth', timeOfDay: 'first thing', tag: 'daily', order: 2 },
      { id: 'locks', name: 'Check Locks', timeOfDay: '  FIRST   THING  ', tag: 'Daily', order: 3 },
      { id: 'night', name: 'End Night', timeOfDay: 'Evening', tag: 'Night', order: 4 }
    ]
  };
  const saved = new Map([['taskpoints_time_of_day_group_order', JSON.stringify(['evening', 'FIRST THING'])]]);
  const calls = { saves: 0, habitRenders: 0, viceRenders: 0 };
  let sortMode = 'timeOfDay';
  const context = {
    state,
    Date,
    localStorage: {
      getItem(key) { return saved.get(key) ?? null; },
      setItem(key, value) { saved.set(key, String(value)); }
    },
    normalizeHexColor(value) { return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : null; },
    getHabitTagColor() { return '#abcdef'; },
    getHabitSortMode() { return sortMode; },
    save() { calls.saves += 1; },
    renderHabits() { calls.habitRenders += 1; },
    renderVices() { calls.viceRenders += 1; }
  };
  vm.runInNewContext(
    extract('function sortHabitsForMode', 'function formatHabitStreakBonusAmount')
      + '\n' + extract('function moveHabitWithinGroup', 'function toggleHabitDay'),
    context
  );
  return { context, state, calls, saved, setSortMode(value) { sortMode = value; } };
}

test('Time of Day groups auto-merge case and whitespace variants without changing stored Habits', () => {
  const h = createHomeTimeOfDayHarness();
  const original = JSON.stringify(h.state.habits);
  const result = h.context.buildHabitRenderEntries(h.state.habits, 'timeOfDay');
  const groups = result.entries.filter(entry => entry.type === 'group');

  assert.equal(groups.length, 2);
  assert.equal(groups[0].tag, 'Evening', 'saved group order still wins');
  assert.equal(groups[1].tag, 'First Thing', 'use the configured display label');
  assert.deepEqual(Array.from(groups[1].habits, habit => habit.id), ['login', 'teeth', 'locks']);
  assert.equal(JSON.stringify(h.state.habits), original, 'grouping does not rewrite source Habit data');
  assert.equal(h.calls.saves, 0, 'rendering never saves or migrates a group');
});

test('merged Time of Day groups continue to use the configured color', () => {
  const h = createHomeTimeOfDayHarness();
  assert.equal(h.context.getTimeOfDayGroupColor('First Thing'), '#ffe600');
  assert.equal(h.context.getTimeOfDayGroupColor(' FIRST   THING '), '#ffe600');
  assert.equal(h.context.getTimeOfDayGroupColor('Evening'), '');
});

test('moving an item in a merged Time of Day group includes its differently cased siblings', () => {
  const h = createHomeTimeOfDayHarness();
  h.context.moveHabitWithinGroup('teeth', 'First Thing', -1);
  const login = h.state.habits.find(habit => habit.id === 'login');
  const teeth = h.state.habits.find(habit => habit.id === 'teeth');
  assert.equal(login.order, 2);
  assert.equal(teeth.order, 1);
  assert.equal(h.calls.saves, 1);
  assert.equal(h.calls.habitRenders, 1);
  assert.equal(h.calls.viceRenders, 1);
});

test('Time of Day group movement keeps one group-order slot for equivalent names', () => {
  const h = createHomeTimeOfDayHarness();
  h.context.moveHabitGroup('first thing', -1);
  assert.deepEqual(
    JSON.parse(h.saved.get('taskpoints_time_of_day_group_order')),
    ['First Thing', 'Evening']
  );
  assert.equal(h.calls.saves, 0, 'group position persists in its dedicated order setting');
  const result = h.context.buildHabitRenderEntries(h.state.habits, 'timeOfDay');
  assert.equal(result.entries[0].tag, 'First Thing');
  assert.equal(result.entries[0].habits.length, 3);
});

test('ordinary Tag sorting retains its original distinct-label behavior', () => {
  const h = createHomeTimeOfDayHarness();
  const groups = h.context.buildHabitRenderEntries(h.state.habits, 'tag').entries
    .filter(entry => entry.type === 'group');
  assert.deepEqual(Object.fromEntries(Array.from(groups, entry => [entry.tag, entry.habits.length])),
    { Daily: 2, daily: 1, Night: 1 });
  assert.equal(h.calls.saves, 0);
});


function createTimeOfDayBubbleColorHarness() {
  const vm = require('node:vm');
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const extract = (start, next) => {
    const i = home.indexOf(start);
    const j = home.indexOf(next, i);
    assert.ok(i >= 0 && j > i, 'missing Habit bubble color helper: ' + start);
    return home.slice(i, j);
  };
  const state = {
    habitTagColors: { Hygiene: '#dd2299' },
    timeOfDayColors: { 'First Thing': '#ffde00' },
    timeOfDayGroups: ['First Thing'],
    habits: []
  };
  const sortSelect = { value: 'timeOfDay' };
  const context = {
    state,
    $: id => id === 'habitsSortSelect' ? sortSelect : null,
    localStorage: { getItem() { return null; } },
    normalizeHexColor(value) {
      return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : null;
    }
  };
  vm.runInNewContext(
    extract('function hexToRgb(hex)', 'function getHabitCompletionFraction')
      + '\n' + extract('function timeOfDayGroupKey(value)', 'function buildHabitRenderEntries')
      + '\n' + extract('function applyHabitBubbleStyle(el, habit, statusClass)', 'function applyHabitDayToggle'),
    context
  );
  const styleFor = (habit, status) => context.getHabitBubbleStyleAttrForHabit(habit, status);
  const tapStyleFor = (habit, status) => {
    const el = {
      style: '',
      setAttribute(name, value) {
        if (name === 'style') this.style = value;
      },
      removeAttribute(name) {
        if (name === 'style') this.style = '';
      }
    };
    context.applyHabitBubbleStyle(el, habit, status);
    return el.style;
  };
  return { styleFor, tapStyleFor, sortSelect, state, css };
}

test('Time of Day Habit completions use TOD colors rather than ordinary Tag colors', () => {
  const h = createTimeOfDayBubbleColorHarness();
  const habit = { category: 'habit', tag: 'Hygiene', timeOfDay: '  first   thing ' };
  const style = h.styleFor(habit, 'on');
  assert.match(style, /#ffde00/i);
  assert.doesNotMatch(style, /#dd2299/i);
  assert.match(h.tapStyleFor(habit, 'on'), /#ffde00/i,
    'an immediate tap must paint the same color as the full Habit renderer');
});

test('Time of Day Habits without assigned or colored TOD groups use original dark teal CSS', () => {
  const h = createTimeOfDayBubbleColorHarness();
  const unassigned = { category: 'habit', tag: 'Hygiene', timeOfDay: '' };
  const uncolored = { category: 'habit', tag: 'Hygiene', timeOfDay: 'Afternoon' };
  for (const habit of [unassigned, uncolored]) {
    assert.equal(h.styleFor(habit, 'on'), '',
      'no inline Tag color: allow normal teal completed bubble CSS');
    assert.equal(h.tapStyleFor(habit, 'on'), '',
      'tap repaint must restore normal teal completed bubble CSS');
    assert.equal(h.styleFor(habit, 'half'), '',
      'half points use the existing dark teal ring default');
  }
  assert.match(h.css, /\.habitDay\.on:not\(\[style\]\)/);
  assert.match(h.css, /--habit-half-color, #254C52/);
});

test('Time of Day half completions use TOD ring color while incomplete stays transparent', () => {
  const h = createTimeOfDayBubbleColorHarness();
  const habit = { category: 'habit', tag: 'Hygiene', timeOfDay: 'FIRST THING' };
  const half = h.styleFor(habit, 'half');
  assert.match(half, /--habit-half-color:#ffde00/i);
  assert.match(h.tapStyleFor(habit, 'half'), /--habit-half-color:#ffde00/i);
  assert.equal(h.styleFor(habit, 'off'), '',
    'uncompleted bubbles remain visually distinct from completions');
  assert.equal(h.styleFor(habit, 'failed'), '',
    'failed status should not be customized in this Habit-only case');
});

test('Tag and custom sorting keep old Tag colors; Vice colors remain unchanged', () => {
  const h = createTimeOfDayBubbleColorHarness();
  const habit = { category: 'habit', tag: 'Hygiene', timeOfDay: 'First Thing' };
  const vice = { category: 'vice', tag: 'Hygiene', timeOfDay: 'First Thing' };
  h.sortSelect.value = 'tag';
  assert.match(h.styleFor(habit, 'on'), /#dd2299/i);
  h.sortSelect.value = 'custom';
  assert.match(h.styleFor(habit, 'on'), /#dd2299/i);
  h.sortSelect.value = 'timeOfDay';
  assert.match(h.styleFor(vice, 'on'), /#dd2299/i);
  assert.equal(h.state.habits.length, 0);
});
