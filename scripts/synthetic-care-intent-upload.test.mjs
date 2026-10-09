import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,existsSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {DEPLOYED_CARE as D} from './verify-deployed-synthetic-care.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {createCareIntentCandidate,careIntentMigrationBinding} from './synthetic-care-intent-release.mjs';
import {verifyIntentUploadPreparation,intentFailureCode,createIntentUploadCustody} from './upload-synthetic-care-intent-release.mjs';
import {careIntentCodeChangeInputs,verifyCareIntentChangeSetViews} from './prepare-synthetic-care-intent-code-change.mjs';
import {verifyCareCodeChangeSet} from './prepare-synthetic-care-code-change.mjs';
const source=JSON.parse(readFileSync(new URL('../infra/aws-clinical-core/identity-api-extension.json',import.meta.url),'utf8'));
const now=Date.parse('2026-10-07T22:00:00.000Z');
function fixture(){
 const snapshot={commit:'a'.repeat(40),clean:true,files:3,sha256:'b'.repeat(64)};
 const current={desktop:snapshot,mobile:{source:{...snapshot,commit:'c'.repeat(40)},
  ...Object.fromEntries(['contractSha256','requestJournalSha256','transportSha256','easSha256','recoveryContractSha256','recoveryUiSha256'].map(k=>[k,'d'.repeat(64)])),
  built:false,deviceVerified:false},migrations:careIntentMigrationBinding(process.cwd(),true),templateSha256:'e'.repeat(64)};
 const candidate=createCareIntentCandidate(current,Buffer.from('fictional handler'));
 const template=structuredClone(source);for(const name of P.absentRoutes)delete template.Resources[name];
 template.Outputs.RoutesEnabled.Value='51';template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=D.version;
 const preparation={contract:'synthetic-care-intent-preparation/1',observedAt:new Date(now).toISOString(),
  execution:'synthetic-staging',account:P.account,region:P.region,desktop:structuredClone(current.desktop),mobile:structuredClone(current.mobile),
  predecessor:structuredClone(candidate.manifest.predecessor),candidateZipSha256:candidate.manifest.zipSha256,
  predecessorExactVersionReadback:true,sourceRebuiltNow:true,
  ...Object.fromEntries(['awsMutationPerformed','candidateUploaded','deployed','schemaChanged','canonicalRegistered',
   'freshCompatibleRecoveryPerformed','lastingSchemaUpgradeAuthorized','hostedAcceptance','paidMobileBuildStarted','phiAllowed'].map(k=>[k,false])),
  control:{codeSha256:candidate.manifest.predecessor.codeSha256,routeCount:51,iamVerified:true,loggingVerified:true,phiAllowed:false,
   revision:'actual-revision',templateSha256:sha256(canonical(template)),
   ...Object.fromEntries(['routesSha256','authorizersSha256','integrationsSha256','stageSha256','policySha256','roleSha256'].map(k=>[k,'f'.repeat(64)]))},
  database:{contract:'care-erasure-intent-upgrade/1',command:'inspect',operatorSource:{sourceCommit:current.desktop.commit,clean:true},
   awsAccountId:P.account,foundation:P.foundation,execution:'synthetic-staging',phiAllowed:false,
   observedMigrationCount:47,sourceMigrationCount:46,tableCount:88,rowCount:23985,dataSha256:'1'.repeat(64),schemaSha256:'2'.repeat(64),
   fromLedgerSha256:current.migrations.liveBefore,toLedgerSha256:current.migrations.liveAfter,referenceLedgerSha256:current.migrations.reference,
   dataPreserved:true,schemaPreserved:true,
   ...Object.fromEntries(['applied','alreadyApplied','rolledBack','canonicalRegistered','hostedAcceptance','recoveryAcceptance',
    'activationApproved','rollbackReadback','lastingUpgradeAvailable','apiDeploymentPerformed','recoveryDrillPerformed','acceptance','phiActivation'].map(k=>[k,false]))}};
 const artifact={bucket:P.bucket,key:candidate.manifest.key,sha256:candidate.manifest.zipSha256,bytes:candidate.manifest.zipBytes,
  exactVersionReadbackVerified:true,encryption:'aws:kms',kmsKeyArn:P.keyArn,versionId:'fictional-new-version'};
 return {current,candidate,template,preparation,artifact};
}
test('upload admission requires fresh current source, exact parent state, concrete data inspection and no claimed activation',()=>{
 const f=fixture();verifyIntentUploadPreparation(f.preparation,f.candidate.manifest,f.current,now);
 for(const change of [f=>f.preparation.observedAt=new Date(now-120001).toISOString(),
  f=>f.preparation.observedAt=new Date(now+1).toISOString(),f=>f.preparation.observedAt='invalid',
  f=>f.preparation.account='173535830222',f=>f.preparation.region='us-west-2',f=>f.preparation.execution='qualification',
  f=>f.preparation.predecessor.zip=P.previousZipSha256,f=>f.preparation.mobile.recoveryUiSha256='0'.repeat(64),
  f=>f.preparation.control.codeSha256='other',f=>f.preparation.control.iamVerified=false,
  f=>f.preparation.control.routeCount=55,f=>f.preparation.control.revision='',
  f=>f.preparation.database.observedMigrationCount=48,f=>f.preparation.database.rowCount=-1,
  f=>f.preparation.database.fromLedgerSha256=P.liveBefore,f=>f.preparation.database.hostedAcceptance=true,
  f=>f.preparation.sourceRebuiltNow=false,f=>f.preparation.predecessorExactVersionReadback=false,
  ...['awsMutationPerformed','candidateUploaded','deployed','schemaChanged','canonicalRegistered',
   'freshCompatibleRecoveryPerformed','lastingSchemaUpgradeAuthorized','hostedAcceptance','paidMobileBuildStarted','phiAllowed'].map(k=>f=>f.preparation[k]=true),
  f=>f.candidate.manifest.key+='/escape',f=>f.candidate.manifest.zipBytes=0,f=>f.candidate.manifest.zipBytes=10*1024*1024+1]){
  const value=fixture();change(value);assert.throws(()=>verifyIntentUploadPreparation(value.preparation,value.candidate.manifest,value.current,now));
 }
});
test('proposal pins exact downloaded object version while preserving all non-Code properties and existing route absences',()=>{
 const f=fixture();f.preparation.observedAt=new Date().toISOString();const before=structuredClone(f.template);
 const input=careIntentCodeChangeInputs(source,f.preparation,f.candidate.manifest,f.artifact,f.current);
 const unchanged=structuredClone(input.template);unchanged.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=D.version;
 assert.deepEqual(unchanged,before);
 assert.equal(input.template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion,f.artifact.versionId);
 assert.deepEqual(input.parameters.filter(p=>p.ParameterValue),[{ParameterKey:'LambdaCodeKey',ParameterValue:f.candidate.manifest.key}]);
 assert.equal(input.parameters.filter(p=>p.UsePreviousValue).length,10);
 assert.equal(Object.values(input.template.Resources).filter(r=>r.Type==='AWS::ApiGatewayV2::Route').length,51);
 for(const name of P.absentRoutes)assert.equal(input.template.Resources[name],undefined);
 for(const change of [f=>f.artifact.versionId='null',f=>f.artifact.versionId='',f=>f.artifact.bucket='other',
  f=>f.artifact.key='other',f=>f.artifact.sha256='0'.repeat(64),f=>f.artifact.bytes++,f=>f.artifact.kmsKeyArn='other',
  f=>f.artifact.exactVersionReadbackVerified=false,f=>f.preparation.control.templateSha256='0'.repeat(64)]){
  const changed=fixture();changed.preparation.observedAt=new Date().toISOString();change(changed);
  assert.throws(()=>careIntentCodeChangeInputs(source,changed.preparation,changed.candidate.manifest,changed.artifact,changed.current));
 }
 const changedSource=structuredClone(source);changedSource.Resources.IdentityApiFunction.Properties.Timeout=30;
 assert.throws(()=>careIntentCodeChangeInputs(changedSource,f.preparation,f.candidate.manifest,f.artifact,f.current));
});
function changeSetFixture(){
 const f=fixture();f.preparation.observedAt=new Date().toISOString();
 const input=careIntentCodeChangeInputs(source,f.preparation,f.candidate.manifest,f.artifact,f.current);
 const binding={stackId:`arn:aws:cloudformation:${P.region}:${P.account}:stack/${P.stack}/fictional`,
  name:'care-intent-fictional',id:`arn:aws:cloudformation:${P.region}:${P.account}:changeSet/care-intent-fictional/fictional`};
 const params={ClinicalApiId:P.apiId,DatabaseName:P.database,DatabaseClusterArn:P.cluster,DatabaseSecretArn:'****',
  ConsumerUserPoolId:P.consumerPool,ConsumerUserPoolClientId:P.consumerClient,WorkforceUserPoolId:P.workforcePool,
  WorkforceUserPoolClientId:P.workforceClient,ClinicalCoreKeyArn:P.keyArn,LambdaCodeBucket:P.bucket,LambdaCodeKey:f.candidate.manifest.key};
 const set={StackId:binding.stackId,StackName:P.stack,ChangeSetName:binding.name,ChangeSetId:binding.id,
  Status:'CREATE_COMPLETE',ExecutionStatus:'AVAILABLE',Capabilities:['CAPABILITY_IAM'],
  Parameters:Object.entries(params).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue})),
  Changes:[{Type:'Resource',ResourceChange:{Action:'Modify',LogicalResourceId:'IdentityApiFunction',PhysicalResourceId:P.functionName,
   ResourceType:'AWS::Lambda::Function',Replacement:'False',Scope:['Properties'],Details:[{Target:{Attribute:'Properties',Name:'Code',RequiresRecreation:'Never'},ChangeSource:'DirectModification'}]}}]};
 return {set,input,binding,f};
}
test('existing strict change-set shape guard rejects an intent proposal that alters any other resource',()=>{
 const {set,input,binding}=changeSetFixture();
 verifyCareCodeChangeSet(set,input.template,input,binding);
 for(const change of [s=>s.Changes[0].ResourceChange.LogicalResourceId='IdentityApiRole',
  s=>s.Changes[0].ResourceChange.Details[0].Target.Name='Environment',s=>s.Changes[0].ResourceChange.Replacement='True',
  s=>s.ExecutionStatus='EXECUTE_COMPLETE',s=>s.NextToken='unread',s=>s.Changes.push(structuredClone(s.Changes[0]))]){
  const changed=structuredClone(set);change(changed);assert.throws(()=>verifyCareCodeChangeSet(changed,input.template,input,binding));
 }
});

