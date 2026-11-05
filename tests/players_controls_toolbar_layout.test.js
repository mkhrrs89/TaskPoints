const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'game.html'), 'utf8');
const begin = source.indexOf('<!-- Compact responsive roster controls:');
const end = source.indexOf('<!-- NOTE: we', begin);
const toolbar = source.slice(begin, end);

test('mobile toolbar presents view/group controls above aligned columns/sort fields', () => {
  assert.ok(begin > 0 && end > begin);
  assert.match(toolbar, /class="players-controls-toolbar/);
  assert.match(toolbar, /class="players-controls-primary"/);
  assert.match(toolbar, /class="players-controls-secondary"/);
  const primary = toolbar.indexOf('players-controls-primary');
  const secondary = toolbar.indexOf('players-controls-secondary');
  const count = toolbar.indexOf('id="playerCount"');
  assert.ok(primary >= 0 && primary < secondary && secondary < count);
  for (const id of ['viewCardBtn', 'viewGalleryBtn', 'groupActiveToggle', 'galleryColumnsControl',
    'galleryColumnsSelect', 'playerSort', 'playerCount']) {
    assert.equal((toolbar.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, id);
  }
  assert.doesNotMatch(toolbar, /<h2[^>]*>Players<\/h2>/);
});

test('buttons and group toggle remain accessible and show the default gallery state', () => {
  assert.match(toolbar, /id="viewCardBtn"[^>]*aria-label="Card view" aria-pressed="false"/);
  assert.match(toolbar, /id="viewGalleryBtn"[^>]*aria-label="Gallery view" aria-pressed="true"/);
  assert.match(toolbar, /<label class="players-group-control" for="groupActiveToggle">/);
  assert.match(toolbar, /id="groupActiveToggle"[^>]*type="checkbox"/);
  assert.match(source, /viewCardBtn\.setAttribute\("aria-pressed", String\(viewMode === "card"\)\)/);
  assert.match(source, /viewGalleryBtn\.setAttribute\("aria-pressed", String\(viewMode === "gallery"\)\)/);
  assert.match(source, /let viewMode = "gallery"/);
});

test('mobile column and sort options are intact and preserve existing user preferences', () => {
  assert.match(toolbar, /id="galleryColumnsControl"\s+class="flex sm:hidden/);
  assert.match(toolbar, /label for="galleryColumnsSelect">Columns<\/label>/);
  assert.match(toolbar, /id="galleryColumnsSelect"/);
  assert.match(toolbar, /<option value="2">2 cols<\/option>/);
  assert.match(toolbar, /<option value="3">3 cols<\/option>/);
  assert.match(toolbar, /id="playerSort"/);
  for (const mode of ['name-asc', 'name-desc', 'pid-asc', 'pid-desc', 'avg-desc',
    'overall-desc', 'ranking-asc', 'baseline-desc', 'created-desc', 'created-asc']) {
    assert.match(toolbar, new RegExp('option value="' + mode + '"'));
  }
  assert.match(source, /function persistGalleryColumns\(next\)/);
  assert.match(source, /persistGroupActivePlayers\(e\.target\.checked\)/);
  assert.match(source, /persistSortMode\(mode\)/);
  assert.match(source, /galleryColumnsControl\.classList\.toggle\("hidden", viewMode !== "gallery"\)/);
});

test('toolbar CSS uses responsive, constrained fields rather than sprawling full-width selectors', () => {
  assert.match(source, /\.players-controls-primary\s*,\s*\.players-controls-secondary\s*\{/);
  assert.match(source, /\.players-controls-secondary\s*\{\s*margin-top: 10px; align-items: flex-end;/);
  assert.match(source, /\.players-columns-control\s*\{\s*flex: 0 0 94px/);
  assert.match(source, /\.players-sort-control\s*\{\s*display: flex; flex: 1 1 0; min-width: 0/);
  assert.match(source, /@media \(max-width: 360px\)/);
  assert.match(source, /@media \(prefers-color-scheme: dark\)/);
  assert.match(source, /\.players-controls-footer/);
});

test('game script still parses and the existing roster rendering is present', () => {
  const scripts = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(Boolean);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
  assert.match(source, /function renderPlayers\(/);
  assert.match(source, /if \(viewGalleryBtn\)/);
  assert.match(source, /if \(viewCardBtn\)/);
  assert.match(source, /if \(galleryColumnsSelect\)/);
  assert.match(source, /if \(groupActiveToggle\)/);
});
