(function installTaskPointsInboxCountBadge(global) {
  'use strict';

  if (global.TaskPointsInboxCountBadge?.installed) return;

  const core = global.TaskPointsCore;
  const STORAGE_KEY = core?.STORAGE_KEY || 'taskpoints_v1';
  const BADGE_CLASS = 'tp-inbox-count-badge';
  const STYLE_ID = 'tpInboxCountBadgeStyles';
  let observer = null;
  let refreshQueued = false;

  function readState() {
    try {
      if (typeof core?.readTaskPointsStoredState === 'function') {
        const state = core.readTaskPointsStoredState(STORAGE_KEY, {});
        return state && typeof state === 'object' ? state : {};
      }
      const raw = global.localStorage?.getItem?.(STORAGE_KEY);
      if (!raw) return {};
      if (typeof core?.parseTaskPointsStorageJson === 'function') {
        const state = core.parseTaskPointsStorageJson(raw, {});
        return state && typeof state === 'object' ? state : {};
      }
      const state = JSON.parse(raw);
      return state && typeof state === 'object' ? state : {};
    } catch (_) {
      return {};
    }
  }

  function countActiveInboxItems(stateInput = null) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : readState();
    return (Array.isArray(state.inboxMessages) ? state.inboxMessages : [])
      .filter((item) => item && item.archived !== true)
      .length;
  }

  function isInboxLink(link) {
    if (!link?.getAttribute) return false;
    const href = String(link.getAttribute('href') || '').trim();
    return /(^|\/)inbox\.html(?:[?#].*)?$/.test(href);
  }

  function inboxLinks() {
    const document = global.document;
    if (!document?.querySelectorAll) return [];
    return Array.from(document.querySelectorAll('a[href]')).filter(isInboxLink);
  }

  function ensureStyles() {
    const document = global.document;
    if (!document?.createElement || document.getElementById?.(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${BADGE_CLASS} {
        position: absolute;
        top: -0.4rem;
        right: -0.45rem;
        z-index: 3;
        min-width: 1.15rem;
        height: 1.15rem;
        padding: 0 0.24rem;
        border: 2px solid #0f172a;
        border-radius: 9999px;
        background: #f97316;
        color: #fff;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        font-size: 0.65rem;
        font-weight: 800;
        line-height: 1;
        letter-spacing: -0.02em;
        pointer-events: none;
      }
      .mobile-bottom-nav-btn .${BADGE_CLASS} {
        top: -0.15rem;
        right: calc(50% - 1.55rem);
      }
    `;
    (document.head || document.documentElement || document.body)?.appendChild?.(style);
  }

  function baseLabelFor(link) {
    const stored = link.getAttribute?.('data-tp-inbox-base-label');
    if (stored) return stored;
    const base = String(link.getAttribute?.('aria-label') || link.textContent || 'Inbox').trim() || 'Inbox';
    link.setAttribute?.('data-tp-inbox-base-label', base);
    return base;
  }

  function ensureBadge(link) {
    let badge = link.querySelector?.(`.${BADGE_CLASS}`) || null;
    if (!badge) {
      badge = global.document?.createElement?.('span') || null;
      if (!badge) return null;
      badge.className = BADGE_CLASS;
      badge.setAttribute?.('aria-hidden', 'true');
      link.appendChild?.(badge);
    }
    if (link.style && (!link.style.position || link.style.position === 'static')) {
      link.style.position = 'relative';
    }
    return badge;
  }

  function render(countInput = null) {
    ensureStyles();
    const count = Number.isFinite(Number(countInput))
      ? Math.max(0, Math.floor(Number(countInput)))
      : countActiveInboxItems();

    inboxLinks().forEach((link) => {
      const baseLabel = baseLabelFor(link);
      const existing = link.querySelector?.(`.${BADGE_CLASS}`) || null;
      if (count <= 0) {
        if (existing) {
          existing.hidden = true;
          if (existing.style) existing.style.display = 'none';
        }
        link.removeAttribute?.('data-inbox-count');
        link.setAttribute?.('aria-label', baseLabel);
        return;
      }

      const badge = ensureBadge(link);
      if (!badge) return;
      badge.hidden = false;
      if (badge.style) badge.style.display = 'inline-flex';
      badge.textContent = String(count);
      link.setAttribute?.('data-inbox-count', String(count));
      link.setAttribute?.('aria-label', `${baseLabel}, ${count} inbox item${count === 1 ? '' : 's'}`);
    });

    return count;
  }

  function emitInboxStateSnapshotIfNeeded(state, count) {
    const knownCount = Number(global.__tpInboxKnownCount);
    if (!Number.isFinite(knownCount) || knownCount === count) return false;
    if (typeof global.dispatchEvent !== 'function' || typeof global.CustomEvent !== 'function') return false;

    global.dispatchEvent(new global.CustomEvent('taskpoints:inbox-state-snapshot', {
      detail: {
        count,
        inboxMessages: Array.isArray(state?.inboxMessages) ? state.inboxMessages : []
      }
    }));
    return true;
  }

  function refresh() {
    const state = readState();
    const count = countActiveInboxItems(state);
    render(count);
    emitInboxStateSnapshotIfNeeded(state, count);
    return count;
  }

  function queueRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    const run = () => {
      refreshQueued = false;
      refresh();
    };
    if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(run);
    else global.setTimeout?.(run, 0);
  }

  function nodeContainsInboxLink(node) {
    if (!node || node.nodeType !== 1) return false;
    if (isInboxLink(node)) return true;
    const links = node.querySelectorAll?.('a[href]');
    return Array.from(links || []).some(isInboxLink);
  }

  function observeLinks() {
    const document = global.document;
    if (observer) return true;
    if (typeof global.MutationObserver !== 'function' || !document?.documentElement) return false;
    observer = new global.MutationObserver((mutations) => {
      const needsRefresh = mutations.some((mutation) => (
        Array.from(mutation.addedNodes || []).some(nodeContainsInboxLink)
      ));
      if (needsRefresh) queueRefresh();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return true;
  }

  function start() {
    const knownCount = Number(global.__tpInboxKnownCount);
    if (Number.isFinite(knownCount)) render(knownCount);
    else refresh();

    const observing = observeLinks();
    // MutationObserver normally catches toolbar links inserted after startup.
    // Keep one delayed fallback only for older environments without it.
    if (!observing) global.setTimeout?.(refresh, 150);
  }

  global.addEventListener?.('storage', (event) => {
    if (!event?.key || event.key === STORAGE_KEY) queueRefresh();
  });
  global.addEventListener?.('pageshow', queueRefresh);
  global.addEventListener?.('focus', queueRefresh);
  global.addEventListener?.('taskpoints:inbox-updated', (event) => {
    const count = Number(event?.detail?.count);
    if (Number.isFinite(count)) render(count);
    else queueRefresh();
  });
  global.document?.addEventListener?.('visibilitychange', () => {
    if (global.document?.visibilityState !== 'hidden') queueRefresh();
  });

  const api = {
    installed: true,
    count: countActiveInboxItems,
    refresh,
    render
  };
  global.TaskPointsInboxCountBadge = api;

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

(function loadTaskPointsHomeFeaturedMatchupModule(global) {
  'use strict';

  const SCRIPT_ID = 'tpHomeFeaturedMatchupScript';
  const SCRIPT_SRC = '/home_featured_matchup_visibility.js?v=20260807-1';

  function load() {
    const document = global.document;
    if (!document?.getElementById?.('homeSeasonChampionshipMount')) return false;

    if (global.TaskPointsHomeFeaturedMatchup?.install) {
      global.TaskPointsHomeFeaturedMatchup.install();
      return true;
    }

    if (document.getElementById(SCRIPT_ID)) return true;
    const script = document.createElement?.('script');
    if (!script) return false;
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = false;
    script.setAttribute?.('data-taskpoints-home-featured-matchup', 'true');
    (document.body || document.head || document.documentElement)?.appendChild?.(script);
    return true;
  }

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', load, { once: true });
  } else {
    load();
  }
})(typeof window !== 'undefined' ? window : globalThis);

(function loadTaskPointsDynamicTournamentBracket(global) {
  'use strict';

  const SCRIPT_ID = 'tpDynamicTournamentBracketScript';
  const SCRIPT_SRC = '/tournament_dynamic_bracket.js?v=20260802-1';

  function load() {
    const document = global.document;
    const bracket = document?.getElementById?.('tournamentBracket');
    if (!bracket) return false;

    if (global.TaskPointsDynamicTournamentBracket?.render) {
      global.TaskPointsDynamicTournamentBracket.render();
      return true;
    }

    if (document.getElementById(SCRIPT_ID)) return true;
    const script = document.createElement?.('script');
    if (!script) return false;
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = false;
    script.setAttribute?.('data-taskpoints-dynamic-tournament', 'true');
    (document.body || document.head || document.documentElement)?.appendChild?.(script);
    return true;
  }

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', load, { once: true });
  } else {
    load();
  }
})(typeof window !== 'undefined' ? window : globalThis);

(function loadTaskPointsSeasonResultIntegrity(global) {
  'use strict';

  const SCRIPT_ID = 'tpSeasonResultIntegrityScript';
  const SCRIPT_SRC = '/season_result_integrity_guard.js?v=20260803-1';

  function load() {
    if (global.TaskPointsSeasonResultIntegrity?.installed) return true;
    const document = global.document;
    if (!document?.createElement) return false;
    if (document.getElementById?.(SCRIPT_ID)) return true;
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = false;
    script.setAttribute?.('data-taskpoints-season-result-integrity', 'true');
    (document.head || document.body || document.documentElement)?.appendChild?.(script);
    return true;
  }

  load();
  global.addEventListener?.('pageshow', load);
})(typeof window !== 'undefined' ? window : globalThis);

(function loadTaskPointsResponsiveExport(global) {
  'use strict';

  const SCRIPT_ID = 'tpResponsiveExportScript';
  const SCRIPT_SRC = '/home_export_responsiveness.js?v=20260803-3';
  const EXPORT_SELECTOR = '[data-export-button]';
  const loaderState = global.__tpResponsiveExportLoaderState || {
    pending: false,
    guard: null
  };
  global.__tpResponsiveExportLoaderState = loaderState;

  function isMainPage() {
    const pathname = String(global.location?.pathname || '');
    return pathname === '/' || pathname === '' || pathname.endsWith('/index.html');
  }

  function readProjects() {
    try {
      const raw = global.localStorage?.getItem?.('tp_projects_v1');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function stripLegacyImages(snapshot) {
    const next = { ...(snapshot || {}) };
    if (next.youImage) delete next.youImage;
    if (Array.isArray(next.players)) {
      next.players = next.players.map((player) => {
        if (!player || typeof player !== 'object') return player;
        const { imageData, ...rest } = player;
        return rest;
      });
    }
    return next;
  }

  function installSecondarySnapshotProvider() {
    if (isMainPage() || typeof global.getTaskPointsExportSnapshot === 'function') return;

    global.getTaskPointsExportSnapshot = function getSecondaryTaskPointsExportSnapshot() {
      const core = global.TaskPointsCore || {};
      core.flushPendingSaves?.();

      let state = {};
      try {
        state = typeof core.loadAppState === 'function'
          ? (core.loadAppState({ syncDerived: false, persistSync: false })?.state || {})
          : {};
      } catch (error) {
        console.warn('Secondary-page export could not load current state', error);
      }

      if (!state || typeof state !== 'object' || !Object.keys(state).length) {
        try {
          const storageKey = core.STORAGE_KEY || 'taskpoints_v1';
          state = typeof core.readTaskPointsStoredState === 'function'
            ? core.readTaskPointsStoredState(storageKey, {})
            : JSON.parse(global.localStorage?.getItem?.(storageKey) || '{}');
        } catch (_) {
          state = {};
        }
      }

      const withProjects = { ...state, projects: readProjects() };
      const normalized = stripLegacyImages(
        typeof core.normalizeState === 'function' ? core.normalizeState(withProjects) : withProjects
      );

      const prepareSchedule = global.ensureUpcomingScheduleFallback;
      const scheduleChanged = typeof prepareSchedule === 'function'
        ? Boolean(prepareSchedule(normalized))
        : false;

      if (scheduleChanged) {
        if (typeof global.saveStateSnapshotFallback === 'function') {
          global.saveStateSnapshotFallback(normalized, { source: 'responsive-export-schedule-prep' });
        } else if (typeof core.saveValidatedSnapshot === 'function') {
          core.saveValidatedSnapshot(normalized, {
            storageKey: core.STORAGE_KEY || 'taskpoints_v1',
            immediateWrite: true,
            source: 'responsive-export-schedule-prep'
          });
        } else if (typeof core.saveStateSnapshot === 'function') {
          core.saveStateSnapshot(normalized, {
            storageKey: core.STORAGE_KEY || 'taskpoints_v1',
            immediateWrite: true
          });
        }
      }

      let notesText = typeof normalized.notes === 'string' ? normalized.notes : '';
      if (typeof global.syncNotesStorageLocations === 'function') {
        try { notesText = global.syncNotesStorageLocations('responsive-export-sync'); } catch (_) {}
      } else {
        try {
          const cached = global.localStorage?.getItem?.('taskpoints_notes_v1') || '';
          if (cached.length >= notesText.length) notesText = cached;
        } catch (_) {}
      }
      normalized.notes = notesText;

      let projectsRaw = null;
      try { projectsRaw = global.localStorage?.getItem?.('tp_projects_v1'); } catch (_) {}

      return {
        exportType: 'taskpoints_full_backup',
        version: 2,
        exportedAtISO: new Date().toISOString(),
        state: normalized,
        aux: {
          taskpoints_notes_v1: notesText,
          ...(typeof projectsRaw === 'string' ? { tp_projects_v1: projectsRaw } : {})
        }
      };
    };
  }

  function exportButtons() {
    return Array.from(global.document?.querySelectorAll?.(EXPORT_SELECTOR) || []);
  }

  function markPreparing() {
    exportButtons().forEach((button) => {
      if (!button.getAttribute?.('data-tp-export-original-label')) {
        button.setAttribute?.(
          'data-tp-export-original-label',
          String(button.textContent || 'Export').trim() || 'Export'
        );
      }
      button.disabled = true;
      button.setAttribute?.('aria-busy', 'true');
      button.textContent = 'Preparing…';
    });
  }

  function restoreButtons() {
    exportButtons().forEach((button) => {
      button.textContent = button.getAttribute?.('data-tp-export-original-label') || 'Export';
      button.disabled = false;
      button.removeAttribute?.('aria-busy');
    });
  }

  function installLoadingGuard() {
    if (loaderState.guard || global.TaskPointsResponsiveExport?.installed) return;
    const document = global.document;
    if (!document?.addEventListener) return;

    loaderState.guard = (event) => {
      const button = event.target?.closest?.(EXPORT_SELECTOR);
      if (!button) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
      loaderState.pending = true;
      markPreparing();
    };
    document.addEventListener('click', loaderState.guard, true);
  }

  function releaseLoadingGuard() {
    if (loaderState.guard) {
      global.document?.removeEventListener?.('click', loaderState.guard, true);
      loaderState.guard = null;
    }
  }

  function handOffPendingExport() {
    const shouldStart = loaderState.pending;
    loaderState.pending = false;
    releaseLoadingGuard();

    if (!shouldStart) return;
    const start = global.TaskPointsResponsiveExport?.startExport;
    if (typeof start === 'function') {
      Promise.resolve(start()).catch(() => {});
    } else {
      restoreButtons();
    }
  }

  function handleLoadFailure() {
    loaderState.pending = false;
    releaseLoadingGuard();
    restoreButtons();
    console.error('TaskPoints responsive export controller failed to load.');
  }

  function load() {
    installSecondarySnapshotProvider();
    installLoadingGuard();

    if (global.TaskPointsResponsiveExport?.installed) {
      handOffPendingExport();
      return true;
    }

    const document = global.document;
    if (!document?.querySelector?.(EXPORT_SELECTOR) || !document.createElement) return false;

    const existing = document.getElementById?.(SCRIPT_ID);
    if (existing) {
      existing.addEventListener?.('load', handOffPendingExport, { once: true });
      existing.addEventListener?.('error', handleLoadFailure, { once: true });
      return true;
    }

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = false;
    script.setAttribute?.('data-taskpoints-responsive-export', 'true');
    script.addEventListener?.('load', handOffPendingExport, { once: true });
    script.addEventListener?.('error', handleLoadFailure, { once: true });
    (document.head || document.body || document.documentElement)?.appendChild?.(script);
    return true;
  }

  installSecondarySnapshotProvider();
  installLoadingGuard();
  if (!load()) {
    global.document?.addEventListener?.('DOMContentLoaded', load, { once: true });
  }
  global.addEventListener?.('pageshow', load);
})(typeof window !== 'undefined' ? window : globalThis);
