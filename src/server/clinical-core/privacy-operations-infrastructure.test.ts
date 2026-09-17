import {beforeAll,describe,expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
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
    expect(Object.values(t.Resources).filter(r=>r.Type==='AWS::ApiGatewayV2::Route')).toHaveLength(1);
    expect(t.Resources.Route.Properties).toMatchObject({RouteKey:'POST /clinical-core/workforce/privacy-operations',AuthorizationType:'JWT',AuthorizerId:{Ref:'Authorizer'}});
    expect(t.Resources.Authorizer.Properties.JwtConfiguration).toEqual({Issuer:{Ref:'WorkforceIssuer'},Audience:[{Ref:'WorkforceAudience'}]});
    expect(t.Resources.Function.Properties.Code).toMatchObject({S3ObjectVersion:{Ref:'CodeVersion'}});
    expect(t.Resources.Logs.Properties.KmsKeyId).toEqual({Ref:'LogsKmsKeyArn'});expect(t.Resources.Logs.DeletionPolicy).toBe('Retain');
    expect(t.Resources.ApiFailureAlarm.Properties.MetricName).toBe('5xx');
  });
  it('bundled disabled runtime makes no AWS connection without credentials',()=>{
    const child=spawnSync(process.execPath,['-e',"require('./dist/aws-clinical-core/privacy-operations/index.js').handler({routeKey:'POST /clinical-core/workforce/privacy-operations'}).then(r=>console.log(JSON.stringify(r)))"],{
      encoding:'utf8',timeout:10000,env:{...process.env,WORKFORCE_ISSUER:'https://cognito-idp.us-east-2.amazonaws.com/workforce',
        WORKFORCE_AUDIENCE:'12345678901234567890',PHI_ALLOWED:'false',PRIVACY_OPERATIONS_ACTIVATION:'blocked',
        CLINICAL_DATABASE_CLUSTER_ARN:'',CLINICAL_DATABASE_SECRET_ARN:'',CLINICAL_DATABASE_NAME:'',AWS_EC2_METADATA_DISABLED:'true',
        AWS_ACCESS_KEY_ID:'',AWS_SECRET_ACCESS_KEY:'',AWS_SESSION_TOKEN:''}});
    expect(child.status,child.stderr).toBe(0);expect(JSON.parse(child.stdout).statusCode).toBe(503);
  });
});
