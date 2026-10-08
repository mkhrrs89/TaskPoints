const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const toolbar = fs.readFileSync(path.join(__dirname, '..', 'toolbar.js'), 'utf8');
const settings = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');

test('shared toolbar import explicitly opens hidden file inputs and requires a committed save', () => {
  assert.match(toolbar, /label\.addEventListener\('click',[\s\S]*?event\.preventDefault\(\);[\s\S]*?input\.click\(\);/);
  assert.match(toolbar, /requireCommitted:\s*true/);
  assert.match(toolbar, /if \(requireCommitted && !result\?\.state\)/);
  assert.match(toolbar, /result\?\.blocked/);
  assert.match(toolbar, /result\?\.skipped \|\| result\?\.blockedByQuotaCircuit/);
});

test('shared toolbar import waits for storage mirrors before reload', () => {
  const applyStart = toolbar.indexOf('async function applyImportedStateFallback');
  const applyEnd = toolbar.indexOf('async function importFileFallback', applyStart);
  const body = toolbar.slice(applyStart, applyEnd);
  assert.match(body, /await flushImportedStatePersistenceFallback\(\);/);
  assert.ok(body.indexOf('await flushImportedStatePersistenceFallback();') < body.indexOf('window.location.reload();'));

  assert.match(toolbar, /await core\.flushPhase4PrimaryWrites\(\);/);
  assert.match(toolbar, /await core\.flushPhase5ANativeSnapshotWrites\(\);/);
});

test('Settings full import cannot report success after a blocked or skipped save', () => {
  assert.match(settings, /async function applyImportedState\(data\)/);
  assert.match(settings, /assertCommittedSettingsImport\(importSaveResult\);/);
  assert.match(settings, /result\.blocked \|\| result\.skipped \|\| result\.blockedByQuotaCircuit/);
  const applyStart = settings.indexOf('async function applyImportedState(data)');
  const applyEnd = settings.indexOf('function isZipFile(file)', applyStart);
  const body = settings.slice(applyStart, applyEnd);
  assert.ok(body.indexOf('await flushSettingsImportPersistence();') < body.indexOf('alert("Import complete!'));
});

test('Settings file imports and merge backup use explicit picker activation and verified persistence', () => {
  assert.match(settings, /bindSettingsFilePicker\('settingsImportInput'\)/);
  assert.match(settings, /bindSettingsFilePicker\('settingsMergeBackupInput'\)/);
  assert.match(settings, /input\.click\(\);/);
  assert.match(settings, /assertCommittedSettingsImport\(mergeSaveResult, "Merge"\);/);

  const mergeStart = settings.indexOf('async function handleMergeBackupFile(ev)');
  const mergeEnd = settings.indexOf('function handleSettingsReset()', mergeStart);
  const body = settings.slice(mergeStart, mergeEnd);
  assert.ok(body.indexOf('await flushSettingsImportPersistence();') < body.indexOf('window.location.reload();'));
});

test('Settings import handlers await async import completion and surface real errors', () => {
  assert.match(settings, /async function handleSettingsFile\(ev\)/);
  assert.match(settings, /await applyImportedState\(parsed\);/);
  assert.match(settings, /async function handleSettingsPaste\(\)/);
  assert.match(settings, /alert\(\`Import failed: \$\{err\?\.message/);
});
