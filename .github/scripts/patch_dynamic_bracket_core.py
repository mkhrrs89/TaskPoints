from pathlib import Path

path = Path('scoring_core.js')
text = path.read_text(encoding='utf-8')


def replace_once(old, new, label):
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, found {count}')
    text = text.replace(old, new, 1)

replace_once(
"  const OFFICIAL_SEASON_ROUND_ORDER = ['play_in', 'round_of_32', 'sweet_16', 'quarterfinals', 'semifinals', 'finals'];\n",
"  const OFFICIAL_SEASON_ROUND_ORDER = ['play_in', 'round_of_32', 'sweet_16', 'quarterfinals', 'semifinals', 'finals'];\n\n  function getSeasonRoundOrder(seasonOrState = null) {\n    const season = seasonOrState?.currentSeason || seasonOrState || null;\n    const bracketOrder = Array.isArray(season?.bracket?.roundOrder) ? season.bracket.roundOrder.filter(Boolean) : [];\n    if (bracketOrder.length) return Array.from(new Set(bracketOrder));\n    const configuredRounds = Array.isArray(season?.bracketConfig?.rounds)\n      ? season.bracketConfig.rounds.map((round) => round?.id).filter(Boolean)\n      : [];\n    if (configuredRounds.length) return Array.from(new Set(configuredRounds));\n    const dateWindowOrder = getSeasonDateWindowsForSeason(season).map((round) => round?.id).filter(Boolean);\n    return dateWindowOrder.length ? Array.from(new Set(dateWindowOrder)) : OFFICIAL_SEASON_ROUND_ORDER.slice();\n  }\n\n  function isLegacyProtectedPlayInSeason(season) {\n    const bracketType = String(season?.bracket?.type || '');\n    if (bracketType === 'official_34_player_championship' || bracketType === 'projected_34_player_preview') return true;\n    const entries = Object.values(season?.series || {});\n    const playInCount = entries.filter((series) => series?.roundId === 'play_in').length;\n    const roundOf32Count = entries.filter((series) => series?.roundId === 'round_of_32').length;\n    return playInCount === 2 && roundOf32Count === 16 && !getSeasonRoundOrder(season).includes('opening_round');\n  }\n",
'add dynamic round helpers')

replace_once(
"    if (series.roundId === 'play_in') return resolvePlayInWinnersIntoRoundOf32(nextSeason, options);\n",
"    if (series.roundId === 'play_in' && isLegacyProtectedPlayInSeason(nextSeason)) return resolvePlayInWinnersIntoRoundOf32(nextSeason, options);\n",
'legacy play-in advancement guard')

replace_once(
"    OFFICIAL_SEASON_ROUND_ORDER.forEach((roundId) => {\n",
"    getSeasonRoundOrder(nextSeason).forEach((roundId) => {\n",
'dynamic repair round order')

replace_once(
"    const currentRoundIndex = OFFICIAL_SEASON_ROUND_ORDER.indexOf(roundId);\n    const seasonControlEnabled = season?.meta?.seasonMatchupControlEnabled === true;\n",
"    const roundOrder = getSeasonRoundOrder(season);\n    const currentRoundIndex = roundOrder.indexOf(roundId);\n    const seasonControlEnabled = season?.meta?.seasonMatchupControlEnabled === true;\n",
'dynamic active round current index')

replace_once(
"        const seriesRoundIndex = OFFICIAL_SEASON_ROUND_ORDER.indexOf(series.roundId);\n",
"        const seriesRoundIndex = roundOrder.indexOf(series.roundId);\n",
'dynamic active series index')

replace_once(
"    const currentRoundIndex = OFFICIAL_SEASON_ROUND_ORDER.indexOf(roundId);\n    const seasonControlEnabled = normalized?.meta?.seasonMatchupControlEnabled === true;\n",
"    const roundOrder = getSeasonRoundOrder(normalized);\n    const currentRoundIndex = roundOrder.indexOf(roundId);\n    const seasonControlEnabled = normalized?.meta?.seasonMatchupControlEnabled === true;\n",
'dynamic prepare current index')

replace_once(
"      const seriesRoundIndex = OFFICIAL_SEASON_ROUND_ORDER.indexOf(series.roundId);\n",
"      const seriesRoundIndex = roundOrder.indexOf(series.roundId);\n",
'dynamic prepare series index')

