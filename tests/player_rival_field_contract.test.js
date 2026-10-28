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


test('YOU edit card exposes the same Rival dropdown, excluding YOU itself', () => {
  const render = between('if (editingPlayerId === "YOU") {', '// 🔹 VIEW MODE for YOU');
  assert.match(render, /<label for="youRivalId">Rival<\/label>/);
  assert.match(render, /<select id="youRivalId" data-field="rivalId"/);
  assert.match(render, /buildPlayerRivalOptions\(\{\s*excludePlayerId: "YOU",\s*selectedRivalId: state\.youRivalId \|\| ""\s*\}\)/);
  assert.match(game, /rivalId: typeof state\.youRivalId === "string" \? state\.youRivalId : ""/);
});

test('YOU Done action saves rival alongside existing name, colors and photo', () => {
  const action = between('// --- Done editing YOU ---', 'if (act === "save"){');
  assert.match(action, /select\[data-field="rivalId"\]/);
  assert.match(action, /state\.youRivalId = validRival \? nextRivalId : ""/);
  assert.match(action, /state\.youName = nextName/);
  assert.match(action, /state\.youPrimaryColor = nextPrimaryColor/);
  assert.match(action, /state\.youSecondaryColor = nextSecondaryColor/);
  assert.match(action, /state = saveState\(state,/);
});

test('both core normalizers and game page normalizer preserve YOU rivalId', () => {
  const core = fs.readFileSync(path.join(__dirname, '..', 'scoring_core.js'), 'utf8');
  assert.match(game, /youRivalId: typeof s\.youRivalId === "string" \? s\.youRivalId : ""/);
  assert.equal((core.match(/youRivalId: typeof src\.youRivalId === ["']string["'] \? src\.youRivalId : ["']["']/g) || []).length, 2);
});

test('YOU can select, clear, and change rivals without editing the NPC roster', async () => {
  const action = between('if (act === "done-you") {', 'if (act === "save"){');
  const ctx = {
    state: {
      youName: 'Before',
      youRivalId: '',
      youPrimaryColor: '#123456',
      youSecondaryColor: '#654321',
      youImageId: 'existing-image',
      players: [{ id: 'npc1', name: 'One', rivalId: 'npc2' }, { id: 'npc2', name: 'Two' }]
    },
    editingPlayerId: 'YOU',
    DEFAULT_PRIMARY_COLOR: '#ffffff',
    DEFAULT_SECONDARY_COLOR: '#888888',
    getYouPlayerColors() { return { primaryColor: ctx.state.youPrimaryColor, secondaryColor: ctx.state.youSecondaryColor }; },
    normalizePlayerColor(input, fallback) { return input || fallback; },
    saveState(state, opts) {
      ctx.saveCalls += 1;
      ctx.savedOptions = opts;
      return JSON.parse(JSON.stringify(state));
    },
    renderPlayers() { ctx.renderCalls += 1; },
    saveCalls: 0,
    renderCalls: 0
  };
  const run = new Function('ctx', 'with(ctx) { return async function (btn) { const act = "done-you"; ' + action + ' } }')(ctx);
  let selected = 'npc1';
  const card = {
    querySelector(selector) {
      if (selector === 'select[data-field="rivalId"]') return { value: selected };
      if (selector === 'input[data-field="you-name"]') return { value: 'Updated You' };
      if (selector === 'input[data-field="primaryColor"]') return { value: '#aabbcc' };
      if (selector === 'input[data-field="secondaryColor"]') return { value: '#334455' };
      return null;
    }
  };
  const btn = { closest: () => card };
  await run(btn);
  assert.equal(ctx.state.youRivalId, 'npc1');
  assert.equal(ctx.state.youName, 'Updated You');
  assert.equal(ctx.state.youImageId, 'existing-image');
  assert.equal(ctx.state.players[0].rivalId, 'npc2', 'Existing NPC rivals must not be overwritten');
  assert.equal(ctx.state.youPrimaryColor, '#aabbcc');
  assert.equal(ctx.state.youSecondaryColor, '#334455');

  selected = 'npc2';
  await run(btn);
  assert.equal(ctx.state.youRivalId, 'npc2');

  selected = '';
  await run(btn);
  assert.equal(ctx.state.youRivalId, '', 'None should clear previous rival');

  selected = 'YOU';
  await run(btn);
  assert.equal(ctx.state.youRivalId, '', 'YOU cannot rival yourself');

  selected = 'deleted-npc';
  await run(btn);
  assert.equal(ctx.state.youRivalId, '', 'Do not persist an invalid NPC ID');

  assert.equal(ctx.saveCalls, 5);
  assert.equal(ctx.renderCalls, 5);
  assert.equal(ctx.editingPlayerId, null);
  assert.deepEqual(ctx.savedOptions.allowStickyOverwriteKeys,
    ['youImageId', 'youName', 'youPrimaryColor', 'youSecondaryColor']);
});

test('YOU Rival dropdown reuses the NPC option builder and selects existing choice', () => {
  const src = between('function buildPlayerRivalOptions', 'function populateCreatePlayerRivalSelect');
  const ctx = {
    state: { players: [{ id: 'npc2', name: 'Beta' }, { id: 'npc1', name: 'Alpha' }] },
    getYouName: () => 'Me',
    escapeHtmlAttr: x => x,
    escapeHtml: x => x
  };
  const makeOptions = new Function('ctx', 'with(ctx) {' + src + '; return buildPlayerRivalOptions;}')(ctx);
  const result = makeOptions({ excludePlayerId: 'YOU', selectedRivalId: 'npc2' });
  assert.match(result, /<option value="">None<\/option>/);
  assert.match(result, /<option value="npc1">Alpha<\/option>/);
  assert.match(result, /<option value="npc2" selected>Beta<\/option>/);
  assert.doesNotMatch(result, /<option value="YOU"/);
});
