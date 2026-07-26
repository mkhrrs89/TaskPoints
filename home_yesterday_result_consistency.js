(function installTaskPointsHomeYesterdayResultConsistency(global) {
  'use strict';

  if (!global || global.__taskPointsHomeYesterdayResultConsistencyInstalled) return;
  global.__taskPointsHomeYesterdayResultConsistencyInstalled = true;

  const WINNER_CLASSES = ['yesterdayWinner', 'yesterdayWinnerScore'];
  const LOSER_CLASSES = ['yesterdayLoser', 'yesterdayLoserScore'];
  let installAttempts = 0;

  function getElement(id) {
    return global.document?.getElementById?.(id) || null;
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
    if (installPatch()) return;
    installAttempts += 1;
    if (installAttempts < 40) global.setTimeout?.(installWhenReady, 50);
  }

  global.TaskPointsHomeYesterdayResultConsistency = {
    applySavedYesterdayResult,
    installPatch
  };

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', installWhenReady, { once: true });
  } else {
    installWhenReady();
  }
})(typeof window !== 'undefined' ? window : globalThis);
