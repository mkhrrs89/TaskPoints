(function (global) {
  'use strict';

  const api = global.TaskPointsBracketBuilder;
  if (!api || api.__reviewFixesApplied) return;

  const originalNormalize = api.normalizeConfig.bind(api);
  const originalValidate = api.validateConfig.bind(api);
  const originalBuild = api.buildConfiguredTournament.bind(api);
  const originalLock = api.lockConfiguredSeasonBracket.bind(api);

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function requestedEntrantCount(config, availableSeeds) {
    const requested = Math.max(2, Math.floor(Number(config?.entrantCount) || 2));
    const available = Array.isArray(availableSeeds) && availableSeeds.length
      ? availableSeeds.length
      : requested;
    return Math.min(requested, Math.max(2, available));
  }

  function normalizeConfig(config, availableSeeds = []) {
    const incoming = clone(config || {});
    const entrantCount = requestedEntrantCount(incoming, availableSeeds);
    const useSeasonTwoPreset = incoming.presetId === api.SEASON_TWO_PRESET_ID && entrantCount >= 60;
    const generated = useSeasonTwoPreset
      ? api.createSeasonTwoPreset(incoming)
      : api.createGenericConfig({ ...incoming, entrantCount });

    const merged = {
      ...incoming,
      ...generated,
      entrantCount: generated.entrantCount
    };

    if (Array.isArray(incoming.rounds) && incoming.rounds.length === generated.rounds.length) {
      merged.rounds = incoming.rounds;
    }

    return originalNormalize(merged, availableSeeds);
  }

  function validateConfig(config, availableSeeds = []) {
    const normalized = normalizeConfig(config, availableSeeds);
    const result = originalValidate(normalized, availableSeeds);
    const errors = Array.isArray(result.errors) ? result.errors.slice() : [];

    if (
      normalized.presetId === api.SEASON_TWO_PRESET_ID
      && (normalized.startDate !== '2026-08-01' || normalized.endDate !== '2026-08-31')
    ) {
      const message = 'The Season 2 preset is only available for the August 1–31, 2026 championship.';
      if (!errors.includes(message)) errors.push(message);
    }

    return {
      ...result,
      ok: errors.length === 0,
      config: normalized,
      errors
    };
  }

  api.normalizeConfig = normalizeConfig;
  api.validateConfig = validateConfig;

  api.buildConfiguredTournament = function buildConfiguredTournament(seeds, config, options = {}) {
    const validation = validateConfig(config, seeds);
    if (!validation.ok) {
      return {
        ok: false,
        config: validation.config,
        errors: validation.errors,
        warnings: validation.warnings || [],
        bracket: null,
        series: {}
      };
    }
    return originalBuild(seeds, validation.config, options);
  };

  api.lockConfiguredSeasonBracket = function lockConfiguredSeasonBracket(state, config, options = {}) {
    const seeds = state?.currentSeason?.seeds || [];
    const validation = validateConfig(config, seeds);
    if (!validation.ok) {
      return {
        ok: false,
        error: 'invalid_config',
        state,
        config: validation.config,
        errors: validation.errors,
        warnings: validation.warnings || []
      };
    }
    return originalLock(state, validation.config, options);
  };

  api.__reviewFixesApplied = true;
  global.TaskPointsBracketBuilderFixes = {
    normalizeConfig,
    validateConfig
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TaskPointsBracketBuilderFixes;
  }
})(typeof window !== 'undefined' ? window : globalThis);
