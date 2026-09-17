import {beforeEach,describe,it,expect,vi,afterEach} from 'vitest';
const mock=vi.hoisted(()=>({db:vi.fn(),sfn:vi.fn()}));
vi.mock('@aws-sdk/lib-dynamodb',async importOriginal=>({...await importOriginal<typeof import('@aws-sdk/lib-dynamodb')>(),DynamoDBDocumentClient:{from:()=>({send:mock.db})}}));
vi.mock('@aws-sdk/client-sfn',()=>({SFNClient:class{send=mock.sfn;},StartExecutionCommand:class{constructor(public input:unknown){}}}));
import {createAwsLabAnalysisApiHandler as handler,createLabAnalysisApi,LAB_DELIVERY_VERSION,LAB_DELIVERY_ACK_VERSION} from './aws-lab-analysis-api';
import {LabAuthorizationRevoked} from './owned-lab-authorization';
import {labRecoveryDescriptor} from './lab-job-inventory';
const id='10000000-0000-4000-8000-000000000001',owner='20000000-0000-4000-8000-000000000001',other='30000000-0000-4000-8000-000000000001';
const deviceA='a'.repeat(64),deviceB='b'.repeat(64);
const rows=new Map<string,Record<string,unknown>>();
const event=(method:string,path:string,input?:unknown,sub=owner)=>({rawPath:'/clinical-core/consumer/labs/'+path,
  body:input===undefined?undefined:JSON.stringify(input),requestContext:{http:{method},authorizer:{jwt:{claims:{sub,'custom:person_id':owner,'custom:organization_id':owner,'custom:synthetic_attested':'true'}}}}});
const job=(patch:Record<string,unknown>={})=>({pk:'job#'+id,ownerSub:owner,organizationId:owner,personId:owner,state:'completed',passesCompleted:5,progressPercent:100,attempt:1,
  createdAt:new Date(Date.now()-120_000).toISOString(),updatedAt:new Date(Date.now()-60_000).toISOString(),expiresAt:Math.floor(Date.now()/1000)+3600,documents:[],failureCategory:null,result:{analysisId:id},...patch});
