const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const matchupsHtml = fs.readFileSync('matchups.html', 'utf8');
const indexHtml = fs.readFileSync('index.html', 'utf8');
const gameHtml = fs.readFileSync('game.html', 'utf8');
const scoringCore = fs.readFileSync('scoring_core.js', 'utf8');

function loadMatchupExportContext() {
  const start = matchupsHtml.indexOf('function csvEscape');
  const end = matchupsHtml.indexOf('document\n  .getElementById("exportMatchupsCsvBtn")');
  assert.ok(start >= 0 && end > start);
  const sandbox = {
    getYouName: () => 'You',
    getHistoryDateKey: (g) => String(g?.dateKey || g?.date || g?.dateISO || '').slice(0, 10),
    getMatchupDateKey: (m) => String(m?.dateKey || m?.date || m?.dateISO || '').slice(0, 10),
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(matchupsHtml.slice(start, end), sandbox);
  return sandbox;
}

test('matchup CSV columns exclude IDs and ratings and include only activation telemetry columns', () => {
  const ctx = loadMatchupExportContext();
  let csv = '';
  ctx.document = { getElementById: (id) => ({ value: id.includes('Start') ? '2026-07-01' : '2026-07-01' }) };
  ctx.alert = (message) => { throw new Error(message); };
  ctx.downloadTextFile = (_filename, text) => { csv = text; };
  ctx.state = {
    players: [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }],
    matchups: [{ date: '2026-07-01', id: 'm1', playerAId: 'A', playerBId: 'B', scoreA: 1, scoreB: 0 }],
    gameHistory: []
  };
  ctx.exportMatchupsForSelectedRange();
  const headings = csv.replace(/^\uFEFF/, '').split('\r\n')[0].split(',');
  assert.deepEqual(headings, [
    'Date', 'Matchup Type',
    'Player A', 'Player A Score', 'Player A Result', 'Player A Record Before', 'Player A Record After', 'Player A Intimidation Activated', 'Player A Poise Activated',
    'Player B', 'Player B Score', 'Player B Result', 'Player B Record Before', 'Player B Record After', 'Player B Intimidation Activated', 'Player B Poise Activated'
  ]);
  assert.equal(headings.some((h) => h === 'Matchup ID' || h === 'Player A ID' || h === 'Player B ID'), false);
  assert.equal(headings.some((h) => /Rating/i.test(h)), false);
  assert.deepEqual(headings.filter((h) => /Activated$/.test(h)), [
    'Player A Intimidation Activated', 'Player A Poise Activated', 'Player B Intimidation Activated', 'Player B Poise Activated'
  ]);
});

test('record export uses spreadsheet text wrapper for all record fields', () => {
  const ctx = loadMatchupExportContext();
  assert.equal(ctx.formatRecordForSpreadsheet({ wins: 1, losses: 0, ties: 0 }), '="1-0"');
  assert.equal(ctx.formatRecordForSpreadsheet({ wins: 0, losses: 1, ties: 0 }), '="0-1"');
  assert.equal(ctx.formatRecordForSpreadsheet({ wins: 47, losses: 31, ties: 0 }), '="47-31"');
  const rows = ctx.buildMatchupExportRows({
    players: [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }],
    matchups: [
      { id: 'm1', date: '2026-07-01', playerAId: 'A', playerBId: 'B', scoreA: 10, scoreB: 5 },
      { id: 'm2', date: '2026-07-02', playerAId: 'A', playerBId: 'B', scoreA: 8, scoreB: 7 }
    ]
  }, '2026-07-02', '2026-07-02');
  assert.equal(rows[0].playerARecordBefore, '="1-0"');
  assert.equal(rows[0].playerARecordAfter, '="2-0"');
  assert.equal(rows[0].playerBRecordBefore, '="0-1"');
  assert.equal(rows[0].playerBRecordAfter, '="0-2"');
  for (const key of ['playerARecordBefore','playerARecordAfter','playerBRecordBefore','playerBRecordAfter']) {
    assert.match(rows[0][key], /^="\d+-\d+(?:-\d+)?"$/);
  }
});

