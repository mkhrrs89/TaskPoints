from pathlib import Path

path = Path('season.js')
text = path.read_text(encoding='utf-8')

old = """  const AUTO_SEED_MODE = 'auto';
  const MANUAL_SEED_MODE = 'manual';
"""
new = """  const AUTO_SEED_MODE = 'auto';
  const MANUAL_SEED_MODE = 'manual';
  const SEED_RANKING_SCOPE_OVERALL = 'overall';
  const SEED_RANKING_SCOPE_SEASON_ONE = 'season1';
  const SEED_RANKING_SCOPE_SEASON_TWO = 'season2';
  const SEASON_TWO_RANKINGS_START_DATE = '2026-07-01';
  const SEED_RANKING_SCOPE_LABELS = {
    [SEED_RANKING_SCOPE_SEASON_TWO]: 'Season 2 rankings',
    [SEED_RANKING_SCOPE_SEASON_ONE]: 'Season 1 rankings',
    [SEED_RANKING_SCOPE_OVERALL]: 'Overall rankings'
  };
"""
assert text.count(old) == 1
text = text.replace(old, new, 1)

old = """  function nowIso(options = {}) {
    return typeof options.nowISO === 'string' ? options.nowISO : new Date().toISOString();
  }

"""
new = """  function nowIso(options = {}) {
    return typeof options.nowISO === 'string' ? options.nowISO : new Date().toISOString();
  }

  function normalizeSeedRankingScope(value, season = null) {
    const scope = String(value || '').trim().toLowerCase();
    if ([SEED_RANKING_SCOPE_OVERALL, SEED_RANKING_SCOPE_SEASON_ONE, SEED_RANKING_SCOPE_SEASON_TWO].includes(scope)) return scope;
    if (season?.id === SEASON_TWO_ID || season?.name === SEASON_TWO_NAME || season?.monthKey === SEASON_TWO_MONTH_KEY) return SEED_RANKING_SCOPE_SEASON_TWO;
    if (season?.id === SEASON_ONE_ID || season?.name === SEASON_ONE_NAME || season?.monthKey === SEASON_ONE_MONTH_KEY) return SEED_RANKING_SCOPE_SEASON_ONE;
    return SEED_RANKING_SCOPE_OVERALL;
  }

  function getSeedRankingScopeLabel(scope) {
    return SEED_RANKING_SCOPE_LABELS[normalizeSeedRankingScope(scope)] || SEED_RANKING_SCOPE_LABELS[SEED_RANKING_SCOPE_OVERALL];
  }

  function getSeedRankingDateKey(row) {
    const value = row?.dateKey || row?.date || row?.completedAtISO || row?.dateISO || row?.createdAtISO || '';
    return value ? String(value).slice(0, 10) : '';
  }

  function seedRankingScopeAllowsDate(scope, dateKey) {
    const key = String(dateKey || '').slice(0, 10);
    if (!key) return false;
    const normalizedScope = normalizeSeedRankingScope(scope);
    if (normalizedScope === SEED_RANKING_SCOPE_OVERALL) return true;
    if (normalizedScope === SEED_RANKING_SCOPE_SEASON_ONE) return key < SEASON_TWO_RANKINGS_START_DATE;
    return key >= SEASON_TWO_RANKINGS_START_DATE;
  }

  function getScopedSeedRankingState(state, scope) {
    const normalizedScope = normalizeSeedRankingScope(scope, state?.currentSeason);
    if (normalizedScope === SEED_RANKING_SCOPE_OVERALL) return state || {};
    const filterRows = (rows) => (Array.isArray(rows) ? rows : []).filter((row) => seedRankingScopeAllowsDate(normalizedScope, getSeedRankingDateKey(row)));
    return {
      ...(state || {}),
      matchups: filterRows(state?.matchups),
      gameHistory: filterRows(state?.gameHistory),
      completions: filterRows(state?.completions)
    };
  }

  function renderSeedRankingScopeOptions(selectedScope) {
    const selected = normalizeSeedRankingScope(selectedScope);
    return [SEED_RANKING_SCOPE_SEASON_TWO, SEED_RANKING_SCOPE_SEASON_ONE, SEED_RANKING_SCOPE_OVERALL]
      .map((scope) => `<option value="${scope}"${scope === selected ? ' selected' : ''}>${escapeHtml(SEED_RANKING_SCOPE_LABELS[scope])}</option>`)
      .join('');
  }

"""
assert text.count(old) == 1
text = text.replace(old, new, 1)

