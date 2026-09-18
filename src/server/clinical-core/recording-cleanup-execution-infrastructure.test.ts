import {beforeAll,describe,expect,it} from 'vitest';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {createHash} from 'node:crypto';
type Json=null|boolean|number|string|Json[]|{[k:string]:Json};
let template:{Parameters:Record<string,{Default?:string}>;Conditions:Record<string,Json>;Rules:Record<string,Json>;
  Resources:Record<string,{Type:string;Properties:Record<string,Json>;DeletionPolicy?:string}>};
const out=mkdtempSync(join(tmpdir(),'alp-cleanup-execution-test-'))+sep;
beforeAll(()=>{
  execFileSync(process.execPath,['scripts/build-aws-recording-authority.mjs','--cleanup-execution','--out-dir='+out],{stdio:'pipe',timeout:10000});
  template=JSON.parse(readFileSync(out+'template.json','utf8'));
},15000);
function evaluate(v:Json,p:Record<string,string>):unknown{
  if(v===null||typeof v!=='object')return v;
  if(Array.isArray(v))return v.map(x=>evaluate(x,p));
  if(typeof v.Ref==='string')return p[v.Ref]??'';
  if(v['Fn::Equals']){const r=evaluate(v['Fn::Equals'],p) as unknown[];return r[0]===r[1];}
  if(v['Fn::Not'])return !(evaluate(v['Fn::Not'],p) as unknown[])[0];
  if(v['Fn::And'])return (evaluate(v['Fn::And'],p) as unknown[]).every(Boolean);
  throw new Error('unexpected_condition');
}
const baseEnv:NodeJS.ProcessEnv={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,NODE_ENV:'production',
  WORKFORCE_ISSUER:'https://cognito-idp.us-east-2.amazonaws.com/FictionalWorkforce',WORKFORCE_AUDIENCE:'12345678901234567890',
  RECORDING_ORGANIZATION_ID:'11111111-1111-4111-8111-111111111111',AWS_EC2_METADATA_DISABLED:'true'};
