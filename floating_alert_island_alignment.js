(function installTaskPointsFloatingAlertIslandAlignment(global) {
  'use strict';

  if (!global || global.TaskPointsFloatingAlertIslandAlignment?.installed) return;

  const MOBILE_QUERY = '(max-width: 767px)';
  const RED_ID = 'criticalTasksIsland';
  const ORANGE_SELECTOR = '.tp-reminder-island';
  const HEADER_ROW_SELECTOR = '.header-nav';
  const RED_FALLBACK_LEFT = '0.75rem';
  const ORANGE_RIGHT = '0.75rem';
  const RED_FALLBACK_SIZE_PX = 60;
  const ORANGE_VERTICAL_NUDGE_PX = 4;
  const FALLBACK_RED_TOP = 'calc(env(safe-area-inset-top, 0px) + 3.45rem)';
  const FALLBACK_ORANGE_TOP = 'calc(env(safe-area-inset-top, 0px) + 3.7rem)';

  let observer = null;
  let scheduled = false;

  function isMobile() {
    return !global.matchMedia || global.matchMedia(MOBILE_QUERY).matches;
  }

  function visibleHeaderRow() {
    const rows = Array.from(global.document?.querySelectorAll?.(HEADER_ROW_SELECTOR) || []);
    return rows.find((row) => {
      const rect = row?.getBoundingClientRect?.();
      if (!rect || rect.height <= 0 || rect.width <= 0) return false;
      const style = global.getComputedStyle?.(row);
      return style?.display !== 'none' && style?.visibility !== 'hidden';
    }) || null;
  }

  function documentRowCenterY(row) {
    const rect = row?.getBoundingClientRect?.();
    if (!rect || rect.height <= 0) return null;
    const scrollY = Number(global.scrollY || global.pageYOffset || 0);
    return rect.top + scrollY + (rect.height / 2);
  }

  function centerFixedElementOnDocumentY(element, centerY, fallbackTop) {
    if (!element) return false;
    const height = Number(element.offsetHeight || element.getBoundingClientRect?.()?.height || 0);
    if (Number.isFinite(centerY) && height > 0) {
      element.style.top = `${Math.round(centerY - (height / 2))}px`;
    } else {
      element.style.top = fallbackTop;
    }
    return true;
  }

  function visibleOrange(oranges) {
    return oranges.find((orange) => {
      const rect = orange?.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = global.getComputedStyle?.(orange);
      return style?.display !== 'none' && style?.visibility !== 'hidden';
    }) || oranges[0] || null;
  }

  function sizeRedIsland(red, orange) {
    if (!red) return;

    // offsetWidth/offsetHeight are layout dimensions and do not wobble with
    // the orange island's visual shake transform.
    const width = Number(orange?.offsetWidth || 0) > 0
      ? Number(orange.offsetWidth)
      : RED_FALLBACK_SIZE_PX;
    const height = Number(orange?.offsetHeight || 0) > 0
      ? Number(orange.offsetHeight)
      : RED_FALLBACK_SIZE_PX;

    red.style.width = `${Math.round(width)}px`;
    red.style.height = `${Math.round(height)}px`;
    red.style.minWidth = `${Math.round(width)}px`;
    red.style.minHeight = `${Math.round(height)}px`;
    red.style.padding = '0';
    red.style.boxSizing = 'border-box';
  }

  function anchorRedMarkFromTwoMarkBaseline(red) {
    const mark = red?.querySelector?.('#criticalTasksIslandMark');
    if (!red || !mark || !global.document?.body) return;

    const style = global.getComputedStyle?.(mark);
    if (!style) return;

    const probe = global.document.createElement('span');
    probe.textContent = '!!';
    probe.setAttribute('aria-hidden', 'true');
    Object.assign(probe.style, {
      position: 'fixed',
      left: '-10000px',
      top: '-10000px',
      visibility: 'hidden',
      pointerEvents: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      whiteSpace: 'nowrap',
      boxSizing: 'border-box',
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      margin: '0',
      transform: 'none',
      animation: 'none'
    });

    global.document.body.appendChild(probe);
    const twoMarkWidth = Number(probe.offsetWidth || probe.getBoundingClientRect?.()?.width || 0);
    probe.remove();

    const islandWidth = Number(red.offsetWidth || 0);
    if (!(islandWidth > 0) || !(twoMarkWidth > 0)) return;

    const leftInset = Math.max(0, Math.round((islandWidth - twoMarkWidth) / 2));
    red.style.setProperty('--tp-critical-mark-left-anchor', `${leftInset}px`);
  }

  function mirrorRedToOrange(red, orange) {
    if (!red) return false;

    // The orange island is right-anchored. Mirror that stable layout inset
    // directly to the red island instead of reading its animated screen rect.
    const orangeStyle = orange ? global.getComputedStyle?.(orange) : null;
    const rightInset = String(orange?.style?.right || orangeStyle?.right || '').trim();
    if (rightInset && rightInset !== 'auto') {
      red.style.left = rightInset;
      return true;
    }

    red.style.left = RED_FALLBACK_LEFT;
    return false;
  }

  function align() {
    scheduled = false;
    const document = global.document;
    if (!document) return false;

    const red = document.getElementById?.(RED_ID) || null;
    const oranges = Array.from(document.querySelectorAll?.(ORANGE_SELECTOR) || []);

    if (!isMobile()) {
      if (red) {
        red.style.removeProperty('top');
        red.style.removeProperty('left');
        red.style.removeProperty('width');
        red.style.removeProperty('height');
        red.style.removeProperty('min-width');
        red.style.removeProperty('min-height');
        red.style.removeProperty('padding');
        red.style.removeProperty('box-sizing');
      }
      oranges.forEach((orange) => {
        orange.style.removeProperty('top');
        orange.style.removeProperty('right');
      });
      return false;
    }

    const row = visibleHeaderRow();
    const centerY = documentRowCenterY(row);

    oranges.forEach((orange) => {
      orange.style.right = ORANGE_RIGHT;
      centerFixedElementOnDocumentY(
        orange,
        Number.isFinite(centerY) ? centerY + ORANGE_VERTICAL_NUDGE_PX : centerY,
        FALLBACK_ORANGE_TOP
      );
    });

    if (red) {
      const orange = visibleOrange(oranges);
      sizeRedIsland(red, orange);
      anchorRedMarkFromTwoMarkBaseline(red);

      // Use the orange island's fixed layout top, not its transformed visual
      // rect, so red does not chase animation pixels during a swipe.
      const orangeStyle = orange ? global.getComputedStyle?.(orange) : null;
      const stableOrangeTop = String(orange?.style?.top || orangeStyle?.top || '').trim();
      if (stableOrangeTop && stableOrangeTop !== 'auto') {
        red.style.top = stableOrangeTop;
      } else {
        centerFixedElementOnDocumentY(red, centerY, FALLBACK_RED_TOP);
      }

      mirrorRedToOrange(red, orange);
    }

    return Boolean(red || oranges.length);
  }

  function scheduleAlign() {
    if (scheduled) return;
    scheduled = true;
    const run = () => align();
    if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(run);
    else global.setTimeout?.(run, 0);
  }

  function observe() {
    const document = global.document;
    if (observer || typeof global.MutationObserver !== 'function' || !document?.documentElement) return;
    observer = new global.MutationObserver((mutations) => {
      const relevant = mutations.some((mutation) => Array.from(mutation.addedNodes || []).some((node) => {
        if (node?.id === RED_ID) return true;
        if (node?.matches?.(ORANGE_SELECTOR)) return true;
        return Boolean(node?.querySelector?.(`#${RED_ID}, ${ORANGE_SELECTOR}, ${HEADER_ROW_SELECTOR}`));
      }));
      if (relevant) scheduleAlign();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function start() {
    scheduleAlign();
    observe();
  }

  global.TaskPointsFloatingAlertIslandAlignment = {
    installed: true,
    version: 4,
    align,
    scheduleAlign,
    getStatus() {
      return {
        installed: true,
        mobile: isMobile(),
        headerRowFound: Boolean(visibleHeaderRow()),
        redFound: Boolean(global.document?.getElementById?.(RED_ID)),
        orangeCount: global.document?.querySelectorAll?.(ORANGE_SELECTOR)?.length || 0,
        redFallbackSizePx: RED_FALLBACK_SIZE_PX,
        orangeVerticalNudgePx: ORANGE_VERTICAL_NUDGE_PX
      };
    }
  };

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  global.addEventListener?.('load', scheduleAlign);
  global.addEventListener?.('pageshow', scheduleAlign);
  global.addEventListener?.('resize', scheduleAlign, { passive: true });
  global.addEventListener?.('orientationchange', scheduleAlign);
})(typeof window !== 'undefined' ? window : globalThis);
