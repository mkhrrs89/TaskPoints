const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
const storage = new Map();
global.localStorage = {
  getItem: (key) => storage.has(String(key)) ? storage.get(String(key)) : null,
  setItem: (key, value) => { storage.set(String(key), String(value)); },
  removeItem: (key) => storage.delete(String(key)),
  key: (index) => Array.from(storage.keys())[index] || null,
  get length() { return storage.size; }
};

require('../scoring_core.js');
const core = global.TaskPointsCore;

const IDS = {
  Seraphine: '4611a441-b311-4822-baa7-63791e41a737',
  Poppy: 'f66a165a-72e5-49c2-b9a0-26e4bab86413',
  Miggy: 'YOU',
  Verrick: '358b982e-c494-4c58-815a-d59953742997',
  Rhys: 'fb53fef8-ec83-471c-aef1-4c6c64b4b5ce',
  Inara: '250ec440-6a9b-40dc-a456-07aeee77ebab',
  Cooper: '243ba65b-6303-4c9c-9a00-710e24c09df2',
  Xander: 'a82a958b-9281-4250-9115-e3e2ee741d09',
  Carlisle: 'b9ec0138-ca2f-46e1-870f-594b53e7f888',
  Joe: '63d43b6f-d36f-4b44-ba0d-87e9e1471499',
  Rocco: '96f64ec3-5ed6-42e0-9dde-596cba7e11b7',
  Fletcher: '8ff55473-882a-4cd5-b956-26cebf323802',
  Mockabee: '2e5b6d94-7982-4992-9185-8bab67e3bda8',
  Everly: '41d3da52-c883-425a-b6d4-0e8479d65e40',
  Rick: '3228e55f-cf13-4719-a9ff-b91d0bc55066',
  Delilah: '7eed8920-278f-4a8a-8e90-318c5a5ac139'
};

const SYNTH_3 = 'season_1_june_2026_season_1_june_2026_sweet_16_3_admin_catchup_2026_06_09';
const SYNTH_4 = 'season_1_june_2026_season_1_june_2026_sweet_16_4_admin_catchup_2026_06_09';

const JUNE14 = [
  ['2026-06-14_exhibition_1_7eed8920-278f-4a8a-8e90-318c5a5ac139_274a84e6-2538-4bde-b76d-c13363b87ded', IDS.Delilah, '274a84e6-2538-4bde-b76d-c13363b87ded', 44, 40.1],
  ['2026-06-14_exhibition_2_f31541a6-7db0-4df8-a864-ef17ac9a407b_8ff55473-882a-4cd5-b956-26cebf323802', 'f31541a6-7db0-4df8-a864-ef17ac9a407b', IDS.Fletcher, 40.6, 42.9],
  ['2026-06-14_exhibition_3_41d3da52-c883-425a-b6d4-0e8479d65e40_44469065-6bcc-4f93-8fc1-2a6b257f716d', IDS.Everly, '44469065-6bcc-4f93-8fc1-2a6b257f716d', 59.2, 43.4],
  ['2026-06-14_exhibition_4_268a1d34-73e5-4944-b786-904e610a8f6a_4f35710c-90ce-40d2-85c7-3398b714c7f3', '268a1d34-73e5-4944-b786-904e610a8f6a', '4f35710c-90ce-40d2-85c7-3398b714c7f3', 76.1, 57.4],
  ['2026-06-14_exhibition_5_fb53fef8-ec83-471c-aef1-4c6c64b4b5ce_b9ec0138-ca2f-46e1-870f-594b53e7f888', IDS.Rhys, IDS.Carlisle, 44.9, 43.8],
  ['2026-06-14_exhibition_6_e5956916-50d8-432d-98df-eff6c6c1649b_7576d45e-7a91-4d80-b2c6-c7a19f4a7a20', 'e5956916-50d8-432d-98df-eff6c6c1649b', '7576d45e-7a91-4d80-b2c6-c7a19f4a7a20', 53.8, 47],
  ['2026-06-14_exhibition_7_1be88608-b4bb-4edf-9a20-739b9d33e6d9_a82a958b-9281-4250-9115-e3e2ee741d09', '1be88608-b4bb-4edf-9a20-739b9d33e6d9', IDS.Xander, 40.1, 61.7],
  ['2026-06-14_exhibition_8_1fa8befc-e31e-4948-abf3-483ccbca23f5_3228e55f-cf13-4719-a9ff-b91d0bc55066', '1fa8befc-e31e-4948-abf3-483ccbca23f5', IDS.Rick, 47.5, 35.7],
  ['2026-06-14_exhibition_9_250ec440-6a9b-40dc-a456-07aeee77ebab_1b87a9ea-cede-48da-a4e8-33d0a6131548', IDS.Inara, '1b87a9ea-cede-48da-a4e8-33d0a6131548', 46.8, 41.6],
  ['2026-06-14_exhibition_11_090665ac-c226-4e92-a211-3244159240ed_d62801f2-7396-4456-b146-d5deabc45f9a', '090665ac-c226-4e92-a211-3244159240ed', 'd62801f2-7396-4456-b146-d5deabc45f9a', 28.7, 38.8],
  ['2026-06-14_exhibition_12_96f64ec3-5ed6-42e0-9dde-596cba7e11b7_2e5b6d94-7982-4992-9185-8bab67e3bda8', IDS.Rocco, IDS.Mockabee, 37.4, 26.9],
  ['2026-06-14_exhibition_13_0129b7e2-8af6-4d7f-9ad1-502e7ff44193_63d43b6f-d36f-4b44-ba0d-87e9e1471499', '0129b7e2-8af6-4d7f-9ad1-502e7ff44193', IDS.Joe, 29.7, 44.8]
];

