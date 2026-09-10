;(function installTaskPointsStreaksNavLink(global) {
  'use strict';

  if (global.TaskPointsStreaksNavLink?.installed) return;

  const LINK_ATTR = 'data-taskpoints-streaks-nav';
  let observer = null;
  let stopTimer = null;

  function hrefPath(anchor) {
    return String(anchor?.getAttribute?.('href') || '').split(/[?#]/)[0];
  }

  function findPrimaryRow(nav) {
    return Array.from(nav?.children || []).find((child) => (
      child?.classList?.contains('mobile-bottom-nav')
      && !child.classList.contains('mobile-bottom-nav-secondary')
    )) || null;
  }

  function isTopRowLink(anchor) {
    const nav = anchor?.closest?.('#mobileBottomNav');
    const primary = findPrimaryRow(nav);
    return Boolean(primary && anchor.parentElement === primary);
  }

  function createStreaksLink(document) {
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
    return link;
  }

  function ensureLink() {
    const document = global.document;
    if (!document?.querySelector) return false;

    const nav = document.querySelector('#mobileBottomNav');
    if (!nav) return false;

    const primary = findPrimaryRow(nav);
    const secondary = nav.querySelector('.mobile-bottom-nav-secondary');
    const taskDropdown = nav.querySelector('.mobile-task-dropdown');
    if (!primary || !secondary || !taskDropdown) return false;

    const today = Array.from(secondary.querySelectorAll('a[href]')).find((anchor) => {
      const href = hrefPath(anchor);
      return href === 'today.html' || href.endsWith('/today.html');
    });
    if (!today) return false;

    let link = nav.querySelector(`[${LINK_ATTR}]`)
      || Array.from(nav.querySelectorAll('a[href]')).find((anchor) => {
        const href = hrefPath(anchor);
        return href === 'streaks.html' || href.endsWith('/streaks.html');
      });

    if (!link) {
      link = createStreaksLink(document);
      // Keep the original insertion point as a safe fallback, then move it
      // into the exact top-row slot vacated by Tasks below.
      today.insertAdjacentElement('afterend', link);
    } else {
      link.setAttribute(LINK_ATTR, 'true');
    }

    // Streaks takes the exact primary-nav position currently occupied by Tasks.
    if (!isTopRowLink(link)) {
      if (taskDropdown.parentElement === primary) {
        taskDropdown.insertAdjacentElement('beforebegin', link);
      } else {
        const inbox = Array.from(primary.querySelectorAll('a[href]')).find((anchor) => {
          const href = hrefPath(anchor);
          return href === 'inbox.html' || href.endsWith('/inbox.html');
        });
        if (inbox) inbox.insertAdjacentElement('afterend', link);
        else primary.insertBefore(link, primary.children[2] || null);
      }
    }

    // Tasks takes Streaks' former expanded-row position immediately after Today.
    if (taskDropdown.parentElement !== secondary || taskDropdown.previousElementSibling !== today) {
      today.insertAdjacentElement('afterend', taskDropdown);
    }

    return isTopRowLink(link)
      && taskDropdown.parentElement === secondary
      && taskDropdown.previousElementSibling === today;
  }

  function watchForToolbar() {
    const ready = ensureLink();
    const document = global.document;
    if (!document?.documentElement || typeof global.MutationObserver !== 'function') return ready;
    if (observer) return true;

    // Keep a short-lived observer even when the toolbar was already present.
    // This preserves the swap if another startup step redraws the mobile nav.
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
