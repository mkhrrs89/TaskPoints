const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'home_yesterday_result_consistency.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, '_worker.js'), 'utf8');

class FakeClassList {
  constructor(initial = []) {
    this.values = new Set(initial);
  }
  add(...names) {
    names.forEach((name) => this.values.add(name));
  }
  remove(...names) {
    names.forEach((name) => this.values.delete(name));
  }
  toggle(name, force) {
    if (force === true) {
      this.values.add(name);
      return true;
    }
    if (force === false) {
      this.values.delete(name);
      return false;
    }
    if (this.values.has(name)) {
      this.values.delete(name);
      return false;
    }
    this.values.add(name);
    return true;
  }
  contains(name) {
    return this.values.has(name);
  }
}

function createElement(initialClasses = []) {
  return {
    textContent: '',
    classList: new FakeClassList(initialClasses)
  };
}

function createHarness(initialRows) {
  let rows = initialRows;
  let originalRenderCalls = 0;
  const elements = {
    yesterdayResultsPanel: createElement(['yesterday-win']),
    yesterdayYouName: createElement(['yesterdayWinner']),
    yesterdayYourScore: createElement(['yesterdayWinnerScore']),
    yesterdayOpponent: createElement(['yesterdayLoser']),
    yesterdayOpponentScore: createElement(['yesterdayLoserScore']),
    yesterdayResult: createElement(),
    yesterdayYourPrimarySwatch: createElement(),
    yesterdayYourSecondarySwatch: createElement(),
    yesterdayOpponentPrimarySwatch: createElement(),
    yesterdayOpponentSecondarySwatch: createElement()
  };

  const context = {
    document: {
      readyState: 'complete',
      getElementById(id) {
        return elements[id] || null;
      },
      addEventListener() {}
    },
    getGameDayKey: () => '2026-07-25',
    getCompletedYouMatchupsForStats: () => rows,
    getYouName: () => 'You',
    getPlayerNameById: (id) => id === 'FRANKIE' ? 'Frankie' : String(id || 'Opponent'),
    getPlayerById: () => ({}),
    setPlayerColorSwatches() {},
    renderYesterdaysResult() {
      originalRenderCalls += 1;
      elements.yesterdayYourScore.textContent = '48.4';
      elements.yesterdayOpponentScore.textContent = '48.4';
      elements.yesterdayResult.textContent = 'W';
      elements.yesterdayResultsPanel.classList.add('yesterday-win');
      elements.yesterdayYouName.classList.add('yesterdayWinner');
      elements.yesterdayYourScore.classList.add('yesterdayWinnerScore');
      elements.yesterdayOpponent.classList.add('yesterdayLoser');
      elements.yesterdayOpponentScore.classList.add('yesterdayLoserScore');
    },
    setTimeout(callback) {
      callback();
      return 1;
    },
    Date,
    Number,
    String,
    Array,
    Object,
    Math,
    Set,
    console
  };
  context.window = context;
  context.globalThis = context;

  vm.runInNewContext(source, context, { filename: 'home_yesterday_result_consistency.js' });

  return {
    context,
    elements,
    setRows(nextRows) {
      rows = nextRows;
    },
    originalRenderCalls: () => originalRenderCalls
  };
}

test('Yesterday panel overwrites a recalculated win with the saved completed matchup loss used by streaks', () => {
  const harness = createHarness([{
    id: 'saved-loss',
    dateKey: '2026-07-25',
    playerAId: 'YOU',
    playerBId: 'FRANKIE',
    youScore: 42.1,
    oppScore: 48.4,
    result: 'L'
  }]);

  harness.context.renderYesterdaysResult({});

  assert.equal(harness.originalRenderCalls(), 1, 'existing renderer still runs first');
  assert.equal(harness.elements.yesterdayYourScore.textContent, '42.1');
  assert.equal(harness.elements.yesterdayOpponentScore.textContent, '48.4');
  assert.equal(harness.elements.yesterdayOpponent.textContent, 'Frankie');
  assert.equal(harness.elements.yesterdayResult.textContent, 'L');
  assert.equal(harness.elements.yesterdayResultsPanel.classList.contains('yesterday-win'), false);
  assert.equal(harness.elements.yesterdayYouName.classList.contains('yesterdayLoser'), true);
  assert.equal(harness.elements.yesterdayOpponent.classList.contains('yesterdayWinner'), true);
});

test('Yesterday panel displays a real tie without winner or loser styling', () => {
  const harness = createHarness([{
    id: 'saved-tie',
    dateKey: '2026-07-25',
    playerAId: 'YOU',
    playerBId: 'FRANKIE',
    youScore: 48.4,
    oppScore: 48.4,
    result: 'T'
  }]);

  harness.context.renderYesterdaysResult({});

  assert.equal(harness.elements.yesterdayResult.textContent, 'T');
  assert.equal(harness.elements.yesterdayResultsPanel.classList.contains('yesterday-win'), false);
  assert.equal(harness.elements.yesterdayResultsPanel.classList.contains('yesterday-tie'), true);
  [
    harness.elements.yesterdayYouName,
    harness.elements.yesterdayYourScore,
    harness.elements.yesterdayOpponent,
    harness.elements.yesterdayOpponentScore
  ].forEach((element) => {
    assert.equal(element.classList.contains('yesterdayWinner'), false);
    assert.equal(element.classList.contains('yesterdayWinnerScore'), false);
    assert.equal(element.classList.contains('yesterdayLoser'), false);
    assert.equal(element.classList.contains('yesterdayLoserScore'), false);
  });
});

test('worker loads the homepage result consistency patch as an optional module', () => {
  assert.match(worker, /'\/home_yesterday_result_consistency\.js'/);
  assert.match(worker, /homeYesterdayConsistencyResult/);
  assert.match(worker, /homeYesterdayConsistencySource/);
  assert.match(worker, /if \(homeYesterdayConsistencySource\) sources\.push\(homeYesterdayConsistencySource\);/);
});
