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
        scroll-behavior: auto !important;
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
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
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
    let gestureActive = false;
    let refreshAfterGesture = false;

    let animationFrame = 0;
    let pendingScale = null;
    let pendingScaleAnchor = null;
    let pendingPanX = 0;
    let pendingPanY = 0;
    let refreshFrame = 0;

    function noteGestureActivity() {
      try { global.TaskPointsCore?.noteStorageUserInteraction?.(); } catch (_) {}
    }

    function measureBase() {
      // CSS transforms do not change the bracket's intrinsic layout box, so
      // there is no reason to remove/reapply the transform just to measure it.
      // Avoiding that style flip prevents a forced layout during interaction.
      baseWidth = Math.max(1, bracket.scrollWidth || 0, bracket.offsetWidth || 0);
      baseHeight = Math.max(1, bracket.scrollHeight || 0, bracket.offsetHeight || 0);
    }

    function updateStageSize(nextScale = scale) {
      stage.style.width = `${Math.max(1, Math.ceil(baseWidth * nextScale))}px`;
      stage.style.height = `${Math.max(1, Math.ceil(baseHeight * nextScale))}px`;
    }

    function expandStageForPinch() {
      // Give the compositor enough scrollable room for the entire pinch before
      // it starts. During the gesture we then only change the transform and
      // scroll offsets; width/height are committed once when the gesture ends.
      stage.style.width = `${Math.max(1, Math.ceil(baseWidth * MAX_SCALE))}px`;
      stage.style.height = `${Math.max(1, Math.ceil(baseHeight * MAX_SCALE))}px`;
    }

    function setVisualScale(nextScale) {
      scale = clamp(Number(nextScale) || 1, MIN_SCALE, MAX_SCALE);
      bracket.style.transform = `translate3d(0, 0, 0) scale(${scale})`;
    }

    function applyQueuedFrame() {
      animationFrame = 0;

      if (pendingScale != null && pendingScaleAnchor) {
        const anchor = pendingScaleAnchor;
        setVisualScale(pendingScale);
        viewport.scrollLeft = Math.max(0, anchor.contentX * scale - anchor.x);
        viewport.scrollTop = Math.max(0, anchor.contentY * scale - anchor.y);
        pendingScale = null;
        pendingScaleAnchor = null;
      }

      if (pendingPanX || pendingPanY) {
        viewport.scrollLeft -= pendingPanX;
        viewport.scrollTop -= pendingPanY;
        pendingPanX = 0;
        pendingPanY = 0;
      }
    }

    function scheduleFrame() {
      if (animationFrame) return;
      animationFrame = global.requestAnimationFrame?.(applyQueuedFrame)
        || global.setTimeout?.(applyQueuedFrame, 16)
        || 0;
    }

    function flushFrameNow() {
      if (!animationFrame) return;
      if (typeof global.cancelAnimationFrame === 'function') global.cancelAnimationFrame(animationFrame);
      else global.clearTimeout?.(animationFrame);
      animationFrame = 0;
      applyQueuedFrame();
    }

    function commitScale(nextScale, anchorX = viewport.clientWidth / 2, anchorY = viewport.clientHeight / 2) {
      flushFrameNow();
      const oldScale = scale || 1;
      const contentX = (viewport.scrollLeft + anchorX) / oldScale;
      const contentY = (viewport.scrollTop + anchorY) / oldScale;
      setVisualScale(nextScale);
      updateStageSize(scale);
      viewport.scrollLeft = Math.max(0, contentX * scale - anchorX);
      viewport.scrollTop = Math.max(0, contentY * scale - anchorY);
    }

    function refreshMeasurementsNow() {
      refreshFrame = 0;
      if (gestureActive) {
        refreshAfterGesture = true;
        return;
      }
      measureBase();
      setVisualScale(scale);
      updateStageSize(scale);
      refreshAfterGesture = false;
    }

    function scheduleRefreshMeasurements() {
      if (gestureActive) {
        refreshAfterGesture = true;
        return;
      }
      if (refreshFrame) return;
      refreshFrame = global.requestAnimationFrame?.(refreshMeasurementsNow)
        || global.setTimeout?.(refreshMeasurementsNow, 16)
        || 0;
    }

    function finishGestureSizing() {
      flushFrameNow();
      updateStageSize(scale);
      if (refreshAfterGesture) scheduleRefreshMeasurements();
    }

    function startSingleTouch(touch) {
      gestureActive = true;
      panLast = { x: touch.clientX, y: touch.clientY };
      pinch = null;
      pendingPanX = 0;
      pendingPanY = 0;
      dragged = false;
      noteGestureActivity();
    }

    function startPinch(touches) {
      flushFrameNow();
      const first = touches[0];
      const second = touches[1];
      const rect = viewport.getBoundingClientRect();
      const mid = midpoint(first, second, rect);
      gestureActive = true;
      expandStageForPinch();
      pinch = {
        startDistance: Math.max(1, distance(first, second)),
        startScale: scale,
        anchorX: mid.x,
        anchorY: mid.y,
        contentX: (viewport.scrollLeft + mid.x) / Math.max(scale, 0.0001),
        contentY: (viewport.scrollTop + mid.y) / Math.max(scale, 0.0001)
      };
      panLast = null;
      pendingPanX = 0;
      pendingPanY = 0;
      dragged = true;
      noteGestureActivity();
    }

    viewport.addEventListener('touchstart', (event) => {
      noteGestureActivity();
      if (event.touches.length >= 2) {
        startPinch(event.touches);
      } else if (event.touches.length === 1) {
        startSingleTouch(event.touches[0]);
      }
    }, { passive: true });

    viewport.addEventListener('touchmove', (event) => {
      noteGestureActivity();

      if (event.touches.length >= 2) {
        if (!pinch) startPinch(event.touches);
        const first = event.touches[0];
        const second = event.touches[1];
        pendingScale = pinch.startScale * (distance(first, second) / pinch.startDistance);
        pendingScaleAnchor = {
          x: pinch.anchorX,
          y: pinch.anchorY,
          contentX: pinch.contentX,
          contentY: pinch.contentY
        };
        event.preventDefault();
        scheduleFrame();
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
        pendingPanX += dx;
        pendingPanY += dy;
        panLast = { x: touch.clientX, y: touch.clientY };
        scheduleFrame();
      }
    }, { passive: false });

    viewport.addEventListener('touchend', (event) => {
      noteGestureActivity();
      flushFrameNow();

      if (event.touches.length >= 2) {
        startPinch(event.touches);
      } else if (event.touches.length === 1) {
        updateStageSize(scale);
        startSingleTouch(event.touches[0]);
      } else {
        gestureActive = false;
        panLast = null;
        pinch = null;
        finishGestureSizing();
        global.setTimeout?.(() => { dragged = false; }, 0);
      }
    }, { passive: true });

    viewport.addEventListener('touchcancel', () => {
      noteGestureActivity();
      gestureActive = false;
      panLast = null;
      pinch = null;
      dragged = false;
      pendingScale = null;
      pendingScaleAnchor = null;
      pendingPanX = 0;
      pendingPanY = 0;
      finishGestureSizing();
    }, { passive: true });

    viewport.addEventListener('click', (event) => {
      if (!dragged) return;
      event.preventDefault();
      event.stopPropagation();
      dragged = false;
    }, true);

    if (typeof global.ResizeObserver === 'function') {
      const resizeObserver = new global.ResizeObserver(scheduleRefreshMeasurements);
      resizeObserver.observe(bracket);
      resizeObserver.observe(viewport);
    }

    if (typeof global.MutationObserver === 'function') {
      const mutationObserver = new global.MutationObserver(scheduleRefreshMeasurements);
      // Attribute observation used to include our own per-frame style transform,
      // which recursively scheduled measurements during every pinch frame.
      // Child/text changes are enough here; ResizeObserver covers geometry.
      mutationObserver.observe(bracket, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    global.addEventListener?.('resize', scheduleRefreshMeasurements);
    global.addEventListener?.('orientationchange', () => {
      global.setTimeout?.(scheduleRefreshMeasurements, 100);
    });

    refreshMeasurementsNow();

    global.TaskPointsTournamentBracketZoom = {
      installed: true,
      minScale: MIN_SCALE,
      maxScale: MAX_SCALE,
      get scale() { return scale; },
      setScale(value) { commitScale(value); },
      refresh: scheduleRefreshMeasurements
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
