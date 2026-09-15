import {describe,it,expect,vi} from 'vitest';
import type {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {labRequestLedger} from './lab-request-ledger';
const now=Date.parse('2026-09-15T15:00:00.000Z');
const request={id:'11111111-1111-4111-8111-111111111111',createdAt:new Date(now).toISOString()};
const scope={ownerSub:'owner-a',organizationId:'org-a',personId:'person-a'};
const job=(state='queued',expiresAt=now/1000+600)=>({...scope,pk:'job#22222222-2222-4222-8222-222222222222',state,expiresAt});
type Row=Record<string,unknown>;
function setup(){
  const rows=new Map<string,Row>();let lost=false,fail=false;
  const cancelled=()=>Object.assign(new Error('conditional check failed'),{name:'TransactionCanceledException'});
  const send=vi.fn(async(command:{constructor:{name:string};input:Record<string,unknown>})=>{
    if(command.constructor.name==='GetCommand')return {Item:rows.get((command.input.Key as {pk:string}).pk)};
    if(fail)throw new Error('permission denied');
    type Action={Put?:{Item:Row;ConditionExpression:string};Update?:{Key:{pk:string};ExpressionAttributeValues:Row;ConditionExpression:string};ConditionCheck?:{Key:{pk:string};ExpressionAttributeValues:Row;ConditionExpression:string}};
    const actions=command.input.TransactItems as Action[];
    // Validate every condition before applying any write, modelling transaction atomicity.
    for(const action of actions){
      if(action.Put){expect(action.Put.ConditionExpression).toBe('attribute_not_exists(pk)');if(rows.has(action.Put.Item.pk as string))throw cancelled();}
      if(action.Update){
        const row=rows.get(action.Update.Key.pk),v=action.Update.ExpressionAttributeValues;
        expect(action.Update.ConditionExpression).toBe('jobId = :job AND createdAt = :created AND attribute_not_exists(retiredAt)');
        if(!row || row.jobId!==v[':job'] || row.createdAt!==v[':created'] || row.retiredAt)throw cancelled();
      }
      if(action.ConditionCheck){
        const row=rows.get(action.ConditionCheck.Key.pk),v=action.ConditionCheck.ExpressionAttributeValues;
        expect(action.ConditionCheck.ConditionExpression).toContain('expiresAt <= :now AND #state IN');
        if(row && !(row.ownerSub===v[':owner']&&row.organizationId===v[':org']&&row.personId===v[':person']
          && Number(row.expiresAt)<=Number(v[':now'])&&[v[':completed'],v[':failed'],v[':review']].includes(row.state)))throw cancelled();
      }
    }
    for(const action of actions){
      if(action.Put)rows.set(action.Put.Item.pk as string,action.Put.Item);
      if(action.Update){const v=action.Update.ExpressionAttributeValues;rows.set(action.Update.Key.pk,{...rows.get(action.Update.Key.pk),retiredAt:v[':retired'],expiresAt:v[':ttl']});}
    }
    if(lost)throw new Error('committed but response lost');return {};
  });
  return {rows,send,api:labRequestLedger({send} as unknown as DynamoDBDocumentClient,'fixture-table',()=>now),lost:()=>{lost=true;},fail:()=>{fail=true;}};
}
describe('safe unavailable-request retirement',()=>{
  it('retirement of an unrecorded request blocks any late create and is retryable',async()=>{
    const t=setup();await t.api.retire(scope,request);await t.api.retire(scope,request);
    expect(t.rows.size).toBe(1);expect([...t.rows.values()][0]).not.toHaveProperty('jobId');
    await expect(t.api.create(scope,request,'saved',{},job())).rejects.toMatchObject({code:'lab_request_gone'});
    await expect(t.api.discover(scope,request.id)).rejects.toMatchObject({code:'lab_request_gone'});
  });
  it.each(['create-first','retire-first'])('serializes competing creation and retirement: %s',async order=>{
    const t=setup();const create=()=>t.api.create(scope,request,'saved',{},job()),retire=()=>t.api.retire(scope,request);
    const results=await Promise.allSettled(order==='create-first'?[create(),retire()]:[retire(),create()]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const ledger=[...t.rows.values()].find(r=>String(r.pk).startsWith('request#'))!;
    expect(Boolean(ledger.retiredAt)).toBe(!t.rows.has(job().pk));
  });
  it('retires a deleted job without recreating or deleting anything else',async()=>{
    const t=setup();await t.api.create(scope,request,'saved',{},job());t.rows.delete(job().pk);
    await t.api.retire(scope,request);expect(t.rows.size).toBe(1);
    await expect(t.api.create(scope,request,'saved',{},job())).rejects.toMatchObject({code:'lab_request_gone'});
  });
  it.each(['completed','failed','needs_review'])('allows expired terminal %s without deleting saved results',async state=>{
    const t=setup();const stored={...job(state,now/1000-1),result:{fictional:'preserve'}};
    await t.api.create(scope,request,'saved',{},stored);await t.api.retire(scope,request);
    expect(t.rows.get(stored.pk)).toEqual(stored);expect(t.rows.size).toBe(2);
  });
  it.each(['awaiting_upload','queued','extracting','verifying','normalizing','interpreting','synthesizing','unknown'])('protects even an expired active/unknown %s job',async state=>{
    const t=setup();await t.api.create(scope,request,'saved',{},job(state,now/1000-1));
    await expect(t.api.retire(scope,request)).rejects.toMatchObject({code:'lab_request_not_releasable'});
    expect([...t.rows.values()].some(r=>r.retiredAt)).toBe(false);
  });
  it('keeps unexpired completed results recoverable and rejects timestamp changes',async()=>{
    const t=setup();await t.api.create(scope,request,'saved',{},job('completed'));
    await expect(t.api.retire(scope,request)).rejects.toMatchObject({code:'lab_request_not_releasable'});
    await expect(t.api.retire(scope,{...request,createdAt:new Date(now-1).toISOString()})).rejects.toMatchObject({code:'lab_request_conflict'});
  });
  it.each(['ownerSub','organizationId','personId'] as const)('cannot retire another %s scope',async key=>{
    const t=setup();await t.api.create(scope,request,'saved',{},job());
    await t.api.retire({...scope,[key]:'other'},request);
    expect(await t.api.discover(scope,request.id)).toEqual(job());
  });
  it('recovers a lost retirement acknowledgement but does not report permission failure as success',async()=>{
    const t=setup();t.lost();await t.api.retire(scope,request);expect(t.rows.size).toBe(1);
    const other=setup();other.fail();await expect(other.api.retire(scope,request)).rejects.toThrow('permission denied');expect(other.rows.size).toBe(0);
  });
  it('refuses fabricated future timestamps and mismatched retired timestamps',async()=>{
    const t=setup();await expect(t.api.retire(scope,{...request,createdAt:new Date(now+61000).toISOString()})).rejects.toThrow();
    await t.api.retire(scope,request);await expect(t.api.retire(scope,{...request,createdAt:new Date(now-1).toISOString()})).rejects.toMatchObject({code:'lab_request_conflict'});
  });
});
