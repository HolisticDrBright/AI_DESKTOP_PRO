import {expect,it,vi} from 'vitest';
import {fullscriptQualificationTemplate} from '../../../scripts/fullscript-qualification-template.mjs';
import {expectedFullscriptInstalledControls,verifyFullscriptInstalledControls,observeFullscriptInstalledControls} from './qualification-deployment-controls';
import {fictionalInstalledControls} from './qualification-deployment-controls.fixture';
import type {DeploymentPlan,DeploymentObservation} from './qualification-deployment-execution';
// Fictional installed metadata, not cloud qualification or an owner review.
function fixture(){
 const template=fullscriptQualificationTemplate({contract:'fullscript-api-build/1',clean:true,sourceCommit:'a'.repeat(40),zipSha256:'b'.repeat(64),
  codeSha256:Buffer.from('b'.repeat(64),'hex').toString('base64'),handler:'index.handler',runtime:'nodejs22.x',phiAllowed:false,activation:'blocked',
  execution:'qualification_only',deployed:false,targetEmbedded:false,hostedQualified:false});
 const values={FunctionName:'alp-fullscript-qualification-fictional',ApiId:'fictionalapi',ConsumerPoolId:'us-east-2_FictionalConsumer',WorkforcePoolId:'us-east-2_FictionalWorkforce',
  OrganizationId:'fictional-org',TargetKey:'fictional-target.json',TargetObjectVersion:'exact-version',DatabaseClusterArn:'fictional-cluster',DatabaseSecretArn:'fictional-db-secret',
  DatabaseSecretKmsKeyArn:'',ProviderSecretArn:'fictional-provider-secret',ProviderSecretVersion:'pinned-provider-version',ProviderSecretKmsKeyArn:'',TokenTableName:'fictional-tokens',AlarmTopicArn:'fictional-topic'};
 const plan={templateBody:JSON.stringify(template),parameters:Object.entries(values).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue})),
  target:{target:{functionArn:'arn:aws:lambda:us-east-2:588966314750:function:'+values.FunctionName}}} as DeploymentPlan;
 const o:DeploymentObservation={stack:null,proposal:null,template:null,function:null,routes:[],authorizers:[],integrations:[],
  resources:Object.entries(template.Resources as Record<string,{Type:string}>).map(([LogicalResourceId,r])=>({LogicalResourceId,ResourceType:r.Type,
  PhysicalResourceId:LogicalResourceId==='Role'?'fictional-role':LogicalResourceId==='Version'?plan.target.target.functionArn+':1':'fictional-'+LogicalResourceId}))};
 o.controls=fictionalInstalledControls(plan,o);return {plan,o,c:o.controls};
}
it('matches installed controls without claiming effective IAM, alarm delivery or hosted behavior',()=>{
 const {plan,o}=fixture();expect(verifyFullscriptInstalledControls(plan,o)).toEqual({installedControlsObserved:true,iamQualified:false,alarmDeliveryProven:false});
 const e=expectedFullscriptInstalledControls(plan,o),s=(e.inline as {Statement:Record<string,unknown>[]}).Statement;
 expect(s.find(r=>r.Sid==='PinnedProviderCredential')).toMatchObject({Resource:'fictional-provider-secret',Condition:{StringEquals:{'secretsmanager:VersionId':'pinned-provider-version'}}});
 expect(s.find(r=>r.Sid==='ExactTargetVersion')).toMatchObject({Condition:{StringEquals:{'s3:VersionId':'exact-version'}}});expect(s.some(r=>String(r.Sid).includes('Decrypt'))).toBe(false);
});
it('resolves optional customer keys only with the reviewed service and secret context',()=>{
 const {plan,o}=fixture();plan.parameters.find(p=>p.ParameterKey==='ProviderSecretKmsKeyArn')!.ParameterValue='fictional-key';o.controls=fictionalInstalledControls(plan,o);
 expect(verifyFullscriptInstalledControls(plan,o).installedControlsObserved).toBe(true);
 expect((expectedFullscriptInstalledControls(plan,o).inline as {Statement:Record<string,unknown>[]}).Statement.find(r=>r.Sid==='ProviderSecretDecrypt')).toMatchObject({Resource:'fictional-key',
  Condition:{StringEquals:{'kms:ViaService':'secretsmanager.us-east-2.amazonaws.com','kms:EncryptionContext:SecretARN':'fictional-provider-secret'}}});
});
it('accepts URL-encoded IAM documents and semantic statement/action ordering',()=>{
 const {plan,o,c}=fixture();const inline=c.inline.PolicyDocument as {Statement:Record<string,unknown>[]};inline.Statement.reverse();
 for(const s of inline.Statement)if(Array.isArray(s.Action))(s.Action as unknown[]).reverse();
 c.inline.PolicyDocument=encodeURIComponent(JSON.stringify(inline));const role=c.role.Role as Record<string,unknown>;role.AssumeRolePolicyDocument=encodeURIComponent(JSON.stringify(role.AssumeRolePolicyDocument));
 expect(verifyFullscriptInstalledControls(plan,o).installedControlsObserved).toBe(true);
});
it.each(['missing','role','trust','boundary','attached','inline-extra','inline-missing','inline-wildcard','secret-pin','target-version','table-scope','policy-page','attached-page','duplicate-statement',
 'invoke-resource','invoke-account','invoke-path','invoke-principal','invoke-extra','invoke-duplicate-sid','concurrency','log-retention','log-duplicate','log-page','alarm-topic','alarm-disabled','alarm-extra-action',
 'alarm-period','alarm-metric','alarm-account','alarm-duplicate','alarm-missing','alarm-page','alarm-unit','alarm-math','alarm-vote'])('refuses installed %s',kind=>{
 const {plan,o,c}=fixture(),role=c.role.Role as Record<string,unknown>,inline=c.inline.PolicyDocument as {Statement:Record<string,unknown>[]},alarms=c.alarms.MetricAlarms as Record<string,unknown>[];
 const invoke=JSON.parse(c.lambdaPolicy.Policy as string);
 if(kind==='missing')delete o.controls;if(kind==='role')role.Arn='foreign';if(kind==='trust')role.AssumeRolePolicyDocument={Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:'*',Action:'sts:AssumeRole'}]};
 if(kind==='boundary')role.PermissionsBoundary={PermissionsBoundaryArn:'unexpected'};if(kind==='attached')c.attached.AttachedPolicies=[{PolicyArn:'AdministratorAccess'}];
 if(kind==='inline-extra')inline.Statement.push({Sid:'extra',Effect:'Allow',Action:'*',Resource:'*'});if(kind==='inline-missing')inline.Statement.pop();
 if(kind==='inline-wildcard')inline.Statement[0].Resource='*';if(kind==='duplicate-statement')inline.Statement.push(inline.Statement[0]);
 if(kind==='secret-pin')(inline.Statement.find(s=>s.Sid==='PinnedProviderCredential')!.Condition as Record<string,unknown>).StringEquals={};
 if(kind==='target-version')(inline.Statement.find(s=>s.Sid==='ExactTargetVersion')!.Condition as Record<string,unknown>).StringEquals={'s3:VersionId':'other'};
 if(kind==='table-scope')delete inline.Statement.find(s=>s.Sid==='ClinicCredentialCustody')!.Condition;
 if(kind==='policy-page')c.policyNames.IsTruncated=true;if(kind==='attached-page')c.attached.Marker='unfinished';
 if(kind==='invoke-resource')invoke.Statement[0].Resource='*';if(kind==='invoke-account')invoke.Statement[0].Condition.StringEquals['AWS:SourceAccount']='173535830222';
 if(kind==='invoke-path')invoke.Statement[0].Condition.ArnLike['AWS:SourceArn']='*';if(kind==='invoke-principal')invoke.Statement[0].Principal='*';
 if(kind==='invoke-extra')invoke.Statement.push(invoke.Statement[0]);if(kind==='invoke-duplicate-sid')invoke.Statement[1].Sid=invoke.Statement[0].Sid;c.lambdaPolicy.Policy=JSON.stringify(invoke);
 if(kind==='concurrency')c.concurrency.ReservedConcurrentExecutions=2;if(kind==='log-retention')(c.logs.logGroups as Record<string,unknown>[])[0].retentionInDays=0;
 if(kind==='log-duplicate')(c.logs.logGroups as unknown[]).push((c.logs.logGroups as unknown[])[0]);if(kind==='log-page')c.logs.nextToken='unfinished';
 if(kind==='alarm-topic')alarms[0].AlarmActions=['other'];if(kind==='alarm-disabled')alarms[0].ActionsEnabled=false;if(kind==='alarm-extra-action')alarms[0].OKActions=['other'];
 if(kind==='alarm-period')alarms[0].Period=300;if(kind==='alarm-metric')alarms[0].MetricName='Duration';if(kind==='alarm-account')alarms[0].AlarmArn='foreign';
 if(kind==='alarm-duplicate')alarms.push(alarms[0]);if(kind==='alarm-missing')alarms.pop();if(kind==='alarm-page')c.alarms.NextToken='unfinished';
 if(kind==='alarm-unit')alarms[0].Unit='Count';if(kind==='alarm-math')alarms[0].Metrics=[];if(kind==='alarm-vote')alarms[0].DatapointsToAlarm=2;
 expect(()=>verifyFullscriptInstalledControls(plan,o)).toThrow(/^fullscript_deployment_controls_refused$/);
});
it('collector reads exact role, qualified version, logs and two named alarms without a write',async()=>{
 const {plan,o}=fixture(),read=vi.fn(async(_service:string,_action:string,_input:Record<string,unknown>)=>({}));await observeFullscriptInstalledControls(plan,o,read);
 expect(read.mock.calls.map(([s,a])=>s+'/'+a)).toEqual(['iam/get-role','iam/list-role-policies','iam/list-attached-role-policies','iam/get-role-policy','lambda/get-policy','lambda/get-function-concurrency','logs/describe-log-groups','cloudwatch/describe-alarms']);
 expect(read.mock.calls[4][2]).toEqual({FunctionName:plan.target.target.functionArn+':1'});
});
it('collector fails closed on permission errors and never returns raw payload text',async()=>{
 const {plan,o}=fixture();await expect(observeFullscriptInstalledControls(plan,o,async()=>{throw Error('SECRET');})).rejects.toThrow(/^fullscript_deployment_controls_refused$/);
});
