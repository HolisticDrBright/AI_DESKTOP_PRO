import {build} from 'esbuild';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
const out='dist/aws-clinical-core/owned-lab';mkdirSync(out,{recursive:true});
await Promise.all([
  build({entryPoints:['src/server/clinical-core/owned-lab-api-lambda.ts'],outfile:`${out}/api/index.js`,bundle:true,platform:'node',target:'node22',format:'cjs',minify:true,legalComments:'none',logLevel:'warning'}),
  build({entryPoints:['src/server/clinical-core/owned-lab-worker-lambda.ts'],outfile:`${out}/worker/index.js`,bundle:true,platform:'node',target:'node22',format:'cjs',minify:true,legalComments:'none',logLevel:'warning'}),
]);
// Reuse the proven durable lab pipeline (job ledger, encrypted documents, five-pass
// state machine, deletion outbox), not its synthetic identity gate. This emits a
// default-blocked candidate only; it never deploys or inserts human approvals.
const source=JSON.parse(readFileSync('infra/aws-clinical-core/lab-analysis-extension.json','utf8'));
const ref=name=>({Ref:name}),sub=value=>({'Fn::Sub':value});
const dropped=name=>name.includes('Synthetic');
const resources=Object.fromEntries(Object.entries(source.Resources).filter(([name,resource])=>!dropped(name)
  &&!(resource.Type==='AWS::ApiGatewayV2::Route'&&!String(resource.Properties.RouteKey).includes('/clinical-core/consumer/'))));
// Rename every synthetic identifier, namespace and tag; the personal namespace is
// enforced again at runtime by LAB_OBJECT_PREFIX and the cleanup posture gate.
const renamed=JSON.parse(JSON.stringify(resources).replaceAll('-synthetic-lab','-personal-lab').replaceAll('synthetic-labs/','personal-labs/')
  .replaceAll('"synthetic-staging"','"production-clinical"').replaceAll('"synthetic_only"','"personal_health_record"').replaceAll('synthetic-lab-consumer','personal-lab-consumer'));
const keepParams=['ClinicalApiId','ClinicalCoreKeyArn','LambdaCodeBucket','ApiCodeKey','WorkerCodeKey','OpenAISecretArn','OpenAIModel',
  'LabRangeMode','LabRangeReleaseBucket','LabRangeReleaseKey','LabRangeReleaseSha256','LabRangeSignerPublicKeyPem',
  'KnowledgeReleaseMode','KnowledgeReleaseBucket','KnowledgeReleaseKey','KnowledgeReleaseObjectVersion','KnowledgeReleaseSha256','KnowledgeSourcePackageSha256','KnowledgeSignerPublicKeyPem'];
const template={AWSTemplateFormatVersion:'2010-09-09',Description:'Independent consumer lab/document processing candidate; default blocked, no seeded approvals',
  Parameters:Object.fromEntries(keepParams.map(k=>[k,source.Parameters[k]])),
  Conditions:{...Object.fromEntries(['ReviewedRanges','ReviewedKnowledge'].map(k=>[k,source.Conditions[k]])),
    Active:{'Fn::And':[{'Fn::Equals':[ref('PhiAllowed'),'true']},{'Fn::Equals':[ref('Activation'),'approved']},
      {'Fn::Not':[{'Fn::Equals':[ref('ActivationEvidenceSha256'),'']}]},{'Fn::Not':[{'Fn::Equals':[ref('ProviderEvidenceSha256'),'']}]}]},
    HasAlarmRecipient:{'Fn::Not':[{'Fn::Equals':[ref('AlarmTopicArn'),'']}]}},
  Resources:renamed,
  Outputs:{PhiAllowed:{Value:ref('PhiAllowed')},Activation:{Value:ref('Activation')},JobTable:{Value:ref('LabJobTable')},DocumentBucket:{Value:ref('LabDocumentsBucket')}}};
