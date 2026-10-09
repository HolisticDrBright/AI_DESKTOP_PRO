import {beforeEach,describe,it,expect,vi,afterEach} from 'vitest';
const mock=vi.hoisted(()=>({db:vi.fn(),sfn:vi.fn()}));
vi.mock('@aws-sdk/lib-dynamodb',async importOriginal=>({...await importOriginal<typeof import('@aws-sdk/lib-dynamodb')>(),DynamoDBDocumentClient:{from:()=>({send:mock.db})}}));
vi.mock('@aws-sdk/client-sfn',()=>({SFNClient:class{send=mock.sfn;},StartExecutionCommand:class{constructor(public input:unknown){}}}));
import {createAwsLabAnalysisApiHandler as handler,labContextFingerprint} from './aws-lab-analysis-api';
import {readFileSync} from 'node:fs';
const id='10000000-0000-4000-8000-000000000001',owner='20000000-0000-4000-8000-000000000001';
const rows=new Map<string,Record<string,unknown>>();
const event=(method:string,path:string,input?:unknown,claims:Record<string,string>={})=>({rawPath:'/clinical-core/consumer/labs/'+path,
  body:input===undefined?undefined:JSON.stringify(input),requestContext:{http:{method},authorizer:{jwt:{claims:{sub:owner,'custom:person_id':owner,'custom:organization_id':owner,'custom:synthetic_attested':'true',...claims}}}}});
const input=()=>({request:{id,createdAt:new Date().toISOString()},dataClassification:'synthetic_only',attestsSyntheticOnly:true,
  panelId:id,panelName:'Fictional panel',testDate:'2026-09-01',biomarkers:[{markerId:'fictional',canonicalName:'Fictional',value:1,unit:'widgets',labMin:null,labMax:null}]});
