(function (global) {
  'use strict';

  const core = global.TaskPointsCore || {};
  const seasonApi = global.TaskPointsSeason || {};

  const SCOPE_OVERALL = 'overall';
  const SCOPE_SEASON_ONE = 'season1';
  const SCOPE_SEASON_TWO = 'season2';
  const SCOPE_SEASON_THREE = 'season3';
  const SEASON_TWO_START_DATE = '2026-07-01';
  const SEASON_THREE_START_DATE = '2026-09-01';
  const SEASON_THREE_TOURNAMENT_START_DATE = '2026-10-01';
  const SCOPE_LABELS = {
    [SCOPE_SEASON_THREE]: 'Season 3 rankings',
    [SCOPE_SEASON_TWO]: 'Season 2 rankings',
    [SCOPE_SEASON_ONE]: 'Season 1 rankings',
    [SCOPE_OVERALL]: 'Overall rankings'
  };

  function normalizeScope(value, season = null) {
    const scope = String(value || '').trim().toLowerCase();
    if ([SCOPE_OVERALL, SCOPE_SEASON_ONE, SCOPE_SEASON_TWO, SCOPE_SEASON_THREE].includes(scope)) return scope;

    const seasonId = String(season?.id || '').toLowerCase();
    const seasonName = String(season?.name || '').toLowerCase();
    const seasonLabel = String(season?.label || '').toLowerCase();
    const monthKey = String(season?.monthKey || '');
    if (seasonId.includes('season_3') || seasonName === 'season 3' || monthKey === '2026-10' || seasonLabel.includes('october 2026')) return SCOPE_SEASON_THREE;
    if (seasonId.includes('season_2') || seasonName === 'season 2' || monthKey === '2026-08' || seasonLabel.includes('august 2026')) return SCOPE_SEASON_TWO;
    if (seasonId.includes('season_1') || seasonName === 'season 1' || monthKey === '2026-06' || seasonLabel.includes('june 2026')) return SCOPE_SEASON_ONE;
    return SCOPE_OVERALL;
  }

  function getRowDateKey(row) {
    const value = row?.dateKey || row?.date || row?.completedAtISO || row?.dateISO || row?.createdAtISO || '';
    return value ? String(value).slice(0, 10) : '';
  }

  function scopeAllowsDate(scope, dateKey) {
    const key = String(dateKey || '').slice(0, 10);
    if (!key) return false;
    const normalized = normalizeScope(scope);
    if (normalized === SCOPE_OVERALL) return true;
    if (normalized === SCOPE_SEASON_ONE) return key < SEASON_TWO_START_DATE;
    if (normalized === SCOPE_SEASON_TWO) return key >= SEASON_TWO_START_DATE && key < SEASON_THREE_START_DATE;
    if (normalized === SCOPE_SEASON_THREE) return key >= SEASON_THREE_START_DATE && key < SEASON_THREE_TOURNAMENT_START_DATE;
    return false;
  }

  function getScopedState(state, scope) {
    const normalized = normalizeScope(scope, state?.currentSeason);
    if (normalized === SCOPE_OVERALL) return state || {};
    const filterRows = (rows) => (Array.isArray(rows) ? rows : [])
      .filter((row) => scopeAllowsDate(normalized, getRowDateKey(row)));

    return {
      ...(state || {}),
      matchups: filterRows(state?.matchups),
      gameHistory: filterRows(state?.gameHistory),
      completions: filterRows(state?.completions)
    };
  }

  function makeScopeSelect(attributeName, selectedScope) {
    const select = global.document.createElement('select');
    select.className = 'season-admin-input';
    select.setAttribute(attributeName, '');
    const selected = normalizeScope(selectedScope);
    [SCOPE_SEASON_THREE, SCOPE_SEASON_TWO, SCOPE_SEASON_ONE, SCOPE_OVERALL].forEach((scope) => {
      const option = global.document.createElement('option');
      option.value = scope;
      option.textContent = SCOPE_LABELS[scope];
      option.selected = scope === selected;
      select.appendChild(option);
    });
    return select;
  }

  function makeScopeLabel(text, select) {
    const label = global.document.createElement('label');
    label.className = 'muted text-xs season-seed-source-control';
    label.append(global.document.createTextNode(`${text} `), select);
    return label;
  }

  function readSeasonState() {
    if (typeof core.loadAppState === 'function') {
      const loaded = core.loadAppState({ syncDerived: false, persistSync: false });
      return loaded?.state || loaded || {};
    }
    if (typeof seasonApi.loadSeasonState === 'function') return seasonApi.loadSeasonState();
    return {};
  }

  function saveSeasonState(state, savePath) {
    if (typeof core.saveStateSnapshot !== 'function') return state;
    const saved = core.saveStateSnapshot(state, { savePath });
    return saved?.state || saved || state;
  }

  function rerenderSeason(state) {
    const mount = global.document?.getElementById('seasonView');
    if (!mount || typeof seasonApi.renderSeasonView !== 'function') return;
    mount.innerHTML = seasonApi.renderSeasonView(state || {});
    if (typeof seasonApi.hydrateSeasonImages === 'function') seasonApi.hydrateSeasonImages(mount);
    enhanceSeasonControls(mount, state);
  }

  function persistAndRender(state, savePath) {
    try {
      const saved = saveSeasonState(state, savePath);
      rerenderSeason(saved);
      return saved;
    } catch (error) {
      console.error('Failed to save season ranking source change', error);
      global.alert?.('Save failed, so the Season seed order was not changed.');
      return null;
    }
  }

  function enhanceRebuildPanel(root, state) {
    const panel = root?.querySelector?.('[data-season-rebuild-panel]');
    if (!panel) return;

    const season = state?.currentSeason || readSeasonState()?.currentSeason || null;
    const selectedScope = normalizeScope(season?.seedRankingScope, season);
    let select = panel.querySelector('[data-season-ranking-scope]');
    if (!select) {
      select = makeScopeSelect('data-season-ranking-scope', selectedScope);
      const actions = panel.querySelector('.season-rebuild-actions');
      actions?.prepend(makeScopeLabel('Ranking source', select));
    } else {
      select.value = selectedScope;
    }

    const rebuildButton = panel.querySelector('[data-season-action="rebuild-standings"]');
    const rebuildButtonLabel = 'Rebuild from selected rankings';
    if (rebuildButton && rebuildButton.textContent !== rebuildButtonLabel) rebuildButton.textContent = rebuildButtonLabel;

    const cardHeader = panel.previousElementSibling;
    const headingWrap = cardHeader?.querySelector?.('.season-section-title')?.parentElement;
    if (headingWrap && !headingWrap.querySelector('[data-season-ranking-source-summary]')) {
      const summary = global.document.createElement('p');
      summary.className = 'muted text-xs mt-1';
      summary.setAttribute('data-season-ranking-source-summary', '');
      headingWrap.appendChild(summary);
    }
    const summary = headingWrap?.querySelector?.('[data-season-ranking-source-summary]');
    const summaryText = `Ranking source: ${SCOPE_LABELS[selectedScope]}.`;
    if (summary && summary.textContent !== summaryText) summary.textContent = summaryText;
  }

  function enhanceCreatePanel(root) {
    const panel = root?.querySelector?.('[data-create-season-panel]');
    if (!panel || panel.querySelector('[data-create-season-ranking-scope]')) return;
    const firstActions = panel.querySelector('.season-rebuild-actions');
    if (!firstActions) return;
    const select = makeScopeSelect('data-create-season-ranking-scope', SCOPE_SEASON_THREE);
    firstActions.appendChild(makeScopeLabel('Initial seed ranking source', select));
  }

  function enhanceSeasonControls(root = global.document?.getElementById('seasonView'), state = null) {
    if (!root) return;
    const currentState = state || readSeasonState();
    enhanceRebuildPanel(root, currentState);
    enhanceCreatePanel(root);
  }

  function rebuildFromScope(state, scope) {
    const normalized = normalizeScope(scope, state?.currentSeason);
    const scoped = getScopedState(state, normalized);
    const rebuilt = seasonApi.rebuildPreviewFromStandings(scoped, state.currentSeason);
    return {
      ...rebuilt,
      seedRankingScope: normalized
    };
  }

  function getSeedDataSnapshot(season) {
    return JSON.stringify((Array.isArray(season?.seeds) ? season.seeds : []).map((seed) => ({
      seed: Number(seed?.seed) || 0,
      playerId: seed?.playerId || seed?.id || '',
      wins: Number(seed?.wins) || 0,
      losses: Number(seed?.losses) || 0,
      winPct: Number(seed?.winPct) || 0,
      totalPoints: Number(seed?.totalPoints) || 0,
      averageScore: Number(seed?.averageScore) || 0,
      marginOfVictory: Number.isFinite(Number(seed?.marginOfVictory)) ? Number(seed.marginOfVictory) : null
    })));
  }

  function reorderManualPreviewByScope(baseSeason, state, scope, playerIds) {
    const normalized = normalizeScope(scope, baseSeason);
    const included = new Set((Array.isArray(playerIds) ? playerIds : []).filter(Boolean));
    const scopedInput = {
      ...(state || {}),
      players: (Array.isArray(state?.players) ? state.players : [])
        .filter((player) => included.has(player?.id || player?.playerId))
    };
    const projected = seasonApi.generateProjectedSeeds(getScopedState(scopedInput, normalized));
    const baseSeeds = Array.isArray(baseSeason?.seeds) ? baseSeason.seeds : [];
    const baseById = new Map(baseSeeds.map((seed) => [seed.playerId || seed.id, seed]));
    const ordered = [];
    const used = new Set();

    (projected?.seeds || []).forEach((rankingSeed) => {
      const playerId = rankingSeed.playerId || rankingSeed.id;
      if (!included.has(playerId) || !baseById.has(playerId) || used.has(playerId)) return;
      const baseSeed = baseById.get(playerId);
      ordered.push({
        ...baseSeed,
        ...rankingSeed,
        imageId: baseSeed.imageId || rankingSeed.imageId || '',
        playerName: baseSeed.playerName || rankingSeed.playerName || rankingSeed.name || playerId,
        name: baseSeed.name || rankingSeed.name || rankingSeed.playerName || playerId
      });
      used.add(playerId);
    });

    baseSeeds.forEach((seed) => {
      const playerId = seed.playerId || seed.id;
      if (!used.has(playerId)) ordered.push({ ...seed });
    });

    const seeds = ordered.map((seed, index) => ({ ...seed, seed: index + 1 }));
    const structuralWarnings = (Array.isArray(baseSeason?.warnings) ? baseSeason.warnings : [])
      .filter((warning) => warning?.code !== 'incomplete_seeding_data');
    const warnings = structuralWarnings.concat(Array.isArray(projected?.warnings) ? projected.warnings : []);
    const bracket = seeds.length === 34 && typeof seasonApi.buildProjectedBracket === 'function'
      ? seasonApi.buildProjectedBracket(seeds)
      : baseSeason.bracket;

    return {
      ...baseSeason,
      seedRankingScope: normalized,
      seeds,
      bracket,
      warnings
    };
  }

  function handleScopedRebuild(event, button) {
    const root = button.closest('#seasonView');
    const scope = root?.querySelector?.('[data-season-ranking-scope]')?.value || SCOPE_OVERALL;
    const state = readSeasonState();
    if (!state?.currentSeason || typeof seasonApi.rebuildPreviewFromStandings !== 'function') return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const season = rebuildFromScope(state, scope);
    persistAndRender({ ...state, currentSeason: season }, `season-rebuild-${normalizeScope(scope)}-rankings`);
  }

  function handleScopedCreate(event, button) {
    const root = button.closest('#seasonView');
    const panel = root?.querySelector?.('[data-create-season-panel]');
    const scope = panel?.querySelector?.('[data-create-season-ranking-scope]')?.value;
    if (!panel || !scope || typeof seasonApi.buildManualSeasonPreview !== 'function') return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const state = readSeasonState();
    const playerIds = Array.from(panel.querySelectorAll('[data-create-season-player]:checked'))
      .map((input) => input.value)
      .filter(Boolean);
    if (playerIds.length !== 34) {
      const message = 'This format was designed for 34 players. Auto-adapted bracket is not implemented yet. Create a preview shell with warning instead?';
      if (typeof global.confirm === 'function' && !global.confirm(message)) return;
    }

    const baseSeason = seasonApi.buildManualSeasonPreview(state, {
      name: panel.querySelector('[data-create-season-name]')?.value,
      startDate: panel.querySelector('[data-create-season-start]')?.value,
      endDate: panel.querySelector('[data-create-season-end]')?.value,
      playerIds
    });
    const season = reorderManualPreviewByScope(baseSeason, state, scope, playerIds);
    persistAndRender({ ...state, currentSeason: season, latestSeasonId: season.id }, 'season-create-ranked-preview');
  }

  function handleClickCapture(event) {
    const button = event.target?.closest?.('[data-season-action]');
    if (!button) return;
    const action = button.getAttribute('data-season-action');
    if (action === 'rebuild-standings') handleScopedRebuild(event, button);
    if (action === 'create-manual-season-preview') handleScopedCreate(event, button);
  }

  function restoreAutomaticPreviewScope() {
    const state = readSeasonState();
    const season = state?.currentSeason;
    if (!season || season.status !== 'preview' || season.seedMode === 'manual') {
      enhanceSeasonControls(global.document?.getElementById('seasonView'), state);
      return;
    }

    const scope = normalizeScope(season.seedRankingScope, season);
    if (scope === SCOPE_OVERALL || typeof seasonApi.rebuildPreviewFromStandings !== 'function') {
      enhanceSeasonControls(global.document?.getElementById('seasonView'), state);
      return;
    }

    const rebuilt = rebuildFromScope(state, scope);
    const alreadyScoped = season.seedRankingScope === scope && getSeedDataSnapshot(season) === getSeedDataSnapshot(rebuilt);
    if (alreadyScoped) {
      enhanceSeasonControls(global.document?.getElementById('seasonView'), state);
      return;
    }

    persistAndRender({ ...state, currentSeason: rebuilt }, `season-restore-${scope}-rankings`);
  }

  function initialize() {
    const mount = global.document?.getElementById('seasonView');
    if (!mount) return;
    global.document.addEventListener('click', handleClickCapture, true);
    if (typeof global.MutationObserver === 'function') {
      const observer = new global.MutationObserver(() => {
        global.queueMicrotask?.(() => enhanceSeasonControls(mount));
      });
      observer.observe(mount, { childList: true, subtree: true });
    }
    restoreAutomaticPreviewScope();
  }

  global.TaskPointsSeasonSeedSources = {
    SCOPE_OVERALL,
    SCOPE_SEASON_ONE,
    SCOPE_SEASON_TWO,
    SCOPE_SEASON_THREE,
    normalizeScope,
    scopeAllowsDate,
    getScopedState,
    getSeedDataSnapshot,
    reorderManualPreviewByScope
  };

  if (global.document) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', initialize);
    else initialize();
  }
})(typeof window !== 'undefined' ? window : globalThis);
