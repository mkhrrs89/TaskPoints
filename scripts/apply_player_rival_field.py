from pathlib import Path

GAME = Path('game.html')
TEST = Path('tests/player_rival_field_contract.test.js')

text = GAME.read_text(encoding='utf-8')


def replace_once(old: str, new: str, label: str) -> None:
    global text
    if new in text:
        return
    if old not in text:
        raise SystemExit(f'Could not locate {label}')
    text = text.replace(old, new, 1)


replace_once(
''' .player-editor-field input,
.player-editor-field textarea {
'''.lstrip(),
''' .player-editor-field input,
.player-editor-field textarea,
.player-editor-field select {
'''.lstrip(),
'player editor field styles',
)

replace_once(
'''          </select>
        </div>
      </div>

<div class="create-player-three-col">
''',
'''          </select>
        </div>
      </div>

      <div>
        <label class="text-xs muted">Rival</label>
        <select id="playerRivalId" class="input mt-1">
          <option value="">None</option>
        </select>
      </div>

<div class="create-player-three-col">
''',
'create player rival field',
)

replace_once(
'''function isPlayerActive(player){
  return !!player && player.active !== false;
}

function getAllParticipantIds(){
''',
'''function isPlayerActive(player){
  return !!player && player.active !== false;
}

function buildPlayerRivalOptions({ excludePlayerId = "", selectedRivalId = "" } = {}) {
  const excludedId = String(excludePlayerId || "");
  const selectedId = String(selectedRivalId || "");
  const candidatesById = new Map();

  candidatesById.set("YOU", { id: "YOU", name: getYouName() });
  (Array.isArray(state.players) ? state.players : []).forEach((player) => {
    const id = String(player?.id || "");
    if (!id || candidatesById.has(id)) return;
    candidatesById.set(id, {
      id,
      name: String(player?.name || "Unnamed")
    });
  });

  const candidates = Array.from(candidatesById.values())
    .filter((candidate) => candidate.id !== excludedId)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));

  return [
    '<option value="">None</option>',
    ...candidates.map((candidate) => {
      const selected = candidate.id === selectedId ? " selected" : "";
      return `<option value="${escapeHtmlAttr(candidate.id)}"${selected}>${escapeHtml(candidate.name)}</option>`;
    })
  ].join("");
}

function populateCreatePlayerRivalSelect(selectedRivalId = "") {
  const select = $("playerRivalId");
  if (!select) return;
  const selectedId = String(selectedRivalId || "");
  select.innerHTML = buildPlayerRivalOptions({ selectedRivalId: selectedId });
  select.value = Array.from(select.options).some((option) => option.value === selectedId)
    ? selectedId
    : "";
}

function getAllParticipantIds(){
''',
'rival option helpers',
)

replace_once(
'''      <div class="player-editor-field">
        <label>Style</label>
        <input data-field="style" value="${escapeHtmlAttr(player.style || "")}" />
      </div>
    </div>
''',
'''      <div class="player-editor-field">
        <label>Style</label>
        <input data-field="style" value="${escapeHtmlAttr(player.style || "")}" />
      </div>
      <div class="player-editor-field">
        <label>Rival</label>
        <select data-field="rivalId">
          ${buildPlayerRivalOptions({ excludePlayerId: player.id, selectedRivalId: player.rivalId || "" })}
        </select>
      </div>
    </div>
''',
'edit player rival field',
)

replace_once(
'''const styleInput     = card.querySelector('input[data-field="style"]');
  const primaryColorInput = card.querySelector('input[data-field="primaryColor"]');
''',
'''const styleInput     = card.querySelector('input[data-field="style"]');
const rivalInput     = card.querySelector('select[data-field="rivalId"]');
  const primaryColorInput = card.querySelector('input[data-field="primaryColor"]');
''',
'edit rival input lookup',
)

replace_once(
'''  const style = styleInput
    ? (styleInput.value || "").trim()
    : (player.style || "");
  const primaryColor = normalizePlayerColor(
''',
'''  const style = styleInput
    ? (styleInput.value || "").trim()
    : (player.style || "");
  const rivalId = rivalInput
    ? String(rivalInput.value || "").trim()
    : String(player.rivalId || "").trim();
  const primaryColor = normalizePlayerColor(
''',
'edit rival value',
)

replace_once(
'''player.style    = style || "balanced";
    player.primaryColor = primaryColor;
''',
'''player.style    = style || "balanced";
player.rivalId = rivalId && rivalId !== player.id ? rivalId : "";
    player.primaryColor = primaryColor;
''',
'edit rival persistence',
)

replace_once(
'''  const isActive = $("playerActive").checked;

const baseline = Number($("playerBaseline").value || 60);
''',
'''  const isActive = $("playerActive").checked;
  const rivalId = String($("playerRivalId")?.value || "").trim();

const baseline = Number($("playerBaseline").value || 60);
''',
'create rival value',
)

replace_once(
'''      active: isActive,

baseline: isNaN(baseline) ? 50 : baseline,
''',
'''      active: isActive,
      rivalId,

baseline: isNaN(baseline) ? 50 : baseline,
''',
'create rival persistence',
)

replace_once(
'''$("playerStyle").value = "";
    $("playerPrimaryColor").value = DEFAULT_PRIMARY_COLOR;
''',
'''$("playerStyle").value = "";
    $("playerRivalId").value = "";
    populateCreatePlayerRivalSelect();
    $("playerPrimaryColor").value = DEFAULT_PRIMARY_COLOR;
''',
'create rival reset',
)

replace_once(
'''  const openModal = () => {
    modal.classList.add("is-open");
''',
'''  const openModal = () => {
    populateCreatePlayerRivalSelect($("playerRivalId")?.value || "");
    modal.classList.add("is-open");
''',
'create modal option refresh',
)

replace_once(
'''  window.openCreatePlayerModal = openModal;
  window.closeCreatePlayerModal = closeModal;
  modal.dataset.init = "true";
''',
'''  populateCreatePlayerRivalSelect();
  window.openCreatePlayerModal = openModal;
  window.closeCreatePlayerModal = closeModal;
  modal.dataset.init = "true";
''',
'create modal initial rival options',
)

GAME.write_text(text, encoding='utf-8')

TEST.write_text(r'''const test = require('node:test');
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
''', encoding='utf-8')
