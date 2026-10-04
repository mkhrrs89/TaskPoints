const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
const storage = new Map();
global.localStorage = {
  getItem(key) { return storage.has(String(key)) ? storage.get(String(key)) : null; },
  setItem(key, value) { storage.set(String(key), String(value)); },
  removeItem(key) { storage.delete(String(key)); },
  key(index) { return Array.from(storage.keys())[index] || null; },
  get length() { return storage.size; }
};

require('../scoring_core.js');
const core = global.TaskPointsCore;
const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const streaks = fs.readFileSync(path.join(__dirname, '..', 'streaks.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

test('shared at-risk helper matches Streaks eligibility and canonical bonus preview', () => {
  const state = core.normalizeState({
    habits: [
      {
        id: 'habit-high',
        name: 'Habit High',
        category: 'habit',
        pointsPerDay: 10,
        streakMultiplierEnabled: true,
        streakMultiplierStartDateKey: '2026-09-01',
        doneKeys: ['2026-10-01', '2026-10-02', '2026-10-03'],
        failedKeys: []
      },
      {
        id: 'vice-low',
        name: 'Vice Low',
        category: 'vice',
        pointsPerDay: 5,
        streakMultiplierEnabled: true,
        streakMultiplierStartDateKey: '2026-09-01',
        doneKeys: ['2026-10-02', '2026-10-03'],
        failedKeys: []
      },
      {
        id: 'done-today',
        name: 'Done Today',
        pointsPerDay: 20,
        streakMultiplierEnabled: true,
        streakMultiplierStartDateKey: '2026-09-01',
        doneKeys: ['2026-10-03', '2026-10-04'],
        failedKeys: []
      },
      {
        id: 'failed-today',
        name: 'Failed Today',
        pointsPerDay: 20,
        streakMultiplierEnabled: true,
        streakMultiplierStartDateKey: '2026-09-01',
        doneKeys: ['2026-10-03'],
        failedKeys: ['2026-10-04']
      }
    ],
    completions: []
  });

  const rows = core.getAtRiskStreakRows(state, {
    todayKey: '2026-10-04',
    pendingDeltas: []
  });

  assert.deepEqual(rows.map((row) => row.id), ['habit-high', 'vice-low']);
  assert.equal(rows[0].streak, 3);
  assert.equal(rows[0].bonus, 0.3);
  assert.equal(rows[0].pointsAtRisk, rows[0].bonus);
  assert.equal(rows[1].streak, 2);
  assert.equal(rows[1].bonus, 0.1);
});

test('pending today toggle immediately removes a streak from At Risk', () => {
  const state = core.normalizeState({
    habits: [{
      id: 'habit-1',
      name: 'Habit 1',
      category: 'habit',
      pointsPerDay: 10,
      streakMultiplierEnabled: true,
      streakMultiplierStartDateKey: '2026-09-01',
      doneKeys: ['2026-10-02', '2026-10-03'],
      failedKeys: []
    }],
    completions: []
  });

  const rows = core.getAtRiskStreakRows(state, {
    todayKey: '2026-10-04',
    pendingDeltas: [{
      habitId: 'habit-1',
      dayKey: '2026-10-04',
      source: 'habit',
      status: 'full',
      done: true,
      updatedAtISO: '2026-10-04T08:00:00'
    }]
  });

  assert.equal(rows.length, 0);
});

test('Habits and Vices contain identical shared top-three at-risk cards', () => {
  const cards = index.match(/<div class="home-streak-risk-card glass mb-3" data-home-streak-risk-card>[\s\S]*?<\/div>\s*\n\s*<div class="glass mb-6 habits-card/g) || [];
  assert.equal(cards.length, 2);
  assert.equal((index.match(/Top 3 by bonus at risk today/g) || []).length, 2);
  assert.equal((index.match(/data-home-streak-risk-list/g) || []).length >= 2, true);
  assert.match(index, /\.sort\(\(a, b\) =>[\s\S]*pointsAtRisk[\s\S]*\.slice\(0, 3\)/);
  assert.match(index, /scheduleHomeStreaksAtRiskRender\(\)/);
});

test('Streaks page and Home summary share the same At Risk helper', () => {
  assert.match(streaks, /core\.getAtRiskStreakRows\(state, \{ todayKey, pendingDeltas \}\)/);
  assert.match(index, /TaskPointsCore\.getAtRiskStreakRows\(state\)/);
});

test('at-risk cards are limited to the mobile Habits/Vices tab experience', () => {
  assert.match(styles, /@media \(min-width: 768px\)[\s\S]*?\.home-streak-risk-card\s*\{\s*display:\s*none;/);
});
