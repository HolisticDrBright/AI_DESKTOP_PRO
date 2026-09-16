import {beforeAll,describe,it,expect} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
let template=JSON.parse('{}');
beforeAll(()=>{
  execFileSync(process.execPath,['scripts/build-aws-owned-lab.mjs'],{stdio:'pipe'});
  template=JSON.parse(readFileSync('dist/aws-clinical-core/owned-lab/template.json','utf8'));
});
type Policy={PolicyName?:string;PolicyDocument?:{Statement:{Action:string|string[];Resource:unknown}[]};'Fn::If'?:[string,Policy,unknown]};
describe('production lab release candidate',()=>{
  it('is blocked, personal-namespaced and logs-only by default with explicit activation evidence',()=>{
    expect(template.Parameters.PhiAllowed.Default).toBe('false');expect(template.Parameters.Activation.Default).toBe('blocked');
    expect(template.Parameters.Activation.AllowedValues).toEqual(['blocked','approved']);
    expect(template.Parameters.AllowedScopes.AllowedValues).toEqual(['','ai_context,lab_history']);
    for(const role of ['LabApiRole','LabWorkerRole','LabCleanupRole']){
      const policies=template.Resources[role].Properties.Policies as Policy[];
      expect(policies[0].PolicyName).toBe('LogsOnly');
      expect(policies[0].PolicyDocument!.Statement.flatMap(s=>s.Action)).toEqual(['logs:CreateLogStream','logs:PutLogEvents']);
      expect(policies.slice(1).every(p=>p['Fn::If']?.[0]==='Active')).toBe(true);
    }
    expect(JSON.stringify(template.Rules.ActivationRequiresReviewedConfiguration)).toContain('reviewed_release');
    for(const name of ['ProviderEvidenceSha256','AlarmTopicArn','BillingApiOrigin','DatabaseClusterArn'])expect(JSON.stringify(template.Rules)).toContain(name);
    expect(JSON.stringify(template.Resources)).not.toMatch(/synthetic-labs|synthetic-lab-|synthetic_only|synthetic-staging|SyntheticSupabase/);
    for(const name of ['LabCleanupSweepRule','LabCleanupObjectRule'])expect(template.Resources[name].Properties.State['Fn::If']).toEqual(['Active','ENABLED','DISABLED']);
    for(const name of ['LabCancellationPolicy','LabInventoryQueryPolicy'])expect(template.Resources[name].Condition).toBe('Active');
  });
  it('keeps only consumer JWT routes and binds identity to explicit production pool parameters',()=>{
    const routes=Object.values(template.Resources as Record<string,{Type:string;Properties:{RouteKey:string;AuthorizationType:string}}>).filter(r=>r.Type==='AWS::ApiGatewayV2::Route');
    expect(routes).toHaveLength(15);
    expect(routes.every(r=>r.Properties.AuthorizationType==='JWT'&&r.Properties.RouteKey.includes('/clinical-core/consumer/labs'))).toBe(true);
    expect(template.Resources.LabConsumerAuthorizer.Properties.JwtConfiguration).toEqual({Issuer:{Ref:'ConsumerIssuer'},Audience:[{Ref:'ConsumerAudience'}]});
    expect(Object.keys(template.Resources).some(name=>name.includes('Synthetic'))).toBe(false);
  });
  it('scopes object, workflow and consent-database permissions to named resources and the personal namespace',()=>{
    for(const role of ['LabApiRole','LabWorkerRole','LabCleanupRole']){
      const active=(template.Resources[role].Properties.Policies as Policy[]).slice(1).map(p=>p['Fn::If']![1]).flatMap(p=>p['Fn::If']?[]:p.PolicyDocument!.Statement);
      expect(active.every(s=>s.Resource!=='*'||(Array.isArray(s.Action)&&s.Action.every(a=>String(a).startsWith('textract:'))))).toBe(true);
      const text=JSON.stringify(active);
      if(role!=='LabCleanupRole'){expect(text).toContain('rds-data:ExecuteStatement');expect(text).toContain('secretsmanager:GetSecretValue');}
      expect(text).toContain('personal-labs/');expect(text).not.toContain('synthetic');
    }
    for(const fn of ['LabApiFunction','LabWorkerFunction']){
      const env=template.Resources[fn].Properties.Environment.Variables;
      expect(env.LAB_OBJECT_PREFIX).toBe('personal-labs');expect(env.PHI_ALLOWED).toEqual({Ref:'PhiAllowed'});expect(env.PERSONAL_LAB_ACTIVATION).toEqual({Ref:'Activation'});
      expect(env.CLINICAL_DATABASE_CLUSTER_ARN).toEqual({Ref:'DatabaseClusterArn'});expect(env.BILLING_AWS_API_ORIGIN).toEqual({Ref:'BillingApiOrigin'});
    }
    expect(template.Resources.LabCleanupFunction.Properties.Environment.Variables).toMatchObject({DATA_CLASSIFICATION:'personal_health_record',LAB_OBJECT_PREFIX:'personal-labs',PHI_ALLOWED:{Ref:'PhiAllowed'}});
    expect(template.Resources.LabJobTable.DeletionPolicy).toBe('Retain');expect(template.Resources.LabDocumentsBucket.DeletionPolicy).toBe('Retain');
    expect(template.Resources.LabDocumentsBucket.Properties.CorsConfiguration).toBeUndefined();
    expect(template.Resources.LabApiFailureAlarm.Properties.AlarmActions['Fn::If'][0]).toBe('HasAlarmRecipient');
  });
  it('bundled API refuses every request while blocked and the worker refuses to process',()=>{
    const env={...process.env,CONSUMER_ISSUER:'https://cognito-idp.us-east-2.amazonaws.com/consumer',CONSUMER_AUDIENCE:'12345678901234567890',PHI_ALLOWED:'false',
      PERSONAL_LAB_ACTIVATION:'blocked',PERSONAL_LAB_ALLOWED_SCOPES:'',LAB_OBJECT_PREFIX:'personal-labs',AWS_REGION:'us-east-2',
      LAB_JOB_TABLE:'fictional',LAB_DOCUMENT_BUCKET:'fictional',LAB_KMS_KEY_ARN:'fictional',LAB_STATE_MACHINE_ARN:'fictional'};
    const api=spawnSync(process.execPath,['-e',`const {handler}=require('./dist/aws-clinical-core/owned-lab/api/index.js');
      handler({rawPath:'/clinical-core/consumer/labs/inventory',requestContext:{http:{method:'GET'},authorizer:{jwt:{claims:{}}}}}).then(r=>console.log(JSON.stringify(r)))`],{env,encoding:'utf8'});
    expect(api.status).toBe(0);const response=JSON.parse(api.stdout.trim().split('\n').pop()!);
    expect(response.statusCode).toBe(503);expect(JSON.parse(response.body)).toEqual({data:{error:'production_not_activated',phiAllowed:false}});
    const worker=spawnSync(process.execPath,['-e',`const {handler}=require('./dist/aws-clinical-core/owned-lab/worker/index.js');
      handler({jobId:'22222222-2222-4222-8222-222222222222',pass:0}).then(()=>console.log('processed')).catch(e=>{console.log(e.message);})`],{env,encoding:'utf8'});
    expect(worker.stdout.trim()).toBe('production_not_activated');
    const wrongNamespace=spawnSync(process.execPath,['-e',`const {handler}=require('./dist/aws-clinical-core/owned-lab/api/index.js');
      handler({rawPath:'/clinical-core/consumer/labs/inventory'}).then(()=>console.log('served')).catch(e=>console.log(e.message))`],{env:{...env,LAB_OBJECT_PREFIX:'synthetic-labs'},encoding:'utf8'});
    expect(wrongNamespace.stdout.trim()).toBe('owned_lab_namespace_required');
  });
});
