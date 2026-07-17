const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const weekHtml = fs.readFileSync(path.join(__dirname, '..', 'week.html'), 'utf8');
const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

test('week habit rows include completion and same-section adjacency classes', () => {
  assert.match(weekHtml, /const renderedRows = sorted\.map/);
  assert.match(weekHtml, /\['habitRow', 'habitRow--single'\]/);
  assert.match(weekHtml, /rowClasses\.push\('habitRow--week-complete'\)/);
  assert.match(weekHtml, /rowClasses\.push\('habitRow--week-complete-after'\)/);
  assert.match(weekHtml, /rowClasses\.push\('habitRow--week-complete-before'\)/);
  assert.match(weekHtml, /habitDaysRow\$\{isWeeklyComplete \? ' week-complete-row' : ''\}/);
});

test('mobile steel slab CSS joins adjacent completed habit rows', () => {
  assert.match(stylesCss, /\.habitRow\.habitRow--week-complete-after::before/);
  assert.match(stylesCss, /\.habitRow\.habitRow--week-complete-before::after/);
  assert.match(stylesCss, /--habit-week-complete-join-gap:/);
  assert.match(stylesCss, /\.habitRow\.habitRow--week-complete-middle/);
  assert.match(stylesCss, /\.habitRow\.habitRow--week-complete-single/);
});
