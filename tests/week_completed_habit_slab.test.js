const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const weekHtml = fs.readFileSync(path.join(__dirname, '..', 'week.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

test('week habit rows include completion and same-section adjacency classes', () => {
  assert.match(weekHtml, /const renderedRows = sorted\.map/);
  assert.match(weekHtml, /\['habitRow', 'habitRow--week-page'\]/);
  assert.doesNotMatch(weekHtml, /const rowClasses = \['habitRow', 'habitRow--single'\]/);
  assert.match(weekHtml, /rowClasses\.push\('habitRow--week-complete'\)/);
  assert.match(weekHtml, /rowClasses\.push\('habitRow--week-complete-after'\)/);
  assert.match(weekHtml, /rowClasses\.push\('habitRow--week-complete-before'\)/);
  assert.match(weekHtml, /habitDaysRow\$\{isWeeklyComplete \? ' week-complete-row' : ''\}/);
});

test('mobile steel slab CSS joins adjacent completed habit rows', () => {
  assert.match(indexHtml, /habitWeekCompleteStack/);
  assert.match(weekHtml, /habitWeekCompleteStack/);
  assert.match(stylesCss, /\.habitWeekCompleteStack::before\s*\{/);
  assert.match(stylesCss, /\.habitWeekCompleteStack::after\s*\{/);
  assert.match(stylesCss, /\.habitWeekCompleteStack::before\s*\{[\s\S]*?border-radius:\s*0;/);
  assert.match(stylesCss, /\.habitWeekCompleteStack::after\s*\{[\s\S]*?border-radius:\s*0;/);
  assert.match(stylesCss, /\.habitScroll \.habitWeekCompleteStack\s*\{\s*min-width:\s*552px;/);
  assert.match(stylesCss, /\.habitWeekCompleteStack > \.habitRow\.habitRow--week-complete::before,[\s\S]*?\.habitWeekCompleteStack > \.habitRow\.habitRow--week-complete::after\s*\{\s*content:\s*none;/);
  assert.doesNotMatch(stylesCss, /habitRow--week-complete-single\s*\{\s*--habit-week-complete-(?:top|bottom)-radius:\s*10px;/);
  assert.match(stylesCss, /\.habitRow--single\.habitRow--week-complete\s*,/);
  assert.match(stylesCss, /\.habitRow--week-page\.habitRow--week-complete\s*\{/);
  assert.match(stylesCss, /\.habitRow\.habitRow--week-complete-after::before/);
  assert.match(stylesCss, /\.habitRow\.habitRow--week-complete-before::after/);
  assert.match(stylesCss, /--habit-week-complete-join-gap:/);
  assert.match(stylesCss, /\.habitRow\.habitRow--week-complete-middle/);
  assert.match(stylesCss, /\.habitRow\.habitRow--week-complete-single/);
});

test('completed-run wrappers preserve desktop spacing', () => {
  assert.match(
    stylesCss,
    /@media \(min-width:\s*641px\)\s*\{\s*\.habitWeekCompleteStack\s*\{[\s\S]*?display:\s*grid;[\s\S]*?gap:\s*0\.5rem;/
  );
});

test('Home habit rows receive completion adjacency classes within their containers', () => {
  assert.match(indexHtml, /function addHabitWeeklyCompleteClasses/);
  assert.match(indexHtml, /classList\.add\('habitRow--week-complete-after'\)/);
  assert.match(indexHtml, /classList\.add\('habitRow--week-complete-before'\)/);
  assert.match(indexHtml, /classList\.add\('habitRow--week-complete-(?:start|middle|end|single)'\)/);
  assert.match(indexHtml, /const groupedRows = entry\.habits\.map/);
assert.match(indexHtml, /previousEntry\?\.type === 'single'/);
assert.match(indexHtml, /nextEntry\?\.type === 'single'/);
  assert.match(indexHtml, /const renderedViceRows = habits\.map/);
});

test('shared single-habit mobile layout remains available outside the Week page', () => {
  assert.match(stylesCss, /\.habitRow--single\s*\{[\s\S]*?grid-template-columns:/);
  assert.match(stylesCss, /\.habitRow--single \.habitDaysRow\s*\{\s*grid-area:\s*days;/);
  assert.doesNotMatch(stylesCss, /\.habitRow--week-page\s*\{[^}]*grid-(?:template-columns|template-areas|area):/);
});
