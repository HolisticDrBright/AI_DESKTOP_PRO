import {build} from 'esbuild';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
const out='dist/aws-clinical-core/owned-voice';mkdirSync(out,{recursive:true});
await build({entryPoints:['src/server/clinical-core/owned-voice-api-lambda.ts'],outfile:`${out}/index.js`,bundle:true,platform:'node',target:'node22',format:'cjs',minify:true,legalComments:'none'});
await build({entryPoints:['src/server/clinical-core/owned-voice-inventory-cli.ts'],outfile:`${out}/inventory.cjs`,bundle:true,platform:'node',target:'node22',format:'cjs',legalComments:'none'});
// Reuse the proven durable provider infrastructure, not its identity/consent gate.
// This emits a candidate only; it never deploys or inserts human approval records.
const source=JSON.parse(readFileSync('infra/aws-clinical-core/chat-transcription-extension.json','utf8'));
const resources=Object.fromEntries(Object.entries(source.Resources).filter(([name])=>name.startsWith('Voice')||['TranscriptionBucket','TranscriptionBucketPolicy','TranscriptionLogGroup'].includes(name)));
const ref=name=>({Ref:name}),sub=value=>({'Fn::Sub':value});
for(const resource of Object.values(resources))delete resource.Condition;
const template={AWSTemplateFormatVersion:'2010-09-09',Description:'Independent consumer voice processing candidate; default blocked, no seeded approvals',
  Parameters:Object.fromEntries(['ClinicalApiId','ConsumerJwtAuthorizerId','ClinicalCoreKeyArn','LambdaCodeBucket','VoiceJobsCodeKey'].map(k=>[k,source.Parameters[k]])),
  Conditions:{Active:{'Fn::And':[
    {'Fn::Equals':[ref('PhiAllowed'),'true']},{'Fn::Equals':[ref('Activation'),'approved']},
    {'Fn::Not':[{'Fn::Equals':[ref('ActivationEvidenceSha256'),'']}]},{'Fn::Not':[{'Fn::Equals':[ref('ProviderEvidenceSha256'),'']}]}
  ]},HasAlarmRecipient:{'Fn::Not':[{'Fn::Equals':[ref('AlarmTopicArn'),'']}]}},
  Resources:resources,Outputs:{PhiAllowed:{Value:ref('PhiAllowed')},Activation:{Value:ref('Activation')},JobTable:{Value:ref('VoiceJobTable')},AudioBucket:{Value:ref('TranscriptionBucket')}}};
