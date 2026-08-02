(function installHomeFeaturedMatchupVisibility(global) {
  'use strict';

  const MOUNT_ID = 'homeSeasonChampionshipMount';
  const STYLE_ID = 'tp-home-featured-matchup-mobile-style';
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
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[character]));
  }

  function ensureResponsiveStyle() {
    const documentRef = global.document;
    if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;

    const style = documentRef.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      @media (max-width: 640px) {
        .home-season-featured-kicker {
          width: 100%;
          flex-wrap: nowrap !important;
          white-space: nowrap;
          gap: 5px !important;
          font-size: 0.64rem !important;
          letter-spacing: 0.08em !important;
        }

        .home-season-featured-kicker > span {
          flex: 0 0 auto;
        }
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

    if (!featured) {
      return { visible: false, reason: 'no-featured-matchup', featured: null, html: '' };
    }

    const featuredTitle = featured.title || 'Featured matchup';
    const featuredRoundLine = `${featured.roundName || 'Round'}${featured.gameNumber ? `, Gm ${featured.gameNumber}` : ''}`;
    const featuredDetail = `${featured.statusText || ''}${featured.isEliminationGame ? ' • Elimination game' : ''}`;
    const html = `
      <section class="home-season-featured" aria-label="Featured tournament matchup">
        <div class="home-season-featured-kicker">
          <span>Featured Matchup</span>
          ${featuredRoundLine ? `<span class="home-season-featured-divider">|</span><span>${escapeHtml(featuredRoundLine)}</span>` : ''}
        </div>

        <strong class="home-season-featured-title">${escapeHtml(featuredTitle)}</strong>

        ${featuredDetail ? `<span class="home-season-featured-status">${escapeHtml(featuredDetail)}</span>` : ''}
      </section>
    `;

    return { visible: true, reason: 'featured-matchup', featured, html };
  }

  function setHidden(mount, hidden) {
    if (mount.classList?.toggle) mount.classList.toggle('hidden', hidden);
    else if (hidden) mount.classList?.add?.('hidden');
    else mount.classList?.remove?.('hidden');
  }

  function renderHomeFeaturedMatchup(stateInput = null, todayKey = localDateKey()) {
    const mount = global.document?.getElementById?.(MOUNT_ID);
    if (!mount) return { visible: false, reason: 'missing-mount', featured: null, html: '' };

    const view = buildFeaturedView(stateInput || loadState(), todayKey);
    setHidden(mount, !view.visible);

    if (!view.visible) {
      if (mount.innerHTML) mount.innerHTML = '';
      mount.removeAttribute?.('data-tp-featured-matchup');
      return view;
    }

    if (mount.innerHTML !== view.html) mount.innerHTML = view.html;
    mount.setAttribute?.('data-tp-featured-matchup', 'active');
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
    // Replace the June-only page renderer after index.html has defined it.
    global.renderHomeSeasonChampionshipCard = renderHomeFeaturedMatchup;
    ensureResponsiveStyle();
    renderHomeFeaturedMatchup();
    observeMount();
  }

  const api = {
    ACTIVE_SEASON_STATUSES,
    localDateKey,
    buildFeaturedView,
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
