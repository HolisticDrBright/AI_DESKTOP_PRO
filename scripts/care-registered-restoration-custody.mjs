/** Append-only restoration suffix. The original failed journal prefix is
 * retained byte for byte; admissions never certify a service response. */
import {sha256} from './synthetic-care-release.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {assertCareRegisteredCurrent,refuseRegistered} from './synthetic-care-registered-release.mjs';
const check=(ok,c)=>{if(!ok)refuseRegistered('restoration_custody_'+c);};
const equal=(a,b)=>canonical(a)===canonical(b);
const fields={registered_stopped_restoration_started:['originalJournalSha256','operatorSource','pid'],
 registered_stopped_return_admitted:['previousDeployment'],registered_stopped_permission_remove_admitted:['revision'],
 registered_stopped_restoration_observed:['controlSha256','databaseSha256']};
export function splitRegisteredRestorationJournal(bytes,current,now){
 check(Buffer.isBuffer(bytes)&&bytes.length<=1024*1024&&bytes.at(-1)===10,'bytes');
 let rows;try{rows=bytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);}catch{refuseRegistered('restoration_custody_json');}
 check(bytes.equals(Buffer.from(rows.map(r=>JSON.stringify(r)).join('\n')+'\n')),'encoding');
 const index=rows.findIndex(e=>Object.hasOwn(fields,e.stage));
 if(index<0)return {originalJournalBytes:bytes,restoration:null};
 const originalJournalBytes=Buffer.from(rows.slice(0,index).map(r=>JSON.stringify(r)).join('\n')+'\n'),events=rows.slice(index);
 check(index>0&&events.length>=1&&events.length<=4&&events[0].stage==='registered_stopped_restoration_started','order');
 const first=events[0];assertCareRegisteredCurrent(first.operatorSource);
 check(first.originalJournalSha256===sha256(originalJournalBytes)&&Number.isSafeInteger(first.pid)&&first.pid>0
  &&equal(first.operatorSource.mobile,current.mobile)&&equal(first.operatorSource.migrations,current.migrations)
  &&first.operatorSource.templateSha256===current.templateSha256,'binding');
 let state='start',prior=Date.parse(rows[index-1].at);check(Number.isFinite(prior),'original_time');
 for(const e of events){
  check(Object.hasOwn(fields,e.stage)&&equal(Object.keys(e).sort(),['at','stage',...fields[e.stage]].sort()),'fields');
  const t=Date.parse(e.at);check(Number.isFinite(t)&&t>=prior&&t<=now,'time');
  if(e===first)check(t-prior>=60000,'original_settlement');
  else if(e.stage==='registered_stopped_return_admitted'){
   check(state==='start'&&/^[A-Za-z0-9_-]{1,128}$/.test(e.previousDeployment??''),'return');state='return';
  }else if(e.stage==='registered_stopped_permission_remove_admitted'){
   check(['start','return'].includes(state)&&typeof e.revision==='string'&&e.revision.length>0&&e.revision.length<=128,'permission');state='remove';
  }else if(e.stage==='registered_stopped_restoration_observed'){
   check(['start','return','remove'].includes(state)&&[e.controlSha256,e.databaseSha256].every(v=>/^[a-f0-9]{64}$/.test(v??'')),'observed');state='observed';
  }else check(e===first,'duplicate_start');
  prior=t;
 }
 return {originalJournalBytes,restoration:{events,pid:first.pid,operatorSource:first.operatorSource,
  originalJournalSha256:first.originalJournalSha256,lastAt:prior,returnAdmission:events.find(e=>e.stage==='registered_stopped_return_admitted'),
  permissionAdmission:events.find(e=>e.stage==='registered_stopped_permission_remove_admitted'),observed:state==='observed'}};
}