beforeEach(()=>{
  rows.clear();vi.clearAllMocks();vi.stubEnv('LAB_JOB_TABLE','fictional-table');vi.stubEnv('LAB_RANGE_MODE','synthetic_fixture');vi.stubEnv('LAB_STATE_MACHINE_ARN','fictional-machine');
  mock.db.mockImplementation(async c=>{
    if(c.constructor.name==='GetCommand')return {Item:rows.get(c.input.Key.pk)};
    if(c.constructor.name==='UpdateCommand'){
      const row=rows.get(c.input.Key.pk)!;const v=c.input.ExpressionAttributeValues;
      const condition=c.input.ConditionExpression as string;
      if(v[':ack']){
        if(row.state!==v[':completed']||row.ownerSub!==v[':owner']||(row.delivery as {bindingSha256:string})?.bindingSha256!==v[':binding']||row.deliveryAcknowledgment)throw Object.assign(new Error('conditional'),{name:'ConditionalCheckFailedException'});
        rows.set(c.input.Key.pk,{...row,deliveryAcknowledgment:v[':ack'],updatedAt:v[':now']});return {};
      }
      const ok=row.state===v[':completed']&&row.ownerSub===v[':owner']&&(condition.includes('attribute_not_exists(delivery)')?row.delivery===undefined
        :(row.delivery as {bindingSha256:string;count:number})?.bindingSha256===v[':binding']&&(row.delivery as {count:number}).count===v[':previous']);
      if(!ok)throw Object.assign(new Error('conditional'),{name:'ConditionalCheckFailedException'});
      rows.set(c.input.Key.pk,{...row,delivery:v[':delivery'],updatedAt:v[':now']});return {};
    }
    throw new Error('unexpected '+c.constructor.name);
  });mock.sfn.mockResolvedValue({});
});
afterEach(()=>vi.unstubAllEnvs());
const claim=(device:string,sub=owner)=>handler(event('POST',`jobs/${id}/delivery`,{contractVersion:LAB_DELIVERY_VERSION,deviceBindingSha256:device},sub));
const ack=(device=deviceA,disposition='applied',sub=owner)=>handler(event('POST',`jobs/${id}/delivery`,{contractVersion:LAB_DELIVERY_ACK_VERSION,deviceBindingSha256:device,disposition},sub));
describe('device-bound delivery claims',()=>{
  it('claims a completed result for one device, is idempotent for that device, and exposes only the binding digest',async()=>{
    rows.set('job#'+id,job());
    const first=await claim(deviceA);expect(first.statusCode).toBe(200);
    const body=JSON.parse(first.body).data;expect(body).toMatchObject({contractVersion:LAB_DELIVERY_VERSION,jobId:id,delivery:{bindingSha256:deviceA,count:1}});
    const again=await claim(deviceA);expect(again.statusCode).toBe(200);expect(JSON.parse(again.body).data.delivery).toMatchObject({bindingSha256:deviceA,count:2,deliveredAt:body.delivery.deliveredAt});
    const status=JSON.parse((await handler(event('GET',`jobs/${id}`))).body).data;
    expect(status.delivery).toEqual({bindingSha256:deviceA,deliveredAt:body.delivery.deliveredAt});expect(status.result).toEqual({analysisId:id});
    const descriptor=labRecoveryDescriptor(rows.get('job#'+id)!,{ownerSub:owner,organizationId:owner,personId:owner})!;
    expect(descriptor.delivery).toEqual({bindingSha256:deviceA});expect(JSON.stringify(descriptor)).not.toContain('count');
  });
  it('refuses a second device, a concurrent winner, unfinished jobs, other owners and malformed claims without changing the result',async()=>{
    rows.set('job#'+id,job());expect((await claim(deviceA)).statusCode).toBe(200);
    const conflict=await claim(deviceB);expect(conflict.statusCode).toBe(409);expect(JSON.parse(conflict.body).data).toEqual({contractVersion:LAB_DELIVERY_VERSION,error:'lab_delivery_conflict'});
    rows.set('job#'+id,job());mock.db.mockImplementationOnce(async c=>({Item:rows.get(c.input.Key.pk)}));
    const original=mock.db.getMockImplementation()!;
    mock.db.mockImplementation(async c=>{if(c.constructor.name==='UpdateCommand'){rows.set('job#'+id,job({delivery:{bindingSha256:deviceB,deliveredAt:'2026-09-16T12:06:00.000Z',count:1}}));throw Object.assign(new Error('conditional'),{name:'ConditionalCheckFailedException'});}return original(c);});
    expect((await claim(deviceA)).statusCode).toBe(409);expect((rows.get('job#'+id)!.delivery as {bindingSha256:string}).bindingSha256).toBe(deviceB);
    mock.db.mockImplementation(original);
    rows.set('job#'+id,job({state:'synthesizing',result:null}));expect((await claim(deviceA)).statusCode).toBe(409);
    rows.set('job#'+id,job());expect((await claim(deviceA,other)).statusCode).toBe(404);
    for(const bad of [{contractVersion:LAB_DELIVERY_VERSION,deviceBindingSha256:'short'},{contractVersion:'other/1',deviceBindingSha256:deviceA},{contractVersion:LAB_DELIVERY_VERSION,deviceBindingSha256:deviceA,extra:true}])
      expect((await handler(event('POST',`jobs/${id}/delivery`,bad))).statusCode).toBe(400);
    expect(rows.get('job#'+id)!.result).toEqual({analysisId:id});expect(rows.get('job#'+id)!.delivery).toBeUndefined();
  });
  it('status omits delivery until a device has claimed, so older clients keep parsing',async()=>{
    rows.set('job#'+id,job());
    expect(JSON.parse((await handler(event('GET',`jobs/${id}`))).body).data).not.toHaveProperty('delivery');
    expect(()=>labRecoveryDescriptor(job({delivery:{bindingSha256:'nope'}}),{ownerSub:owner,organizationId:owner,personId:owner})).toThrow('lab_inventory_invalid');
  });
});

