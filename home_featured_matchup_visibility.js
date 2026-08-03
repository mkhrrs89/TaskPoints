(function installHomeFeaturedMatchupVisibility(global) {
  'use strict';

  const MOUNT_ID = 'homeSeasonChampionshipMount';
  const STYLE_ID = 'tp-home-featured-matchup-mobile-style';
  const SCOREBOARD_FORMAT_CLASS = 'home-scoreboard-series-format';
  const ACTIVE_SEASON_STATUSES = new Set(['locked', 'active']);
  let observer = null;
  let renderScheduled = false;

  function localDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  function normalizeBestOf(value) {
    const bestOf = Math.floor(Number(value));
    return Number.isFinite(bestOf) && bestOf > 0 ? bestOf : null;
  }

  function resolveMatchupBestOf(matchup, season, core) {
    const direct = normalizeBestOf(matchup?.bestOf ?? matchup?.seriesBestOf ?? matchup?.series?.bestOf);
    if (direct) return direct;

    const seriesId = matchup?.seriesId || matchup?.seasonSeriesId || matchup?.series?.id || '';
    const series = seriesId && season?.series ? season.series[seriesId] : null;
    const storedSeriesBestOf = normalizeBestOf(series?.bestOf);
    if (storedSeriesBestOf) return storedSeriesBestOf;

    const roundId = matchup?.roundId || series?.roundId || '';
    if (roundId && typeof core?.getSeasonSeriesLength === 'function') {
      try {
        const configured = normalizeBestOf(core.getSeasonSeriesLength(roundId, season));
        if (configured) return configured;
      } catch (_) {}
    }

    for (const rounds of [season?.dateWindows, season?.bracketConfig?.rounds, season?.bracket?.rounds]) {
      const round = (Array.isArray(rounds) ? rounds : []).find((item) => {
        if (!item) return false;
        if (roundId && item.id === roundId) return true;
        return matchup?.roundName && item.displayName === matchup.roundName;
      });
      const configured = normalizeBestOf(round?.bestOf);
      if (configured) return configured;
    }

    return null;
  }

  function resolveFeaturedBestOf(featured, season, core) {
    return resolveMatchupBestOf(featured, season, core);
  }

  function ensureResponsiveStyle() {
    const documentRef = global.document;
    if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
    const style = documentRef.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${SCOREBOARD_FORMAT_CLASS} {
        color: #cbd5e1;
        font-size: 0.76rem;
        font-weight: 700;
        line-height: 1.1;
        letter-spacing: 0.08em;
        margin-top: 4px;
        text-transform: uppercase;
      }
      @media (max-width: 640px) {
        .home-season-featured-kicker {
          width: 100%;
          flex-wrap: nowrap !important;
          white-space: nowrap;
          gap: 5px !important;
          font-size: 0.64rem !important;
          letter-spacing: 0.08em !important;
        }
        .home-season-featured-kicker > span { flex: 0 0 auto; }
        .${SCOREBOARD_FORMAT_CLASS} { font-size: 0.7rem; margin-top: 3px; }
      }
    `;
    documentRef.head.appendChild(style);
  }

  function loadState() {
    const core = global.TaskPointsCore;
    try {
      if (typeof core?.loadAppState === 'function') {
        const loaded = core.loadAppState({ syncDerived: false, persistSync: false });
        return loaded?.state || loaded || {};
      }
      if (typeof core?.readTaskPointsStoredState === 'function') {
        return core.readTaskPointsStoredState(core.STORAGE_KEY || 'taskpoints_v1', {}) || {};
      }
    } catch (error) {
      console.warn('Home featured matchup state could not be loaded', error);
    }
    return {};
  }

  function buildFeaturedView(stateInput, todayKey = localDateKey()) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const season = state.currentSeason;
    const core = global.TaskPointsCore;
    if (!season || !ACTIVE_SEASON_STATUSES.has(String(season.status || '')) || !core) {
      return { visible: false, reason: 'inactive-season', featured: null, html: '' };
    }

    const featured = typeof core.getFeaturedSeasonMatchup === 'function'
      ? core.getFeaturedSeasonMatchup(season, todayKey, state)
      : null;
    if (!featured) return { visible: false, reason: 'no-featured-matchup', featured: null, html: '' };

    const title = featured.title || 'Featured matchup';
    const roundLine = `${featured.roundName || 'Round'}${featured.gameNumber ? `, Gm ${featured.gameNumber}` : ''}`;
    const detail = `${featured.statusText || ''}${featured.isEliminationGame ? ' • Elimination game' : ''}`;
    const html = `
      <section class="home-season-featured" aria-label="Featured tournament matchup">
        <div class="home-season-featured-kicker">
          <span>Featured Matchup</span>
          ${roundLine ? `<span class="home-season-featured-divider">|</span><span>${escapeHtml(roundLine)}</span>` : ''}
        </div>
        <strong class="home-season-featured-title">${escapeHtml(title)}</strong>
        ${detail ? `<span class="home-season-featured-status">${escapeHtml(detail)}</span>` : ''}
      </section>
    `;
    return { visible: true, reason: 'featured-matchup', featured, html };
  }

  function matchupDateKey(matchup) {
    return String(matchup?.dateKey || matchup?.date || matchup?.dateISO || '').slice(0, 10);
  }

  function getCurrentUserMatchup(stateInput, todayKey = localDateKey()) {
    const matchups = Array.isArray(stateInput?.matchups) ? stateInput.matchups : [];
    return matchups.find((matchup) => matchup
      && matchupDateKey(matchup) === todayKey
      && (matchup.playerAId === 'YOU' || matchup.playerBId === 'YOU')) || null;
  }

  function findSeriesLine(scoreboard) {
    const candidates = scoreboard?.querySelectorAll?.('div, span, p, strong') || [];
    for (const element of candidates) {
      if (/^SERIES\s*:/i.test(String(element?.textContent || '').trim())) return element;
    }
    return null;
  }

  function existingScoreboardLabels(scoreboard) {
    return Array.from(scoreboard?.querySelectorAll?.(`.${SCOREBOARD_FORMAT_CLASS}`) || []);
  }

  function removeScoreboardBestOf(scoreboard) {
    existingScoreboardLabels(scoreboard).forEach((element) => element.remove?.());
  }

  function renderCurrentSeriesBestOf(stateInput = null, todayKey = localDateKey()) {
    const documentRef = global.document;
    const scoreboard = documentRef?.querySelector?.('.home-scoreboard-card');
    if (!scoreboard) return { visible: false, reason: 'missing-scoreboard', bestOf: null };

    const state = stateInput || loadState();
    const season = state?.currentSeason;
    const matchup = getCurrentUserMatchup(state, todayKey);
    const bestOf = season && matchup
      ? resolveMatchupBestOf(matchup, season, global.TaskPointsCore)
      : null;

    if (!bestOf) {
      removeScoreboardBestOf(scoreboard);
      return { visible: false, reason: matchup ? 'unknown-series-length' : 'no-current-user-series', bestOf: null };
    }

    const expectedText = `Best of ${bestOf}`;
    const existing = existingScoreboardLabels(scoreboard);
    if (existing.length === 1 && String(existing[0].textContent || '').trim() === expectedText) {
      return { visible: true, reason: 'current-user-series', bestOf, matchup };
    }

    removeScoreboardBestOf(scoreboard);
    const seriesLine = findSeriesLine(scoreboard);
    if (!seriesLine) return { visible: false, reason: 'missing-series-line', bestOf };

    const label = documentRef.createElement?.('div');
    if (!label) return { visible: false, reason: 'cannot-create-label', bestOf };
    label.className = SCOREBOARD_FORMAT_CLASS;
    label.textContent = expectedText;
    label.setAttribute?.('aria-label', `Current series is best of ${bestOf}`);
    seriesLine.insertAdjacentElement?.('afterend', label);
    return { visible: true, reason: 'current-user-series', bestOf, matchup };
  }

  function setHidden(mount, hidden) {
    if (mount.classList?.toggle) mount.classList.toggle('hidden', hidden);
    else if (hidden) mount.classList?.add?.('hidden');
    else mount.classList?.remove?.('hidden');
  }

  function renderHomeFeaturedMatchup(stateInput = null, todayKey = localDateKey()) {
    const state = stateInput || loadState();
    const mount = global.document?.getElementById?.(MOUNT_ID);
    const view = mount
      ? buildFeaturedView(state, todayKey)
      : { visible: false, reason: 'missing-mount', featured: null, html: '' };

    if (mount) {
      setHidden(mount, !view.visible);
      if (!view.visible) {
        if (mount.innerHTML) mount.innerHTML = '';
        mount.removeAttribute?.('data-tp-featured-matchup');
      } else {
        if (mount.innerHTML !== view.html) mount.innerHTML = view.html;
        mount.setAttribute?.('data-tp-featured-matchup', 'active');
      }
    }

    renderCurrentSeriesBestOf(state, todayKey);
    return view;
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    const run = () => {
      renderScheduled = false;
      renderHomeFeaturedMatchup();
    };
    if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(run);
    else global.setTimeout?.(run, 0);
  }

  function observeMount() {
    if (observer || typeof global.MutationObserver !== 'function') return;
    const mount = global.document?.getElementById?.(MOUNT_ID);
    if (!mount) return;
    observer = new global.MutationObserver(scheduleRender);
    observer.observe(mount, { attributes: true, childList: true });
  }

  function install() {
    global.renderHomeSeasonChampionshipCard = renderHomeFeaturedMatchup;
    ensureResponsiveStyle();
    renderHomeFeaturedMatchup();
    observeMount();
  }

  const api = {
    ACTIVE_SEASON_STATUSES,
    SCOREBOARD_FORMAT_CLASS,
    localDateKey,
    resolveMatchupBestOf,
    resolveFeaturedBestOf,
    buildFeaturedView,
    getCurrentUserMatchup,
    renderCurrentSeriesBestOf,
    render: renderHomeFeaturedMatchup,
    install
  };

  global.TaskPointsHomeFeaturedMatchup = api;

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }

  global.addEventListener?.('pageshow', scheduleRender);
  global.addEventListener?.('storage', (event) => {
    const storageKey = global.TaskPointsCore?.STORAGE_KEY || 'taskpoints_v1';
    if (!event?.key || event.key === storageKey) scheduleRender();
  });
  global.document?.addEventListener?.('visibilitychange', () => {
    if (global.document.visibilityState === 'visible') scheduleRender();
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

(function installHomeStorageDiagnosticsLink(global) {
  'use strict';

  const LINK_ID = 'tpHomeStorageDiagnosticsLink';
  const EXPORT_SELECTOR = '[data-export-button]';

  function install() {
    const documentRef = global.document;
    if (!documentRef?.createElement || documentRef.getElementById?.(LINK_ID)) return false;

    const exportButton = documentRef.querySelector?.(EXPORT_SELECTOR);
    if (!exportButton) return false;

    const link = documentRef.createElement('a');
    link.id = LINK_ID;
    link.href = 'storage_diagnostics.html';
    link.className = 'btn btn-ghost btn-toolbar nav-btn';
    link.textContent = 'Diagnostics';
    link.setAttribute?.('aria-label', 'Open Storage Diagnostics');
    link.setAttribute?.('data-storage-diagnostics-link', 'true');

    if (typeof exportButton.insertAdjacentElement === 'function') {
      exportButton.insertAdjacentElement('afterend', link);
    } else {
      exportButton.parentNode?.appendChild?.(link);
    }
    return true;
  }

  function scheduleInstall() {
    if (install()) return;
    global.setTimeout?.(install, 0);
    global.setTimeout?.(install, 150);
    global.setTimeout?.(install, 600);
  }

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', scheduleInstall, { once: true });
  } else {
    scheduleInstall();
  }
  global.addEventListener?.('pageshow', scheduleInstall);

  global.TaskPointsHomeStorageDiagnosticsLink = { install };
})(typeof window !== 'undefined' ? window : globalThis);
