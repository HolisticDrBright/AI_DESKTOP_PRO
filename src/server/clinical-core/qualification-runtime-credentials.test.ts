import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {buildQualificationFoundation} from '../../../scripts/build-aws-qualification-foundation.mjs';
import {CANDIDATES,qualificationValue} from '../../../scripts/build-aws-qualification-parameters.mjs';
import * as targets from './qualification-target-manifest';
import {observeQualificationTarget} from './qualification-target-observation';

const account='588966314750',region='us-east-2';
const secret=(name:string)=>`arn:aws:secretsmanager:${region}:${account}:secret:${name}`;
const api=secret('alp/qualification/runtime-api-fictional-AbCdEf');
const operator=secret('rds!cluster-fictional-AbCdEf');
const worker=secret('alp/qualification/fullscript-worker-fictional-GhIjKl');
const review='c'.repeat(64);
function fixture(){return {
 schemaVersion:'aws-clinical-core-qualification-target/4',environment:'synthetic-staging',dataClassification:'synthetic_only',containsPhi:false,
 awsAccountId:account,awsRegion:region,foundationStackName:'ai-clinical-core-qualification-foundation',apiId:'abcdefghij',
 apiOrigin:`https://abcdefghij.execute-api.${region}.amazonaws.com`,databaseClusterArn:`arn:aws:rds:${region}:${account}:cluster:fictional`,
 databaseSecretArn:api,operatorDatabaseSecretArn:operator,runtimeCredentialReviewSha256:review,databaseName:'clinical_core_qualification',
 exportBucket:'fictional-qualification-exports',recordingBucket:'fictional-qualification-recordings',sourceCommit:'a'.repeat(40),migrationReleaseHash:'b'.repeat(64),
 identitySubjects:{consumer:'fictional-owner',workforce:'fictional-practitioner',foreignConsumer:'fictional-peer'},
 stacks:Object.fromEntries(['personal-storage','privacy-operations','owned-lab','owned-voice','recording-authority','recording-capture',
  'recording-transcription','recording-drafting','recording-cleanup-review','recording-cleanup-execution','care-messaging','care-connections'].map(n=>[n,'qualification-'+n])),
 refused:{stagingFoundationStackName:'ai-clinical-core-synthetic',stagingApiOrigin:`https://klmnopqrst.execute-api.${region}.amazonaws.com`,stagingDatabaseName:'clinical_core'},
 reviewedAt:'2026-10-11T00:00:00Z',
};}
function foundationOutputs(){const m=fixture();return {PhiAllowed:'false',Activation:'blocked',QualificationExecution:'disabled',ApiId:m.apiId,ApiOrigin:m.apiOrigin,
 DatabaseName:m.databaseName,ExportBucketName:m.exportBucket,DatabaseClusterArn:m.databaseClusterArn,DatabaseSecretArn:operator,
 OperatorDatabaseSecretArn:operator,RuntimeApiDatabaseSecretArn:api,FullscriptWorkerDatabaseSecretArn:worker,RuntimeCredentialReviewSha256:review};}
