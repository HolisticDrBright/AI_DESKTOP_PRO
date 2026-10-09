import {describe,it,expect,vi} from 'vitest';
import type {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {readFileSync} from 'node:fs';
import {inventoryStamp,listLabInventory} from './lab-job-inventory';
import {planInventoryMigration,applyInventoryMigration,validateInventoryMigrationPlan,inventoryMigrationHash,type MigrationMetadata} from './lab-inventory-migration';
const id='10000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
const now=Date.parse('2026-09-15T12:00:00.000Z'),table='ai-clinical-core-synthetic-staging-lab-analysis-LabJobTable-EXAMPLE';
const config={account:'588966314750' as const,region:'us-east-2' as const,table,pool:'us-east-2_Example',sourceCommit:'a'.repeat(40)};
const row=():MigrationMetadata=>({pk:'job#'+id,ownerSub:id,organizationId:id,personId:id,createdAt:'2026-09-15T10:00:00.000Z',updatedAt:'2026-09-15T10:01:00.000Z',
  expiresAt:Math.floor(now/1000)+3600,state:'awaiting_upload',progressPercent:0});
function setup(rows:Record<string,unknown>[]=[row()]){
  const records=new Map(rows.map(row=>[row.pk,row])),owner=vi.fn(async(sub:string)=>({ownerSub:sub,organizationId:id,personId:id,enabled:true,syntheticAttested:true}));
  const send=vi.fn(async(command:{constructor:{name:string};input:Record<string,unknown>}):Promise<Record<string,unknown>>=>{
    if(command.constructor.name==='ScanCommand')return {Items:rows};
    const key=(command.input.Key as {pk:string}).pk;
    if(command.constructor.name==='GetCommand')return {Item:records.get(key)};
    if(command.constructor.name==='UpdateCommand'){
      const current=records.get(key)!;records.set(key,{...current,...inventoryStamp(current as MigrationMetadata,String(current.createdAt),key)});return {};
    }
    throw new Error('unexpected command');
  });
  const deps={db:{send} as unknown as DynamoDBDocumentClient,table,owner,now:()=>now};
  return {send,records,owner,deps,plan:()=>planInventoryMigration(deps,config)};
}
describe('reviewed legacy lab inventory migration',()=>{
  it('plans metadata only, preserving all fields and deriving only two index keys',async()=>{
    const t=setup(),plan=await t.plan();expect(plan.entries).toEqual([row()]);expect(plan.inspected).toBe(1);
    expect(t.send.mock.calls[0][0].input).toMatchObject({ConsistentRead:true,Limit:100,FilterExpression:'begins_with(#f0, :job)'});
    const projection=JSON.stringify(t.send.mock.calls[0][0].input);
    for(const forbidden of ['result','documents','structuredBiomarkers','patientContext','fileName','sourcePanel'])expect(projection).not.toContain(forbidden);
    expect(t.send.mock.calls.map(c=>c[0].constructor.name)).toEqual(['ScanCommand']);
    expect(await applyInventoryMigration(t.deps,plan)).toEqual({indexed:1,alreadyIndexed:0,conflicts:0,unverifiedOwner:0,expiredOrMissing:0});
    expect(t.records.get('job#'+id)).toEqual({...row(),...inventoryStamp(row(),row().createdAt,'job#'+id)});
    const update=t.send.mock.calls.find(c=>c[0].constructor.name==='UpdateCommand')![0].input;
    expect(update.UpdateExpression).toBe('SET #f9 = :owner, #f10 = :order');
    expect(update.ConditionExpression).toContain('attribute_not_exists(#f9) AND attribute_not_exists(#f10)');
    for(let i=0;i<9;i++)expect(update.ConditionExpression).toContain('#f'+i+' = :v'+i);
  });
  it('replays a partially applied plan without overwriting indexed records',async()=>{
    const t=setup(),plan=await t.plan();await applyInventoryMigration(t.deps,plan);
    expect((await applyInventoryMigration(t.deps,plan)).alreadyIndexed).toBe(1);
    expect(t.send.mock.calls.filter(c=>c[0].constructor.name==='UpdateCommand')).toHaveLength(1);
  });
  it.each(['ownerSub','organizationId','personId'])('never infers or changes missing/malformed %s',async field=>{
    const t=setup([{...row(),[field]:'not-an-identity'}]);
    expect((await t.plan()).skipped).toEqual({invalid_or_deleting:1});expect(t.owner).not.toHaveBeenCalled();
  });
  it.each(['ownerSub','organizationId','personId','enabled','syntheticAttested'])('requires current verified owner %s',async field=>{
    const t=setup();t.owner.mockResolvedValue({...await t.owner(id),[field]:['enabled','syntheticAttested'].includes(field)?false:other});
    expect((await t.plan()).skipped).toEqual({unverified_owner:1});expect(t.send).toHaveBeenCalledTimes(1);
  });
  it.each(['ownerSub','organizationId','personId','enabled','syntheticAttested'])('rechecks owner %s at apply',async field=>{
    const t=setup(),plan=await t.plan();t.owner.mockResolvedValue({...await t.owner(id),[field]:['enabled','syntheticAttested'].includes(field)?false:other});
    expect((await applyInventoryMigration(t.deps,plan)).unverifiedOwner).toBe(1);
    expect(t.send.mock.calls.some(c=>c[0].constructor.name==='UpdateCommand')).toBe(false);
  });
  it('skips expired, deleting, already-indexed, conflicting and invalid-time rows',async()=>{
    const base=row(),stamp=inventoryStamp(base,base.createdAt,base.pk);
    for(const [patch,reason]of [
      [{expiresAt:1},'expired'],[{state:'deleting'},'invalid_or_deleting'],[stamp,'already_indexed'],
      [{inventoryOwner:stamp.inventoryOwner},'index_conflict'],[{inventoryOwner:'wrong',inventoryOrder:'wrong'},'index_conflict'],
      [{updatedAt:'2027-01-01T00:00:00.000Z'},'invalid_time'],[{updatedAt:'2020-01-01T00:00:00.000Z'},'invalid_time'],
    ] as [Record<string,unknown>,string][]){
      const t=setup([{...base,...patch}]),plan=await t.plan();expect(plan.entries).toEqual([]);expect(plan.skipped).toEqual({[reason]:1});
    }
  });
  it.each(['ownerSub','organizationId','personId','createdAt','updatedAt','state','progressPercent','expiresAt'])('does not index a row changed after review: %s',async field=>{
    const t=setup(),plan=await t.plan();
    const value=field.endsWith('At')?field==='expiresAt'?row().expiresAt+1:'2026-09-15T11:00:00.000Z':field==='state'?'completed':field==='progressPercent'?100:other;
    t.records.set('job#'+id,{...row(),[field]:value});
    expect((await applyInventoryMigration(t.deps,plan)).conflicts).toBe(1);
    expect(t.send.mock.calls.some(c=>c[0].constructor.name==='UpdateCommand')).toBe(false);
  });
  it('refuses deletion and expiry races and never recreates a missing row',async()=>{
    for(const replacement of [undefined,{...row(),state:'deleting'},{...row(),expiresAt:1}]){
      const t=setup(),plan=await t.plan();if(replacement)t.records.set('job#'+id,replacement);else t.records.delete('job#'+id);
      const result=await applyInventoryMigration(t.deps,plan);expect(result.indexed).toBe(0);
      expect(t.send.mock.calls.some(c=>c[0].constructor.name==='UpdateCommand')).toBe(false);
    }
  });
  it('counts conditional conflicts and fails closed on uncertain writes without leaking SDK details',async()=>{
    for(const name of ['ConditionalCheckFailedException','TimeoutError']){
      const t=setup(),plan=await t.plan(),original=t.send.getMockImplementation()!;
      t.send.mockImplementation(async command=>{if(command.constructor.name==='UpdateCommand')throw Object.assign(new Error('private error details'),{name});return original(command);});
      if(name==='ConditionalCheckFailedException')expect((await applyInventoryMigration(t.deps,plan)).conflicts).toBe(1);
      else await expect(applyInventoryMigration(t.deps,plan)).rejects.toThrow('migration_update_unconfirmed_rerun_review');
    }
  });
  it('paginates bounded metadata scans without silently losing empty pages',async()=>{
    const t=setup();
    t.send.mockResolvedValueOnce({Items:[],LastEvaluatedKey:{pk:'request#opaque'}}).mockResolvedValueOnce({Items:[row()]});
    expect((await t.plan()).entries).toHaveLength(1);
    expect(t.send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({pk:'request#opaque'});
  });
  it('fails on looping scan cursors and duplicate job IDs instead of producing partial success',async()=>{
    const t=setup();t.send.mockResolvedValue({Items:[],LastEvaluatedKey:{pk:'job#'+id}});
    await expect(t.plan()).rejects.toThrow('migration_cursor_invalid');
    await expect(setup([row(),row()]).plan()).rejects.toThrow('migration_duplicate_scan_row');
  });
  it('does not turn scan or identity lookup failure into empty success',async()=>{
    const t=setup();t.send.mockRejectedValue(new Error('unavailable'));await expect(t.plan()).rejects.toThrow('unavailable');
    const u=setup();u.owner.mockRejectedValue(new Error('unavailable'));await expect(u.plan()).rejects.toThrow('unavailable');
  });
  it('rejects forged counts, duplicate IDs, clinical extras, wrong target and stale/future plans',async()=>{
    const t=setup(),plan=await t.plan();
    for(const patch of [
      {account:'173535830222'},{region:'us-east-1'},{table:'other'},{inspected:99},{entries:[row(),row()],inspected:2},
      {entries:[{...row(),result:{private:'forbidden'}}]},{plannedAt:'2027-01-01T00:00:00.000Z'},
      {plannedAt:'2020-01-01T00:00:00.000Z'},{entries:[{...row(),createdAt:'2026-09-15T12:01:00.000Z'}]},
    ])expect(()=>validateInventoryMigrationPlan({...plan,...patch},now)).toThrow();
    await expect(applyInventoryMigration({...t.deps,table:table+'OTHER'},plan)).rejects.toThrow('target_mismatch');
  });
  it('uses exact file bytes for the reviewed plan hash',()=>{
    expect(inventoryMigrationHash('{"a":1}')).not.toBe(inventoryMigrationHash('{"a":1}\n'));
    expect(inventoryMigrationHash('{"a":1}')).toMatch(/^[a-f0-9]{64}$/);
  });
  it('can limit fixture migration to an exact reviewed ID and refuses extra jobs',async()=>{
    const t=setup(),plan=await planInventoryMigration(t.deps,{...config,selectedJob:id});
    expect(plan.selectedJob).toBe(id);
    expect(t.send.mock.calls[0][0].input).toMatchObject({FilterExpression:'begins_with(#f0, :job) AND #f0 = :selected',
      ExpressionAttributeValues:{':job':'job#',':selected':'job#'+id}});
    expect(()=>validateInventoryMigrationPlan({...plan,selectedJob:other},now)).toThrow();
  });
  it('migrated index still requires fresh row ownership and expiry in normal inventory reads',async()=>{
    const t=setup(),plan=await t.plan();await applyInventoryMigration(t.deps,plan);
    const migrated=t.records.get('job#'+id)!;
    const key={pk:migrated.pk,inventoryOwner:migrated.inventoryOwner,inventoryOrder:migrated.inventoryOrder};
    const send=vi.fn(async command=>command.constructor.name==='QueryCommand'?{Items:[key]}:{Item:{...migrated,ownerSub:other}});
    const page=await listLabInventory({send} as unknown as DynamoDBDocumentClient,table,row());
    expect(page.jobs).toEqual([]);
  });
  it('keeps scanning an offline operator capability, not a runtime permission or route',()=>{
    const template=readFileSync('infra/aws-clinical-core/lab-analysis-extension.json','utf8');
    expect(template).not.toContain('dynamodb:Scan');
    const api=readFileSync('src/server/clinical-core/aws-lab-analysis-api.ts','utf8');
    expect(api).not.toContain('lab-inventory-migration');expect(api).not.toContain('ScanCommand');
    const cli=readFileSync('scripts/migrate-lab-inventory.mjs','utf8');
    for(const guard of ['--approved-sha256','--confirm-synthetic-only','--source','committed_source_required','wrong_aws_account','synthetic_posture_not_verified'])expect(cli).toContain(guard);
    const hosted=readFileSync('scripts/test-aws-lab-recovery-hosted.ps1','utf8');
    expect(hosted).toContain('$changed=$requestBody.Clone()');
    expect(hosted).toContain('$changed.documents=@($requestBody.documents|ForEach-Object {$_.Clone()})');
    expect(hosted).not.toContain('$changed=($requestBody|ConvertTo-Json');
  });
});
