/** Exact code upload only. Fresh observations are made in-process, never supplied as reports. */
import {readFileSync,mkdirSync,writeFileSync,unlinkSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {S3Client,PutObjectCommand} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {careIntentCurrent,readCareIntentCandidate,verifyCareIntentCandidate,refuseIntent} from './synthetic-care-intent-release.mjs';
import {prepareCareIntentRelease,verifyCareIntentInspector} from './prepare-synthetic-care-intent-release.mjs';
import {uploadAndVerifyCareArtifact} from './upload-synthetic-care-release.mjs';
import {observeSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
const canonical=v=>JSON.stringify(v);
export function verifyIntentUploadPreparation(plan,manifest,current,now=Date.now()){
 const age=now-Date.parse(plan?.observedAt);
 if(plan?.contract!=='synthetic-care-intent-preparation/1'||!Number.isFinite(age)||age<0||age>120000
  ||plan.account!==P.account||plan.region!==P.region||plan.execution!=='synthetic-staging'
  ||canonical(plan.desktop)!==canonical(current.desktop)||canonical(plan.mobile)!==canonical(current.mobile)
  ||canonical(plan.predecessor)!==canonical(manifest.predecessor)||plan.candidateZipSha256!==manifest.zipSha256
  ||plan.predecessorExactVersionReadback!==true||plan.sourceRebuiltNow!==true
  ||['awsMutationPerformed','candidateUploaded','deployed','schemaChanged','canonicalRegistered',
   'freshCompatibleRecoveryPerformed','lastingSchemaUpgradeAuthorized','hostedAcceptance','paidMobileBuildStarted','phiAllowed'].some(k=>plan[k]!==false)
  ||plan.control?.codeSha256!==manifest.predecessor.codeSha256||plan.control.routeCount!==51
  ||plan.control.iamVerified!==true||plan.control.loggingVerified!==true||plan.control.phiAllowed!==false
  ||typeof plan.control.revision!=='string'||!plan.control.revision
  ||!['templateSha256','routesSha256','authorizersSha256','integrationsSha256','stageSha256','policySha256','roleSha256']
   .every(k=>/^[a-f0-9]{64}$/.test(plan.control[k]))
  ||manifest.key!==`clinical-core/authenticated-api/care-intent-release/${current.desktop.commit}/${manifest.zipSha256}.zip`
  ||!Number.isSafeInteger(manifest.zipBytes)||manifest.zipBytes<=0||manifest.zipBytes>10*1024*1024)
  refuseIntent('upload_preparation');
 verifyCareIntentInspector(plan.database,current);
}
export function intentFailureCode(error){
 const value=error?.message??'';
 return /^synthetic_care_intent_release_refused:[a-z0-9_]{1,180}$/.test(value)?value:'synthetic_care_intent_release_refused:upload_or_proposal_unconfirmed';
}
/** Filesystem custody, not deployment authority. Admission is flushed before
 * the remote request; an unknown outcome deliberately retains its lock. */
export function createIntentUploadCustody(root,out,current,purpose='intent-artifact-upload-proposal'){
 if(!['intent-artifact-upload-proposal','registered-artifact-upload'].includes(purpose))refuseIntent('custody_purpose');
 const directory=resolve(root,'dist/synthetic-care-routing');
 mkdirSync(directory,{recursive:true});mkdirSync(out,{recursive:true});
 const runId=randomBytes(16).toString('hex'),lock=resolve(directory,'operator.lock'),journal=resolve(out,runId+'.events.jsonl');
 const saved={runId,pid:process.pid,purpose,desktop:current.desktop,mobile:current.mobile};
 let handle;
 try{handle=openSync(lock,'wx');writeFileSync(handle,JSON.stringify(saved)+'\n');fsyncSync(handle);}
 catch{refuseIntent('operator_lock');}finally{if(handle!==undefined)closeSync(handle);}
 let admitted=false,settled=false;
 const record=event=>{
  const fd=openSync(journal,'a');
  try{writeFileSync(fd,JSON.stringify({at:new Date().toISOString(),...event})+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 };
 return {runId,lock,journal,record,
  admit:event=>{record(event);admitted=true;},
  settle:()=>{settled=true;},
  get admitted(){return admitted;},
  close:()=>{
   if(!admitted||settled){
    if(canonical(JSON.parse(readFileSync(lock,'utf8')))!==canonical(saved))refuseIntent('custody_changed');
    unlinkSync(lock);
   }
  }};
}
/** Shared custody covers artifact upload and an optional nonexecuting proposal.
 * An unknown write outcome keeps this same run's lock and journal for diagnosis. */
export async function runCareIntentUpload(root,mobileRoot,directory,proposal){
 const current=careIntentCurrent(root,mobileRoot),candidate=readCareIntentCandidate(directory);
 verifyCareIntentCandidate(candidate.manifest,candidate.release,candidate.bundle,candidate.zip,current);
 observeSyntheticMemberIdentity();
 const out=resolve(directory,'uploads'),custody=createIntentUploadCustody(root,out,current);
 const {runId,journal,record,admit}=custody;
 const unchanged=()=>{if(canonical(careIntentCurrent(root,mobileRoot))!==canonical(current)
  ||!readFileSync(resolve(directory,'candidate.zip')).equals(candidate.zip))refuseIntent('source_changed');};
 const client=new S3Client({region:P.region,credentials:fromIni({profile}),maxAttempts:1});
 try{
  record({stage:'started',runId});
  const preparation=await prepareCareIntentRelease(root,mobileRoot,directory);
  unchanged();observeSyntheticMemberIdentity();verifyIntentUploadPreparation(preparation,candidate.manifest,current);
  record({stage:'live_preparation_verified',observedAt:preparation.observedAt});
  const artifact=await uploadAndVerifyCareArtifact(async(command,options={})=>{
   if(command instanceof PutObjectCommand){
    unchanged();observeSyntheticMemberIdentity();verifyIntentUploadPreparation(preparation,candidate.manifest,current);
    admit({stage:'artifact_put_admitted',key:candidate.manifest.key,sha256:candidate.manifest.zipSha256});
   }
   return client.send(command,{...options,abortSignal:options.abortSignal??AbortSignal.timeout(30000)});
  },candidate.manifest,candidate.zip);
  unchanged();record({stage:'artifact_exact_version_verified',artifact});
  const uploaded={contract:'synthetic-care-intent-upload/1',observedAt:new Date().toISOString(),runId,journal,
   execution:'synthetic-staging',account:P.account,region:P.region,desktop:current.desktop,mobile:current.mobile,
   preparation,artifact,candidateUploaded:true,awsMutationPerformed:!artifact.reused,
   deployed:false,schemaChanged:false,canonicalRegistered:false,freshCompatibleRecoveryPerformed:false,
   hostedAcceptance:false,paidMobileBuildStarted:false,phiAllowed:false};
  // Preserve the verified upload even if a subsequent proposal fails.
  const file=resolve(out,runId+'.json');writeFileSync(file,JSON.stringify(uploaded,null,2)+'\n',{flag:'wx'});
  let proposed;
  if(proposal){
   const fresh=await prepareCareIntentRelease(root,mobileRoot,directory);
   unchanged();observeSyntheticMemberIdentity();verifyIntentUploadPreparation(fresh,candidate.manifest,current);
   proposed=await proposal({candidate,current,artifact,preparation:fresh,unchanged,record,
    admit});
  }
  unchanged();record({stage:'completed',report:file});custody.settle();
  return {report:file,...uploaded,...(proposed?{proposal:proposed}:{}),operatorCustodySettled:true};
 }catch(error){record({stage:'finding',code:intentFailureCode(error),writeAdmitted:custody.admitted});throw error;}
 finally{
  client.destroy();
  custody.close();
 }
}
async function main(){
 const a=process.argv.slice(2);
 if(a.length!==5||a[0]!=='--v2-root'||a[2]!=='--candidate'||a[4]!=='--upload-fictional-intent-code-only'
  ||a[1].startsWith('--')||a[3].startsWith('--'))refuseIntent('arguments');
 console.log(JSON.stringify(await runCareIntentUpload(process.cwd(),resolve(a[1]),resolve(a[3]))));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(error=>{console.error(intentFailureCode(error));process.exitCode=1;});
}
