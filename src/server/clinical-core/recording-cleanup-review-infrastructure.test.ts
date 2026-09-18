import {beforeAll,describe,expect,it} from 'vitest';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
type Json=null|boolean|number|string|Json[]|{[k:string]:Json};
let template:{Parameters:Record<string,{Default?:string}>;Conditions:Record<string,Json>;Rules:Record<string,Json>;
  Resources:Record<string,{Type:string;Properties:Record<string,Json>;DeletionPolicy?:string}>};
const out='dist/aws-clinical-core/recording-cleanup-review/';
beforeAll(()=>{
  execFileSync(process.execPath,['scripts/build-aws-recording-authority.mjs','--cleanup-review'],{stdio:'pipe',timeout:10000});
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
describe('cleanup review deployment candidate',()=>{
  it('binds both runtime files and template to a digest manifest',()=>{
    const m=JSON.parse(readFileSync(out+'artifact-manifest.json','utf8')) as {contract:string;files:{path:string;sha256:string;bytes:number}[]};
    expect(m.contract).toBe('recording-cleanup-review-artifact/1');expect(m.files.map(f=>f.path)).toEqual(['index.js','recording-cleanup-review-runtime.js','template.json']);
    for(const f of m.files){const bytes=readFileSync(out+f.path);expect(bytes.length).toBe(f.bytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.sha256);}
  });
  it('keeps all non-log permissions behind independent review and never grants storage or dispatch rights',()=>{
    const defaults=Object.fromEntries(Object.entries(template.Parameters).map(([k,v])=>[k,v.Default??'']));
    const reviews=['ActivationEvidenceSha256','DatabaseReviewSha256','WorkforceMfaReviewSha256','CleanupReviewSha256'];
    const approved={...defaults,...Object.fromEntries(reviews.map(k=>[k,'a'.repeat(64)])),PhiAllowed:'true',Activation:'approved',AlarmTopicArn:'arn:aws:sns:us-east-2:123456789012:fictional'};
    expect(evaluate(template.Conditions.Active,defaults)).toBe(false);expect(evaluate(template.Conditions.Active,approved)).toBe(true);
    for(const key of [...reviews,'PhiAllowed','Activation','AlarmTopicArn'])expect(evaluate(template.Conditions.Active,{...approved,[key]:defaults[key]})).toBe(false);
    const policies=template.Resources.Role.Properties.Policies as Json[];
    expect(JSON.stringify(policies[0])).not.toMatch(/rds-data:|s3:|kms:|secretsmanager:/);
    expect((policies[1] as Record<string,Json>)['Fn::If']).toEqual(['Active',expect.any(Object),{Ref:'AWS::NoValue'}]);
    expect(JSON.stringify(policies)).not.toMatch(/s3:|lambda:Invoke|scheduler:|states:|"Resource":"\*"/);
    for(const review of reviews)expect(JSON.stringify(template.Rules)).toContain(review);
  });
  it('exposes only the reviewed JWT route with pinned deployment and retained encrypted logs',()=>{
    const r=template.Resources;expect(Object.values(r).filter(v=>v.Type==='AWS::ApiGatewayV2::Route')).toHaveLength(1);
    expect(r.Route.Properties).toMatchObject({RouteKey:'POST /clinical-core/workforce/encounter-recording/cleanup-review',AuthorizationType:'JWT',AuthorizerId:{Ref:'Authorizer'}});
    expect(JSON.stringify(r.Invoke.Properties.SourceArn)).toContain('/POST/clinical-core/workforce/encounter-recording/cleanup-review');
    expect(r.Invoke.Properties.SourceAccount).toEqual({Ref:'AWS::AccountId'});
    expect(r.Authorizer.Properties.JwtConfiguration).toEqual({Issuer:{Ref:'WorkforceIssuer'},Audience:[{Ref:'WorkforceAudience'}]});
    expect(r.Function.Properties.Code).toMatchObject({S3ObjectVersion:{Ref:'CodeVersion'}});
    expect(r.Logs.Properties.KmsKeyId).toEqual({Ref:'LogsKmsKeyArn'});expect(r.Logs.DeletionPolicy).toBe('Retain');
    expect(Object.values(r).some(v=>v.Type==='AWS::Lambda::Url')).toBe(false);
    expect(JSON.stringify(r.Function.Properties.Environment)).not.toContain('RECORDING_AUTHORITY_ACTIVATION');
  });
  it('runs the actual blocked artifact without loading SDK services or credentials',async()=>{
    const result=await promisify(execFile)(process.execPath,['-e',`require('./${out}index.js').handler({}).then(response=>console.log(JSON.stringify({response,loaded:Object.keys(require.cache).some(p=>p.endsWith('recording-cleanup-review-runtime.js'))})))`],{
      timeout:4000,encoding:'utf8',env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,NODE_ENV:'production',
        WORKFORCE_ISSUER:'https://cognito-idp.us-east-2.amazonaws.com/FictionalWorkforce',WORKFORCE_AUDIENCE:'12345678901234567890',
        RECORDING_ORGANIZATION_ID:'11111111-1111-4111-8111-111111111111',PHI_ALLOWED:'false',RECORDING_CLEANUP_REVIEW_ACTIVATION:'blocked',AWS_EC2_METADATA_DISABLED:'true'}});
    const {response,loaded}=JSON.parse(result.stdout);expect(response.statusCode).toBe(503);expect(loaded).toBe(false);expect(result.stderr).toBe('');
    expect(JSON.parse(response.body)).toEqual({error:'production_not_activated',phiAllowed:false});
  });
});
