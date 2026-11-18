(() => {
  'use strict';
  const $=id=>document.getElementById(id),guard=window.CaptureReadOnly;
  // Use the existing codec/catalog/export/validator; never expose restore here.
  const transfer=window.TransferRehearsal;delete window.TransferRehearsal;
  let sequence=0,objectUrl=null,busy=false,currentAbort=null;
  function discard(){sequence++;currentAbort?.abort();currentAbort=null;if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=null;$('download').hidden=true;$('download').removeAttribute('href');}
  function cancel(){discard();$('status').textContent='REFUSED — capture interrupted; prepare a new package.';}
  const check=n=>{guard.assertClean();if(n!==sequence||document.hidden)throw Error('Capture interrupted; no package ready.');};
  async function capture(){
    discard();const n=sequence,abort=new AbortController();currentAbort=abort;
    const interrupted=new Promise((_,reject)=>abort.signal.addEventListener('abort',()=>reject(Error('Capture interrupted; no package ready.')),{once:true}));
    const work=(async()=>{
      await guard.ready;check(n);
      // Empty/wrong contexts must not silently become a successful empty export.
      // Presence is only a prerequisite, NOT proof of context identity or health.
      if(localStorage.getItem('taskpoints_v1')===null)throw Error('TaskPoints canonical key absent; source context is unverified. No archive fallback.');
      const text=await transfer.exportPackage();check(n);
      const parsed=await transfer.verifyPackage(text);check(n);
      // Third read covers drift while checksumming/validating. No atomic-snapshot claim.
      const current=await transfer.capture();check(n);
      if(JSON.stringify(current)!==JSON.stringify(parsed.data))throw Error('Source changed before package release.');
      return text;
    })();
    try{return await Promise.race([work,interrupted]);}
    finally{if(currentAbort===abort)currentAbort=null;}
  }
  async function verify(text){await guard.ready;guard.assertClean();return transfer.verifyPackage(text);}
  window.TaskPointsCaptureOnly=Object.freeze({capture,verify,cancel});
  $('capture').onclick=async()=>{
    if(busy)return;busy=true;$('capture').disabled=true;$('file').disabled=true;$('cancel').disabled=false;
    $('status').textContent='Reading source only…';
    try{
      const text=await capture();guard.assertClean();
      objectUrl=URL.createObjectURL(new Blob([text],{type:'application/json'}));
      $('download').href=objectUrl;$('download').hidden=false;
      $('status').textContent='PASS — complete package prepared; source checks unchanged. Save and reopen the file.';
    }catch(e){discard();$('status').textContent='REFUSED — '+e.message;}
    finally{busy=false;$('capture').disabled=false;$('file').disabled=false;$('cancel').disabled=true;}
  };
  $('cancel').onclick=cancel;
  $('file').onchange=async()=>{
    $('details').textContent='';$('verification').textContent='Checking saved file…';
    try{
      const file=$('file').files[0];if(!file||file.size>64*1024*1024)throw Error('Missing/oversized file');
      const p=await verify(await file.text());
      $('details').textContent=JSON.stringify({format:p.format,sourceOrigin:p.sourceOrigin,localStorageKeys:p.data.local.length,archivedSessionKeys:p.data.session.length,databases:p.data.databases.map(d=>({name:d.name,stores:d.stores.length}))},null,2);
      $('verification').textContent='PASS — checksum and complete encoded contents verified; nothing restored or replayed.';
    }catch(e){$('verification').textContent='REFUSED — '+e.message;}
    finally{$('file').value='';}
  };
  document.addEventListener('visibilitychange',()=>{if(document.hidden)cancel();});
  window.addEventListener('pagehide',cancel);
  window.addEventListener('pageshow',event=>{if(event.persisted){cancel();$('verification').textContent='Not verified after returning; reopen the saved file.';$('details').textContent='';}});
  (async()=>{
    try{
      if(!guard||!transfer)throw Error('Capture modules missing.');
      await guard.ready;guard.assertClean();
      $('entry').textContent='PASS — capture-only entry loaded. Ordinary TaskPoints scripts are absent.';
      $('mode').textContent='Context: '+(navigator.standalone===true||matchMedia('(display-mode: standalone)').matches?'Home Screen':'browser')+' · '+location.origin;
      $('capture').disabled=false;$('file').disabled=false;
    }catch(e){$('entry').textContent='REFUSED — '+e.message;}
  })();
})();
