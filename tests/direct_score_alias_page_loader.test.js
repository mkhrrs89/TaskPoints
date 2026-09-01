const fs = require('fs');
const assert = require('assert');

const worker = fs.readFileSync('_worker.js', 'utf8');
const routes = JSON.parse(fs.readFileSync('_routes.json', 'utf8'));

const helperMatch = worker.match(/function directAliasPageKind\(pathname\) \{([\s\S]*?)\n\}/);
assert.ok(helperMatch, 'worker must define the direct Audit/Matchups page classifier');
const directAliasPageKind = new Function('pathname', helperMatch[1]);
assert.equal(directAliasPageKind('/audit'), 'audit', 'worker must target extensionless Audit directly');
assert.equal(directAliasPageKind('/audit.html'), 'audit', 'worker must target Audit HTML directly');
assert.equal(directAliasPageKind('/matchups'), 'matchups', 'worker must target extensionless Matchups directly');
assert.equal(directAliasPageKind('/matchups.html'), 'matchups', 'worker must target Matchups HTML directly');
assert.equal(directAliasPageKind('/other.html'), '', 'unrelated pages must not receive the direct alias loader');

assert.match(worker, /score_alias_consistency\.js\?v=\d{8}-\d+/, 'direct page injection must cache-bust the repair module');
assert.match(worker, /new HTMLRewriter\(\)/, 'direct page loading must be injected into the HTML response');
assert.match(worker, /no-cache, no-store, must-revalidate/, 'rewritten HTML must not be served with stale caching headers');
assert.match(worker, /data-taskpoints-score-alias-direct/, 'direct script injection should be identifiable');
assert.ok(routes.include.includes('/audit.html'), 'Audit must be routed through the worker');
assert.ok(routes.include.includes('/matchups.html'), 'Matchups must be routed through the worker');

console.log('direct score-alias page loader contract passed');