beforeEach(()=>{
  rows.clear();vi.clearAllMocks();vi.stubEnv('LAB_JOB_TABLE','fictional-table');vi.stubEnv('LAB_RANGE_MODE','synthetic_fixture');vi.stubEnv('LAB_STATE_MACHINE_ARN','fictional-machine');
  mock.db.mockImplementation(async c=>{
    if(c.constructor.name==='GetCommand')return {Item:rows.get(c.input.Key.pk)};
    if(c.constructor.name==='QueryCommand')return {Items:[...rows.values()].filter(r=>r.inventoryOwner===c.input.ExpressionAttributeValues[':owner'])
      .map(r=>({pk:r.pk,inventoryOwner:r.inventoryOwner,inventoryOrder:r.inventoryOrder}))};
    if(c.constructor.name==='TransactWriteCommand'){
      const puts=c.input.TransactItems.map((r:{Put:{Item:{pk:string}}})=>r.Put.Item);
      if(puts.some((r:{pk:string})=>rows.has(r.pk)))throw new Error('conditional collision');
      for(const row of puts)rows.set(row.pk,row);return {};
    }
    throw new Error('unexpected nontransactional write');
  });mock.sfn.mockResolvedValue({});
});
afterEach(()=>vi.unstubAllEnvs());
describe('request-aware API integration',()=>{
  it('binds saved-plan context fingerprints to verified request inputs and preserves them in recovery',async()=>{
    const patientContext={ageYears:40,sex:'male',pregnancyStatus:'not_applicable',nursing:false,
      mainComplaint:null,complaintDuration:null,complaintSeverity:0,conditions:[],medications:[],allergies:[],topSymptomSignals:[],
      lifestyle:{sleepHours:7,sleepQuality:6,stressLevel:3,dietType:'omnivore',exerciseFrequency:2}};
    const sourceContextSha256=labContextFingerprint(patientContext);
    const body={...input(),patientContext,sourceContextSha256};
    expect((await handler(event('POST','requests/saved',{...body,sourceContextSha256:'a'.repeat(64)}))).statusCode).toBe(400);
    expect(rows.size).toBe(0);expect(mock.sfn).not.toHaveBeenCalled();
    expect((await handler(event('POST','requests/saved',{...body,patientContext:undefined}))).statusCode).toBe(400);
    expect((await handler(event('POST','requests/saved',{...body,sourceContextSha256:'malformed'}))).statusCode).toBe(400);
    expect(rows.size).toBe(0);expect(mock.sfn).not.toHaveBeenCalled();
    const created=await handler(event('POST','requests/saved',body));expect(created.statusCode).toBe(200);
    const jobId=JSON.parse(created.body).data.jobId;
    expect(rows.get('job#'+jobId)?.patientContext).toEqual(patientContext);
    const detail=await handler(event('GET',`jobs/${jobId}/recovery`));
    expect(JSON.parse(detail.body).data.job.sourceContextSha256).toBe(sourceContextSha256);
    expect(JSON.stringify(JSON.parse(detail.body).data.job)).not.toContain('patientContext');
  });
  it('lists an actually created job and retrieves recovery metadata without clinical payload or execution side effects',async()=>{
    const body={...input(),sourcePanelSha256:'b'.repeat(64)};const created=await handler(event('POST','requests/saved',body));
    const jobId=JSON.parse(created.body).data.jobId;mock.sfn.mockClear();
    const listed=await handler(event('GET','inventory'));expect(listed.statusCode).toBe(200);
    const page=JSON.parse(listed.body).data;expect(page.contractVersion).toBe('lab-job-inventory/1');
    expect(page.jobs[0]).toMatchObject({jobId,panelId:id,canResume:true,request:{...body.request,kind:'saved'},sourcePanelSha256:'b'.repeat(64)});
    expect(JSON.stringify(page)).not.toContain('Fictional');
    const detail=await handler(event('GET',`jobs/${jobId}/recovery`));
    expect(JSON.parse(detail.body).data.job).toEqual(page.jobs[0]);expect(mock.sfn).not.toHaveBeenCalled();
    expect(JSON.parse((await handler(event('GET','inventory',undefined,{sub:id}))).body).data.jobs).toEqual([]);
    expect((await handler(event('GET',`jobs/${jobId}/recovery`,undefined,{sub:id}))).statusCode).toBe(404);
    rows.get('job#'+jobId)!.state='deleting';
    expect((await handler(event('GET',`jobs/${jobId}/recovery`))).statusCode).toBe(404);
  });
  it('requires synthetic identity on inventory and rejects unrecognized query parameters',async()=>{
    expect((await handler(event('GET','inventory',undefined,{'custom:synthetic_attested':'false'}))).statusCode).toBe(400);
    expect((await handler({...event('GET','inventory'),queryStringParameters:{ownerSub:id}})).statusCode).toBe(400);
    expect(mock.db).not.toHaveBeenCalled();
  });
  it('retires a never-created request with a versioned acknowledgement and refuses late creation',async()=>{
    const body=input();const retired=await handler(event('POST',`requests/${id}/retire`,{request:body.request}));
    expect(retired.statusCode).toBe(200);expect(JSON.parse(retired.body).data).toEqual({contractVersion:'lab-request-retirement/1',requestId:id,status:'retired'});
    expect((await handler(event('POST','requests/saved',body))).statusCode).toBe(410);
    expect(mock.sfn).not.toHaveBeenCalled();
  });
  it('refuses unsigned identities, mismatched IDs and extra retirement input',async()=>{
    const body={request:input().request};
    expect((await handler(event('POST',`requests/${id}/retire`,body,{'custom:synthetic_attested':'false'}))).statusCode).toBe(400);
    expect((await handler(event('POST',`requests/${owner}/retire`,body))).statusCode).toBe(400);
    expect((await handler(event('POST',`requests/${id}/retire`,{...body,deleteResults:true}))).statusCode).toBe(400);
    expect(mock.db).not.toHaveBeenCalled();
  });
  it('creates and discovers one saved plan and replays its actual terminal job without inventing queued state',async()=>{
    const body=input();const first=await handler(event('POST','requests/saved',body));expect(first.statusCode).toBe(200);
    const reference=JSON.parse(first.body).data;expect(reference).toEqual({contractVersion:'lab-request-recovery/1',requestId:id,jobId:expect.any(String)});
    const job=rows.get('job#'+reference.jobId)!;job.state='completed';
    const retry=await handler(event('POST','requests/saved',body));expect(JSON.parse(retry.body).data).toEqual(reference);
    expect(JSON.parse((await handler(event('GET','requests/'+id))).body).data).toEqual(reference);
    expect(rows.size).toBe(2);expect(mock.sfn).toHaveBeenCalledTimes(1);
  });
  it('creates document jobs without presigning before the identity is durable',async()=>{
    const body={request:input().request,dataClassification:'synthetic_only',attestsSyntheticOnly:true,
      documents:[{clientDocumentId:id,fileName:'fictional.pdf',contentType:'application/pdf',byteSize:10,checksumSHA256:Buffer.alloc(32).toString('base64')}]};
    const first=await handler(event('POST','requests/documents',body));expect(first.statusCode).toBe(200);
    expect((await handler(event('POST','requests/documents',body))).body).toBe(first.body);
    expect([...rows.values()].find(r=>r.state)?.state).toBe('awaiting_upload');expect(mock.sfn).not.toHaveBeenCalled();
  });
  it('rejects missing identity on dedicated routes, cross-owner discovery and input mismatch',async()=>{
    const body=input();expect((await handler(event('POST','requests/saved',{...body,request:undefined}))).statusCode).toBe(400);
    await handler(event('POST','requests/saved',body));
    expect((await handler(event('POST','requests/saved',{...body,panelName:'Changed'}))).statusCode).toBe(409);
    const missing=await handler(event('GET','requests/'+id,undefined,{sub:id}));expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body).data).toEqual({contractVersion:'lab-request-recovery/1',error:'lab_request_not_found'});
  });
  it('does not recreate a deleted job and keeps synthetic authorization on capability discovery',async()=>{
    const body=input(),first=await handler(event('POST','requests/saved',body));rows.delete('job#'+JSON.parse(first.body).data.jobId);
    expect((await handler(event('POST','requests/saved',body))).statusCode).toBe(410);
    expect((await handler(event('GET','requests/'+id))).statusCode).toBe(410);
    expect((await handler(event('GET','request-recovery',undefined,{'custom:synthetic_attested':'false'}))).statusCode).toBe(400);
    expect(JSON.parse((await handler(event('GET','request-recovery'))).body).data.contractVersion).toBe('lab-request-recovery/1');
  });
  it('declares all ten recovery routes with existing scoped authorizers and no public routes',()=>{
    const template=JSON.parse(readFileSync('infra/aws-clinical-core/lab-analysis-extension.json','utf8'));
    const routes=Object.values(template.Resources).filter((r:unknown)=>(r as {Type:string}).Type==='AWS::ApiGatewayV2::Route') as {Properties:{RouteKey:string;AuthorizationType:string;AuthorizerId:{Ref:string}}}[];
    expect(routes).toHaveLength(36);expect(routes.filter(r=>/\/requests\/|\/request-recovery$/.test(r.Properties.RouteKey))).toHaveLength(10);
    expect(routes.filter(r=>r.Properties.RouteKey.endsWith('/cancel'))).toHaveLength(2);
    for(const {Properties:p} of routes){expect(p.AuthorizationType).toBe(p.RouteKey.includes('/consumer/')?'JWT':'CUSTOM');expect(template.Resources[p.AuthorizerId.Ref]).toBeDefined();}
    expect(template.Outputs.PhiAllowed.Value).toBe('false');
    const policy=template.Resources.LabApiRole.Properties.Policies.find((p:{PolicyName:string})=>p.PolicyName==='LabJobLedger');
    expect(policy.PolicyDocument.Statement[0].Action).toContain('dynamodb:ConditionCheckItem');
    expect(policy.PolicyDocument.Statement[0].Resource).toEqual({'Fn::GetAtt':['LabJobTable','Arn']});
  });
});
