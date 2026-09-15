import { describe,it,expect,vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { labRequestLedger, requestIdentity } from './lab-request-ledger';
const id='10000000-0000-4000-8000-000000000001';
const now=Date.parse('2026-09-15T12:00:00.000Z');
const request={id,createdAt:new Date(now).toISOString()};
const scope={ownerSub:'owner-a',organizationId:'clinic-a',personId:'person-a'};
const job=(suffix='a')=>({...scope,pk:'job#'+suffix,expiresAt:now/1000+600});
function setup(){
  const rows=new Map<string,Record<string,unknown>>();let lost=false,offline=false,time=now;
  const send=vi.fn(async(command:{constructor:{name:string};input:Record<string,unknown>})=>{
    if(offline)throw new Error('offline');
    if(command.constructor.name==='GetCommand'){
      expect(command.input.ConsistentRead).toBe(true);
      return {Item:rows.get((command.input.Key as {pk:string}).pk)};
    }
    const puts=(command.input.TransactItems as {Put:{Item:Record<string,unknown>;ConditionExpression:string}}[]).map(r=>r.Put);
    expect(puts).toHaveLength(2);expect(puts.every(p=>p.ConditionExpression==='attribute_not_exists(pk)')).toBe(true);
    if(puts.some(p=>rows.has(p.Item.pk as string)))throw new Error('transaction cancelled');
    for(const p of puts)rows.set(p.Item.pk as string,p.Item);
    if(lost)throw new Error('committed but response lost');
    return {};
  });
  const api=labRequestLedger({send} as unknown as DynamoDBDocumentClient,'fixture-table',()=>time);
  return {api,rows,send,lost:()=>{lost=true;},offline:()=>{offline=true;},time:(n:number)=>{time=n;}};
}
describe('immutable lab creation request ledger',()=>{
  it('atomically stores a payload-free identity and job and replays canonical reordered inputs',async()=>{
    const t=setup();await t.api.create(scope,request,'saved',{b:2,a:1},job());
    expect(await t.api.create(scope,request,'saved',{a:1,b:2},job('ignored'))).toEqual(job());
    expect(t.rows.size).toBe(2);
    const ledger=[...t.rows.values()].find(r=>String(r.pk).startsWith('request#'))!;
    expect(Object.keys(ledger).sort()).toEqual(['pk','jobId','fingerprint','createdAt','expiresAt'].sort());
    expect(await t.api.discover(scope,id)).toEqual(job());
  });
  it('returns one winner under concurrent creates',async()=>{
    const t=setup();const results=await Promise.all(['a','b','c'].map(x=>t.api.create(scope,request,'documents',{documents:['fictional']},job(x))));
    expect(new Set(results.map(r=>r.pk)).size).toBe(1);expect(t.rows.size).toBe(2);
  });
  it('recovers a committed transaction whose response was lost',async()=>{
    const t=setup();t.lost();expect(await t.api.create(scope,request,'saved',{},job())).toEqual(job());expect(t.rows.size).toBe(2);
  });
  it.each([{input:{changed:true},kind:'saved',createdAt:request.createdAt},
    {input:{},kind:'documents',createdAt:request.createdAt},
    {input:{},kind:'saved',createdAt:new Date(now-1).toISOString()}] as const)('rejects intent/kind/time conflict %#',async change=>{
    const t=setup();await t.api.create(scope,request,'saved',{},job());
    await expect(t.api.create(scope,{...request,createdAt:change.createdAt},change.kind,change.input,job('replacement'))).rejects.toMatchObject({code:'lab_request_conflict'});
    expect(t.rows.size).toBe(2);
  });
  it.each(['ownerSub','organizationId','personId'] as const)('does not discover another %s scope',async field=>{
    const t=setup();await t.api.create(scope,request,'saved',{},job());
    await expect(t.api.discover({...scope,[field]:'other'},id)).rejects.toMatchObject({code:'lab_request_not_found'});
  });
  it('retains a tombstone after job deletion and refuses recreation',async()=>{
    const t=setup();await t.api.create(scope,request,'saved',{},job());t.rows.delete('job#a');
    await expect(t.api.discover(scope,id)).rejects.toMatchObject({code:'lab_request_gone'});
    await expect(t.api.create(scope,request,'saved',{},job('new'))).rejects.toMatchObject({code:'lab_request_gone'});expect(t.rows.size).toBe(1);
  });
  it('refuses expired jobs and requests even after TTL removes all metadata',async()=>{
    const t=setup();await t.api.create(scope,request,'saved',{},job());t.time(now+601_000);
    await expect(t.api.discover(scope,id)).rejects.toMatchObject({code:'lab_request_gone'});
    t.rows.clear();t.time(now+91*86400_000);
    await expect(t.api.create(scope,request,'saved',{},job('new'))).rejects.toMatchObject({code:'lab_request_gone'});expect(t.rows.size).toBe(0);
  });
  it('refuses future, malformed and augmented identities',async()=>{
    for(const value of [null,{}, {...request,id:'bad'}, {...request,createdAt:'yesterday'}, {...request,token:'not-allowed'}])expect(()=>requestIdentity(value)).toThrow();
    const t=setup();await expect(t.api.create(scope,{...request,createdAt:new Date(now+61_000).toISOString()},'saved',{},job())).rejects.toMatchObject({code:'lab_request_gone'});
  });
  it('never interprets infrastructure failure as absence',async()=>{
    const t=setup();t.offline();await expect(t.api.discover(scope,id)).rejects.toThrow('offline');
    await expect(t.api.create(scope,request,'saved',{},job())).rejects.toThrow('offline');expect(t.rows.size).toBe(0);
  });
});
