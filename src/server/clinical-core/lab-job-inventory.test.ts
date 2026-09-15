import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import type {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {inventoryStamp,labRecoveryDescriptor,listLabInventory} from './lab-job-inventory';
const id='10000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000001';
const scope={ownerSub:id,organizationId:id,personId:id},date='2026-01-01T00:00:00.000Z';
const row=()=>({...scope,pk:'job#'+id,createdAt:date,expiresAt:Math.floor(Date.now()/1000)+3600,state:'completed',progressPercent:100,
  panelId:id,structuredBiomarkers:[{secret:'never disclose'}],result:{secret:'never disclose'},
  recoveryRequest:{id,createdAt:date,kind:'saved'},documents:[]});
const key=()=>({pk:'job#'+id,...inventoryStamp(scope,date,'job#'+id)});
function setup(item:Record<string,unknown>|undefined=row()){
  const send=vi.fn(async (c:{constructor:{name:string};input:Record<string,unknown>}):Promise<{Items?:ReturnType<typeof key>[];LastEvaluatedKey?:ReturnType<typeof key>;Item?:Record<string,unknown>}>=>c.constructor.name==='QueryCommand'?{Items:[key()],LastEvaluatedKey:key()}:{Item:item});
  return {send,db:{send} as unknown as DynamoDBDocumentClient};
}
it('queries the caller partition and checks the current row before disclosure or paging',async()=>{
  const t=setup();const page=await listLabInventory(t.db,'table',scope);
  expect(t.send.mock.calls[0][0].input).toMatchObject({IndexName:'LabOwnerInventory',Limit:20,ScanIndexForward:false,
    KeyConditionExpression:'inventoryOwner = :owner',ExpressionAttributeValues:{':owner':key().inventoryOwner}});
  expect(t.send.mock.calls[1][0].input).toMatchObject({ConsistentRead:true,Key:{pk:'job#'+id}});
  expect(page.jobs).toHaveLength(1);expect(JSON.stringify(page)).not.toContain('never disclose');
  await listLabInventory(t.db,'table',scope,page.nextCursor!);
  expect(t.send.mock.calls[2][0].input.ExclusiveStartKey).toEqual(key());
});
it.each(['ownerSub','organizationId','personId'])('stale index cannot disclose changed %s',async field=>{
  const t=setup({...row(),[field]:other});
  expect((await listLabInventory(t.db,'table',scope)).jobs).toEqual([]);
});
it.each([undefined,{...row(),state:'deleting'},{...row(),expiresAt:1}])('filters missing, deleting or expired rows without losing pagination',async value=>{
  const t=setup();t.send.mockImplementation(async c=>c.constructor.name==='QueryCommand'?{Items:[key()],LastEvaluatedKey:key()}:{Item:value});
  const page=await listLabInventory(t.db,'table',scope);
  expect(page.jobs).toEqual([]);expect(page.nextCursor).not.toBeNull();
});
it('refuses malformed and cross-account cursors before querying',async()=>{
  const t=setup();
  for(const cursor of ['bad!','a'.repeat(601),Buffer.from(JSON.stringify({...key(),inventoryOwner:'another-owner'})).toString('base64url'),
    Buffer.from(JSON.stringify({...key(),pk:'request#not-a-job'})).toString('base64url')]){
    await expect(listLabInventory(t.db,'table',scope,cursor)).rejects.toThrow();
  }
  expect(t.send).not.toHaveBeenCalled();
});
it('returns only a checksum manifest and refuses resumability without verified document identity',()=>{
  const document={clientDocumentId:id,checksumSHA256:'A'.repeat(43)+'=',byteSize:100,contentType:'application/pdf',fileName:'private.pdf',objectKey:'private-key'};
  const job={...row(),structuredBiomarkers:undefined,state:'awaiting_upload',recoveryRequest:{id,createdAt:date,kind:'documents'},documents:[document]};
  const value=labRecoveryDescriptor(job,scope)!;
  expect(value.canResume).toBe(true);expect(JSON.stringify(value)).not.toContain('private');
  expect(labRecoveryDescriptor({...job,documents:[{...document,checksumSHA256:undefined}]},scope)?.canResume).toBe(false);
});
it('refuses malformed stored request metadata and unsupported legacy saved requests',()=>{
  expect(()=>labRecoveryDescriptor({...row(),recoveryRequest:{id,createdAt:date,kind:'documents'}},scope)).toThrow();
  expect(labRecoveryDescriptor({...row(),recoveryRequest:undefined},scope)?.canResume).toBe(false);
});
it('does not replace an AWS outage with an empty success or a scan',async()=>{
  const t=setup();t.send.mockRejectedValue(new Error('unavailable'));
  await expect(listLabInventory(t.db,'table',scope)).rejects.toThrow('unavailable');
  expect(t.send).toHaveBeenCalledOnce();
});
it('deploys a key-only index and four authorized routes without scan permission',()=>{
  const template=JSON.parse(readFileSync('infra/aws-clinical-core/lab-analysis-extension.json','utf8'));
  expect(template.Resources.LabJobTable.Properties.GlobalSecondaryIndexes[0].Projection).toEqual({ProjectionType:'KEYS_ONLY'});
  const policy=template.Resources.LabInventoryQueryPolicy.Properties.PolicyDocument.Statement[0];
  expect(policy.Action).toEqual(['dynamodb:Query']);expect(JSON.stringify(policy.Resource)).toContain('/index/LabOwnerInventory');
  for(const name of ['LabInventoryConsumerRoute','LabInventorySyntheticRoute','LabRecoveryConsumerRoute','LabRecoverySyntheticRoute']){
    expect(['JWT','CUSTOM']).toContain(template.Resources[name].Properties.AuthorizationType);
  }
  expect(JSON.stringify(template)).not.toContain('dynamodb:Scan');
});
