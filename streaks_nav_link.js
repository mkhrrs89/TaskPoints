;(function installTaskPointsStreaksNavLink(global) {
  'use strict';

  if (global.TaskPointsStreaksNavLink?.installed) return;

  const LINK_ATTR = 'data-taskpoints-streaks-nav';
  let observer = null;
  let stopTimer = null;

  function isMobileToolbarLink(anchor) {
    return anchor?.closest?.('#mobileBottomNav .mobile-bottom-nav-secondary');
  }

  function ensureLink() {
    const document = global.document;
    if (!document?.querySelector) return false;

    const existing = document.querySelector(`[${LINK_ATTR}]`);
    if (existing && isMobileToolbarLink(existing)) return true;

    const secondary = document.querySelector('#mobileBottomNav .mobile-bottom-nav-secondary');
    if (!secondary) return false;

    const today = Array.from(secondary.querySelectorAll('a[href]')).find((anchor) => {
      const href = String(anchor.getAttribute('href') || '').split(/[?#]/)[0];
      return href === 'today.html' || href.endsWith('/today.html');
    });
    if (!today) return false;

    const link = document.createElement('a');
    link.href = 'streaks.html';
    link.className = 'mobile-bottom-nav-btn flex flex-col items-center gap-0.5 opacity-80 hover:opacity-100';
    link.setAttribute(LINK_ATTR, 'true');
    link.setAttribute('aria-label', 'Streaks');

    const icon = document.createElement('span');
    icon.className = 'tp-nav-emoji';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '🔥';

    const label = document.createElement('span');
    label.className = 'uppercase tracking-wide text-[10px]';
    label.textContent = 'Streaks';

    link.append(icon, label);
    today.insertAdjacentElement('afterend', link);
    return true;
  }

  function watchForToolbar() {
    if (ensureLink()) return true;
    const document = global.document;
    if (!document?.documentElement || typeof global.MutationObserver !== 'function') return false;
    if (observer) return true;

    observer = new global.MutationObserver(() => {
      ensureLink();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    stopTimer = global.setTimeout?.(() => {
      observer?.disconnect?.();
      observer = null;
      stopTimer = null;
      ensureLink();
    }, 10000) || null;
    return true;
  }

  function install() {
    if (global.document?.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', watchForToolbar, { once: true });
    } else {
      watchForToolbar();
    }
    global.addEventListener?.('pageshow', ensureLink);
    return true;
  }

  global.TaskPointsStreaksNavLink = {
    installed: true,
    install,
    ensureLink
  };

  install();
})(typeof window !== 'undefined' ? window : globalThis);
