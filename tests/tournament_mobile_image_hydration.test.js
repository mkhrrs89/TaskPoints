const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tournamentHtml = fs.readFileSync(path.join(__dirname, '..', 'tournament.html'), 'utf8');
const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

test('applyTournamentImageSlot preserves image DOM when player and image id are unchanged', () => {
  assert.match(tournamentHtml, /function\s+applyTournamentImageSlot/);
  assert.match(tournamentHtml, /const\s+previousPlayerId\s*=\s*slot\.getAttribute\('data-tourney-player-id'\)/);
  assert.match(tournamentHtml, /const\s+previousImageId\s*=\s*slot\.getAttribute\('data-tourney-image-id'\)/);
  assert.match(tournamentHtml, /previousPlayerId\s*===\s*playerId\s*&&\s*previousImageId\s*===\s*nextImageId\s*&&\s*existingImg/);
  assert.match(tournamentHtml, /updateTournamentPlayerMeta\(node,\s*state,\s*playerId,\s*series,\s*side,\s*slot\)/);
});

test('changing to a different tournament image reuses the slot structure and resets stale src', () => {
  assert.match(tournamentHtml, /function\s+ensureTournamentImageElement/);
  assert.match(tournamentHtml, /let\s+wrapper\s*=\s*node\.querySelector\(':scope > \.tourney-player-image-slot'\)\s*\|\|\s*slot\.querySelector\('\.tourney-player-image-slot'\)/);
  assert.match(tournamentHtml, /let\s+img\s*=\s*wrapper\.querySelector\('img\.tourney-player-image'\)/);
  assert.match(tournamentHtml, /previousImageId\s*&&\s*previousImageId\s*!==\s*nextImageId\)\s*img\.removeAttribute\('src'\)/);
});

test('hydrateTournamentImages hydrates each slot independently and guards against stale async results', () => {
  assert.match(tournamentHtml, /const\s+hydrations\s*=\s*slots\.map/);
  assert.doesNotMatch(tournamentHtml, /await\s+Promise\.all\(imageIds\.map/);
  assert.match(tournamentHtml, /loadTournamentImageUrl\(imageId\)\.then\(\(url\)\s*=>/);
  assert.match(tournamentHtml, /slot\.getAttribute\('data-tourney-image-id'\)\s*!==\s*imageId/);
  assert.match(tournamentHtml, /if\s*\(img\.src\s*!==\s*url\)\s*img\.src\s*=\s*url/);
});

test('rendered tournament bracket markup is stable across page refresh renders', () => {
  assert.match(tournamentHtml, /data-tournament-bracket-rendered/);
  assert.match(tournamentHtml, /bracket\.getAttribute\('data-tournament-bracket-rendered'\)\s*===\s*'true'\s*&&\s*bracket\.querySelector\('\.tournament-slot'\)/);
  assert.doesNotMatch(tournamentHtml, /bracket\.innerHTML\s*=\s*''/);
});


test('scroll and lifecycle listeners do not rebuild tournament images during normal bracket scrolling', () => {
  assert.doesNotMatch(tournamentHtml, /addEventListener\('scroll'[\s\S]*renderTournament(?:Page|Images)\(/);
  assert.doesNotMatch(tournamentHtml, /new\s+IntersectionObserver[\s\S]*renderTournament(?:Page|Images)\(/);
  assert.match(tournamentHtml, /window\.addEventListener\('resize',\s*debounceTournamentConnectorDraw\(100\)\)/);
  assert.doesNotMatch(tournamentHtml, /window\.addEventListener\('resize',[\s\S]{0,120}renderTournament(?:Page|Images)\(/);
});

test('mobile bracket layout reserves the full 32-row height and avoids lazy content visibility', () => {
  assert.match(stylesCss, /\.tournament-bracket\s*{[\s\S]*min-height:\s*calc\(32 \* var\(--bracket-row-size\)\);/);
  assert.doesNotMatch(stylesCss, /content-visibility:\s*auto/);
});
