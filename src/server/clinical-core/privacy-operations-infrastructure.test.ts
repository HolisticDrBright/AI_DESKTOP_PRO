import {beforeAll,describe,expect,it} from 'vitest';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync} from 'node:fs';
type Json=null|boolean|number|string|Json[]|{[key:string]:Json};
let t:{Parameters:Record<string,{Default?:string}>;Conditions:Record<string,Json>;Rules:Json;Resources:Record<string,{Type:string;Properties:Record<string,Json>;DeletionPolicy?:string}>};
beforeAll(()=>{
  execFileSync(process.execPath,['scripts/build-aws-privacy-operations.mjs'],{stdio:'pipe'});
  t=JSON.parse(readFileSync('dist/aws-clinical-core/privacy-operations/template.json','utf8'));
},20000);
function evaluate(v:Json,p:Record<string,string>):unknown{
  if(v===null||typeof v!=='object')return v;if(Array.isArray(v))return v.map(x=>evaluate(x,p));
  if(typeof v.Ref==='string')return p[v.Ref]??'';
  const equals=v['Fn::Equals'];if(equals){const a=evaluate(equals,p) as unknown[];return a[0]===a[1];}
  if(v['Fn::Not'])return !(evaluate(v['Fn::Not'],p) as unknown[])[0];
  if(v['Fn::And'])return (evaluate(v['Fn::And'],p) as unknown[]).every(Boolean);
  if(v['Fn::Or'])return (evaluate(v['Fn::Or'],p) as unknown[]).some(Boolean);
  if(typeof v.Condition==='string')return evaluate(t.Conditions[v.Condition],p);
  throw new Error('unsupported_condition');
}
describe('privacy operations deployable candidate',()=>{
  it('keeps retained inventories separately disabled and grants only pinned table scans, never deletion or object reads',()=>{
    expect(t.Parameters.ExternalInventoryEnabled.Default).toBe('false');expect(t.Parameters.ExternalInventoryEvidenceSha256.Default).toBe('');
    const policies=t.Resources.Role.Properties.Policies as Record<string,Json>[];
    const branch=policies[2]['Fn::If'] as Json[];expect(branch[0]).toBe('InventoryActive');
    expect(JSON.stringify(branch[1])).toContain('dynamodb:Scan');
    expect(JSON.stringify(branch[1])).not.toMatch(/Delete|Put|Update|s3:|transcribe:|"Resource":"\*"/);
    expect(JSON.stringify(branch[1])).toContain('kms:EncryptionContext:aws:dynamodb:tableName');
    expect(JSON.stringify(branch[1])).toContain('"dynamodb:Select":"SPECIFIC_ATTRIBUTES"');
    expect(JSON.stringify(branch[1])).toContain('ForAllValues:StringEquals');
    expect(branch[2]).toEqual({Ref:'AWS::NoValue'});
  });
  it('grants external purge only behind inventory activation, its own evidence and pinned destinations, never table scans of bodies or wildcard resources',()=>{
    expect(t.Parameters.ExternalPurgeEnabled.Default).toBe('false');expect(t.Parameters.ExternalPurgeEvidenceSha256.Default).toBe('');
    const policies=t.Resources.Role.Properties.Policies as Record<string,Json>[];
    const branch=policies[3]['Fn::If'] as Json[];expect(branch[0]).toBe('PurgeActive');
    const text=JSON.stringify(branch[1]);
    for(const action of ['dynamodb:UpdateItem','dynamodb:DeleteItem','s3:ListBucketVersions','s3:DeleteObjectVersion','states:StopExecution','transcribe:DeleteTranscriptionJob','kms:GenerateDataKey'])expect(text).toContain(action);
    for(const forbidden of ['dynamodb:Scan','dynamodb:Query','s3:GetObject','s3:PutObject','transcribe:StartTranscriptionJob','"Resource":"*"','synthetic-labs','temporary-input'])expect(text).not.toContain(forbidden);
    expect(text).toContain('personal-labs/*');expect(text).toContain('personal-voice/*');expect(text).toContain('alp-personal-voice-*');
    expect(branch[2]).toEqual({Ref:'AWS::NoValue'});
    const defaults=Object.fromEntries(Object.entries(t.Parameters).map(([k,v])=>[k,v.Default??'']));
    const inventory={...defaults,PhiAllowed:'true',Activation:'approved',ActivationEvidenceSha256:'a'.repeat(64),DatabaseReviewSha256:'b'.repeat(64),
      WorkforceMfaReviewSha256:'c'.repeat(64),AlarmTopicArn:'arn:aws:sns:us-east-2:123456789012:reviewed',ExternalInventoryEnabled:'true',
      ExternalInventoryEvidenceSha256:'d'.repeat(64),LabTableArn:'arn:aws:dynamodb:us-east-2:123456789012:table/labs',VoiceTableArn:'arn:aws:dynamodb:us-east-2:123456789012:table/voice',
      LabTableKmsKeyArn:'arn:aws:kms:us-east-2:123456789012:key/00000000-0000-4000-8000-000000000000',VoiceTableKmsKeyArn:'arn:aws:kms:us-east-2:123456789012:key/00000000-0000-4000-8000-000000000001'};
    const purge={...inventory,ExternalPurgeEnabled:'true',ExternalPurgeEvidenceSha256:'e'.repeat(64),LabDocumentBucket:'lab-bucket',
      LabStateMachineArn:'arn:aws:states:us-east-2:123456789012:stateMachine:abc-personal-lab-analysis',VoiceBucket:'voice-bucket',VoiceKmsKeyArn:'arn:aws:kms:us-east-2:123456789012:key/00000000-0000-4000-8000-000000000002'};
    const conditions={...t.Conditions};
    const evaluateWith=(name:string,p:Record<string,string>):boolean=>{
      const resolve=(v:Json):Json=>{if(v&&typeof v==='object'&&!Array.isArray(v)&&typeof (v as Record<string,Json>).Condition==='string')return evaluateWith((v as Record<string,string>).Condition,p);
        if(Array.isArray(v))return v.map(resolve);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,resolve(x)]));return v;};
      return evaluate(resolve(conditions[name]),p) as boolean;};
    expect(evaluateWith('PurgeActive',inventory)).toBe(false);expect(evaluateWith('PurgeActive',purge)).toBe(true);
    for(const key of ['ExternalInventoryEnabled','ExternalPurgeEvidenceSha256','LabDocumentBucket','LabStateMachineArn','VoiceBucket','VoiceKmsKeyArn','PhiAllowed'])
      expect(evaluateWith('PurgeActive',{...purge,[key]:defaults[key]})).toBe(false);
    expect(t.Rules).toMatchObject({ReviewedExternalPurge:{RuleCondition:{'Fn::Equals':[{Ref:'ExternalPurgeEnabled'},'true']}}});
    const env=(t.Resources.Function.Properties.Environment as {Variables:Record<string,Json>}).Variables;
    expect(env.LAB_OBJECT_PREFIX).toBe('personal-labs');expect(env.EXTERNAL_PURGE_ENABLED).toEqual({Ref:'ExternalPurgeEnabled'});
  });
  it('grants identity deletion only behind activation, its own evidence and the pinned consumer pool, with exactly the three admin actions',()=>{
    expect(t.Parameters.IdentityDeletionEnabled.Default).toBe('false');expect(t.Parameters.ConsumerUserPoolId.Default).toBe('');
    const policies=t.Resources.Role.Properties.Policies as Record<string,Json>[];
    const branch=policies[4]['Fn::If'] as Json[];expect(branch[0]).toBe('IdentityDeletionActive');
    const statements=((branch[1] as Record<string,Json>).PolicyDocument as Record<string,Json>).Statement as Record<string,Json>[];
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toEqual(['cognito-idp:AdminDisableUser','cognito-idp:AdminUserGlobalSignOut','cognito-idp:AdminDeleteUser']);
    expect(JSON.stringify(statements[0].Resource)).toContain('userpool/${ConsumerUserPoolId}');
    expect(JSON.stringify(branch[1])).not.toMatch(/AdminCreateUser|AdminSetUserPassword|ListUsers|"Resource":"\*"/);
    expect(branch[2]).toEqual({Ref:'AWS::NoValue'});
    expect(t.Rules).toMatchObject({ReviewedIdentityDeletion:{RuleCondition:{'Fn::Equals':[{Ref:'IdentityDeletionEnabled'},'true']}}});
    const env=(t.Resources.Function.Properties.Environment as {Variables:Record<string,Json>}).Variables;
    expect(env.CONSUMER_USER_POOL_ID).toEqual({Ref:'ConsumerUserPoolId'});expect(env.IDENTITY_DELETION_ENABLED).toEqual({Ref:'IdentityDeletionEnabled'});
  });
  it('grants export retention only listing, abort, versioned delete and HEAD under the export prefix, behind its own condition',()=>{
    expect(t.Parameters.ExportCleanupEnabled.Default).toBe('false');expect(t.Parameters.ExportBucketName.Default).toBe('');expect(t.Parameters.ExportKmsKeyArn.Default).toBe('');
    const policies=t.Resources.Role.Properties.Policies as Record<string,Json>[];
    const branch=policies[5]['Fn::If'] as Json[];expect(branch[0]).toBe('ExportCleanupActive');
    const text=JSON.stringify(branch[1]);
    for(const action of ['s3:ListBucketVersions','s3:ListBucketMultipartUploads','s3:AbortMultipartUpload','s3:DeleteObjectVersion'])expect(text).toContain(action);
    // No object reads at all: cleanup proves absence by listing, so no HEAD (GetObjectVersion), no GetObject, no KMS.
    for(const forbidden of ['s3:GetObject','s3:PutObject','s3:DeleteObject"','kms:','"Resource":"*"','personal-labs','personal-voice'])expect(text).not.toContain(forbidden);
    const statements=((branch[1] as Record<string,Json>).PolicyDocument as Record<string,Json>).Statement as Record<string,Json>[];
    const versions=statements.find(s=>s.Action==='s3:ListBucketVersions')!,uploads=statements.find(s=>s.Action==='s3:ListBucketMultipartUploads')!;
    expect(versions.Condition).toMatchObject({StringLike:{'s3:prefix':'personal-exports/*'}});
    expect(JSON.stringify(uploads.Condition)).not.toContain('s3:prefix'); // unsupported for this action; bucket-level on the dedicated export bucket
    expect(text).toContain('personal-exports/*');
    expect(branch[2]).toEqual({Ref:'AWS::NoValue'});
    expect(t.Rules).toMatchObject({ReviewedExportCleanup:{RuleCondition:{'Fn::Equals':[{Ref:'ExportCleanupEnabled'},'true']}}});
    const defaults=Object.fromEntries(Object.entries(t.Parameters).map(([k,v])=>[k,v.Default??'']));
    const active={...defaults,PhiAllowed:'true',Activation:'approved',ActivationEvidenceSha256:'a'.repeat(64),DatabaseReviewSha256:'b'.repeat(64),
      WorkforceMfaReviewSha256:'c'.repeat(64),AlarmTopicArn:'arn:aws:sns:us-east-2:123456789012:reviewed'};
    const cleanup={...active,ExportCleanupEnabled:'true',ExportCleanupEvidenceSha256:'f'.repeat(64),ExportBucketName:'fictional-export-bucket',
      ExportKmsKeyArn:'arn:aws:kms:us-east-2:123456789012:key/00000000-0000-4000-8000-000000000003'};
    const resolve=(v:Json,p:Record<string,string>):Json=>{if(v&&typeof v==='object'&&!Array.isArray(v)&&typeof (v as Record<string,Json>).Condition==='string')return evaluate(resolve(t.Conditions[(v as Record<string,string>).Condition],p),p) as Json;
      if(Array.isArray(v))return v.map(x=>resolve(x,p));if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,resolve(x,p)]));return v;};
    expect(evaluate(resolve(t.Conditions.ExportCleanupActive,active),active)).toBe(false);
    expect(evaluate(resolve(t.Conditions.ExportCleanupActive,cleanup),cleanup)).toBe(true);
    for(const key of ['ExportCleanupEnabled','ExportCleanupEvidenceSha256','ExportBucketName','ExportKmsKeyArn','PhiAllowed'])
      expect(evaluate(resolve(t.Conditions.ExportCleanupActive,{...cleanup,[key]:defaults[key]}),{...cleanup,[key]:defaults[key]})).toBe(false);
    const env=(t.Resources.Function.Properties.Environment as {Variables:Record<string,Json>}).Variables;
    expect(env.EXPORT_CLEANUP_ENABLED).toEqual({Ref:'ExportCleanupEnabled'});
    expect(env.PERSONAL_EXPORT_BUCKET).toEqual({'Fn::If':['ExportCleanupActive',{Ref:'ExportBucketName'},'']});
  });
  it('ships the scheduled retention sweep disabled: its function, hourly rule, permission and alarms exist only under RetentionScheduleActive, which needs the reviewed service identity',()=>{
    expect(t.Parameters.RetentionScheduleEnabled.Default).toBe('false');expect(t.Parameters.RetentionServicePersonId.Default).toBe('');expect(t.Parameters.RetentionServiceSubject.Default).toBe('');
    for(const name of ['RetentionSweep','RetentionSweepSchedule','RetentionSweepInvoke','RetentionOverdueAlarm','RetentionRefusedAlarm'])expect((t.Resources[name] as {Condition?:string}).Condition).toBe('RetentionScheduleActive');
    expect(t.Resources.RetentionSweep.Properties).toMatchObject({Handler:'retention-sweep.handler',ReservedConcurrentExecutions:1,Timeout:600});
    expect(t.Resources.RetentionSweepSchedule.Properties).toMatchObject({ScheduleExpression:'rate(1 hour)'});
    expect(t.Resources.RetentionSweepInvoke.Properties).toMatchObject({Principal:'events.amazonaws.com'});
    expect(t.Resources.RetentionOverdueAlarm.Properties).toMatchObject({Namespace:'ALP/PrivacyExportRetention',MetricName:'OldestOverdueSeconds',TreatMissingData:'breaching',Threshold:{Ref:'RetentionOverdueAlarmSeconds'}});
    expect(t.Resources.RetentionRefusedAlarm.Properties).toMatchObject({MetricName:'SweepRefused',TreatMissingData:'breaching'});
    const env=(t.Resources.RetentionSweep.Properties.Environment as {Variables:Record<string,Json>}).Variables;
    expect(env.RETENTION_SWEEP_ENABLED).toEqual({Ref:'RetentionScheduleEnabled'});expect(env.RETENTION_SERVICE_PERSON_ID).toEqual({Ref:'RetentionServicePersonId'});
    expect(JSON.stringify(env)).not.toMatch(/WORKFORCE_ISSUER|CONSUMER_USER_POOL_ID|VOICE_BUCKET/);
    expect((t.Resources.Function.Properties.Environment as {Variables:Record<string,Json>}).Variables.RETENTION_SWEEP_ENABLED).toBe('false');
    expect(t.Rules).toMatchObject({ReviewedRetentionSchedule:{RuleCondition:{'Fn::Equals':[{Ref:'RetentionScheduleEnabled'},'true']}}});
    expect(Object.values(t.Resources).filter(r=>r.Type==='AWS::ApiGatewayV2::Route')).toHaveLength(1);
    expect(readFileSync('dist/aws-clinical-core/privacy-operations/retention-sweep.js','utf8').length).toBeGreaterThan(1000);
    const lifecycle=JSON.parse(readFileSync('infra/aws-clinical-core/personal-export-bucket-lifecycle.json','utf8')) as {Rules:Array<Record<string,Json>>};
    expect(lifecycle.Rules.every(r=>(r.Filter as {Prefix:string}).Prefix==='personal-exports/'&&r.Status==='Enabled')).toBe(true);
    expect(lifecycle.Rules.some(r=>(r.AbortIncompleteMultipartUpload as {DaysAfterInitiation:number})?.DaysAfterInitiation===1)).toBe(true);
    expect(lifecycle.Rules.some(r=>(r.NoncurrentVersionExpiration as {NoncurrentDays:number})?.NoncurrentDays===1)).toBe(true);
  });
  it('remains blocked unless every separate approval and alarm destination exists',()=>{
    const defaults=Object.fromEntries(Object.entries(t.Parameters).map(([k,v])=>[k,v.Default??'']));
    const approved={...defaults,PhiAllowed:'true',Activation:'approved',ActivationEvidenceSha256:'a'.repeat(64),
      DatabaseReviewSha256:'b'.repeat(64),WorkforceMfaReviewSha256:'c'.repeat(64),AlarmTopicArn:'arn:aws:sns:us-east-2:123456789012:reviewed'};
    expect(evaluate(t.Conditions.Active,defaults)).toBe(false);expect(evaluate(t.Conditions.Active,approved)).toBe(true);
    for(const key of ['PhiAllowed','Activation','ActivationEvidenceSha256','DatabaseReviewSha256','WorkforceMfaReviewSha256','AlarmTopicArn'])
      expect(evaluate(t.Conditions.Active,{...approved,[key]:defaults[key]})).toBe(false);
    const policies=t.Resources.Role.Properties.Policies as Json[];
    expect(JSON.stringify(policies[0])).not.toMatch(/rds-data:|secretsmanager:|kms:/);
    // Database access rides Enabled: the production activation or the qualification execution, both false by default.
    expect((policies[1] as Record<string,Json>)['Fn::If']).toEqual(['Enabled',expect.any(Object),{Ref:'AWS::NoValue'}]);
    expect(evaluate(t.Conditions.Enabled,defaults)).toBe(false);
    expect(JSON.stringify(policies)).not.toContain('"Resource":"*"');
  });
  it('enables qualification execution only with PHI disabled, activation blocked, the deploying synthetic account, a qualification database and the reviewed inputs, and lets the sub-activations ride it on their own evidence',()=>{
    const defaults=Object.fromEntries(Object.entries(t.Parameters).map(([k,v])=>[k,String((v as {Default?:unknown}).Default??'')]));
    expect(t.Parameters.QualificationExecution.Default).toBe('disabled');
    const qualified={...defaults,'AWS::AccountId':'588966314750',QualificationExecution:'enabled',QualificationReviewSha256:'e'.repeat(64),QualificationAccountId:'588966314750',
      QualificationIdentitySubjects:'workforce-sub-00000001',DatabaseName:'clinical_core_qualification',DatabaseReviewSha256:'b'.repeat(64),WorkforceMfaReviewSha256:'c'.repeat(64),AlarmTopicArn:'arn:aws:sns:us-east-2:588966314750:alarms'};
    expect(evaluate(t.Conditions.Qualification,qualified)).toBe(true);expect(evaluate(t.Conditions.Enabled,qualified)).toBe(true);expect(evaluate(t.Conditions.Active,qualified)).toBe(false);
    for(const key of ['QualificationExecution','QualificationReviewSha256','QualificationAccountId','QualificationIdentitySubjects','DatabaseReviewSha256','WorkforceMfaReviewSha256','AlarmTopicArn'])
      expect(evaluate(t.Conditions.Qualification,{...qualified,[key]:defaults[key]}),key).toBe(false);
    expect(evaluate(t.Conditions.Qualification,{...qualified,DatabaseName:'clinical_core'})).toBe(false);
    expect(evaluate(t.Conditions.Qualification,{...qualified,'AWS::AccountId':'173535830222',QualificationAccountId:'173535830222'})).toBe(false);
    expect(evaluate(t.Conditions.Qualification,{...qualified,PhiAllowed:'true'})).toBe(false);
    expect(evaluate(t.Conditions.Qualification,{...qualified,Activation:'approved'})).toBe(false);
    // Export cleanup and the retention schedule need the same reviewed inputs under qualification as in production.
    expect(evaluate(t.Conditions.ExportCleanupActive,qualified)).toBe(false);
    const cleanup={...qualified,ExportCleanupEnabled:'true',ExportCleanupEvidenceSha256:'d'.repeat(64),ExportBucketName:'fictional-export-bucket',ExportKmsKeyArn:'arn:aws:kms:us-east-2:588966314750:key/11111111-1111-4111-8111-111111111111'};
    expect(evaluate(t.Conditions.ExportCleanupActive,cleanup)).toBe(true);
    expect(evaluate(t.Conditions.RetentionScheduleActive,cleanup)).toBe(false);
    expect(evaluate(t.Conditions.RetentionScheduleActive,{...cleanup,RetentionScheduleEnabled:'true',RetentionScheduleEvidenceSha256:'f'.repeat(64),RetentionServicePersonId:'11111111-1111-4111-8111-111111111111',RetentionServiceSubject:'workforce-sub-00000001',RetentionServiceOrganizationId:'22222222-2222-4222-8222-222222222222'})).toBe(true);
    const env=(t.Resources.Function.Properties.Environment as {Variables:Record<string,Json>}).Variables,sweep=(t.Resources.RetentionSweep.Properties.Environment as {Variables:Record<string,Json>}).Variables;
    expect(env.QUALIFICATION_EXECUTION).toEqual({'Fn::If':['Qualification','enabled','disabled']});
    expect(sweep.QUALIFICATION_EXECUTION).toEqual({'Fn::If':['Qualification','enabled','disabled']});expect(sweep.PRIVACY_OPERATIONS_ACTIVATION).toEqual({Ref:'Activation'});
    expect(JSON.stringify((t.Rules as Record<string,Json>).QualificationRequiresSyntheticPosture)).toContain('173535830222');
  });
  it('has one dedicated workforce JWT route and bounded encrypted infrastructure',()=>{
    expect(t.Parameters.PersonalPurgeEnabled.Default).toBe('false');
    expect(t.Parameters.PersonalPurgeEvidenceSha256.Default).toBe('');
    expect(t.Rules).toMatchObject({ReviewedPersonalPurge:{RuleCondition:{'Fn::Equals':[{Ref:'PersonalPurgeEnabled'},'true']},
      Assertions:[{Assert:{'Fn::Or':[{'Fn::Equals':[{Ref:'PhiAllowed'},'true']},{'Fn::Equals':[{Ref:'QualificationExecution'},'enabled']}]},AssertDescription:expect.any(String)},
        {Assert:{'Fn::Not':[{'Fn::Equals':[{Ref:'PersonalPurgeEvidenceSha256'},'']}]},AssertDescription:expect.any(String)}]}});
    expect(Object.values(t.Resources).filter(r=>r.Type==='AWS::ApiGatewayV2::Route')).toHaveLength(1);
    expect(t.Resources.Route.Properties).toMatchObject({RouteKey:'POST /clinical-core/workforce/privacy-operations',AuthorizationType:'JWT',AuthorizerId:{Ref:'Authorizer'}});
    expect(t.Resources.Authorizer.Properties.JwtConfiguration).toEqual({Issuer:{Ref:'WorkforceIssuer'},Audience:[{Ref:'WorkforceAudience'}]});
    expect(t.Resources.Function.Properties.Code).toMatchObject({S3ObjectVersion:{Ref:'CodeVersion'}});
    expect(t.Resources.Logs.Properties.KmsKeyId).toEqual({Ref:'LogsKmsKeyArn'});expect(t.Resources.Logs.DeletionPolicy).toBe('Retain');
    expect(t.Resources.ApiFailureAlarm.Properties.MetricName).toBe('5xx');
  });
  it('bundled disabled runtime makes no AWS connection without credentials',async()=>{
    const child=await promisify(execFile)(process.execPath,['-e',"require('./dist/aws-clinical-core/privacy-operations/index.js').handler({routeKey:'POST /clinical-core/workforce/privacy-operations'}).then(r=>console.log(JSON.stringify(r)))"],{
      // Match a deployment child, not the parent's Vitest preloads. The outer
      // artifact-check budget includes the original ten-second process bound.
      encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,NODE_ENV:'production',
        WORKFORCE_ISSUER:'https://cognito-idp.us-east-2.amazonaws.com/workforce',
        WORKFORCE_AUDIENCE:'12345678901234567890',PHI_ALLOWED:'false',PRIVACY_OPERATIONS_ACTIVATION:'blocked',
        CLINICAL_DATABASE_CLUSTER_ARN:'',CLINICAL_DATABASE_SECRET_ARN:'',CLINICAL_DATABASE_NAME:'',AWS_EC2_METADATA_DISABLED:'true',
        AWS_ACCESS_KEY_ID:'',AWS_SECRET_ACCESS_KEY:'',AWS_SESSION_TOKEN:''}});
    expect(child.stderr).toBe('');expect(JSON.parse(child.stdout).statusCode).toBe(503);
  },15000);
});
