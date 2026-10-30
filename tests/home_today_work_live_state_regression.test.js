const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const core = fs.readFileSync(path.join(__dirname, '..', 'scoring_core.js'), 'utf8');

function extractFunction(source, name) {
  const anchor = 'function ' + name + '(';
  const start = source.indexOf(anchor);
  assert.ok(start >= 0, 'Missing function: ' + name);
  const brace = source.indexOf('{', start);
  let level = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') level++;
    else if (source[i] === '}' && --level === 0) return source.slice(start, i + 1);
  }
  throw new Error('Unbalanced function ' + name);
}

test('Work hours survive reading a title-only row with an absent hours property', () => {
  for (const source of [home, core]) {
    const getInfo = new Function(extractFunction(source, 'getWorkInfo') + '\nreturn getWorkInfo;')();
    const row = { title: 'Work Score (0) — Hours 8', points: 0, source: 'work',
      completedAtISO: '2026-10-29T12:00:00.000Z' };
    assert.deepEqual(getInfo(row), { score: 0, hours: 8 });
    assert.equal(getInfo({ title: 'Work Score (7) — Hours 7.75' }).hours, 7.75);
    assert.equal(getInfo({ title: 'Work Score (7) — Hours 8', workHours: 0 }).hours, 0);
    assert.equal(getInfo({ title: 'Work Score (7) — Hours 8', workHours: 4 }).hours, 4);
  }
});

test('Work Hours parsing is read-only and does not change stored source rows', () => {
  const getInfo = new Function(extractFunction(home, 'getWorkInfo') + '\nreturn getWorkInfo;')();
  const row = { id: 'work-29', title: 'Work Score (0) — Hours 8', points: 0 };
  const before = JSON.stringify(row);
  assert.equal(getInfo(row).hours, 8);
  assert.equal(JSON.stringify(row), before);
});

test('derived cache is invalidated for state replacements, array swaps and same-size swaps', () => {
  const fragment = home.slice(home.indexOf('const _derived = {'), home.indexOf('// ---------- /Derived cache ----------'));
  assert.match(fragment, /builtState:\s*null/);
  assert.match(fragment, /builtCompletions:\s*null/);
  assert.match(fragment, /builtCompletionsLength:\s*-1/);
  const ctx = {
    state: { completions: [{ completedAtISO: '2026-10-30T12:00:00.000Z', points: 3, title: 'A' }] },
    getCompletionPoints: c => c.points,
    dateKey: () => '2026-10-30',
    aggregateCompletionsByDate: rows => ({ dailyTotals: { '2026-10-30': rows.reduce((n, r) => n + r.points, 0) } })
  };
  const getDerived = new Function('ctx', 'with(ctx) { ' + fragment + '\n return { getDerived, markCompletionsDirty, _derived }; }')(ctx);
  // The fragment declares its own _derived and creates getters in its closure.
  const first = getDerived.getDerived();
  assert.equal(first.agg.dailyTotals['2026-10-30'], 3);
  const cacheRevision = first.builtRev;
  getDerived.getDerived();
  assert.equal(first.builtRev, cacheRevision);
  ctx.state = { completions: [{ completedAtISO: '2026-10-30T12:00:00.000Z', points: 9, title: 'B' }] };
  assert.equal(getDerived.getDerived().agg.dailyTotals['2026-10-30'], 9);
  assert.equal(getDerived._derived.builtState, ctx.state);
  ctx.state.completions.push({ completedAtISO: '2026-10-30T13:00:00.000Z', points: 1 });
  assert.equal(getDerived.getDerived().agg.dailyTotals['2026-10-30'], 10);
});

test('lifecycle reload invalidates scores before scheduling a repaint', () => {
  const fragment = extractFunction(home, 'refreshMainPageFromStorage');
  assert.match(fragment, /state = normalizeState\(load\(\)\);\s*markCompletionsDirty\(\)/);
  assert.match(fragment, /state = syncStateWithMatchups\(state\);\s*markCompletionsDirty\(\)/);
  let revision = 0;
  let rendered = false;
  const storedState = { completions: [{ points: 9 }] };
  const run = new Function('ctx','with(ctx) {' + fragment + '; return refreshMainPageFromStorage; }')({
    storageCache: { raw: 'a', parsed: { completions: [] } },
    normalizeState: s => s,
    load: () => storedState,
    markCompletionsDirty: () => { revision++; },
    maybeAutoSimToday: () => false,
    syncStateWithMatchups: s => s,
    scheduleRender: () => { rendered = true; },
    renderAll: () => {},
    markHomeLifecycleBaseline: () => {}
  });
  run();
  assert.equal(revision, 2);
  assert.equal(rendered, true);
});

