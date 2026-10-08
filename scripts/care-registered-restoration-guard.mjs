/** Windows operator mutex is released by the kernel on process loss. It
 * serializes retirement of a dead inspection guard; the admitted release lock
 * is never removed here and still needs full service reconciliation. */
import {spawn} from 'node:child_process';
import {existsSync,realpathSync,openSync,writeFileSync,fsyncSync,closeSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {sha256} from './synthetic-care-release.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {refuseRegistered} from './synthetic-care-registered-release.mjs';
import {readRegisteredReleaseBounded as bounded} from './reconcile-synthetic-care-registered-release.mjs';
import {acquireRegisteredUploadReconciliationGuard,stoppedUploadWriter} from './reconcile-synthetic-care-registered-upload.mjs';
const check=(ok,c)=>{if(!ok)refuseRegistered('restoration_guard_'+c);};
export function verifyStoppedRegisteredInspectionGuard(bytes,mtimeMs,now,stopped){
 let row;try{row=JSON.parse(bytes);}catch{refuseRegistered('restoration_guard_json');}
 check(Buffer.isBuffer(bytes)&&bytes.length<=16384&&bytes.equals(Buffer.from(JSON.stringify(row)+'\n'))
  &&canonical(Object.keys(row).sort())===canonical(['operator','pid','purpose','runId'])
  &&row.purpose==='registered-upload-reconciliation'&&Number.isSafeInteger(row.pid)&&row.pid>0
  &&/^[a-f0-9]{32}$/.test(row.runId??'')&&/^[a-f0-9]{40}$/.test(row.operator??'')
  &&Number.isFinite(now)&&Number.isFinite(mtimeMs)&&now-mtimeMs>=60000,'binding');
 check(stopped(row.pid)===true,'writer_active');return row;
}
export async function acquireRegisteredRestorationMutex(shared){
 check(process.platform==='win32','windows_operator_required');
 const name='Local\\ALPRegisteredRestoration'+sha256(realpathSync(shared).toLowerCase()),
  script=`$ErrorActionPreference='Stop'; $mutex=New-Object System.Threading.Mutex($false, '${name}'); $owned=$false; try { try { $owned=$mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned=$true }; if (!$owned) { exit 23 }; [Console]::Out.WriteLine('owned'); [Console]::Out.Flush(); [void][Console]::In.ReadLine() } finally { if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }`,
  child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let owns=false,ended=false,output='';
 const terminal=new Promise(done=>{child.once('exit',()=>{ended=true;done();});child.once('error',()=>{ended=true;done();});});
 await new Promise((done,reject)=>{
  const timer=setTimeout(()=>{child.kill();reject(Error('synthetic_care_registered_release_refused:restoration_guard_mutex_timeout'));},10000);
  const fail=()=>{clearTimeout(timer);reject(Error('synthetic_care_registered_release_refused:restoration_guard_mutex_busy'));};
  child.once('error',fail);child.once('exit',()=>{if(!owns)fail();});
  child.stdout.on('data',bytes=>{output+=bytes.toString('utf8');if(output.length>128){child.kill();fail();}
   if(output==='owned\r\n'||output==='owned\n'){owns=true;clearTimeout(timer);done();}});
  child.stderr.resume();
 });
 const verify=()=>check(owns&&!ended,'mutex_lost');
 return {verify,close:async()=>{if(!ended){const timer=setTimeout(()=>child.kill(),5000);
  try{child.stdin.end('\n');await terminal;}finally{clearTimeout(timer);}}owns=false;}};
}
export async function acquireRecoverableRegisteredInspectionGuard(shared,operator){
 const mutex=await acquireRegisteredRestorationMutex(shared);let guard;
 try{
  const file=resolve(shared,'registered-upload-reconciliation.lock');
  if(existsSync(file)){
   const {lstatSync}=await import('node:fs'),stat=lstatSync(file),bytes=bounded(file,16384);
   verifyStoppedRegisteredInspectionGuard(bytes,stat.mtimeMs,Date.now(),stoppedUploadWriter);mutex.verify();
   const archive=resolve(shared,'registered-inspection-abandoned-'+sha256(bytes)+'.json');let fd;
   try{fd=openSync(archive,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}
   catch(e){if(e?.code!=='EEXIST')throw e;}finally{if(fd!==undefined)closeSync(fd);}
   check(bounded(archive,16384).equals(bytes)&&bounded(file,16384).equals(bytes),'archive_changed');
   verifyStoppedRegisteredInspectionGuard(bytes,stat.mtimeMs,Date.now(),stoppedUploadWriter);mutex.verify();unlinkSync(file);
  }
  guard=acquireRegisteredUploadReconciliationGuard(shared,operator);
  return {...guard,verify:()=>{mutex.verify();guard.verify();},close:async()=>{try{guard.close();}finally{await mutex.close();}}};
 }catch(e){await mutex.close();throw e;}
}
