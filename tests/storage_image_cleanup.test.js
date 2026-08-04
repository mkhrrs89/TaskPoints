const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const cleanup = require(path.join('..', 'storage_image_cleanup.js'));

test('collects image references from current and historical state', () => {
  const state = {
    youImageId: 'you-current',
    players: [
      { id: 'p1', imageId: 'player-current' },
      { id: 'p2', profileImageId: 'player-profile' }
    ],
    currentSeason: {
      playerPool: [{ id: 'p3', imageId: 'season-current' }]
    },
    seasonHistory: [{ playerPool: [{ id: 'p4', imageId: 'season-history' }] }]
  };

  const result = cleanup.collectReferencedImageIds(state);
  assert.deepEqual(result.referencedIds, [
    'player-current',
    'player-profile',
    'season-current',
    'season-history',
    'you-current'
  ]);
  assert.deepEqual(result.referencePaths['season-history'], [
    'state.seasonHistory[0].playerPool[0].imageId'
  ]);
});

test('builds a cleanup plan without treating replaced unreferenced blobs as active', () => {
  const state = {
    youImageId: 'you-current',
    players: [{ id: 'p1', imageId: 'player-current' }]
  };
  const rows = [
    { key: 'you-current', bytes: 100, type: 'image/png' },
    { key: 'player-current', bytes: 200, type: 'image/jpeg' },
    { key: 'player-old', bytes: 300, type: 'image/jpeg' }
  ];

  const plan = cleanup.buildCleanupPlan(state, rows);
  assert.deepEqual(plan.missingReferences, []);
  assert.deepEqual(plan.unreferencedIds, ['player-old']);
  assert.equal(plan.unreferencedBytes, 300);
});

test('reports missing referenced blobs and blocks validation', () => {
  const state = { players: [{ imageId: 'missing-current' }] };
  const preview = cleanup.buildCleanupPlan(state, [{ key: 'orphan', bytes: 10 }]);
  const validation = cleanup.validateCleanupPreview(preview, state, [{ key: 'orphan', bytes: 10 }]);

  assert.deepEqual(preview.missingReferences, ['missing-current']);
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'missing-references');
});

test('rejects a stale preview when an orphan becomes referenced', () => {
  const rows = [
    { key: 'current', bytes: 100 },
    { key: 'candidate', bytes: 50 }
  ];
  const preview = cleanup.buildCleanupPlan(
    { players: [{ imageId: 'current' }] },
    rows
  );
  const validation = cleanup.validateCleanupPreview(
    preview,
    { players: [{ imageId: 'current' }, { imageId: 'candidate' }] },
    rows
  );

  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'stale-preview');
  assert.deepEqual(validation.current.unreferencedIds, []);
});

test('rejects a stale preview when image rows change', () => {
  const state = { players: [{ imageId: 'current' }] };
  const preview = cleanup.buildCleanupPlan(state, [
    { key: 'current', bytes: 100 },
    { key: 'candidate', bytes: 50 }
  ]);
  const validation = cleanup.validateCleanupPreview(preview, state, [
    { key: 'current', bytes: 100 },
    { key: 'candidate', bytes: 55 }
  ]);

  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'stale-preview');
});

test('accepts an unchanged safe cleanup preview', () => {
  const state = { players: [{ imageId: 'current' }] };
  const rows = [
    { key: 'current', bytes: 100 },
    { key: 'candidate', bytes: 50 }
  ];
  const preview = cleanup.buildCleanupPlan(state, rows);
  const validation = cleanup.validateCleanupPreview(preview, state, rows);

  assert.equal(validation.ok, true);
  assert.equal(validation.reason, '');
  assert.deepEqual(validation.current.unreferencedIds, ['candidate']);
});
