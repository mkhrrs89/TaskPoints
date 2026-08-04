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

  function isAllowedSeasonPath(pathInput) {
    const path = String(pathInput || '');
    return path === 'state.currentSeason'
      || path.startsWith('state.currentSeason.')
      || path.startsWith('state.currentSeason[')
      || path === 'state.seasonHistory'
      || path.startsWith('state.seasonHistory.')
      || path.startsWith('state.seasonHistory[');
  }

  function collectSeasonReferences(state) {
    const rows = [];
    walk(state?.currentSeason, 'state.currentSeason', (value, path) => {
      const imageId = imageIdFor(value);
      const playerId = playerIdFor(value);
      if (imageId && playerId) rows.push({
        path: `${path}.imageId`,
        playerId,
        imageId,
        name: value.playerName || value.name || playerId
      });
    });
    walk(state?.seasonHistory, 'state.seasonHistory', (value, path) => {
      const imageId = imageIdFor(value);
      const playerId = playerIdFor(value);
      if (imageId && playerId) rows.push({
        path: `${path}.imageId`,
        playerId,
        imageId,
        name: value.playerName || value.name || playerId
      });
    });
    return rows;
  }

  function buildRepairPlan(state, imageReport) {
    const players = Array.isArray(state?.players) ? state.players : [];
    const currentByPlayerId = new Map();
    const duplicatePlayerIds = new Set();
    const seenPlayerIds = new Set(['YOU']);
    const youImageId = typeof state?.youImageId === 'string' ? state.youImageId : '';
    if (youImageId) {
      currentByPlayerId.set('YOU', {
        playerId: 'YOU',
        imageId: youImageId,
        name: state?.youName || 'You'
      });
    }

    players.forEach((player) => {
      const playerId = playerIdFor(player);
      const imageId = imageIdFor(player);
      if (!playerId) return;
      if (seenPlayerIds.has(playerId)) duplicatePlayerIds.add(playerId);
      else seenPlayerIds.add(playerId);
      if (imageId) {
        currentByPlayerId.set(playerId, {
          playerId,
          imageId,
          name: player.name || player.playerName || playerId
        });
      }
    });

    const missingIds = [...new Set((imageReport?.missingReferences || []).map(String).filter(Boolean))].sort();
    const availableIds = new Set((imageReport?.rows || []).map((row) => String(row?.key || '')).filter(Boolean));
    const referencePaths = imageReport?.referencePaths || {};
    const seasonReferences = collectSeasonReferences(state);
    const missingSet = new Set(missingIds);
    const repairs = [];
    const unresolved = [];
    const externalPaths = [];
    const expectedAllowedPaths = new Set();

    missingIds.forEach((imageId) => {
      const paths = Array.isArray(referencePaths[imageId]) ? referencePaths[imageId].map(String) : [];
      if (!paths.length) {
        unresolved.push({ imageId, reason: 'reference-paths-unavailable' });
        return;
      }
      paths.forEach((path) => {
        if (isAllowedSeasonPath(path)) expectedAllowedPaths.add(`${imageId}|${path}`);
        else externalPaths.push({ imageId, path });
      });
    });

    seasonReferences.forEach((reference) => {
      if (!missingSet.has(reference.imageId)) return;
      if (duplicatePlayerIds.has(reference.playerId)) {
        unresolved.push({ ...reference, reason: 'duplicate-current-player-id' });
        return;
      }
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

    const coveredPaths = new Set();
    repairs.forEach((repair) => coveredPaths.add(`${repair.oldImageId}|${repair.path}`));
    unresolved.forEach((entry) => {
      if (entry.imageId && entry.path) coveredPaths.add(`${entry.imageId}|${entry.path}`);
    });
    expectedAllowedPaths.forEach((key) => {
      if (!coveredPaths.has(key)) {
        const splitAt = key.indexOf('|');
        unresolved.push({
          imageId: key.slice(0, splitAt),
          path: key.slice(splitAt + 1),
          reason: 'reference-path-not-matched'
        });
      }
    });

    const candidatesByMissingId = new Map();
    repairs.forEach((repair) => {
      const candidate = `${repair.playerId}|${repair.newImageId}`;
      if (!candidatesByMissingId.has(repair.oldImageId)) candidatesByMissingId.set(repair.oldImageId, new Set());
      candidatesByMissingId.get(repair.oldImageId).add(candidate);
    });
    candidatesByMissingId.forEach((candidates, imageId) => {
      if (candidates.size > 1) {
        unresolved.push({
          imageId,
          candidates: [...candidates].sort(),
          reason: 'ambiguous-missing-image-reference'
        });
      }
    });

    const foundMissingIds = new Set(repairs.map((repair) => repair.oldImageId));
    unresolved.forEach((entry) => {
      if (entry.imageId) foundMissingIds.add(entry.imageId);
    });
    missingIds.forEach((imageId) => {
      if (!foundMissingIds.has(imageId)) unresolved.push({ imageId, reason: 'missing-reference-not-found-in-season-data' });
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
      && repairedMissingIds.length === missingIds.length
      && repairs.length === expectedAllowedPaths.size;
    const fingerprint = JSON.stringify({
      missingIds,
      expectedAllowedPaths: [...expectedAllowedPaths].sort(),
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
      duplicatePlayerIds: [...duplicatePlayerIds].sort(),
      expectedAllowedPathCount: expectedAllowedPaths.size,
      fingerprint
    };
  }

  function applyRepairPlan(state, plan) {
    if (!plan?.safe || !Array.isArray(plan.repairs) || !plan.repairs.length) {
      return { ok: false, state, updatedCount: 0, error: 'unsafe-plan' };
    }
    const next = clone(state || {});
    const repairsByPath = new Map(plan.repairs.map((repair) => [repair.path, repair]));
    let updatedCount = 0;
    let mismatch = false;

    const update = (value, path) => {
      const repair = repairsByPath.get(`${path}.imageId`);
      if (!repair) return;
      const playerId = playerIdFor(value);
      const imageId = imageIdFor(value);
      if (playerId !== repair.playerId || imageId !== repair.oldImageId) {
        mismatch = true;
        return;
      }
      value.imageId = repair.newImageId;
      updatedCount += 1;
    };
    walk(next.currentSeason, 'state.currentSeason', update);
    walk(next.seasonHistory, 'state.seasonHistory', update);

    if (mismatch || updatedCount !== plan.repairs.length) {
      return { ok: false, state, updatedCount, error: 'repair-count-or-path-mismatch' };
    }
    return { ok: true, state: next, updatedCount };
  }

  function nonImageSnapshot(state) {
    const next = clone(state || {});
    walk(next.currentSeason, 'state.currentSeason', (value) => {
      if (Object.prototype.hasOwnProperty.call(value, 'imageId')) value.imageId = '__SEASON_IMAGE_ID__';
    });
    walk(next.seasonHistory, 'state.seasonHistory', (value) => {
      if (Object.prototype.hasOwnProperty.call(value, 'imageId')) value.imageId = '__SEASON_IMAGE_ID__';
    });
    return JSON.stringify(next);
  }

  function seasonImageSnapshot(state) {
    return JSON.stringify(collectSeasonReferences(state)
      .map(({ path, playerId, imageId }) => [path, playerId, imageId])
      .sort((a, b) => a[0].localeCompare(b[0])));
  }

  const api = {
    collectSeasonReferences,
    buildRepairPlan,
    applyRepairPlan,
    nonImageSnapshot,
    seasonImageSnapshot,
    isAllowedSeasonPath
  };

  global.TaskPointsSeasonImageReferenceRepair = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
