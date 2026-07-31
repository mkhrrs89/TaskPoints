const fs = require('fs');
const assert = require('assert');

const worker = fs.readFileSync('_worker.js', 'utf8');
const routes = JSON.parse(fs.readFileSync('_routes.json', 'utf8'));

assert.match(worker, /pathname === '\/audit\.html'/, 'worker must target Audit directly');
assert.match(worker, /pathname === '\/matchups\.html'/, 'worker must target Matchups directly');
assert.match(worker, /score_alias_consistency\.js\?v=20260730-3/, 'direct page injection must cache-bust the repair module');
assert.match(worker, /new HTMLRewriter\(\)/, 'direct page loading must be injected into the HTML response');
assert.match(worker, /no-cache, no-store, must-revalidate/, 'rewritten HTML must not be served with stale caching headers');
assert.match(worker, /data-taskpoints-score-alias-direct/, 'direct script injection should be identifiable');
assert.ok(routes.include.includes('/audit.html'), 'Audit must be routed through the worker');
assert.ok(routes.include.includes('/matchups.html'), 'Matchups must be routed through the worker');

console.log('direct score-alias page loader contract passed');