describe('separately disabled cleanup execution candidate',()=>{
  it('binds actual runtime and template bytes in the artifact manifest',()=>{
    const manifest=JSON.parse(readFileSync(out+'artifact-manifest.json','utf8')) as {contract:string;files:{path:string;sha256:string;bytes:number}[]};
    expect(manifest.contract).toBe('recording-cleanup-execution-artifact/1');
    expect(manifest.files.map(f=>f.path)).toEqual(['index.js','recording-cleanup-execution-runtime.js','template.json']);
    for(const file of manifest.files){const bytes=readFileSync(out+file.path);expect(file.bytes).toBe(bytes.length);expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));}
  });
  it('withholds all data/storage rights unless every independent review is present',()=>{
    const defaults=Object.fromEntries(Object.entries(template.Parameters).map(([k,v])=>[k,v.Default??'']));
    const reviews=['ActivationEvidenceSha256','DatabaseReviewSha256','WorkforceMfaReviewSha256','CleanupExecutionReviewSha256',
      'CleanupWorkerSha256','StorageReviewSha256','HoldCoordinationReviewSha256'];
    const approved={...defaults,...Object.fromEntries(reviews.map(k=>[k,'a'.repeat(64)])),PhiAllowed:'true',Activation:'approved',AlarmTopicArn:'arn:aws:sns:us-east-2:123456789012:fictional'};
    expect(evaluate(template.Conditions.Active,defaults)).toBe(false);expect(evaluate(template.Conditions.Active,approved)).toBe(true);
    for(const key of [...reviews,'PhiAllowed','Activation','AlarmTopicArn'])expect(evaluate(template.Conditions.Active,{...approved,[key]:defaults[key]})).toBe(false);
    for(const key of reviews)expect(JSON.stringify(template.Rules)).toContain(key);
    const policies=template.Resources.Role.Properties.Policies as Json[];
    expect(JSON.stringify(policies[0])).not.toMatch(/rds-data:|s3:|kms:|secretsmanager:/);
    expect((policies[1] as Record<string,Json>)['Fn::If']).toEqual(['Active',expect.any(Object),{Ref:'AWS::NoValue'}]);
  });
  it('permits only exact-version deletion within the configured organization prefix and cannot alter holds or schedule jobs',()=>{
    const policies=JSON.stringify(template.Resources.Role.Properties.Policies);
    expect(policies).toContain('s3:DeleteObjectVersion');expect(policies).not.toMatch(/"s3:DeleteObject"|s3:Put|s3:Bypass|lambda:Invoke|scheduler:|states:|"Resource":"\*"/);
    expect(policies).toContain('encounter-recordings/${OrganizationId}/*');expect(policies).toContain('s3:ResourceAccount');
    expect(policies).toContain('s3:prefix');expect(policies).toContain('s3:GetObjectLegalHold');expect(policies).toContain('s3:GetObjectRetention');
    expect(policies).toContain('kms:GenerateDataKey');expect(policies).toContain('kms:EncryptionContext:aws:s3:arn');
  });
  it('exposes only the workforce JWT execution route, with pinned code and retained encrypted logs',()=>{
    const r=template.Resources;expect(Object.values(r).filter(v=>v.Type==='AWS::ApiGatewayV2::Route')).toHaveLength(1);
    expect(r.Route.Properties).toMatchObject({RouteKey:'POST /clinical-core/workforce/encounter-recording/cleanup-execution',AuthorizationType:'JWT',AuthorizerId:{Ref:'Authorizer'}});
    expect(JSON.stringify(r.Invoke.Properties.SourceArn)).toContain('/POST/clinical-core/workforce/encounter-recording/cleanup-execution');
    expect(r.Invoke.Properties.SourceAccount).toEqual({Ref:'AWS::AccountId'});
    expect(r.Function.Properties.Code).toMatchObject({S3ObjectVersion:{Ref:'CodeVersion'}});
    expect(r.Function.Properties.Timeout).toBe(29);expect(r.Function.Properties.ReservedConcurrentExecutions).toBe(2);
    expect(r.Logs.Properties.KmsKeyId).toEqual({Ref:'LogsKmsKeyArn'});expect(r.Logs.DeletionPolicy).toBe('Retain');
    expect(Object.values(r).some(v=>v.Type==='AWS::Lambda::Url'||v.Type==='AWS::Scheduler::Schedule')).toBe(false);
    expect(JSON.stringify(r.Function.Properties.Environment)).not.toContain('RECORDING_CAPTURE_ACTIVATION');
  });
  it('executes the actual blocked artifact without loading storage/SDK runtime',async()=>{
    const run=await promisify(execFile)(process.execPath,['-e',`require(${JSON.stringify(out+'index.js')}).handler({}).then(response=>console.log(JSON.stringify({response,loaded:Object.keys(require.cache).some(p=>p.endsWith('recording-cleanup-execution-runtime.js'))})))`],{
      encoding:'utf8',timeout:4000,env:{...baseEnv,PHI_ALLOWED:'false',RECORDING_CLEANUP_EXECUTION_ACTIVATION:'blocked'}});
    const result=JSON.parse(run.stdout);expect(result.loaded).toBe(false);expect(result.response.statusCode).toBe(503);
    expect(JSON.parse(result.response.body)).toEqual({error:'production_not_activated',phiAllowed:false});expect(run.stderr).toBe('');
  });
  it('rejects a claimed worker digest that differs from the deployed bytes before importing runtime',async()=>{
    const run=await promisify(execFile)(process.execPath,['-e',`require(${JSON.stringify(out+'index.js')}).handler({}).catch(e=>console.log(JSON.stringify({error:e.message,loaded:Object.keys(require.cache).some(p=>p.endsWith('recording-cleanup-execution-runtime.js'))})))`],{
      encoding:'utf8',timeout:4000,env:{...baseEnv,PHI_ALLOWED:'true',RECORDING_CLEANUP_WORKER_SHA256:'0'.repeat(64)}});
    expect(JSON.parse(run.stdout)).toEqual({error:'recording_cleanup_worker_digest_mismatch',loaded:false});expect(run.stderr).toBe('');
  });
});
