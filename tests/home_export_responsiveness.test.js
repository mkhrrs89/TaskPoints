const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'home_export_responsiveness.js'), 'utf8');

function install(overrides = {}) {
  const listeners = [];
  const context = {
    console,
    Promise,
    Blob,
    TextEncoder,
    Uint8Array,
    Uint32Array,
    Date,
    JSON,
    Math,
    Map,
    Set,
    Object,
    Array,
    Number,
    String,
    Error,
    URL: {
      createObjectURL() { return 'blob:test'; },
      revokeObjectURL() {}
    },
    document: {
      addEventListener(type, handler, capture) { listeners.push({ type, handler, capture }); },
      querySelectorAll() { return []; },
      getElementById() { return null; },
      createElement() { return { style: {}, setAttribute() {}, click() {}, remove() {} }; },
      body: { appendChild() {} },
      documentElement: { appendChild() {} }
    },
    localStorage: { getItem() { return null; } },
    setTimeout(callback) { callback(); return 1; },
    requestAnimationFrame(callback) { callback(); return 1; },
    module: { exports: {} },
    ...overrides
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'home_export_responsiveness.js' });
  return { api: context.TaskPointsResponsiveExport, context, listeners };
}

test('single-flight runner ignores repeated taps until the first export finishes', async () => {
  const { api } = install();
  const run = api.createSingleFlightRunner();
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });

  const first = run(async () => {
    calls += 1;
    await pending;
    return 'done';
  });
  const second = run(async () => {
    calls += 1;
    return 'duplicate';
  });

  assert.strictEqual(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 'done');

  const third = run(async () => {
    calls += 1;
    return 'next';
  });
  assert.equal(await third, 'next');
  assert.equal(calls, 2);
});

test('bounded concurrency never exceeds the requested worker limit', async () => {
  const { api } = install();
  let active = 0;
  let maxActive = 0;
  const gates = [];

  const work = api.mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => gates.push(resolve));
    active -= 1;
    return value * 2;
  });

  await Promise.resolve();
  assert.equal(maxActive, 3);
  while (gates.length) {
    gates.shift()();
    await Promise.resolve();
  }
  assert.deepEqual(Array.from(await work), [2, 4, 6, 8, 10, 12]);
  assert.equal(maxActive, 3);
});

test('download URL is not revoked immediately on iOS-style delayed consumption', () => {
  const timers = [];
  let clicked = 0;
  let removed = 0;
  let revoked = 0;
  let appended = 0;
  const anchor = {
    style: {},
    click() { clicked += 1; },
    remove() { removed += 1; }
  };
  const document = {
    createElement(tag) {
      assert.equal(tag, 'a');
      return anchor;
    },
    body: { appendChild(node) { assert.strictEqual(node, anchor); appended += 1; } }
  };
  const urlApi = {
    createObjectURL() { return 'blob:delayed'; },
    revokeObjectURL(value) { assert.equal(value, 'blob:delayed'); revoked += 1; }
  };
  const setTimeout = (callback, delay) => {
    timers.push({ callback, delay });
    return timers.length;
  };
  const { api } = install();

  api.triggerDownload(new Blob(['backup']), 'backup.zip', { document, URL: urlApi, setTimeout });

  assert.equal(appended, 1);
  assert.equal(clicked, 1);
  assert.equal(removed, 0);
  assert.equal(revoked, 0);

  timers.find((timer) => timer.delay === api.constants.ANCHOR_REMOVE_DELAY_MS).callback();
  assert.equal(removed, 1);
  assert.equal(revoked, 0);

  timers.find((timer) => timer.delay === api.constants.URL_REVOKE_DELAY_MS).callback();
  assert.equal(revoked, 1);
});

test('home export reuses the in-memory full-backup snapshot instead of reloading storage', () => {
  let loadCalls = 0;
  let flushCalls = 0;
  const payload = {
    exportType: 'taskpoints_full_backup',
    version: 2,
    exportedAtISO: '2026-08-03T19:34:00.000Z',
    state: { tasks: [{ id: 'fresh' }], players: [] },
    aux: {}
  };
  const { api } = install({
    TaskPointsCore: {
      flushPendingSaves() { flushCalls += 1; },
      loadAppState() { loadCalls += 1; return { state: { tasks: [{ id: 'stale' }] } }; }
    },
    getTaskPointsExportSnapshot() { return payload; }
  });

  const result = api.buildExportPayload();
  assert.strictEqual(result, payload);
  assert.equal(flushCalls, 1);
  assert.equal(loadCalls, 0);
});

test('zip builder emits a valid local header and end-of-central-directory marker', async () => {
  const { api } = install();
  const zip = await api.buildZipBlob([
    { path: 'manifest.json', blob: new Blob(['{}'], { type: 'application/json' }) }
  ]);
  const bytes = new Uint8Array(await zip.arrayBuffer());

  const read32 = (offset) => (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;

  assert.equal(read32(0), 0x04034b50);
  assert.equal(read32(bytes.length - 22), 0x06054b50);
});


function manifestFromZip(blob) {
  return blob.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer);
    const read16 = offset => bytes[offset] | (bytes[offset+1] << 8);
    const read32 = offset => (bytes[offset] | (bytes[offset+1] << 8)
      | (bytes[offset+2] << 16) | (bytes[offset+3] << 24)) >>> 0;
    assert.equal(read32(0), 0x04034b50);
    const filenameLength = read16(26);
    const filename = new TextDecoder().decode(bytes.slice(30, 30+filenameLength));
    assert.equal(filename, 'manifest.json');
    const start = 30 + filenameLength + read16(28);
    return JSON.parse(new TextDecoder().decode(bytes.slice(start, start+read32(18))));
  });
}

