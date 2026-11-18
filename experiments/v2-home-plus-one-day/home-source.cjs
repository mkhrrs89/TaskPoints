'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const names=['addDays','dayDiff','trackDueDatePush','bumpOneDay','todayKey','dateKey','fromKey','niceDate','labelForDay','cmpImportance','escapeHtml','getTaskStatus','isTaskTrashed','taskDueMeta','taskGroupDefaultExpanded','isTaskGroupExpanded','renderTasks','getTaskCardLayoutStateInput','readHomeStateRevision','installMobileTaskSwipeDelete','isTaskSwipeRescheduleGesture','isTaskSwipeDeleteGesture','initTaskListDelegation','updateTaskActionSheetVisibility','bumpTaskOneDay'];
function extract(text,name){
 const start=text.indexOf('function '+name+'(');assert.ok(start>=0,name);
 // JavaScript's parser determines the end, including nested templates/regexes.
 for(let end=text.indexOf('}',start);end>=0;end=text.indexOf('}',end+1)){
  const source=text.slice(start,end+1);
  try{new vm.Script('('+source+')');return source;}catch(_){}
 }
 throw Error('Cannot extract actual Home function '+name);
}
function source(){
 const text=fs.readFileSync(path.join(root,'index.html'),'utf8');
 return `// These functions are taken VERBATIM from the checked-in Home page.\nconst $=id=>document.getElementById(id);\nlet state={tasks:[]},expandedTaskId='t1',editingTaskId=null,taskActionSheetTaskId=null,loadedStateRevision='';\nconst taskGroupExpandedState={later:true};\n`+names.map(n=>extract(text,n)).join('\n')+`\nwindow.RealHomeTaskSlice={setState(next){state=next;},getState(){return structuredClone(state);},render(){renderTasks(state);}};\n`;
}
module.exports={root,source,extract,names};
