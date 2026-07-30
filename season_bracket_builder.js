(function (global) {
  'use strict';

  const core = global.TaskPointsCore || {};
  const builder = global.TaskPointsBracketBuilder || {};
  const mount = global.document?.getElementById('bracketBuilderView');
  if (!mount) return;

  let state = {};
  let season = null;
  let config = null;

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function loadState() {
    if (typeof core.loadAppState !== 'function') return {};
    const loaded = core.loadAppState({ syncDerived: false, persistSync: false });
    return loaded?.state || loaded || {};
  }

  function saveState(nextState, savePath) {
    if (typeof core.saveStateSnapshot !== 'function') throw new Error('Save helper unavailable');
    const saved = core.saveStateSnapshot(nextState, { savePath, userInitiated: true, immediateWrite: true });
    return saved?.state || saved || nextState;
  }

  function isSeasonTwo(seasonLike) {
    const id = String(seasonLike?.id || '').toLowerCase();
    const label = String(seasonLike?.label || '').toLowerCase();
    return seasonLike?.monthKey === '2026-08' || id.includes('season_2') || id.includes('2026-08') || label.includes('august 2026');
  }

  function defaultConfig() {
    const count = Array.isArray(season?.seeds) ? season.seeds.length : 0;
    if (isSeasonTwo(season) && count >= 60) return builder.createSeasonTwoPreset({ startDate: season.startDate, endDate: season.endDate });
    return builder.createGenericConfig({ entrantCount: count, startDate: season?.startDate, endDate: season?.endDate, name: season?.name });
  }

  function playerLabel(series, slot) {
    const prefix = slot === 'B' ? 'B' : 'A';
    const seed = series?.[`player${prefix}Seed`];
    const name = series?.[`player${prefix}Name`] || series?.[`placeholder${prefix}`] || 'Awaiting winner';
    return `${Number.isFinite(Number(seed)) ? `#${Number(seed)} ` : ''}${name}`;
  }

  function roundSeries(built, roundId) {
    return Object.values(built?.series || {})
      .filter((series) => series?.roundId === roundId)
      .sort((a, b) => (Number(a.seriesIndex) || 0) - (Number(b.seriesIndex) || 0));
  }

  function readConfigFromForm() {
    const presetId = mount.querySelector('[data-builder-preset]')?.value || config?.presetId;
    const entrantCount = Number(mount.querySelector('[data-builder-entrant-count]')?.value) || config?.entrantCount;
    const rounds = Array.from(mount.querySelectorAll('[data-builder-round-index]')).map((card) => ({
      id: card.dataset.roundId,
      displayName: card.querySelector('[data-builder-round-name]')?.value || '',
      bestOf: Number(card.querySelector('[data-builder-round-best-of]')?.value) || 1,
      startDate: card.querySelector('[data-builder-round-start]')?.value || '',
      endDate: card.querySelector('[data-builder-round-end]')?.value || '',
      tieBreaker: card.querySelector('[data-builder-round-tie]')?.value === 'higher_seed' ? 'higher_seed' : 'none'
    }));
    config = builder.normalizeConfig({ ...config, presetId, entrantCount, rounds }, season?.seeds || []);
    return config;
  }

  function renderRoundEditor(round, index) {
    return `
      <article class="builder-round-card ${round.tieBreaker === 'higher_seed' ? 'is-play-in' : ''}" data-builder-round-index="${index}" data-round-id="${escapeHtml(round.id)}">
        <div class="builder-round-header">
          <div class="flex items-center gap-2"><span class="builder-round-number">${index + 1}</span><strong>${escapeHtml(round.displayName)}</strong></div>
          <span class="muted text-xs">${escapeHtml(round.id)}</span>
        </div>
        <div class="builder-round-fields">
          <label class="builder-field builder-round-name"><span>Round name</span><input class="season-admin-input" data-builder-round-name value="${escapeHtml(round.displayName)}"></label>
          <label class="builder-field"><span>Best of</span><select class="season-admin-input" data-builder-round-best-of>${[1, 3, 5, 7].map((value) => `<option value="${value}" ${Number(round.bestOf) === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
          <label class="builder-field"><span>Starts</span><input class="season-admin-input" type="date" data-builder-round-start value="${escapeHtml(round.startDate)}"></label>
          <label class="builder-field"><span>Last possible game</span><input class="season-admin-input" type="date" data-builder-round-end value="${escapeHtml(round.endDate)}"></label>
        </div>
        <label class="builder-field"><span>Tied game rule</span><select class="season-admin-input" data-builder-round-tie><option value="none" ${round.tieBreaker !== 'higher_seed' ? 'selected' : ''}>No automatic tiebreaker</option><option value="higher_seed" ${round.tieBreaker === 'higher_seed' ? 'selected' : ''}>Higher seed advances</option></select></label>
      </article>`;
  }

  function renderValidation(validation) {
    const messages = validation.errors.concat(validation.warnings);
    return `
      <div class="builder-validation ${validation.ok ? 'is-valid' : 'is-invalid'}">
        <strong>${validation.ok ? 'Bracket structure is valid' : 'Bracket needs attention'}</strong>
        ${messages.length ? `<ul class="builder-message-list">${messages.map((message) => `<li>${escapeHtml(message)}</li>`).join('')}</ul>` : '<p class="muted text-sm mt-1">All rounds fit the selected field and date range.</p>'}
      </div>`;
  }

  function renderTierSummary() {
    if (config.presetId === builder.SEASON_TWO_PRESET_ID) {
      return `
        <div class="builder-tier-grid">
          <div class="builder-tier"><strong>Seeds 1–16</strong><span>Round of 32 berth and Opening Round bye</span></div>
          <div class="builder-tier"><strong>Seeds 17–36</strong><span>Enter the Opening Round on August 2</span></div>
          <div class="builder-tier"><strong>Seeds 37–60</strong><span>Single-game Play-In on August 1</span></div>
        </div>`;
    }
    const preliminary = Number(config.preliminarySeries) || 0;
    const directByes = Number(config.directByes) || 0;
    return `
      <div class="builder-tier-grid">
        <div class="builder-tier"><strong>${escapeHtml(config.entrantCount)} entrants</strong><span>Top ${escapeHtml(config.entrantCount)} locked seeds qualify</span></div>
        <div class="builder-tier"><strong>${escapeHtml(directByes)} direct byes</strong><span>Advance to the main ${escapeHtml(config.mainBracketSize)}-player bracket</span></div>
        <div class="builder-tier"><strong>${escapeHtml(preliminary)} preliminary games</strong><span>${preliminary ? 'Reduce the field to a power of two' : 'No preliminary round needed'}</span></div>
      </div>`;
  }

  function renderBracketPreview(built) {
    if (!built.ok) return '<p class="muted text-sm">Fix the validation errors to preview the bracket.</p>';
    return `
      <div class="builder-bracket-rounds">
        ${built.config.rounds.map((round) => {
          const rows = roundSeries(built, round.id);
          return `
            <section class="builder-preview-round">
              <div class="builder-preview-header"><strong>${escapeHtml(round.displayName)}</strong><span class="muted text-xs">${rows.length} matchup${rows.length === 1 ? '' : 's'} • Best of ${escapeHtml(round.bestOf)} • ${escapeHtml(round.startDate)}–${escapeHtml(round.endDate)}</span></div>
              <div class="builder-pairing-list">
                ${rows.map((series) => `<div class="builder-pairing"><span>${escapeHtml(playerLabel(series, 'A'))}</span><b>vs</b><span>${escapeHtml(playerLabel(series, 'B'))}</span></div>`).join('')}
              </div>
            </section>`;
        }).join('')}
      </div>`;
  }

  function render() {
    if (!season) {
      mount.innerHTML = `<section class="glass season-card"><h2 class="season-title">No season preview found</h2><p class="muted text-sm">Create a Season preview and lock down its seed order first.</p><a href="season.html" class="btn btn-teal btn-toolbar mt-3">Return to Season</a></section>`;
      return;
    }
    if (season.status !== 'preview') {
      mount.innerHTML = `<section class="glass season-card"><h2 class="season-title">Bracket already created</h2><p class="muted text-sm">${escapeHtml(season.name || 'This season')} is ${escapeHtml(season.status)}. Bracket structure can only be built before official creation.</p><a href="season.html" class="btn btn-teal btn-toolbar mt-3">Return to Season</a></section>`;
      return;
    }

    config = builder.normalizeConfig(config || defaultConfig(), season.seeds || []);
    const validation = builder.validateConfig(config, season.seeds || []);
    const built = builder.buildConfiguredTournament(season.seeds || [], config, { seasonId: season.id });
    const totalSeeds = Array.isArray(season.seeds) ? season.seeds.length : 0;
    const excluded = Math.max(0, totalSeeds - Number(config.entrantCount || 0));

    mount.innerHTML = `
      <div class="builder-stack">
        <section class="glass season-hero-card">
          <p class="season-eyebrow">Bracket Builder</p>
          <h2 class="season-title">${escapeHtml(season.label || season.name || 'Season Championship')}</h2>
          <p class="muted text-sm">The current seed order is the source of truth. Building a draft does not create games or lock the official bracket.</p>
        </section>

        <section class="glass season-card">
          <h3 class="season-section-title">Tournament Field</h3>
          <div class="builder-summary-grid mt-3">
            <div class="builder-stat"><span class="muted text-xs">Available seeds</span><strong>${escapeHtml(totalSeeds)}</strong></div>
            <div class="builder-stat"><span class="muted text-xs">Tournament entrants</span><strong>${escapeHtml(config.entrantCount)}</strong></div>
            <div class="builder-stat"><span class="muted text-xs">Excluded</span><strong>${escapeHtml(excluded)}</strong></div>
            <div class="builder-stat"><span class="muted text-xs">Stages</span><strong>${escapeHtml(config.rounds.length)}</strong></div>
          </div>
          <div class="builder-controls-grid mt-4">
            <label class="builder-field"><span>Starting structure</span><select class="season-admin-input" data-builder-preset><option value="${builder.SEASON_TWO_PRESET_ID}" ${config.presetId === builder.SEASON_TWO_PRESET_ID ? 'selected' : ''} ${totalSeeds < 60 ? 'disabled' : ''}>Season 2: 60 → 48 → 32</option><option value="custom_single_elimination" ${config.presetId !== builder.SEASON_TWO_PRESET_ID ? 'selected' : ''}>Auto-fit single elimination</option></select></label>
            <label class="builder-field"><span>Use top N seeds</span><input class="season-admin-input" type="number" min="2" max="${escapeHtml(totalSeeds)}" data-builder-entrant-count value="${escapeHtml(config.entrantCount)}"></label>
            <button type="button" class="btn btn-teal btn-toolbar" data-builder-action="apply-structure">Generate structure</button>
            <button type="button" class="btn btn-ghost btn-toolbar" data-builder-action="fit-dates">Fit dates to season</button>
          </div>
          <div class="mt-4">${renderTierSummary()}</div>
        </section>

        <section class="glass season-card">
          <div class="season-card-header"><div><h3 class="season-section-title">Round Setup</h3><p class="muted text-sm">Edit names, best-of lengths, dates, and tie behavior. Field size determines the elimination structure.</p></div></div>
          <div class="builder-round-list mt-3">${config.rounds.map(renderRoundEditor).join('')}</div>
        </section>

        <section class="glass season-card">
          <h3 class="season-section-title">Validation</h3>
          <div class="mt-3">${renderValidation(validation)}</div>
        </section>

        <section class="glass season-card">
          <div class="season-card-header"><div><h3 class="season-section-title">Live Bracket Preview</h3><p class="muted text-sm">Pairings update from the locked seed order. Awaiting-winner slots show where each series feeds next.</p></div></div>
          <div class="mt-3">${renderBracketPreview(built)}</div>
        </section>

        <div class="builder-sticky-actions">
          <a href="season.html" class="btn btn-ghost btn-toolbar">Back to Seeds</a>
          <button type="button" class="btn btn-teal btn-toolbar" data-builder-action="save-draft">Save Bracket Draft</button>
          <button type="button" class="btn btn-success btn-toolbar" data-builder-action="create-official" ${validation.ok ? '' : 'disabled'}>Create Official Bracket</button>
        </div>
      </div>`;
  }

  function applyStructure() {
    const preset = mount.querySelector('[data-builder-preset]')?.value;
    const count = Math.min(Number(mount.querySelector('[data-builder-entrant-count]')?.value) || 2, season.seeds.length);
    if (preset === builder.SEASON_TWO_PRESET_ID) {
      if (season.seeds.length < 60) {
        global.alert?.('The Season 2 preset requires 60 locked seeds.');
        return;
      }
      config = builder.createSeasonTwoPreset({ startDate: season.startDate, endDate: season.endDate });
    } else {
      config = builder.createGenericConfig({ entrantCount: count, startDate: season.startDate, endDate: season.endDate, name: season.name });
    }
    render();
  }

  function fitDates() {
    readConfigFromForm();
    config = { ...config, rounds: builder.fitRoundDates(config.rounds, season.startDate, season.endDate) };
    render();
  }

  function saveDraft() {
    readConfigFromForm();
    const validation = builder.validateConfig(config, season.seeds || []);
    const built = builder.buildConfiguredTournament(season.seeds || [], config, { seasonId: season.id });
    if (!validation.ok || !built.ok) {
      global.alert?.(`Bracket draft was not saved: ${validation.errors.concat(built.errors || []).join(' ')}`);
      render();
      return;
    }
    const nowISO = new Date().toISOString();
    const nextSeason = {
      ...season,
      bracketConfig: validation.config,
      dateWindows: validation.config.rounds.map((round) => ({ ...round })),
      updatedAtISO: nowISO,
      meta: { ...(season.meta || {}), seedsLockedForBuilder: true, bracketDraftSavedAtISO: nowISO }
    };
    state = saveState({ ...state, currentSeason: nextSeason }, 'season-bracket-builder-save-draft');
    season = state.currentSeason;
    config = season.bracketConfig;
    render();
    global.alert?.('Bracket draft saved. The official bracket has not been created yet.');
  }

  function createOfficial() {
    readConfigFromForm();
    const validation = builder.validateConfig(config, season.seeds || []);
    if (!validation.ok) {
      global.alert?.(`Fix these issues first: ${validation.errors.join(' ')}`);
      render();
      return;
    }
    const message = `Create the official ${config.entrantCount}-player bracket now? Seeds and bracket paths will lock, but Admin Mode will remain available for repairs.`;
    if (typeof global.confirm === 'function' && !global.confirm(message)) return;
    const result = builder.lockConfiguredSeasonBracket(state, validation.config, { nowISO: new Date().toISOString() });
    if (!result.ok) {
      global.alert?.(`Official bracket creation failed: ${(result.errors || []).join(' ') || result.error || 'unknown error'}`);
      return;
    }
    saveState(result.state, 'season-bracket-builder-create-official');
    global.location.href = 'season.html';
  }

  mount.addEventListener('change', (event) => {
    if (event.target?.matches?.('[data-builder-round-name],[data-builder-round-best-of],[data-builder-round-start],[data-builder-round-end],[data-builder-round-tie]')) {
      readConfigFromForm();
      render();
    }
  });

  mount.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-builder-action]');
    if (!button) return;
    const action = button.dataset.builderAction;
    if (action === 'apply-structure') applyStructure();
    if (action === 'fit-dates') fitDates();
    if (action === 'save-draft') saveDraft();
    if (action === 'create-official') createOfficial();
  });

  try {
    state = loadState();
    season = state.currentSeason || null;
    config = season?.bracketConfig || defaultConfig();
    render();
  } catch (error) {
    console.error('Failed to load bracket builder', error);
    mount.innerHTML = `<section class="glass season-card"><h2 class="season-title">Bracket builder failed to load</h2><p class="muted text-sm">${escapeHtml(error?.message || error)}</p><a href="season.html" class="btn btn-teal btn-toolbar mt-3">Return to Season</a></section>`;
  }
})(window);
