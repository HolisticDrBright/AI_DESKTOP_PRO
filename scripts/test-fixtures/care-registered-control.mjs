/** Fictional, credential-free current-history control fixture. No live proof. */
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P,sha256} from '../synthetic-care-release.mjs';
import {CARE_REGISTERED as C,createCareRegisteredCandidate} from '../synthetic-care-registered-release.mjs';
import {canonicalCareRegistrationDescriptor} from '../care-canonical-migrations.mjs';
import {CARE_REGISTERED_PREDECESSOR as B,careRegisteredPredecessorTemplate,verifyCareRegisteredPredecessorControl} from '../care-registered-preflight.mjs';
import {CARE_RECOVERY_ROUTE as R} from '../care-recovery-routing.mjs';
import {careControlObservation} from './care-control.mjs';
export function careRegisteredControlFixture(){
 const sourceText=readFileSync(new URL('../../infra/aws-clinical-core/identity-api-extension.json',import.meta.url),'utf8').replace(/\r\n?/g,'\n');
 const source=JSON.parse(sourceText),current={desktop:{commit:'a'.repeat(40),clean:true,files:20,sha256:'b'.repeat(64)},
  mobile:{source:{commit:'c'.repeat(40),clean:true,files:21,sha256:'d'.repeat(64)},built:false,deviceVerified:false,
   ...Object.fromEntries(['contractSha256','requestJournalSha256','transportSha256','easSha256','recoveryContractSha256','recoveryUiSha256'].map(k=>[k,'e'.repeat(64)]))},
  migrations:canonicalCareRegistrationDescriptor(),templateSha256:sha256(sourceText)};
 const candidate=createCareRegisteredCandidate(current,Buffer.from('exports.handler=async()=>({statusCode:403});\n'));
 const raw=careControlObservation();raw.template=careRegisteredPredecessorTemplate(source);
 raw.foundation.Stacks[0].StackName=P.foundation;raw.stack.Stacks[0].StackName=P.stack;raw.stack.Stacks[0].StackId=B.stackId;
 raw.stack.Stacks[0].Parameters.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue=candidate.release.predecessor.key;
 raw.fn.CodeSha256=Buffer.from(C.predecessorZip,'hex').toString('base64');raw.fn.CodeSize=C.predecessorBytes;
 raw.routes.Items.forEach((r,i)=>r.RouteId='r'+i);const old=raw.resources.StackResources;
 raw.resources.StackResources=Object.entries(raw.template.Resources).map(([LogicalResourceId,r])=>{
  let PhysicalResourceId=old.find(x=>x.LogicalResourceId===LogicalResourceId)?.PhysicalResourceId;
  if(r.Type==='AWS::ApiGatewayV2::Route')PhysicalResourceId=raw.routes.Items.find(x=>x.RouteKey===r.Properties.RouteKey).RouteId;
  if(LogicalResourceId==='IdentityApiFunction')PhysicalResourceId=P.functionName;
  if(LogicalResourceId==='IdentityApiIntegration')PhysicalResourceId=R.integrationId;
  if(LogicalResourceId==='ConsumerJwtAuthorizer')PhysicalResourceId='consumer';
  if(LogicalResourceId==='WorkforceJwtAuthorizer')PhysicalResourceId='workforce';
  if(LogicalResourceId==='IdentityApiInvokePermission')PhysicalResourceId=JSON.parse(raw.latestPolicy.Policy).Statement[0].Sid;
  return {LogicalResourceId,ResourceType:r.Type,PhysicalResourceId:PhysicalResourceId??'fictional-'+LogicalResourceId,ResourceStatus:'UPDATE_COMPLETE'};
 });
 for(let n=raw.routes.Items.length;n<112;n++)raw.routes.Items.push({RouteId:'foreign'+n,RouteKey:'GET /fictional-other/'+n,Target:'integrations/other'});
 const now=Date.parse('2026-10-08T06:00:00Z'),preflight={contract:'synthetic-care-registered-preflight/1',observedAt:new Date(now).toISOString(),
  execution:'synthetic-staging',account:P.account,current:structuredClone(current),candidateZipSha256:candidate.manifest.zipSha256,
  control:verifyCareRegisteredPredecessorControl(raw,source),liveTargetObserved:true,independentSourceRebuildVerified:true,
  predecessorBytesVerified:true,repeatedReadbackVerified:true,reportIsNotAuthority:true,
  ...Object.fromEntries(['deployAuthorized','awsMutationPerformed','schemaReplayPerformed','recoveryRehearsed','erasureAccepted','hostedAcceptance',
   'releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'].map(k=>[k,false]))};
 const artifact={bucket:P.bucket,key:candidate.manifest.key,versionId:'fictional-version',sha256:candidate.manifest.zipSha256,
  bytes:candidate.zip.length,reused:false,encryption:'aws:kms',kmsKeyArn:P.keyArn,exactVersionReadbackVerified:true};
 return {sourceText,source,current,candidate,raw,preflight,artifact,now};
}