old = """  function createSeasonOnePreview(state, options = {}) {
    const projected = generateProjectedSeeds(state || {});
    const now = nowIso(options);
"""
new = """  function createSeasonOnePreview(state, options = {}) {
    const rankingScope = SEED_RANKING_SCOPE_SEASON_ONE;
    const projected = generateProjectedSeeds(getScopedSeedRankingState(state || {}, rankingScope));
    const now = nowIso(options);
"""
assert text.count(old) == 1
text = text.replace(old, new, 1)

old = """       status: 'preview',
       seedMode: AUTO_SEED_MODE,
       createdAtISO: now,
"""
new = """       status: 'preview',
       seedMode: AUTO_SEED_MODE,
       seedRankingScope: rankingScope,
       createdAtISO: now,
"""
assert text.count(old) == 1
text = text.replace(old, new, 1)

old = """  function rebuildPreviewFromStandings(state, season, options = {}) {
    const projected = generateProjectedSeeds(state || {});
    return {
      ...(season || {}),
      seedMode: AUTO_SEED_MODE,
      playerPool: getPlayerPool(state || {}),
      seeds: projected.seeds,
      bracket: buildProjectedBracket(projected.seeds),
      warnings: projected.warnings,
      updatedAtISO: nowIso(options)
    };
  }
"""
new = """  function rebuildPreviewFromStandings(state, season, options = {}) {
    const rankingScope = normalizeSeedRankingScope(options.rankingScope || season?.seedRankingScope, season);
    const scopedState = getScopedSeedRankingState(state || {}, rankingScope);
    const projected = generateProjectedSeeds(scopedState);
    return {
      ...(season || {}),
      seedMode: AUTO_SEED_MODE,
      seedRankingScope: rankingScope,
      playerPool: getPlayerPool(state || {}),
      seeds: projected.seeds,
      bracket: buildProjectedBracket(projected.seeds),
      warnings: projected.warnings,
      updatedAtISO: nowIso(options)
    };
  }
"""
assert text.count(old) == 1
text = text.replace(old, new, 1)

old = """  function buildManualSeasonPreview(state, options = {}) {
    const activePool = getPlayerPool(state || {});
    const includedIds = Array.isArray(options.playerIds) && options.playerIds.length
      ? new Set(options.playerIds)
      : new Set(activePool.map((player) => player.id || player.playerId).filter(Boolean));
    const playerPool = activePool.filter((player) => includedIds.has(player.id || player.playerId));
    const startDate = typeof options.startDate === 'string' && options.startDate ? options.startDate : getDateKey(new Date());
    const endDate = typeof options.endDate === 'string' && options.endDate ? options.endDate : startDate;
    const monthKey = startDate.slice(0, 7);
    const name = typeof options.name === 'string' && options.name.trim() ? options.name.trim() : 'Manual Season Championship';
    const projected = generateProjectedSeeds({ ...(state || {}), players: playerPool.filter((player) => (player.id || player.playerId) !== 'YOU') });
    const seeds = playerPool.map((player, index) => {
      const playerId = player.id || player.playerId;
      const projectedRow = projected.seeds.find((seed) => seed.playerId === playerId) || {};
      return {
        ...projectedRow,
        seed: index + 1,
        playerId,
        id: playerId,
        playerName: player.name || projectedRow.playerName || playerId,
        name: player.name || projectedRow.name || playerId,
        imageId: player.imageId || projectedRow.imageId || getPlayerImageId(state || {}, playerId),
        wins: projectedRow.wins || 0,
        losses: projectedRow.losses || 0,
        winPct: projectedRow.winPct || 0,
        totalPoints: projectedRow.totalPoints || 0,
        averageScore: projectedRow.averageScore || 0,
        marginOfVictory: projectedRow.marginOfVictory ?? null,
        warningFlags: Array.isArray(projectedRow.warningFlags) ? projectedRow.warningFlags : []
      };
    });
"""
new = """  function buildManualSeasonPreview(state, options = {}) {
    const activePool = getPlayerPool(state || {});
    const includedIds = Array.isArray(options.playerIds) && options.playerIds.length
      ? new Set(options.playerIds)
      : new Set(activePool.map((player) => player.id || player.playerId).filter(Boolean));
    const playerPool = activePool.filter((player) => includedIds.has(player.id || player.playerId));
    const startDate = typeof options.startDate === 'string' && options.startDate ? options.startDate : getDateKey(new Date());
    const endDate = typeof options.endDate === 'string' && options.endDate ? options.endDate : startDate;
    const monthKey = startDate.slice(0, 7);
    const name = typeof options.name === 'string' && options.name.trim() ? options.name.trim() : 'Manual Season Championship';
    const rankingScope = normalizeSeedRankingScope(options.rankingScope, { monthKey, name });
    const rankingState = getScopedSeedRankingState({ ...(state || {}), players: playerPool.filter((player) => (player.id || player.playerId) !== 'YOU') }, rankingScope);
    const projected = generateProjectedSeeds(rankingState);
    const playerById = new Map(playerPool.map((player) => [player.id || player.playerId, player]));
    const orderedPlayers = projected.seeds.map((seed) => playerById.get(seed.playerId)).filter(Boolean);
    const orderedIds = new Set(orderedPlayers.map((player) => player.id || player.playerId));
    playerPool.forEach((player) => {
      if (!orderedIds.has(player.id || player.playerId)) orderedPlayers.push(player);
    });
    const seeds = orderedPlayers.map((player, index) => {
      const playerId = player.id || player.playerId;
      const projectedRow = projected.seeds.find((seed) => seed.playerId === playerId) || {};
      return {
        ...projectedRow,
        seed: index + 1,
        playerId,
        id: playerId,
        playerName: player.name || projectedRow.playerName || playerId,
        name: player.name || projectedRow.name || playerId,
        imageId: player.imageId || projectedRow.imageId || getPlayerImageId(state || {}, playerId),
        wins: projectedRow.wins || 0,
        losses: projectedRow.losses || 0,
        winPct: projectedRow.winPct || 0,
        totalPoints: projectedRow.totalPoints || 0,
        averageScore: projectedRow.averageScore || 0,
        marginOfVictory: projectedRow.marginOfVictory ?? null,
        warningFlags: Array.isArray(projectedRow.warningFlags) ? projectedRow.warningFlags : []
      };
    });
"""
assert text.count(old) == 1
text = text.replace(old, new, 1)

