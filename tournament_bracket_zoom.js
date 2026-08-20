(function installTaskPointsTournamentBracketZoom(global) {
  'use strict';

  const document = global.document;
  if (!global || !document || global.TaskPointsTournamentBracketZoom?.installed) return;

  const MIN_SCALE = 0.18;
  const MAX_SCALE = 2.5;
  const INSTALL_RETRY_MS = 50;
  const MAX_INSTALL_ATTEMPTS = 240;
  let installAttempts = 0;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function distance(a, b) {
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.hypot(dx, dy);
  }

  function midpoint(a, b, rect) {
    return {
      x: ((a.clientX + b.clientX) / 2) - rect.left,
      y: ((a.clientY + b.clientY) / 2) - rect.top
    };
  }

  function installStyles() {
    if (document.getElementById('taskpointsTournamentBracketZoomStyles')) return;
    const style = document.createElement('style');
    style.id = 'taskpointsTournamentBracketZoomStyles';
    style.textContent = `
      .tournament-bracket-scroll.tp-bracket-zoom-viewport {
        overflow: auto !important;
        overflow-x: auto !important;
        overflow-y: auto !important;
        position: relative;
        max-height: min(72vh, 900px);
        min-height: 280px;
        touch-action: none;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
      }
      .tournament-bracket-zoom-stage {
        position: relative;
        transform-origin: 0 0;
      }
      #tournamentBracket.tp-bracket-zoom-target {
        transform-origin: 0 0;
        will-change: transform;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function install() {
    if (global.TaskPointsTournamentBracketZoom?.installed) return true;

    const viewport = document.querySelector('.tournament-bracket-scroll');
    const bracket = document.getElementById('tournamentBracket');
    if (!viewport || !bracket) return false;

    installStyles();

    let stage = bracket.parentElement?.classList?.contains('tournament-bracket-zoom-stage')
      ? bracket.parentElement
      : null;

    if (!stage) {
      stage = document.createElement('div');
      stage.className = 'tournament-bracket-zoom-stage';
      bracket.parentNode.insertBefore(stage, bracket);
      stage.appendChild(bracket);
    }

    viewport.classList.add('tp-bracket-zoom-viewport');
    bracket.classList.add('tp-bracket-zoom-target');
    viewport.setAttribute(
      'aria-label',
      'Season Championship bracket. Drag to pan. Pinch with two fingers to zoom in or out.'
    );

    let scale = 1;
    let baseWidth = 1;
    let baseHeight = 1;
    let panLast = null;
    let pinch = null;
    let dragged = false;

    function measureBase() {
      const previousTransform = bracket.style.transform;
      bracket.style.transform = 'none';
      baseWidth = Math.max(1, bracket.scrollWidth || 0, bracket.offsetWidth || 0);
      baseHeight = Math.max(1, bracket.scrollHeight || 0, bracket.offsetHeight || 0);
      bracket.style.transform = previousTransform;
    }

    function updateStageSize() {
      stage.style.width = `${Math.max(1, Math.ceil(baseWidth * scale))}px`;
      stage.style.height = `${Math.max(1, Math.ceil(baseHeight * scale))}px`;
    }

    function applyScale(nextScale, anchorX = viewport.clientWidth / 2, anchorY = viewport.clientHeight / 2) {
      const oldScale = scale || 1;
      const contentX = (viewport.scrollLeft + anchorX) / oldScale;
      const contentY = (viewport.scrollTop + anchorY) / oldScale;

      scale = clamp(Number(nextScale) || 1, MIN_SCALE, MAX_SCALE);
      bracket.style.transform = `scale(${scale})`;
      updateStageSize();

      viewport.scrollLeft = Math.max(0, contentX * scale - anchorX);
      viewport.scrollTop = Math.max(0, contentY * scale - anchorY);
    }

    function refreshMeasurements() {
      measureBase();
      bracket.style.transform = `scale(${scale})`;
      updateStageSize();
    }

    function startSingleTouch(touch) {
      panLast = { x: touch.clientX, y: touch.clientY };
      pinch = null;
      dragged = false;
    }

    function startPinch(touches) {
      const first = touches[0];
      const second = touches[1];
      const rect = viewport.getBoundingClientRect();
      const mid = midpoint(first, second, rect);
      pinch = {
        startDistance: Math.max(1, distance(first, second)),
        startScale: scale,
        anchorX: mid.x,
        anchorY: mid.y
      };
      panLast = null;
      dragged = true;
    }

    viewport.addEventListener('touchstart', (event) => {
      if (event.touches.length >= 2) {
        startPinch(event.touches);
      } else if (event.touches.length === 1) {
        startSingleTouch(event.touches[0]);
      }
    }, { passive: true });

    viewport.addEventListener('touchmove', (event) => {
      if (event.touches.length >= 2) {
        if (!pinch) startPinch(event.touches);
        const first = event.touches[0];
        const second = event.touches[1];
        const nextScale = pinch.startScale * (distance(first, second) / pinch.startDistance);
        event.preventDefault();
        applyScale(nextScale, pinch.anchorX, pinch.anchorY);
        dragged = true;
        return;
      }

      if (event.touches.length === 1) {
        const touch = event.touches[0];
        if (!panLast) {
          startSingleTouch(touch);
          return;
        }

        const dx = touch.clientX - panLast.x;
        const dy = touch.clientY - panLast.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;
        event.preventDefault();
        viewport.scrollLeft -= dx;
        viewport.scrollTop -= dy;
        panLast = { x: touch.clientX, y: touch.clientY };
      }
    }, { passive: false });

    viewport.addEventListener('touchend', (event) => {
      if (event.touches.length >= 2) {
        startPinch(event.touches);
      } else if (event.touches.length === 1) {
        startSingleTouch(event.touches[0]);
      } else {
        panLast = null;
        pinch = null;
        global.setTimeout?.(() => { dragged = false; }, 0);
      }
    }, { passive: true });

    viewport.addEventListener('touchcancel', () => {
      panLast = null;
      pinch = null;
      dragged = false;
    }, { passive: true });

    viewport.addEventListener('click', (event) => {
      if (!dragged) return;
      event.preventDefault();
      event.stopPropagation();
      dragged = false;
    }, true);

    if (typeof global.ResizeObserver === 'function') {
      const resizeObserver = new global.ResizeObserver(refreshMeasurements);
      resizeObserver.observe(bracket);
      resizeObserver.observe(viewport);
    }

    if (typeof global.MutationObserver === 'function') {
      const mutationObserver = new global.MutationObserver(() => {
        global.requestAnimationFrame?.(refreshMeasurements);
      });
      mutationObserver.observe(bracket, { childList: true, subtree: true, attributes: true });
    }

    global.addEventListener?.('resize', refreshMeasurements);
    global.addEventListener?.('orientationchange', () => {
      global.setTimeout?.(refreshMeasurements, 100);
    });

    refreshMeasurements();

    global.TaskPointsTournamentBracketZoom = {
      installed: true,
      minScale: MIN_SCALE,
      maxScale: MAX_SCALE,
      get scale() { return scale; },
      setScale(value) { applyScale(value); },
      refresh: refreshMeasurements
    };

    return true;
  }

  function installWhenReady() {
    installAttempts += 1;
    if (!install() && installAttempts < MAX_INSTALL_ATTEMPTS) {
      global.setTimeout?.(installWhenReady, INSTALL_RETRY_MS);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installWhenReady, { once: true });
  } else {
    installWhenReady();
  }
})(typeof window !== 'undefined' ? window : globalThis);
