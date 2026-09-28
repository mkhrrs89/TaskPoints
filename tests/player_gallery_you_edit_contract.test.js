const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'game.html'), 'utf8');

test('gallery avatar click routes YOU into the existing self-profile editor', () => {
  const galleryStart = source.indexOf('// ----- GALLERY VIEW (image + name only) -----');
  const galleryEnd = source.indexOf('// ----- CARD VIEW', galleryStart);
  assert.ok(galleryStart >= 0 && galleryEnd > galleryStart);

  const gallery = source.slice(galleryStart, galleryEnd);
  assert.match(gallery, /imgArea\.addEventListener\("click", \(\) => \{/);
  assert.match(gallery, /if \(p\.isYou\) \{/);
  assert.match(gallery, /editingPlayerId = "YOU";/);
  assert.match(gallery, /viewMode = "card";/);
  assert.match(gallery, /renderPlayers\(\);/);
  assert.match(gallery, /updateViewToggleUI\(\);/);
  assert.match(gallery, /openPlayerEditor\(p\.id\);/);
});

test('NPC modal editor still resolves normal players from state.players', () => {
  assert.match(source, /function openPlayerEditor\(playerId\) \{\s*const player = state\.players\.find\(\(p\) => p\.id === playerId\);/);
});
