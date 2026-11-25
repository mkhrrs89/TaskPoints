(() => {
  'use strict';
  const api=window.SyntheticCapture,$=id=>document.getElementById(id);
  let busy=false,controller=null,downloadUrl=null,packageText=null;
  const actions=['inspect','seed','capture','compare','file','share'];
  function status(id,text,pass=false){$(id).textContent=text;$(id).className=pass?'pass':'fail';}
  function clearExport(){
    const hadPackage=!!packageText;
    if(downloadUrl)URL.revokeObjectURL(downloadUrl);
    downloadUrl=null;packageText=null;$('download').hidden=true;$('download').removeAttribute('href');$('share').hidden=true;
    if(hadPackage)status('exportStatus','NOT READY — previous export cleared. Prepare a new export.');
  }
  function invalidate(){controller?.abort();clearExport();status('exportStatus','NOT READY — capture interrupted or page reopened. Prepare a new export.');}
  function lock(value){busy=value;for(const id of actions)$(id).disabled=value;$('cancel').disabled=!controller;}
  async function action(where,fn){if(busy)return;lock(true);try{await api.guard();await fn();}catch(e){clearExport();if(where==='verifyStatus')$('details').textContent='';status(where,'FAIL — '+e.message);}finally{controller=null;lock(false);}}
  async function show(){
    const result=await api.inspect();
    $('identity').textContent=result.data?.identity.id||'No synthetic records yet';
    $('createdMode').textContent=result.data?.identity.createdAs||'Not created';
    $('preview').hidden=true;
    if(result.complete){
      $('preview').src='data:image/png;base64,'+api.PNG;
      await $('preview').decode();$('preview').hidden=false;
      status('health','PASS — 3 localStorage records, 2 database records and 1 image are complete. Image decoded.',true);
    }else {clearExport();status('health',result.empty?'NOT TESTED — create synthetic records to begin.':'FAIL — incomplete creation. Export is blocked. Use Create or resume to fill missing synthetic records.');}
    return result;
  }
  $('origin').textContent=location.origin;$('mode').textContent=api.mode();
  $('inspect').onclick=()=>action('health',show);
  $('seed').onclick=()=>action('health',async()=>{clearExport();await api.seed();await show();});
  $('compare').onclick=()=>action('comparison',async()=>{
    const current=await api.inspect(),other=$('other').value.trim();
    if(!current.complete)throw Error('Create and check this app’s records first.');
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(other))throw Error('Enter the full Storage ID from the other app on this website.');
    status('comparison',current.data.identity.id===other?'OBSERVED: same Storage ID. Shared or copied fixture; not proof of independent storage.':'OBSERVED: different Storage IDs. Separate fixture identities on this website.',true);
  });
  $('capture').onclick=()=>action('exportStatus',async()=>{
    clearExport();controller=new AbortController();$('cancel').disabled=false;
    status('exportStatus','Preparing… no file is ready yet.');
    const text=await api.capture(controller.signal,msg=>status('exportStatus',msg));
    packageText=text;downloadUrl=URL.createObjectURL(new Blob([text],{type:'application/json'}));
    $('download').href=downloadUrl;$('download').hidden=false;
    const file=new File([text],'taskpoints-synthetic-capture.json',{type:'application/json'});
    $('share').hidden=!(navigator.canShare&&navigator.canShare({files:[file]}));
    status('exportStatus','PASS — complete synthetic package prepared; source records unchanged during checks. Save it, then reopen the saved file below.',true);
  });
  $('cancel').onclick=()=>invalidate();
  // Invoke native sharing directly in the click gesture (important on iOS).
  // This shares only an already validated in-memory synthetic package.
  $('share').onclick=async()=>{
    if(busy||!packageText)return;
    const file=new File([packageText],'taskpoints-synthetic-capture.json',{type:'application/json'});
    lock(true);
    try{await navigator.share({files:[file],title:'Synthetic capture test'});
      status('exportStatus','Share action finished. Reopen the saved file below to verify it.',true);
    }catch(e){status('exportStatus','Share did not finish. Prepare again or use Download, then verify the saved file.');}
    finally{lock(false);}
  };
  $('file').onchange=()=>action('verifyStatus',async()=>{
    const file=$('file').files[0];$('details').textContent='';
    status('verifyStatus','Checking selected file…');
    try{
      if(!file||file.size>api.MAX)throw Error('Choose a synthetic package smaller than 64 KiB.');
      const body=await api.verify(await file.text());
      const img=new Image();img.src='data:image/png;base64,'+body.data.database.stores[0].records[0].base64;await img.decode();
      $('details').textContent=JSON.stringify({sourceWebsite:body.sourceOrigin,capturedAs:body.capturedAs,storageID:body.data.identity.id,firstCreatedAs:body.data.identity.createdAs,localStorageRecords:3,databaseRecords:2,images:1,imageDecoded:true,syntheticOnly:true},null,2);
      status('verifyStatus','PASS — saved file reopened; checksum, every synthetic record and image bytes verified. Nothing imported.',true);
    }finally{$('file').value='';}
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&(controller||downloadUrl))invalidate();});
  window.addEventListener('pagehide',invalidate);
  window.addEventListener('pageshow',event=>{if(event.persisted){invalidate();status('verifyStatus','NOT TESTED — verify the saved file again after returning.');$('details').textContent='';}});
  action('health',show);
})();
