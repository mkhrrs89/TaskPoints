const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tournamentHtml = fs.readFileSync(path.join(__dirname, '..', 'tournament.html'), 'utf8');
const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

test('live Tourney image renderer uses the shared player node with seed and wins meta', () => {
  assert.match(tournamentHtml, /function\s+renderTournamentPlayerNodeHTML/);
  assert.match(tournamentHtml, /class="tourney-player-node"/);
  assert.match(tournamentHtml, /class="tourney-player-meta"/);
  assert.match(tournamentHtml, /class="tourney-player-seed"/);
  assert.match(tournamentHtml, /class="tourney-player-wins"/);
  assert.match(tournamentHtml, /function\s+ensureTournamentImageElement/);
  assert.match(tournamentHtml, /function\s+updateTournamentPlayerMeta/);
});

test('live Tourney Round of 32 scaffold no longer creates standalone seed labels', () => {
  assert.doesNotMatch(tournamentHtml, /row\.appendChild\(createTournamentElement\('span', \{\}, \['tournament-seed'\]\)\)/);
  assert.match(tournamentHtml, /function\s+createTournamentSlotRow\(slotOptions\)\s*{[\s\S]*row\.appendChild\(createTournamentSlot\(slotOptions\)\)/);
});

test('Tourney player meta CSS stacks seed over wins immediately left of the image', () => {
  assert.match(stylesCss, /\.tourney-player-node\s*{[\s\S]*display:\s*inline-flex;[\s\S]*gap:\s*5px;/);
  assert.match(stylesCss, /\.tourney-player-meta\s*{[\s\S]*flex-direction:\s*column;[\s\S]*min-width:\s*var\(--seed-width\);/);
  assert.match(stylesCss, /\.tourney-player-image-slot\s*{[\s\S]*flex:\s*0 0 var\(--slot-width\);/);
});
