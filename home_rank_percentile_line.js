(function installTaskPointsHomeRankPercentileLine(global) {
  'use strict';

  const ROOT_ID = 'homeRankPercentileLine';
  const STYLE_ID = 'taskpoints-home-rank-percentile-style';
  const TRACK_CLASS = 'home-rank-percentile-track';
  const MARKER_CLASS = 'home-rank-percentile-marker';
  let renderQueued = false;
  let retryCount = 0;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function calculatePosition(rankInput, totalInput) {
    const rank = Number(rankInput);
    const total = Number(totalInput);
    if (!Number.isFinite(rank) || !Number.isFinite(total) || rank < 1 || total < 1) return null;
    if (total === 1) return 100;
    return clamp(((total - rank) / (total - 1)) * 100, 0, 100);
  }

  function getRankingView() {
    if (typeof global.getCanonicalRankingMap !== 'function') return null;

    let rankingMap;
    try {
      rankingMap = global.getCanonicalRankingMap();
    } catch (_) {
      return null;
    }

    if (!rankingMap || typeof rankingMap.get !== 'function') return null;
    const total = Number(rankingMap.size);
    const you = rankingMap.get('YOU');
    const rank = Number(you?.rank);
    const position = calculatePosition(rank, total);
    if (position == null) return null;

    return { rank, total, position };
  }

  function ensureStyles() {
    const document = global.document;
    if (!document?.createElement || !document.head || document.getElementById?.(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} {
        grid-column: 1 / -1;
        width: 100%;
        height: 22px;
        display: flex;
        align-items: center;
        padding: 0 2px;
        box-sizing: border-box;
        pointer-events: none;
      }

      #${ROOT_ID}[hidden] {
        display: none !important;
      }

      #${ROOT_ID} .${TRACK_CLASS} {
        position: relative;
        width: 100%;
        height: 2px;
        border-radius: 999px;
        background: linear-gradient(
          90deg,
          rgba(71, 85, 105, 0.38) 0%,
          rgba(45, 212, 191, 0.58) 62%,
          rgba(251, 146, 60, 0.92) 100%
        );
        box-shadow: 0 0 10px rgba(45, 212, 191, 0.12);
      }

      #${ROOT_ID} .${MARKER_CLASS} {
        position: absolute;
        top: 50%;
        left: var(--tp-rank-position, 50%);
        transform: translate(-50%, -50%);
        width: 18px;
        height: 18px;
        box-sizing: border-box;
        display: grid;
        place-items: center;
        border: 1.5px solid transparent;
        border-radius: 999px;
        background:
          linear-gradient(#0b0d10, #0b0d10) padding-box,
          linear-gradient(135deg, #5eead4, #fb923c) border-box;
        color: #f8fafc;
        font-size: 7px;
        font-weight: 900;
        line-height: 1;
        font-variant-numeric: tabular-nums;
        box-shadow:
          0 0 0 2px rgba(15, 23, 42, 0.75),
          0 0 10px rgba(45, 212, 191, 0.34),
          0 0 7px rgba(251, 146, 60, 0.22);
      }

      @media (max-width: 640px) {
        #${ROOT_ID} {
          height: 20px;
          padding-left: 1px;
          padding-right: 1px;
        }

        #${ROOT_ID} .${MARKER_CLASS} {
          width: 17px;
          height: 17px;
          font-size: 6.5px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function createMount(scoreboard) {
    const document = global.document;
    if (!document?.createElement || !scoreboard?.parentNode?.insertBefore) return null;

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute?.('role', 'img');

    const track = document.createElement('div');
    track.className = TRACK_CLASS;

    const marker = document.createElement('span');
    marker.className = MARKER_CLASS;
    marker.setAttribute?.('aria-hidden', 'true');

    track.appendChild?.(marker);
    root.appendChild?.(track);
    scoreboard.parentNode.insertBefore(root, scoreboard);
    return root;
  }

  function ensureMount() {
    const document = global.document;
    const scoreboard = document?.querySelector?.('.home-scoreboard-card');
    if (!scoreboard) return null;

    const existing = document.getElementById?.(ROOT_ID);
    if (existing) return existing;
    return createMount(scoreboard);
  }

  function render() {
    ensureStyles();
    const root = ensureMount();
    if (!root) return null;

    const view = getRankingView();
    if (!view) {
      root.hidden = true;
      return null;
    }

    root.hidden = false;
    root.style?.setProperty?.('--tp-rank-position', `${view.position}%`);
    root.setAttribute?.('aria-label', `Your current rank is ${view.rank} of ${view.total}`);
    root.setAttribute?.('data-rank', String(view.rank));
    root.setAttribute?.('data-ranked-players', String(view.total));

    const marker = root.querySelector?.(`.${MARKER_CLASS}`);
    if (marker) marker.textContent = String(view.rank);
    return view;
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    const run = () => {
      renderQueued = false;
      render();
    };
    if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(run);
    else global.setTimeout?.(run, 0);
  }

  function start() {
    const view = render();
    if (view) return;
    retryCount += 1;
    if (retryCount < 40) global.setTimeout?.(start, 50);
  }

  const api = {
    ROOT_ID,
    calculatePosition,
    getRankingView,
    render,
    scheduleRender
  };
  global.TaskPointsHomeRankPercentileLine = api;

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  global.addEventListener?.('taskpoints:state-revision', scheduleRender);
  global.addEventListener?.('storage', scheduleRender);
  global.addEventListener?.('pageshow', scheduleRender);
  global.document?.addEventListener?.('visibilitychange', () => {
    if (global.document?.visibilityState === 'visible') scheduleRender();
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