test('both CloudFormation views and complete property contexts are mandatory; a hidden dependency is not a pass',()=>{
 const make=()=>{
  const value=changeSetFixture(),{set,input}=value;
  const detailed=structuredClone(set),before={Properties:{FunctionName:P.functionName,Timeout:'29',
   Code:{S3Bucket:P.bucket,S3Key:`clinical-core/authenticated-api/care-release/${D.desktop}/${D.zip}.zip`,S3ObjectVersion:D.version}}};
  const after=structuredClone(before);after.Properties.Code.S3Key=value.f.candidate.manifest.key;
  after.Properties.Code.S3ObjectVersion=value.f.artifact.versionId;
  const change=detailed.Changes[0].ResourceChange;
  change.BeforeContext=JSON.stringify(before);change.AfterContext=JSON.stringify(after);
  change.Details=['S3ObjectVersion','S3Key'].map(name=>({ChangeSource:'DirectModification',Evaluation:'Static',
   Target:{Attribute:'Properties',Name:'Code',RequiresRecreation:'Never',Path:'/Properties/Code/'+name,
    BeforeValue:before.Properties.Code[name],AfterValue:after.Properties.Code[name],AttributeChangeType:'Modify'}}));
  return {...value,detailed,before,after,input};
 };
 const f=make();assert.equal(verifyCareIntentChangeSetViews(f.set,f.detailed,f.input.template,f.input,f.binding).summaryResourceCount,1);
 for(const change of [
  f=>f.set.Changes.push({Type:'Resource',ResourceChange:{Action:'Modify',LogicalResourceId:'IdentityApiIntegration',
   PhysicalResourceId:'2k0pka6',ResourceType:'AWS::ApiGatewayV2::Integration',Replacement:'False',Scope:['Properties'],
   Details:[{Target:{Attribute:'Properties',Name:'IntegrationUri',RequiresRecreation:'Never'},Evaluation:'Dynamic',
    ChangeSource:'ResourceAttribute',CausingEntity:'IdentityApiFunction.Arn'}]}}),
  f=>f.detailed.Changes.push(structuredClone(f.detailed.Changes[0])),f=>f.set.NextToken='unread',f=>f.detailed.NextToken='unread',
  f=>f.detailed.Changes[0].ResourceChange.AfterContext=undefined,
  f=>f.detailed.Changes[0].ResourceChange.BeforeContext='{broken',
  f=>{f.after.Properties.Timeout='30';f.detailed.Changes[0].ResourceChange.AfterContext=JSON.stringify(f.after);},
  f=>{f.after.Properties.Role='other';f.detailed.Changes[0].ResourceChange.AfterContext=JSON.stringify(f.after);},
  f=>{f.after.Properties.Code.S3Bucket='other';f.detailed.Changes[0].ResourceChange.AfterContext=JSON.stringify(f.after);},
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Target.BeforeValue='other',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Target.AfterValue='other',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Target.Path='/Properties/Code/S3Bucket',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Target.AttributeChangeType='Remove',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Evaluation='Dynamic',
  f=>f.detailed.Changes[0].ResourceChange.Details.pop()
 ]){const changed=make();change(changed);assert.throws(()=>verifyCareIntentChangeSetViews(changed.set,changed.detailed,changed.input.template,changed.input,changed.binding));}
});
test('CLI has no saved-report, target, execution or SQL override and preserves write custody until settled',()=>{
 const upload=readFileSync(new URL('./upload-synthetic-care-intent-release.mjs',import.meta.url),'utf8');
 const proposal=readFileSync(new URL('./prepare-synthetic-care-intent-code-change.mjs',import.meta.url),'utf8');
 assert.match(upload,/prepareCareIntentRelease\(root,mobileRoot,directory\)/);
 assert.match(upload,/const fresh=await prepareCareIntentRelease/);
 assert.match(upload,/uploadAndVerifyCareArtifact/);
 assert.match(upload,/if\(!admitted\|\|settled\)/);assert.match(upload,/admit\(\{stage:'artifact_put_admitted'/);
 assert.match(upload,/maxAttempts:1/);assert.match(upload,/operator.lock/);
 assert.match(proposal,/collectCancellationInventory\(aws,\['cloudformation','list-change-sets'/);
 assert.match(proposal,/'--client-token',digest/);assert.match(proposal,/verifyCareCodeChangeSet/);
 assert.match(proposal,/'--no-include-property-values','--no-paginate'/);
 assert.match(proposal,/verifyCareIntentChangeSetViews\(summary,set/);
 assert.doesNotMatch(upload+proposal,/'execute-change-set'|'update-stack'|'update-function-code'|'execute-statement'|'commit-transaction'|--report|--target|process\.env/);
 const shared=readFileSync(new URL('./upload-synthetic-care-release.mjs',import.meta.url),'utf8');
 assert.match(shared,/IfNoneMatch: '\*'/);
});
test('custody preserves uncertain writes, settles only its own lock and journals admission before storage',()=>{
 const root=mkdtempSync(join(tmpdir(),'alp-intent-custody-'));
 try{
  const f=fixture(),out=join(root,'uploads'),first=createIntentUploadCustody(root,out,f.current);
  first.record({stage:'read_only_failure'});first.close();assert.equal(existsSync(first.lock),false);
  const unknown=createIntentUploadCustody(root,out,f.current);
  assert.throws(()=>createIntentUploadCustody(root,out,f.current),/operator_lock/);
  unknown.admit({stage:'artifact_put_admitted',key:f.candidate.manifest.key});unknown.close();
  assert.equal(existsSync(unknown.lock),true);
  const events=readFileSync(unknown.journal,'utf8').trim().split('\n').map(x=>JSON.parse(x));
  assert.equal(events[0].stage,'artifact_put_admitted');
  assert.equal(JSON.parse(readFileSync(unknown.lock,'utf8')).runId,unknown.runId);
  unknown.settle();unknown.close();assert.equal(existsSync(unknown.lock),false);
  const changed=createIntentUploadCustody(root,out,f.current);
  const saved=JSON.parse(readFileSync(changed.lock,'utf8'));saved.pid++;
  writeFileSync(changed.lock,JSON.stringify(saved)+'\n');
  assert.throws(()=>changed.close(),/custody_changed/);assert.equal(existsSync(changed.lock),true);
 }finally{
  assert.equal(dirname(resolve(root)),resolve(tmpdir()));
  assert.match(root.slice(dirname(root).length+1),/^alp-intent-custody-/);
  rmSync(root,{recursive:true,force:true});
 }
});
test('unknown upload/proposal diagnostics never expose credential, command or response text',()=>{
 assert.equal(intentFailureCode(new Error('secret SQL token')),'synthetic_care_intent_release_refused:upload_or_proposal_unconfirmed');
 assert.equal(intentFailureCode(new Error('synthetic_care_intent_release_refused:source_changed')),'synthetic_care_intent_release_refused:source_changed');
 assert.equal(intentFailureCode(new Error('synthetic_care_intent_release_refused:bad\nsecret')),'synthetic_care_intent_release_refused:upload_or_proposal_unconfirmed');
});
