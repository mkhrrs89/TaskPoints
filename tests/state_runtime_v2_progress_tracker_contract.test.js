'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const file=path.join(root,'V2-PROGRESS-TRACKER.md');
const source=fs.readFileSync(file,'utf8');

const expected=[
  ...Array.from({length:8},(_,i)=>'P'+String(i+1).padStart(2,'0')),
  ...Array.from({length:9},(_,i)=>'M'+String(i+1).padStart(2,'0')),
  ...Array.from({length:6},(_,i)=>'C'+String(i+1).padStart(2,'0'))
];
const rows=source.split('\n').filter(line=>/^\| [PMC]\d{2} \| /.test(line))
  .map(line=>{
    const cells=line.split('|').slice(1,-1).map(x=>x.trim());
    return {id:cells[0],status:cells[1],condition:cells[2],evidence:cells[3]};
  });

test('V2 tracker has a fixed, nonduplicated 23-checkpoint baseline',()=>{
  assert.deepEqual(rows.map(row=>row.id),expected,
    'changing a checkpoint/denominator requires an explicit tracker-schema revision');
  assert.equal(new Set(rows.map(row=>row.id)).size,23);
  assert.ok(source.includes('Stable IDs:')||source.includes('**Stable IDs:**'));
  assert.match(source,/Do not silently add\/remove\/split\/rename requirements/);
});

test('tracker scoreboard is derived from actual statuses rather than guessed progress',()=>{
  const statuses=new Set(['Verified','Working','Open','Blocked']);
  for(const row of rows){
    assert.ok(statuses.has(row.status),'unknown tracker status: '+row.status);
    assert.ok(row.condition.length>45,'checkpoint pass condition missing: '+row.id);
    assert.ok(row.evidence.length>24,'checkpoint blocker/evidence missing: '+row.id);
  }
  const count=status=>rows.filter(x=>x.status===status).length;
  const verified=count('Verified'), working=count('Working');
  const open=count('Open')+count('Blocked');
  assert.match(source,new RegExp('\\*\\*'+verified+' \\/ '+rows.length+'\\*\\*'));
  assert.match(source,new RegExp('\\*\\*'+working+'\\*\\*\\s*\\| Work has begun'));
  assert.match(source,new RegExp('\\*\\*'+open+'\\*\\*\\s*\\| No complete evidence'));
  assert.equal(verified+working+open,rows.length);
  assert.ok(rows.filter(r=>r.status==='Verified').every(r=>r.id.startsWith('P')),
    'no live migration can be certified solely from preview contracts');
  assert.ok(rows.filter(r=>/^M|^C/.test(r.id)&&r.status==='Verified').length===0,
    'a live milestone needs more than the current preview evidence');
});

test('every marked preview checkpoint links to a real tracked test file',()=>{
  for(const row of rows.filter(r=>r.status==='Verified')){
    const matches=[...row.evidence.matchAll(/\]\((tests\/[^)]+\.test\.js)\)/g)]
      .map(m=>m[1]);
    assert.ok(matches.length,'missing in-repo test evidence for '+row.id);
    for(const reference of matches)
      assert.ok(fs.existsSync(path.join(root,reference)),
        'missing test file: '+reference);
  }
});

test('tracker cannot silently treat preview successes as authority/cutover readiness',()=>{
  assert.match(source,/\*\*0 \/ 12 points credited\*\*/);
  assert.match(source,/\*\*67 \/ 100 points\*\*/);
  assert.match(source,/Former "98% to escaping 67%"/);
  assert.match(source,/Withdrawn/);
  assert.match(source,/V1 remains the only live storage authority/);
  assert.match(source,/Production legacy-writer exclusion and generation fencing/);
  assert.match(source,/Physical iPhone standalone Safari/);
  assert.match(source,/Explicitly authorized final cutover/);
});
