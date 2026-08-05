const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const game = fs.readFileSync(path.join(__dirname, '..', 'game.html'), 'utf8');

function between(start, end) {
  const startIndex = game.indexOf(start);
  const endIndex = game.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  assert.notEqual(endIndex, -1, `missing ${end}`);
  return game.slice(startIndex, endIndex);
}

test('create player modal exposes a Rival dropdown', () => {
  const form = between('<form id="createPlayerForm"', '</form>');
  assert.match(form, /<label class="text-xs muted">Rival<\/label>/);
  assert.match(form, /<select id="playerRivalId"/);
  assert.match(form, /<option value="">None<\/option>/);
});

test('rival options include You and all saved players while excluding the edited player', () => {
  const helper = between('function buildPlayerRivalOptions', 'function getAllParticipantIds');
  assert.match(helper, /candidatesById\.set\("YOU", \{ id: "YOU", name: getYouName\(\) \}\)/);
  assert.match(helper, /Array\.isArray\(state\.players\)/);
  assert.match(helper, /candidate\.id !== excludedId/);
  assert.match(helper, /left\.name\.localeCompare\(right\.name/);
  assert.match(helper, /<option value="">None<\/option>/);
});

test('edit player modal selects and persists rivalId', () => {
  const editor = between('function buildPlayerEditorContent(player)', 'function syncPlayerEditorModalState');
  assert.match(editor, /<label>Rival<\/label>/);
  assert.match(editor, /<select data-field="rivalId">/);
  assert.match(editor, /excludePlayerId: player\.id/);
  assert.match(editor, /selectedRivalId: player\.rivalId/);

  const actions = between('async function handlePlayerAction', 'function escapeHtml(str)');
  assert.match(actions, /querySelector\('select\[data-field="rivalId"\]'\)/);
  assert.match(actions, /player\.rivalId = rivalId && rivalId !== player\.id \? rivalId : ""/);
});

test('create player stores and resets rivalId', () => {
  const submit = between('$("createPlayerForm").addEventListener("submit"', '// Export / Import / Paste / Reset');
  assert.match(submit, /const rivalId = String\(\$\("playerRivalId"\)\?\.value \|\| ""\)\.trim\(\)/);
  assert.match(submit, /active: isActive,\s*rivalId,/);
  assert.match(submit, /\$\("playerRivalId"\)\.value = ""/);
  assert.match(submit, /populateCreatePlayerRivalSelect\(\)/);
});

test('rivalId is only stored by player-form code and is not used by simulation or matchup logic', () => {
  const simulation = between('function simulateToday()', 'function maybeAutoSimToday');
  const scheduling = between('function buildDailySchedule', 'function ensureUpcomingSchedule');
  assert.doesNotMatch(simulation, /rivalId/);
  assert.doesNotMatch(scheduling, /rivalId/);
});
