import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLogRecovery, observeLogRecovery, main } from './prepare-qualification-log-recovery.mjs';

const prefix = 'arn:aws:cloudformation:us-east-2:588966314750:stack/';
const stackName = 'ai-clinical-core-qualification-personal-storage';
const foundationName = 'ai-clinical-core-qualification-foundation';
const stackId = `${prefix}${stackName}/00000000-0000-4000-8000-000000000001`;
const kms = 'arn:aws:kms:us-east-2:588966314750:key/00000000-0000-4000-8000-000000000002';
const logName = '/aws/lambda/6zt8e9qz04-personal-storage';
function fixture() {
  const values = { ApiId:'6zt8e9qz04', DatabaseName:'clinical_core_qualification', PhiAllowed:'false',
    Activation:'blocked', QualificationExecution:'enabled', QualificationAccountId:'588966314750', LogsKmsKeyArn:kms };
  return {
    identity: { Account:'588966314750' },
    foundation: { Stacks:[{ StackName:foundationName, StackId:`${prefix}${foundationName}/fictional`, StackStatus:'CREATE_COMPLETE',
      Outputs:Object.entries({...values, QualificationExecution:'disabled'}).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue})) }] },
    stack: { Stacks:[{ StackName:stackName, StackId:stackId, StackStatus:'ROLLBACK_COMPLETE',
      Parameters:Object.entries(values).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue})) }] },
    resources:{ StackResources:Object.entries({Logs:'AWS::Logs::LogGroup',Function:'AWS::Lambda::Function',Role:'AWS::IAM::Role',
      ConsumerAuthorizer:'AWS::ApiGatewayV2::Authorizer',ApiFailureAlarm:'AWS::CloudWatch::Alarm'}).map(([LogicalResourceId,ResourceType])=>({
        LogicalResourceId,ResourceType,StackId:stackId,ResourceStatus:LogicalResourceId==='Logs'?'DELETE_SKIPPED':'DELETE_COMPLETE',
        PhysicalResourceId:LogicalResourceId==='Logs'?logName:LogicalResourceId==='Function'?'6zt8e9qz04-personal-storage':'fictional-deleted-id',
      })) },
    template:{ TemplateBody:{ Resources:{ Logs:{ Type:'AWS::Logs::LogGroup',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',
      Properties:{LogGroupName:{'Fn::Sub':'/aws/lambda/${ApiId}-personal-storage'},RetentionInDays:30,KmsKeyId:{Ref:'LogsKmsKeyArn'}} } } } },
    function:null, logs:{logGroups:[{logGroupName:logName,logGroupClass:'STANDARD',retentionInDays:30,kmsKeyId:kms,creationTime:1000,storedBytes:0}]},
    key:{KeyMetadata:{Arn:kms,Enabled:true,KeyState:'Enabled',KeyUsage:'ENCRYPT_DECRYPT'}},
  };
}
test('proposal preserves the named log and both retain policies without authorizing any operation',()=>{
  const report=planLogRecovery(fixture());
  assert.equal(report.executionAuthorized,false); assert.equal(report.deploymentPerformed,false);
  assert.equal(report.activationEvidence,false); assert.equal(report.readOnlyAws,true);
  assert.deepEqual(Object.keys(report.importTemplate.Resources),['Logs']);
  assert.equal(report.importTemplate.Resources.Logs.DeletionPolicy,'Retain');
  assert.equal(report.importTemplate.Resources.Logs.UpdateReplacePolicy,'Retain');
  assert.deepEqual(report.resourcesToImport,[{ResourceType:'AWS::Logs::LogGroup',LogicalResourceId:'Logs',ResourceIdentifier:{LogGroupName:logName}}]);
  assert.equal(report.proposalSha256,planLogRecovery(fixture()).proposalSha256);
});
test('nonempty retained logs remain preservable and never become deletion authority',()=>{
  const value=fixture(); value.logs.logGroups[0].storedBytes=999;
  const result=planLogRecovery(value); assert.equal(result.observedStoredBytes,999);
  assert.equal(result.executionAuthorized,false); assert.notEqual(result.proposalSha256,planLogRecovery(fixture()).proposalSha256);
});
for (const [name,mutate] of Object.entries({
  account:v=>{v.identity.Account='173535830222';},
  foundation_state:v=>{v.foundation.Stacks[0].StackStatus='UPDATE_IN_PROGRESS';},
  foreign_stack:v=>{v.stack.Stacks[0].StackId=stackId.replace('588966314750','173535830222');},
  wrong_database:v=>{v.foundation.Stacks[0].Outputs.find(r=>r.OutputKey==='DatabaseName').OutputValue='clinical_core';},
  phi_enabled:v=>{v.stack.Stacks[0].Parameters.find(r=>r.ParameterKey==='PhiAllowed').ParameterValue='true';},
  duplicate_parameter:v=>{v.stack.Stacks[0].Parameters.push(v.stack.Stacks[0].Parameters[0]);},
  missing_resource:v=>{v.resources.StackResources.pop();},
  unexpected_resource:v=>{v.resources.StackResources[2].ResourceType='AWS::S3::Bucket';},
  resource_still_live:v=>{v.resources.StackResources[2].ResourceStatus='CREATE_COMPLETE';},
  resource_from_other_stack:v=>{v.resources.StackResources[0].StackId+='changed';},
  duplicate_log:v=>{v.logs.logGroups.push(v.logs.logGroups[0]);},
  wrong_retention:v=>{v.logs.logGroups[0].retentionInDays=7;},
  replacement_deletes:v=>{v.template.TemplateBody.Resources.Logs.UpdateReplacePolicy='Delete';},
  unsupported_log_properties:v=>{v.template.TemplateBody.Resources.Logs.Properties.DataProtectionPolicy={};},
  live_function:v=>{v.function={State:'Active'};},
  disabled_key:v=>{v.key.KeyMetadata.Enabled=false;},
  pending_key_deletion:v=>{v.key.KeyMetadata.KeyState='PendingDeletion';},
  other_key:v=>{v.logs.logGroups[0].kmsKeyId=kms.replace('000002','000003');},
})) test(`refuses ${name}`,()=>{const value=fixture();mutate(value);assert.throws(()=>planLogRecovery(value),/qualification_log_recovery_refused:/);});

test('live reader uses only fixed read calls and does not read log events or secrets',()=>{
  const value=fixture(),calls=[];
  const responses={'sts.get-caller-identity':value.identity,'cloudformation.describe-stacks':[value.foundation,value.stack],
    'cloudformation.describe-stack-resources':value.resources,'cloudformation.get-template':value.template,
    'lambda.get-function-configuration':null,'logs.describe-log-groups':value.logs,'kms.describe-key':value.key};
  const result=observeLogRecovery(args=>{calls.push(args);const key=args.slice(0,2).join('.');
    assert.ok(Object.hasOwn(responses,key));return key==='cloudformation.describe-stacks'?responses[key].shift():responses[key];});
  assert.equal(calls.length,8);assert.equal(result.executionAuthorized,false);
  assert.ok(calls.every(args=>!args.some(s=>/delete|execute|create-change|GetSecretValue|filter-log-events/i.test(s))));
});
test('wrong caller stops before any other AWS observation',()=>{
  let calls=0;assert.throws(()=>observeLogRecovery(()=>{calls++;return{Account:'173535830222'};}),/account/);assert.equal(calls,1);
});
test('CLI rejects mutation and profile flags before touching AWS',()=>{
  for(const args of [[],['--deploy','yes'],['--out','file','--execute'],['--profile','production']]) assert.throws(()=>main(args),/arguments/);
});