Object.assign(template.Parameters,{
  ConsumerIssuer:{Type:'String',AllowedPattern:'^https://cognito-idp\\.[a-z0-9-]+\\.amazonaws\\.com/[A-Za-z0-9_-]+$'},
  ConsumerAudience:{Type:'String',AllowedPattern:'^[a-zA-Z0-9]{20,128}$'},
  PhiAllowed:{Type:'String',AllowedValues:['false','true'],Default:'false'},
  Activation:{Type:'String',AllowedValues:['blocked','approved','draining'],Default:'blocked'},
  CleanupEvidenceSha256:{Type:'String',Default:'',AllowedPattern:'^$|^[a-f0-9]{64}$'},
  ActivationEvidenceSha256:{Type:'String',Default:'',AllowedPattern:'^$|^[a-f0-9]{64}$'},
  ProviderEvidenceSha256:{Type:'String',Default:'',AllowedPattern:'^$|^[a-f0-9]{64}$'},
  AllowedScopes:{Type:'String',Default:'',AllowedValues:['','ai_context,voice_transcription']},
  DatabaseClusterArn:{Type:'String',AllowedPattern:'^arn:aws:rds:[a-z0-9-]+:[0-9]{12}:cluster:[A-Za-z0-9-]+$'},
  DatabaseSecretArn:{Type:'String',AllowedPattern:'^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@!-]+$'},
  SecretKmsKeyArn:{Type:'String',AllowedPattern:'^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]{36}$'},
  DatabaseName:{Type:'String',AllowedPattern:'^[a-z][a-z0-9_]{0,62}$'},
  BillingApiOrigin:{Type:'String',Default:'',AllowedPattern:'^$|^https://[a-z0-9-]+\\.execute-api\\.[a-z0-9-]+\\.amazonaws\\.com$'},
  AlarmTopicArn:{Type:'String',Default:'',AllowedPattern:'^$|^arn:aws:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]+$'}
});
delete template.Parameters.VoiceJobsCodeKey.Default;
template.Parameters.VoiceJobsCodeKey.AllowedPattern='^[A-Za-z0-9/_.-]{1,1024}$';
template.Rules={ActivationRequiresReviewedConfiguration:{RuleCondition:{'Fn::Equals':[ref('PhiAllowed'),'true']},Assertions:[
  {Assert:{'Fn::Equals':[ref('Activation'),'approved']},AssertDescription:'Activation review must be approved'},
  ...['ActivationEvidenceSha256','ProviderEvidenceSha256','DatabaseClusterArn','DatabaseSecretArn','DatabaseName','AlarmTopicArn','BillingApiOrigin'].map(name=>({Assert:{'Fn::Not':[{'Fn::Equals':[ref(name),'']}]},AssertDescription:`${name} required before activation`})),
  {Assert:{'Fn::Equals':[ref('AllowedScopes'),'ai_context,voice_transcription']},AssertDescription:'Explicit voice and AI scopes required'}
]}};
template.Conditions.Draining={'Fn::And':[
  {'Fn::Equals':[ref('PhiAllowed'),'false']},{'Fn::Equals':[ref('Activation'),'draining']},
  {'Fn::Not':[{'Fn::Equals':[ref('CleanupEvidenceSha256'),'']}]}
]};
template.Conditions.SweepEnabled={'Fn::Or':[{Condition:'Active'},{Condition:'Draining'}]};
template.Rules.DrainRequiresReviewedCleanup={RuleCondition:{'Fn::Equals':[ref('Activation'),'draining']},Assertions:[
  {Assert:{'Fn::Equals':[ref('PhiAllowed'),'false']},AssertDescription:'New content processing must be disabled during drain'},
  {Assert:{'Fn::Equals':[ref('AllowedScopes'),'']},AssertDescription:'No feature scopes during drain'},
  ...['CleanupEvidenceSha256','ActivationEvidenceSha256','ProviderEvidenceSha256','AlarmTopicArn','DatabaseClusterArn','DatabaseSecretArn','DatabaseName','SecretKmsKeyArn'].map(name=>({Assert:{'Fn::Not':[{'Fn::Equals':[ref(name),'']}]},AssertDescription:`${name} required for reviewed cleanup`}))
]};
resources.TranscriptionLogGroup.Properties.LogGroupName=sub('/ai-clinical-core/production/personal-voice/${ClinicalApiId}');
resources.VoiceJobTable.Properties.PointInTimeRecoverySpecification={PointInTimeRecoveryEnabled:true};
resources.TranscriptionBucket.Properties.VersioningConfiguration={Status:'Enabled'};
// Native expiry cannot consult legal holds. Processing/readability deadlines
// remain, but personal-record erasure must use the guarded cleanup path.
delete resources.TranscriptionBucket.Properties.LifecycleConfiguration;
delete resources.VoiceJobTable.Properties.TimeToLiveSpecification;
resources.VoiceJobFunction.Properties.Environment.Variables={
  VOICE_JOB_TABLE:ref('VoiceJobTable'),TRANSCRIPTION_BUCKET:ref('TranscriptionBucket'),VOICE_KMS_KEY_ARN:ref('ClinicalCoreKeyArn'),
  CONSUMER_ISSUER:ref('ConsumerIssuer'),CONSUMER_AUDIENCE:ref('ConsumerAudience'),PHI_ALLOWED:ref('PhiAllowed'),
  PERSONAL_VOICE_ACTIVATION:ref('Activation'),PERSONAL_VOICE_EVIDENCE_SHA256:ref('ActivationEvidenceSha256'),
  PERSONAL_VOICE_CLEANUP_EVIDENCE_SHA256:ref('CleanupEvidenceSha256'),
  PERSONAL_VOICE_PROVIDER_EVIDENCE_SHA256:ref('ProviderEvidenceSha256'),PERSONAL_VOICE_ALLOWED_SCOPES:ref('AllowedScopes'),
  BILLING_AWS_API_ORIGIN:ref('BillingApiOrigin'),
  CLINICAL_DATABASE_CLUSTER_ARN:ref('DatabaseClusterArn'),CLINICAL_DATABASE_SECRET_ARN:ref('DatabaseSecretArn'),CLINICAL_DATABASE_NAME:ref('DatabaseName')
};
resources.VoiceJobFunction.Properties.ReservedConcurrentExecutions=4;
const logPolicy={PolicyName:'LogsOnly',PolicyDocument:{Version:'2012-10-17',Statement:[resources.VoiceJobRole.Properties.Policies[0].PolicyDocument.Statement[0]]}};
const statements=resources.VoiceJobRole.Properties.Policies[0].PolicyDocument.Statement.slice(1);
const objectPolicy=statements.find(s=>Array.isArray(s.Action)&&s.Action.includes('s3:GetObject'));
objectPolicy.Action=['s3:GetObject','s3:PutObject','s3:DeleteObjectVersion'];
objectPolicy.Resource=sub('${TranscriptionBucket.Arn}/personal-voice/*');
statements.push({Effect:'Allow',Action:'s3:ListBucketVersions',Resource:{'Fn::GetAtt':['TranscriptionBucket','Arn']},Condition:{StringLike:{'s3:prefix':['personal-voice/input/*','personal-voice/output/*']}}});
statements.find(s=>Array.isArray(s.Action)&&s.Action.includes('transcribe:StartTranscriptionJob')).Resource=sub('arn:${AWS::Partition}:transcribe:${AWS::Region}:${AWS::AccountId}:transcription-job/alp-personal-voice-*');
const holdDatabase=[{Effect:'Allow',Action:['rds-data:BeginTransaction','rds-data:CommitTransaction','rds-data:RollbackTransaction','rds-data:ExecuteStatement'],Resource:ref('DatabaseClusterArn')},
  {Effect:'Allow',Action:['secretsmanager:GetSecretValue'],Resource:ref('DatabaseSecretArn')},
  {Effect:'Allow',Action:['kms:Decrypt'],Resource:ref('SecretKmsKeyArn'),Condition:{StringEquals:{
    'kms:ViaService':sub('secretsmanager.${AWS::Region}.amazonaws.com'),'kms:EncryptionContext:SecretARN':ref('DatabaseSecretArn')}}}];
