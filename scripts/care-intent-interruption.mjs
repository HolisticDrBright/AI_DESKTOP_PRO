/** The original custody journal locates admitted identities; it is never
 * evidence that a remote operation succeeded or permission to repeat it. */
import {readFileSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {refuseIntent} from './synthetic-care-intent-release.mjs';
import {canonical} from './care-recovery-routing.mjs';
const check=(ok,code)=>{if(!ok)refuseIntent('interruption_'+code);};
export function verifyCareIntentInterruption(saved,events,application,candidate){
 check(saved?.purpose==='intent-artifact-upload-proposal'&&/^[a-f0-9]{32}$/.test(saved.runId??'')
  &&Number.isSafeInteger(saved.pid)&&saved.pid>0&&canonical(saved.desktop)===canonical(application.desktop)
  &&canonical(saved.mobile)===canonical(application.mobile),'custody_binding');
 const stages=['started','live_preparation_verified','artifact_put_admitted','artifact_exact_version_verified',
  'intent_live_release_started','change_set_create_admitted','change_set_observed','change_set_projection_readback',
  'dependency_live_readback_unchanged','change_set_verified_unexecuted','intent_change_execute_admitted',
  'intent_change_execute_terminal','intent_deployed_bytes_control_verified','intent_version_publish_admitted',
  'intent_retained_bytes_verified','finding'];
 check(Array.isArray(events)&&events.length===stages.length&&events.every((e,i)=>e.stage===stages[i]
  &&Number.isFinite(Date.parse(e.at))&&(i===0||Date.parse(e.at)>=Date.parse(events[i-1].at))),'journal_scope');
 const at=stage=>events.find(e=>e.stage===stage),put=at('artifact_put_admitted'),artifact=at('artifact_exact_version_verified').artifact,
  created=at('change_set_create_admitted'),set=at('change_set_observed'),executed=at('intent_change_execute_admitted'),retained=at('intent_retained_bytes_verified');
 check(events[0].runId===saved.runId&&put.key===candidate.manifest.key&&put.sha256===candidate.manifest.zipSha256
  &&artifact?.bucket===P.bucket&&artifact.key===candidate.manifest.key&&artifact.sha256===candidate.manifest.zipSha256
  &&artifact.bytes===candidate.zip.length&&typeof artifact.versionId==='string'&&artifact.versionId.length>0
  &&artifact.versionId.length<=1024&&artifact.versionId!=='null','artifact_locator');
 check(set.stackId===created.stackId&&set.name===created.name
  &&set.stackId?.startsWith(`arn:aws:cloudformation:${P.region}:${P.account}:stack/${P.stack}/`)
  &&/^care-intent-[a-f0-9]{32}$/.test(set.name??'')&&/^[a-f0-9]{64}$/.test(created.clientToken??'')
  &&created.clientToken.startsWith(set.name.slice(12))
  &&set.id?.startsWith(`arn:aws:cloudformation:${P.region}:${P.account}:changeSet/${set.name}/`)
  &&executed.stackId===set.stackId&&executed.changeSetId===set.id&&at('intent_change_execute_terminal').changeSetId===set.id,
 'execution_locator');
 check(at('intent_live_release_started').desktop===application.desktop.commit
  &&at('intent_live_release_started').mobile===application.mobile.source.commit
  &&at('intent_version_publish_admitted').zipSha256===candidate.manifest.zipSha256
  &&retained.sha256===candidate.manifest.zipSha256&&/^[1-9][0-9]{0,19}$/.test(retained.version??'')&&retained.version!=='1'
  &&events.at(-1).writeAdmitted===true
  &&events.at(-1).code==='synthetic_care_intent_release_refused:runner_transport_revision','terminal_scope');
 return {runId:saved.runId,pid:saved.pid,binding:{stackId:set.stackId,name:set.name,id:set.id},
  artifactVersion:artifact.versionId,retainedVersion:retained.version,remoteSuccessProven:false,replayAuthorized:false};
}
const boundedFile=(file,max)=>{
 const stat=lstatSync(file);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=max,'file');
 const bytes=readFileSync(file);check(bytes.length===stat.size&&bytes.length<=max,'file_read');return bytes;
};
export function careIntentProcessAbsent(pid){
 check(Number.isSafeInteger(pid)&&pid>0&&pid!==process.pid,'process');
 try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')return true;}
 refuseIntent('interruption_process_alive_or_unknown');
}
export function readCareIntentInterruption(root,directory,application,candidate){
 const lock=resolve(root,'dist/synthetic-care-routing/operator.lock'),lockBytes=boundedFile(lock,16384);
 let saved;try{saved=JSON.parse(lockBytes.toString('utf8'));}catch{refuseIntent('interruption_lock_json');}
 check(/^[a-f0-9]{32}$/.test(saved.runId??''),'run_id');
 const journal=resolve(directory,'uploads',saved.runId+'.events.jsonl'),journalBytes=boundedFile(journal,1024*1024);
 check(journalBytes.at(-1)===10,'journal_boundary');
 let events;try{events=journalBytes.toString('utf8').trimEnd().split('\n').map(s=>JSON.parse(s));}
 catch{refuseIntent('interruption_journal_json');}
 const location=verifyCareIntentInterruption(saved,events,application,candidate);careIntentProcessAbsent(saved.pid);
 return {...location,lock,journal,lockSha256:sha256(lockBytes),journalSha256:sha256(journalBytes),
  previousProcessAbsent:true,originalCustodyRetained:true};
}
