const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function extractFunction(source, functionName) {
  const signature = `function ${functionName}`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${functionName} not found`);
  const braceStart = source.indexOf('{', start);
  assert.notEqual(braceStart, -1, `${functionName} opening brace not found`);

  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }

  throw new Error(`${functionName} closing brace not found`);
}

function loadHelpers(file, readName, normalizeName, prefix = '') {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const code = [
    prefix,
    extractFunction(source, readName),
    extractFunction(source, normalizeName),
    `module.exports = { read: ${readName}, normalize: ${normalizeName} };`
  ].join('\n');
  const context = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(code, context, { filename: `${file}:${readName}` });
  return context.module.exports;
}

const helperCopies = [
  ['index.html', 'readNotesPayloadFromBackupPayload', 'normalizeNotesPayload'],
  ['settings.html', 'readNotesPayloadFromBackupPayload', 'normalizeNotesPayload'],
  ['toolbar.js', 'readNotesPayloadFromBackupPayloadFallback', 'normalizeNotesPayloadFallback'],
  ['audit.html', 'readNotesPayloadFromBackupPayloadForAudit', 'normalizeNotesPayloadForAudit', 'const NOTES_PAGE_CACHE_KEY_FOR_AUDIT = "taskpoints_notes_v1";']
];

for (const [file, readName, normalizeName, prefix] of helperCopies) {
  test(`${file} notes reader prefers non-empty state.notes over blank aux notes`, () => {
    const { read, normalize } = loadHelpers(file, readName, normalizeName, prefix);
    const backup = {
      exportType: 'taskpoints_full_backup',
      state: { notes: 'real notes from state' },
      aux: { taskpoints_notes_v1: '' }
    };

    assert.equal(normalize(read(backup)), 'real notes from state');
  });

  test(`${file} notes reader preserves true empty backup notes`, () => {
    const { read, normalize } = loadHelpers(file, readName, normalizeName, prefix);
    const backup = {
      exportType: 'taskpoints_full_backup',
      state: { notes: '' },
      aux: { taskpoints_notes_v1: '' }
    };

    assert.equal(normalize(read(backup)), '');
  });

  test(`${file} notes normalization does not JSON-stringify strings`, () => {
    const { read, normalize } = loadHelpers(file, readName, normalizeName, prefix);
    const backup = { state: { notes: 'plain string notes' } };

    assert.equal(normalize(read(backup)), 'plain string notes');
  });
}
