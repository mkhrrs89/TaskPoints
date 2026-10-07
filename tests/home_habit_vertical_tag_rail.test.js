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