function baseFixture() {
  const matchups = [
    { id:SYNTH_3, date:'2026-06-09', dateKey:'2026-06-09', playerAId:IDS.Poppy, playerBId:IDS.Rhys, scoreA:55, scoreB:45, source:'admin_catch_up' },
    { id:SYNTH_4, date:'2026-06-09', dateKey:'2026-06-09', playerAId:IDS.Seraphine, playerBId:IDS.Inara, scoreA:55, scoreB:45, source:'admin_catch_up' },
    ...JUNE14.map(([id,a,b]) => ({ id, matchupId:id, date:'2026-06-14', dateKey:'2026-06-14', playerAId:a, playerBId:b, matchupType:'exhibition', scoreA:null, scoreB:null }))
  ];
  const gameHistory = JUNE14.flatMap(([,a,b,sa,sb], i) => [
    { id:`j14-a-${i}`, date:'2026-06-14', dateKey:'2026-06-14', playerId:a, score:sa },
    { id:`j14-b-${i}`, date:'2026-06-14', dateKey:'2026-06-14', playerId:b, score:sb }
  ]);
  gameHistory.push(
    { id:'poppy-synth', date:'2026-06-09', dateKey:'2026-06-09', playerId:IDS.Poppy, score:55, matchupId:SYNTH_3 },
    { id:'rhys-synth', date:'2026-06-09', dateKey:'2026-06-09', playerId:IDS.Rhys, score:45, matchupId:SYNTH_3 },
    { id:'seraphine-synth', date:'2026-06-09', dateKey:'2026-06-09', playerId:IDS.Seraphine, score:55, matchupId:SYNTH_4 },
    { id:'0aa96495-d223-43c8-82d1-a9df15a84042', date:'2026-06-09', dateKey:'2026-06-09', playerId:IDS.Inara, score:45 }
  );
  return {
    youName:'Miggy',
    players:Object.entries(IDS).filter(([name]) => name !== 'Miggy').map(([name,id]) => ({ id, name, active:true })),
    tasks:[], reminders:[], completions:[], habits:[], flexActions:[],
    matchups, gameHistory,
    schedule:[
      { date:'2026-06-09', dateKey:'2026-06-09', matchups:matchups.slice(0,2) },
      { date:'2026-06-14', dateKey:'2026-06-14', matchups:matchups.slice(2) }
    ],
    seasonHistory:[{
      id:'season_1_june_2026',
      monthKey:'2026-06',
      status:'champion_crowned',
      series:{
        sweet3:{ id:'sweet3', roundId:'sweet_16', playerAId:IDS.Poppy, playerBId:IDS.Rhys, gameResults:[{ matchupId:SYNTH_3, dateKey:'2026-06-09', winnerId:IDS.Poppy, loserId:IDS.Rhys, playerAScore:55, playerBScore:45, source:'admin_catch_up', catchUpResult:true }] },
        sweet4:{ id:'sweet4', roundId:'sweet_16', playerAId:IDS.Seraphine, playerBId:IDS.Inara, gameResults:[{ matchupId:SYNTH_4, dateKey:'2026-06-09', winnerId:IDS.Seraphine, loserId:IDS.Inara, playerAScore:55, playerBScore:45, source:'admin_catch_up', catchUpResult:true }] }
      }
    }]
  };
}

