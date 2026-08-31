const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'streaks.html'), 'utf8');

test('streak tables expose aligned bonus total slots', () => {
  assert.equal((source.match(/data-streak-bonus-total/g) || []).length >= 2, true);
  assert.match(source, /grid-template-columns:\s*41%\s+25%\s+18%\s+16%/);
});

test('streak bonus totals sum the rendered table row bonuses', () => {
  assert.match(source, /tableRows\.reduce\(\(total, row\) => total \+ \(Number\(row\?\.bonus\) \|\| 0\), 0\)/);
  assert.match(source, /context\.bonusTotal\.textContent = bonusText\(bonusTotal\)/);
});
