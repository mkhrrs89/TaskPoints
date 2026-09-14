const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CORE_SOURCE = fs.readFileSync(path.join(ROOT, 'scoring_core.js'), 'utf8');
const SETTINGS_SOURCE = fs.readFileSync(path.join(ROOT, 'settings.html'), 'utf8');

function extractSafeReplaceSource() {
  const start = CORE_SOURCE.indexOf('function safeReplaceTaskPointsStorage');
  const end = CORE_SOURCE.indexOf('function runPendingInteractiveRecompress', start);
  assert.ok(start >= 0, 'safeReplaceTaskPointsStorage must exist');
  assert.ok(end > start, 'safeReplaceTaskPointsStorage source must be bounded by the next function');
  return CORE_SOURCE.slice(start, end);
}

function buildSafeReplace(localStorage) {
  const source = extractSafeReplaceSource();
  return Function('localStorage', `${source}; return safeReplaceTaskPointsStorage;`)(localStorage);
}

test('normal authoritative replacement never removes taskpoints_v1 first', () => {
  const source = extractSafeReplaceSource();
  assert.doesNotMatch(
    source,
    /removeItem\s*\(/,
    'the core replacement primitive must never physically delete the authoritative key before replacement'
  );
  assert.match(source, /localStorage\.setItem\(storageKey, serializedCandidate\)/);

  const rows = new Map([['taskpoints_v1', 'a much larger old authoritative snapshot']]);
  let removals = 0;
  const storage = {
    getItem(key) {
      return rows.has(String(key)) ? rows.get(String(key)) : null;
    },
    setItem(key, value) {
      rows.set(String(key), String(value));
    },
    removeItem(key) {
      removals += 1;
      rows.delete(String(key));
    }
  };

  buildSafeReplace(storage)('taskpoints_v1', 'small replacement');

  assert.equal(rows.get('taskpoints_v1'), 'small replacement');
  assert.equal(removals, 0);
});

test('failed authoritative replacement leaves the previous raw physically present', () => {
  const oldRaw = 'the old authoritative state that must survive';
  const rows = new Map([['taskpoints_v1', oldRaw]]);
  let removals = 0;
  const storage = {
    getItem(key) {
      return rows.has(String(key)) ? rows.get(String(key)) : null;
    },
    setItem(key, value) {
      if (String(key) === 'taskpoints_v1' && String(value) === 'candidate') {
        const error = new Error('simulated iOS storage failure');
        error.name = 'QuotaExceededError';
        throw error;
      }
      rows.set(String(key), String(value));
    },
    removeItem(key) {
      removals += 1;
      rows.delete(String(key));
    }
  };

  const safeReplace = buildSafeReplace(storage);
  assert.throws(
    () => safeReplace('taskpoints_v1', 'candidate'),
    /simulated iOS storage failure/
  );

  assert.equal(rows.get('taskpoints_v1'), oldRaw);
  assert.equal(removals, 0, 'failed normal replacement must perform zero physical removals');
});

test('Settings optimization and rollback never delete before replacing taskpoints_v1', () => {
  assert.doesNotMatch(
    SETTINGS_SOURCE,
    /localStorage\.removeItem\(storageKey\);\s*localStorage\.setItem\(storageKey, plan\.chosenRaw\)/,
    'optimized settings rewrite must directly replace the existing key'
  );
  assert.doesNotMatch(
    SETTINGS_SOURCE,
    /localStorage\.removeItem\(storageKey\);\s*localStorage\.setItem\(storageKey, oldRaw\)/,
    'settings rollback must not create a second delete-before-write window'
  );
});
