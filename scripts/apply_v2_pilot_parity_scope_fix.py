from pathlib import Path

path = Path('state_runtime_v2.js')
text = path.read_text()

old_projection = r'''  // Home renderHabits recomputes exactly these fields for display/sorting.
  // Exclude them only from parity; stored records and compatibility exports stay intact.
  const DERIVED_HABIT_CACHE_FIELDS = ['__streak', '__completion', '__failedStreak'];
  function paritySubset(state) {
    return {
      habits: (state.habits || []).map((habit) => {
        if (!habit || typeof habit !== 'object') return habit;
        const copy = { ...habit };
        for (const field of DERIVED_HABIT_CACHE_FIELDS) delete copy[field];
        return copy;
      }),
      completions: state.completions || []
    };
  }
'''

new_projection = r'''  // Home renderHabits recomputes exactly these fields for display/sorting.
  // Exclude them only from parity; stored records and compatibility exports stay intact.
  const DERIVED_HABIT_CACHE_FIELDS = ['__streak', '__completion', '__failedStreak'];

  // The first V2 proving ground owns only Habit/Vice completion records. Other
  // completion classes remain legacy-only and must not make dark-mirror parity
  // fail merely because V2 has no mutation hook for them yet.
  function isPilotCompletion(completion) {
    const source = String(completion?.source || '');
    const habitId = String(completion?.habitId || '').trim();
    return Boolean(habitId) && (source === 'habit' || source === 'vice');
  }

  function pilotCompletions(state) {
    return (Array.isArray(state?.completions) ? state.completions : []).filter(isPilotCompletion);
  }

  // Legacy full Habit completions historically may omit completionFraction.
  // Production verification already treats that omission as canonical 1. Keep
  // parity strict for half/custom fractions while honoring the same full-row
  // compatibility semantic. This projection never mutates either data source.
  function normalizePilotCompletionForParity(completion) {
    if (!completion || typeof completion !== 'object') return completion;
    const copy = { ...completion };
    if (copy.completionFraction == null) copy.completionFraction = 1;
    return copy;
  }

  function parityInput(state) {
    return {
      habits: Array.isArray(state?.habits) ? state.habits : [],
      completions: pilotCompletions(state)
    };
  }

  function paritySubset(state) {
    const scoped = parityInput(state);
    return {
      habits: scoped.habits.map((habit) => {
        if (!habit || typeof habit !== 'object') return habit;
        const copy = { ...habit };
        for (const field of DERIVED_HABIT_CACHE_FIELDS) delete copy[field];
        return copy;
      }),
      completions: scoped.completions.map(normalizePilotCompletionForParity)
    };
  }
'''

if old_projection not in text:
    raise SystemExit('V2 parity projection block not found')
text = text.replace(old_projection, new_projection, 1)

old_index = r'''      const index = (rows) => {
        const occurrences = new Map();
        return rows.map((value, position) => {
          const id = value?.id == null ? null : String(value.id);
          const base = id === null ? `missing:${position}` : `id:${id}`;
          const occurrence = occurrences.get(base) || 0;
          occurrences.set(base, occurrence + 1);
          return { key: `${base}:${occurrence}`, id, occurrence, position, value };
        });
      };
'''
new_index = r'''      const index = (rows) => {
        const occurrences = new Map();
        return rows.map((value, position) => {
          const normalizedValue = collection === 'completions'
            ? normalizePilotCompletionForParity(value)
            : value;
          const id = normalizedValue?.id == null ? null : String(normalizedValue.id);
          const base = id === null ? `missing:${position}` : `id:${id}`;
          const occurrence = occurrences.get(base) || 0;
          occurrences.set(base, occurrence + 1);
          return { key: `${base}:${occurrence}`, id, occurrence, position, value: normalizedValue };
        });
      };
'''
if old_index not in text:
    raise SystemExit('V2 parity diagnostic index block not found')
text = text.replace(old_index, new_index, 1)

old_verify = r'''    const collections = await readV2Collections();
    const expected = sourceSubset(source.state);
    const expectedText = stableJson(paritySubset(expected));
    const actualText = stableJson(paritySubset(collections));
    const hasRawDifferences = expectedText !== actualText || stableJson(expected.habits) !== stableJson(collections.habits);
    const diagnostics = hasRawDifferences ? parityDifferences(expected, collections) : null;
    lastParity = {
      checked: true,
      match: expectedText === actualText,
      expectedHash: `${fnv1a(expectedText)}:${expectedText.length}`,
      actualHash: `${fnv1a(actualText)}:${actualText.length}`,
      comparisonScope: 'authoritative_records_excluding_three_home_display_caches',
      ignoredHabitCacheFields: [...DERIVED_HABIT_CACHE_FIELDS],
      ignoredDerivedCacheDifferences: diagnostics?.ignoredDerivedCacheDifferences || null,
      differences: expectedText === actualText ? null : diagnostics,
      expectedCounts: { habits: source.state.habits.length, completions: source.state.completions.length },
      actualCounts: { habits: collections.habits.length, completions: collections.completions.length },
      checkedAtISO: nowIso()
    };
'''
new_verify = r'''    const collections = await readV2Collections();
    const expected = sourceSubset(source.state);
    const expectedScoped = parityInput(expected);
    const actualScoped = parityInput(collections);
    const expectedText = stableJson(paritySubset(expectedScoped));
    const actualText = stableJson(paritySubset(actualScoped));
    const hasRawDifferences = expectedText !== actualText || stableJson(expectedScoped.habits) !== stableJson(actualScoped.habits);
    const diagnostics = hasRawDifferences ? parityDifferences(expectedScoped, actualScoped) : null;
    lastParity = {
      checked: true,
      match: expectedText === actualText,
      expectedHash: `${fnv1a(expectedText)}:${expectedText.length}`,
      actualHash: `${fnv1a(actualText)}:${actualText.length}`,
      comparisonScope: 'habit_records_plus_habit_vice_completions_normalizing_full_fraction',
      ignoredHabitCacheFields: [...DERIVED_HABIT_CACHE_FIELDS],
      ignoredDerivedCacheDifferences: diagnostics?.ignoredDerivedCacheDifferences || null,
      differences: expectedText === actualText ? null : diagnostics,
      expectedCounts: { habits: expectedScoped.habits.length, completions: expectedScoped.completions.length },
      actualCounts: { habits: actualScoped.habits.length, completions: actualScoped.completions.length },
      scopeExcludedCounts: {
        expectedCompletions: Math.max(0, source.state.completions.length - expectedScoped.completions.length),
        actualCompletions: Math.max(0, collections.completions.length - actualScoped.completions.length)
      },
      checkedAtISO: nowIso()
    };
'''
if old_verify not in text:
    raise SystemExit('V2 verifyParity block not found')
text = text.replace(old_verify, new_verify, 1)

path.write_text(text)
