(function(global){
  const core = global.TaskPointsCore || {};

  const SEASON_ONE_ID = 'season_1_june_2026';
  const SEASON_ONE_NAME = 'Season 1';
  const SEASON_ONE_LABEL = 'June 2026 TaskPoints Championship';
  const SEASON_ONE_MONTH_KEY = '2026-06';
  const SEASON_ONE_START_DATE = '2026-06-01';
  const SEASON_ONE_END_DATE = '2026-06-30';
  const AUTO_SEED_MODE = 'auto';
  const MANUAL_SEED_MODE = 'manual';

  const STATUS_LABELS = {
    preview: 'Preview',
    locked: 'Locked',
    active: 'Active',
    champion_crowned: 'Champion Crowned',
    finalized: 'Finalized'
  };

  const ROUND_OF_32_PAIRINGS = [
    [1, 'play_in_low'], [16, 17], [8, 25], [9, 24],
    [4, 29], [13, 20], [5, 28], [12, 21],
    [2, 'play_in_other'], [15, 18], [7, 26], [10, 23],
    [3, 30], [14, 19], [6, 27], [11, 22]
  ];

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clone(value) {
    if (value == null) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
  }

  function seasonSnapshot(value) {
    try { return JSON.stringify(value || null); } catch (e) { return ''; }
  }

  function semanticSeasonSnapshot(value) {
    const copy = clone(value || null);
    if (copy && typeof copy === 'object') {
      delete copy.updatedAtISO;
      if (copy.bracket && typeof copy.bracket === 'object') delete copy.bracket.generatedAtISO;
    }
    return seasonSnapshot(copy);
  }

  function getDateKey(input) {
    if (typeof input === 'string') return input.slice(0, 10);
    if (typeof core.dateKey === 'function') return core.dateKey(input || new Date());
    const date = input instanceof Date ? input : new Date(input || Date.now());
    if (!date || Number.isNaN(date.getTime())) return 'invalid';
    return date.toISOString().slice(0, 10);
  }

  function getEffectiveDateKey(options = {}) {
    if (typeof options.effectiveDateKey === 'string') return options.effectiveDateKey.slice(0, 10);
    if (typeof options.nowISO === 'string') return getDateKey(options.nowISO);
    return getDateKey(new Date());
  }

  function nowIso(options = {}) {
    return typeof options.nowISO === 'string' ? options.nowISO : new Date().toISOString();
  }

  function getSeasonStatusLabel(status) {
    const key = typeof status === 'string' ? status.trim() : '';
    if (STATUS_LABELS[key]) return STATUS_LABELS[key];
    if (!key) return 'Preview';
    return key
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ') || 'Preview';
  }

  function getSeasonTabTitle(state) {
    const currentSeason = state?.currentSeason;
    const history = Array.isArray(state?.seasonHistory) ? state.seasonHistory : [];
    if (currentSeason?.status === 'preview' && currentSeason.monthKey === SEASON_ONE_MONTH_KEY) return 'Season 1 Preview';
    if (currentSeason) return currentSeason.name || currentSeason.label || 'Season 1';
    if (history.length) return 'Trophy Case';
    return 'Season 1';
  }

  function formatSeasonDate(dateKey) {
    if (!dateKey) return '';
    if (typeof core.niceDate === 'function') return core.niceDate(dateKey);
    return String(dateKey);
  }

  function getSeasonSummaryLine(season) {
    if (!season || typeof season !== 'object') return 'Season preview tools coming next.';
    const parts = [];
    if (season.status) parts.push(getSeasonStatusLabel(season.status));
    if (season.monthKey) parts.push(season.monthKey);
    const start = formatSeasonDate(season.startDate);
    const end = formatSeasonDate(season.endDate);
    if (start && end) parts.push(`${start} – ${end}`);
    else if (start) parts.push(`Starts ${start}`);
    else if (end) parts.push(`Ends ${end}`);
    return parts.join(' • ') || 'Season tools will appear here in the next update.';
  }

  function getRoundDefs() {
    if (typeof core.getSeasonRoundDefs === 'function') return core.getSeasonRoundDefs();
    return [
      { id: 'play_in', displayName: 'Play-In', bestOf: 3 },
      { id: 'round_of_32', displayName: 'Round of 32', bestOf: 5 },
      { id: 'sweet_16', displayName: 'Sweet 16', bestOf: 5 },
      { id: 'quarterfinals', displayName: 'Quarterfinals', bestOf: 5 },
      { id: 'semifinals', displayName: 'Semifinals', bestOf: 5 },
      { id: 'finals', displayName: 'Finals', bestOf: 7 }
    ];
  }

  function normalizeSeedSourceResult(state) {
    if (typeof core.getSeasonSeedSourceRows === 'function') {
      try { return core.getSeasonSeedSourceRows(state || {}); } catch (e) { /* fallback below */ }
    }
    const players = typeof core.getActiveSeasonPlayerPool === 'function'
      ? core.getActiveSeasonPlayerPool(state || {})
      : [{ id: 'YOU', name: state?.youName || 'You', isYou: true }].concat(Array.isArray(state?.players) ? state.players.filter((p) => p?.active !== false) : []);
    return { rows: players.map((p) => ({ playerId: p.id, id: p.id, name: p.name || p.id || 'Unnamed' })), warnings: [] };
  }

  function generateProjectedSeeds(state) {
    const source = normalizeSeedSourceResult(state || {});
    const rows = Array.isArray(source.rows) ? source.rows : [];
    const warnings = Array.isArray(source.warnings) ? source.warnings.slice() : [];
    const seeds = rows.map((row, index) => {
      const wins = Number(row.wins);
      const losses = Number(row.losses);
      const winPct = Number(row.winPct);
      const totalPoints = Number(row.totalPoints);
      const averageScore = Number(row.averageScore);
      const marginOfVictory = Number(row.marginOfVictory);
      const games = Number(row.games);
      const warningFlags = [];
      if (!Number.isFinite(games) || games <= 0) warningFlags.push('missing_record');
      if (!Number.isFinite(winPct)) warningFlags.push('missing_win_pct');
      if (!Number.isFinite(averageScore)) warningFlags.push('missing_average_score');
      if (!Number.isFinite(marginOfVictory)) warningFlags.push('missing_margin_of_victory');
      return {
        seed: index + 1,
        playerId: row.playerId || row.id || `player_${index + 1}`,
        id: row.playerId || row.id || `player_${index + 1}`,
        playerName: row.name || row.playerName || row.id || `Player ${index + 1}`,
        name: row.name || row.playerName || row.id || `Player ${index + 1}`,
        wins: Number.isFinite(wins) ? wins : 0,
        losses: Number.isFinite(losses) ? losses : 0,
        winPct: Number.isFinite(winPct) ? winPct : 0,
        totalPoints: Number.isFinite(totalPoints) ? totalPoints : 0,
        averageScore: Number.isFinite(averageScore) ? averageScore : 0,
        marginOfVictory: Number.isFinite(marginOfVictory) ? marginOfVictory : null,
        warningFlags
      };
    });

    const incomplete = seeds.filter((seed) => seed.warningFlags.length > 0);
    if (incomplete.length) {
      warnings.push({
        code: 'incomplete_seeding_data',
        count: incomplete.length,
        playerIds: incomplete.map((seed) => seed.playerId),
        playerNames: incomplete.map((seed) => seed.playerName),
        message: `Warning: ${incomplete.length} players have incomplete seeding data. Review before bracket lock.`
      });
    }
    return { seeds, warnings };
  }

  function seedByNumber(seeds, seedNumber) {
    const row = (Array.isArray(seeds) ? seeds : []).find((seed) => Number(seed.seed) === Number(seedNumber));
    if (row) return { type: 'seed', seed: row.seed, playerId: row.playerId, playerName: row.playerName || row.name || row.playerId };
    return { type: 'seed', seed: seedNumber, playerId: null, playerName: `Seed ${seedNumber}` };
  }

  function placeholderCompetitor(key) {
    if (key === 'play_in_low') return { type: 'placeholder', key, label: 'Play-In Winner Low' };
    if (key === 'play_in_other') return { type: 'placeholder', key, label: 'Play-In Winner Other' };
    return { type: 'placeholder', key, label: String(key || 'TBD') };
  }

  function competitorFor(seeds, token) {
    return typeof token === 'number' ? seedByNumber(seeds, token) : placeholderCompetitor(token);
  }

  function buildProjectedBracket(seeds) {
    const safeSeeds = Array.isArray(seeds) ? seeds : [];
    const playInMatches = [
      { id: 'play_in_31_34', roundId: 'play_in', name: 'Play-In 1', competitors: [competitorFor(safeSeeds, 31), competitorFor(safeSeeds, 34)] },
      { id: 'play_in_32_33', roundId: 'play_in', name: 'Play-In 2', competitors: [competitorFor(safeSeeds, 32), competitorFor(safeSeeds, 33)] }
    ];
    const roundOf32Matches = ROUND_OF_32_PAIRINGS.map((pair, index) => ({
      id: `round_of_32_${index + 1}`,
      roundId: 'round_of_32',
      name: `Match ${index + 1}`,
      competitors: [competitorFor(safeSeeds, pair[0]), competitorFor(safeSeeds, pair[1])]
    }));
    return {
      type: 'projected_34_player_preview',
      generatedAtISO: new Date().toISOString(),
      rounds: [
        { id: 'play_in', displayName: 'Play-In', status: 'projected', matches: playInMatches },
        { id: 'round_of_32', displayName: 'Round of 32', status: 'projected', matches: roundOf32Matches },
        { id: 'sweet_16', displayName: 'Sweet 16', status: 'placeholder', matches: [] },
        { id: 'quarterfinals', displayName: 'Quarterfinals', status: 'placeholder', matches: [] },
        { id: 'semifinals', displayName: 'Semifinals', status: 'placeholder', matches: [] },
        { id: 'finals', displayName: 'Finals', status: 'placeholder', matches: [] }
      ]
    };
  }

  function getPlayerPool(state) {
    if (typeof core.getActiveSeasonPlayerPool === 'function') {
      try { return core.getActiveSeasonPlayerPool(state || {}); } catch (e) { return []; }
    }
    return [];
  }

  function hasFinalizedSeasonOne(history) {
    return (Array.isArray(history) ? history : []).some((season) => {
      if (!season || season.status !== 'finalized') return false;
      return season.id === SEASON_ONE_ID || season.monthKey === SEASON_ONE_MONTH_KEY || season.name === SEASON_ONE_NAME;
    });
  }

  function createSeasonOnePreview(state, options = {}) {
    const projected = generateProjectedSeeds(state || {});
    const now = nowIso(options);
    const draftOptions = {
      id: SEASON_ONE_ID,
      name: SEASON_ONE_NAME,
      label: SEASON_ONE_LABEL,
      monthKey: SEASON_ONE_MONTH_KEY,
      startDate: SEASON_ONE_START_DATE,
      endDate: SEASON_ONE_END_DATE,
      status: 'preview',
      seedMode: AUTO_SEED_MODE,
      createdAtISO: now,
      updatedAtISO: now,
      playerPool: getPlayerPool(state || {}),
      seeds: projected.seeds,
      bracket: buildProjectedBracket(projected.seeds),
      warnings: projected.warnings,
      meta: { previewOnly: true, lockHint: 'Official bracket locks June 1 at 5am.' }
    };
    if (typeof core.createEmptySeasonDraft === 'function') return core.createEmptySeasonDraft(draftOptions);
    return draftOptions;
  }

  function rebuildPreviewFromStandings(state, season, options = {}) {
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

  function rebuildPreviewFromManualOrder(season, options = {}) {
    const seeds = (Array.isArray(season?.seeds) ? season.seeds : []).map((seed, index) => ({ ...seed, seed: index + 1 }));
    return {
      ...(season || {}),
      seedMode: season?.seedMode === MANUAL_SEED_MODE ? MANUAL_SEED_MODE : (season?.seedMode || AUTO_SEED_MODE),
      seeds,
      bracket: buildProjectedBracket(seeds),
      updatedAtISO: nowIso(options)
    };
  }

  function applyManualSeedReorder(season, fromIndex, toIndex, options = {}) {
    const seeds = Array.isArray(season?.seeds) ? season.seeds.slice() : [];
    const from = Number(fromIndex);
    const to = Number(toIndex);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= seeds.length || to >= seeds.length || from === to) {
      return season;
    }
    const [moved] = seeds.splice(from, 1);
    seeds.splice(to, 0, moved);
    const renumbered = seeds.map((seed, index) => ({ ...seed, seed: index + 1 }));
    return {
      ...(season || {}),
      seedMode: MANUAL_SEED_MODE,
      seeds: renumbered,
      bracket: buildProjectedBracket(renumbered),
      updatedAtISO: nowIso(options)
    };
  }


  function applyManualSeasonSeedReorderWithoutBracket(season, fromIndex, toIndex, options = {}) {
    const seeds = Array.isArray(season?.seeds) ? season.seeds.slice() : [];
    const from = Number(fromIndex);
    const to = Number(toIndex);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= seeds.length || to >= seeds.length || from === to) return season;
    const [moved] = seeds.splice(from, 1);
    seeds.splice(to, 0, moved);
    const renumbered = seeds.map((seed, index) => ({ ...seed, seed: index + 1 }));
    return { ...(season || {}), seedMode: MANUAL_SEED_MODE, seeds: renumbered, updatedAtISO: nowIso(options) };
  }

  function buildManualSeasonPreview(state, options = {}) {
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
        wins: projectedRow.wins || 0,
        losses: projectedRow.losses || 0,
        winPct: projectedRow.winPct || 0,
        totalPoints: projectedRow.totalPoints || 0,
        averageScore: projectedRow.averageScore || 0,
        marginOfVictory: projectedRow.marginOfVictory ?? null,
        warningFlags: Array.isArray(projectedRow.warningFlags) ? projectedRow.warningFlags : []
      };
    });
    const warnings = [];
    if (seeds.length !== 34) warnings.push({ code: 'non_34_player_pool', message: 'This format was designed for 34 players.' });
    const canCreateOfficialBracket = seeds.length === 34;
    const draftOptions = {
      name,
      label: name,
      monthKey,
      startDate,
      endDate,
      status: 'preview',
      seedMode: MANUAL_SEED_MODE,
      playerPool,
      seeds,
      bracket: canCreateOfficialBracket ? buildProjectedBracket(seeds) : { type: 'manual_preview_shell', rounds: [] },
      warnings: warnings.concat(projected.warnings || []),
      meta: { manualSeason: true, canCreateOfficialBracket, autoAdaptedBracketAvailable: false, previewOnly: !canCreateOfficialBracket }
    };
    if (typeof core.createEmptySeasonDraft === 'function') return core.createEmptySeasonDraft(draftOptions);
    return draftOptions;
  }



  function lockCurrentPreviewToOfficialBracket(state, options = {}) {
    if (typeof core.lockSeasonPreviewToOfficialBracket === 'function') {
      return core.lockSeasonPreviewToOfficialBracket(state || {}, options);
    }
    return state;
  }

  function applyChampionCrownedStatus(season, options = {}) {
    if (!season || ['preview', 'finalized', 'champion_crowned'].includes(season.status)) return season;
    const champion = typeof core.getSeasonChampionFromFinals === 'function' ? core.getSeasonChampionFromFinals(season) : null;
    if (!champion) return season;
    const summary = typeof core.getChampionSummary === 'function' ? core.getChampionSummary(season, { currentSeason: season }) : season.championSummary;
    return { ...season, status: 'champion_crowned', championSummary: summary || season.championSummary, updatedAtISO: nowIso(options) };
  }

  function prepareSeasonStateForPreview(state, options = {}) {
    const normalized = normalizeSeasonViewState(state || {});
    const before = semanticSeasonSnapshot(normalized.currentSeason);
    const effectiveDateKey = getEffectiveDateKey(options);
    let currentSeason = normalized.currentSeason;
    let changed = false;

    if (!currentSeason && !hasFinalizedSeasonOne(normalized.seasonHistory) && effectiveDateKey < SEASON_ONE_START_DATE) {
      currentSeason = createSeasonOnePreview(normalized, options);
      changed = true;
    } else if (currentSeason?.status === 'preview') {
      const mode = currentSeason.seedMode === MANUAL_SEED_MODE ? MANUAL_SEED_MODE : AUTO_SEED_MODE;
      currentSeason = mode === AUTO_SEED_MODE
        ? rebuildPreviewFromStandings(normalized, { ...currentSeason, seedMode: AUTO_SEED_MODE }, options)
        : rebuildPreviewFromManualOrder({ ...currentSeason, seedMode: MANUAL_SEED_MODE }, options);
      changed = before !== semanticSeasonSnapshot(currentSeason);
    }

    currentSeason = applyChampionCrownedStatus(currentSeason, options);

    const nextState = {
      ...normalized,
      currentSeason,
      latestSeasonId: currentSeason?.id || normalized.latestSeasonId || ''
    };
    return { state: normalizeSeasonViewState(nextState), changed };
  }

  function persistSeasonState(state, savePath = 'season-preview') {
    if (typeof core.saveStateSnapshot === 'function') {
      try {
        const saved = core.saveStateSnapshot(state, { savePath });
        return saved?.state || saved || state;
      } catch (error) {
        console.error('Failed to save Season preview state', error);
      }
    }
    return state;
  }

  function renderFormatList() {
    const rounds = getRoundDefs();
    return `
      <div class="season-format-grid" aria-label="Planned Season Championship format">
        ${rounds.map((round) => `
          <div class="season-format-card">
            <span class="season-format-round">${escapeHtml(round.displayName || 'Round')}</span>
            <span class="season-format-length">Best-of-${escapeHtml(round.bestOf || '')}</span>
          </div>
        `).join('')}
      </div>
      <ul class="season-bullet-list">
        <li>Play-In</li>
        <li>Round of 32</li>
        <li>Sweet 16</li>
        <li>Quarterfinals</li>
        <li>Semifinals</li>
        <li>Finals</li>
        <li>Best-of-3 Play-In</li>
        <li>Best-of-5 rounds</li>
        <li>Best-of-7 Finals</li>
      </ul>
    `;
  }

  function renderSeasonSetupShell() {
    return `
      <section class="glass season-hero-card">
        <p class="season-eyebrow">Season 1</p>
        <h2 class="season-title">June 2026 TaskPoints Championship</h2>
        <p class="muted text-sm">Open this tab before June 1, 2026 to create a dormant Season 1 preview from current standings.</p>
      </section>
      <section class="glass season-card">
        <h3 class="season-section-title">Planned Format</h3>
        <p class="muted text-sm mb-3">Preview-only shell: tournament games, official lock behavior, and bracket advancement are not active yet.</p>
        ${renderFormatList()}
      </section>
    `;
  }

  function formatStat(value, digits = 1) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '—';
    return digits === 0 ? String(Math.round(num)) : num.toFixed(digits);
  }

  function formatWinPct(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '.000';
    return num.toFixed(3).replace(/^0/, '');
  }

  function renderWarningPanel(season) {
    const warnings = Array.isArray(season?.warnings) ? season.warnings : [];
    const incomplete = warnings.find((warning) => warning?.code === 'incomplete_seeding_data');
    if (!incomplete) return '';
    const names = Array.isArray(incomplete.playerNames) ? incomplete.playerNames : [];
    return `
      <section class="season-warning-card" role="status">
        <strong>Warning: ${escapeHtml(incomplete.count || names.length)} players have incomplete seeding data. Review before bracket lock.</strong>
        ${names.length ? `
          <details class="season-warning-details">
            <summary>Affected players</summary>
            <p>${names.map(escapeHtml).join(', ')}</p>
          </details>
        ` : ''}
      </section>
    `;
  }

  function renderSeedList(season) {
    const seeds = Array.isArray(season?.seeds) ? season.seeds : [];
    return `
      <section class="glass season-card">
        <div class="season-card-header">
          <div>
            <h3 class="season-section-title">Projected Seeds</h3>
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
        <div class="season-seed-list" data-season-seed-list>
          ${seeds.map((seed, index) => `
            <article class="season-seed-row" draggable="true" data-seed-index="${index}" aria-label="Seed ${escapeHtml(seed.seed)} ${escapeHtml(seed.playerName || seed.name)}">
              <span class="season-seed-number">${escapeHtml(seed.seed)}</span>
              <div class="season-seed-main">
                <strong>${escapeHtml(seed.playerName || seed.name || seed.playerId)}</strong>
                <span>${escapeHtml(seed.wins)}-${escapeHtml(seed.losses)} • Win pct ${escapeHtml(formatWinPct(seed.winPct))} • Avg ${escapeHtml(formatStat(seed.averageScore))}</span>
              </div>
              <div class="season-seed-stats">
                <span>${escapeHtml(formatStat(seed.totalPoints, 0))} pts</span>
                <span>MOV ${escapeHtml(formatStat(seed.marginOfVictory))}</span>
              </div>
              <div class="season-seed-actions" aria-label="Manual seed controls">
                <button type="button" class="btn btn-ghost btn-toolbar" data-season-action="seed-up" data-seed-index="${index}" ${index === 0 ? 'disabled' : ''}>↑</button>
                <button type="button" class="btn btn-ghost btn-toolbar" data-season-action="seed-down" data-seed-index="${index}" ${index === seeds.length - 1 ? 'disabled' : ''}>↓</button>
              </div>
            </article>
          `).join('') || '<p class="muted text-sm">No active players found for seeding yet.</p>'}
        </div>
      </section>
    `;
  }

  function renderCompetitor(competitor) {
    if (!competitor) return '<span class="season-bracket-player muted">TBD</span>';
    if (competitor.type === 'placeholder') return `<span class="season-bracket-player season-bracket-placeholder">${escapeHtml(competitor.label)}</span>`;
    return `<span class="season-bracket-seed">${escapeHtml(competitor.seed)}</span><span class="season-bracket-player">${escapeHtml(competitor.playerName || `Seed ${competitor.seed}`)}</span>`;
  }

  function renderBracketRound(round) {
    const matches = Array.isArray(round?.matches) ? round.matches : [];
    return `
      <section class="season-bracket-round">
        <div class="season-bracket-round-header">
          <h4>${escapeHtml(round?.displayName || 'Round')}</h4>
          <span>${round?.status === 'placeholder' ? 'Locked placeholder' : 'Projected'}</span>
        </div>
        ${matches.length ? `
          <div class="season-bracket-match-grid">
            ${matches.map((match) => `
              <article class="season-bracket-match">
                <p class="season-bracket-match-name">${escapeHtml(match.name || 'Match')}</p>
                <div class="season-bracket-slot">${renderCompetitor(match.competitors?.[0])}</div>
                <div class="season-bracket-slot">${renderCompetitor(match.competitors?.[1])}</div>
              </article>
            `).join('')}
          </div>
        ` : '<p class="muted text-sm">Preview placeholder — this round will populate after earlier series are known.</p>'}
      </section>
    `;
  }

  function renderProjectedBracket(season) {
    const rounds = Array.isArray(season?.bracket?.rounds) ? season.bracket.rounds : buildProjectedBracket(season?.seeds || []).rounds;
    return `
      <section class="glass season-card">
        <h3 class="season-section-title">Projected Bracket</h3>
        <p class="muted text-sm">Play-In winners use protected placeholders: the lowest remaining Play-In winner faces Seed 1, and the other winner faces Seed 2.</p>
        <div class="season-bracket-stack">
          ${rounds.map(renderBracketRound).join('')}
        </div>
      </section>
    `;
  }

  function renderPreviewSeason(season) {
    return `
      <section class="glass season-hero-card">
        <p class="season-eyebrow">Season 1 Preview</p>
        <h2 class="season-title">Season 1 Preview</h2>
        <p class="season-subtitle">${escapeHtml(season?.label || SEASON_ONE_LABEL)}</p>
        <p class="season-projection-note">Seeds and bracket are projected from current standings. No official series are created until you create the official bracket.</p>
        <div class="season-rebuild-actions mt-4">
          <button type="button" class="btn btn-success btn-toolbar" data-season-action="create-official-bracket">Create Official Bracket</button>
        </div>
        <p class="muted text-sm mt-3">After creating the official bracket, seeds will no longer auto-update. You can still edit later through Admin Mode in a future update.</p>
      </section>
      ${season?.seedMode === MANUAL_SEED_MODE ? '<section class="season-manual-banner">Manual seed order active — standings updates will not change seeds.</section>' : ''}
      ${renderWarningPanel(season)}
      ${renderSeedList(season)}
      ${renderProjectedBracket(season)}
    `;
  }


  function officialSeriesEntries(season) {
    return Object.values(season?.series || {}).sort((a, b) => {
      const ar = Number(a?.roundIndex) || 0;
      const br = Number(b?.roundIndex) || 0;
      if (ar !== br) return ar - br;
      return (Number(a?.seriesIndex) || 0) - (Number(b?.seriesIndex) || 0);
    });
  }

  function renderSeriesSide(series, slot) {
    const prefix = slot === 'B' ? 'B' : 'A';
    const seed = series?.[`player${prefix}Seed`];
    const name = series?.[`player${prefix}Name`] || series?.[`player${prefix}Id`];
    const placeholder = series?.[`placeholder${prefix}`];
    if (name) return `<span class="season-bracket-seed">#${escapeHtml(seed || '—')}</span><span class="season-bracket-player">${escapeHtml(name)}</span>`;
    return `<span class="season-bracket-player season-bracket-placeholder">${escapeHtml(placeholder || 'Awaiting winner')}</span>`;
  }

  function getSeriesStatusLine(series) {
    if (typeof core.getSeriesStatusText === 'function') return core.getSeriesStatusText(series);
    return `${Number(series?.winsA) || 0}–${Number(series?.winsB) || 0}`;
  }

  function getWinnerFacesLine(season, series) {
    if (typeof core.getWinnerFacesText === 'function') return core.getWinnerFacesText(season, series);
    return 'Winner faces: TBD';
  }

  function getRoundName(roundId) {
    return getRoundDefs().find((round) => round.id === roundId)?.displayName || roundId || 'Round';
  }

  function getRoundForToday(season, dateKey = getEffectiveDateKey()) {
    if (typeof core.getSeasonRoundForDate === 'function') return core.getSeasonRoundForDate(dateKey);
    return getRoundDefs().find((round) => dateKey >= round.startDate && dateKey <= round.endDate) || null;
  }

  function getSeriesCompactTitle(series) {
    if (typeof core.getSeriesCompactTitle === 'function') return core.getSeriesCompactTitle(series);
    const a = series?.playerAName ? `${series.playerASeed ? `#${series.playerASeed} ` : ''}${series.playerAName}` : (series?.placeholderA || 'Awaiting opponent');
    const b = series?.playerBName ? `${series.playerBSeed ? `#${series.playerBSeed} ` : ''}${series.playerBName}` : (series?.placeholderB || 'Awaiting opponent');
    return `${a} vs ${b}`;
  }

  function getSeriesGameNumber(series, dateKey) {
    if (typeof core.getSeriesGameNumber === 'function') return core.getSeriesGameNumber(series, dateKey);
    return (Array.isArray(series?.gameResults) ? series.gameResults.length : 0) + 1;
  }

  function getPlayerNameFromSeries(series, playerId) {
    if (!playerId) return 'TBD';
    if (playerId === series?.playerAId) return series.playerAName || playerId;
    if (playerId === series?.playerBId) return series.playerBName || playerId;
    return playerId;
  }

  function renderGameResult(series, result, index) {
    const winner = getPlayerNameFromSeries(series, result?.winnerId);
    const loser = getPlayerNameFromSeries(series, result?.loserId);
    const score = Number.isFinite(Number(result?.playerAScore)) && Number.isFinite(Number(result?.playerBScore))
      ? ` • ${Number(result.playerAScore).toFixed(1)}–${Number(result.playerBScore).toFixed(1)}`
      : '';
    return `<li><span>Game ${index + 1} — ${escapeHtml(winner)} defeated ${escapeHtml(loser)}</span>${result?.dateKey ? `<small>${escapeHtml(result.dateKey)}</small>` : ''}${score ? `<small>${escapeHtml(score.replace(/^ • /, ''))}</small>` : ''}${result?.matchupId ? `<small class="season-debug-id">${escapeHtml(result.matchupId)}</small>` : ''}</li>`;
  }

  function seriesHasTodayGame(series, dateKey) {
    if (!series || !dateKey || series.status === 'complete') return false;
    const currentRound = getRoundForToday(null, dateKey);
    if (series.roundId !== currentRound?.id) return false;
    return Boolean(series.playerAId && series.playerBId);
  }

  function renderOfficialSeriesCard(season, series, options = {}) {
    const dateKey = options.dateKey || getEffectiveDateKey();
    const results = Array.isArray(series?.gameResults) ? series.gameResults : [];
    const bestOf = Number(series?.bestOf) || '—';
    const winsNeeded = Number(series?.winsNeeded) || (Number.isFinite(Number(bestOf)) ? Math.floor(Number(bestOf) / 2) + 1 : '—');
    const statusText = getSeriesStatusLine(series);
    const winnerFaces = getWinnerFacesLine(season, series);
    const todayGameNumber = seriesHasTodayGame(series, dateKey) ? getSeriesGameNumber(series, dateKey) : null;
    const pending = !series?.playerAId || !series?.playerBId;
    return `
      <details class="season-bracket-match season-series-card ${pending ? 'is-pending' : ''}">
        <summary>
          <span class="season-bracket-match-name">${escapeHtml(getSeriesCompactTitle(series))}</span>
          <span class="season-series-meta-row">
            <span>${escapeHtml(series?.roundName || getRoundName(series?.roundId))}</span>
            <span>Best of ${escapeHtml(bestOf)}</span>
          </span>
          <span class="season-series-status">${escapeHtml(statusText)}</span>
          ${todayGameNumber ? `<span class="season-series-today">Game ${escapeHtml(todayGameNumber)} today</span>` : ''}
          <span class="muted text-sm">${escapeHtml(winnerFaces)}</span>
        </summary>
        <div class="season-series-details">
          <p class="muted text-sm">Best of ${escapeHtml(bestOf)} • First to ${escapeHtml(winsNeeded)} wins</p>
          <p class="muted text-sm">${escapeHtml(winnerFaces)}</p>
          ${results.length ? `
            <ol class="season-game-results">
              ${results.map((result, index) => renderGameResult(series, result, index)).join('')}
            </ol>
          ` : '<p class="muted text-sm">No game results recorded yet.</p>'}
        </div>
      </details>
    `;
  }

  function renderRoundSection(season, round, options = {}) {
    const all = officialSeriesEntries(season).filter((series) => series?.roundId === round.id);
    const dateKey = options.dateKey || getEffectiveDateKey();
    const activeRound = getRoundForToday(season, dateKey);
    const isCurrent = activeRound?.id === round.id;
    return `
      <section class="season-bracket-round ${isCurrent ? 'is-current' : ''}">
        <div class="season-bracket-round-header">
          <div>
            <h4>${escapeHtml(round.displayName || round.id)}</h4>
            <p class="muted text-sm">${isCurrent ? 'Current round' : (all.some((series) => series?.playerAId && series?.playerBId) ? 'Series ready or in progress' : 'Pending / awaiting winners')}</p>
          </div>
          <span>${escapeHtml(all.length)} series</span>
        </div>
        <div class="season-bracket-match-grid">
          ${all.length ? all.map((series) => renderOfficialSeriesCard(season, series, { dateKey })).join('') : '<p class="muted text-sm">Pending / awaiting winners.</p>'}
        </div>
      </section>
    `;
  }

  function renderCurrentRoundSection(season, dateKey) {
    const round = getRoundForToday(season, dateKey);
    if (!round) return '';
    const hasSeries = officialSeriesEntries(season).some((series) => series?.roundId === round.id);
    if (!hasSeries) return '';
    return `
      <section class="glass season-card">
        <h3 class="season-section-title">Current Round</h3>
        ${renderRoundSection(season, round, { dateKey })}
      </section>
    `;
  }

  function renderOfficialBracket(season, options = {}) {
    const dateKey = options.dateKey || getEffectiveDateKey();
    const activeRoundId = getRoundForToday(season, dateKey)?.id || '';
    const rounds = getRoundDefs();
    return `
      <section class="glass season-card">
        <h3 class="season-section-title">Round-by-Round Championship</h3>
        <p class="muted text-sm">Series are shown as compact cards. Tap a series to expand results, dates, and advancement details.</p>
        <div class="season-bracket-stack">
          ${rounds.map((round) => renderRoundSection(season, round, { dateKey, activeRoundId })).join('')}
        </div>
      </section>
    `;
  }

  function renderEliminatedPlayers(season) {
    const players = typeof core.getEliminatedPlayers === 'function' ? core.getEliminatedPlayers(season) : [];
    return `
      <section class="glass season-card">
        <h3 class="season-section-title">Eliminated Players</h3>
        <div class="season-placement-list">
          ${players.length ? players.map((player) => `
            <article class="season-placement-row">
              <strong>${player.seed ? `#${escapeHtml(player.seed)} ` : ''}${escapeHtml(player.playerName || player.playerId)}</strong>
              <span>Lost in ${escapeHtml(player.roundLost || 'TBD')} to ${escapeHtml(player.eliminatedByName || 'TBD')}</span>
              <span>${escapeHtml(player.seriesScore || 'Series score TBD')}</span>
            </article>
          `).join('') : '<p class="muted text-sm">No players have been eliminated yet.</p>'}
        </div>
      </section>
    `;
  }

  function renderFinalPlacements(season) {
    if (!['champion_crowned', 'finalized'].includes(season?.status)) return '';
    const placements = typeof core.getFinalPlacements === 'function' ? core.getFinalPlacements(season, { currentSeason: season }) : [];
    return `
      <section class="glass season-card">
        <h3 class="season-section-title">Final Placement</h3>
        <div class="season-placement-list">
          ${placements.length ? placements.map((player, index) => `
            <article class="season-placement-row">
              <strong>${index + 1}. ${player.seed ? `#${escapeHtml(player.seed)} ` : ''}${escapeHtml(player.playerName || player.playerId)}</strong>
              <span>${escapeHtml(player.finish || 'Pending')}</span>
              <span>${escapeHtml(player.wins ?? 0)}–${escapeHtml(player.losses ?? 0)} • Avg ${escapeHtml(formatStat(player.averageScore))}</span>
            </article>
          `).join('') : '<p class="muted text-sm">Final placement data will appear after tournament results are complete.</p>'}
        </div>
      </section>
    `;
  }

  function renderChampionSummary(season) {
    const summary = typeof core.getChampionSummary === 'function' ? core.getChampionSummary(season, { currentSeason: season }) : null;
    if (!summary?.championId) return '';
    return `
      <section class="glass season-champion-summary season-card">
        <p class="season-eyebrow">Champion Summary</p>
        <h2 class="season-title">Season 1 Champion: ${escapeHtml(summary.championName || 'Champion TBD')}</h2>
        <p class="muted text-sm">Runner-up: ${escapeHtml(summary.runnerUpName || 'Runner-up TBD')}</p>
        <p class="season-series-status">Finals result: ${escapeHtml(summary.finalsResult || 'Finals complete')}</p>
        <p class="muted text-sm">Tournament record: ${escapeHtml(summary.record || '—')} • Points: ${escapeHtml(formatStat(summary.totalPoints, 0))} • Avg: ${escapeHtml(formatStat(summary.averageScore))}</p>
        <div class="season-path-list">
          ${(summary.path || []).map((step) => `<p>${escapeHtml(step.roundName || 'Round')}: defeated ${escapeHtml(step.opponentName || 'TBD')}, ${escapeHtml(step.score || '—')}</p>`).join('') || '<p class="muted text-sm">Bracket path will appear as completed series are synced.</p>'}
        </div>
      </section>
    `;
  }

  function playerPoolOptions(season, selectedId = '') {
    const players = Array.isArray(season?.seeds) && season.seeds.length
      ? season.seeds.map((seed) => ({ id: seed.playerId || seed.id, name: seed.playerName || seed.name || seed.playerId, seed: seed.seed }))
      : (Array.isArray(season?.playerPool) ? season.playerPool : []).map((player, index) => ({ id: player.id || player.playerId, name: player.name || player.playerName || player.id, seed: index + 1 }));
    return ['<option value="">Clear / TBD</option>'].concat(players.filter((player) => player.id).map((player) => `<option value="${escapeHtml(player.id)}" ${player.id === selectedId ? 'selected' : ''}>${player.seed ? `#${escapeHtml(player.seed)} ` : ''}${escapeHtml(player.name || player.id)}</option>`)).join('');
  }

  function renderAdminSeedsPanel(season) {
    const seeds = Array.isArray(season?.seeds) ? season.seeds : [];
    return `
      <section class="glass season-card season-admin-panel">
        <h3 class="season-section-title">Admin: Seeds</h3>
        <p class="muted text-sm">Changing seeds after official bracket creation can affect bracket structure. Rebuild the bracket only when you explicitly choose to.</p>
        <div class="season-rebuild-actions mt-3">
          <button type="button" class="btn btn-warn btn-toolbar" data-season-action="admin-rebuild-official-bracket">Rebuild bracket from current seeds</button>
        </div>
        <div class="season-seed-list mt-3" data-season-admin-seed-list>
          ${seeds.map((seed, index) => `
            <article class="season-seed-row" draggable="true" data-admin-seed-index="${index}">
              <span class="season-seed-number">${escapeHtml(seed.seed)}</span>
              <div class="season-seed-main"><strong>${escapeHtml(seed.playerName || seed.name || seed.playerId)}</strong><span>${escapeHtml(seed.playerId || seed.id || '')}</span></div>
              <div class="season-seed-actions">
                <button type="button" class="btn btn-ghost btn-toolbar" data-season-action="admin-seed-up" data-seed-index="${index}" ${index === 0 ? 'disabled' : ''}>↑</button>
                <button type="button" class="btn btn-ghost btn-toolbar" data-season-action="admin-seed-down" data-seed-index="${index}" ${index === seeds.length - 1 ? 'disabled' : ''}>↓</button>
              </div>
            </article>`).join('') || '<p class="muted text-sm">No seeds available.</p>'}
        </div>
      </section>`;
  }

  function renderAdminSeriesPanel(season) {
    const series = officialSeriesEntries(season);
    return `
      <section class="glass season-card season-admin-panel">
        <h3 class="season-section-title">Admin: Series scores and winners</h3>
        <p class="muted text-sm">Set wins or winners defensively. Recalculate from game results when daily scores are the source of truth.</p>
        <div class="season-admin-series-list">
          ${series.map((item) => `
            <article class="season-history-item season-admin-series-row">
              <div>
                <strong>${escapeHtml(item.roundName || getRoundName(item.roundId))}: ${escapeHtml(getSeriesCompactTitle(item))}</strong>
                <p class="muted text-xs">${escapeHtml(item.id || '')} • ${escapeHtml(getSeriesStatusLine(item))}</p>
                <div class="season-rebuild-actions mt-2">
                  <label class="muted text-xs">A wins <input class="season-admin-input" type="number" min="0" max="7" value="${escapeHtml(Number(item.winsA) || 0)}" data-admin-series-wins-a="${escapeHtml(item.id)}"></label>
                  <label class="muted text-xs">B wins <input class="season-admin-input" type="number" min="0" max="7" value="${escapeHtml(Number(item.winsB) || 0)}" data-admin-series-wins-b="${escapeHtml(item.id)}"></label>
                  <label class="muted text-xs">Winner <select class="season-admin-select" data-admin-series-winner="${escapeHtml(item.id)}"><option value="">No winner</option><option value="${escapeHtml(item.playerAId || '')}" ${item.winnerId === item.playerAId ? 'selected' : ''}>${escapeHtml(item.playerAName || item.playerAId || 'Player A')}</option><option value="${escapeHtml(item.playerBId || '')}" ${item.winnerId === item.playerBId ? 'selected' : ''}>${escapeHtml(item.playerBName || item.playerBId || 'Player B')}</option></select></label>
                </div>
              </div>
              <div class="season-rebuild-actions">
                <button type="button" class="btn btn-success btn-toolbar" data-season-action="admin-save-series" data-series-id="${escapeHtml(item.id)}">Save</button>
                <button type="button" class="btn btn-ghost btn-toolbar" data-season-action="admin-recalc-series" data-series-id="${escapeHtml(item.id)}">Recalculate from game results</button>
                <button type="button" class="btn btn-ghost btn-toolbar" data-season-action="admin-complete-series" data-series-id="${escapeHtml(item.id)}">Mark series complete</button>
                <button type="button" class="btn btn-warn btn-toolbar" data-season-action="admin-clear-series" data-series-id="${escapeHtml(item.id)}">Clear series result</button>
              </div>
            </article>`).join('') || '<p class="muted text-sm">No official series available.</p>'}
        </div>
      </section>`;
  }

  function renderAdminBracketPathsPanel(season) {
    const series = officialSeriesEntries(season);
    return `
      <section class="glass season-card season-admin-panel">
        <h3 class="season-section-title">Admin: Bracket paths</h3>
        <p class="muted text-sm">Assign or clear a player in a next-series slot if advancement broke. Placeholders are safe.</p>
        <div class="season-admin-series-list">
          ${series.filter((item) => item.roundId !== 'play_in').map((item) => `
            <article class="season-history-item">
              <div><strong>${escapeHtml(item.roundName || getRoundName(item.roundId))} ${escapeHtml(item.seriesIndex || '')}</strong><p class="muted text-xs">${escapeHtml(renderSeriesSide(item, 'A').replace(/<[^>]+>/g, ' '))} vs ${escapeHtml(renderSeriesSide(item, 'B').replace(/<[^>]+>/g, ' '))}</p></div>
              <div class="season-rebuild-actions">
                <label class="muted text-xs">Slot A <select class="season-admin-select" data-admin-slot-player="${escapeHtml(item.id)}" data-slot="A">${playerPoolOptions(season, item.playerAId)}</select></label>
                <button type="button" class="btn btn-ghost btn-toolbar" data-season-action="admin-assign-slot" data-series-id="${escapeHtml(item.id)}" data-slot="A">Assign A</button>
                <label class="muted text-xs">Slot B <select class="season-admin-select" data-admin-slot-player="${escapeHtml(item.id)}" data-slot="B">${playerPoolOptions(season, item.playerBId)}</select></label>
                <button type="button" class="btn btn-ghost btn-toolbar" data-season-action="admin-assign-slot" data-series-id="${escapeHtml(item.id)}" data-slot="B">Assign B</button>
              </div>
            </article>`).join('') || '<p class="muted text-sm">No bracket paths available yet.</p>'}
        </div>
      </section>`;
  }

  function renderAdminDailyRepairPanel(season, dateKey) {
    const enabled = season?.meta?.seasonMatchupControlEnabled === true;
    const todaySlate = (typeof core.loadAppState === 'function' ? (core.loadAppState({ syncDerived: false, persistSync: false }).state || {}) : {}).matchups || [];
    const seasonMatchups = todaySlate.filter((matchup) => matchup?.dateKey === dateKey && matchup?.seasonId === season?.id);
    return `
      <section class="glass season-card season-admin-panel">
        <h3 class="season-section-title">Admin: Daily tournament matchup repair</h3>
        <p class="muted text-sm">Today: ${escapeHtml(dateKey)} • Season matchup control: <strong>${enabled ? 'Enabled' : 'Disabled'}</strong></p>
        <div class="season-history-list mt-3">
          ${seasonMatchups.map((matchup) => `<article class="season-history-item"><div><strong>${escapeHtml(matchup.seasonMatchupLabel || matchup.roundName || matchup.matchupType || 'Season matchup')}</strong><p class="muted text-xs">${escapeHtml(matchup.playerAName || matchup.playerAId)} vs ${escapeHtml(matchup.playerBName || matchup.playerBId)}${Number.isFinite(Number(matchup.scoreA)) && Number.isFinite(Number(matchup.scoreB)) ? ` • ${escapeHtml(matchup.scoreA)}–${escapeHtml(matchup.scoreB)}` : ''}</p></div><span class="season-champion-pill">${escapeHtml(matchup.matchupType || '')}</span></article>`).join('') || '<p class="muted text-sm">No Season matchups found for today.</p>'}
        </div>
        <div class="season-rebuild-actions mt-3">
          <button type="button" class="btn btn-warn btn-toolbar" data-season-action="admin-regenerate-slate" ${enabled ? '' : 'disabled'}>Regenerate today’s Season slate</button>
          <button type="button" class="btn btn-success btn-toolbar" data-season-action="admin-resync-results">Re-sync tournament results from daily matchups</button>
        </div>
        <p class="muted text-xs mt-2">Regeneration may replace unsaved/unplayed matchups for this date. Completed/synced scores require confirmation.</p>
      </section>`;
  }

  function renderAdminFinalizePanel(season) {
    const canFinalize = typeof core.canFinalizeSeason === 'function' ? core.canFinalizeSeason(season, { currentSeason: season }, getEffectiveDateKey()) : false;
    return `
      <section class="glass season-card season-admin-panel">
        <h3 class="season-section-title">Admin: Finalize / archive</h3>
        <p class="muted text-sm">Finalizing archives the full season, moves it to Trophy Case history, sets latestSeasonId, and clears currentSeason.</p>
        <button type="button" class="btn btn-success btn-toolbar" data-season-action="admin-finalize-season" ${canFinalize ? '' : 'disabled'}>Finalize and archive current Season</button>
        ${canFinalize ? '' : '<p class="muted text-xs mt-2">Finals must be complete before manual finalization is available.</p>'}
      </section>`;
  }

  function renderSeasonAdminTools(season, dateKey) {
    return `
      <section class="glass season-card season-admin-banner">
        <h3 class="season-section-title">Admin Mode</h3>
        <p class="muted text-sm">Bracket, series, matchup, and sync repair tools are visible. Admin edits do not require reasons and do not write an audit log.</p>
      </section>
      ${renderAdminSeedsPanel(season)}
      ${renderAdminSeriesPanel(season)}
      ${renderAdminBracketPathsPanel(season)}
      ${renderAdminDailyRepairPanel(season, dateKey)}
      ${renderAdminFinalizePanel(season)}
    `;
  }





  function renderSeasonMatchupControl(season) {
    const hasOfficial = Object.keys(season?.series || {}).length > 0;
    const canToggle = hasOfficial && ['locked', 'active'].includes(season?.status);
    if (!canToggle) return '';
    const enabled = season?.meta?.seasonMatchupControlEnabled === true;
    return `
      <section class="glass season-card">
        <h3 class="season-section-title">Season Matchup Control</h3>
        <p class="muted text-sm">When enabled during June 2026, the Season system will create the full daily matchup slate: tournament games first, then exhibition matchups for everyone else.</p>
        <p class="muted text-sm mt-2">Current setting: <strong>${enabled ? 'Enabled' : 'Disabled'}</strong></p>
        <div class="season-rebuild-actions mt-4">
          <button type="button" class="btn ${enabled ? 'btn-ghost' : 'btn-success'} btn-toolbar" data-season-action="${enabled ? 'disable-matchup-control' : 'enable-matchup-control'}">${enabled ? 'Disable Season Matchup Control' : 'Enable Season Matchup Control'}</button>
        </div>
      </section>
    `;
  }

  function renderCurrentSeason(season) {
    if (season?.status === 'preview') return renderPreviewSeason(season);
    const name = season?.label || season?.name || 'Season 1';
    const status = getSeasonStatusLabel(season?.status);
    const monthKey = season?.monthKey || '—';
    const start = formatSeasonDate(season?.startDate) || '—';
    const end = formatSeasonDate(season?.endDate) || '—';
    const dateKey = getEffectiveDateKey();
    const currentRound = getRoundForToday(season, dateKey);
    const controlEnabled = season?.meta?.seasonMatchupControlEnabled === true;
    const hasSeries = Object.keys(season?.series || {}).length > 0;
    const adminMode = season?.meta?.adminMode === true;
    return `
      ${renderChampionSummary(season)}
      <section class="glass season-hero-card">
        <div class="season-card-header">
          <div>
            <p class="season-eyebrow">Current Season</p>
            <h2 class="season-title">${escapeHtml(name)}</h2>
            <p class="muted text-sm">${escapeHtml(getSeasonSummaryLine(season))}</p>
          </div>
          <button type="button" class="btn ${adminMode ? 'btn-warn' : 'btn-ghost'} btn-toolbar" data-season-action="toggle-admin-mode">${adminMode ? 'Exit Admin Mode' : 'Admin Mode'}</button>
        </div>
      </section>
      <section class="glass season-card season-header-card">
        <h3 class="season-section-title">Season Header</h3>
        <dl class="season-detail-grid">
          <div><dt>Status</dt><dd>${escapeHtml(status)}</dd></div>
          <div><dt>Current Round</dt><dd>${escapeHtml(currentRound?.displayName || 'Outside tournament dates')}</dd></div>
          <div><dt>Matchup Control</dt><dd>${controlEnabled ? 'Enabled' : 'Disabled'}</dd></div>
          <div><dt>Date Range</dt><dd>${escapeHtml(start)} – ${escapeHtml(end)}</dd></div>
          <div><dt>Month</dt><dd>${escapeHtml(monthKey)}</dd></div>
        </dl>
        <p class="muted text-sm mt-4">Seeds are locked. This presentation layer does not change scoring, drip schedules, matchup generation rules, or the Season matchup control gate.</p>
      </section>
      ${adminMode ? renderSeasonAdminTools(season, dateKey) : ''}
      ${renderSeasonMatchupControl(season)}
      ${hasSeries ? renderCurrentRoundSection(season, dateKey) : ''}
      ${hasSeries ? renderOfficialBracket(season, { dateKey }) : '<section class="glass season-card"><p class="muted text-sm">Season tools will appear here in the next update.</p></section>'}
      ${['locked', 'active', 'champion_crowned'].includes(season?.status) ? renderEliminatedPlayers(season) : ''}
      ${renderFinalPlacements(season)}
    `;
  }

  function getChampionLabel(season) {
    const summary = season?.championSummary || {};
    return summary.championName || summary.name || summary.playerName || season?.championName || season?.champion || 'Champion TBD';
  }

  function getRunnerUpLabel(season) {
    const summary = season?.championSummary || {};
    return summary.runnerUpName || season?.runnerUpName || 'Runner-up TBD';
  }

  function getFinalsResultLabel(season) {
    return season?.finalsResult || season?.championSummary?.finalsResult || season?.finalsSeries?.resultText || 'Finals result TBD';
  }

  function renderArchiveSeriesResults(season) {
    const series = Array.isArray(season?.seriesResults) ? season.seriesResults : officialSeriesEntries(season).map((item) => ({ ...item, resultText: getSeriesStatusLine(item) }));
    const byRound = getRoundDefs().map((round) => ({ round, rows: series.filter((item) => item.roundId === round.id) }));
    return byRound.map(({ round, rows }) => `
      <section class="season-bracket-round">
        <div class="season-bracket-round-header"><h4>${escapeHtml(round.displayName)}</h4><span>${escapeHtml(rows.length)} series</span></div>
        <div class="season-history-list">
          ${rows.map((item) => `<article class="season-history-item"><div><strong>${escapeHtml(item.playerAName || item.playerAId || 'TBD')} vs ${escapeHtml(item.playerBName || item.playerBId || 'TBD')}</strong><p class="muted text-xs">${escapeHtml(item.resultText || `${item.winsA || 0}–${item.winsB || 0}`)}</p></div><span class="season-champion-pill">${escapeHtml(item.winnerName || item.winnerId || 'TBD')}</span></article>`).join('') || '<p class="muted text-sm">No archived results for this round.</p>'}
        </div>
      </section>`).join('');
  }

  function renderArchivePlacements(season) {
    const placements = Array.isArray(season?.finalPlacements) ? season.finalPlacements : [];
    return `<div class="season-placement-list">${placements.map((player, index) => `<article class="season-placement-row"><strong>${index + 1}. ${player.seed ? `#${escapeHtml(player.seed)} ` : ''}${escapeHtml(player.playerName || player.playerId)}</strong><span>${escapeHtml(player.finish || '—')}</span><span>${escapeHtml(player.wins ?? 0)}–${escapeHtml(player.losses ?? 0)} • Avg ${escapeHtml(formatStat(player.averageScore))}</span></article>`).join('') || '<p class="muted text-sm">No placement list archived.</p>'}</div>`;
  }

  function renderCreateSeasonShell(state) {
    const pool = getPlayerPool(state || {});
    const count = pool.length;
    return `
      <section class="glass season-card season-create-shell">
        <div class="season-card-header">
          <div>
            <h3 class="season-section-title">Create New Season</h3>
            <p class="muted text-sm">Future seasons are manual only and use the established playoff format.</p>
          </div>
          <button type="button" class="btn btn-success btn-toolbar" data-season-action="show-create-season">Create New Season</button>
        </div>
        <div data-create-season-panel hidden>
          <div class="season-rebuild-actions mt-3">
            <label class="muted text-xs">Season name <input class="season-admin-input" type="text" data-create-season-name value="Manual Season Championship"></label>
            <label class="muted text-xs">Start date <input class="season-admin-input" type="date" data-create-season-start value="${escapeHtml(getDateKey(new Date()))}"></label>
            <label class="muted text-xs">End date <input class="season-admin-input" type="date" data-create-season-end value="${escapeHtml(getDateKey(new Date()))}"></label>
          </div>
          <p class="muted text-sm mt-3">Player pool review: all active players are included by default (${escapeHtml(count)} active players).</p>
          ${count !== 34 ? '<p class="season-manual-banner">This format was designed for 34 players. Review/edit the player pool to 34 players, or create a preview shell with warning; invalid official brackets will not be created.</p>' : ''}
          <div class="season-history-list mt-3 season-player-pool-review">
            ${pool.map((player) => `<label class="season-history-item"><span>${escapeHtml(player.name || player.id || player.playerId)}</span><input type="checkbox" data-create-season-player value="${escapeHtml(player.id || player.playerId)}" checked></label>`).join('') || '<p class="muted text-sm">No active players available.</p>'}
          </div>
          <div class="season-rebuild-actions mt-3">
            <button type="button" class="btn btn-success btn-toolbar" data-season-action="create-manual-season-preview">Create preview</button>
            <button type="button" class="btn btn-ghost btn-toolbar" data-season-action="hide-create-season">Cancel</button>
          </div>
        </div>
      </section>`;
  }

  function renderTrophyCase(history, state = {}) {
    const seasons = Array.isArray(history) ? history : [];
    return `
      <section class="glass season-hero-card season-trophy-hero">
        <p class="season-eyebrow">🏆 Season Archive</p>
        <h2 class="season-title">Trophy Case</h2>
        <p class="muted text-sm">Archived Season Championship results collect here as trophy cards.</p>
      </section>
      ${renderCreateSeasonShell(state)}
      <section class="season-trophy-grid">
        ${seasons.map((season) => `
          <details class="glass season-card season-trophy-card">
            <summary>
              <div>
                <p class="season-eyebrow">🏆 Champion</p>
                <h3 class="season-section-title">${escapeHtml(season?.name || season?.label || 'Season')}</h3>
                <p class="muted text-sm">${escapeHtml(formatSeasonDate(season?.startDate))} – ${escapeHtml(formatSeasonDate(season?.endDate))}</p>
              </div>
              <span class="season-champion-pill">${escapeHtml(getChampionLabel(season))}</span>
            </summary>
            <div class="season-series-details">
              <dl class="season-detail-grid">
                <div><dt>Champion</dt><dd>${escapeHtml(getChampionLabel(season))}</dd></div>
                <div><dt>Runner-up</dt><dd>${escapeHtml(getRunnerUpLabel(season))}</dd></div>
                <div><dt>Finals</dt><dd>${escapeHtml(getFinalsResultLabel(season))}</dd></div>
                <div><dt>Champion record</dt><dd>${escapeHtml(season?.championSummary?.record || '—')}</dd></div>
              </dl>
              <h4 class="season-section-title mt-4">Full Season</h4>
              ${season?.championSummary ? `<p class="muted text-sm">${escapeHtml(season.championSummary.championName || 'Champion')} defeated ${escapeHtml(season.championSummary.runnerUpName || 'runner-up')} in the Finals.</p>` : ''}
              <div class="season-bracket-stack mt-3">${renderArchiveSeriesResults(season)}</div>
              <h4 class="season-section-title mt-4">Final Placements</h4>
              ${renderArchivePlacements(season)}
              <h4 class="season-section-title mt-4">Archived Tournament Stats</h4>
              ${renderArchivePlacements({ finalPlacements: season?.tournamentStats || season?.finalPlacements || [] })}
            </div>
          </details>`).join('') || '<section class="glass season-card"><p class="muted text-sm">No archived seasons yet.</p></section>'}
      </section>
    `;
  }


  function normalizeSeasonViewState(state) {
    if (typeof core.normalizeState === 'function') return core.normalizeState(state || {});
    return {
      ...(state || {}),
      currentSeason: state?.currentSeason || null,
      seasonHistory: Array.isArray(state?.seasonHistory) ? state.seasonHistory : []
    };
  }

  function renderSeasonView(state) {
    const normalized = normalizeSeasonViewState(state || {});
    const currentSeason = normalized.currentSeason;
    const history = Array.isArray(normalized.seasonHistory) ? normalized.seasonHistory : [];
    const title = getSeasonTabTitle(normalized);
    const body = currentSeason
      ? renderCurrentSeason(currentSeason)
      : (history.length ? renderTrophyCase(history, normalized) : renderSeasonSetupShell());

    return `
      <div class="season-page-stack" data-season-title="${escapeHtml(title)}">
        ${body}
      </div>
    `;
  }

  function loadRawSeasonState() {
    if (typeof core.loadAppState === 'function') {
      try {
        const loaded = core.loadAppState({ syncDerived: false, persistSync: false });
        if (loaded && typeof loaded === 'object' && loaded.state && typeof loaded.state === 'object') {
          return loaded.state;
        }
        return loaded || {};
      } catch (error) {
        console.error('Failed to load Season state', error);
        return {};
      }
    }
    return normalizeSeasonViewState({});
  }

  function loadSeasonState(options = {}) {
    const prepared = prepareSeasonStateForPreview(loadRawSeasonState(), options);
    if (prepared.changed) return persistSeasonState(prepared.state, 'season-preview-load');
    return prepared.state;
  }

  function saveAndRenderSeason(nextState, savePath = 'season-preview-action') {
    const saved = persistSeasonState(nextState, savePath);
    const mount = global.document?.getElementById('seasonView');
    if (mount) mount.innerHTML = renderSeasonView(saved);
    attachSeasonInteractions(mount);
    return saved;
  }

  function currentMountedState() {
    return loadSeasonState({ effectiveDateKey: getDateKey(new Date()) });
  }

  function handleSeedMove(fromIndex, toIndex) {
    const state = currentMountedState();
    const season = applyManualSeedReorder(state.currentSeason, fromIndex, toIndex);
    if (season === state.currentSeason) return;
    saveAndRenderSeason({ ...state, currentSeason: season }, 'season-manual-seed-reorder');
  }


  function handleAdminSeedMove(fromIndex, toIndex) {
    const state = currentMountedState();
    const season = applyManualSeasonSeedReorderWithoutBracket(state.currentSeason, fromIndex, toIndex);
    if (season === state.currentSeason) return;
    saveAndRenderSeason({ ...state, currentSeason: season }, 'season-admin-seed-reorder');
  }

  function replaceTodaySeasonMatchups(state, dateKey, slate) {
    const existing = Array.isArray(state.matchups) ? state.matchups : [];
    return existing.filter((matchup) => !(matchup?.dateKey === dateKey && matchup?.seasonId === state.currentSeason?.id)).concat(slate.allMatchups || []);
  }

  function matchupHasCompletedScore(matchup) {
    return Number.isFinite(Number(matchup?.scoreA)) && Number.isFinite(Number(matchup?.scoreB));
  }

  function attachSeasonInteractions(root) {
    if (!root || root.__seasonInteractionsAttached) return;
    root.__seasonInteractionsAttached = true;
    let dragFrom = null;

    root.addEventListener('dragstart', (event) => {
      const row = event.target?.closest?.('[data-seed-index],[data-admin-seed-index]');
      if (!row) return;
      dragFrom = Number(row.dataset.seedIndex ?? row.dataset.adminSeedIndex);
      row.classList.add('is-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(dragFrom));
      }
    });

    root.addEventListener('dragover', (event) => {
      const row = event.target?.closest?.('[data-seed-index],[data-admin-seed-index]');
      if (!row) return;
      event.preventDefault();
      row.classList.add('is-drag-over');
    });

    root.addEventListener('dragleave', (event) => {
      const row = event.target?.closest?.('[data-seed-index],[data-admin-seed-index]');
      row?.classList.remove('is-drag-over');
    });

    root.addEventListener('dragend', () => {
      root.querySelectorAll('.is-dragging,.is-drag-over').forEach((el) => el.classList.remove('is-dragging', 'is-drag-over'));
      dragFrom = null;
    });

    root.addEventListener('drop', (event) => {
      const row = event.target?.closest?.('[data-seed-index],[data-admin-seed-index]');
      if (!row) return;
      event.preventDefault();
      const from = dragFrom ?? Number(event.dataTransfer?.getData('text/plain'));
      const to = Number(row.dataset.seedIndex);
      root.querySelectorAll('.is-dragging,.is-drag-over').forEach((el) => el.classList.remove('is-dragging', 'is-drag-over'));
      dragFrom = null;
      handleSeedMove(from, to);
    });

    root.addEventListener('click', (event) => {
      const button = event.target?.closest?.('[data-season-action]');
      if (!button) return;
      const action = button.dataset.seasonAction;
      const panel = root.querySelector('[data-season-rebuild-panel]');
      if (action === 'rebuild-toggle') {
        if (panel) panel.hidden = !panel.hidden;
        return;
      }
      if (action === 'rebuild-cancel') {
        if (panel) panel.hidden = true;
        return;
      }
      if (action === 'seed-up' || action === 'seed-down') {
        const index = Number(button.dataset.seedIndex);
        handleSeedMove(index, action === 'seed-up' ? index - 1 : index + 1);
        return;
      }
      if (action === 'rebuild-standings' || action === 'rebuild-manual') {
        const state = currentMountedState();
        const season = action === 'rebuild-standings'
          ? rebuildPreviewFromStandings(state, state.currentSeason)
          : rebuildPreviewFromManualOrder(state.currentSeason);
        saveAndRenderSeason({ ...state, currentSeason: season }, action === 'rebuild-standings' ? 'season-rebuild-standings' : 'season-rebuild-manual');
        return;
      }
      if (action === 'create-official-bracket') {
        const message = 'After creating the official bracket, seeds will no longer auto-update. You can still edit later through Admin Mode in a future update.';
        if (typeof global.confirm === 'function' && !global.confirm(message)) return;
        const state = currentMountedState();
        const nextState = lockCurrentPreviewToOfficialBracket(state, { nowISO: nowIso() });
        saveAndRenderSeason(nextState, 'season-create-official-bracket');
        return;
      }
      if (action === 'toggle-admin-mode') {
        const state = currentMountedState();
        const currentSeason = state.currentSeason || null;
        if (!currentSeason) return;
        const nextSeason = { ...currentSeason, updatedAtISO: nowIso(), meta: { ...(currentSeason.meta || {}), adminMode: currentSeason?.meta?.adminMode !== true } };
        saveAndRenderSeason({ ...state, currentSeason: nextSeason }, 'season-admin-mode-toggle');
        return;
      }
      if (action === 'admin-seed-up' || action === 'admin-seed-down') {
        const index = Number(button.dataset.seedIndex);
        handleAdminSeedMove(index, action === 'admin-seed-up' ? index - 1 : index + 1);
        return;
      }
      if (action === 'admin-rebuild-official-bracket') {
        if (typeof global.confirm === 'function' && !global.confirm('Changing seeds after official bracket creation can affect bracket structure. Rebuild bracket from current seeds now?')) return;
        const state = currentMountedState();
        const currentSeason = state.currentSeason || null;
        if (!currentSeason) return;
        const series = typeof core.createOfficialSeasonSeriesFromSeeds === 'function' ? core.createOfficialSeasonSeriesFromSeeds(currentSeason.seeds || [], { seasonId: currentSeason.id, nowISO: nowIso() }) : currentSeason.series;
        const bracket = typeof core.buildOfficialSeasonBracketFromSeeds === 'function' ? core.buildOfficialSeasonBracketFromSeeds(currentSeason.seeds || [], { seasonId: currentSeason.id, nowISO: nowIso() }) : currentSeason.bracket;
        saveAndRenderSeason({ ...state, currentSeason: { ...currentSeason, series, bracket, updatedAtISO: nowIso() } }, 'season-admin-rebuild-official-bracket');
        return;
      }
      if (action === 'admin-save-series' || action === 'admin-complete-series' || action === 'admin-recalc-series' || action === 'admin-clear-series') {
        const state = currentMountedState();
        const seriesId = button.dataset.seriesId;
        const winsA = root.querySelector(`[data-admin-series-wins-a="${CSS.escape(seriesId)}"]`)?.value;
        const winsB = root.querySelector(`[data-admin-series-wins-b="${CSS.escape(seriesId)}"]`)?.value;
        const winnerId = root.querySelector(`[data-admin-series-winner="${CSS.escape(seriesId)}"]`)?.value || '';
        let patch = { winsA, winsB, winnerId };
        if (action === 'admin-recalc-series') patch = { recalculate: true };
        if (action === 'admin-clear-series') patch = { clear: true };
        if (action === 'admin-complete-series' && !winnerId) { alert('Choose a winner before marking the series complete.'); return; }
        if (action === 'admin-clear-series' && typeof global.confirm === 'function' && !global.confirm('Clear this series result? Game results are kept, but wins/winner/status are reset.')) return;
        const result = typeof core.updateSeasonSeriesManualResult === 'function' ? core.updateSeasonSeriesManualResult(state.currentSeason, seriesId, patch, { nowISO: nowIso() }) : { ok: false, error: 'helper_unavailable' };
        if (!result.ok) { alert(`Series update failed: ${result.error || 'unknown error'}`); return; }
        saveAndRenderSeason({ ...state, currentSeason: result.season }, 'season-admin-series-update');
        return;
      }
      if (action === 'admin-assign-slot') {
        const state = currentMountedState();
        const seriesId = button.dataset.seriesId;
        const slot = button.dataset.slot === 'B' ? 'B' : 'A';
        const playerId = root.querySelector(`[data-admin-slot-player="${CSS.escape(seriesId)}"][data-slot="${slot}"]`)?.value || '';
        const result = typeof core.assignSeasonBracketSlot === 'function' ? core.assignSeasonBracketSlot(state.currentSeason, seriesId, slot, playerId, { nowISO: nowIso() }) : { ok: false, error: 'helper_unavailable' };
        if (!result.ok) { alert(`Slot assignment failed: ${result.error || 'unknown error'}`); return; }
        saveAndRenderSeason({ ...state, currentSeason: result.season }, 'season-admin-assign-slot');
        return;
      }
      if (action === 'admin-regenerate-slate') {
        const state = currentMountedState();
        const dateKey = getDateKey(new Date());
        const existing = (Array.isArray(state.matchups) ? state.matchups : []).filter((matchup) => matchup?.dateKey === dateKey && matchup?.seasonId === state.currentSeason?.id);
        const hasScores = existing.some(matchupHasCompletedScore);
        const message = hasScores ? 'This date has completed/synced scores. Regenerate anyway? This may replace unsaved/unplayed matchups for this date.' : 'This may replace unsaved/unplayed matchups for this date.';
        if (typeof global.confirm === 'function' && !global.confirm(message)) return;
        const slate = typeof core.buildSeasonDailySlate === 'function' ? core.buildSeasonDailySlate(state, dateKey, { nowISO: nowIso() }) : { ok: false, errors: ['helper unavailable'] };
        if (!slate.ok) { alert(`Slate regeneration failed: ${(slate.errors || []).join('; ') || 'unknown error'}`); return; }
        const nextState = { ...state, currentSeason: slate.updatedSeason || state.currentSeason, matchups: replaceTodaySeasonMatchups(state, dateKey, slate) };
        saveAndRenderSeason(nextState, 'season-admin-regenerate-slate');
        alert(`Regenerated ${slate.allMatchups.length} Season matchups. ${(slate.warnings || []).join(' ')}`);
        return;
      }
      if (action === 'admin-resync-results') {
        const state = currentMountedState();
        const dateKey = getDateKey(new Date());
        const result = typeof core.syncSeasonResultsFromDailyMatchups === 'function' ? core.syncSeasonResultsFromDailyMatchups(state, dateKey, { nowISO: nowIso() }) : { ok: false, errors: ['helper unavailable'] };
        if (!result.ok && (result.errors || []).length) alert(`Re-sync warnings/errors: ${(result.errors || []).concat(result.warnings || []).join('; ')}`);
        saveAndRenderSeason(result.state || state, 'season-admin-resync-results');
        if (result.ok) alert(`Re-sync complete. Changed: ${result.changed ? 'yes' : 'no'}. ${(result.warnings || []).join(' ')}`);
        return;
      }
      if (action === 'admin-finalize-season') {
        if (typeof global.confirm === 'function' && !global.confirm('Finalize and archive this Season Championship? This moves currentSeason to seasonHistory and clears currentSeason.')) return;
        const state = currentMountedState();
        const result = typeof core.finalizeCurrentSeason === 'function' ? core.finalizeCurrentSeason(state, { dateKey: getDateKey(new Date()) }) : { ok: false, error: 'helper_unavailable' };
        if (!result.ok) { alert(`Finalize failed: ${result.error || 'unknown error'}`); return; }
        saveAndRenderSeason(result.state, 'season-admin-finalize');
        return;
      }
      if (action === 'show-create-season' || action === 'hide-create-season') {
        const createPanel = root.querySelector('[data-create-season-panel]');
        if (createPanel) createPanel.hidden = action === 'hide-create-season';
        return;
      }
      if (action === 'create-manual-season-preview') {
        const state = currentMountedState();
        const playerIds = Array.from(root.querySelectorAll('[data-create-season-player]:checked')).map((input) => input.value).filter(Boolean);
        const count = playerIds.length;
        if (count !== 34) {
          const msg = 'This format was designed for 34 players. Auto-adapted bracket is not implemented yet. Create a preview shell with warning instead?';
          if (typeof global.confirm === 'function' && !global.confirm(msg)) return;
        }
        const season = buildManualSeasonPreview(state, {
          name: root.querySelector('[data-create-season-name]')?.value,
          startDate: root.querySelector('[data-create-season-start]')?.value,
          endDate: root.querySelector('[data-create-season-end]')?.value,
          playerIds
        });
        saveAndRenderSeason({ ...state, currentSeason: season, latestSeasonId: season.id }, 'season-create-manual-preview');
        return;
      }
      if (action === 'enable-matchup-control' || action === 'disable-matchup-control') {
        const state = currentMountedState();
        const currentSeason = state.currentSeason || null;
        if (!currentSeason) return;
        const enabled = action === 'enable-matchup-control';
        const nextSeason = {
          ...currentSeason,
          updatedAtISO: nowIso(),
          meta: { ...(currentSeason.meta || {}), seasonMatchupControlEnabled: enabled }
        };
        saveAndRenderSeason({ ...state, currentSeason: nextSeason }, enabled ? 'season-enable-matchup-control' : 'season-disable-matchup-control');
      }
    });
  }

  function mountSeasonView() {
    const mount = global.document?.getElementById('seasonView');
    if (!mount) return;
    try {
      mount.innerHTML = renderSeasonView(loadSeasonState());
    } catch (error) {
      console.error('Failed to render Season view', error);
      mount.innerHTML = renderSeasonView({});
    }
    attachSeasonInteractions(mount);
  }

  global.TaskPointsSeason = {
    SEASON_ONE_ID,
    AUTO_SEED_MODE,
    MANUAL_SEED_MODE,
    getSeasonStatusLabel,
    getSeasonTabTitle,
    getSeasonSummaryLine,
    generateProjectedSeeds,
    buildProjectedBracket,
    createSeasonOnePreview,
    prepareSeasonStateForPreview,
    applyManualSeedReorder,
    applyManualSeasonSeedReorderWithoutBracket,
    buildManualSeasonPreview,
    applyChampionCrownedStatus,
    rebuildPreviewFromStandings,
    rebuildPreviewFromManualOrder,
    lockCurrentPreviewToOfficialBracket,
    loadSeasonState,
    renderSeasonView,
    mountSeasonView
  };

  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', mountSeasonView);
    } else {
      mountSeasonView();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
