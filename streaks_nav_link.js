;(function installTaskPointsStreaksNavLink(global) {
  'use strict';

  if (global.TaskPointsStreaksNavLink?.installed) return;

  const LINK_ATTR = 'data-taskpoints-streaks-nav';
  const HEADER_SPACER_STYLE_ID = 'taskpoints-relocated-header-nav-mobile-style';
  const EXPANDED_SHORTCUT_ATTR = 'data-taskpoints-expanded-shortcut';
  const EXPANDED_SHORTCUTS = Object.freeze([
    { href: 'daily_sources.html', label: 'Sources', icon: '📚', key: 'sources' },
    { href: 'log.html', label: 'Log', icon: '📜', key: 'log' },
    { href: 'week.html', label: 'Week', icon: '🗓️', key: 'week' }
  ]);
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

  function ensureHeaderNavSpacerStyle(document) {
    if (!document?.createElement || !document.head || document.getElementById?.(HEADER_SPACER_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = HEADER_SPACER_STYLE_ID;
    style.textContent = `
      @media (max-width: 767px) {
        .header-nav > a[href="index.html"],
        .header-nav > a[href="daily_sources.html"],
        .header-nav > a[href="log.html"],
        .header-nav > a[href="week.html"],
        .header-nav > a[href="season.html"] {
          visibility: hidden !important;
          pointer-events: none !important;
        }
      }
    `;
    document.head.appendChild(style);
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

  function createExpandedShortcut(document, spec) {
    const link = document.createElement('a');
    link.href = spec.href;
    link.className = 'mobile-bottom-nav-btn flex flex-col items-center gap-0.5 opacity-80 hover:opacity-100';
    link.setAttribute(EXPANDED_SHORTCUT_ATTR, spec.key);
    link.setAttribute('aria-label', spec.label);

    const icon = document.createElement('span');
    icon.className = 'tp-nav-emoji';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = spec.icon;

    const label = document.createElement('span');
    label.className = 'uppercase tracking-wide text-[10px]';
    label.textContent = spec.label;

    link.append(icon, label);
    return link;
  }

  function findOrCreateExpandedShortcut(document, secondary, spec) {
    let link = Array.from(secondary.querySelectorAll('a[href]')).find((anchor) => {
      const href = hrefPath(anchor);
      return href === spec.href || href.endsWith(`/${spec.href}`);
    });
    if (!link) {
      link = createExpandedShortcut(document, spec);
      secondary.appendChild(link);
    }
    link.setAttribute(EXPANDED_SHORTCUT_ATTR, spec.key);
    return link;
  }

  function ensureLink() {
    const document = global.document;
    if (!document?.querySelector) return false;

    // The old mobile header buttons stay in layout but become invisible. This
    // deliberately preserves the exact blank row height/spacing they occupied.
    ensureHeaderNavSpacerStyle(document);

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

    // Fill the three requested empty expanded-menu slots in order after Tasks.
    let previous = taskDropdown;
    const expandedLinks = EXPANDED_SHORTCUTS.map((spec) => {
      const shortcut = findOrCreateExpandedShortcut(document, secondary, spec);
      if (shortcut.parentElement !== secondary || shortcut.previousElementSibling !== previous) {
        previous.insertAdjacentElement('afterend', shortcut);
      }
      previous = shortcut;
      return shortcut;
    });

    return isTopRowLink(link)
      && taskDropdown.parentElement === secondary
      && taskDropdown.previousElementSibling === today
      && expandedLinks.every((shortcut) => shortcut.parentElement === secondary);
  }

  function watchForToolbar() {
    const ready = ensureLink();
    const document = global.document;
    if (!document?.documentElement || typeof global.MutationObserver !== 'function') return ready;
    if (observer) return true;

    // Keep a short-lived observer even when the toolbar was already present.
    // This preserves the swap and new shortcuts if another startup step redraws
    // the mobile nav.
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
