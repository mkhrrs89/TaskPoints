(function installTaskPointsHomeYesterdayResultConsistency(global) {
  'use strict';

  if (!global || global.__taskPointsHomeYesterdayResultConsistencyInstalled) return;
  global.__taskPointsHomeYesterdayResultConsistencyInstalled = true;

  const WINNER_CLASSES = ['yesterdayWinner', 'yesterdayWinnerScore'];
  const LOSER_CLASSES = ['yesterdayLoser', 'yesterdayLoserScore'];
  const PLAYER_PHOTO_FRAME_STYLE_ID = 'taskpoints-player-photo-frame-override';
  const TRENDLINE_COLOR = '#F59E0B';
  const TRENDLINE_PERIOD = 14;
  const TRENDLINE_MAX_POINTS = 400;
  const WEEKLY_ON_TRACK_ATTR = 'data-weekly-on-track';
  const WEEKLY_BOARD_LIMIT = 10;
  let installAttempts = 0;

  function getElement(id) {
    return global.document?.getElementById?.(id) || null;
  }

  function installPlayerPhotoFrameOverride() {
    const document = global.document;
    if (!document?.head || typeof document.createElement !== 'function') return false;
    if (document.getElementById?.(PLAYER_PHOTO_FRAME_STYLE_ID)) return true;

    const style = document.createElement('style');
    style.id = PLAYER_PHOTO_FRAME_STYLE_ID;
    style.textContent = `
/* Players page: remove the silver gradient frame while retaining the black photo edge. */
.player-img-frame {
  padding: 0 !important;
  background: transparent !important;
}
`;
    document.head.appendChild(style);
    return true;
  }

  function fallbackDateKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function getYesterdayGameKey() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return typeof global.getGameDayKey === 'function'
      ? global.getGameDayKey(yesterday)
      : fallbackDateKey(yesterday);
  }

  function normalizeResult(row, youScore, opponentScore) {
    const saved = String(row?.result || '').toUpperCase();
    if (saved === 'W' || saved === 'L' || saved === 'T') return saved;
    if (youScore > opponentScore) return 'W';
    if (youScore < opponentScore) return 'L';
    return 'T';
  }

  function clearResultClasses(elements) {
    elements.forEach((element) => {
      if (!element?.classList) return;
      element.classList.remove(...WINNER_CLASSES, ...LOSER_CLASSES);
    });
  }

  function applySavedYesterdayResult() {
    if (typeof global.getCompletedYouMatchupsForStats !== 'function') return false;

    const panel = getElement('yesterdayResultsPanel');
    const yesterdayKey = getYesterdayGameKey();
    const completedRows = global.getCompletedYouMatchupsForStats();
    const matchup = (Array.isArray(completedRows) ? completedRows : [])
      .find((row) => row?.dateKey === yesterdayKey);
    if (!matchup) {
      panel?.classList?.remove('yesterday-tie');
      return false;
    }

    const youScore = Number(matchup.youScore);
    const opponentScore = Number(matchup.oppScore);
    if (!Number.isFinite(youScore) || !Number.isFinite(opponentScore)) {
      panel?.classList?.remove('yesterday-tie');
      return false;
    }

    const result = normalizeResult(matchup, youScore, opponentScore);
    const youAreA = matchup.playerAId === 'YOU';
    const opponentId = youAreA ? matchup.playerBId : matchup.playerAId;

    const yourName = getElement('yesterdayYouName');
    const yourScoreElement = getElement('yesterdayYourScore');
    const opponentName = getElement('yesterdayOpponent');
    const opponentScoreElement = getElement('yesterdayOpponentScore');
    const resultElement = getElement('yesterdayResult');
    const yourPrimarySwatch = getElement('yesterdayYourPrimarySwatch');
    const yourSecondarySwatch = getElement('yesterdayYourSecondarySwatch');
    const opponentPrimarySwatch = getElement('yesterdayOpponentPrimarySwatch');
    const opponentSecondarySwatch = getElement('yesterdayOpponentSecondarySwatch');

    if (!yourName || !yourScoreElement || !opponentName || !opponentScoreElement || !resultElement) {
      return false;
    }

    yourName.textContent = typeof global.getYouName === 'function' ? global.getYouName() : 'You';
    opponentName.textContent = typeof global.getPlayerNameById === 'function'
      ? global.getPlayerNameById(opponentId)
      : String(opponentId || 'Opponent');
    yourScoreElement.textContent = youScore.toFixed(1);
    opponentScoreElement.textContent = opponentScore.toFixed(1);
    resultElement.textContent = result;

    if (typeof global.setPlayerColorSwatches === 'function') {
      const yourPlayer = typeof global.getPlayerById === 'function' ? global.getPlayerById('YOU') : {};
      const opponentPlayer = typeof global.getPlayerById === 'function' ? global.getPlayerById(opponentId) : {};
      global.setPlayerColorSwatches(yourPrimarySwatch, yourSecondarySwatch, yourPlayer || {});
      global.setPlayerColorSwatches(opponentPrimarySwatch, opponentSecondarySwatch, opponentPlayer || {});
    }

    panel?.classList?.toggle('yesterday-win', result === 'W');
    panel?.classList?.toggle('yesterday-tie', result === 'T');

    const styledElements = [yourName, yourScoreElement, opponentName, opponentScoreElement];
    clearResultClasses(styledElements);

    if (result === 'W') {
      yourName.classList.add('yesterdayWinner');
      yourScoreElement.classList.add('yesterdayWinnerScore');
      opponentName.classList.add('yesterdayLoser');
      opponentScoreElement.classList.add('yesterdayLoserScore');
    } else if (result === 'L') {
      yourName.classList.add('yesterdayLoser');
      yourScoreElement.classList.add('yesterdayLoserScore');
      opponentName.classList.add('yesterdayWinner');
      opponentScoreElement.classList.add('yesterdayWinnerScore');
    }

    return true;
  }

  function downsampleTrendEntries(entries) {
    if (entries.length <= TRENDLINE_MAX_POINTS) return entries;
    const step = Math.ceil(entries.length / TRENDLINE_MAX_POINTS);
    return entries.filter((_, index) => index % step === 0 || index === entries.length - 1);
  }

  function getDailyTrendEntries(dailyTotals) {
    if (!dailyTotals || typeof dailyTotals !== 'object') return [];
    return downsampleTrendEntries(
      Object.entries(dailyTotals)
        .map(([key, total]) => ({ key, value: Number(total) }))
        .filter((entry) => Number.isFinite(entry.value))
        .sort((a, b) => a.key.localeCompare(b.key))
    );
  }

  function getCaloriesTrendEntries(caloriesHistoryInput) {
    const source = Array.isArray(caloriesHistoryInput)
      ? caloriesHistoryInput.slice()
      : (typeof global.getCaloriesHistorySorted === 'function' ? global.getCaloriesHistorySorted() : []);

    return downsampleTrendEntries(
      source
        .map((entry) => ({
          key: String(entry?.key || ''),
          value: Number(entry?.calories)
        }))
        .filter((entry) => Number.isFinite(entry.value))
        .sort((a, b) => a.key.localeCompare(b.key))
    );
  }

  function drawMovingAverageAboveDots(canvasId, entries, referenceValue) {
    const canvas = getElement(canvasId);
    if (!canvas?.getContext || entries.length < 2) return false;

    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    const width = canvas.clientWidth || 320;
    const height = canvas.clientHeight || 80;
    const dpr = global.devicePixelRatio || 1;
    const values = entries.map((entry) => entry.value);
    const rangeValues = Number.isFinite(referenceValue) ? [...values, referenceValue] : values;
    const maxValue = Math.max(...rangeValues);
    const minValue = Math.min(...rangeValues);
    const range = (maxValue - minValue) || 1;
    const paddingX = 6;
    const paddingTop = 22;
    const paddingBottom = 6;
    const chartWidth = width - paddingX * 2;
    const chartHeight = height - paddingTop - paddingBottom;
    const count = entries.length;

    const points = entries.map((entry, index) => ({
      x: paddingX + (count === 1 ? chartWidth / 2 : chartWidth * index / (count - 1)),
      value: entry.value
    }));

    const movingAveragePoints = points.map((point, index) => {
      const start = Math.max(0, index - TRENDLINE_PERIOD + 1);
      const slice = points.slice(start, index + 1);
      const average = slice.reduce((sum, current) => sum + current.value, 0) / slice.length;
      const normalized = (average - minValue) / range;
      return {
        x: point.x,
        y: paddingTop + chartHeight - normalized * chartHeight
      };
    });

    if (typeof ctx.save === 'function') ctx.save();
    if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.strokeStyle = TRENDLINE_COLOR;
    ctx.lineWidth = 0.9;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.moveTo(movingAveragePoints[0].x, movingAveragePoints[0].y);

    for (let index = 1; index < movingAveragePoints.length - 1; index += 1) {
      const current = movingAveragePoints[index];
      const next = movingAveragePoints[index + 1];
      ctx.quadraticCurveTo(
        current.x,
        current.y,
        (current.x + next.x) / 2,
        (current.y + next.y) / 2
      );
    }

    const last = movingAveragePoints[movingAveragePoints.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    if (typeof ctx.restore === 'function') ctx.restore();
    return true;
  }

  function wrapTrendRenderer(functionName, canvasId, entriesBuilder, referenceValue) {
    const original = global[functionName];
    if (typeof original !== 'function') return false;
    if (original.__taskPointsTrendLineAboveDots) return true;

    const wrapped = function taskPointsTrendLineAboveDots(...args) {
      const result = original.apply(this, args);
      try {
        drawMovingAverageAboveDots(canvasId, entriesBuilder(args[0]), referenceValue);
      } catch (error) {
        console.warn(`TaskPoints could not redraw ${functionName} trendline above its dots.`, error);
      }
      return result;
    };

    wrapped.__taskPointsTrendLineAboveDots = true;
    wrapped.__taskPointsOriginal = original;
    global[functionName] = wrapped;
    return true;
  }

  function installTrendLineLayering() {
    const hasScoreCanvas = Boolean(getElement('dailyTrend'));
    const hasCaloriesCanvas = Boolean(getElement('caloriesTrend'));
    if (!hasScoreCanvas && !hasCaloriesCanvas) return true;

    const scoreReady = !hasScoreCanvas || wrapTrendRenderer(
      'drawDailyTrend',
      'dailyTrend',
      getDailyTrendEntries,
      null
    );
    const caloriesReady = !hasCaloriesCanvas || wrapTrendRenderer(
      'drawCaloriesTrend',
      'caloriesTrend',
      getCaloriesTrendEntries,
      2600
    );

    return scoreReady && caloriesReady;
  }

  function parseDateKeyLocal(key) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function addLocalDays(date, amount) {
    const next = new Date(date);
    next.setDate(next.getDate() + amount);
    return next;
  }

  function currentTaskPointsDate() {
    let key = '';
    try {
      if (typeof global.getCurrentTaskPointsDayKey === 'function') key = global.getCurrentTaskPointsDayKey();
      else if (typeof global.todayKey === 'function') key = global.todayKey();
    } catch (_) {}
    return parseDateKeyLocal(key) || new Date();
  }

  function mondayForDate(date) {
    const day = date.getDay();
    const daysSinceMonday = day === 0 ? 6 : day - 1;
    return addLocalDays(date, -daysSinceMonday);
  }

  function formatWeeklyDate(date) {
    if (typeof global.niceDate === 'function') {
      try { return global.niceDate(date); } catch (_) {}
    }
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  function readProjectionState() {
    try {
      const loaded = global.TaskPointsCore?.loadAppState?.({ syncDerived: true, persistSync: false });
      if (loaded?.state && typeof loaded.state === 'object') return loaded.state;
    } catch (_) {}
    return {};
  }

  function dailyTotalsWithInertiaForProjection(state) {
    try {
      if (typeof global.getDerived === 'function') {
        const derived = global.getDerived();
        if (derived?.dailyTotalsWithInertia && typeof derived.dailyTotalsWithInertia === 'object') {
          return derived.dailyTotalsWithInertia;
        }
      }
    } catch (_) {}

    const core = global.TaskPointsCore;
    const completions = Array.isArray(state?.completions) ? state.completions : [];
    let dailyTotals = {};
    try {
      dailyTotals = core?.aggregateCompletionsByDate?.(completions, state)?.dailyTotals || {};
    } catch (_) {}
    try {
      return core?.computeDailyTotalsWithInertia?.(dailyTotals, state) || dailyTotals;
    } catch (_) {
      return dailyTotals;
    }
  }

  function buildCurrentWeekProjection() {
    const state = readProjectionState();
    const dailyTotals = dailyTotalsWithInertiaForProjection(state);
    const today = currentTaskPointsDate();
    today.setHours(12, 0, 0, 0);
    const start = mondayForDate(today);
    const end = addLocalDays(start, 6);
    const elapsedDays = Math.round((today - start) / 86400000) + 1;
    if (elapsedDays < 1 || elapsedDays > 7) return null;

    let actualTotal = 0;
    let hasCurrentWeekEntry = false;
    for (let offset = 0; offset < elapsedDays; offset += 1) {
      const key = fallbackDateKey(addLocalDays(start, offset));
      if (!Object.prototype.hasOwnProperty.call(dailyTotals, key)) continue;
      const value = Number(dailyTotals[key]);
      if (!Number.isFinite(value)) continue;
      hasCurrentWeekEntry = true;
      actualTotal += value;
    }
    if (!hasCurrentWeekEntry) return null;

    const projectedTotal = (actualTotal / elapsedDays) * 7;
    if (!Number.isFinite(projectedTotal)) return null;
    return {
      key: fallbackDateKey(start),
      start,
      end,
      actualTotal,
      projectedTotal,
      elapsedDays,
      label: `${formatWeeklyDate(start)} – ${formatWeeklyDate(end)} (on-track)`
    };
  }

  function scoreFromWeeklyRow(row) {
    const scoreNode = row?.lastElementChild;
    const text = String(scoreNode?.textContent || row?.textContent || '').replaceAll(',', '');
    const matches = text.match(/-?\d+(?:\.\d+)?/g);
    if (!matches?.length) return Number.NEGATIVE_INFINITY;
    const value = Number(matches[matches.length - 1]);
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  }

  function createWeeklyProjectionRow(template, projection) {
    const row = template?.cloneNode?.(true) || global.document.createElement('li');
    row.setAttribute(WEEKLY_ON_TRACK_ATTR, '1');
    row.dataset.key = projection.key;
    row.classList.add('leaderboard-current');

    const children = Array.from(row.children || []);
    const scoreText = `${projection.projectedTotal.toLocaleString(undefined, { maximumFractionDigits: 1 })} pts`;
    if (children.length >= 2) {
      children[0].textContent = projection.label;
      children[children.length - 1].textContent = scoreText;
    } else {
      row.className = `${row.className || ''} flex items-center justify-between`.trim();
      row.innerHTML = '';
      const label = global.document.createElement('span');
      const score = global.document.createElement('span');
      label.textContent = projection.label;
      score.textContent = scoreText;
      row.append(label, score);
    }
    return row;
  }

  function applyWeeklyOnTrackProjection() {
    const board = getElement('weeklyBoard');
    if (!board) return false;
    const projection = buildCurrentWeekProjection();
    if (!projection) return false;

    const existingProjection = board.querySelector?.(`[${WEEKLY_ON_TRACK_ATTR}]`);
    if (!existingProjection) {
      board.__taskPointsWeeklyBaseRows = Array.from(board.children || []).map((row) => row.cloneNode(true));
    }
    const baseRows = Array.isArray(board.__taskPointsWeeklyBaseRows)
      ? board.__taskPointsWeeklyBaseRows.map((row) => row.cloneNode(true))
      : Array.from(board.children || [])
          .filter((row) => !row.hasAttribute?.(WEEKLY_ON_TRACK_ATTR))
          .map((row) => row.cloneNode(true));
    if (!baseRows.length) return false;

    const projectionRow = createWeeklyProjectionRow(baseRows[0], projection);
    const rankedRows = [...baseRows, projectionRow]
      .map((row, originalIndex) => ({ row, score: scoreFromWeeklyRow(row), originalIndex }))
      .sort((a, b) => (b.score - a.score) || (a.originalIndex - b.originalIndex))
      .slice(0, WEEKLY_BOARD_LIMIT)
      .map((entry) => entry.row);

    board.replaceChildren(...rankedRows);
    return rankedRows.includes(projectionRow);
  }

  function installWeeklyOnTrackProjection() {
    const board = getElement('weeklyBoard');
    if (!board) return true;
    const original = global.renderStats;
    if (typeof original !== 'function') return false;
    if (original.__taskPointsWeeklyOnTrackProjection) return true;

    const wrapped = function taskPointsRenderStatsWithWeeklyProjection(...args) {
      const result = original.apply(this, args);
      try { applyWeeklyOnTrackProjection(); }
      catch (error) { console.warn('TaskPoints could not add the weekly on-track projection.', error); }
      return result;
    };
    wrapped.__taskPointsWeeklyOnTrackProjection = true;
    wrapped.__taskPointsOriginal = original;
    global.renderStats = wrapped;
    applyWeeklyOnTrackProjection();
    return true;
  }

  function installPatch() {
    if (typeof global.renderYesterdaysResult !== 'function'
      || typeof global.getCompletedYouMatchupsForStats !== 'function') {
      return false;
    }

    if (global.renderYesterdaysResult.__taskPointsUsesSavedCompletedMatchup) return true;

    const originalRenderYesterdaysResult = global.renderYesterdaysResult;
    const wrappedRenderYesterdaysResult = function taskPointsRenderYesterdaysSavedResult(...args) {
      const result = originalRenderYesterdaysResult.apply(this, args);
      applySavedYesterdayResult();
      return result;
    };
    wrappedRenderYesterdaysResult.__taskPointsUsesSavedCompletedMatchup = true;
    wrappedRenderYesterdaysResult.__taskPointsOriginal = originalRenderYesterdaysResult;
    global.renderYesterdaysResult = wrappedRenderYesterdaysResult;

    applySavedYesterdayResult();
    return true;
  }

  function installWhenReady() {
    const resultPatchReady = installPatch();
    const trendLayeringReady = installTrendLineLayering();
    const weeklyProjectionReady = installWeeklyOnTrackProjection();
    if (resultPatchReady && trendLayeringReady && weeklyProjectionReady) return;
    installAttempts += 1;
    if (installAttempts < 40) global.setTimeout?.(installWhenReady, 50);
  }

  global.TaskPointsHomeYesterdayResultConsistency = {
    applySavedYesterdayResult,
    installPatch,
    installPlayerPhotoFrameOverride,
    installTrendLineLayering,
    drawMovingAverageAboveDots,
    buildCurrentWeekProjection,
    applyWeeklyOnTrackProjection,
    installWeeklyOnTrackProjection
  };

  installPlayerPhotoFrameOverride();

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', installWhenReady, { once: true });
  } else {
    installWhenReady();
  }
})(typeof window !== 'undefined' ? window : globalThis);
