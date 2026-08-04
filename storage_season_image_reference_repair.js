(function installSeasonImageReferenceRepair(global) {
  'use strict';

  function clone(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function playerIdFor(value) {
    if (!value || typeof value !== 'object') return '';
    return String(value.playerId || value.id || '');
  }

  function imageIdFor(value) {
    return value && typeof value.imageId === 'string' ? value.imageId : '';
  }

  function walk(value, path, visitor) {
    if (!value || typeof value !== 'object') return;
    visitor(value, path);
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, visitor));
      return;
    }
    Object.entries(value).forEach(([key, child]) => walk(child, `${path}.${key}`, visitor));
  }

  function collectSeasonReferences(state) {
    const rows = [];
    walk(state?.currentSeason, 'state.currentSeason', (value, path) => {
      const imageId = imageIdFor(value);
      const playerId = playerIdFor(value);
      if (imageId && playerId) rows.push({ path, playerId, imageId, name: value.playerName || value.name || playerId });
    });
    walk(state?.seasonHistory, 'state.seasonHistory', (value, path) => {
      const imageId = imageIdFor(value);
      const playerId = playerIdFor(value);
      if (imageId && playerId) rows.push({ path, playerId, imageId, name: value.playerName || value.name || playerId });
    });
    return rows;
  }

  function buildRepairPlan(state, imageReport) {
    const players = Array.isArray(state?.players) ? state.players : [];
    const currentByPlayerId = new Map();
    players.forEach((player) => {
      const playerId = playerIdFor(player);
      const imageId = imageIdFor(player);
      if (playerId && imageId) currentByPlayerId.set(playerId, {
        playerId,
        imageId,
        name: player.name || player.playerName || playerId
      });
    });

    const missingIds = [...new Set((imageReport?.missingReferences || []).map(String).filter(Boolean))].sort();
    const availableIds = new Set((imageReport?.rows || []).map((row) => String(row?.key || '')).filter(Boolean));
    const referencePaths = imageReport?.referencePaths || {};
    const seasonReferences = collectSeasonReferences(state);
    const missingSet = new Set(missingIds);
    const repairs = [];
    const unresolved = [];

    seasonReferences.forEach((reference) => {
      if (!missingSet.has(reference.imageId)) return;
      const current = currentByPlayerId.get(reference.playerId);
      if (!current) {
        unresolved.push({ ...reference, reason: 'player-not-found' });
        return;
      }
      if (!current.imageId || current.imageId === reference.imageId) {
        unresolved.push({ ...reference, reason: 'no-replacement-image' });
        return;
      }
      if (!availableIds.has(current.imageId)) {
        unresolved.push({ ...reference, replacementImageId: current.imageId, reason: 'replacement-blob-missing' });
        return;
      }
      repairs.push({
        path: reference.path,
        playerId: reference.playerId,
        playerName: current.name || reference.name,
        oldImageId: reference.imageId,
        newImageId: current.imageId
      });
    });

    const foundMissingIds = new Set(repairs.map((repair) => repair.oldImageId));
    unresolved.forEach((entry) => foundMissingIds.add(entry.imageId));
    missingIds.forEach((imageId) => {
      if (!foundMissingIds.has(imageId)) unresolved.push({ imageId, reason: 'missing-reference-not-found-in-season-data' });
    });

    const externalPaths = [];
    missingIds.forEach((imageId) => {
      const paths = Array.isArray(referencePaths[imageId]) ? referencePaths[imageId] : [];
      paths.forEach((path) => {
        if (!String(path).startsWith('state.currentSeason') && !String(path).startsWith('state.seasonHistory')) {
          externalPaths.push({ imageId, path: String(path) });
        }
      });
    });

    repairs.sort((a, b) => a.path.localeCompare(b.path));
    unresolved.sort((a, b) => String(a.path || a.imageId || '').localeCompare(String(b.path || b.imageId || '')));
    externalPaths.sort((a, b) => a.path.localeCompare(b.path));

    const replacementGroups = [];
    const groupMap = new Map();
    repairs.forEach((repair) => {
      const key = `${repair.playerId}|${repair.oldImageId}|${repair.newImageId}`;
      let group = groupMap.get(key);
      if (!group) {
        group = {
          playerId: repair.playerId,
          playerName: repair.playerName,
          oldImageId: repair.oldImageId,
          newImageId: repair.newImageId,
          paths: []
        };
        groupMap.set(key, group);
        replacementGroups.push(group);
      }
      group.paths.push(repair.path);
    });
    replacementGroups.sort((a, b) => a.playerName.localeCompare(b.playerName));

    const repairedMissingIds = [...new Set(repairs.map((repair) => repair.oldImageId))].sort();
    const safe = missingIds.length > 0
      && unresolved.length === 0
      && externalPaths.length === 0
      && repairedMissingIds.length === missingIds.length;
    const fingerprint = JSON.stringify({
      missingIds,
      repairs: repairs.map(({ path, playerId, oldImageId, newImageId }) => [path, playerId, oldImageId, newImageId])
    });

    return {
      safe,
      missingIds,
      repairedMissingIds,
      repairs,
      replacementGroups,
      unresolved,
      externalPaths,
      fingerprint
    };
  }

  function applyRepairPlan(state, plan) {
    if (!plan?.safe || !Array.isArray(plan.repairs) || !plan.repairs.length) {
      return { ok: false, state, updatedCount: 0, error: 'unsafe-plan' };
    }
    const next = clone(state || {});
    const byPlayerAndOldImage = new Map();
    plan.repairs.forEach((repair) => {
      byPlayerAndOldImage.set(`${repair.playerId}|${repair.oldImageId}`, repair.newImageId);
    });

    let updatedCount = 0;
    const update = (value) => {
      const playerId = playerIdFor(value);
      const imageId = imageIdFor(value);
      if (!playerId || !imageId) return;
      const replacement = byPlayerAndOldImage.get(`${playerId}|${imageId}`);
      if (!replacement) return;
      value.imageId = replacement;
      updatedCount += 1;
    };
    walk(next.currentSeason, 'state.currentSeason', update);
    walk(next.seasonHistory, 'state.seasonHistory', update);

    if (updatedCount !== plan.repairs.length) {
      return { ok: false, state, updatedCount, error: 'repair-count-mismatch' };
    }
    return { ok: true, state: next, updatedCount };
  }

  function nonImageSnapshot(state) {
    const roots = {
      currentSeason: clone(state?.currentSeason ?? null),
      seasonHistory: clone(state?.seasonHistory ?? [])
    };
    walk(roots, 'roots', (value) => {
      if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'imageId')) {
        value.imageId = '__IMAGE_ID__';
      }
    });
    return JSON.stringify(roots);
  }

  const api = {
    collectSeasonReferences,
    buildRepairPlan,
    applyRepairPlan,
    nonImageSnapshot
  };

  global.TaskPointsSeasonImageReferenceRepair = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
