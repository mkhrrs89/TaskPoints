const fs = require('fs');
const assert = require('assert');

const routes = JSON.parse(fs.readFileSync('_routes.json', 'utf8'));
const worker = fs.readFileSync('_worker.js', 'utf8');
const bootstrap = fs.readFileSync('score_alias_audit_bootstrap.js', 'utf8');

for (const route of ['/audit', '/audit/', '/audit.html', '/matchups', '/matchups/', '/matchups.html']) {
  assert(routes.include.includes(route), `missing worker route ${route}`);
}

assert(worker.includes("return 'audit'"), 'worker must identify Audit pages');
assert(worker.includes("return 'matchups'"), 'worker must identify Matchups pages');
assert(worker.includes('score_alias_audit_bootstrap.js'), 'Audit bootstrap must be injected');
assert(worker.includes('score_alias_consistency.js?v=20260731-4'), 'alias module must be cache-busted');
assert(bootstrap.includes('audit(?:\\.html)?\\/?$'), 'bootstrap must accept clean and .html Audit paths');
assert(bootstrap.includes('installAuditRepairPanel'), 'bootstrap must invoke the existing repair panel installer');
assert(bootstrap.includes('replaceState'), 'bootstrap must provide compatibility for the legacy installer path check');

console.log('score alias clean Audit path tests passed');
