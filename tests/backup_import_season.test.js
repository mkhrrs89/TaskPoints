const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
const storage = new Map();
global.localStorage = {
  getItem: (key) => storage.has(String(key)) ? storage.get(String(key)) : null,
  setItem: (key, value) => { storage.set(String(key), String(value)); },
  removeItem: (key) => { storage.delete(String(key)); },
  key: (index) => Array.from(storage.keys())[index] || null,
  get length() { return storage.size; }
};
require('../scoring_core.js');

const core = global.TaskPointsCore;

function makeSeasonState(extra = {}) {
  return {
    tasks: [{ id: 'task_1', title: 'Daily task', points: 5 }],
    completions: [{ id: 'comp_1', taskId: 'task_1', completedAtISO: '2026-06-07T12:00:00.000Z', points: 5 }],
    currentSeason: {
      id: 'season_1_june_2026',
      name: 'June 2026 Season Championship',
      monthKey: '2026-06',
      status: 'active',
      series: { finals: { id: 'finals', winsA: 1, winsB: 0 } }
    },
    latestSeasonId: 'season_1_june_2026',
    seasonHistory: [],
    playerBadges: { YOU: [{ id: 'badge_1' }] },
    liveDiffHistory: { NPC1: [{ dateKey: '2026-06-06', value: 3 }] },
    liveDiffSnapshots: { NPC1: { value: 4 } },
    opponentDripSchedules: [{ id: 'drip_1', playerId: 'NPC1', date: '2026-06-07', points: 12 }],
    workHistory: [{ id: 'work_1', dateKey: '2026-06-07', hours: 2 }],
    futureTopLevelField: { ok: true },
    ...extra
  };
}

function assertSeasonPreserved(imported) {
  assert.equal(imported.currentSeason.id, 'season_1_june_2026');
  assert.equal(imported.latestSeasonId, 'season_1_june_2026');
  assert.deepEqual(imported.seasonHistory, []);
}

test('JSON full backup import preserves season championship fields', () => {
  const backup = {
    exportType: 'taskpoints_full_backup',
    version: 2,
    exportedAtISO: '2026-06-07T12:00:00.000Z',
    state: makeSeasonState(),
    aux: {}
  };

  const imported = core.normalizeImportedFullBackupState(backup, {});

  assertSeasonPreserved(imported);
});

test('direct old-format state import preserves season championship fields', () => {
  const imported = core.normalizeImportedFullBackupState(makeSeasonState(), {});

  assertSeasonPreserved(imported);
});

test('toolbar fallback import normalization path preserves season championship fields', () => {
  const toolbarFallbackEquivalent = (root, currentState = {}) => core.normalizeImportedFullBackupState(root, currentState);

  const imported = toolbarFallbackEquivalent(makeSeasonState(), { reminders: [{ id: 'existing-reminder' }] });

  assertSeasonPreserved(imported);
});

test('settings import normalization path preserves season championship fields', () => {
  const normalizeSettingsImportEquivalent = (root, currentState = {}) => core.normalizeImportedFullBackupState(root, currentState);

  const imported = normalizeSettingsImportEquivalent(makeSeasonState(), {});

  assertSeasonPreserved(imported);
});

test('full backup import preserves durable and future top-level fields', () => {
  const imported = core.normalizeImportedFullBackupState(makeSeasonState(), {});

  assertSeasonPreserved(imported);
  assert.deepEqual(imported.playerBadges, { YOU: [{ id: 'badge_1' }] });
  assert.deepEqual(imported.liveDiffHistory, { NPC1: [{ dateKey: '2026-06-06', value: 3 }] });
  assert.deepEqual(imported.liveDiffSnapshots, { NPC1: { value: 4 } });
  assert.deepEqual(imported.opponentDripSchedules, [{ id: 'drip_1', playerId: 'NPC1', date: '2026-06-07', points: 12 }]);
  assert.deepEqual(imported.workHistory, [{ id: 'work_1', dateKey: '2026-06-07', hours: 2 }]);
  assert.deepEqual(imported.futureTopLevelField, { ok: true });
});

function normalizeSettingsImportForReminderChoice(root, currentState, { preserveMissingReminders = false } = {}) {
  const normalized = core.normalizeImportedFullBackupState(root, currentState, {
    preserveMissingReminders: false,
    preserveMissingProjects: false
  });
  const currentReminderCount = Array.isArray(currentState.reminders) ? currentState.reminders.length : 0;
  const hasImportedReminders = Array.isArray(root.reminders);
  const shouldPreserveReminders = currentReminderCount > 0 && !hasImportedReminders && preserveMissingReminders;
  if (shouldPreserveReminders) normalized.reminders = Array.isArray(currentState.reminders) ? currentState.reminders : [];
  return normalized;
}

test('settings import with missing reminders can clear existing reminders', () => {
  const currentState = { reminders: [{ id: 'current-reminder', text: 'Keep only if user cancels replace' }] };
  const importedRoot = makeSeasonState();
  delete importedRoot.reminders;

  const imported = normalizeSettingsImportForReminderChoice(importedRoot, currentState, { preserveMissingReminders: false });

  assert.deepEqual(imported.reminders, []);
  assertSeasonPreserved(imported);
});

test('settings import with missing reminders can preserve existing reminders', () => {
  const currentState = { reminders: [{ id: 'current-reminder', text: 'Preserve me' }] };
  const importedRoot = makeSeasonState();
  delete importedRoot.reminders;

  const imported = normalizeSettingsImportForReminderChoice(importedRoot, currentState, { preserveMissingReminders: true });

  assert.deepEqual(imported.reminders, currentState.reminders);
  assertSeasonPreserved(imported);
});

test('settings import with explicit reminders uses backup reminders', () => {
  const currentState = { reminders: [{ id: 'current-reminder', text: 'Do not keep me' }] };
  const backupReminders = [{ id: 'backup-reminder', text: 'Use me' }];
  const importedRoot = makeSeasonState({ reminders: backupReminders });

  const imported = normalizeSettingsImportForReminderChoice(importedRoot, currentState, { preserveMissingReminders: true });

  assert.deepEqual(imported.reminders, backupReminders);
  assertSeasonPreserved(imported);
});

test('settings import with explicit empty reminders uses backup empty reminders', () => {
  const currentState = { reminders: [{ id: 'current-reminder', text: 'Do not keep me' }] };
  const importedRoot = makeSeasonState({ reminders: [] });

  const imported = normalizeSettingsImportForReminderChoice(importedRoot, currentState, { preserveMissingReminders: true });

  assert.deepEqual(imported.reminders, []);
  assertSeasonPreserved(imported);
});

test('settings import preserves season data whether reminders are missing or present', () => {
  const currentState = { reminders: [{ id: 'current-reminder', text: 'Existing' }] };
  const missingReminderRoot = makeSeasonState();
  delete missingReminderRoot.reminders;
  const explicitReminderRoot = makeSeasonState({ reminders: [{ id: 'backup-reminder', text: 'Backup' }] });

  const missingReminderImport = normalizeSettingsImportForReminderChoice(missingReminderRoot, currentState, { preserveMissingReminders: false });
  const explicitReminderImport = normalizeSettingsImportForReminderChoice(explicitReminderRoot, currentState, { preserveMissingReminders: false });

  assertSeasonPreserved(missingReminderImport);
  assertSeasonPreserved(explicitReminderImport);
});