test('every habit tap schedules canonical Today reconciliation, including today's taps', () => {
  const action = extractFunction(home, 'handleHabitBubbleTap');
  assert.match(action, /renderTodayScoreValueOnly\(baseline \+ delta\)/);
  assert.match(action, /scheduleHabitTodayScoreReconciliation\(\);\s*if \(window\.TP_DEBUG_PERF\)/);
  assert.doesNotMatch(action, /if \(dayKey === todayKey\(\)\)[\s\S]*?scheduleHabitTodayScoreReconciliation\(\);\s*\}/);
});

test('background live-diff capture never reloads a stale saved copy over live habits or Work', () => {
  const fragment = extractFunction(home, 'captureLiveDiffPoint');
  assert.doesNotMatch(fragment, /normalizeState\(load\(\)\)/);
  assert.match(fragment, /const latest = state;/);
  assert.match(fragment, /storedRevision !== loadedStateRevision/);
  const current = { completions: [
    { id: 'work-29', workHours: 8 },
    { id: 'habit-30', source: 'habit', points: 5 }
  ], liveDiffHistory: {}, liveDiffSnapshots: {} };
  let saved = null, loads = 0;
  const ctx = {
    state: current,
    loadedStateRevision: 'rev1',
    getCurrentTaskPointsDayKey: () => '2026-10-30',
    getLiveDiffSlotForNow: () => 's1',
    readHomeStateRevision: () => 'rev1',
    normalizeState: s => s,
    load: () => { loads++; return { completions: [] }; },
    getTodayVisibleMatchupScores: () => ({ youScore: 17, opponentScore: 5 }),
    liveDiffSlotToIndex: () => 0,
    cleanupLiveDiffHistory: s => s,
    save: () => { saved = ctx.state; },
    drawLiveDiffGraph: () => {},
    window: { TP_DEBUG_PERF: false }
  };
  const run = new Function('ctx','with(ctx) { ' + fragment + '; return captureLiveDiffPoint; }')(ctx);
  run();
  assert.equal(loads, 0);
  assert.equal(saved.completions.length, 2);
  assert.equal(saved.completions[0].workHours, 8);
  assert.equal(saved.completions[1].points, 5);
});

test('optional live-diff capture skips writing if another tab has a newer revision', () => {
  const fragment = extractFunction(home, 'captureLiveDiffPoint');
  let writes = 0;
  const context = {
    getCurrentTaskPointsDayKey: () => '2026-10-30',
    getLiveDiffSlotForNow: () => 's1',
    state: { completions: [] },
    readHomeStateRevision: () => 'new-revision',
    loadedStateRevision: 'old-revision',
    save: () => { writes++; },
    window: { TP_DEBUG_PERF: false }
  };
  const run = new Function('ctx', 'with(ctx) { ' + fragment + '; return captureLiveDiffPoint; }')(context);
  run();
  assert.equal(writes, 0);
});

test('read-only live-diff cleanup retains state identity until pruning is required', () => {
  const fragment = extractFunction(home, 'cleanupLiveDiffHistory');
  const cleanup = new Function('ctx', 'with(ctx) { ' + fragment + '; return cleanupLiveDiffHistory; }')({
    getCurrentTaskPointsDayKey: () => '2026-10-30',
    fromKey: k => new Date(k + 'T12:00:00'),
    dateKey: d => d.toISOString().slice(0,10)
  });
  const present = { completions: [{ points: 1 }], liveDiffHistory: {}, liveDiffSnapshots: {} };
  assert.equal(cleanup(present), present);
  const stale = { ...present, liveDiffHistory: { '2026-10-20': [1], '2026-10-30': [2] } };
  const pruned = cleanup(stale);
  assert.notEqual(pruned, stale);
  assert.equal(pruned.completions, stale.completions);
  assert.deepEqual(Object.keys(pruned.liveDiffHistory), ['2026-10-30']);
});
