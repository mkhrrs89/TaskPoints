from pathlib import Path

page = Path('state_v2_trace_review.html')
text = page.read_text()
text = text.replace(
    '<script src="/state_runtime_v2_trace_review.js"></script>',
    '<script src="/state_runtime_v2_trace_review.js?v=20260915-1"></script>',
    1,
)
old_metrics = """      verdict('Interaction postponement observed', review.interactionPreemptionObserved, true),
      verdict('V2 data matches legacy data', review.parity?.matchConfirmed === true),
      verdict('No V2 failures observed', review.failures?.noV2FailuresObserved === true),"""
new_metrics = """      verdict('Interaction postponement observed', review.interactionPreemptionObserved, true),
      verdict('V2 stores only Habit/Vice pilot completions', review.pilotOwnership?.v2StoreContainsOnlyPilotCompletions === true),
      verdict('V2 data matches legacy data', review.parity?.matchConfirmed === true),
      verdict('No V2 failures observed', review.failures?.noV2FailuresObserved === true),"""
if old_metrics not in text:
    raise SystemExit('offline trace ownership metric insertion target not found')
text = text.replace(old_metrics, new_metrics, 1)
old_detail = """      `<div class="metric"><strong>Deep quiet target</strong><span>${esc(review.maintenance?.deepQuietMs ?? 'unknown')} ms</span></div>`,
      `<div class="metric"><strong>Foreground windows correlated</strong><span>${esc(correlationText)}</span></div>`,"""
new_detail = """      `<div class="metric"><strong>Deep quiet target</strong><span>${esc(review.maintenance?.deepQuietMs ?? 'unknown')} ms</span></div>`,
      `<div class="metric"><strong>Pilot parity scope</strong><span>${esc(review.pilotOwnership?.comparisonScope ?? 'not observed')}</span></div>`,
      `<div class="metric"><strong>Legacy-only completions outside pilot</strong><span>${esc(review.pilotOwnership?.expectedExcludedCompletions ?? 'unknown')}</span></div>`,
      `<div class="metric"><strong>Out-of-scope completions physically in V2</strong><span>${esc(review.pilotOwnership?.actualExcludedCompletions ?? 'unknown')}</span></div>`,
      `<div class="metric"><strong>Foreground windows correlated</strong><span>${esc(correlationText)}</span></div>`,"""
if old_detail not in text:
    raise SystemExit('offline trace ownership detail insertion target not found')
text = text.replace(old_detail, new_detail, 1)
old_note = "This reviewer summarizes trace evidence only. The tester still has to confirm the trace came from the intended physical iPhone/PWA scenario. Foreground correlation starts at the latest recorded interaction before each V2 enqueue."
new_note = "This reviewer summarizes trace evidence only. The tester still has to confirm the trace came from the intended physical iPhone/PWA scenario. Pilot ownership is a separate gate from parity: a pilot-scoped match does not pass if out-of-scope completion rows are physically present in V2. Foreground correlation starts at the latest recorded interaction before each V2 enqueue."
if old_note not in text:
    raise SystemExit('offline trace device note target not found')
text = text.replace(old_note, new_note, 1)
page.write_text(text)

test_path = Path('tests/state_runtime_v2_trace_review_page_contract.test.js')
test = test_path.read_text()
test = test.replace(
    r'assert.match(source, /<script src="\/state_runtime_v2_trace_review\.js"><\/script>/);',
    r'assert.match(source, /<script src="\/state_runtime_v2_trace_review\.js\?v=20260915-1"><\/script>/);',
    1,
)
old_checks = """  assert.match(source, /Interaction postponement observed/);
  assert.match(source, /Automatic parity crossed deep-idle gate/);
  assert.match(source, /Foreground windows correlated/);"""
new_checks = """  assert.match(source, /Interaction postponement observed/);
  assert.match(source, /Automatic parity crossed deep-idle gate/);
  assert.match(source, /V2 stores only Habit\/Vice pilot completions/);
  assert.match(source, /pilotOwnership\?\.v2StoreContainsOnlyPilotCompletions/);
  assert.match(source, /Out-of-scope completions physically in V2/);
  assert.match(source, /expectedExcludedCompletions/);
  assert.match(source, /actualExcludedCompletions/);
  assert.match(source, /Foreground windows correlated/);"""
if old_checks not in test:
    raise SystemExit('offline trace page contract insertion target not found')
test = test.replace(old_checks, new_checks, 1)
test_path.write_text(test)
