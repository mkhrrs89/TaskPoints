from pathlib import Path

path = Path('state_runtime_v2.js')
text = path.read_text()

old_source = r'''  function sourceSubset(state) {
    return {
      habits: Array.isArray(state?.habits) ? state.habits : [],
      completions: Array.isArray(state?.completions) ? state.completions : []
    };
  }
'''
new_source = r'''  // V2's first proving ground owns Habit/Vice completion records only. Keep
  // unrelated task/manual/scoring completion classes in the legacy authority
  // until their own migration phases exist.
  function isPilotCompletion(completion) {
    const source = String(completion?.source || '');
    const habitId = String(completion?.habitId || '').trim();
    return Boolean(habitId) && (source === 'habit' || source === 'vice');
  }

  function pilotCompletions(state) {
    return (Array.isArray(state?.completions) ? state.completions : []).filter(isPilotCompletion);
  }

  function sourceSubset(state) {
    return {
      habits: Array.isArray(state?.habits) ? state.habits : [],
      completions: pilotCompletions(state)
    };
  }
'''
if old_source not in text:
    raise SystemExit('sourceSubset block not found')
text = text.replace(old_source, new_source, 1)

old_seed = '''      const habits = source.state.habits;\n      const completions = source.state.completions;'''
new_seed = '''      const habits = source.state.habits;\n      const completions = pilotCompletions(source.state);'''
if old_seed not in text:
    raise SystemExit('seed collection selection not found')
text = text.replace(old_seed, new_seed, 1)

old_compat = r'''  async function buildCompatibilitySnapshot() {
    if (!isDarkEnabled()) throw new Error('state_runtime_v2_dark_disabled');
    await seedFromLegacy();
    const source = parseLegacyStateWithPending();
    if (source.missing) return {};
    const collections = await readV2Collections();
    return {
      ...source.state,
      habits: collections.habits,
      completions: collections.completions
    };
  }

  // Home renderHabits recomputes exactly these fields for display/sorting.
'''
new_compat = r'''  function completionCompatibilityBase(completion) {
    if (completion?.id != null && String(completion.id) !== '') return `id:${String(completion.id)}`;
    return `pilot:${String(completion?.source || '')}:${String(completion?.habitId || '')}:${String(completion?.dayKey || '')}`;
  }

  function indexPilotCompletionOccurrences(completions) {
    const occurrences = new Map();
    return (Array.isArray(completions) ? completions : [])
      .filter(isPilotCompletion)
      .map((value) => {
        const base = completionCompatibilityBase(value);
        const occurrence = occurrences.get(base) || 0;
        occurrences.set(base, occurrence + 1);
        return { key: `${base}:${occurrence}`, value: clone(value) };
      });
  }

  function mergeCompatibilityCompletions(legacyCompletions, v2Completions) {
    const legacy = Array.isArray(legacyCompletions) ? legacyCompletions : [];
    const v2Indexed = indexPilotCompletionOccurrences(v2Completions);
    const v2ByKey = new Map(v2Indexed.map((row) => [row.key, row.value]));
    const consumed = new Set();
    const legacyOccurrences = new Map();
    const merged = [];

    legacy.forEach((completion) => {
      if (!isPilotCompletion(completion)) {
        merged.push(clone(completion));
        return;
      }
      const base = completionCompatibilityBase(completion);
      const occurrence = legacyOccurrences.get(base) || 0;
      legacyOccurrences.set(base, occurrence + 1);
      const key = `${base}:${occurrence}`;
      if (!v2ByKey.has(key)) return;
      consumed.add(key);
      merged.push(clone(v2ByKey.get(key)));
    });

    // A V2-only pilot completion has no legacy slot yet. Its V2 sequence/order is
    // already newest-first, so prepend it without disturbing the exact relative
    // order of every legacy-only completion class.
    const v2Only = v2Indexed
      .filter((row) => !consumed.has(row.key))
      .map((row) => clone(row.value));
    return [...v2Only, ...merged];
  }

  async function buildCompatibilitySnapshot() {
    if (!isDarkEnabled()) throw new Error('state_runtime_v2_dark_disabled');
    await seedFromLegacy();
    const source = parseLegacyStateWithPending();
    if (source.missing) return {};
    const collections = await readV2Collections();
    return {
      ...source.state,
      habits: collections.habits,
      completions: mergeCompatibilityCompletions(source.state.completions, collections.completions)
    };
  }

  // Home renderHabits recomputes exactly these fields for display/sorting.
'''
if old_compat not in text:
    raise SystemExit('compatibility snapshot block not found')
text = text.replace(old_compat, new_compat, 1)

old_duplicate = r'''  // The first V2 proving ground owns only Habit/Vice completion records. Other
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

'''
if old_duplicate not in text:
    raise SystemExit('later pilot helper block not found')
text = text.replace(old_duplicate, '', 1)

path.write_text(text)
