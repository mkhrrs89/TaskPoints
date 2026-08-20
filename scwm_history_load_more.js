(function installTaskPointsScwmHistoryLoadMore(global) {
  'use strict';

  if (!global || global.TaskPointsScwmHistoryLoadMore?.installed) return;

  const INITIAL_DAYS = 10;
  const STEP_DAYS = 5;
  const MAX_DAYS = 30;
  const PRIMARY_GRID_ID = 'scoreV2RecentGrid';
  const EXTRAS_ID = 'scoreV2RecentExtraHistory';
  const CONTROLS_ID = 'scoreV2RecentLoadMoreControls';
  const BUTTON_ID = 'scoreV2RecentLoadMoreBtn';
  const INSTALL_RETRY_MS = 50;
  const MAX_INSTALL_ATTEMPTS = 240;

  let visibleDays = INITIAL_DAYS;
  let originalRender = null;
  let installAttempts = 0;
  let renderingExtras = false;

  function currentState() {
    try {
      if (typeof state !== 'undefined' && state && typeof state === 'object') return state;
    } catch (_) {}
    return null;
  }

  function isScwmCompletion(entry) {
    const title = String(entry?.title || '');
    return title.startsWith('Sleep Score')
      || title.startsWith('Calories')
      || title.startsWith('Work Score')
      || title.startsWith('Mood Score');
  }

  function entryDayKey(entry) {
    if (!entry) return '';
    const direct = String(entry.dayKey || entry.dateKey || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
    const iso = entry.completedAtISO;
    if (!iso) return '';
    const parsed = new global.Date(iso);
    if (Number.isNaN(parsed.getTime())) return '';
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function localDayStart(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const date = new global.Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function maxUsefulDays() {
    const appState = currentState();
    const completions = Array.isArray(appState?.completions) ? appState.completions : [];
    let earliestKey = '';

    completions.forEach((entry) => {
      if (!isScwmCompletion(entry)) return;
      const key = entryDayKey(entry);
      if (!key) return;
      if (!earliestKey || key < earliestKey) earliestKey = key;
    });

    if (!earliestKey) return INITIAL_DAYS;

    const today = new global.Date();
    today.setHours(0, 0, 0, 0);
    const earliest = localDayStart(earliestKey);
    if (!earliest) return INITIAL_DAYS;

    const daysBack = Math.max(1, Math.round((today - earliest) / 86400000));
    const rounded = Math.ceil(Math.max(INITIAL_DAYS, daysBack) / STEP_DAYS) * STEP_DAYS;
    return Math.min(MAX_DAYS, rounded);
  }

  function shiftedDateConstructor(offsetDays) {
    const RealDate = global.Date;
    const shiftedNow = new RealDate();
    shiftedNow.setDate(shiftedNow.getDate() - offsetDays);
    const shiftedNowMs = shiftedNow.getTime();

    class ShiftedDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(shiftedNowMs);
        else super(...args);
      }

      static now() {
        return shiftedNowMs;
      }
    }

    return ShiftedDate;
  }

  function renderFiveDayChunk(primaryGrid, offsetDays, count) {
    if (!primaryGrid || typeof originalRender !== 'function' || count <= 0) return null;

    const segment = global.document.createElement('div');
    segment.className = primaryGrid.className || 'scoreV2-recentGrid';
    segment.dataset.scwmHistoryOffset = String(offsetDays);
    segment.style.display = 'contents';

    const extras = global.document.getElementById(EXTRAS_ID);
    if (!extras) return null;
    extras.appendChild(segment);

    const realId = primaryGrid.id;
    const RealDate = global.Date;

    try {
      primaryGrid.id = `${PRIMARY_GRID_ID}Primary`;
      segment.id = PRIMARY_GRID_ID;
      global.Date = shiftedDateConstructor(offsetDays);
      originalRender();
    } catch (error) {
      console.warn('TaskPoints SCWM older-history render failed.', error);
      segment.remove();
      return null;
    } finally {
      global.Date = RealDate;
      segment.removeAttribute('id');
      primaryGrid.id = realId || PRIMARY_GRID_ID;
    }

    const children = Array.from(segment.children);
    children.slice(count).forEach((child) => child.remove());
    return segment;
  }

  function ensureUi(primaryGrid) {
    const wrap = global.document.getElementById('scoreV2RecentWrap');
    if (!wrap || !primaryGrid) return null;

    let extras = global.document.getElementById(EXTRAS_ID);
    if (!extras) {
      extras = global.document.createElement('div');
      extras.id = EXTRAS_ID;
      extras.className = 'scoreV2-recentExtraHistory';
      primaryGrid.insertAdjacentElement('afterend', extras);
    }

    let controls = global.document.getElementById(CONTROLS_ID);
    if (!controls) {
      controls = global.document.createElement('div');
      controls.id = CONTROLS_ID;
      controls.style.cssText = 'display:flex;justify-content:center;padding-top:10px;';
      extras.insertAdjacentElement('afterend', controls);
    }

    let button = global.document.getElementById(BUTTON_ID);
    if (!button) {
      button = global.document.createElement('button');
      button.id = BUTTON_ID;
      button.type = 'button';
      button.className = 'btn btn-secondary';
      button.textContent = 'Load 5 more';
      button.setAttribute('aria-label', 'Load 5 more SCWM history days');
      controls.appendChild(button);
      button.addEventListener('click', () => {
        const maximum = maxUsefulDays();
        visibleDays = Math.min(maximum, visibleDays + STEP_DAYS);
        refreshExtras();
      });
    }

    return { extras, controls, button };
  }

  function updateButton(primaryGrid) {
    const ui = ensureUi(primaryGrid);
    if (!ui) return;
    const maximum = maxUsefulDays();
    const hasMore = visibleDays < maximum;
    ui.controls.style.display = hasMore ? 'flex' : 'none';
    ui.button.disabled = !hasMore;
  }

  function refreshExtras() {
    if (renderingExtras || typeof originalRender !== 'function') return;
    const primaryGrid = global.document.getElementById(PRIMARY_GRID_ID);
    if (!primaryGrid) return;

    const ui = ensureUi(primaryGrid);
    if (!ui) return;

    renderingExtras = true;
    try {
      ui.extras.replaceChildren();
      for (let offset = INITIAL_DAYS; offset < visibleDays; offset += STEP_DAYS) {
        renderFiveDayChunk(primaryGrid, offset, Math.min(STEP_DAYS, visibleDays - offset));
      }
      updateButton(primaryGrid);
    } finally {
      renderingExtras = false;
    }
  }

  function install() {
    if (global.TaskPointsScwmHistoryLoadMore?.installed) return true;

    const primaryGrid = global.document?.getElementById?.(PRIMARY_GRID_ID);
    const candidate = global.renderScoreV2RecentGrid;
    if (!primaryGrid || typeof candidate !== 'function') return false;

    originalRender = candidate.__taskPointsScwmHistoryLoadMoreOriginal || candidate;

    const wrappedRender = function taskPointsScwmHistoryLoadMoreRender(...args) {
      const result = originalRender.apply(this, args);
      refreshExtras();
      return result;
    };
    wrappedRender.__taskPointsScwmHistoryLoadMore = true;
    wrappedRender.__taskPointsScwmHistoryLoadMoreOriginal = originalRender;
    global.renderScoreV2RecentGrid = wrappedRender;

    ensureUi(primaryGrid);
    updateButton(primaryGrid);

    global.TaskPointsScwmHistoryLoadMore = {
      installed: true,
      initialDays: INITIAL_DAYS,
      stepDays: STEP_DAYS,
      maxDays: MAX_DAYS,
      get visibleDays() { return visibleDays; },
      get maxUsefulDays() { return maxUsefulDays(); },
      refresh: refreshExtras
    };

    return true;
  }

  function installWhenReady() {
    installAttempts += 1;
    if (!install() && installAttempts < MAX_INSTALL_ATTEMPTS) {
      global.setTimeout?.(installWhenReady, INSTALL_RETRY_MS);
    }
  }

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', installWhenReady, { once: true });
  } else {
    installWhenReady();
  }
})(typeof window !== 'undefined' ? window : globalThis);