test('effect labels and fallback priority preserve blanks for missing NPC telemetry', () => {
  const ctx = loadMatchupExportContext();
  assert.equal(ctx.matchupEffectLabel(true), 'Yes');
  assert.equal(ctx.matchupEffectLabel(false), 'No');
  assert.equal(ctx.matchupEffectLabel(null), '');
  assert.equal(ctx.matchupEffectLabel(undefined), '');

  const matchupA = { intimidationApplied: true, poiseApplied: false };
  const matchupB = { intimidationApplied: false, poiseApplied: true };
  const historyA = { intimidationApplied: false, poiseApplied: true };
  const historyB = { intimidationApplied: true, poiseApplied: false };
  const rows = ctx.buildMatchupExportRows({
    players: [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }, { id: 'C', name: 'Gamma' }],
    gameHistory: [
      { date: '2026-07-01', playerId: 'A', score: 3, effects: historyA },
      { date: '2026-07-01', playerId: 'B', score: 4, effects: historyB }
    ],
    matchups: [
      { id: 'direct', date: '2026-07-01', playerAId: 'A', playerBId: 'B', scoreA: 1, scoreB: 2, playerAEffects: matchupA, playerBEffects: matchupB },
      { id: 'hist', date: '2026-07-01', playerAId: 'A', playerBId: 'B', scoreA: 1, scoreB: 2, playerAEffects: null, playerBEffects: null },
      { id: 'you-a', date: '2026-07-01', playerAId: 'YOU', playerBId: 'C', scoreA: 1, scoreB: 2 },
      { id: 'you-b', date: '2026-07-01', playerAId: 'C', playerBId: 'YOU', scoreA: 2, scoreB: 1 },
      { id: 'blank', date: '2026-07-01', playerAId: 'C', playerBId: 'A', scoreA: 1, scoreB: 2 }
    ]
  }, '2026-07-01', '2026-07-01');
  const direct = rows.find((r) => r.playerA === 'Alpha' && r.playerB === 'Beta');
  assert.equal(direct.playerAIntimidationActivated, 'No');
  assert.equal(direct.playerAPoiseActivated, 'No');
  assert.equal(direct.playerBIntimidationActivated, 'Yes');
  assert.equal(direct.playerBPoiseActivated, 'Yes');
  const hist = rows.filter((r) => r.playerA === 'Alpha' && r.playerB === 'Beta')[1];
  assert.equal(hist.playerAIntimidationActivated, 'Yes');
  assert.equal(hist.playerAPoiseActivated, 'Yes');
  assert.equal(hist.playerBIntimidationActivated, 'No');
  assert.equal(hist.playerBPoiseActivated, 'No');
  const youAsA = rows.find((r) => r.playerA === 'You' && r.playerB === 'Gamma');
  assert.equal(youAsA.playerAIntimidationActivated, 'No');
  assert.equal(youAsA.playerBIntimidationActivated, 'No');
  assert.equal(youAsA.playerAPoiseActivated, 'No');
  assert.equal(youAsA.playerBPoiseActivated, '');
  const youAsB = rows.find((r) => r.playerA === 'Gamma' && r.playerB === 'You');
  assert.equal(youAsB.playerAIntimidationActivated, 'No');
  assert.equal(youAsB.playerBIntimidationActivated, 'No');
  assert.equal(youAsB.playerAPoiseActivated, '');
  assert.equal(youAsB.playerBPoiseActivated, 'No');
  const blank = rows.find((r) => r.playerA === 'Gamma' && r.playerB === 'Alpha');
  assert.equal(blank.playerAPoiseActivated, '');
  assert.equal(blank.playerBIntimidationActivated, '');
});

test('score-generation paths and packed schemas preserve effects telemetry', () => {
  assert.match(indexHtml, /state\.gameHistory\.push\(\{[\s\S]*?effects: capturedEffects[\s\S]*?\}\);/);
  assert.match(indexHtml, /existingHistoryEntry = g;[\s\S]*capturedEffects = existingHistoryEntry\?\.effects \?\? null;/);
  assert.match(gameHtml, /const effectsById = \{\};/);
  assert.match(gameHtml, /captureEffects\(effects\)[\s\S]*capturedEffects = effects \|\| null;/);
  assert.match(gameHtml, /playerAEffects: effectsById\[pair\.playerAId\] \?\? null/);
  assert.match(gameHtml, /effects: m\.playerAEffects \?\? null/);
  assert.match(gameHtml, /effects: m\.playerBEffects \?\? null/);
  assert.match(matchupsHtml, /existing\.effects \?\? null/);
  assert.match(matchupsHtml, /upsertGameHistoryEntry\(nextState, dateKeyStr, playerId, score, capturedEffects\)/);
  assert.match(matchupsHtml, /if \(hasEffects\) existing\.effects = effects;/);
  assert.match(scoringCore, /matchups: \[[^\]]*'playerAEffects'[^\]]*'playerBEffects'/);
  assert.match(scoringCore, /gameHistory: \[[^\]]*'effects'/);
  assert.match(scoringCore, /effects: capturedEffects/);
  assert.match(scoringCore, /historyEntry\?\.effects[\s\S]*next\[`player\$\{side\}Effects`\] = historyEntry\.effects/);
});