Object.assign(template.Parameters,{
  ConsumerIssuer:{Type:'String',AllowedPattern:'^https://cognito-idp\\.[a-z0-9-]+\\.amazonaws\\.com/[A-Za-z0-9_-]+$'},
  ConsumerAudience:{Type:'String',AllowedPattern:'^[a-zA-Z0-9]{20,128}$'},
  PhiAllowed:{Type:'String',AllowedValues:['false','true'],Default:'false'},
  Activation:{Type:'String',AllowedValues:['blocked','approved'],Default:'blocked'},
  ActivationEvidenceSha256:{Type:'String',Default:'',AllowedPattern:'^$|^[a-f0-9]{64}$'},
  ProviderEvidenceSha256:{Type:'String',Default:'',AllowedPattern:'^$|^[a-f0-9]{64}$'},
  AllowedScopes:{Type:'String',Default:'',AllowedValues:['','ai_context,lab_history']},
  DatabaseClusterArn:{Type:'String',AllowedPattern:'^arn:aws:rds:[a-z0-9-]+:[0-9]{12}:cluster:[A-Za-z0-9-]+$'},
  DatabaseSecretArn:{Type:'String',AllowedPattern:'^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@!-]+$'},
  SecretKmsKeyArn:{Type:'String',AllowedPattern:'^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]{36}$'},
  DatabaseName:{Type:'String',AllowedPattern:'^[a-z][a-z0-9_]{0,62}$'},
  BillingApiOrigin:{Type:'String',Default:'',AllowedPattern:'^$|^https://[a-z0-9-]+\\.execute-api\\.[a-z0-9-]+\\.amazonaws\\.com$'},
  AlarmTopicArn:{Type:'String',Default:'',AllowedPattern:'^$|^arn:aws:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]+$'},
});
for(const key of ['ApiCodeKey','WorkerCodeKey'])delete template.Parameters[key].Default;
template.Rules={ActivationRequiresReviewedConfiguration:{RuleCondition:{'Fn::Equals':[ref('PhiAllowed'),'true']},Assertions:[
  {Assert:{'Fn::Equals':[ref('Activation'),'approved']},AssertDescription:'Activation review must be approved'},
  ...['ActivationEvidenceSha256','ProviderEvidenceSha256','DatabaseClusterArn','DatabaseSecretArn','DatabaseName','AlarmTopicArn','BillingApiOrigin'].map(name=>({Assert:{'Fn::Not':[{'Fn::Equals':[ref(name),'']}]},AssertDescription:`${name} required before activation`})),
  {Assert:{'Fn::Equals':[ref('AllowedScopes'),'ai_context,lab_history']},AssertDescription:'Explicit lab-history and AI scopes required'},
  {Assert:{'Fn::Equals':[ref('LabRangeMode'),'reviewed_release']},AssertDescription:'Personal documents may only be classified against a signed reviewed range release'},
]},...(source.Rules??{})};
const R=template.Resources;
// Consumer identity: production pool issuer/audience are explicit parameters;
// the runtime additionally verifies production binding and refuses synthetic attestation.
R.LabConsumerAuthorizer.Properties.JwtConfiguration={Issuer:ref('ConsumerIssuer'),Audience:[ref('ConsumerAudience')]};
R.LabJobTable.Properties.PointInTimeRecoverySpecification={PointInTimeRecoveryEnabled:true};
delete R.LabJobTable.DeletionPolicy;R.LabJobTable.DeletionPolicy='Retain';R.LabJobTable.UpdateReplacePolicy='Retain';
R.LabDocumentsBucket.DeletionPolicy='Retain';R.LabDocumentsBucket.UpdateReplacePolicy='Retain';
delete R.LabDocumentsBucket.Properties.CorsConfiguration; // native uploads only; browser origins need separate review
// A processing deadline is not deletion authority. Native Dynamo TTL and S3
// expiry cannot consult owner holds, so neither may erase personal records.
// Retention cleanup must use the hold-aware worker under an approved policy.
delete R.LabJobTable.Properties.TimeToLiveSpecification;
delete R.LabDocumentsBucket.Properties.LifecycleConfiguration;
const production={CONSUMER_ISSUER:ref('ConsumerIssuer'),CONSUMER_AUDIENCE:ref('ConsumerAudience'),PHI_ALLOWED:ref('PhiAllowed'),
  PERSONAL_LAB_ACTIVATION:ref('Activation'),PERSONAL_LAB_EVIDENCE_SHA256:ref('ActivationEvidenceSha256'),PERSONAL_LAB_PROVIDER_EVIDENCE_SHA256:ref('ProviderEvidenceSha256'),
  PERSONAL_LAB_ALLOWED_SCOPES:ref('AllowedScopes'),BILLING_AWS_API_ORIGIN:ref('BillingApiOrigin'),LAB_OBJECT_PREFIX:'personal-labs',DATA_CLASSIFICATION:'personal_health_record',
  CLINICAL_DATABASE_CLUSTER_ARN:ref('DatabaseClusterArn'),CLINICAL_DATABASE_SECRET_ARN:ref('DatabaseSecretArn'),CLINICAL_DATABASE_NAME:ref('DatabaseName')};
