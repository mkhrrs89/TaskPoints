const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'indexeddb_requalification_guard.js'), 'utf8');

function oldHighCurve(rawScore) {
  const score = Number(rawScore);
  if (score <= 62) return score;
  const over = score - 62;
  return Math.round((62 + 23 * (over / (over + 23))) * 10) / 10;
}

function install({ baseScore = 50, effects = null } = {}) {
  const core = {
    simulateAiScoreForPlayerCore(player, dateKey, options = {}) {
      if (effects) options.context?.captureEffects?.({ ...effects });
      return baseScore;
    }
  };
  const context = {
    TaskPointsCore: core,
    console,
    queueMicrotask(fn) { fn(); }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'indexeddb_requalification_guard.js' });
  return core;
}

test('future NPC high-score taper keeps 62 and 86 but thins the upper tail', () => {
  const core = install();

  assert.equal(core.softCurbNpcScore(62), 62);
  assert.equal(core.softCurbNpcScore(70), 65);
  assert.equal(core.softCurbNpcScore(80), 68.7);
  assert.equal(core.softCurbNpcScore(100), 73.5);
  assert.equal(core.softCurbNpcScore(150), 78.7);
  assert.ok(core.softCurbNpcScore(1000000) <= 86);
});

test('lower taper below 20 is unchanged', () => {
  const core = install();

  assert.equal(core.softCurbNpcScore(20), 20);
  assert.equal(core.softCurbNpcScore(10), 14);
  assert.ok(core.softCurbNpcScore(-1000000) >= 5);
});

test('new upper-tail shape is future-only by date', () => {
  const core = install();
  assert.equal(core.softCurbNpcScore(80, { dateKey: '2026-09-29' }), 72.3);
  assert.equal(core.softCurbNpcScore(80, { dateKey: '2026-09-30' }), 68.7);
});

test('final simulator preserves historical curve and uses the thinner tail for future dates', () => {
  const core = install({ baseScore: oldHighCurve(80) });

  assert.equal(core.simulateAiScoreForPlayerCore({}, '2026-09-29'), 72.3);
  assert.equal(core.simulateAiScoreForPlayerCore({}, '2026-09-30'), 68.7);
});

test('Greed still applies after the future taper and the final hard ceiling stays 86', () => {
  const core = install({
    baseScore: 81.3,
    effects: {
      greedTelemetryVersion: 1,
      greedPerformanceEligible: true,
      greedBonus: 5,
      greedPotentialBonus: 5
    }
  });
  let captured = null;
  const score = core.simulateAiScoreForPlayerCore({}, '2026-09-30', {
    context: {
      captureEffects(effects) { captured = effects; }
    }
  });

  assert.equal(score, 78.5);
  assert.equal(captured.greedBonus, 5);
  assert.ok(score <= 86);
});