test('image ZIP discloses missing referenced photos, but preserves export and complete state', async () => {
  const payload = {
    exportType:'taskpoints_full_backup',version:2,
    state:{
      tasks:[{id:'important-task'}],completions:[],
      players:[{id:'a',imageId:'image-ok'},{id:'b',imageId:'image-missing'}],
      youImageId:'image-ok',goldLedger:[{id:'gold-keep',amount:5}],
      unknownImportedState:{keep:true}
    },aux:{taskpoints_notes_v1:'Keep notes'}
  };
  const imagesRequested = [];
  const {api} = install({
    getTaskPointsExportSnapshot(){return payload;},
    TaskPointsCore:{
      getImageBlob(id){imagesRequested.push(id);
        return id==='image-ok' ? new Blob(['photo'],{type:'image/png'}) : null;
      }
    }
  });

  const artifact = await api.createExportArtifact();
  assert.equal(artifact.imageCount,1);
  assert.equal(artifact.missingImageCount,1);
  assert.deepEqual(Array.from(artifact.missingImageIds),['image-missing']);
  assert.deepEqual(imagesRequested,['image-ok','image-missing']);
  assert.deepEqual(Array.from(artifact.payload.imageExportCoverage.missingImageIds),['image-missing']);
  assert.equal(artifact.payload.imageExportCoverage.complete,false);
  const manifest = await manifestFromZip(artifact.blob);
  assert.equal(manifest.exportType,'taskpoints_full_backup');
  assert.equal(manifest.version,2);
  assert.equal(manifest.imageExportCoverage.referencedCount,2);
  assert.equal(manifest.imageExportCoverage.includedCount,1);
  assert.equal(manifest.imageExportCoverage.complete,false);
  assert.deepEqual(manifest.imageExportCoverage.missingImageIds,['image-missing']);
  assert.equal(manifest.state.goldLedger[0].id,'gold-keep');
  assert.equal(manifest.state.unknownImportedState.keep,true);
  assert.equal(manifest.aux.taskpoints_notes_v1,'Keep notes');
  assert.equal(payload.imageExportCoverage,undefined,
    'snapshot owner must not be mutated by the export');
});

test('a referenced photo added after a missing-image export is fetched next time', async () => {
  let recovered=false;
  const calls=[];
  const {api}=install({
    getTaskPointsExportSnapshot(){return {
      exportType:'taskpoints_full_backup',version:2,
      state:{tasks:[],completions:[],youImageId:'recovered-photo',players:[]},aux:{}
    }},
    TaskPointsCore:{
      getImageBlob(id){calls.push(id);
        return recovered ? new Blob(['now present'],{type:'image/webp'}) : null;
      }
    }
  });
  const missing=await api.createExportArtifact();
  assert.equal(missing.missingImageCount,1);
  assert.equal(api.imageBlobCache.has('recovered-photo'),false,
    'negative image lookup must not be cached forever');
  recovered=true;
  const complete=await api.createExportArtifact();
  assert.equal(complete.imageCount,1);
  assert.equal(complete.missingImageCount,0);
  assert.equal(complete.payload.imageExportCoverage.complete,true);
  assert.deepEqual(Array.from(complete.payload.imageExportCoverage.missingImageIds),[]);
  assert.equal(calls.length,2);
  const manifest=await manifestFromZip(complete.blob);
  assert.equal(manifest.imageExportCoverage.complete,true);
});

test('partial photo backup visibly warns and remains downloadable; complete backup stays ordinary', async () => {
  const nodes=new Map();
  let clicked=0, hiddenWarnings=0;
  const document={
    addEventListener(){},querySelectorAll(){return []},
    getElementById(id){return nodes.get(id)||null},
    createElement(tag){
      const element={tag,style:{},hidden:false,textContent:'',
        setAttribute(){},removeAttribute(){},click(){clicked++},remove(){}};
      return element;
    },
    body:{appendChild(el){if(el.id)nodes.set(el.id,el)}},
    documentElement:{appendChild(el){if(el.id)nodes.set(el.id)}}
  };
  let missing=true;
  const payload={exportType:'taskpoints_full_backup',version:2,
    state:{tasks:[],completions:[],youImageId:'profile-image',players:[]},aux:{}};
  const {api}=install({
    document,
    getTaskPointsExportSnapshot(){return payload},
    TaskPointsCore:{
      getImageBlob(){return missing?null:new Blob(['image'],{type:'image/png'})}
    },
    setTimeout(callback,delay){
      if(delay===2500)hiddenWarnings++;
      else callback();
      return 1;
    },
    requestAnimationFrame(callback){callback();return 1}
  });

  const first=await api.startExport();
  assert.equal(first.missingImageCount,1);
  const warning=nodes.get('tpResponsiveExportStatus');
  assert.ok(warning);
  assert.match(warning.textContent,/referenced image was missing/i);
  assert.equal(warning.hidden,false);
  assert.equal(hiddenWarnings,0,'partial backup warning must not auto-hide');
  assert.equal(clicked,1,'user still receives the ZIP');

  missing=false;
  await api.startExport();
  assert.equal(clicked,2);
  assert.equal(hiddenWarnings,1);
  assert.equal(nodes.get('tpResponsiveExportStatus').textContent,'Backup ready with 1 images.');
});
