import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('critical task check button is white with a red checkmark', () => {
  assert.match(styles, /\.critical-card \.btn-check,[\s\S]*?background:linear-gradient\([\s\S]*?#ffffff,[\s\S]*?#9ca3af[\s\S]*?\) !important;[\s\S]*?color:#b91c1c !important;/);
});

test('critical task check glyph is extra bold without thickening other priority buttons', () => {
  const critical = styles.match(/\.critical-card \.btn-check,\s*\.critical-card \.btn-check:hover\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(critical, /font-weight:900 !important;/);
  assert.match(critical, /-webkit-text-stroke:1\.6px currentColor;/);
  assert.match(critical, /color:#b91c1c !important;/);
  assert.match(critical, /#ffffff/);
  const high = styles.match(/\.high-card \.btn-check,\s*\.high-card \.btn-check:hover\s*\{([^}]+)\}/)?.[1] || '';
  assert.doesNotMatch(high, /-webkit-text-stroke|font-weight:900/);
});

test('high task check button uses the same translucent orange-brown gradient as the high task card', () => {
  const highCard = styles.match(/\.high-card \{[\s\S]*?rgba\(180, 83, 9, 0\.24\)[\s\S]*?rgba\(120, 52, 4, 0\.16\)[\s\S]*?\}/)?.[0] || '';
  const highButton = styles.match(/\.high-card \.btn-check,[\s\S]*?rgba\(180, 83, 9, 0\.24\)[\s\S]*?rgba\(120, 52, 4, 0\.16\)[\s\S]*?\}/)?.[0] || '';
  assert.ok(highCard, 'high task card gradient should remain present');
  assert.ok(highButton, 'high task button should reuse the card gradient alpha values');
});
