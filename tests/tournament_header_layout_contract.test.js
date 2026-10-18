const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'tournament.html'), 'utf8');
const header = html.split('<header class="mb-3">')[1]?.split('</header>')[0];

test('Tournament header no longer contains its four redundant top links', () => {
  assert.ok(header, 'Tournament header exists');
  for (const href of ['notes.html', 'projects.html', 'skills.html', 'tournament.html']) {
    assert.doesNotMatch(header, new RegExp('<a href="' + href.replace('.', '\\.') + '"'));
  }
  assert.doesNotMatch(html, /Season Championship bracket view\./);
});

test('Tournament mobile header clears the phone status bar without moving other pages', () => {
  assert.match(html, /class="tournament-page-frame mx-auto max-w-6xl/);
  assert.match(html, /@media \(max-width: 767px\)\s*\{\s*\.tournament-page-frame\s*\{\s*padding-top: max\(64px, calc\(env\(safe-area-inset-top, 0px\) \+ 14px\)\);/);
  assert.match(html, /<img src="assets\/taskpoints-logo\.png" alt="TaskPoints logo"/);
});

test('Tournament header cleanup preserves Export, Import and the championship bracket', () => {
  assert.match(html, /data-export-button/);
  assert.match(html, /data-import-input/);
  assert.match(html, /id="tournamentBracket"/);
  assert.match(html, /class="tournament-bracket-scroll"/);
  assert.match(html, /<h2 class="text-lg font-semibold mb-1">Tournament<\/h2>/);
  assert.match(html, /Current Season tournament bracket view\./);
  assert.match(html, /<a href="season\.html" class="btn btn-teal btn-toolbar nav-btn">Season<\/a>/);
  assert.match(html, /<a href="settings\.html" class="btn btn-teal btn-toolbar nav-btn">Settings<\/a>/);
});