old = """  status: 'preview',
  seedMode: MANUAL_SEED_MODE,
  playerPool,
"""
new = """  status: 'preview',
  seedMode: MANUAL_SEED_MODE,
  seedRankingScope: rankingScope,
  playerPool,
"""
assert text.count(old) == 1
text = text.replace(old, new, 1)

old = """  function renderSeedList(season, state = {}) {
    const seeds = Array.isArray(season?.seeds) ? season.seeds : [];
    return `
"""
new = """  function renderSeedList(season, state = {}) {
    const seeds = Array.isArray(season?.seeds) ? season.seeds : [];
    const selectedRankingScope = normalizeSeedRankingScope(season?.seedRankingScope, season);
    const selectedRankingLabel = getSeedRankingScopeLabel(selectedRankingScope);
    return `
"""
assert text.count(old) == 1
text = text.replace(old, new, 1)

old = """            <h3 class="season-section-title">Projected Seeds</h3>
            <p class="muted text-sm">Drag a row to freeze and manually edit seed order.</p>
          </div>
          <button type="button" class="btn btn-teal btn-toolbar" data-season-action="rebuild-toggle">Rebuild Preview</button>
        </div>
        <div class="season-rebuild-panel" data-season-rebuild-panel hidden>
          <p class="muted text-sm">Choose how to rebuild this dormant preview.</p>
          <div class="season-rebuild-actions">
            <button type="button" class="btn btn-success btn-toolbar" data-season-action="rebuild-standings">Rebuild from current standings</button>
            <button type="button" class="btn btn-ghost btn-toolbar" data-season-action="rebuild-manual">Rebuild from current manual seed order</button>
            <button type="button" class="btn btn-ghost btn-toolbar" data-season-action="rebuild-cancel">Cancel</button>
          </div>
        </div>
"""
new = """            <h3 class="season-section-title">Projected Seeds</h3>
            <p class="muted text-sm">Drag a row to freeze and manually edit seed order. Current ranking source: ${escapeHtml(selectedRankingLabel)}.</p>
          </div>
          <button type="button" class="btn btn-teal btn-toolbar" data-season-action="rebuild-toggle">Rebuild Preview</button>
        </div>
        <div class="season-rebuild-panel" data-season-rebuild-panel hidden>
          <p class="muted text-sm">Choose a ranking source, or keep the current manual seed order.</p>
          <div class="season-rebuild-actions">
            <label class="muted text-xs">Ranking source
              <select class="season-admin-input" data-season-ranking-scope>
                ${renderSeedRankingScopeOptions(selectedRankingScope)}
              </select>
            </label>
            <button type="button" class="btn btn-success btn-toolbar" data-season-action="rebuild-standings">Rebuild from selected rankings</button>
            <button type="button" class="btn btn-ghost btn-toolbar" data-season-action="rebuild-manual">Rebuild from current manual seed order</button>
            <button type="button" class="btn btn-ghost btn-toolbar" data-season-action="rebuild-cancel">Cancel</button>
          </div>
        </div>
"""
assert text.count(old) == 1
text = text.replace(old, new, 1)

