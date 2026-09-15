from pathlib import Path

module_path = Path('task_create_fast_path.js')
module = module_path.read_text()
old_now = "const now = () => Number(global.performance?.now?.() || Date.now());"
new_now = "const now = () => Number(global.performance?.now?.() ?? Date.now());"
if old_now not in module:
    raise SystemExit('Inbox population timer helper target not found')
module = module.replace(old_now, new_now, 1)
module_path.write_text(module)

test_path = Path('tests/inbox_mutation_journal_fast_path.test.js')
test = test_path.read_text()

test = test.replace(
    "assert.equal(result.encoding, 'inbox-journal-v1');",
    "assert.equal(result.encoding, 'inbox-journal-v2');",
    1,
)

test = test.replace(
    "assert.deepEqual(stored.inboxProcessedEventIds, pending.inboxProcessedEventIds);",
    "assert.deepEqual(JSON.parse(JSON.stringify(stored.inboxProcessedEventIds)), { 'old-event': true, 'pending-event': true });",
    1,
)

test = test.replace(
    "assert.deepEqual(effective.inboxProcessedEventIds, { 'old-event': true });",
    "assert.deepEqual(JSON.parse(JSON.stringify(effective.inboxProcessedEventIds)), { 'old-event': true });",
    1,
)

test = test.replace(
    "assert.deepEqual(h.core.readTaskPointsStoredState().inboxProcessedEventIds, { 'old-event': true });",
    "assert.deepEqual(JSON.parse(JSON.stringify(h.core.readTaskPointsStoredState().inboxProcessedEventIds)), { 'old-event': true });",
    1,
)

test_path.write_text(test)
