const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const worker = fs.readFileSync(path.join(root, '_worker.js'), 'utf8');
const preservedWorker = fs.readFileSync(path.join(root, '_worker_core.js'), 'utf8');

assert.match(worker, /import baseWorker from '\.\/_worker_core\.js';/);
assert.match(worker, /await baseWorker\.fetch\(request, env, ctx\)/);
assert.match(worker, /url\.pathname !== '\/scoring_core\.js'/);
assert.match(worker, /score_alias_consistency\.js/);
assert.match(worker, /x-taskpoints-score-alias-bundle/);
assert.match(preservedWorker, /url\.pathname !== '\/scoring_core\.js'/);
assert.match(preservedWorker, /phase4_storage_coordinator\.js/);
assert.match(preservedWorker, /phase5b_deferred_mirror\.js/);

console.log('score alias worker bundle contract passed');