old = """<label class="muted text-xs">Season name <input class="season-admin-input" type="text" data-create-season-name value="Season 2"></label>
<label class="muted text-xs">Start date <input class="season-admin-input" type="date" data-create-season-start value="2026-08-01"></label>
<label class="muted text-xs">End date <input class="season-admin-input" type="date" data-create-season-end value="2026-08-31"></label>
"""
new = """<label class="muted text-xs">Season name <input class="season-admin-input" type="text" data-create-season-name value="Season 2"></label>
<label class="muted text-xs">Start date <input class="season-admin-input" type="date" data-create-season-start value="2026-08-01"></label>
<label class="muted text-xs">End date <input class="season-admin-input" type="date" data-create-season-end value="2026-08-31"></label>
<label class="muted text-xs">Initial seed ranking source
  <select class="season-admin-input" data-create-season-ranking-scope>
    ${renderSeedRankingScopeOptions(SEED_RANKING_SCOPE_SEASON_TWO)}
  </select>
</label>
"""
assert text.count(old) == 1
text = text.replace(old, new, 1)

old = """      if (action === 'rebuild-standings' || action === 'rebuild-manual') {
        const state = currentMountedState();
        const season = action === 'rebuild-standings'
          ? rebuildPreviewFromStandings(state, state.currentSeason)
          : rebuildPreviewFromManualOrder(state.currentSeason);
        saveAndRenderSeason({ ...state, currentSeason: season }, action === 'rebuild-standings' ? 'season-rebuild-standings' : 'season-rebuild-manual');
        return;
      }
"""
new = """      if (action === 'rebuild-standings' || action === 'rebuild-manual') {
        const state = currentMountedState();
        const rankingScope = normalizeSeedRankingScope(root.querySelector('[data-season-ranking-scope]')?.value, state.currentSeason);
        const season = action === 'rebuild-standings'
          ? rebuildPreviewFromStandings(state, state.currentSeason, { rankingScope })
          : rebuildPreviewFromManualOrder(state.currentSeason);
        saveAndRenderSeason({ ...state, currentSeason: season }, action === 'rebuild-standings' ? `season-rebuild-${rankingScope}-rankings` : 'season-rebuild-manual');
        return;
      }
"""
assert text.count(old) == 1
text = text.replace(old, new, 1)

old = """          endDate: root.querySelector('[data-create-season-end]')?.value,
          playerIds
"""
new = """          endDate: root.querySelector('[data-create-season-end]')?.value,
          rankingScope: root.querySelector('[data-create-season-ranking-scope]')?.value,
          playerIds
"""
assert text.count(old) == 1
text = text.replace(old, new, 1)

old = """    getSeasonSummaryLine,
    generateProjectedSeeds,
"""
new = """    getSeasonSummaryLine,
    normalizeSeedRankingScope,
    getSeedRankingScopeLabel,
    getScopedSeedRankingState,
    generateProjectedSeeds,
"""
assert text.count(old) == 1
text = text.replace(old, new, 1)

path.write_text(text, encoding='utf-8')

verified = path.read_text(encoding='utf-8')
assert verified.count('data-season-ranking-scope') == 2
assert verified.count('data-create-season-ranking-scope') == 2
assert verified.count("const SEASON_TWO_RANKINGS_START_DATE = '2026-07-01';") == 1
assert verified.count('function getScopedSeedRankingState') == 1
assert verified.count('seedRankingScope: rankingScope') == 3
assert 'Rebuild from current standings' not in verified

for trigger in Path('.github/automation-triggers').glob('season-ranking-source*.txt'):
    trigger.unlink()
Path(__file__).unlink()
