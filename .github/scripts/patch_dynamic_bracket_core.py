from pathlib import Path


def replace_once(path, old, new, label):
    text = path.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    path.write_text(text.replace(old, new, 1), encoding='utf-8')

core = Path('season_bracket_builder_core.js')
replace_once(core,
"    let normalized = incoming.presetId === SEASON_TWO_PRESET_ID && entrantCount >= 60\n      ? { ...createSeasonTwoPreset(incoming), ...incoming, entrantCount: 60 }\n      : { ...createGenericConfig({ ...incoming, entrantCount }), ...incoming, entrantCount };\n",
"    const generated = incoming.presetId === SEASON_TWO_PRESET_ID && entrantCount >= 60\n      ? createSeasonTwoPreset(incoming)\n      : createGenericConfig({ ...incoming, entrantCount });\n    let normalized = { ...incoming, ...generated, entrantCount: generated.entrantCount };\n",
'fresh derived structure fields')
replace_once(core,
"    if (normalized.presetId === SEASON_TWO_PRESET_ID && normalized.entrantCount !== 60) errors.push('The Season 2 preset requires exactly 60 entrants.');\n",
"    if (normalized.presetId === SEASON_TWO_PRESET_ID && normalized.entrantCount !== 60) errors.push('The Season 2 preset requires exactly 60 entrants.');\n    if (normalized.presetId === SEASON_TWO_PRESET_ID && (normalized.startDate !== '2026-08-01' || normalized.endDate !== '2026-08-31')) {\n      errors.push('The Season 2 preset is only available for the August 1–31, 2026 championship.');\n    }\n",
'restrict Season 2 preset dates')

ui = Path('season_bracket_builder.js')
replace_once(ui,
"${totalSeeds < 60 ? 'disabled' : ''}>Season 2: 60 → 48 → 32",
"${totalSeeds < 60 || !isSeasonTwo(season) ? 'disabled' : ''}>Season 2: 60 → 48 → 32",
'disable preset outside Season 2')
replace_once(ui,
"      if (season.seeds.length < 60) {\n        global.alert?.('The Season 2 preset requires 60 locked seeds.');\n",
"      if (season.seeds.length < 60 || !isSeasonTwo(season)) {\n        global.alert?.('The Season 2 preset requires 60 locked seeds in the August 2026 Season 2 preview.');\n",
'guard preset outside Season 2')

entry = Path('season_bracket_builder_entry.js')
replace_once(entry,
"      existing.dataset.seasonAction = 'open-bracket-builder';\n      existing.textContent = season.bracketConfig ? 'Continue Building Bracket' : 'Build Bracket';\n      existing.disabled = !Array.isArray(season.seeds) || season.seeds.length < 2;\n",
"      if (existing.dataset.seasonAction !== 'open-bracket-builder') existing.dataset.seasonAction = 'open-bracket-builder';\n      const label = season.bracketConfig ? 'Continue Building Bracket' : 'Build Bracket';\n      if (existing.textContent !== label) existing.textContent = label;\n      existing.disabled = !Array.isArray(season.seeds) || season.seeds.length < 2;\n",
'avoid observer text churn')

tests = Path('tests/season_bracket_builder.test.js')
text = tests.read_text(encoding='utf-8')
append = """

test('changing entrant count recomputes all derived bracket structure fields', () => {
  const original = builder.createGenericConfig({ entrantCount: 60, startDate: '2026-08-01', endDate: '2026-08-31' });
  const changed = builder.normalizeConfig({ ...original, entrantCount: 48 }, seeds(60));
  assert.equal(changed.mainBracketSize, 32);
  assert.equal(changed.preliminarySeries, 16);
  assert.equal(changed.directByes, 16);
});

test('Season 2 preset cannot be applied to another season month', () => {
  const config = builder.createSeasonTwoPreset({ startDate: '2026-09-01', endDate: '2026-09-30' });
  const result = builder.validateConfig(config, seeds(60));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /only available for the August 1–31, 2026 championship/);
});
"""
if "changing entrant count recomputes" not in text:
    tests.write_text(text.rstrip() + append, encoding='utf-8')
