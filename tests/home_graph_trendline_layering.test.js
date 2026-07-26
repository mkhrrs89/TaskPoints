const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'home_yesterday_result_consistency.js'),
  'utf8'
);

function createCanvas(log) {
  const context = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    lineJoin: '',
    lineCap: '',
    save() { log.push({ type: 'save' }); },
    restore() { log.push({ type: 'restore' }); },
    setTransform() { log.push({ type: 'transform' }); },
    beginPath() { log.push({ type: 'begin' }); },
    moveTo(x, y) { log.push({ type: 'move', x, y }); },
    lineTo(x, y) { log.push({ type: 'line', x, y }); },
    quadraticCurveTo() { log.push({ type: 'curve' }); },
    arc() { log.push({ type: 'arc' }); },
    fill() { log.push({ type: 'fill', color: this.fillStyle }); },
    stroke() { log.push({ type: 'stroke', color: this.strokeStyle }); }
  };

  return {
    clientWidth: 320,
    clientHeight: 80,
    getContext() { return context; },
    context
  };
}

function createHarness() {
  const dailyLog = [];
  const caloriesLog = [];
  const dailyCanvas = createCanvas(dailyLog);
  const caloriesCanvas = createCanvas(caloriesLog);
  const appendedStyles = [];
  const elements = new Map([
    ['dailyTrend', dailyCanvas],
    ['caloriesTrend', caloriesCanvas]
  ]);

  const document = {
    readyState: 'complete',
    head: {
      appendChild(element) {
        appendedStyles.push(element);
        if (element.id) elements.set(element.id, element);
      }
    },
    createElement(tagName) {
      return { tagName, id: '', textContent: '' };
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
    addEventListener() {}
  };

  const context = {
    document,
    devicePixelRatio: 2,
    Date,
    Number,
    String,
    Array,
    Object,
    Math,
    Set,
    Map,
    console,
    getCompletedYouMatchupsForStats: () => [],
    renderYesterdaysResult() {},
    drawDailyTrend() {
      dailyCanvas.context.fillStyle = '#5FC4CF';
      dailyCanvas.context.strokeStyle = 'rgba(11,13,16,0.85)';
      dailyCanvas.context.beginPath();
      dailyCanvas.context.arc(20, 30, 2, 0, Math.PI * 2);
      dailyCanvas.context.fill();
      dailyCanvas.context.stroke();
    },
    drawCaloriesTrend() {
      caloriesCanvas.context.fillStyle = '#5FC4CF';
      caloriesCanvas.context.strokeStyle = 'rgba(11,13,16,0.85)';
      caloriesCanvas.context.beginPath();
      caloriesCanvas.context.arc(20, 30, 2, 0, Math.PI * 2);
      caloriesCanvas.context.fill();
      caloriesCanvas.context.stroke();
    },
    setTimeout(callback) {
      callback();
      return 1;
    }
  };
  context.window = context;
  context.globalThis = context;

  vm.runInNewContext(source, context, {
    filename: 'home_yesterday_result_consistency.js'
  });

  return { context, dailyLog, caloriesLog };
}

function assertOrangeStrokeIsAboveDots(log) {
  const arcIndex = log.findIndex((entry) => entry.type === 'arc');
  const orangeStrokeIndex = log.findLastIndex(
    (entry) => entry.type === 'stroke' && entry.color === '#F59E0B'
  );
  const lastStroke = log.filter((entry) => entry.type === 'stroke').at(-1);

  assert.notEqual(arcIndex, -1, 'the original renderer painted a dot');
  assert.ok(orangeStrokeIndex > arcIndex, 'the orange line was painted after the dot layer');
  assert.equal(lastStroke?.color, '#F59E0B', 'the orange trendline is the final painted stroke');
}

test('Score Trend paints its orange moving average above the raw dots', () => {
  const harness = createHarness();

  harness.context.drawDailyTrend({
    '2026-07-23': 42,
    '2026-07-24': 55,
    '2026-07-25': 49
  });

  assert.equal(harness.context.drawDailyTrend.__taskPointsTrendLineAboveDots, true);
  assertOrangeStrokeIsAboveDots(harness.dailyLog);
});

test('Calories Trend paints its orange moving average above the raw dots', () => {
  const harness = createHarness();

  harness.context.drawCaloriesTrend([
    { key: '2026-07-23', calories: 2400 },
    { key: '2026-07-24', calories: 2800 },
    { key: '2026-07-25', calories: 2600 }
  ]);

  assert.equal(harness.context.drawCaloriesTrend.__taskPointsTrendLineAboveDots, true);
  assertOrangeStrokeIsAboveDots(harness.caloriesLog);
});
