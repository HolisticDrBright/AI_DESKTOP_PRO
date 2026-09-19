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
  it('remains blocked unless every separate approval and alarm destination exists',()=>{
    const defaults=Object.fromEntries(Object.entries(t.Parameters).map(([k,v])=>[k,v.Default??'']));
    const approved={...defaults,PhiAllowed:'true',Activation:'approved',ActivationEvidenceSha256:'a'.repeat(64),
      DatabaseReviewSha256:'b'.repeat(64),WorkforceMfaReviewSha256:'c'.repeat(64),AlarmTopicArn:'arn:aws:sns:us-east-2:123456789012:reviewed'};
    expect(evaluate(t.Conditions.Active,defaults)).toBe(false);expect(evaluate(t.Conditions.Active,approved)).toBe(true);
    for(const key of ['PhiAllowed','Activation','ActivationEvidenceSha256','DatabaseReviewSha256','WorkforceMfaReviewSha256','AlarmTopicArn'])
      expect(evaluate(t.Conditions.Active,{...approved,[key]:defaults[key]})).toBe(false);
    const policies=t.Resources.Role.Properties.Policies as Json[];
    expect(JSON.stringify(policies[0])).not.toMatch(/rds-data:|secretsmanager:|kms:/);
    expect((policies[1] as Record<string,Json>)['Fn::If']).toEqual(['Active',expect.any(Object),{Ref:'AWS::NoValue'}]);
    expect(JSON.stringify(policies)).not.toContain('"Resource":"*"');
  });
  it('has one dedicated workforce JWT route and bounded encrypted infrastructure',()=>{
    expect(t.Parameters.PersonalPurgeEnabled.Default).toBe('false');
    expect(t.Parameters.PersonalPurgeEvidenceSha256.Default).toBe('');
    expect(t.Rules).toMatchObject({ReviewedPersonalPurge:{RuleCondition:{'Fn::Equals':[{Ref:'PersonalPurgeEnabled'},'true']},
      Assertions:[{Assert:{'Fn::Equals':[{Ref:'PhiAllowed'},'true']},AssertDescription:expect.any(String)},
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
