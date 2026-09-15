from pathlib import Path

runtime = Path('state_runtime_v2_trace_review.js')
text = runtime.read_text()

old_parity = '''  function parityEvidence(events, status) {
    const checks = events.filter((event) => event.name === 'stateV2.parityChecked').map(detailObject);
    const last = status?.lastParity;
    if (last?.checked === true) checks.push(last);
    const mismatches = checks.filter((check) => check.match === false);
    return {
      observed: checks.some((check) => check.checked === true),
      mismatchObserved: mismatches.length > 0,
      matchConfirmed: checks.some((check) => check.checked === true && check.match === true) && mismatches.length === 0,
      lastCheck: last || checks[checks.length - 1] || null
    };
  }
'''
new_parity = '''  function parityEvidence(events, status) {
    const checks = events.filter((event) => event.name === 'stateV2.parityChecked').map(detailObject);
    const last = status?.lastParity;
    if (last?.checked === true) checks.push(last);
    const mismatches = checks.filter((check) => check.match === false);
    return {
      observed: checks.some((check) => check.checked === true),
      mismatchObserved: mismatches.length > 0,
      matchConfirmed: checks.some((check) => check.checked === true && check.match === true) && mismatches.length === 0,
      lastCheck: last || checks[checks.length - 1] || null
    };
  }

  const PILOT_PARITY_SCOPE = 'habit_records_plus_habit_vice_completions_normalizing_full_fraction';

  function pilotOwnershipEvidence(parity) {
    const last = parity?.lastCheck;
    const comparisonScope = typeof last?.comparisonScope === 'string' ? last.comparisonScope : null;
    const expectedExcludedCompletions = finiteNumber(last?.scopeExcludedCounts?.expectedCompletions);
    const actualExcludedCompletions = finiteNumber(last?.scopeExcludedCounts?.actualCompletions);
    const observed = last?.checked === true && comparisonScope === PILOT_PARITY_SCOPE;
    return {
      observed,
      comparisonScope,
      expectedExcludedCompletions,
      actualExcludedCompletions,
      v2StoreContainsOnlyPilotCompletions: observed && actualExcludedCompletions === 0
    };
  }
'''
if old_parity not in text:
    raise SystemExit('parityEvidence block not found')
text = text.replace(old_parity, new_parity, 1)

old_review = '''    const parity = parityEvidence(events, status);
    const failures = failureEvidence(events, status, mutationClasses, parity);'''
new_review = '''    const parity = parityEvidence(events, status);
    const pilotOwnership = pilotOwnershipEvidence(parity);
    const failures = failureEvidence(events, status, mutationClasses, parity);'''
if old_review not in text:
    raise SystemExit('review parity block not found')
text = text.replace(old_review, new_review, 1)

old_return = '''      failures,
      parity,
      noDirectForegroundMaintenanceObserved,'''
new_return = '''      failures,
      parity,
      pilotOwnership,
      noDirectForegroundMaintenanceObserved,'''
if old_return not in text:
    raise SystemExit('review return parity block not found')
text = text.replace(old_return, new_return, 1)

old_accept = '''        && preemption.observed
        && failures.noV2FailuresObserved
        && parity.matchConfirmed,'''
new_accept = '''        && preemption.observed
        && failures.noV2FailuresObserved
        && parity.matchConfirmed
        && pilotOwnership.v2StoreContainsOnlyPilotCompletions,'''
if old_accept not in text:
    raise SystemExit('device evidence acceptance block not found')
text = text.replace(old_accept, new_accept, 1)
runtime.write_text(text)

test_path = Path('tests/state_runtime_v2_trace_review_contract.test.js')
test = test_path.read_text()
old_base = "      lastParity: { checked: true, match: true },"
new_base = "      lastParity: { checked: true, match: true, comparisonScope: 'habit_records_plus_habit_vice_completions_normalizing_full_fraction', scopeExcludedCounts: { expectedCompletions: 7, actualCompletions: 0 } },"
if old_base not in test:
    raise SystemExit('trace review base parity fixture not found')
test = test.replace(old_base, new_base, 1)

old_assert = '''  assert.equal(result.failures.noV2FailuresObserved, true);
  assert.equal(result.evidenceCompleteForDeviceTrace, true);'''
new_assert = '''  assert.equal(result.failures.noV2FailuresObserved, true);
  assert.equal(result.pilotOwnership.observed, true);
  assert.equal(result.pilotOwnership.expectedExcludedCompletions, 7);
  assert.equal(result.pilotOwnership.actualExcludedCompletions, 0);
  assert.equal(result.pilotOwnership.v2StoreContainsOnlyPilotCompletions, true);
  assert.equal(result.evidenceCompleteForDeviceTrace, true);'''
if old_assert not in test:
    raise SystemExit('primary trace review assertion block not found')
test = test.replace(old_assert, new_assert, 1)

anchor = '''test('internal dark-mirror commit marks complete mutation evidence when public apply wrappers are bypassed', () => {'''
new_tests = '''test('device evidence stays incomplete when pilot ownership diagnostics are absent', () => {
  const report = baseReport();
  report.stateRuntimeV2Status.lastParity = { checked: true, match: true };
  const result = reviewer.review(report);

  assert.equal(result.parity.matchConfirmed, true);
  assert.equal(result.pilotOwnership.observed, false);
  assert.equal(result.pilotOwnership.v2StoreContainsOnlyPilotCompletions, false);
  assert.equal(result.evidenceCompleteForDeviceTrace, false);
});

test('device evidence fails closed if non-pilot completions are physically present in V2', () => {
  const report = baseReport();
  report.stateRuntimeV2Status.lastParity.scopeExcludedCounts.actualCompletions = 2;
  const result = reviewer.review(report);

  assert.equal(result.parity.matchConfirmed, true, 'pilot-scoped parity can still match while out-of-scope rows exist');
  assert.equal(result.pilotOwnership.observed, true);
  assert.equal(result.pilotOwnership.actualExcludedCompletions, 2);
  assert.equal(result.pilotOwnership.v2StoreContainsOnlyPilotCompletions, false);
  assert.equal(result.evidenceCompleteForDeviceTrace, false);
});

test('legacy-only completions may exist outside the pilot without blocking ownership evidence', () => {
  const report = baseReport();
  report.stateRuntimeV2Status.lastParity.scopeExcludedCounts.expectedCompletions = 19;
  report.stateRuntimeV2Status.lastParity.scopeExcludedCounts.actualCompletions = 0;
  const result = reviewer.review(report);

  assert.equal(result.pilotOwnership.expectedExcludedCompletions, 19);
  assert.equal(result.pilotOwnership.actualExcludedCompletions, 0);
  assert.equal(result.pilotOwnership.v2StoreContainsOnlyPilotCompletions, true);
  assert.equal(result.evidenceCompleteForDeviceTrace, true);
});

'''
if anchor not in test:
    raise SystemExit('trace review test insertion anchor not found')
test = test.replace(anchor, new_tests + anchor, 1)
test_path.write_text(test)