statements.push(...holdDatabase);
resources.VoiceJobRole.Properties.Policies=[logPolicy,{'Fn::If':['Active',{PolicyName:'ScopedOwnedVoiceData',PolicyDocument:{Version:'2012-10-17',Statement:statements}},ref('AWS::NoValue')]}];
// Drain retains only maintenance access: no audio/transcript reads or writes,
// provider starts, billing or unrestricted KMS decryption. The scoped database
// guard is necessary during drain too; there is no hold-bypass cleanup mode.
const cleanupActions=new Set(['dynamodb:GetItem','dynamodb:UpdateItem','dynamodb:Query',
  's3:DeleteObjectVersion','s3:ListBucketVersions','transcribe:GetTranscriptionJob','transcribe:DeleteTranscriptionJob']);
const cleanupStatements=statements.flatMap(statement=>{
  const Action=(Array.isArray(statement.Action)?statement.Action:[statement.Action]).filter(a=>cleanupActions.has(a));
  return Action.length?[{...statement,Action}]:[];
});
cleanupStatements.push(...holdDatabase);
cleanupStatements.push({Effect:'Allow',Action:['kms:Encrypt','kms:Decrypt','kms:GenerateDataKey'],Resource:ref('ClinicalCoreKeyArn'),
  Condition:{StringEquals:{'kms:ViaService':sub('dynamodb.${AWS::Region}.amazonaws.com'),
    'kms:EncryptionContext:aws:dynamodb:tableName':ref('VoiceJobTable'),
    'kms:EncryptionContext:aws:dynamodb:subscriberId':ref('AWS::AccountId')}}});
resources.VoiceJobRole.Properties.Policies.push({'Fn::If':['Draining',{PolicyName:'ScopedOwnedVoiceCleanup',
  PolicyDocument:{Version:'2012-10-17',Statement:cleanupStatements}},ref('AWS::NoValue')]});
resources.VoiceSweepRule.Properties.State={'Fn::If':['SweepEnabled','ENABLED','DISABLED']};
resources.VoiceFailureAlarm={Type:'AWS::CloudWatch::Alarm',Properties:{Namespace:'AWS/Lambda',MetricName:'Errors',Dimensions:[{Name:'FunctionName',Value:ref('VoiceJobFunction')}],
  Statistic:'Sum',Period:60,EvaluationPeriods:1,Threshold:1,ComparisonOperator:'GreaterThanOrEqualToThreshold',TreatMissingData:'notBreaching',
  AlarmActions:{'Fn::If':['HasAlarmRecipient',[ref('AlarmTopicArn')],ref('AWS::NoValue')]}}};
writeFileSync(`${out}/template.json`,JSON.stringify(template,null,2));
console.log('Built owned voice Lambda and default-blocked deployment candidate. No deployment or activation performed.');
