const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'..','styles.css'),'utf8');
test('SCWM explicit skip appears under +2, allows blank values and zero points',()=>{
 const a=html.indexOf('id="caloriesLogBonusToggle"'),b=html.indexOf('id="caloriesNotTrackedToggle"');
 assert.ok(a>0&&b>a&&b-a<500);
 assert.match(html,/if \(!caloriesNotTracked && rawStr === ''\)/);
 assert.match(html,/caloriesNotTracked \? 0 : caloriesToPoints\(raw\)/);
 assert.match(html,/caloriesTotalImpactPoints\(raw, calLogBonusEnabled, caloriesNotTracked\)/);
});
test('editing and re-enabling calories persists explicit tracking flag',()=>{
 assert.match(html,/id="caloriesEditNotTrackedToggle"/);
 assert.equal((html.match(/\.caloriesNotTracked = caloriesNotTracked;/g)||[]).length,5);
 assert.equal((html.match(/calLogBonusDisabled: !calLogBonusEnabled,\s*caloriesNotTracked/g)||[]).length,3);
 assert.equal((html.match(/currentNotTracked: caloriesNotTrackedForEntry\(/g)||[]).length,4);
});
test('skipped days are shown honestly and excluded from numeric trends',()=>{
 assert.match(html,/if \(!entry \|\| caloriesNotTrackedForEntry\(entry\)\) return null/);
 assert.match(html,/todayValueEl\.textContent = 'Not tracked'/);
 assert.match(html,/const cal = caloriesNotTrackedForEntry\(entry\)/);
 assert.match(css,/calories-not-tracked-value/);
});
