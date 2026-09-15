from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one target, found {count}')
    p.write_text(text.replace(old, new, 1))


replace_once(
    'tests/flex_action_fast_path_contract.test.js',
    """test('the worker bundles the Flex Action fast path after the home modules', () => {\n  assert.match(workerSource, /'\\/flex_action_fast_path\\.js'/);\n  assert.match(workerSource, /if \\(flexActionFastPathSource\\) sources\\.push\\(flexActionFastPathSource\\)/);\n});\n""",
    """test('the worker bundles the Flex Action fast path after the home modules', () => {\n  assert.match(workerSource, /'\\/home_yesterday_result_consistency\\.js',\\s*'\\/flex_action_fast_path\\.js'/);\n});\n"""
)

replace_once(
    'tests/flex_action_fast_path_contract.test.js',
    """    function renderFlexActions() { metrics.fallbackFlexRenderCalls += 1; }\n    function renderAll() { metrics.fullRenderCalls += 1; }\n""",
    """    function renderFlexActions() { metrics.fallbackFlexRenderCalls += 1; }\n    function moveFlexAction() {}\n    function renderAll() { metrics.fullRenderCalls += 1; }\n"""
)

replace_once(
    'tests/flex_action_fast_path_review_contract.test.js',
    """    function renderFlexActions() {}\n    function renderAll() { renderCount += 1; }\n""",
    """    function renderFlexActions() {}\n    function moveFlexAction() {}\n    function renderAll() { renderCount += 1; }\n"""
)
