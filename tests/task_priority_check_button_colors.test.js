import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('critical task check button is white with a red checkmark', () => {
  assert.match(styles, /\.critical-card \.btn-check,[\s\S]*?background:linear-gradient\([\s\S]*?#ffffff,[\s\S]*?#9ca3af[\s\S]*?\) !important;[\s\S]*?color:#b91c1c !important;/);
});

test('high task check button uses the same translucent orange-brown gradient as the high task card', () => {
  const highCard = styles.match(/\.high-card \{[\s\S]*?rgba\(180, 83, 9, 0\.24\)[\s\S]*?rgba\(120, 52, 4, 0\.16\)[\s\S]*?\}/)?.[0] || '';
  const highButton = styles.match(/\.high-card \.btn-check,[\s\S]*?rgba\(180, 83, 9, 0\.24\)[\s\S]*?rgba\(120, 52, 4, 0\.16\)[\s\S]*?\}/)?.[0] || '';
  assert.ok(highCard, 'high task card gradient should remain present');
  assert.ok(highButton, 'high task button should reuse the card gradient alpha values');
});
