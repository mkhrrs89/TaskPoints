(function(global){
  const core = global.TaskPointsCore || {};

  const STATUS_LABELS = {
    preview: 'Preview',
    locked: 'Locked',
    active: 'Active',
    champion_crowned: 'Champion Crowned',
    finalized: 'Finalized'
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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
      { displayName: 'Play-In', bestOf: 3 },
      { displayName: 'Round of 32', bestOf: 5 },
      { displayName: 'Sweet 16', bestOf: 5 },
      { displayName: 'Quarterfinals', bestOf: 5 },
      { displayName: 'Semifinals', bestOf: 5 },
      { displayName: 'Finals', bestOf: 7 }
    ];
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
        <p class="muted text-sm">Preview and bracket tools coming next.</p>
        <p class="muted text-sm">Season preview tools coming next.</p>
      </section>
      <section class="glass season-card">
        <h3 class="season-section-title">Planned Format</h3>
        <p class="muted text-sm mb-3">A safe shell is in place now; tournament games, seeding previews, and bracket advancement are not active yet.</p>
        ${renderFormatList()}
      </section>
    `;
  }

  function renderCurrentSeason(season) {
    const name = season?.name || season?.label || 'Season 1';
    const status = getSeasonStatusLabel(season?.status);
    const monthKey = season?.monthKey || '—';
    const start = formatSeasonDate(season?.startDate) || '—';
    const end = formatSeasonDate(season?.endDate) || '—';
    return `
      <section class="glass season-hero-card">
        <p class="season-eyebrow">Current Season</p>
        <h2 class="season-title">${escapeHtml(name)}</h2>
        <p class="muted text-sm">${escapeHtml(getSeasonSummaryLine(season))}</p>
      </section>
      <section class="glass season-card">
        <h3 class="season-section-title">Season Snapshot</h3>
        <dl class="season-detail-grid">
          <div><dt>Status</dt><dd>${escapeHtml(status)}</dd></div>
          <div><dt>Month</dt><dd>${escapeHtml(monthKey)}</dd></div>
          <div><dt>Start</dt><dd>${escapeHtml(start)}</dd></div>
          <div><dt>End</dt><dd>${escapeHtml(end)}</dd></div>
        </dl>
        <p class="muted text-sm mt-4">Season tools will appear here in the next update.</p>
      </section>
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

  function loadSeasonState() {
    if (typeof core.loadAppState === 'function') {
      return core.loadAppState({ syncDerived: false, persistSync: false });
    }
    return normalizeSeasonViewState({});
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
  }

  global.TaskPointsSeason = {
    getSeasonStatusLabel,
    getSeasonTabTitle,
    getSeasonSummaryLine,
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
