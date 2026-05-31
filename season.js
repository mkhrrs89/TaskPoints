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



  function lockCurrentPreviewToOfficialBracket(state, options = {}) {
    if (typeof core.lockSeasonPreviewToOfficialBracket === 'function') {
      return core.lockSeasonPreviewToOfficialBracket(state || {}, options);
    }
    return state;
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
    return `
      ${renderChampionSummary(season)}
      <section class="glass season-hero-card">
        <p class="season-eyebrow">Current Season</p>
        <h2 class="season-title">${escapeHtml(name)}</h2>
        <p class="muted text-sm">${escapeHtml(getSeasonSummaryLine(season))}</p>
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
      ${renderSeasonMatchupControl(season)}
      ${hasSeries ? renderCurrentRoundSection(season, dateKey) : ''}
      ${hasSeries ? renderOfficialBracket(season, { dateKey }) : '<section class="glass season-card"><p class="muted text-sm">Season tools will appear here in the next update.</p></section>'}
      ${['locked', 'active', 'champion_crowned'].includes(season?.status) ? renderEliminatedPlayers(season) : ''}
      ${renderFinalPlacements(season)}
    `;
  }

  function getChampionLabel(season) {
    const summary = season?.championSummary || {};
    return summary.name || summary.playerName || summary.championName || season?.championName || season?.champion || 'Champion TBD';
  }

  function renderTrophyCase(history) {
    const seasons = Array.isArray(history) ? history : [];
    return `
      <section class="glass season-hero-card">
        <p class="season-eyebrow">Season Archive</p>
        <h2 class="season-title">Trophy Case</h2>
        <p class="muted text-sm">Archived Season Championship results will collect here.</p>
      </section>
      <section class="glass season-card">
        <h3 class="season-section-title">Archived Seasons</h3>
        <div class="season-history-list">
          ${seasons.map((season) => `
            <article class="season-history-item">
              <div>
                <h4>${escapeHtml(season?.name || season?.label || 'Season')}</h4>
                <p class="muted text-sm">${escapeHtml(getSeasonSummaryLine(season))}</p>
              </div>
              <span class="season-champion-pill">${escapeHtml(getChampionLabel(season))}</span>
            </article>
          `).join('') || '<p class="muted text-sm">No archived seasons yet.</p>'}
        </div>
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
      : (history.length ? renderTrophyCase(history) : renderSeasonSetupShell());

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

  function attachSeasonInteractions(root) {
    if (!root || root.__seasonInteractionsAttached) return;
    root.__seasonInteractionsAttached = true;
    let dragFrom = null;

    root.addEventListener('dragstart', (event) => {
      const row = event.target?.closest?.('[data-seed-index]');
      if (!row) return;
      dragFrom = Number(row.dataset.seedIndex);
      row.classList.add('is-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(dragFrom));
      }
    });

    root.addEventListener('dragover', (event) => {
      const row = event.target?.closest?.('[data-seed-index]');
      if (!row) return;
      event.preventDefault();
      row.classList.add('is-drag-over');
    });

    root.addEventListener('dragleave', (event) => {
      const row = event.target?.closest?.('[data-seed-index]');
      row?.classList.remove('is-drag-over');
    });

    root.addEventListener('dragend', () => {
      root.querySelectorAll('.is-dragging,.is-drag-over').forEach((el) => el.classList.remove('is-dragging', 'is-drag-over'));
      dragFrom = null;
    });

    root.addEventListener('drop', (event) => {
      const row = event.target?.closest?.('[data-seed-index]');
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
