/** Fixed synthetic target; rollback only, under the actual shared routing lock.
 * No environment target override, SQL argument, upgrade, deployment or activation. */
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {existsSync,lstatSync,realpathSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {careSourceSnapshot,CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {observeSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
import {acquireRegisteredRestorationMutex} from './care-registered-restoration-guard.mjs';
import {boundedCatalogFile as bounded,saveCatalogBytes,createCatalogRollbackCustody,refuseCatalogRollback as fail} from './catalog-forward-rollback-custody.mjs';
const check=(v,c)=>{if(!v)fail(c);};
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function catalogRollbackArguments(args){check(args.length===1&&[
 '--rehearse-fictional-catalog-rollback-only','--qualify-fictional-catalog-lock-admission-only'].includes(args[0]),'arguments');
 return args[0]==='--qualify-fictional-catalog-lock-admission-only'?'lock-admission':'rollback';}
export function verifyCatalogRollbackBuild(m,bytes,source,mode='rollback'){
 check(['rollback','lock-admission'].includes(mode),'mode');
 check(m?.contract==='catalog-forward-rollback-build/1'&&m.sourceCommit===source.commit&&m.clean===true&&m.sha256===sha256(bytes)
  &&m.execution==='synthetic-staging'&&m.phiAllowed===false&&m.coreSourceCount===47&&m.coreLiveCount===48
  &&m.referenceBeforeCount===2&&m.referenceCandidateCount===3
  &&m.referenceBeforeSha256==='83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62'
  &&m.referenceCandidateSha256==='80027d6da351b0756385ba4d68c04dfb7397b21b058e5d341ce625a4c9b1611a'
  &&m.candidateSqlSha256==='3d63f4a04b8168818844736ea5143115ca1e01fc9b2c96f0da6d5889938a6117'
  &&m.rollbackRehearsalAvailable===true&&m.readOnly===false&&(mode==='rollback'||m.lockAdmissionQualificationAvailable===true)
  &&['lastingApplyAvailable','canonicalRegistered','databaseMutationPerformed','hostedAcceptance','activationApproved'].every(k=>m[k]===false),'build_binding');
}
export function verifyCatalogRollbackControl(r){
 const f=r.fn,i=r.integration,e=f?.Environment?.Variables;
 check(f?.FunctionName===P.functionName&&f.Version==='$LATEST'&&f.State==='Active'&&f.LastUpdateStatus==='Successful'
  &&f.CodeSha256==='KF8z0MAz0mazT+u/UzNuHxhThz0xwpE48/yS5SlBsPw='
  &&f.RevisionId==='531d8866-f650-4751-a89d-dceef74fc153'
  &&e?.CLINICAL_DATABASE_NAME===P.database&&e.CLINICAL_DATABASE_CLUSTER_ARN===P.cluster&&e.CLINICAL_DATABASE_SECRET_ARN===P.secret
  &&i?.IntegrationId==='2k0pka6'&&i.IntegrationUri===`arn:aws:lambda:${P.region}:${P.account}:function:${P.functionName}`
  &&r.retainedPermissionAbsent===true,'control_binding');
 return {configurationSha256:sha256(JSON.stringify(f)),integrationSha256:sha256(JSON.stringify(i)),
  permissionSha256:sha256(JSON.stringify(r.permission)),retainedPermissionAbsent:true};
}
async function main(){
 const mode=catalogRollbackArguments(process.argv.slice(2));
 const root=realpathSync(process.cwd()),source=careSourceSnapshot(root,'desktop');
 const custodyRoot=realpathSync(resolve(root,'..','DESKTOP_COMMERCIAL_20261005'));
 check(careSourceSnapshot(custodyRoot,'desktop').commit==='c7e1840b9cd58086d077e54d224784a273246d77','custody_source');
 const shared=resolve(custodyRoot,'dist/synthetic-care-routing');
 check(lstatSync(shared).isDirectory()&&!lstatSync(shared).isSymbolicLink(),'shared_directory');
 // This is a fixed observed recovery result, not caller-supplied approval.
 const recoveryDir=resolve(custodyRoot,'dist/synthetic-care-standalone-operations',
  '9597fcb709482c8eb9bedb2841b27993844a4a6e','38ea48c07dc7d4ca7c2c37962b2a50ac178e381b',
  '285f33d0c033d266b34febbf53336e1f1853873d31c29138f3fc92e52941b0fc');
 const settled=bounded(resolve(recoveryDir,'5d858e9eaef91df48215df1d8fed39c9.standalone-settled-lock.json'),16384);
 check(JSON.parse(settled).runId==='5d858e9eaef91df48215df1d8fed39c9','recovery_archive');
 const recovery=bounded(resolve(recoveryDir,'5d858e9eaef91df48215df1d8fed39c9.standalone-rehearsal-95e7855acb9e7af1bb823d99b8c538b8f0a9246d3ef27d851baad120e01bea7d.json'));
 check(sha256(recovery)==='03d6c2aeefd10548362dfc1795d86655cb587c35dfa25f6c021f0c816e329760','recovery_bytes');
 observeSyntheticMemberIdentity();
 execFileSync(process.execPath,[resolve(root,'scripts/build-catalog-forward-inspector.mjs'),'--rollback-rehearsal'],
  {cwd:root,windowsHide:true,timeout:30000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
 const directory=resolve(root,'dist/aws-clinical-core/catalog-forward-rollback'),moduleFile=resolve(directory,'index.cjs');
 verifyCatalogRollbackBuild(JSON.parse(bounded(resolve(directory,'artifact-manifest.json')).toString('utf8')),bounded(moduleFile,16*1024*1024),source,mode);
 const port=createRequire(import.meta.url)(moduleFile);
 check(typeof port.inspectCatalogForwardDatabase==='function'&&typeof port.rehearseCatalogForwardDatabase==='function'
  &&(mode==='rollback'||typeof port.qualifyCatalogLockDatabase==='function'),'database_port');
 const out=resolve(directory,'runs');mkdirSync(out,{recursive:true});
 const mutex=await acquireRegisteredRestorationMutex(shared);let guard,owned;
 try{
  const guardFile=resolve(shared,'registered-upload-reconciliation.lock');
  // No deletion of an abandoned guard here: uncertain work must be reconciled.
  check(!existsSync(guardFile)&&!existsSync(resolve(shared,'operator.lock')),'operator_active');
  const bytes=Buffer.from(JSON.stringify({purpose:'registered-upload-reconciliation',pid:process.pid,runId:randomBytes(16).toString('hex'),operator:source.commit})+'\n');
  let fd;try{fd=openSync(guardFile,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}
  guard={verify:()=>{mutex.verify();check(bounded(guardFile,16384).equals(bytes),'guard_changed');},close:()=>{guard.verify();unlinkSync(guardFile);}};
  owned=createCatalogRollbackCustody(shared,out,source,guard,Date.now(),process.pid,mode);
  const verify=()=>owned.verify();
  const unchanged=()=>{verify();check(eq(careSourceSnapshot(root,'desktop'),source),'source_changed');
   check(careSourceSnapshot(custodyRoot,'desktop').commit==='c7e1840b9cd58086d077e54d224784a273246d77','custody_source_changed');};
  const aws=args=>{verify();observeSyntheticMemberIdentity();
   check(!Object.entries(process.env).some(([key,value])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(key)&&value),'endpoint_override');
   return JSON.parse(execFileSync('aws',[...args,'--profile',profile,'--region',P.region,'--output','json','--no-cli-pager'],
    {windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe'],
     env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',AWS_PAGER:''}}));};
  const control=()=>{
   let retainedPermissionAbsent=false;
   try{aws(['lambda','get-policy','--function-name',P.functionName,'--qualifier','2']);}
   catch(e){check(e?.status===254&&/\(ResourceNotFoundException\)/.test(String(e.stderr??'')),'permission_absence_unconfirmed');retainedPermissionAbsent=true;}
   return verifyCatalogRollbackControl({retainedPermissionAbsent,
    fn:aws(['lambda','get-function-configuration','--function-name',P.functionName]),
    integration:aws(['apigatewayv2','get-integration','--api-id',P.apiId,'--integration-id','2k0pka6']),
    permission:aws(['lambda','get-policy','--function-name',P.functionName])});};
  unchanged();const beforeControl=control(),before=await port.inspectCatalogForwardDatabase(source.commit,{verify,record:()=>{fail('unexpected_inspection_event');}});
  check(before.referenceMigrationCount===2&&before.databaseMutationPerformed===false,'predecessor');
  saveCatalogBytes(resolve(out,owned.runId+'.before.json'),Buffer.from(JSON.stringify({source,beforeControl,before},null,2)+'\n'));
  const result=mode==='rollback'?await port.rehearseCatalogForwardDatabase(source.commit,{verify,record:(stage,digest)=>{
   unchanged();check(digest===before.observationSha256,'inspection_changed');owned.record(stage,{observationSha256:digest});}})
   :await port.qualifyCatalogLockDatabase(source.commit,{verify,record:()=>fail('unexpected_rollback_event')},{
    // No filesystem scan while the bounded database lock is waiting. Exact
    // source snapshots are checked before admission and after all work settles.
    record:(stage,details)=>{verify();owned.record(stage,details);},
    persistFixture:fixture=>{unchanged();saveCatalogBytes(resolve(out,owned.runId+'.fixture.json'),Buffer.from(JSON.stringify(fixture,null,2)+'\n'));}
   });
  check(eq(result.before,before)&&eq(result.after,before)&&(mode==='rollback'?result.rolledBack===true:result.fixtureRemoved===true)
   &&result.lastingApplyPerformed===false,'rollback_readback');
  const afterControl=control();check(eq(afterControl,beforeControl),'control_changed');unchanged();
  owned.record('catalog_rollback_control_verified',{configurationSha256:afterControl.configurationSha256});
  const proof=mode==='rollback'?{rolledBack:true}:{stableId:result.stableId,writerPid:result.writerPid,migrationPid:result.migrationPid,
   realLockWaitObserved:result.realLockWaitObserved,competingCommitVerified:result.competingCommitVerified,
   changedWitnessRefused:result.changedWitnessRefused,workersSettled:result.workersSettled,fixtureRemoved:result.fixtureRemoved};
  const report={contract:mode==='rollback'?'catalog-forward-custodied-rollback/1':'catalog-forward-custodied-lock-admission/1',runId:owned.runId,observedAt:new Date().toISOString(),
   operatorSource:source,recoveryReportBytesSha256:sha256(recovery),before,after:result.after,control:afterControl,
   ...proof,repeatedDatabaseReadbackVerified:true,controlUnchanged:true,sourceUnchanged:true,journalSha256:owned.journalSha256(),
   lastingApplyPerformed:false,apiDeploymentPerformed:false,canonicalRegistered:false,hostedAcceptance:false,activationApproved:false,phiAllowed:false};
  const settlement=owned.settle(report);console.log(JSON.stringify({...settlement,runId:owned.runId,...proof,lastingApplyPerformed:false,phiAllowed:false}));
 }catch(error){
  if(owned){try{owned.record('catalog_rollback_finding',{outcome:'unsettled',noAutomaticReplay:true});}catch{ /* Preserve changed custody, never remove it. */ }}
  throw error;
 }finally{try{if(guard)guard.close();}finally{await mutex.close();}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{
 console.error(e?.message?.startsWith('catalog_forward_rollback_refused:')?e.message:'catalog_forward_rollback_failed');process.exitCode=1;
});
