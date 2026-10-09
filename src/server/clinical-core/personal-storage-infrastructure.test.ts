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
  if(value['Fn::Or'])return (condition(value['Fn::Or'],parameters) as unknown[]).some(Boolean);
  if(typeof value.Condition==='string')return condition(candidate.Conditions[value.Condition],parameters);
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
    expect(policies).toHaveLength(5);
    expect(JSON.stringify(policies[0])).not.toMatch(/rds-data:|secretsmanager:|kms:|s3:/);
    // Database access rides Enabled: the production activation or the qualification execution, both false by default.
    expect((policies[1] as Record<string,Json>)['Fn::If']).toEqual(['Enabled',expect.any(Object),{Ref:'AWS::NoValue'}]);
    expect(condition(candidate.Conditions.Enabled,defaults)).toBe(false);
    // Export delivery is a second, separately reviewed condition: no bucket, key or review hash means no S3 or KMS statement at all.
    expect((policies[2] as Record<string,Json>)['Fn::If']).toEqual(['ExportDelivery',expect.any(Object),{Ref:'AWS::NoValue'}]);
    expect(JSON.stringify(policies[1])).not.toMatch(/s3:/);
    // Listing exists only for the export prefix (cleanup proof); never the whole bucket, all buckets or unversioned deletes.
    expect(JSON.stringify(policies[2])).not.toMatch(/s3:ListBucket"|s3:ListAllMyBuckets|s3:DeleteObject"|s3:\*|kms:\*/);
    const exportStatements=(((policies[2] as Record<string,Json>)['Fn::If'] as Json[])[1] as {PolicyDocument:{Statement:Array<{Action:string|string[];Resource:Json;Condition:Json}>}}).PolicyDocument.Statement;
    // s3:prefix is a supported condition for ListBucketVersions but not for ListBucketMultipartUploads: the two are separate statements.
    const versions=exportStatements.find(s=>s.Action==='s3:ListBucketVersions')!,uploads=exportStatements.find(s=>s.Action==='s3:ListBucketMultipartUploads')!;
    expect(JSON.stringify(versions.Resource)).not.toContain('personal-exports');expect(versions.Condition).toMatchObject({StringLike:{'s3:prefix':'personal-exports/*'}});
    expect(JSON.stringify(uploads.Resource)).not.toContain('personal-exports');expect(JSON.stringify(uploads.Condition)).not.toContain('s3:prefix');
    expect(exportStatements.filter(s=>JSON.stringify(s.Action).includes('ListBucketMultipartUploads'))).toHaveLength(1);
    expect(condition(candidate.Conditions.ExportDelivery,approved)).toBe(false);
    const delivery={...approved,ExportBucketName:'fictional-export-bucket',ExportKmsKeyArn:'arn:aws:kms:us-east-2:123456789012:key/11111111-1111-4111-8111-111111111111',ExportReviewSha256:'c'.repeat(64)};
    expect(condition(candidate.Conditions.ExportDelivery,delivery)).toBe(true);
    for(const key of ['ExportBucketName','ExportKmsKeyArn','ExportReviewSha256','PhiAllowed','Activation'])expect(condition(candidate.Conditions.ExportDelivery,{...delivery,[key]:defaults[key]}),key).toBe(false);
    expect(JSON.stringify(candidate.Rules.ExportDeliveryRequiresReview)).toContain('ExportReviewSha256');
    for(const key of ['Activation','ActivationEvidenceSha256','DatabaseReviewSha256','AllowedScopes','AlarmTopicArn'])expect(JSON.stringify(candidate.Rules)).toContain(key);
  });
  it('enables qualification execution only with PHI disabled, activation blocked, the deploying synthetic account, a qualification database and every reviewed input, and never together with production activation',()=>{
    const defaults=Object.fromEntries(Object.entries(candidate.Parameters).map(([k,v])=>[k,v.Default??'']));
    expect(candidate.Parameters.QualificationExecution.Default).toBe('disabled');
    const qualified={...defaults,'AWS::AccountId':'588966314750',QualificationExecution:'enabled',QualificationReviewSha256:'e'.repeat(64),QualificationAccountId:'588966314750',
      QualificationIdentitySubjects:'consumer-sub-00000001,workforce-sub-00000001',DatabaseName:'clinical_core_qualification',DatabaseReviewSha256:'b'.repeat(64),AllowedScopes:'lab_history',AlarmTopicArn:'arn:aws:sns:us-east-2:588966314750:alarms'};
    expect(condition(candidate.Conditions.Qualification,qualified)).toBe(true);
    expect(condition(candidate.Conditions.Enabled,qualified)).toBe(true);
    expect(condition(candidate.Conditions.Active,qualified)).toBe(false);
    for(const key of ['QualificationExecution','QualificationReviewSha256','QualificationAccountId','QualificationIdentitySubjects','DatabaseReviewSha256','AllowedScopes','AlarmTopicArn'])
      expect(condition(candidate.Conditions.Qualification,{...qualified,[key]:defaults[key]}),key).toBe(false);
    // The staging database, another deploying account, the production account, PHI allowed or an approved activation all disable it.
    expect(condition(candidate.Conditions.Qualification,{...qualified,DatabaseName:'clinical_core'})).toBe(false);
    expect(condition(candidate.Conditions.Qualification,{...qualified,'AWS::AccountId':'123456789012'})).toBe(false);
    expect(condition(candidate.Conditions.Qualification,{...qualified,'AWS::AccountId':'173535830222',QualificationAccountId:'173535830222',AlarmTopicArn:'arn:aws:sns:us-east-2:173535830222:alarms'})).toBe(false);
    expect(condition(candidate.Conditions.Qualification,{...qualified,PhiAllowed:'true'})).toBe(false);
    expect(condition(candidate.Conditions.Qualification,{...qualified,Activation:'approved'})).toBe(false);
    // Export delivery under qualification needs the same reviewed export inputs as production.
    expect(condition(candidate.Conditions.ExportDelivery,qualified)).toBe(false);
    expect(condition(candidate.Conditions.ExportDelivery,{...qualified,ExportBucketName:'fictional-export-bucket',ExportKmsKeyArn:'arn:aws:kms:us-east-2:588966314750:key/11111111-1111-4111-8111-111111111111',ExportReviewSha256:'c'.repeat(64)})).toBe(true);
    const env=candidate.Resources.Function.Properties.Environment as {Variables:Record<string,Json>};
    expect(env.Variables.QUALIFICATION_EXECUTION).toEqual({'Fn::If':['Qualification','enabled','disabled']});
    expect(env.Variables.QUALIFICATION_IDENTITY_SUBJECTS).toEqual({'Fn::If':['Qualification',{Ref:'QualificationIdentitySubjects'},'']});
    expect(JSON.stringify(candidate.Rules.QualificationRequiresSyntheticPosture)).toContain('173535830222');
    for(const key of ['PhiAllowed','Activation','QualificationReviewSha256','QualificationAccountId','QualificationIdentitySubjects','DatabaseName'])expect(JSON.stringify(candidate.Rules.QualificationRequiresSyntheticPosture)).toContain(key);
  });
  it('grants cross-store export reads only with a complete, reviewed store configuration on top of export delivery, read-only and bound to the named stores',()=>{
    const policies=candidate.Resources.Role.Properties.Policies as Json[];
    const lab=(policies[3] as Record<string,Json>)['Fn::If'] as Json[],voice=(policies[4] as Record<string,Json>)['Fn::If'] as Json[];
    expect(lab[0]).toBe('CrossStoreLabExport');expect(voice[0]).toBe('CrossStoreVoiceExport');
    const statements=(block:Json[])=>(block[1] as {PolicyDocument:{Statement:Array<{Action:string|string[];Resource:Json}>}}).PolicyDocument.Statement;
    expect(statements(lab).flatMap(s=>s.Action)).toEqual(['dynamodb:GetItem','dynamodb:Query','s3:GetObject','kms:Decrypt']);
    expect(statements(voice).flatMap(s=>s.Action)).toEqual(['dynamodb:GetItem','dynamodb:Scan','s3:GetObject','kms:Decrypt']);
    expect(JSON.stringify([lab,voice])).not.toMatch(/PutItem|UpdateItem|DeleteItem|s3:PutObject|s3:DeleteObject|s3:ListBucket|"Resource":"\*"/);
    expect(JSON.stringify(statements(voice)[1].Resource)).toContain('personal-voice/output/*');
    const defaults=Object.fromEntries(Object.entries(candidate.Parameters).map(([k,v])=>[k,v.Default??'']));
    const approved={...defaults,PhiAllowed:'true',Activation:'approved',ActivationEvidenceSha256:'a'.repeat(64),DatabaseReviewSha256:'b'.repeat(64),AllowedScopes:'lab_history',AlarmTopicArn:'arn:aws:sns:us-east-2:123456789012:alarms',
      ExportBucketName:'fictional-export-bucket',ExportKmsKeyArn:'arn:aws:kms:us-east-2:123456789012:key/11111111-1111-4111-8111-111111111111',ExportReviewSha256:'c'.repeat(64)};
    expect(condition(candidate.Conditions.CrossStoreLabExport,approved)).toBe(false);
    const labFull={...approved,ExportLabJobTableArn:'arn:aws:dynamodb:us-east-2:123456789012:table/fictional-lab-jobs',ExportLabDocumentBucketName:'fictional-lab-documents',
      ExportLabKmsKeyArn:'arn:aws:kms:us-east-2:123456789012:key/22222222-2222-4222-8222-222222222222',CrossStoreExportReviewSha256:'d'.repeat(64)};
    expect(condition(candidate.Conditions.CrossStoreLabExport,labFull)).toBe(true);
    expect(condition(candidate.Conditions.CrossStoreVoiceExport,labFull)).toBe(false);
    for(const key of ['ExportLabJobTableArn','ExportLabDocumentBucketName','ExportLabKmsKeyArn','CrossStoreExportReviewSha256','ExportBucketName','PhiAllowed'])
      expect(condition(candidate.Conditions.CrossStoreLabExport,{...labFull,[key]:defaults[key]}),key).toBe(false);
    const env=candidate.Resources.Function.Properties.Environment as {Variables:Record<string,Json>};
    expect(env.Variables.EXPORT_LAB_JOB_TABLE).toEqual({'Fn::If':['CrossStoreLabExport',{'Fn::Select':[1,{'Fn::Split':['/',{Ref:'ExportLabJobTableArn'}]}]},'']});
    expect(env.Variables.EXPORT_TRANSCRIPTION_BUCKET).toEqual({'Fn::If':['CrossStoreVoiceExport',{Ref:'ExportTranscriptionBucketName'},'']});
    expect(JSON.stringify(candidate.Rules.CrossStoreLabExportRequiresReview)).toContain('CrossStoreExportReviewSha256');
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
