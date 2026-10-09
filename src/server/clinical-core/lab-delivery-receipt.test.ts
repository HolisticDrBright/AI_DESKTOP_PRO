import {beforeEach,describe,it,expect,vi,afterEach} from 'vitest';
const mock=vi.hoisted(()=>({db:vi.fn(),sfn:vi.fn()}));
vi.mock('@aws-sdk/lib-dynamodb',async importOriginal=>({...await importOriginal<typeof import('@aws-sdk/lib-dynamodb')>(),DynamoDBDocumentClient:{from:()=>({send:mock.db})}}));
vi.mock('@aws-sdk/client-sfn',()=>({SFNClient:class{send=mock.sfn;},StartExecutionCommand:class{constructor(public input:unknown){}}}));
import {createAwsLabAnalysisApiHandler as handler,createLabAnalysisApi,LAB_DELIVERY_VERSION,LAB_DELIVERY_ACK_VERSION} from './aws-lab-analysis-api';
import {LabAuthorizationRevoked} from './owned-lab-authorization';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
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
      if(v[':transfers']){
        const matches=row&&row.state===v[':completed']&&row.ownerSub===v[':owner']&&row.organizationId===v[':organization']&&row.personId===v[':person']
          &&row.dataClassification===v[':classification']&&row.expiresAt===v[':expiry']&&Number(row.expiresAt)>v[':clock']
          &&isDeepStrictEqual(row.delivery,v[':previousDelivery'])&&isDeepStrictEqual(row.result,v[':result'])
          &&isDeepStrictEqual(row.deliveryAcknowledgment,v[':previousAck'])&&isDeepStrictEqual(row.deliveryTransfers,v[':previousTransfers']);
        if(!matches)throw Object.assign(new Error('conditional'),{name:'ConditionalCheckFailedException'});
        const next:Record<string,unknown>={...row,delivery:v[':delivery'],deliveryTransfers:v[':transfers'],updatedAt:v[':now']};delete next.deliveryAcknowledgment;
        rows.set(c.input.Key.pk,next);return {};
      }
      if(v[':publication']){
        const conditionOk=row&&row.state===v[':completed']&&row.ownerSub===v[':owner']&&isDeepStrictEqual(row.result,v[':result']);
        if(!conditionOk)throw Object.assign(new Error('conditional'),{name:'ConditionalCheckFailedException'});
        rows.set(c.input.Key.pk,{...row,publication:v[':publication'],updatedAt:v[':now']});return {};
      }
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

const reviewTransfer=async(to=deviceB,sub=owner)=>handler(event('POST',`jobs/${id}/delivery`,{contractVersion:'lab-delivery-transfer-review/1',toBindingSha256:to},sub));
const transferCommand=(preview:Record<string,unknown>)=>({contractVersion:'lab-delivery-transfer/1',claimSha256:preview.claimSha256,
  fromBindingSha256:preview.fromBindingSha256,toBindingSha256:preview.toBindingSha256,confirmTransfer:true});
