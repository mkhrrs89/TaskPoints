const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'home_rank_percentile_line.js'), 'utf8');
const marker = ';(function installTaskPointsHomeScoreboardTieRecord';
const start = source.indexOf(marker);
assert.notEqual(start, -1, 'expected Home scoreboard tie-record patch');
const patchSource = source.slice(start);

function makeContext() {
  const recordNode = { textContent: '' };
  const context = {
    computeYourRecord: () => ({ wins: 7, losses: 4, ties: 1, games: 12 }),
    getPlayerRecordText: () => 'fallback',
    getHomeScoreboardSeasonThreeState: () => ({ marker: 'season-three' }),
    TaskPointsCore: {
      computeRecord(_state, playerId) {
        if (playerId === 'TIED') return { wins: 5, losses: 4, ties: 2, games: 11 };
        if (playerId === 'UNTIED') return { wins: 3, losses: 2, ties: 0, games: 5 };
        return { wins: 0, losses: 0, ties: 0, games: 0 };
      }
    },
    document: {
      readyState: 'complete',
      getElementById(id) {
        return id === 'matchupYourRecord' ? recordNode : null;
      },
      addEventListener() {}
    },
    setTimeout(fn) { fn(); return 1; },
    addEventListener() {},
    Number,
    String,
    console
  };
  context.window = context;
  context.globalThis = context;
  return { context, recordNode };
}

test('Home scoreboard shows W-L-T when the season record contains ties', () => {
  const { context, recordNode } = makeContext();
  vm.runInNewContext(patchSource, context, { filename: 'home_scoreboard_tie_record_patch.js' });

  assert.equal(context.getYourRecordText(), '7-4-1');
  assert.equal(recordNode.textContent, 'Record: 7-4-1');
});

test('Home scoreboard opponent record follows the same tie-aware format', () => {
  const { context } = makeContext();
  vm.runInNewContext(patchSource, context, { filename: 'home_scoreboard_tie_record_patch.js' });

  assert.equal(context.getPlayerRecordText('TIED'), '5-4-2');
  assert.equal(context.getPlayerRecordText('UNTIED'), '3-2');
});

test('tie-record patch does not alter Last 10 logic', () => {
  assert.doesNotMatch(patchSource, /last\s*10|lastTen|matchupLastTen/i);
});
