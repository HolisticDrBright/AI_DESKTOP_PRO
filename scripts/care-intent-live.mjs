/** Live AWS observation helpers for the separate code-before-intent profile. */
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {DEPLOYED_CARE as D} from './verify-deployed-synthetic-care.mjs';
import {refuseIntent} from './synthetic-care-intent-release.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical,verifyRecoveryIntegration} from './care-recovery-routing.mjs';
import {careIntentFunctionConfig} from './care-intent-release.mjs';
import {verifyIntentRetainedCode,verifyIntentPublicationLatest} from './care-intent-routing.mjs';
import {collectCancellationInventory,verifyCancellationControlPlane} from './verify-synthetic-care-cancellation.mjs';
import {readCareArtifact} from './upload-synthetic-care-release.mjs';
import {SYNTHETIC_MEMBER_PROFILE as profile,observeSyntheticMemberIdentity} from './synthetic-aws-principal.mjs';
const check=(ok,code)=>{if(!ok)refuseIntent('live_'+code);};
export function intentPolicyAbsent(args,version,error){
 const stderr=Buffer.isBuffer(error?.stderr)?error.stderr.toString('utf8'):error?.stderr??'';
 return typeof version==='string'&&/^[1-9][0-9]{0,19}$/.test(version)&&version!=='1'
  &&canonical(args)===canonical(['lambda','get-policy','--function-name',P.functionName,'--qualifier',version])
  &&/^(?:aws: \[ERROR\]: )?An error occurred \(ResourceNotFoundException\) when calling the GetPolicy operation:/.test(stderr.trim());
}
export function intentAws(args,missingPolicyVersion){
 try{
  const raw=execFileSync('aws',[...args,'--profile',profile,'--region',P.region,'--output','json'],
   {encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']});
  return raw.trim()?JSON.parse(raw):{};
 }catch(error){
  // Only the exact qualified GetPolicy absence is a null. No other access,
  // transport or service error is treated as missing data.
  if(intentPolicyAbsent(args,missingPolicyVersion,error))return null;
  refuseIntent('live_aws_outcome_unconfirmed');
 }
}
export function observeIntentControlRaw(){
 observeSyntheticMemberIdentity();
 const inventory=(args,k,t)=>collectCancellationInventory(intentAws,args,k,t);
 const resources=intentAws(['cloudformation','describe-stack-resources','--stack-name',P.stack,'--no-paginate']);
 const roleName=resources.StackResources?.find(r=>r.LogicalResourceId==='IdentityApiRole')?.PhysicalResourceId;
 check(typeof roleName==='string'&&/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(roleName),'role_name');
 const raw=intentAws(['cloudformation','get-template','--stack-name',P.stack,'--template-stage','Original']).TemplateBody;
 const inline=intentAws(['iam','list-role-policies','--role-name',roleName,'--no-paginate']);
 check(Array.isArray(inline.PolicyNames)&&inline.PolicyNames.length<=10&&inline.IsTruncated===false,'inline_inventory');
 return {foundation:intentAws(['cloudformation','describe-stacks','--stack-name',P.foundation]),
  stack:intentAws(['cloudformation','describe-stacks','--stack-name',P.stack]),template:typeof raw==='string'?JSON.parse(raw):raw,
  fn:intentAws(['lambda','get-function-configuration','--function-name',P.functionName]),resources,
  role:intentAws(['iam','get-role','--role-name',roleName]),attached:intentAws(['iam','list-attached-role-policies','--role-name',roleName,'--no-paginate']),inline,
  policies:inline.PolicyNames.map(name=>intentAws(['iam','get-role-policy','--role-name',roleName,'--policy-name',name])),
  logGroups:inventory(['logs','describe-log-groups','--log-group-name-prefix','/ai-clinical-core/synthetic-staging/identity-api','--limit','50'],'logGroups','nextToken'),
  integrations:inventory(['apigatewayv2','get-integrations','--api-id',P.apiId,'--max-results','100'],'Items','NextToken'),
  routes:inventory(['apigatewayv2','get-routes','--api-id',P.apiId,'--max-results','100'],'Items','NextToken'),
  authorizers:inventory(['apigatewayv2','get-authorizers','--api-id',P.apiId,'--max-results','100'],'Items','NextToken'),
  stage:intentAws(['apigatewayv2','get-stage','--api-id',P.apiId,'--stage-name','$default']),
  latestPolicy:intentAws(['lambda','get-policy','--function-name',P.functionName])};
}
/** Admit exactly the code pointer/checksum differences, then reuse all original
 * authority checks. The original public verifier remains pinned and unchanged.
 * Retained URI is independently checked before this specific normalization. */
export function verifyIntentLiveControl(o,source,input,candidate,before,preparation,retainedVersion){
 check(canonical(o.template)===canonical(input.template),'template');
 const stack=o.stack?.Stacks?.[0],params=stack?.Parameters;
 check(o.stack?.Stacks?.length===1&&stack.StackId===before.binding.stackId&&stack.StackName===P.stack&&stack.StackStatus==='UPDATE_COMPLETE'
  &&Array.isArray(params)&&params.length===11&&new Set(params.map(x=>x.ParameterKey)).size===11,'stack');
 const actual=Object.fromEntries(params.map(x=>[x.ParameterKey,x.ParameterValue]));
 const expected=Object.fromEntries(before.summary.Parameters.map(x=>[x.ParameterKey,x.ParameterValue]));
 check(canonical(actual)===canonical(expected),'parameters');
 check(o.fn?.FunctionArn===R.latestArn&&o.fn.Version==='$LATEST'&&o.fn.State==='Active'&&o.fn.LastUpdateStatus==='Successful'
  &&o.fn.CodeSha256===Buffer.from(candidate.manifest.zipSha256,'hex').toString('base64')&&o.fn.CodeSize===candidate.zip.length
  &&typeof o.fn.RevisionId==='string'&&o.fn.RevisionId!==before.live.fn.RevisionId
  &&canonical(careIntentFunctionConfig(o.fn))===canonical(careIntentFunctionConfig(before.live.fn)),'function');
 const identity=o.integrations?.Items?.filter(v=>v.IntegrationId===R.integrationId);
 check(identity?.length===1,'identity_integration');
 const uri=retainedVersion?`${R.latestArn}:${retainedVersion}`:R.latestArn;
 if(retainedVersion)check(/^[1-9][0-9]{0,19}$/.test(retainedVersion)&&retainedVersion!=='1','retained_version');
 verifyRecoveryIntegration(identity[0],uri);
 const predecessor=structuredClone(o);
 predecessor.template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=D.version;
 predecessor.stack.Stacks[0].Parameters.find(v=>v.ParameterKey==='LambdaCodeKey').ParameterValue=
  `clinical-core/authenticated-api/care-release/${D.desktop}/${D.zip}.zip`;
 predecessor.fn.CodeSha256=Buffer.from(D.zip,'hex').toString('base64');predecessor.fn.CodeSize=D.bytes;
 predecessor.integrations.Items.find(v=>v.IntegrationId===R.integrationId).IntegrationUri=R.latestArn;
 const proof=verifyCancellationControlPlane(predecessor,source);
 for(const k of ['routesSha256','authorizersSha256','roleSha256','policySha256'])check(proof[k]===preparation.control[k],'authority_drift');
 check(proof.integrationsSha256===preparation.control.integrationsSha256,'other_integrations_drift');
 return {...proof,codeSha256:o.fn.CodeSha256,revision:o.fn.RevisionId,templateSha256:sha256(canonical(o.template)),
  integrationsSha256:sha256(canonical(o.integrations)),stageSha256:sha256(canonical(o.stage))};
}
export function verifyIntentCodeLocation(result,configuration){
 check(canonical(result?.Configuration)===canonical(configuration)&&result.Code?.RepositoryType==='S3'
  &&typeof result.Code.Location==='string'&&result.Code.Location.length<=16384,'code_location_binding');
 let url;try{url=new URL(result.Code.Location);}catch{refuseIntent('live_code_location');}
 check(url.protocol==='https:'&&url.hostname==='awslambda-us-east-2-tasks.s3.us-east-2.amazonaws.com'
  &&!url.username&&!url.password&&!url.port&&!url.hash&&url.search.length>0
  &&new RegExp(`^/snapshots/${P.account}/${P.functionName}-[a-f0-9-]{36}$`).test(url.pathname),'code_location');
 // Caller must keep this presigned URL in memory; reports contain no query.
 return url.href;
}
export async function downloadIntentFunction(configuration,candidate){
 const qualified=configuration.Version==='$LATEST'?[]:['--qualifier',configuration.Version];
 const answer=intentAws(['lambda','get-function','--function-name',P.functionName,...qualified]);
 const url=verifyIntentCodeLocation(answer,configuration),signal=AbortSignal.timeout(30000);
 const response=await fetch(url,{redirect:'error',signal});
 let body;
 try{
  check(response.status===200&&response.body&&response.headers.get('content-length')===String(candidate.zip.length),'code_download_headers');
  body=Readable.fromWeb(response.body);
  const bytes=await readCareArtifact(body,candidate.manifest,signal);check(bytes.equals(candidate.zip),'code_download_bytes');return bytes;
 }catch(error){body?.destroy();if(!body)await response.body?.cancel().catch(()=>{});throw error;}
}
export function intentVersionDescription(candidate){return `ALP synthetic intent ${candidate.manifest.desktop.commit} ${candidate.manifest.zipSha256} PHI=off`;}
export function verifyIntentInterruptedVersionInventory(matching,expected){
 check(typeof expected==='string'&&/^[1-9][0-9]{0,19}$/.test(expected)&&expected!=='1'
  &&Array.isArray(matching)&&matching.length===1&&matching[0].Version===expected,'interrupted_retained_missing_or_changed');
 return expected;
}
async function intentVersions(){
 const versions=[],markers=new Set();let marker;
 for(let n=0;n<10;n++){
  const answer=intentAws(['lambda','list-versions-by-function','--no-paginate','--cli-input-json',JSON.stringify({FunctionName:P.functionName,
   MaxItems:50,...(marker?{Marker:marker}:{})})]);
  check(Array.isArray(answer.Versions)&&answer.Versions.length<=50,'version_inventory');versions.push(...answer.Versions);
  check(new Set(versions.map(v=>v.Version)).size===versions.length,'version_duplicates');
  if(answer.NextMarker===undefined)return versions;
  marker=answer.NextMarker;check(typeof marker==='string'&&marker.length>0&&marker.length<=1024&&!markers.has(marker),'version_marker');markers.add(marker);
 }
 refuseIntent('live_version_pages');
}
export async function retainIntentFunction(latest,candidate,context){
 context.unchanged();observeSyntheticMemberIdentity();
 const description=intentVersionDescription(candidate);
 const matching=(await intentVersions()).filter(v=>v.Version!=='$LATEST'&&v.Description===description);
 check(matching.length<=1,'retained_ambiguous');let version=matching[0]?.Version;
 if(context.interruptedRetainedVersion!==undefined)verifyIntentInterruptedVersionInventory(matching,context.interruptedRetainedVersion);
 if(!version){
  context.unchanged();observeSyntheticMemberIdentity();
  check(canonical(intentAws(['lambda','get-function-configuration','--function-name',P.functionName]))===canonical(latest),'publication_drift');
  context.admit({stage:'intent_version_publish_admitted',revision:latest.RevisionId,zipSha256:candidate.manifest.zipSha256});
  try{version=intentAws(['lambda','publish-version','--function-name',P.functionName,'--code-sha256',latest.CodeSha256,
   '--revision-id',latest.RevisionId,'--description',description]).Version;}
  catch{
   // Reconcile once from service inventory. Never replay a lost publication.
   const found=(await intentVersions()).filter(v=>v.Version!=='$LATEST'&&v.Description===description);
   check(found.length===1,'publication_unconfirmed');version=found[0].Version;
  }
 }
 check(typeof version==='string'&&/^[1-9][0-9]{0,19}$/.test(version)&&version!=='1','retained_version');
 const configuration=intentAws(['lambda','get-function-configuration','--function-name',P.functionName,'--qualifier',version]);
 check(configuration.Description===description,'retained_description');
 const codeBytes=await downloadIntentFunction(configuration,candidate);verifyIntentRetainedCode(configuration,codeBytes,latest,candidate);
 const latestConfiguration=verifyIntentPublicationLatest(
  intentAws(['lambda','get-function-configuration','--function-name',P.functionName]),latest,candidate);
 await downloadIntentFunction(latestConfiguration,candidate);
 context.record({stage:'intent_retained_bytes_verified',version,sha256:sha256(codeBytes),
  beforeLatestRevision:latest.RevisionId,latestRevision:latestConfiguration.RevisionId});
 return {configuration,codeBytes,latestConfiguration};
}
