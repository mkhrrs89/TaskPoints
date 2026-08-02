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

  function refresh() {
    return render(countActiveInboxItems());
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
    if (observer || typeof global.MutationObserver !== 'function' || !document?.documentElement) return;
    observer = new global.MutationObserver((mutations) => {
      const needsRefresh = mutations.some((mutation) => (
        Array.from(mutation.addedNodes || []).some(nodeContainsInboxLink)
      ));
      if (needsRefresh) queueRefresh();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function start() {
    refresh();
    observeLinks();
    global.setTimeout?.(refresh, 0);
    global.setTimeout?.(refresh, 150);
  }

  global.addEventListener?.('storage', (event) => {
    if (!event?.key || event.key === STORAGE_KEY) queueRefresh();
  });
  global.addEventListener?.('pageshow', queueRefresh);
  global.addEventListener?.('focus', queueRefresh);
  global.addEventListener?.('taskpoints:inbox-updated', queueRefresh);
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
  const SCRIPT_SRC = '/home_featured_matchup_visibility.js?v=20260801-1';

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
