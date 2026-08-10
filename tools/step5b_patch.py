from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one target, found {count}")
    return text.replace(old, new, 1)


core = Path("scoring_core.js")
text = core.read_text()

text = replace_once(
    text,
    """  function packTaskPointsStorageState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
    const packed = { ...state };
""",
    """  function packTaskPointsStorageState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
    const perfEnd = global.TaskPointsPerf?.span?.('savePipeline.packTaskPointsStorageState', {
      completions: Array.isArray(state.completions) ? state.completions.length : 0,
      matchups: Array.isArray(state.matchups) ? state.matchups.length : 0,
      gameHistory: Array.isArray(state.gameHistory) ? state.gameHistory.length : 0,
      tasks: Array.isArray(state.tasks) ? state.tasks.length : 0
    });
    const packed = { ...state };
""",
    "pack start",
)

text = replace_once(
    text,
    """    return packed;
  }

  function unpackTaskPointsStorageState(rawState) {
""",
    """    perfEnd?.({ packedArrayCount: Object.keys(packedArrays).length, outcome: 'return' });
    return packed;
  }

  function unpackTaskPointsStorageState(rawState) {
""",
    "pack end",
)

text = replace_once(
    text,
    """  function compressStorageString(rawJson) {
    return TaskPointsLZString.compressToUTF16(String(rawJson || ''));
  }
""",
    """  function compressStorageString(rawJson) {
    const input = String(rawJson || '');
    const perfEnd = global.TaskPointsPerf?.span?.('savePipeline.compressStorageString', { inputLength: input.length });
    const output = TaskPointsLZString.compressToUTF16(input);
    perfEnd?.({ outputLength: output.length, outcome: 'return' });
    return output;
  }
""",
    "compress",
)

text = replace_once(
    text,
    """function buildOptimizedTaskPointsStorageRaw(state) {
  const packedState = packTaskPointsStorageState(state);
""",
    """function buildOptimizedTaskPointsStorageRaw(state) {
  const perfEnd = global.TaskPointsPerf?.span?.('savePipeline.buildOptimizedTaskPointsStorageRaw', {
    completions: Array.isArray(state?.completions) ? state.completions.length : 0,
    tasks: Array.isArray(state?.tasks) ? state.tasks.length : 0
  });
  const packedState = packTaskPointsStorageState(state);
""",
    "build start",
)

text = replace_once(
    text,
    """  return {
    packedState,
    packedRawJson,
    compressedWrapperRaw,
    chosenRaw,
    chosenEncoding: useCompressed
      ? TASKPOINTS_STORAGE_ENCODING_LZ16_PACKED_V1
      : (packedState?.__packedArrays ? 'packed-json' : 'plain-json'),
    packedRawChars: packedRawJson.length,
    compressedRawChars: compressedWrapperRaw.length,
    chosenChars: chosenRaw.length,
    chosenBytes: chosenRaw.length * 2
  };
}
""",
    """  const plan = {
    packedState,
    packedRawJson,
    compressedWrapperRaw,
    chosenRaw,
    chosenEncoding: useCompressed
      ? TASKPOINTS_STORAGE_ENCODING_LZ16_PACKED_V1
      : (packedState?.__packedArrays ? 'packed-json' : 'plain-json'),
    packedRawChars: packedRawJson.length,
    compressedRawChars: compressedWrapperRaw.length,
    chosenChars: chosenRaw.length,
    chosenBytes: chosenRaw.length * 2
  };
  perfEnd?.({
    packedRawChars: plan.packedRawChars,
    compressedRawChars: plan.compressedRawChars,
    chosenChars: plan.chosenChars,
    chosenEncoding: plan.chosenEncoding,
    outcome: 'return'
  });
  return plan;
}
""",
    "build end",
)

core.write_text(text)

perf = Path("performance_diagnostics.js")
text = perf.read_text()
text = replace_once(
    text,
    "  const desc=t=>!t?'':`${String(t.tagName||'').toLowerCase()}${t.id?`#${t.id}`:''}`.slice(0,100);\n",
    """  const desc=t=>{if(!t)return '';const tag=String(t.tagName||'').toLowerCase(),id=t.id?`#${t.id}`:'',cls=String(t.className||'').trim().split(/\\s+/).filter(Boolean).slice(0,3).map(x=>`.${x}`).join(''),attrs=[];for(const a of['data-del-id','data-task-id','data-action','data-cat','data-datekey','aria-label','title']){const v=t.getAttribute?.(a);if(v)attrs.push(`[${a}=${String(v).slice(0,45)}]`)}const label=String(t.textContent||'').trim().replace(/\\s+/g,' ').slice(0,55);return `${tag}${id}${cls}${attrs.join('')}${label?` \\"${label}\\"`:''}`.slice(0,220)};
""",
    "descriptor",
)

anchor = "  function pendingNav(){"
insert = """  function dialogTrace(){if(typeof global.confirm!=='function'||global.confirm.__tpPerfWrapped)return;const orig=global.confirm.bind(global),w=function(message){const st=now();try{return orig(message)}finally{duration('browser.confirm',now()-st,{message:String(message||'').slice(0,120)})}};Object.defineProperty(w,'__tpPerfWrapped',{value:true});global.confirm=w}
  function clickPaintTrace(){const d=global.document;if(!d?.addEventListener)return;d.addEventListener('click',e=>{if(!relevant(e.target))return;const target=e.target?.closest?.('a,button,input,textarea,select,.scoreV2-cell,.habitDay')||e.target,label=desc(target),st=now();global.requestAnimationFrame?.(()=>duration('interaction.click.toNextPaint',now()-st,{target:label}))},true)}
"""
text = replace_once(text, anchor, insert + anchor, "pendingNav anchor")

text = replace_once(
    text,
    "mark('trace.enabled',{path:page.path});pendingNav();storageTrace();jsonTrace();cloneTrace();idbTrace();interactions();observers();watchdog();navTiming();",
    "mark('trace.enabled',{path:page.path});pendingNav();storageTrace();jsonTrace();cloneTrace();idbTrace();interactions();dialogTrace();clickPaintTrace();observers();watchdog();navTiming();",
    "startup hooks",
)
perf.write_text(text)
