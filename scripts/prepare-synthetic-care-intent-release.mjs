/** Read-only live preparation. No upload, stack change, fixture, lasting DDL or activation. */
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {S3Client,HeadObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P,sha256,normalizedText,buildCareIdentityBundle} from './synthetic-care-release.mjs';
import {careIntentCurrent,readCareIntentCandidate,verifyCareIntentCandidate,refuseIntent} from './synthetic-care-intent-release.mjs';
import {DEPLOYED_CARE as D,verifyDeployedCareArtifact} from './verify-deployed-synthetic-care.mjs';
import {verifyCareStoredArtifact,readCareArtifact} from './upload-synthetic-care-release.mjs';
import {collectCancellationInventory,verifyCancellationControlPlane} from './verify-synthetic-care-cancellation.mjs';
import {observeSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
const canonical=v=>JSON.stringify(v);
export function verifyCareIntentInspector(r,current){
 const p=current.migrations;
 if(r?.contract!=='care-erasure-intent-upgrade/1'||r.command!=='inspect'
  ||canonical(r.operatorSource)!==canonical({sourceCommit:current.desktop.commit,clean:true})
  ||r.awsAccountId!==P.account||r.foundation!==P.foundation||r.execution!=='synthetic-staging'||r.phiAllowed!==false
  ||r.observedMigrationCount!==47||r.sourceMigrationCount!==46||r.tableCount!==88
  ||!Number.isSafeInteger(r.rowCount)||r.rowCount<0||!/^[a-f0-9]{64}$/.test(r.dataSha256)||!/^[a-f0-9]{64}$/.test(r.schemaSha256)
  ||r.fromLedgerSha256!==p.liveBefore||r.toLedgerSha256!==p.liveAfter||r.referenceLedgerSha256!==p.reference
  ||r.dataPreserved!==true||r.schemaPreserved!==true
  ||['applied','alreadyApplied','rolledBack','canonicalRegistered','hostedAcceptance','recoveryAcceptance',
    'activationApproved','rollbackReadback','lastingUpgradeAvailable','apiDeploymentPerformed','recoveryDrillPerformed',
    'acceptance','phiActivation'].some(k=>r[k]!==false))refuseIntent('database_predecessor');
 return {...r};
}
export function verifyCareIntentOperator(manifest,bytes,current){
 if(manifest?.contract!=='care-erasure-intent-operator-build/1'||manifest.sourceCommit!==current.desktop.commit
  ||manifest.clean!==true||manifest.sha256!==sha256(bytes)||manifest.execution!=='synthetic-staging'||manifest.phiAllowed!==false
  ||['embeddedMigrations','embeddedReferenceMigrations','embeddedOverlay','inspectionAvailable','rollbackRehearsalAvailable','apiRecoveryRequired'].some(k=>manifest[k]!==true)
  ||['targetOverrides','lastingUpgradeAvailable','canonicalRegistered','migrationPerformed','hostedAcceptance'].some(k=>manifest[k]!==false)
  ||canonical(manifest.releaseMapping?.migration)!==canonical(current.migrations.overlay)
  ||manifest.releaseMapping?.liveBeforeCount!==47||manifest.releaseMapping?.liveAfterCount!==48
  ||manifest.releaseMapping?.liveBeforeSha256!==current.migrations.liveBefore
  ||manifest.releaseMapping?.liveAfterSha256!==current.migrations.liveAfter)refuseIntent('inspector_binding');
}
function aws(args){
 try{return JSON.parse(execFileSync('aws',[...args,'--profile',profile,'--region',P.region,'--output','json'],
  {encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']}));}
 catch{refuseIntent('aws_observation');}
}
export function careIntentChildFailure(error,phase){
 if(!['build','inspect'].includes(phase))return 'inspector_phase_refused';
 if(error?.code==='ETIMEDOUT')return 'inspector_'+phase+'_deadline';
 const stderr=Buffer.isBuffer(error?.stderr)?error.stderr.toString('utf8'):typeof error?.stderr==='string'?error.stderr:'';
 const code=stderr.trim();
 const safe=/^(boundary_refused|artifact_refused|history_refused|inventory_refused|upgrade_busy|data_changed|verification_failed|upgrade_failed|api_recovery_required)(?::(transaction_start|transaction_settings|database_identity|operator_locks|history|inventory|writer_locks|before_verification|before_fingerprint|before_schema|after_history|after_inventory|after_schema|after_fingerprint|contract_verification|rollback_readback|preserved_schema_inventory))?(?::(?:begin|statement|commit|rollback|unknown)_(?:database_resuming|database_unavailable|access_denied|token_expired|credentials_unavailable|timeout|aborted|transaction_missing|statement_timeout|service_unavailable|connection_reset|transport_type_error|unknown))?$/;
 return safe.test(code)?'inspector_'+phase+'_'+code.replaceAll(':','_'):'inspector_'+phase+'_failed';
}
function child(root,args,phase){
 try{return execFileSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:180000,
  maxBuffer:2*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']});}
 catch(error){refuseIntent(careIntentChildFailure(error,phase));}
}
export async function prepareCareIntentRelease(root,mobileRoot,directory){
 const current=careIntentCurrent(root,mobileRoot),candidate=readCareIntentCandidate(directory);
 verifyCareIntentCandidate(candidate.manifest,candidate.release,candidate.bundle,candidate.zip,current);
 if(!(await buildCareIdentityBundle(root)).equals(candidate.bundle))refuseIntent('rebuilt_bundle');
 const unchanged=()=>{if(canonical(careIntentCurrent(root,mobileRoot))!==canonical(current))refuseIntent('source_changed');};
 child(root,[resolve(root,'scripts/build-care-erasure-intent-operator.mjs')],'build');
 const operatorDir=resolve(root,'dist/aws-clinical-core/care-erasure-intent-operator');
 verifyCareIntentOperator(JSON.parse(readFileSync(resolve(operatorDir,'artifact-manifest.json'),'utf8')),
  readFileSync(resolve(operatorDir,'index.cjs')),current);
 const inspect=()=>{unchanged();observeSyntheticMemberIdentity();
  return verifyCareIntentInspector(JSON.parse(child(root,[resolve(operatorDir,'index.cjs'),'inspect'],'inspect')),current);};
 const control=()=>{
  unchanged();observeSyntheticMemberIdentity();
  const resources=aws(['cloudformation','describe-stack-resources','--stack-name',P.stack]);
  const roleName=resources.StackResources?.find(r=>r.LogicalResourceId==='IdentityApiRole')?.PhysicalResourceId;
  if(typeof roleName!=='string'||!/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(roleName))refuseIntent('role');
  const raw=aws(['cloudformation','get-template','--stack-name',P.stack]).TemplateBody;
  const inline=aws(['iam','list-role-policies','--role-name',roleName,'--no-paginate']);
  if(!Array.isArray(inline.PolicyNames)||inline.PolicyNames.length>10||inline.IsTruncated!==false)refuseIntent('policies');
  return verifyCancellationControlPlane({resources,
   foundation:aws(['cloudformation','describe-stacks','--stack-name',P.foundation]),
   stack:aws(['cloudformation','describe-stacks','--stack-name',P.stack]),template:typeof raw==='string'?JSON.parse(raw):raw,
   fn:aws(['lambda','get-function-configuration','--function-name',P.functionName]),
   role:aws(['iam','get-role','--role-name',roleName]),inline,
   attached:aws(['iam','list-attached-role-policies','--role-name',roleName,'--no-paginate']),
   policies:inline.PolicyNames.map(name=>aws(['iam','get-role-policy','--role-name',roleName,'--policy-name',name])),
   logGroups:collectCancellationInventory(aws,['logs','describe-log-groups','--log-group-name-prefix','/ai-clinical-core/synthetic-staging/identity-api','--limit','50'],'logGroups','nextToken'),
   integrations:collectCancellationInventory(aws,['apigatewayv2','get-integrations','--api-id',P.apiId,'--max-results','100'],'Items','NextToken'),
   routes:collectCancellationInventory(aws,['apigatewayv2','get-routes','--api-id',P.apiId,'--max-results','100'],'Items','NextToken'),
   authorizers:collectCancellationInventory(aws,['apigatewayv2','get-authorizers','--api-id',P.apiId,'--max-results','100'],'Items','NextToken'),
   stage:aws(['apigatewayv2','get-stage','--api-id',P.apiId,'--stage-name','$default']),
   latestPolicy:aws(['lambda','get-policy','--function-name',P.functionName])},
   JSON.parse(normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json')));
 };
 const before=inspect(),live=control();
 const originalDir=resolve(root,'dist/synthetic-care-release',D.desktop,D.mobile);
 const original={manifest:JSON.parse(readFileSync(resolve(originalDir,'artifact-manifest.json'),'utf8')),
  release:JSON.parse(readFileSync(resolve(originalDir,'release.json'),'utf8')),
  bundle:readFileSync(resolve(originalDir,'index.js')),zip:readFileSync(resolve(originalDir,'candidate.zip'))};
 verifyDeployedCareArtifact(original.manifest,original.release,original.bundle,original.zip);
 const s3=new S3Client({region:P.region,credentials:fromIni({profile}),maxAttempts:1});
 try{
  const input={Bucket:P.bucket,ExpectedBucketOwner:P.account,Key:original.manifest.key,VersionId:D.version,ChecksumMode:'ENABLED'};
  verifyCareStoredArtifact(await s3.send(new HeadObjectCommand(input),{abortSignal:AbortSignal.timeout(30000)}),original.manifest,D.version);
  const signal=AbortSignal.timeout(30000),object=await s3.send(new GetObjectCommand(input),{abortSignal:signal});
  try{verifyCareStoredArtifact(object,original.manifest,D.version);}catch(error){object.Body?.destroy?.();throw error;}
  if(!(await readCareArtifact(object.Body,original.manifest,signal)).equals(original.zip))refuseIntent('predecessor_bytes');
 }finally{s3.destroy();}
 const after=inspect(),returned=control();unchanged();
 if(canonical(before)!==canonical(after)||canonical(live)!==canonical(returned))refuseIntent('live_changed');
 return {contract:'synthetic-care-intent-preparation/1',observedAt:new Date().toISOString(),
  execution:'synthetic-staging',account:P.account,region:P.region,desktop:current.desktop,mobile:current.mobile,
  candidateZipSha256:candidate.manifest.zipSha256,predecessor:candidate.manifest.predecessor,
  control:live,database:after,predecessorExactVersionReadback:true,sourceRebuiltNow:true,
  awsMutationPerformed:false,candidateUploaded:false,deployed:false,schemaChanged:false,canonicalRegistered:false,
  freshCompatibleRecoveryPerformed:false,lastingSchemaUpgradeAuthorized:false,hostedAcceptance:false,
  paidMobileBuildStarted:false,phiAllowed:false};
}
async function main(){
 const args=process.argv.slice(2);
 if(args.length!==5||args[0]!=='--v2-root'||args[2]!=='--candidate'||args[4]!=='--prepare-fictional-intent-code-only'
  ||args[1].startsWith('--')||args[3].startsWith('--'))refuseIntent('arguments');
 const directory=resolve(args[3]);let report;
 try{report=await prepareCareIntentRelease(process.cwd(),resolve(args[1]),directory);}
 catch(error){
  const code=/^synthetic_care_intent_release_refused:[a-z0-9_]{1,180}$/.test(error?.message??'')
   ?error.message:'synthetic_care_intent_release_refused:preparation';
  const output=resolve(directory,'preparation-findings');mkdirSync(output,{recursive:true});
  writeFileSync(resolve(output,Date.now()+'-'+randomUUID()+'.json'),JSON.stringify({
   contract:'synthetic-care-intent-preparation-finding/1',at:new Date().toISOString(),code,
   awsMutationPerformed:false,deployed:false,schemaChanged:false,hostedAcceptance:false,phiAllowed:false})+'\n',{flag:'wx'});
  throw error;
 }
 const output=resolve(directory,'preparations');mkdirSync(output,{recursive:true});
 const file=resolve(output,sha256(canonical(report))+'.json');
 writeFileSync(file,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({report:file,...report}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(error=>{console.error(error.message?.startsWith('synthetic_care_intent_release_refused:')?error.message:
  'synthetic_care_intent_release_refused:preparation');process.exitCode=1;});
}
