const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const splitSource = fs.readFileSync(path.join(ROOT, 'verified_secondary_lock_split.js'), 'utf8');
const restoreHtml = fs.readFileSync(path.join(ROOT, 'verified_secondary_restore.html'), 'utf8');
const normalGuardSource = fs.readFileSync(path.join(ROOT, 'home_yesterday_result_consistency.js'), 'utf8');

const COMMITTED_KEY = 'taskpoints_recovery_write_lock_v1';
const ATTEMPT_KEY = 'taskpoints_recovery_attempt_lock_v1';

class FakeStorage {
  constructor(initial = {}) {
    this.rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

function lock(token, committedAtMs = 0, extra = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    active: true,
    token,
    createdAtMs: String(Date.now()),
    committedAtMs: String(committedAtMs).padStart(13, '0'),
    ...extra
  });
}

function install(initial = {}) {
  const storage = new FakeStorage(initial);
  const context = { localStorage: storage, Storage: FakeStorage, JSON, Number, String, Object, Date, Error };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(splitSource, context, { filename: 'verified_secondary_lock_split.js' });
  return storage;
}

test('restore loads the lock splitter before ownership enforcement and runtime', () => {
  assert.doesNotThrow(() => new vm.Script(splitSource));
  const splitAt = restoreHtml.indexOf('<script src="verified_secondary_lock_split.js" defer></script>');
  const guardAt = restoreHtml.indexOf('<script src="verified_secondary_restore_lock_guard.js" defer></script>');
  const runtimeAt = restoreHtml.indexOf('<script src="verified_secondary_restore.js" defer></script>');
  assert.ok(splitAt >= 0 && guardAt > splitAt && runtimeAt > guardAt);
});

test('a new attempt never overwrites or removes the prior committed recovery lock', () => {
  const priorCommitted = lock('committed-old', 1700000000000);
  const storage = install({ [COMMITTED_KEY]: priorCommitted });

  const attempt = lock('attempt-new', 0);
  storage.setItem(COMMITTED_KEY, attempt);
  assert.equal(storage.rows.get(COMMITTED_KEY), priorCommitted);
  assert.equal(storage.rows.get(ATTEMPT_KEY), attempt);
  assert.equal(storage.getItem(COMMITTED_KEY), attempt);

  storage.removeItem(COMMITTED_KEY);
  assert.equal(storage.rows.has(ATTEMPT_KEY), false);
  assert.equal(storage.rows.get(COMMITTED_KEY), priorCommitted);
  assert.equal(storage.getItem(COMMITTED_KEY), priorCommitted);
});

test('only a successfully finalized attempt replaces the committed generation', () => {
  const priorCommitted = lock('committed-old', 1700000000000);
  const storage = install({ [COMMITTED_KEY]: priorCommitted });

  storage.setItem(COMMITTED_KEY, lock('attempt-new', 0));
  const finalized = lock('attempt-new', 1800000000000);
  storage.setItem(COMMITTED_KEY, finalized);
  assert.equal(storage.rows.get(COMMITTED_KEY), finalized);
  assert.equal(storage.rows.has(ATTEMPT_KEY), false);
  assert.equal(storage.getItem(COMMITTED_KEY), finalized);
});

test('a retained or competing attempt cannot be replaced by a new manual restore token', () => {
  const retained = lock('retained-old', 0, { retainUntilManualRecovery: true });
  const storage = install({ [ATTEMPT_KEY]: retained });
  assert.throws(
    () => storage.setItem(COMMITTED_KEY, lock('attempt-new', 0)),
    (error) => error?.code === 'TASKPOINTS_RETAINED_RECOVERY_ATTEMPT_EXISTS'
  );
  assert.equal(storage.rows.get(ATTEMPT_KEY), retained);

  const owningUpdate = lock('retained-old', 0, { retainUntilManualRecovery: true, writeBoundaryEnteredAtISO: 'now' });
  storage.setItem(COMMITTED_KEY, owningUpdate);
  assert.equal(storage.rows.get(ATTEMPT_KEY), owningUpdate);
});

test('normal TaskPoints tabs block the save and both journals while an attempt lock exists', () => {
  assert.doesNotThrow(() => new vm.Script(normalGuardSource));
  assert.match(normalGuardSource, /installTaskPointsRecoveryAttemptWriteLockGuard/);
  assert.match(normalGuardSource, /taskpoints_recovery_attempt_lock_v1/);
  assert.match(normalGuardSource, /const ATTEMPT_TTL_MS = 2 \* 60 \* 1000/);
  assert.match(normalGuardSource, /const PROTECTED_KEYS = new Set\(\[STORAGE_KEY, HABIT_JOURNAL_KEY, LEGACY_JOURNAL_KEY\]\)/);
  assert.match(normalGuardSource, /assertAttemptAllowsWrite\(key, 'setItem'\)/);
  assert.match(normalGuardSource, /assertAttemptAllowsWrite\(key, 'removeItem'\)/);
  assert.match(normalGuardSource, /TASKPOINTS_RECOVERY_ATTEMPT_WRITE_LOCKED/);
  assert.match(normalGuardSource, /storage\.removeItem\(ATTEMPT_LOCK_KEY\)/);
});

test('splitter routes uncommitted and committed records to different physical keys', () => {
  assert.match(splitSource, /const COMMITTED_LOCK_KEY = 'taskpoints_recovery_write_lock_v1'/);
  assert.match(splitSource, /const ATTEMPT_LOCK_KEY = 'taskpoints_recovery_attempt_lock_v1'/);
  assert.match(splitSource, /assertAttemptMayBeWritten/);
  assert.match(splitSource, /return priorSet\(ATTEMPT_LOCK_KEY, value\)/);
  assert.match(splitSource, /const result = priorSet\(COMMITTED_LOCK_KEY, value\)/);
  assert.match(splitSource, /priorRemove\(ATTEMPT_LOCK_KEY\)/);
});
