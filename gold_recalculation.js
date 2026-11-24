;(function installGoldReplayTool(global) {
  'use strict';
  const KEY='taskpoints_v1', HOLD='taskpoints_emergency_recovery_hold_v1';
  const TYPE='gold_recalculation_adjustment';
  const baseTypes=new Set(['manual_adjustment','season_interest','champion_bonus']);
  const money=n=>Math.round(n)/10, str=x=>String(x==null?'':x).trim();
  const dateKey=x=>str(x?.dateKey||x?.date||x?.completedAtISO||x?.finalizedAtISO||x?.createdAtISO).slice(0,10);
  const dayOK=x=>/^\d{4}-\d{2}-\d{2}$/.test(x);
  const add=(m,k,v)=>m.set(k,(m.get(k)||0)+v);
  let pending=null, saving=false;
  function tenth(n) {
    if(n==null||n===''||!Number.isFinite(Number(n))||Math.abs(Number(n)*10-Math.round(Number(n)*10))>1e-5)
      throw Error('Invalid Gold amount in saved history. No changes made.');
    return Math.round(Number(n)*10);
  }
  function localDay(d) {
    if(!(d instanceof Date)||!Number.isFinite(d.getTime()))throw Error('Invalid date.');
    return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
  }
  function throughDay(d) {
    const now=d instanceof Date?d:new Date(d);
    if(!Number.isFinite(now.getTime()))throw Error('Invalid current date.');
    return localDay(new Date(now.getFullYear(),now.getMonth(),now.getDate()-1));
  }
  function read() {
    const core=global.TaskPointsCore,storage=global.localStorage;
    if(!core||typeof core.parseTaskPointsStorageJson!=='function'
      ||typeof core.saveValidatedSnapshot!=='function'||!storage)throw Error('Protected storage is unavailable.');
    const hold=storage.getItem(HOLD);
    if(hold){try{if(JSON.parse(hold)?.active===true)throw Error('Recovery hold is active.');}
      catch(e){throw Error('Recovery hold is active or unreadable. No Gold changed.');}}
    const raw=storage.getItem(KEY);
    if(!raw)throw Error('Saved TaskPoints data is unavailable.');
    // Reading raw bytes avoids loadAppState's automatic Gold reconciliation.
    const state=core.parseTaskPointsStorageJson(raw,null);
    if(!state||typeof state!=='object')throw Error('Saved data could not be decoded.');
    return {core,storage,raw,state};
  }
  function checkLedger(s) {
    const economy=s.goldEconomy,ledger=s.goldLedger;
    if(Number(economy?.version)!==1||!dayOK(str(economy?.launchDateKey))||!Array.isArray(ledger))
      throw Error('Gold economy is not initialized.');
    const actual=new Map(),opening=new Map(),ids=new Set();
    let starts=0;
    ledger.forEach((e,i)=>{
      const who=str(e?.playerId),eid=str(e?.id);
      if(!who||!eid||ids.has(eid))throw Error('Invalid or duplicate Gold ledger ID at row '+(i+1)+'.');
      ids.add(eid);
      const n=tenth(e.amount);
      add(actual,who,n);
      if(actual.get(who)<0)throw Error('Existing Gold wallet becomes negative at row '+(i+1)+'.');
      if(e.balanceAfter==null||Math.abs(tenth(e.balanceAfter)-actual.get(who))>1)
        throw Error('Gold ledger running balance does not match at row '+(i+1)+'.');
      if(e.type==='opening_balance'){
        if(dateKey(e)!==economy.launchDateKey)throw Error('Opening balance dates differ from Gold launch.');
        add(opening,who,n);starts++;
      }else if(e.type==='matchup_margin'||e.type==='matchup_theft'||e.type===TYPE||baseTypes.has(e.type)){
        // Game rows will be replayed, other rows preserved.
      }else if(e.type==='matchup_adjustment'&&e?.meta?.reason==='retroactive_score_edit'){
        // Already reflected in the final recorded scores; exclude from replay.
      }else throw Error('Unsupported Gold transaction type '+str(e.type)+'. No changes made.');
    });
    if(!starts)throw Error('Original opening balances are missing.');
    return {actual,opening,ids};
  }
  function plan(s,options={}) {
    const until=throughDay(options.now||new Date()),launch=str(s?.goldEconomy?.launchDateKey);
    const inspected=checkLedger(s);
    if(until<launch)throw Error('No fully completed Gold-economy day exists yet.');
    const api=global.TaskPointsGreedGoldEconomy;
    if(typeof api?.collectCompleteMatchups!=='function'||typeof api?.matchupIdentity!=='function'
      ||typeof api?.effectiveTheftGreed!=='function')throw Error('Gold rules are not loaded. Refresh the page.');
    const ignored=new Set(s.goldEconomy.ignoredSameDayMatchupKeys||[]);
    const matches=[],byId=new Map();
    let conflicting=0;
    for(const m of api.collectCompleteMatchups(s)){
      const when=dateKey(m),key=api.matchupIdentity(m),gameId=str(m?.id||m?.matchupId);
      if(!key||!dayOK(when))continue;
      if(gameId&&byId.has(gameId))throw Error('Duplicate matchup ID in Gold history.');
      if(gameId)byId.set(gameId,m);
      if(when<launch||when>until||(when===launch&&ignored.has(key)))continue;
      const a=str(m.playerAId),b=str(m.playerBId);
      const va=m.scoreA==null?m.playerAScore:m.scoreA;
      const vb=m.scoreB==null?m.playerBScore:m.scoreB;
      const sa=Number(va),sb=Number(vb);
      if(!a||!b||a===b||va==null||vb==null||!Number.isFinite(sa)||!Number.isFinite(sb))
        throw Error('A completed matchup has incomplete final scores ('+when+').');
      const winner=sa===sb?'':sa>sb?a:b;
      if(m.goldOutcome?.settled&&str(m.goldOutcome.winnerId)!==winner)conflicting++;
      const stamp=str(m.completedAtISO||m.finalizedAtISO||m.recordedAtISO||m.createdAtISO
        ||(when+'T12:00:00.000Z'));
      matches.push({m,key,gameId,when,stamp,a,b,sa,sb,winner});
    }
    matches.sort((x,y)=>x.when.localeCompare(y.when)||x.stamp.localeCompare(y.stamp)||x.key.localeCompare(y.key));
    const validIds=new Set(matches.map(m=>m.gameId).filter(Boolean));
    const events=[],frozen=[];
    let external=0;
    s.goldLedger.forEach((e,i)=>{
      if(e.type==='opening_balance'||e.type===TYPE
        ||(e.type==='matchup_adjustment'&&e?.meta?.reason==='retroactive_score_edit'))return;
      const when=dateKey(e);
      if(!dayOK(when))throw Error('Gold transaction has an invalid date.');
      if(e.type==='matchup_margin'||e.type==='matchup_theft'){
        if(when<=until){
          if(when<launch||!validIds.has(str(e.matchupId)))
            throw Error('Historical Gold transaction lacks a final recorded game ('+when+').');
        }else frozen.push(e);
      }else{
        external++;
        events.push({when,stamp:str(e.createdAtISO)||when+'T12:00:00.000Z',
          key:'0:'+String(i).padStart(8,'0'),entry:e});
      }
    });
    for(const m of matches)events.push({when:m.when,stamp:m.stamp,key:'1:'+m.key,game:m});
    events.sort((a,b)=>a.when.localeCompare(b.when)||a.stamp.localeCompare(b.stamp)||a.key.localeCompare(b.key));
    const projected=new Map(inspected.opening);
    for(const ev of events){
      if(ev.entry){add(projected,str(ev.entry.playerId),tenth(ev.entry.amount));continue;}
      const m=ev.game;if(!m.winner)continue;
      const loser=m.winner===m.a?m.b:m.a;
      const margin=Math.round(Math.abs(m.sa-m.sb)+Number.EPSILON);
      const loserGold=Math.max(0,projected.get(loser)||0);
      const greed=Math.min(100,Math.max(0,Number(api.effectiveTheftGreed(s,m.winner,m.m))||0));
      const stolen=Math.min(loserGold,Math.round(loserGold*greed/100*0.10+Number.EPSILON));
      add(projected,m.winner,margin+stolen);
      add(projected,loser,-stolen);
    }
    // Preserve (rather than resettle) today's provisional transaction rows.
    for(const e of frozen)add(projected,str(e.playerId),tenth(e.amount));
    const names=new Map((Array.isArray(s.players)?s.players:[])
      .map(p=>[str(p?.id||p?.playerId),str(p?.name)]));
    const changes=[];
    for(const who of new Set([...projected.keys(),...inspected.actual.keys()])){
      const before=inspected.actual.get(who)||0,after=projected.get(who)||0;
      if(after<0||after>10000000)throw Error('Unsafe projected wallet for '+(names.get(who)||who)+'.');
      if(before!==after)changes.push({playerId:who,name:who==='YOU'?(str(s.youName)||'You'):(names.get(who)||who),
        before:money(before),after:money(after),delta:money(after-before)});
    }
    changes.sort((a,b)=>a.playerId==='YOU'?-1:b.playerId==='YOU'?1:
      Math.abs(b.delta)-Math.abs(a.delta)||a.name.localeCompare(b.name));
    return {launch,until,changes,stats:{games:matches.length,incorrectResults:conflicting,
      affected:changes.length,frozenTransactions:frozen.length,externalTransactions:external,
      totalChange:money(changes.reduce((n,r)=>n+tenth(r.delta),0))}};
  }
  function preview(options={}) {
    const current=read(),result=plan(current.state,options);
    pending={raw:current.raw,result};return result;
  }
  function commit(approved=pending){
    if(saving)throw Error('A recalculation is already saving.');
    if(!approved?.raw||!approved?.result)throw Error('Preview before confirming.');
    if(!approved.result.changes.length)throw Error('No Gold corrections are needed.');
    saving=true;
    try{
      const latest=read();
      if(latest.raw!==approved.raw)throw Error('Your saved data changed. Run a fresh preview.');
      const verified=plan(latest.state);
      if(JSON.stringify(verified)!==JSON.stringify(approved.result))
        throw Error('The projected correction changed. Run a fresh preview.');
      const runId=typeof global.crypto?.randomUUID==='function'
        ?global.crypto.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
      const timestamp=new Date().toISOString(),today=localDay(new Date());
      const balances=new Map();
      latest.state.goldLedger.forEach(e=>add(balances,str(e.playerId),tenth(e.amount)));
      const existing=new Set(latest.state.goldLedger.map(e=>str(e.id)));
      const adjustments=verified.changes.map(row=>{
        const key='gold:recalculation:'+runId+':'+encodeURIComponent(row.playerId);
        if(existing.has(key))throw Error('A correction ID collided with saved history.');
        add(balances,row.playerId,tenth(row.delta));
        return {id:key,type:TYPE,playerId:row.playerId,opponentId:'',matchupId:'',seasonId:'',
          dateKey:today,createdAtISO:timestamp,amount:row.delta,balanceAfter:money(balances.get(row.playerId)),
          meta:{reason:'historical_gold_replay',runId,launchDateKey:verified.launch,
            throughDateKey:verified.until,oldBalance:row.before,correctedBalance:row.after,
            gamesReplayed:verified.stats.games}};
      });
      const candidate={...latest.state,goldLedger:[...latest.state.goldLedger,...adjustments]};
      if(latest.storage.getItem(KEY)!==latest.raw)throw Error('Saved data changed. Preview again.');
      const answer=latest.core.saveValidatedSnapshot(candidate,{storageKey:KEY,immediateWrite:true,
        savePath:'gold-recalculation',source:'gold-recalculation'});
      if(!answer||answer.blocked||answer.skipped||answer.blockedByQuotaCircuit||answer.ok===false)
        throw Error('The protected save did not accept this correction.');
      const raw=latest.storage.getItem(KEY);
      const saved=raw&&latest.core.parseTaskPointsStorageJson(raw,null);
      if(!saved||!Array.isArray(saved.goldLedger)
        ||saved.goldLedger.length!==candidate.goldLedger.length)
        throw Error('The correction could not be verified. Inspect saved Gold before retrying.');
      const rows=new Map(saved.goldLedger.map(e=>[str(e.id),e]));
      if(!latest.state.goldLedger.every(e=>JSON.stringify(rows.get(str(e.id)))===JSON.stringify(e))
        ||!adjustments.every(e=>rows.has(e.id)&&tenth(rows.get(e.id).amount)===tenth(e.amount)
          &&tenth(rows.get(e.id).balanceAfter)===tenth(e.balanceAfter)))
        throw Error('Gold verification failed. Inspect saved history before retrying.');
      pending=null;
      return {state:saved,adjustments,stats:verified.stats};
    }finally{saving=false;}
  }
  function escape(text){return str(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function install(){
    const doc=global.document;
    const previewBtn=doc?.getElementById?.('goldRecalcPreviewButton');
    const saveBtn=doc?.getElementById?.('goldRecalcApplyButton');
    const results=doc?.getElementById?.('goldRecalcResults');
    const status=doc?.getElementById?.('goldRecalcStatus');
    if(!previewBtn||!saveBtn||!results||!status)return;
    let shown=null;
    const notice=(text,error=false)=>{status.textContent=text;status.classList.toggle('gold-manual-error',error);};
    previewBtn.addEventListener('click',()=>{
      shown=null;saveBtn.disabled=true;results.replaceChildren();
      try{
        const r=preview(),t=r.stats;
        shown=pending;
        const you=r.changes.find(x=>x.playerId==='YOU');
        results.innerHTML='<p><strong>Games replayed:</strong> '+t.games+
          ' · <strong>Results corrected:</strong> '+t.incorrectResults+
          ' · <strong>Wallets changed:</strong> '+t.affected+
          ' · <strong>Net Gold change:</strong> '+(t.totalChange>0?'+':'')+t.totalChange.toFixed(1)+'</p>'+
          '<p><strong>Your Gold:</strong> '+(you?(you.before.toFixed(1)+' → '+you.after.toFixed(1)):'No change')+'</p>'+
          (t.frozenTransactions?'<p><strong>Unfinished-day caution:</strong> '+t.frozenTransactions+
            ' Gold entries from today or later are preserved unchanged; run another preview after the day ends.</p>':'')+
          (r.changes.length?'<div class="gold-table-wrap"><table class="gold-table"><thead><tr><th>Player</th><th>Current</th><th>Recalculated</th><th>Change</th></tr></thead><tbody>'+
            r.changes.map(x=>'<tr><td>'+escape(x.name)+'</td><td>'+x.before.toFixed(1)+
              '</td><td>'+x.after.toFixed(1)+'</td><td class="gold-amount '+(x.delta<0?'negative':'positive')+'">'+
              (x.delta>0?'+':'')+x.delta.toFixed(1)+'</td></tr>').join('')+'</tbody></table></div>':
            '<p>No correction is needed.</p>');
        saveBtn.disabled=!r.changes.length;
        notice('Read-only preview. Nothing has been changed.');
      }catch(e){notice(e?.message||String(e),true);}
    });
    saveBtn.addEventListener('click',()=>{
      if(!shown||saveBtn.disabled||saving)return;
      const r=shown.result, you=r.changes.find(x=>x.playerId==='YOU');
      const question='Apply '+r.changes.length+' Gold wallet correction(s) through '+r.until+'?\n'+
        (you?'Your Gold: '+you.before.toFixed(1)+' → '+you.after.toFixed(1)+'\n':'')+
        'Original transactions will be kept. Have you exported a current backup?';
      if(!global.confirm?.(question))return;
      saveBtn.disabled=true;
      try{
        const saved=commit(shown);shown=null;
        notice('Verified: '+saved.adjustments.length+' corrections saved; original transactions preserved.');
        global.dispatchEvent?.(new CustomEvent('taskpoints:gold-manual-adjusted',
          {detail:{state:saved.state,source:'gold-recalculation'}}));
      }catch(e){shown=null;results.replaceChildren();notice(e?.message||String(e),true);}
    });
  }
  const api={plan,preview,commit,readLatest:read,throughDay};
  global.TaskPointsGoldRecalculation=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(global.document?.readyState==='loading')
    global.document.addEventListener('DOMContentLoaded',install,{once:true});
  else install();
})(typeof window !== 'undefined' ? window : globalThis);
