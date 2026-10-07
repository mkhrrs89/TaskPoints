import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('Home habits render tagged and untagged sections with a dedicated left rail', () => {
  assert.match(index, /habitGroup--rail-layout/);
  assert.match(index, /habitGroup--tagged/);
  assert.match(index, /habitGroup--untagged/);
  assert.match(index, /rail\.className = 'habitGroupRail'/);
  assert.match(index, /title\.className = 'habitGroupTitle'/);
  assert.match(index, /section\.type === 'untagged'/);
  assert.match(index, /rail\.setAttribute\('aria-hidden', 'true'\)/);
});

test('habit tag rail spans the group and uses vertical top-aligned text', () => {
  assert.match(styles, /\.habitGroup--rail-layout \.habitGroupRail\{[\s\S]*?min-height:100%;[\s\S]*?align-items:flex-start;[\s\S]*?background:linear-gradient\(180deg, #254c52 0%, #1a383b 100%\)/);
  assert.match(styles, /\.habitGroup--rail-layout \.habitGroupTitle\{[\s\S]*?writing-mode:vertical-rl;[\s\S]*?transform:rotate\(180deg\)/);
});

test('habit group boundary is open on the right with only top and bottom rules', () => {
  assert.match(styles, /\.habitGroup\.habitGroup--rail-layout\{[\s\S]*?border:0;[\s\S]*?border-top:1px solid var\(--border\);[\s\S]*?border-bottom:1px solid var\(--border\);[\s\S]*?border-radius:0;/);
  assert.match(styles, /\.habitGroup--rail-layout,[\s\S]*?border-right:0 !important;/);
});

test('completed-week plate starts at the rail/content boundary rather than extending beneath the rail', () => {
  assert.match(styles, /\.habitGroup--rail-layout \.habitGroupBody \.habitWeekCompleteStack\{[\s\S]*?margin-left:0;[\s\S]*?width:100%;/);
  assert.doesNotMatch(styles, /\.habitGroup--rail-layout \.habitGroupBody \.habitWeekCompleteStack\{[\s\S]*?margin-left:\s*-36px/);
});


test('Home rail sections touch and extend flush to both Habits card edges', () => {
  assert.match(index, /id="habitsList" class="grid gap-2 habitsList--rail-layout"/);
  assert.match(styles, /#habitsList\.habitsList--rail-layout\{[\s\S]*?gap:0;[\s\S]*?margin-left:-16px;[\s\S]*?margin-right:-16px;[\s\S]*?width:calc\(100% \+ 32px\);/);
  assert.match(styles, /\.habitGroup\.habitGroup--rail-layout \+ \.habitGroup\.habitGroup--rail-layout\{[\s\S]*?margin-top:-1px;/);
});

test('vertical habit group labels are larger uppercase text', () => {
  assert.match(styles, /\.habitGroup--rail-layout \.habitGroupTitle\{[\s\S]*?font-size:15px;[\s\S]*?text-transform:uppercase;/);
  assert.match(styles, /@media \(max-width:640px\)[\s\S]*?\.habitGroup--rail-layout \.habitGroupTitle\{[\s\S]*?font-size:14px;/);
});

test('Home habit bubbles disable iOS double-tap zoom while preserving tap and pinch behavior', () => {
  assert.match(styles, /#habitsList\.habitsList--rail-layout \.habitDay\{[\s\S]*?touch-action:manipulation;[\s\S]*?-webkit-tap-highlight-color:transparent;/);
});


test('silver week-complete visual is layout-neutral inside Home habit rails', () => {
  assert.match(styles, /\.habitGroup--rail-layout \.habitGroupBody \.habitWeekCompleteStack\{[\s\S]*?padding:0 10px;[\s\S]*?display:grid;[\s\S]*?gap:\.5rem;/);
  assert.match(styles, /\.habitGroup--rail-layout \.habitGroupBody \.habitWeekCompleteStack > \.habitRow\.habitRow--week-complete\{[\s\S]*?padding:0;/);
  assert.match(styles, /\.habitGroup--rail-layout \.habitRow--week-complete \.habitDaysRow\.week-complete-row\{[\s\S]*?margin-top:-4px;/);
  assert.match(styles, /@media \(max-width:640px\)[\s\S]*?\.habitGroup--rail-layout \.habitGroupBody \.habitWeekCompleteStack > \.habitRow\.habitRow--week-complete\{[\s\S]*?margin-bottom:1rem;/);
});


test('habit rail groups have no trailing bottom gap after their final habit', () => {
  assert.match(styles, /\.habitGroup--rail-layout \.habitGroupBody\{[\s\S]*?padding:8px 0;/);
  assert.match(styles, /\.habitGroup--rail-layout \.habitGroupBody > \.habitRow:last-child\{[\s\S]*?margin-bottom:0;/);
  assert.match(styles, /\.habitGroup--rail-layout \.habitGroupBody > \.habitWeekCompleteStack:last-child > \.habitRow:last-child\{[\s\S]*?margin-bottom:0;/);
});


test('bottommost silver habit paints through the group bottom breathing room without changing layout', () => {
  assert.match(styles, /\.habitGroup--rail-layout \.habitGroupBody > \.habitWeekCompleteStack:last-child::before\{[\s\S]*?bottom:-8px;/);
  assert.match(styles, /\.habitGroup--rail-layout \.habitGroupBody > \.habitWeekCompleteStack:last-child::after\{[\s\S]*?bottom:-7px;/);
  assert.match(styles, /\.habitGroup--rail-layout \.habitGroupBody > \.habitRow\.habitRow--week-complete:last-child::before\{[\s\S]*?bottom:-8px;/);
});