function runner(outputs=foundationOutputs(),status='UPDATE_COMPLETE'){
 return (file:string,args:string[])=>file==='git'?fixture().sourceCommit:args[0]==='sts'?JSON.stringify({Account:account,Arn:`arn:aws:sts::${account}:assumed-role/Fictional/session`}):
 JSON.stringify({StackStatus:status,Outputs:Object.entries(outputs).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue})),Parameters:[]});
}
function evaluate(value:unknown,parameters:Record<string,string>,conditions:Record<string,unknown>):unknown{
 if(value===null||typeof value!=='object')return value;
 if(Array.isArray(value))return value.map(v=>evaluate(v,parameters,conditions));
 const v=value as Record<string,unknown>;
 if(typeof v.Ref==='string')return parameters[v.Ref];
 if(typeof v.Condition==='string')return evaluate(conditions[v.Condition],parameters,conditions);
 if(Array.isArray(v['Fn::Equals'])){const pair=evaluate(v['Fn::Equals'],parameters,conditions) as unknown[];return pair[0]===pair[1];}
 if(Array.isArray(v['Fn::Not']))return !(evaluate(v['Fn::Not'],parameters,conditions) as unknown[])[0];
 if(Array.isArray(v['Fn::And']))return (evaluate(v['Fn::And'],parameters,conditions) as unknown[]).every(x=>x===true);
 if(Array.isArray(v['Fn::Or']))return (evaluate(v['Fn::Or'],parameters,conditions) as unknown[]).some(x=>x===true);
 throw new Error('unsupported_rule');
}
describe('qualification runtime credential separation',()=>{
 it.each(Object.keys(CANDIDATES))('%s request parameter examples never suggest the master credential',candidate=>{
  expect(qualificationValue(candidate,'DatabaseSecretArn',{})).toMatch(/^arn:aws:secretsmanager:us-east-2:588966314750:secret:alp\/qualification\/runtime-api-/);
 });
 it('prepares distinct credential slots without creating roles secrets handlers or grants',()=>{
  const t=buildQualificationFoundation();
  expect(t.Parameters).toHaveProperty('RuntimeApiDatabaseSecretArn');
  expect(t.Parameters).toHaveProperty('FullscriptWorkerDatabaseSecretArn');
  expect(t.Parameters).toHaveProperty('RuntimeCredentialReviewSha256');
  expect(t.Outputs).toMatchObject({OperatorDatabaseSecretArn:{Value:{Ref:'DatabaseSecretArn'}},
   RuntimeApiDatabaseSecretArn:{Condition:'RuntimeBindingsSupplied',Value:{Ref:'RuntimeApiDatabaseSecretArn'}},
   FullscriptWorkerDatabaseSecretArn:{Condition:'RuntimeBindingsSupplied',Value:{Ref:'FullscriptWorkerDatabaseSecretArn'}}});
  expect(JSON.stringify(t.Resources)).not.toMatch(/AWS::SecretsManager::Secret|AWS::IAM::Role|AWS::Lambda::Function|CREATE ROLE|GRANT /);
  expect(t.Outputs.PhiAllowed.Value).toBe('false');expect(t.Outputs.Activation.Value).toBe('blocked');
 });
 it('enforces all-or-none bindings, distinct secrets and a nonzero review through actual foundation rules',()=>{
  const t=buildQualificationFoundation();
  const empty={'AWS::AccountId':account,'AWS::Region':region,DatabaseSecretArn:operator,
    RuntimeApiDatabaseSecretArn:'',FullscriptWorkerDatabaseSecretArn:'',RuntimeCredentialReviewSha256:''};
  const filled={...empty,RuntimeApiDatabaseSecretArn:api,FullscriptWorkerDatabaseSecretArn:worker,RuntimeCredentialReviewSha256:review};
  const accepts=(p:Record<string,string>)=>t.Rules.RuntimeCredentialBindings.Assertions.every(a=>evaluate(a.Assert,p,t.Conditions)===true);
  expect(accepts(empty)).toBe(true);expect(evaluate(t.Conditions.RuntimeBindingsSupplied,empty,t.Conditions)).toBe(false);
  expect(accepts(filled)).toBe(true);expect(evaluate(t.Conditions.RuntimeBindingsSupplied,filled,t.Conditions)).toBe(true);
  const names=['RuntimeApiDatabaseSecretArn','FullscriptWorkerDatabaseSecretArn','RuntimeCredentialReviewSha256'] as const;
  for(let mask=1;mask<7;mask++){
    const partial={...empty};names.forEach((name,i)=>{if(mask&(1<<i))partial[name]=filled[name];});
    expect(accepts(partial),`partial binding ${mask}`).toBe(false);
  }
  for(const patch of [{RuntimeApiDatabaseSecretArn:operator},{FullscriptWorkerDatabaseSecretArn:operator},
    {FullscriptWorkerDatabaseSecretArn:api},{RuntimeCredentialReviewSha256:'0'.repeat(64)}])expect(accepts({...filled,...patch})).toBe(false);
  expect(evaluate(t.Conditions.RuntimeBindingsSupplied,{...filled,'AWS::AccountId':'173535830222'},t.Conditions)).toBe(false);
  expect(evaluate(t.Conditions.RuntimeBindingsSupplied,{...filled,'AWS::Region':'us-west-2'},t.Conditions)).toBe(false);
 });
 it('keeps existing historical manifests unchanged and never falls back for invalid version four operator input',()=>{
  const m=targets.validateQualificationTargetManifest(fixture());
  expect(()=>targets.qualificationOperatorDatabase({...m,operatorDatabaseSecretArn:undefined})).toThrow();
  expect(()=>targets.qualificationOperatorDatabase({...m,operatorDatabaseSecretArn:api})).toThrow();
  const old:Record<string,unknown>={...fixture(),schemaVersion:'aws-clinical-core-qualification-target/3',databaseSecretArn:operator};
  delete old.operatorDatabaseSecretArn;delete old.runtimeCredentialReviewSha256;
  const historical=targets.validateQualificationTargetManifest(old);
  expect(targets.qualificationOperatorDatabase(historical).secretArn).toBe(operator);
  expect(historical).not.toHaveProperty('operatorDatabaseSecretArn');
 });
 it('keeps recording fixture administration explicitly wired through the operator selector',()=>{
  const source=readFileSync('src/server/clinical-core/recording-acceptance-cli.ts','utf8');
  expect(source).toContain('createRdsDataAdministrativeDatabase({ ...qualificationOperatorDatabase(manifest)');
  expect(source).not.toContain('createRdsDataAdministrativeDatabase({ ...target.database');
 });
 it('checks all four committed example versions offline and refuses every one as a run target',()=>{
  const output=JSON.parse(execFileSync(process.execPath,['scripts/check-aws-qualification-target.mjs','--examples'],{encoding:'utf8',timeout:30_000,windowsHide:true}));
  expect(output.ok).toBe(true);expect(output.examples).toHaveLength(4);
  expect(output.examples.every((v:{refusedAsRunTarget:string})=>v.refusedAsRunTarget==='target_placeholder')).toBe(true);
 });
 it('admits a version four manifest and keeps API and operator bindings separate',()=>{
  const m=targets.validateQualificationTargetManifest(fixture());
  const bound=targets.bindQualificationTarget(m,{awsAccountId:account,sourceCommit:m.sourceCommit,migrationReleaseHash:m.migrationReleaseHash},{});
  expect(bound.database.secretArn).toBe(api);
  const select=(targets as unknown as {qualificationOperatorDatabase:(m:targets.QualificationTargetManifest)=>{secretArn:string}}).qualificationOperatorDatabase;
  expect(select(m).secretArn).toBe(operator);
 });
 it('observes the foundation actual API and operator credential outputs independently',()=>{
  const m=targets.validateQualificationTargetManifest(fixture());
  expect(observeQualificationTarget(m,[],{runner:runner()}).source).toBe('observed');
 });
 it('the shared foundation output check also enforces version four separation',()=>{
  const m=targets.validateQualificationTargetManifest(fixture());
  expect(()=>targets.assertQualificationFoundationOutputs(foundationOutputs(),m)).not.toThrow();
  expect(()=>targets.assertQualificationFoundationOutputs({...foundationOutputs(),RuntimeApiDatabaseSecretArn:operator},m)).toThrow('target_stack_refused');
  expect(()=>targets.assertQualificationFoundationOutputs({PhiAllowed:'false'},m)).toThrow('target_stack_refused');
 });
 it.each(['operatorDatabaseSecretArn','runtimeCredentialReviewSha256'])('refuses a missing version four %s',field=>{
  const m:Record<string,unknown>=fixture();delete m[field];expect(()=>targets.validateQualificationTargetManifest(m)).toThrow();
 });
 it.each([
  ['master as request',()=>({databaseSecretArn:operator})],['same credential',()=>({operatorDatabaseSecretArn:api})],
  ['worker as request',()=>({databaseSecretArn:worker})],['API in production',()=>({databaseSecretArn:api.replace(account,'173535830222')})],
  ['operator in another account',()=>({operatorDatabaseSecretArn:operator.replace(account,'173535830222')})],
  ['zero review',()=>({runtimeCredentialReviewSha256:'0'.repeat(64)})],['missing review',()=>({runtimeCredentialReviewSha256:''})],
 ])('refuses %s',(_label,patch)=>expect(()=>targets.validateQualificationTargetManifest({...fixture(),...patch()})).toThrow());
 it.each(['RuntimeApiDatabaseSecretArn','OperatorDatabaseSecretArn','DatabaseClusterArn','RuntimeCredentialReviewSha256'])('refuses a mismatched observed foundation %s',field=>{
  const m=targets.validateQualificationTargetManifest(fixture());
  expect(()=>observeQualificationTarget(m,[],{runner:runner({...foundationOutputs(),[field]:'wrong'})})).toThrow('target_stack_refused');
 });
 it.each(['RuntimeApiDatabaseSecretArn','OperatorDatabaseSecretArn','DatabaseSecretArn','DatabaseClusterArn','RuntimeCredentialReviewSha256',
   'ApiId','ApiOrigin','DatabaseName','ExportBucketName'])('refuses an absent version four foundation output %s',field=>{
  const outputs:Record<string,string>=foundationOutputs();delete outputs[field];
  const m=targets.validateQualificationTargetManifest(fixture());
  expect(()=>observeQualificationTarget(m,[],{runner:runner(outputs as ReturnType<typeof foundationOutputs>)})).toThrow('target_stack_refused');
 });
 it('binds actual candidate parameters to the API credential, never the operator credential',()=>{
  const m=targets.validateQualificationTargetManifest(fixture());
  const outputs={PhiAllowed:'false',Activation:'blocked',QualificationExecution:'enabled',SourceCommit:m.sourceCommit};
  const parameters={DatabaseClusterArn:m.databaseClusterArn,DatabaseSecretArn:api,DatabaseName:m.databaseName,
    QualificationAccountId:account,ApiId:m.apiId,ExportBucketName:m.exportBucket,SourceCommit:m.sourceCommit,
    QualificationIdentitySubjects:targets.designatedSubjects(m.identitySubjects).join(',')};
  expect(()=>targets.assertQualificationStackOutputs('personal-storage',outputs,m,parameters,'CREATE_COMPLETE')).not.toThrow();
  for(const secretArn of [operator,worker,''])expect(()=>targets.assertQualificationStackOutputs('personal-storage',outputs,m,
    {...parameters,DatabaseSecretArn:secretArn},'CREATE_COMPLETE')).toThrow('target_stack_refused');
 });
 it('refuses an unfinished version four foundation',()=>{
  const m=targets.validateQualificationTargetManifest(fixture());expect(()=>observeQualificationTarget(m,[],{runner:runner(foundationOutputs(),'UPDATE_IN_PROGRESS')})).toThrow('target_stack_refused');
 });
 it('cannot override the request binding with the operator secret',()=>{
  const m=targets.validateQualificationTargetManifest(fixture());
  expect(()=>targets.bindQualificationTarget(m,{awsAccountId:account,sourceCommit:m.sourceCommit,migrationReleaseHash:m.migrationReleaseHash},{CLINICAL_DATABASE_SECRET_ARN:operator})).toThrow('target_override_refused');
 });
});