const transfer=(preview:Record<string,unknown>,sub=owner)=>handler(event('POST',`jobs/${id}/delivery`,transferCommand(preview),sub));
describe('explicit lost-phone delivery transfer',()=>{
  async function prepare(){rows.set('job#'+id,job());await claim(deviceA);return JSON.parse((await reviewTransfer()).body).data;}
  it('reviews without writing, transfers only the claim, retains prior ACK and allows the new device to persist',async()=>{
    await prepare();await ack();const before=structuredClone(rows.get('job#'+id));
    const preview=JSON.parse((await reviewTransfer()).body).data;
    expect(rows.get('job#'+id)).toEqual(before);expect(preview).toMatchObject({contractVersion:'lab-delivery-transfer-review/1',jobId:id,fromBindingSha256:deviceA,toBindingSha256:deviceB});
    expect(Object.keys(preview).sort()).toEqual(['claimSha256','contractVersion','fromBindingSha256','jobId','resultSha256','toBindingSha256']);
    const result=await transfer(preview);expect(result.statusCode).toBe(200);
    const row=rows.get('job#'+id)!;expect(row.result).toEqual(before!.result);expect(row.state).toBe('completed');
    expect(row.deliveryAcknowledgment).toBeUndefined();expect(row.deliveryTransfers).toEqual([expect.objectContaining({previousAcknowledgment:before!.deliveryAcknowledgment,previousDelivery:before!.delivery})]);
    expect((await claim(deviceA)).statusCode).toBe(409);expect((await ack(deviceA)).statusCode).toBe(409);
    expect((await claim(deviceB)).statusCode).toBe(200);expect((await ack(deviceB)).statusCode).toBe(200);
    const replay=await transfer(preview);expect(replay.body).toEqual(result.body);expect((rows.get('job#'+id)!.deliveryTransfers as unknown[]).length).toBe(1);
  });
  it('rejects tampered reviews, absent confirmation, same device, wrong users and unsupported fields',async()=>{
    const preview=await prepare();expect((await reviewTransfer(deviceA)).statusCode).toBe(409);expect((await reviewTransfer(deviceB,other)).statusCode).toBe(404);
    expect((await transfer(preview,other)).statusCode).toBe(404);
    for(const patch of [{claimSha256:'d'.repeat(64)},{fromBindingSha256:'c'.repeat(64)}])expect((await transfer({...preview,...patch})).statusCode).toBe(409);
    for(const patch of [{confirmTransfer:false},{confirmTransfer:undefined},{extra:true},{toBindingSha256:deviceA},{claimSha256:'bad'}]){
      const response=await handler(event('POST',`jobs/${id}/delivery`,{...transferCommand(preview),...patch}));expect(response.statusCode).toBe(400);
    }
    expect(rows.get('job#'+id)!.deliveryTransfers).toBeUndefined();
  });
  it.each(['ack','claim','result','expiry','deleting'] as const)('refuses a review after %s changes',async mode=>{
    const preview=await prepare();
    if(mode==='ack')await ack();if(mode==='claim')await claim(deviceA);if(mode==='result')rows.get('job#'+id)!.result={changed:true};
    if(mode==='expiry')rows.get('job#'+id)!.expiresAt=Math.floor(Date.now()/1000)-1;if(mode==='deleting')rows.get('job#'+id)!.state='deleting';
    expect((await transfer(preview)).statusCode).toBe(mode==='deleting'?404:409);expect(rows.get('job#'+id)!.deliveryTransfers).toBeUndefined();
  });
  it.each(['ack','result','deleted','other_transfer','classification','organization','person'] as const)('conditional update fences a concurrent %s after the authorized read',async mode=>{
    const preview=await prepare(),original=mock.db.getMockImplementation()!;
    mock.db.mockImplementation(async c=>{
      if(c.input.ExpressionAttributeValues?.[':transfers']){
        const row=rows.get('job#'+id)!;
        if(mode==='ack')row.deliveryAcknowledgment={bindingSha256:deviceA,disposition:'applied'};
        if(mode==='result')row.result={changed:true};if(mode==='deleted')rows.delete('job#'+id);
        if(mode==='other_transfer')row.delivery={bindingSha256:'c'.repeat(64),deliveredAt:new Date().toISOString(),count:1};
        if(mode==='classification')row.dataClassification='personal_health_record';if(mode==='organization')row.organizationId=other;if(mode==='person')row.personId=other;
      }
      return original(c);
    });
    expect((await transfer(preview)).statusCode).toBe(409);
    expect(rows.get('job#'+id)?.deliveryTransfers).toBeUndefined();
  });
  it('reconciles simultaneous identical requests without duplicate audit entries',async()=>{
    const preview=await prepare(),results=await Promise.all([transfer(preview),transfer(preview)]);
    expect(results.map(r=>r.statusCode)).toEqual([200,200]);expect(results[0].body).toEqual(results[1].body);
    expect((rows.get('job#'+id)!.deliveryTransfers as unknown[]).length).toBe(1);
  });
  it('preserves newer decisions after A to B to A and refuses stale transfer replay',async()=>{
    const preview=await prepare();await transfer(preview);
    const reverse=JSON.parse((await reviewTransfer(deviceA)).body).data;expect((await transfer(reverse)).statusCode).toBe(200);
    expect((await transfer(preview)).statusCode).toBe(409);expect((rows.get('job#'+id)!.delivery as {bindingSha256:string}).bindingSha256).toBe(deviceA);
  });
  it('bounds transfer history without dropping old receipts or extending expiry',async()=>{
    await prepare();const expiry=rows.get('job#'+id)!.expiresAt;
    for(let index=0;index<16;index++){
      const preview=JSON.parse((await reviewTransfer(index%2?deviceA:deviceB)).body).data;
      expect((await transfer(preview)).statusCode).toBe(200);
    }
    expect((await reviewTransfer(deviceB)).statusCode).toBe(409);
    expect((rows.get('job#'+id)!.deliveryTransfers as unknown[]).length).toBe(16);expect(rows.get('job#'+id)!.expiresAt).toBe(expiry);
  });
  it('production review and confirmation independently enforce current consent/account closure',async()=>{
    const preview=await prepare();rows.get('job#'+id)!.dataClassification='personal_health_record';
    const verify=vi.fn(async()=>{throw new LabAuthorizationRevoked('account_deletion_write_blocked');});
    const production=createLabAnalysisApi({mode:'production',identity:()=>({sub:owner,'custom:person_id':owner,'custom:organization_id':owner}),capture:async()=>{throw new Error('not creation');},policy:{verify},requireCore:async()=>{},revalidatePrivacyIdentity:async()=>{}});
    for(const input of [{contractVersion:'lab-delivery-transfer-review/1',toBindingSha256:deviceB},transferCommand(preview)]){
      const response=await production(event('POST',`jobs/${id}/delivery`,input));expect(response.statusCode).toBe(403);expect(response.body).toContain('account_deletion_write_blocked');
    }
    expect(verify).toHaveBeenCalledTimes(2);expect(rows.get('job#'+id)!.deliveryTransfers).toBeUndefined();
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

describe('durable cloud publication route',()=>{
  const receipt=(status:'published'|'pending'|'refused',extra:Record<string,unknown>={})=>({version:'lab-publication/1' as const,status,resultSha256:createHash('sha256').update(JSON.stringify({analysisId:id})).digest('hex'),at:'2026-09-18T12:00:00.000Z',...extra});
  const production=(publish?:(job:unknown)=>Promise<unknown>)=>createLabAnalysisApi({mode:'production',identity:(e)=>{const c=(e as {requestContext:{authorizer:{jwt:{claims:Record<string,string>}}}}).requestContext.authorizer.jwt.claims;return {sub:c.sub,'custom:person_id':c['custom:person_id'],'custom:organization_id':c['custom:organization_id']};},capture:async()=>{throw new Error('not creation');},policy:{verify:async()=>{}},requireCore:async()=>{},revalidatePrivacyIdentity:async()=>{},...(publish?{publish:publish as never}:{})});
  it('publishes a completed result once, records the receipt, exposes it in status and inventory, and replays without republishing',async()=>{
    rows.set('job#'+id,job({dataClassification:'personal_health_record'}));const publish=vi.fn(async()=>receipt('published',{recordId:owner,revision:1}));
    const api=production(publish);
    const first=await api(event('POST',`jobs/${id}/publication`));expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).data).toMatchObject({contractVersion:'lab-publication/1',jobId:id,publication:{status:'published',recordId:owner,revision:1}});
    const status=JSON.parse((await api(event('GET',`jobs/${id}`))).body).data;expect(status.publication).toMatchObject({status:'published',recordId:owner});
    expect(labRecoveryDescriptor(rows.get('job#'+id)!,{ownerSub:owner,organizationId:owner,personId:owner})!.publication).toEqual({status:'published'});
    const again=await api(event('POST',`jobs/${id}/publication`));expect(again.statusCode).toBe(200);expect(publish).toHaveBeenCalledOnce();
  });
  it('retries a pending or refused publication, refuses unfinished jobs and other owners, and is unavailable in synthetic mode',async()=>{
    rows.set('job#'+id,job({dataClassification:'personal_health_record',publication:receipt('pending',{reason:'storage_unavailable'})}));
    const publish=vi.fn(async()=>receipt('refused',{reason:'lab_consent_required'}));const api=production(publish);
    const retried=await api(event('POST',`jobs/${id}/publication`));expect(retried.statusCode).toBe(200);expect(JSON.parse(retried.body).data.publication).toMatchObject({status:'refused',reason:'lab_consent_required'});
    expect(publish).toHaveBeenCalledOnce();
    rows.set('job#'+id,job({dataClassification:'personal_health_record',state:'interpreting',result:undefined}));
    expect((await api(event('POST',`jobs/${id}/publication`))).statusCode).toBe(409);
    rows.set('job#'+id,job({dataClassification:'personal_health_record'}));
    expect((await api(event('POST',`jobs/${id}/publication`,undefined,other))).statusCode).toBe(404);
    expect((await production()(event('POST',`jobs/${id}/publication`))).statusCode).toBe(404);
    rows.set('job#'+id,job());
    expect((await handler(event('POST',`jobs/${id}/publication`))).statusCode).toBe(404);
    expect(publish).toHaveBeenCalledOnce();
  });
  it('reports a pending receipt when the job record cannot be updated after publishing',async()=>{
    rows.set('job#'+id,job({dataClassification:'personal_health_record'}));const api=production(async()=>receipt('published',{recordId:owner,revision:1}));
    mock.db.mockImplementationOnce(async c=>{if(c.constructor.name==='GetCommand')return {Item:rows.get(c.input.Key.pk)};throw new Error('x');});
    mock.db.mockImplementationOnce(async()=>{throw new Error('dynamo offline');});
    const response=await api(event('POST',`jobs/${id}/publication`));
    expect(response.statusCode).toBe(503);expect(JSON.parse(response.body).data).toMatchObject({error:'lab_publication_receipt_pending'});
  });
});
