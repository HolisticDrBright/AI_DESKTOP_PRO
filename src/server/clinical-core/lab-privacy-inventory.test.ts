import {expect,it,vi} from 'vitest';
import type {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {discoverRetainedLabJobs} from './lab-privacy-inventory';
import {inventoryStamp} from './lab-job-inventory';
const id='10000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
const scope={ownerSub:id,organizationId:id,personId:id},now=Date.parse('2026-09-17T12:00:00.000Z');
const row=()=>({...scope,pk:'job#'+id,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:01.000Z',
  expiresAt:1,state:'completed'});
function setup(){
  const scan=vi.fn(async()=>({Items:[row()] as Record<string,unknown>[],ScannedCount:1,LastEvaluatedKey:undefined as Record<string,unknown>|undefined}));
  const read=vi.fn(async()=>({Item:row() as Record<string,unknown>|undefined}));
  const send=vi.fn(async(c:{constructor:{name:string};input:Record<string,unknown>})=>{
    if(c.constructor.name==='ScanCommand')return scan();
    if(c.constructor.name==='GetCommand')return read();
    throw new Error('unexpected write or request');
  });
  const revalidate=vi.fn(async()=>({...scope}));
  const deps={db:{send} as unknown as DynamoDBDocumentClient,table:'synthetic-table',scope,classification:'synthetic_only' as const,revalidate,now:()=>now};
  return {scan,read,send,revalidate,deps,run:()=>discoverRetainedLabJobs(deps)};
}
it('discovers expired and unindexed retained metadata without processing, payloads or writes',async()=>{
  const t=setup(),result=await t.run();
  expect(result.jobs).toEqual([{jobId:id,state:'completed',createdAt:row().createdAt,updatedAt:row().updatedAt,
    processingExpiresAt:1,processingExpired:true,indexStatus:'unindexed',copyStatus:'request_copy'}]);
  expect(result.coverage).toMatchObject({completeAccountExport:false,tableTraversalExhausted:true,requiresOperatorReconciliation:true});
  expect(t.send.mock.calls.map(c=>c[0].constructor.name)).toEqual(['ScanCommand','GetCommand']);
  for(const [command]of t.send.mock.calls){
    expect(command.input.ConsistentRead).toBe(true);
    const values=Object.values(command.input.ExpressionAttributeNames as Record<string,string>);
    for(const forbidden of ['result','documents','objectKey','structuredBiomarkers','authorization','leaseToken','fileName'])expect(values).not.toContain(forbidden);
  }
  expect(t.send.mock.calls[0][0].input.ExpressionAttributeValues).toEqual({':job':'job#',':owner':id,':org':id,':person':id});
});
it.each(['ownerSub','organizationId','personId'])('rejects scope substitution in filtered scan: %s',async field=>{
  const t=setup();t.scan.mockResolvedValue({Items:[{...row(),[field]:other}],ScannedCount:1,LastEvaluatedKey:undefined});
  await expect(t.run()).rejects.toThrow();expect(t.read).not.toHaveBeenCalled();
});
it.each(['ownerSub','organizationId','personId'])('never discloses an owner changed during reread: %s',async field=>{
  const t=setup();t.read.mockResolvedValue({Item:{...row(),[field]:other}});
  const result=await t.run();expect(result.jobs).toEqual([]);expect(result.counts.disappearedOrChangedOwner).toBe(1);
});
it('counts removed, malformed, changed-key and wrong-classification rows without silently declaring completeness',async()=>{
  for(const item of [undefined,{...row(),pk:'job#'+other},{...row(),expiresAt:null},{...row(),state:'invented'},
    {...row(),updatedAt:'2020-01-01T00:00:00.000Z'},{...row(),dataClassification:'personal_health_record'}]){
    const t=setup();t.read.mockResolvedValue({Item:item});const result=await t.run();
    expect(result.jobs).toEqual([]);expect(result.coverage.hasUnresolvedEnumerationIssues).toBe(true);
  }
});
it('treats missing legacy classification as synthetic, never production',async()=>{
  const t=setup();const result=await discoverRetainedLabJobs({...t.deps,classification:'personal_health_record'});
  expect(result.jobs).toEqual([]);expect(result.counts.classificationMismatch).toBe(1);
});
it('includes deletion in progress without offering a privacy copy or restarting it',async()=>{
  const t=setup();t.read.mockResolvedValue({Item:{...row(),state:'deleting'}});
  expect((await t.run()).jobs[0].copyStatus).toBe('deletion_in_progress');
});
it('distinguishes correct and conflicting index keys and retains unexpired rows',async()=>{
  const stamp=inventoryStamp(scope,row().createdAt,row().pk);
  for(const [patch,status]of [[stamp,'indexed'],[{inventoryOwner:stamp.inventoryOwner},'conflicting']] as const){
    const t=setup();t.read.mockResolvedValue({Item:{...row(),...patch,expiresAt:now/1000+3600}});
    expect((await t.run()).jobs[0]).toMatchObject({indexStatus:status,processingExpired:false});
  }
});
it('continues through empty filtered pages using evaluated counts, not returned count',async()=>{
  const t=setup();t.scan.mockResolvedValueOnce({Items:[],ScannedCount:100,LastEvaluatedKey:{pk:'request#opaque'}});
  const result=await t.run();expect(result.counts.scanned).toBe(101);expect(result.jobs).toHaveLength(1);
  expect(t.send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({pk:'request#opaque'});
});
it('reports truncated traversal instead of success when the evaluated budget is reached',async()=>{
  const t=setup();t.scan.mockResolvedValue({Items:[],ScannedCount:1,LastEvaluatedKey:{pk:'job#'+other}});
  const result=await discoverRetainedLabJobs({...t.deps,maxScanned:1});
  expect(result.coverage).toMatchObject({tableTraversalExhausted:false,hasUnresolvedEnumerationIssues:true,completeAccountExport:false});
  expect(t.scan).toHaveBeenCalledOnce();expect(JSON.stringify(result)).not.toContain(other);
});
it('refuses repeated cursors, invalid counters, invalid keys and duplicate scan rows',async()=>{
  for(const patch of [{ScannedCount:undefined},{ScannedCount:101},{ScannedCount:0},
    {LastEvaluatedKey:{ownerSub:other}},{LastEvaluatedKey:{pk:'job#'+id}}]){
    const t=setup();t.scan.mockResolvedValue({...await t.scan(),...patch} as Awaited<ReturnType<typeof t.scan>>);
    await expect(t.run()).rejects.toThrow();
  }
});
it('fences identity before scan, after scan, after reread and before returning',async()=>{
  for(let call=1;call<=5;call++){
    const t=setup();let count=0;t.revalidate.mockImplementation(async()=>++count===call?{...scope,personId:other}:scope);
    await expect(t.run()).rejects.toThrow();
  }
});
it('does not substitute an empty inventory for an AWS or identity outage',async()=>{
  for(const dependency of ['scan','read','revalidate'] as const){const t=setup();t[dependency].mockRejectedValue(new Error('unavailable'));await expect(t.run()).rejects.toThrow();}
});
