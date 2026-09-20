import {readFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {beforeAll,describe,it,expect} from 'vitest';
import {OWNED_CONSUMER_ROUTES} from './owned-consumer-api';
import {OWNED_STORAGE_SCOPES} from './owned-consumer-records';
describe('personal storage deployment boundary',()=>{
  it('keeps the deployable candidate blocked with logs-only permissions and JWT routes',()=>{
    const script=readFileSync('scripts/build-aws-personal-storage.mjs','utf8');
    expect(script).toContain("PHI_ALLOWED:'false'");expect(script).toContain("PERSONAL_STORAGE_ACTIVATION:'blocked'");expect(script).toContain("PERSONAL_STORAGE_ALLOWED_SCOPES:''");
    expect(script).toContain("AuthorizationType:'JWT'");expect(script).toContain("['logs:CreateLogStream','logs:PutLogEvents']");expect(script).not.toMatch(/rds-data:|secretsmanager:GetSecretValue|s3:GetObject/);
    expect(script).toContain('GET chat-context');expect(script).toContain('GET posture');expect(script).toContain('POST active-plan/release');expect(script).toContain('POST privacy-request/tombstone');
  });
});

type Json = null | boolean | number | string | Json[] | {[key:string]:Json};
type Resource = {Type:string;Properties:Record<string,Json>;DeletionPolicy?:string;UpdateReplacePolicy?:string};
type Template = {Parameters:Record<string,{Default?:string;AllowedPattern?:string}>;Conditions:Record<string,Json>;Rules:Record<string,Json>;Resources:Record<string,Resource>};
let candidate:Template;
beforeAll(()=>{
  execFileSync(process.execPath,['scripts/build-aws-personal-storage.mjs'],{stdio:'pipe',timeout:15000});
  candidate=JSON.parse(readFileSync('dist/aws-clinical-core/personal-storage/template.json','utf8')) as Template;
},20000);

// Interpret the emitted IAM activation condition, not a source substring. Real
// CloudFormation schema validation runs separately; these are negative gates.
function condition(value:Json,parameters:Record<string,string>):unknown {
  if(value===null||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(v=>condition(v,parameters));
  if(typeof value.Ref==='string')return parameters[value.Ref]??'';
  if(value['Fn::Equals']){const v=condition(value['Fn::Equals'],parameters) as unknown[];return v[0]===v[1];}
  if(value['Fn::Not'])return !(condition(value['Fn::Not'],parameters) as unknown[])[0];
  if(value['Fn::And'])return (condition(value['Fn::And'],parameters) as unknown[]).every(Boolean);
  throw new Error('unsupported condition');
}
describe('functional personal storage deployment candidate',()=>{
  it('gives no database permissions by default and rejects every incomplete activation combination',()=>{
    const defaults=Object.fromEntries(Object.entries(candidate.Parameters).map(([k,v])=>[k,v.Default??'']));
    expect(condition(candidate.Conditions.Active,defaults)).toBe(false);
    const approved={...defaults,PhiAllowed:'true',Activation:'approved',ActivationEvidenceSha256:'a'.repeat(64),DatabaseReviewSha256:'b'.repeat(64),AllowedScopes:'lab_history',AlarmTopicArn:'arn:aws:sns:us-east-2:123456789012:reviewed'};
    expect(condition(candidate.Conditions.Active,approved)).toBe(true);
    for(const key of ['PhiAllowed','Activation','ActivationEvidenceSha256','DatabaseReviewSha256','AllowedScopes','AlarmTopicArn'])expect(condition(candidate.Conditions.Active,{...approved,[key]:defaults[key]}),key).toBe(false);
    const policies=candidate.Resources.Role.Properties.Policies as Json[];
    expect(policies).toHaveLength(3);
    expect(JSON.stringify(policies[0])).not.toMatch(/rds-data:|secretsmanager:|kms:|s3:/);
    expect((policies[1] as Record<string,Json>)['Fn::If']).toEqual(['Active',expect.any(Object),{Ref:'AWS::NoValue'}]);
    // Export delivery is a second, separately reviewed condition: no bucket, key or review hash means no S3 or KMS statement at all.
    expect((policies[2] as Record<string,Json>)['Fn::If']).toEqual(['ExportDelivery',expect.any(Object),{Ref:'AWS::NoValue'}]);
    expect(JSON.stringify(policies[1])).not.toMatch(/s3:/);
    expect(JSON.stringify(policies[2])).not.toMatch(/s3:ListBucket|s3:DeleteObject"|s3:\*|kms:\*/);
    expect(condition(candidate.Conditions.ExportDelivery,approved)).toBe(false);
    const delivery={...approved,ExportBucketName:'fictional-export-bucket',ExportKmsKeyArn:'arn:aws:kms:us-east-2:123456789012:key/11111111-1111-4111-8111-111111111111',ExportReviewSha256:'c'.repeat(64)};
    expect(condition(candidate.Conditions.ExportDelivery,delivery)).toBe(true);
    for(const key of ['ExportBucketName','ExportKmsKeyArn','ExportReviewSha256','PhiAllowed','Activation'])expect(condition(candidate.Conditions.ExportDelivery,{...delivery,[key]:defaults[key]}),key).toBe(false);
    expect(JSON.stringify(candidate.Rules.ExportDeliveryRequiresReview)).toContain('ExportReviewSha256');
    for(const key of ['Activation','ActivationEvidenceSha256','DatabaseReviewSha256','AllowedScopes','AlarmTopicArn'])expect(JSON.stringify(candidate.Rules)).toContain(key);
  });
  it('allows exactly the personal API routes under a dedicated matching consumer authorizer',()=>{
    const routes=Object.values(candidate.Resources).filter(r=>r.Type==='AWS::ApiGatewayV2::Route');
    expect(routes.map(r=>r.Properties.RouteKey).sort()).toEqual([...OWNED_CONSUMER_ROUTES].sort());
    for(const route of routes){expect(route.Properties.AuthorizationType).toBe('JWT');expect(route.Properties.AuthorizerId).toEqual({Ref:'ConsumerAuthorizer'});}
    expect(candidate.Resources.ConsumerAuthorizer.Properties.JwtConfiguration).toEqual({Issuer:{Ref:'ConsumerIssuer'},Audience:[{Ref:'ConsumerAudience'}]});
    expect(candidate.Resources.Invoke.Properties.SourceAccount).toEqual({Ref:'AWS::AccountId'});
    const scopePattern=new RegExp(candidate.Parameters.AllowedScopes.AllowedPattern!);
    for(const scope of OWNED_STORAGE_SCOPES)expect(scopePattern.test(scope)).toBe(true);
    expect(scopePattern.test(OWNED_STORAGE_SCOPES.join(','))).toBe(true);
    for(const invalid of ['all','lab_history,admin',' lab_history','lab_history,'])expect(scopePattern.test(invalid)).toBe(false);
  });
  it('uses resource- and account-bound data IAM, restricted secret decryption, pinned code and encrypted logs',()=>{
    const policies=candidate.Resources.Role.Properties.Policies as Json[];
    const active=((policies[1] as Record<string,Json>)['Fn::If'] as Json[])[1] as {PolicyDocument:{Statement:Array<{Action:string|string[];Resource:Json;Condition:Json}>}};
    expect(active.PolicyDocument.Statement.map(s=>s.Resource)).toEqual([{Ref:'DatabaseClusterArn'},{Ref:'DatabaseSecretArn'},{Ref:'SecretKmsKeyArn'}]);
    expect(active.PolicyDocument.Statement[0].Condition).toEqual({StringEquals:{'aws:ResourceAccount':{Ref:'AWS::AccountId'}}});
    expect(active.PolicyDocument.Statement[1].Condition).toEqual(active.PolicyDocument.Statement[0].Condition);
    expect(active.PolicyDocument.Statement[2]).toMatchObject({Action:'kms:Decrypt',Condition:{StringEquals:{'kms:EncryptionContext:SecretARN':{Ref:'DatabaseSecretArn'},'kms:ViaService':{'Fn::Sub':'secretsmanager.${AWS::Region}.amazonaws.com'}}}});
    expect(JSON.stringify(active)).not.toMatch(/s3:|cognito-idp:|rds-data:BatchExecuteStatement|"Resource":"\*"/);
    expect(candidate.Resources.Function.Properties.Code).toMatchObject({S3ObjectVersion:{Ref:'CodeVersion'}});
    const versionPattern=new RegExp(candidate.Parameters.CodeVersion.AllowedPattern!);expect(versionPattern.test('null')).toBe(false);expect(versionPattern.test('version-123')).toBe(true);
    expect(candidate.Resources.Logs.Properties.KmsKeyId).toEqual({Ref:'LogsKmsKeyArn'});
    expect(candidate.Resources.Logs.DeletionPolicy).toBe('Retain');expect(candidate.Resources.Logs.UpdateReplacePolicy).toBe('Retain');
    expect(candidate.Resources.Function.Properties.Environment).toMatchObject({Variables:{KNOWLEDGE_RELEASE_MODE:'disabled',CLINICAL_DATABASE_NAME:{Ref:'DatabaseName'},PHI_ALLOWED:{Ref:'PhiAllowed'}}});
    expect(candidate.Resources.ApiFailureAlarm.Properties).toMatchObject({Namespace:'AWS/ApiGateway',MetricName:'5xx'});
    for(const alarm of ['ApiFailureAlarm','ErrorsAlarm','ThrottlesAlarm'])expect(candidate.Resources[alarm].Properties.AlarmActions).toEqual({'Fn::If':['HasAlarmRecipient',[{Ref:'AlarmTopicArn'}],{Ref:'AWS::NoValue'}]});
  });
  it('bundled default-blocked handler refuses without any database configuration or AWS credentials',()=>{
    const child=spawnSync(process.execPath,['-e',`const {handler}=require('./dist/aws-clinical-core/personal-storage/index.js');handler({routeKey:'GET /clinical-core/consumer/personal/records'}).then(r=>console.log(JSON.stringify(r)))`],{
      encoding:'utf8',timeout:10000,env:{...process.env,CONSUMER_ISSUER:'https://cognito-idp.us-east-2.amazonaws.com/consumer',CONSUMER_AUDIENCE:'12345678901234567890',PHI_ALLOWED:'false',PERSONAL_STORAGE_ACTIVATION:'blocked',PERSONAL_STORAGE_ALLOWED_SCOPES:'',CLINICAL_DATABASE_CLUSTER_ARN:'',CLINICAL_DATABASE_SECRET_ARN:'',CLINICAL_DATABASE_NAME:'',AWS_EC2_METADATA_DISABLED:'true',AWS_ACCESS_KEY_ID:'',AWS_SECRET_ACCESS_KEY:'',AWS_SESSION_TOKEN:''},
    });
    expect(child.status,child.stderr).toBe(0);
    const response=JSON.parse(child.stdout.trim());expect(response.statusCode).toBe(503);expect(JSON.parse(response.body)).toEqual({error:'production_not_activated',phiAllowed:false});
  },15000);
});
