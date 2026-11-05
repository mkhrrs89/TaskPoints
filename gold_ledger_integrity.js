;(function installTaskPointsGoldLedgerIntegrity(global) {
  'use strict';
  function dateOf(row) {
    for (const value of [row?.dateKey,row?.date,row?.completedAtISO,row?.finalizedAtISO,row?.recordedAtISO,row?.createdAtISO]) {
      const key=String(value||'').slice(0,10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
    }
    return '';
  }
  function analyzeGoldLedger(state) {
    const s=state&&typeof state==='object'?state:{};
    const start=String(s.goldEconomy?.launchDateKey||'').slice(0,10);
    const ledger=Array.isArray(s.goldLedger)?s.goldLedger:[];
    const indexed=new Set(ledger.filter(row=>row?.type==='matchup_theft'&&Number(row.amount)>0&&row.matchupId&&row.playerId)
      .map(row=>String(row.matchupId)+'|'+String(row.playerId)));
    const seen=new Set(), historical=[],missing=[],unresolved=[];
    const visit=rows=>(Array.isArray(rows)?rows:[]).forEach(row=>{
      const result=row?.goldOutcome;
      const amount=Number(result?.theftGoldStolen);
      if(result?.settled!==true||!Number.isFinite(amount)||amount<=0)return;
      const winner=String(result.winnerId||'').trim();
      const loser=String(result.loserId||'').trim();
      const match=String(row.id||row.matchupId||'').trim();
      if(!winner||!loser||!match)return;
      const dateKey=dateOf(row);
      const key=match+'|'+winner+'|'+dateKey;
      if(seen.has(key)||indexed.has(match+'|'+winner))return;
      seen.add(key);
      const item={playerId:winner,opponentId:loser,matchupId:match,dateKey,amount:Math.round(amount*10)/10};
      if(!start||!dateKey)unresolved.push(item);
      else if(dateKey<start)historical.push(item);
      else missing.push(item);
    });
    visit(s.matchups);visit(s.gameHistory);visit(s.currentSeason?.tournamentMatchupResults);
    (Array.isArray(s.seasonHistory)?s.seasonHistory:[]).forEach(x=>visit(x?.tournamentMatchupResults));
    (Array.isArray(s.schedule)?s.schedule:[]).forEach(x=>visit(x?.matchups));
    const order=(a,b)=>b.amount-a.amount||String(b.dateKey).localeCompare(String(a.dateKey));
    historical.sort(order);missing.sort(order);
    return {
      launchDateKey:start,
      ledgerCount:ledger.length,
      historical,missing,unresolved,
      metadataIssue:ledger.length>0&&(!start||!Number.isFinite(Number(s.goldEconomy?.version)))
    };
  }
  const api={analyzeGoldLedger};
  global.TaskPointsGoldLedgerIntegrity=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
