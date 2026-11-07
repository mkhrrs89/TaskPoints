const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'save_pipeline_shared_work.js'), 'utf8');
const nextInstaller = source.indexOf(';(function installTaskPointsYouScoreAliasSync');
assert.ok(nextInstaller > 0, 'shared reader must be independently testable');
const readerSource = source.slice(0, nextInstaller);

function makeHarness({ verified = false } = {}) {
  const payload = { tasks: [{ id: 'saved-task' }], completions: [{ id: 'saved-completion' }], players: [{ id: 'saved-player' }] };
  const raw = JSON.stringify(payload);
  let decodes = 0;
  let warnings = 0;
  const core = {
    parseTaskPointsStorageJson(value) { decodes += 1; return JSON.parse(value); },
    shadowSourceSummary() { return { counts: {}, hashes: { state: 'hash' } }; },
    readPendingHabitDeltas() { return []; },
    readPendingPlayerEdits() { return []; },
    getPendingShadowDualWriteCount() { return 0; },
    getPendingPhase4WriteCount() { return 0; },
    getPhase4VerifiedPrimaryCache() {
      return verified ? {
        status: 'passed_verification', mirrorRaw: raw,
        state: { tasks: [{ id: 'stale-cache-row' }] }, destinationHash: 'hash', sequence: 1
      } : null;
    }
  };
  const context = {
    TaskPointsCore: core,
    structuredClone() { throw new Error('simulated iOS snapshot clone failure'); },
    console: { warn() { warnings += 1; } },
    JSON, Date, Math, Map, Set, WeakMap
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readerSource, context, { filename: 'save_pipeline_shared_work.js' });
  return { core, raw, decodes: () => decodes, warnings: () => warnings };
}

test('optional recent read-cache clone failure never masks authoritative saved data', () => {
  const h = makeHarness();
  const first = h.core.parseTaskPointsStorageJson(h.raw, {});
  assert.equal(first.tasks[0].id, 'saved-task');
  assert.equal(first.completions[0].id, 'saved-completion');
  assert.equal(first.players[0].id, 'saved-player');
  const second = h.core.parseTaskPointsStorageJson(h.raw, {});
  assert.equal(second.tasks[0].id, 'saved-task');
  assert.equal(h.decodes(), 2, 'fallback parses original storage again rather than trusting failed cache');
  assert.equal(h.warnings(), 1, 'clone failure is logged only once');
});

test('optional verified-cache clone failure falls back to authoritative parser', () => {
  const h = makeHarness({ verified: true });
  const state = h.core.parseTaskPointsStorageJson(h.raw, {});
  assert.equal(state.tasks[0].id, 'saved-task');
  assert.equal(state.completions[0].id, 'saved-completion');
  assert.equal(h.decodes(), 1);
});