for(const name of ['LabApiFunction','LabWorkerFunction'])Object.assign(R[name].Properties.Environment.Variables,production);
Object.assign(R.LabCleanupFunction.Properties.Environment.Variables,production);
R.LabApiFunction.Properties.ReservedConcurrentExecutions=8;
R.LabWorkerFunction.Properties.ReservedConcurrentExecutions=4;
const database=[{Effect:'Allow',Action:['rds-data:BeginTransaction','rds-data:CommitTransaction','rds-data:RollbackTransaction','rds-data:ExecuteStatement'],Resource:ref('DatabaseClusterArn')},
  {Effect:'Allow',Action:'secretsmanager:GetSecretValue',Resource:ref('DatabaseSecretArn')},
  {Effect:'Allow',Action:'kms:Decrypt',Resource:ref('SecretKmsKeyArn'),Condition:{StringEquals:{
    'kms:ViaService':sub('secretsmanager.${AWS::Region}.amazonaws.com'),'kms:EncryptionContext:SecretARN':ref('DatabaseSecretArn')}}}];
// Logs-only by default; every data, provider, workflow and database permission
// exists only while the reviewed activation condition holds.
function gate(roleName,logsPolicyName,extra=[]){
  const role=R[roleName].Properties;
  const policies=role.Policies;
  const logs=policies.find(p=>p.PolicyName===logsPolicyName);
  const rest=policies.filter(p=>p!==logs);
  role.Policies=[{PolicyName:'LogsOnly',PolicyDocument:logs.PolicyDocument},
    ...rest.map(p=>p['Fn::If']?{'Fn::If':['Active',{'Fn::If':[p['Fn::If'][0],p['Fn::If'][1],ref('AWS::NoValue')]},ref('AWS::NoValue')]}:{'Fn::If':['Active',p,ref('AWS::NoValue')]}),
    ...(extra.length?[{'Fn::If':['Active',{PolicyName:'OwnedConsentDatabase',PolicyDocument:{Version:'2012-10-17',Statement:extra}},ref('AWS::NoValue')]}]:[])];
}
gate('LabApiRole','LabApiLogs',database);
gate('LabWorkerRole','LabWorkerLogs',database);
const cleanupRole=R.LabCleanupRole.Properties;
const cleanupStatements=cleanupRole.Policies[0].PolicyDocument.Statement;
const cleanupLogs=cleanupStatements.find(s=>Array.isArray(s.Action)&&s.Action.includes('logs:PutLogEvents'));
cleanupRole.Policies=[{PolicyName:'LogsOnly',PolicyDocument:{Version:'2012-10-17',Statement:[cleanupLogs]}},
  {'Fn::If':['Active',{PolicyName:'ScopedPersonalLabCleanup',PolicyDocument:{Version:'2012-10-17',Statement:[...cleanupStatements.filter(s=>s!==cleanupLogs),...database]}},ref('AWS::NoValue')]}];
for(const name of ['LabCancellationPolicy','LabInventoryQueryPolicy'])R[name].Condition='Active';
for(const name of ['LabCleanupSweepRule','LabCleanupObjectRule'])R[name].Properties.State={'Fn::If':['Active','ENABLED','DISABLED']};
for(const [name,fn] of [['LabApiFailureAlarm','LabApiFunction'],['LabWorkerFailureAlarm','LabWorkerFunction']])R[name]={Type:'AWS::CloudWatch::Alarm',Properties:{
  Namespace:'AWS/Lambda',MetricName:'Errors',Dimensions:[{Name:'FunctionName',Value:ref(fn)}],Statistic:'Sum',Period:60,EvaluationPeriods:1,Threshold:1,
  ComparisonOperator:'GreaterThanOrEqualToThreshold',TreatMissingData:'notBreaching',AlarmActions:{'Fn::If':['HasAlarmRecipient',[ref('AlarmTopicArn')],ref('AWS::NoValue')]}}};
if(R.LabCleanupFailureAlarm)R.LabCleanupFailureAlarm.Properties.AlarmActions={'Fn::If':['HasAlarmRecipient',[ref('AlarmTopicArn')],ref('AWS::NoValue')]};
if(R.LabCleanupQueueAlarm)R.LabCleanupQueueAlarm.Properties.AlarmActions={'Fn::If':['HasAlarmRecipient',[ref('AlarmTopicArn')],ref('AWS::NoValue')]};
for(const name of Object.keys(R))if(R[name].Properties?.LogGroupName?.['Fn::Sub'])R[name].Properties.LogGroupName=sub(String(R[name].Properties.LogGroupName['Fn::Sub']).replace('synthetic-staging','production/personal-lab'));
writeFileSync(`${out}/template.json`,JSON.stringify(template,null,2));
console.log('Built owned lab Lambdas and default-blocked deployment candidate. No deployment or activation performed.');
