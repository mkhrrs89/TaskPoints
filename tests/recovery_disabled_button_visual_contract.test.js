const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'verified_secondary_recovery.html'), 'utf8');

function inlineScripts(source) {
  return [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .filter((script) => script.trim());
}

test('verified-secondary preview keeps exact-match restore visibly and functionally disabled', () => {
  inlineScripts(html).forEach((script) => assert.doesNotThrow(() => new vm.Script(script)));
  assert.match(html, /\.actions button:disabled\{/);
  assert.match(html, /cursor:not-allowed!important/);
  assert.match(html, /<button id="restoreLink"[^>]*disabled>Restore unavailable<\/button>/);
  assert.match(html, /exactRawMatch[\s\S]*Restore unavailable — copies match/);
  assert.match(html, /if\(!exactRawMatch\)\{\$\('restoreLink'\)\.disabled=false;\$\('restoreLink'\)\.textContent='Begin confirmed restore';\}/);
  assert.match(html, /if\(!\$\('restoreLink'\)\.disabled\)global\.location\.href='verified_secondary_restore\.html'/);
});