describe('durable delivery acknowledgment',()=>{
  it('requires a prior matching claim, records the client disposition and result digest once, and survives lost responses',async()=>{
    rows.set('job#'+id,job());expect((await ack()).statusCode).toBe(409);
    await claim(deviceA);expect(rows.get('job#'+id)!.deliveryAcknowledgment).toBeUndefined();
    const first=await ack();expect(first.statusCode).toBe(200);
    const receipt=JSON.parse(first.body).data;
    expect(receipt).toMatchObject({contractVersion:LAB_DELIVERY_ACK_VERSION,jobId:id,acknowledgment:{bindingSha256:deviceA,disposition:'applied',resultSha256:expect.stringMatching(/^[a-f0-9]{64}$/)}});
    expect(JSON.parse((await ack()).body).data).toEqual(receipt);
    await claim(deviceA);expect(rows.get('job#'+id)!.deliveryAcknowledgment).toEqual(receipt.acknowledgment);
    expect((await ack(deviceA,'archived_not_applied')).statusCode).toBe(409);
    expect((await ack(deviceB)).statusCode).toBe(409);expect((await ack(deviceA,'applied',other)).statusCode).toBe(404);
    expect(rows.get('job#'+id)!.result).toEqual({analysisId:id});
  });
  it('refuses unknown dispositions, extra fields, deleting jobs and changed content without inventing applied state',async()=>{
    rows.set('job#'+id,job());await claim(deviceA);
    expect((await ack(deviceA,'physician_approved')).statusCode).toBe(400);
    expect((await handler(event('POST',`jobs/${id}/delivery`,{contractVersion:LAB_DELIVERY_ACK_VERSION,deviceBindingSha256:deviceA,disposition:'applied',ownerId:owner}))).statusCode).toBe(400);
    expect(rows.get('job#'+id)!.deliveryAcknowledgment).toBeUndefined();
    expect((await ack(deviceA,'archived_not_applied')).statusCode).toBe(200);
    rows.get('job#'+id)!.result={changed:true};expect((await ack(deviceA,'archived_not_applied')).statusCode).toBe(409);
    rows.get('job#'+id)!.state='deleting';expect((await ack()).statusCode).toBe(404);
  });
  it('reconciles concurrent identical acknowledgments but never overwrites another disposition or deletion',async()=>{
    for(const outcome of ['same','different','deleted','result_changed']){
      rows.set('job#'+id,job());await claim(deviceA);
      const original=mock.db.getMockImplementation()!;
      mock.db.mockImplementation(async c=>{
        if(c.input.ExpressionAttributeValues?.[':ack']){
          const acknowledgment=c.input.ExpressionAttributeValues[':ack'];
          if(outcome==='deleted')rows.delete(c.input.Key.pk);
          else rows.get(c.input.Key.pk)!.deliveryAcknowledgment={...acknowledgment,...(outcome==='different'?{disposition:'archived_not_applied'}:{})};
          if(outcome==='result_changed')rows.get(c.input.Key.pk)!.result={changed:true};
          throw Object.assign(new Error('conditional'),{name:'ConditionalCheckFailedException'});
        }
        return original(c);
      });
      expect((await ack()).statusCode).toBe(outcome==='same'?200:409);mock.db.mockImplementation(original);
    }
  });
  it('rechecks production consent before persisting an acknowledgment',async()=>{
    rows.set('job#'+id,job({dataClassification:'personal_health_record',delivery:{bindingSha256:deviceA,deliveredAt:new Date().toISOString(),count:1}}));
    const verify=vi.fn(async()=>{throw new LabAuthorizationRevoked();});
    const production=createLabAnalysisApi({mode:'production',identity:()=>({sub:owner,'custom:person_id':owner,'custom:organization_id':owner}),capture:async()=>{throw new Error('not creation');},policy:{verify},requireCore:async()=>{throw new Error('not creation');},revalidatePrivacyIdentity:async()=>{throw new Error('not privacy');}});
    const result=await production(event('POST',`jobs/${id}/delivery`,{contractVersion:LAB_DELIVERY_ACK_VERSION,deviceBindingSha256:deviceA,disposition:'applied'}));
    expect(result.statusCode).toBe(403);expect(verify).toHaveBeenCalledOnce();expect(rows.get('job#'+id)!.deliveryAcknowledgment).toBeUndefined();
  });
});