replace_once(
"      warnings.push(`${getSeasonDisplayName(roundId) || roundId} is waiting for all series to be ready (${readyCount}/${currentRoundSeries.length}).`);\n",
"      warnings.push(`${getSeasonDisplayName(roundId, normalized) || roundId} is waiting for all series to be ready (${readyCount}/${currentRoundSeries.length}).`);\n",
'custom round warning name')

replace_once(
"    const currentRoundIndex = OFFICIAL_SEASON_ROUND_ORDER.indexOf(dateRound);\n    const seriesRoundIndex = OFFICIAL_SEASON_ROUND_ORDER.indexOf(series?.roundId);\n",
"    const roundOrder = getSeasonRoundOrder(season);\n    const currentRoundIndex = roundOrder.indexOf(dateRound);\n    const seriesRoundIndex = roundOrder.indexOf(series?.roundId);\n",
'dynamic result evidence order')

replace_once(
"      const repairState = normalizeState({ ...normalized, currentSeason: repaired });\n      const upstreamPlayInRepair = repairPlayInSeriesFromProtectedRoundOf32Slots(repaired, {\n        ...options,\n        state: repairState,\n        currentState: repairState\n      });\n      if (upstreamPlayInRepair.season && (upstreamPlayInRepair.ok || upstreamPlayInRepair.changed)) repaired = upstreamPlayInRepair.season;\n      const playInRepair = repairPlayInAdvancementForSeason(repaired, options);\n      if (playInRepair.season) repaired = playInRepair.season;\n      return normalizeSeasonState(repaired);\n",
"      if (isLegacyProtectedPlayInSeason(repaired)) {\n        const repairState = normalizeState({ ...normalized, currentSeason: repaired });\n        const upstreamPlayInRepair = repairPlayInSeriesFromProtectedRoundOf32Slots(repaired, {\n          ...options,\n          state: repairState,\n          currentState: repairState\n        });\n        if (upstreamPlayInRepair.season && (upstreamPlayInRepair.ok || upstreamPlayInRepair.changed)) repaired = upstreamPlayInRepair.season;\n        const playInRepair = repairPlayInAdvancementForSeason(repaired, options);\n        if (playInRepair.season) repaired = playInRepair.season;\n      }\n      const advancementRepair = repairCompletedSeasonAdvancementForSeason(repaired, options);\n      if (advancementRepair.season) repaired = advancementRepair.season;\n      return normalizeSeasonState(repaired);\n",
'generic championship advancement repair')

replace_once(
"    if (series.roundId === 'play_in') return 'Winner enters Round of 32 with Play-In protection';\n",
"    if (series.roundId === 'play_in' && isLegacyProtectedPlayInSeason(season)) return 'Winner enters Round of 32 with Play-In protection';\n",
'generic play-in winner faces text')

replace_once(
"    if (playerAScore != null && playerBScore != null && playerAScore !== playerBScore && playerAId && playerBId) {\n      const winnerId = playerAScore > playerBScore ? playerAId : playerBId;\n      const loserId = playerAScore > playerBScore ? playerBId : playerAId;\n      return { winnerId, loserId, playerAScore, playerBScore, source: 'scores' };\n    }\n\n    const fallback = getRecordedResultWinner(record);\n",
"    if (playerAScore != null && playerBScore != null && playerAScore !== playerBScore && playerAId && playerBId) {\n      const winnerId = playerAScore > playerBScore ? playerAId : playerBId;\n      const loserId = playerAScore > playerBScore ? playerBId : playerAId;\n      return { winnerId, loserId, playerAScore, playerBScore, source: 'scores' };\n    }\n\n    if (playerAScore != null && playerBScore != null && playerAScore === playerBScore && series.tieBreaker === 'higher_seed' && playerAId && playerBId) {\n      const seedA = Number(series.playerASeed);\n      const seedB = Number(series.playerBSeed);\n      if (Number.isFinite(seedA) && Number.isFinite(seedB) && seedA !== seedB) {\n        const winnerId = seedA < seedB ? playerAId : playerBId;\n        const loserId = seedA < seedB ? playerBId : playerAId;\n        return { winnerId, loserId, playerAScore, playerBScore, source: 'higher_seed_tiebreaker' };\n      }\n    }\n\n    const fallback = getRecordedResultWinner(record);\n",
'tie higher seed result')

replace_once(
"    getSeasonRoundDefs,\n    getSeasonRoundForDate,\n",
"    getSeasonRoundDefs,\n    getSeasonRoundOrder,\n    getSeasonRoundForDate,\n",
'export round order')

path.write_text(text, encoding='utf-8')