test('repairs only confirmed June lifetime rows and preserves archived Season 1 series results', () => {
  const state = baseFixture();
  const normalizedSeasonBefore = structuredClone(core.normalizeState(state).seasonHistory);
  const result = core.repairConfirmedJune2026LifetimeHistory(state);

  assert.equal(result.changed, true);
  assert.equal(result.repairedJune14Matchups, 12);
  assert.equal(result.removedJune9Matchups, 2);
  assert.equal(result.removedJune9GameHistory, 4);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.state.seasonHistory, normalizedSeasonBefore);

  assert.equal(result.state.matchups.some((m) => m.id === SYNTH_3 || m.id === SYNTH_4), false);
  assert.equal(result.state.gameHistory.some((g) => g.matchupId === SYNTH_3 || g.matchupId === SYNTH_4), false);
  assert.equal(result.state.gameHistory.some((g) => g.id === '0aa96495-d223-43c8-82d1-a9df15a84042'), false);

  JUNE14.forEach(([id,,,sa,sb]) => {
    const row = result.state.matchups.find((m) => m.id === id);
    assert.equal(row.scoreA, sa);
    assert.equal(row.playerAScore, sa);
    assert.equal(row.scoreB, sb);
    assert.equal(row.playerBScore, sb);
  });

  const scheduleJune9 = result.state.schedule.find((day) => day.dateKey === '2026-06-09');
  assert.equal(scheduleJune9.matchups.some((m) => m.id === SYNTH_3 || m.id === SYNTH_4), false);
  const scheduleJune14 = result.state.schedule.find((day) => day.dateKey === '2026-06-14');
  assert.equal(scheduleJune14.matchups.every((m) => Number.isFinite(Number(m.scoreA)) && Number.isFinite(Number(m.scoreB))), true);
});

test('repair is idempotent and leaves a completion marker', () => {
  const first = core.repairConfirmedJune2026LifetimeHistory(baseFixture());
  assert.equal(first.state.historicalRepairMarkers.june2026LifetimeMatchupsV1, true);
  const second = core.repairConfirmedJune2026LifetimeHistory(first.state);
  assert.equal(second.changed, false);
  assert.equal(second.repairedJune14Matchups, 0);
  assert.equal(second.removedJune9Matchups, 0);
  assert.equal(second.removedJune9GameHistory, 0);
});

test('repair never overwrites a conflicting June 14 score', () => {
  const state = baseFixture();
  state.matchups[2].scoreA = 999;
  const result = core.repairConfirmedJune2026LifetimeHistory(state);
  assert.ok(result.unresolved.includes(JUNE14[0][0]));
  assert.equal(result.state.matchups.find((m) => m.id === JUNE14[0][0]).scoreA, 999);
  assert.notEqual(result.state.historicalRepairMarkers?.june2026LifetimeMatchupsV1, true);
});

test('loadAppState can persist only the confirmed repair while general startup persistence stays disabled', () => {
  storage.clear();
  storage.set('taskpoints_v1', JSON.stringify(baseFixture()));
  const loaded = core.loadAppState({
    syncDerived:false,
    persistSync:false,
    persistConfirmedHistoricalRepairs:true
  });
  assert.equal(loaded.state.matchups.some((m) => m.id === SYNTH_3 || m.id === SYNTH_4), false);
  assert.equal(loaded.state.historicalRepairMarkers.june2026LifetimeMatchupsV1, true);

  const persisted = core.parseTaskPointsStorageJson(storage.get('taskpoints_v1'), {});
  assert.equal(persisted.matchups.some((m) => m.id === SYNTH_3 || m.id === SYNTH_4), false);
  assert.equal(persisted.historicalRepairMarkers.june2026LifetimeMatchupsV1, true);
});

test('known Oct 8 lifetime totals become 178 for all original 16 after the confirmed deltas', () => {
  const before = {
    Seraphine:179, Poppy:179, Miggy:178, Verrick:178, Rhys:178, Inara:178, Cooper:178,
    Xander:177, Carlisle:177, Joe:177, Rocco:177, Fletcher:177, Mockabee:177, Everly:177, Rick:177, Delilah:177
  };
  const june9Removed = new Set(['Seraphine','Poppy','Rhys','Inara']);
  const june14Recovered = new Set(['Rhys','Inara','Xander','Carlisle','Joe','Rocco','Fletcher','Mockabee','Everly','Rick','Delilah']);
  Object.keys(before).forEach((name) => {
    const after = before[name] - (june9Removed.has(name) ? 1 : 0) + (june14Recovered.has(name) ? 1 : 0);
    assert.equal(after, 178, name);
  });
});


test('Home opts into repair-only persistence on both localStorage and native boot paths', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const occurrences = home.match(/persistConfirmedHistoricalRepairs:\s*true/g) || [];
  assert.equal(occurrences.length, 2);
});


test('an unrelated or empty state is never marked as already repaired', () => {
  const empty = {
    tasks:[], reminders:[], completions:[], players:[], habits:[], flexActions:[],
    gameHistory:[], matchups:[], schedule:[], seasonHistory:[]
  };
  const result = core.repairConfirmedJune2026LifetimeHistory(empty);
  assert.equal(result.changed, false);
  assert.notEqual(result.state.historicalRepairMarkers?.june2026LifetimeMatchupsV1, true);
});
