import { expect,it,vi } from 'vitest';
import type {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import type {S3Client} from '@aws-sdk/client-s3';
import {claimLabDeletion,reconcileLabDeletion,sweepLabDeletions,cleanupJobFromObjectKey,LAB_CLEANUP_VERSION} from './lab-deletion-cleanup';
const id='10000000-0000-4000-8000-000000000001',owner='20000000-0000-7000-f000-000000000001';
const scope={ownerSub:owner,organizationId:id,personId:id},now=Date.parse('2026-09-15T20:00:00.000Z');
const prefix=`synthetic-labs/${id}/${owner}/${id}/`;
function setup() {
  let job:Record<string,unknown>|undefined={...scope,pk:'job#'+id,state:'deleting'};
  let ledger:Record<string,unknown>|undefined={...scope,pk:'cleanup#'+id,contractVersion:LAB_CLEANUP_VERSION,
    requestedAt:new Date(now).toISOString(),cleanupPartition:'pending',cleanupDue:new Date(now).toISOString()};
  let objects=[{Key:prefix+'document/source.pdf',VersionId:'version-one'}];
  const db=vi.fn(async(command:{constructor:{name:string};input:Record<string,unknown>})=>{
    const {input}=command;
    if(command.constructor.name==='GetCommand')return {Item:(input.Key as {pk:string}).pk.startsWith('cleanup#')?ledger:job};
    if(command.constructor.name==='DeleteCommand'){expect(String(input.ConditionExpression)).toContain('leaseUntil <= :epoch');job=undefined;return {};}
    if(command.constructor.name==='UpdateCommand'){
      const values=input.ExpressionAttributeValues as Record<string,string>;
      ledger={...ledger,cleanupPartition:'watching',cleanupDue:values[':next'],lastVerifiedAt:values[':now']};return {};
    }
    if(command.constructor.name==='TransactWriteCommand')return {};
    if(command.constructor.name==='QueryCommand')return {Items:[{pk:'cleanup#'+id}]};
    throw new Error('unexpected test command');
  });
  const s3=vi.fn(async(command:{constructor:{name:string};input:Record<string,unknown>})=>{
    if(command.constructor.name==='ListObjectVersionsCommand')return {Versions:objects.filter(row=>row.Key.startsWith(String(command.input.Prefix)))};
    if(command.constructor.name==='DeleteObjectsCommand'){objects=[];return {};}
    throw new Error('unexpected test object command');
  });
  return {db,s3,deps:{db:{send:db} as unknown as DynamoDBDocumentClient,s3:{send:s3} as unknown as S3Client,table:'fictional-table',bucket:'fictional-bucket',now:()=>now},
    get job(){return job;},set job(v){job=v;},get ledger(){return ledger;},set ledger(v){ledger=v;},
    get objects(){return objects;},set objects(v){objects=v;}};
}
it('atomically claims the job and outbox with scope/state/lease checks and no clinical payload or TTL',async()=>{
  const h=setup();await claimLabDeletion(h.deps,scope,id);
  const command=h.db.mock.calls[0][0];
  expect(command.constructor.name).toBe('TransactWriteCommand');
  expect(JSON.stringify(command.input)).toContain('attribute_not_exists(leaseUntil)');
  expect(JSON.stringify(command.input)).toContain('if_not_exists(requestedAt, :now)');
  expect(JSON.stringify(command.input)).not.toMatch(/expiresAt|fileName|biomarkers|result|documents/);
});
it('purges all versions before dropping the clinical row and keeps a minimal late-upload watch',async()=>{
  const h=setup();const result=await reconcileLabDeletion(h.deps,id,scope);
  expect(result?.cleanupStatus).toBe('late_upload_watch');expect(h.job).toBeUndefined();expect(h.objects).toEqual([]);
  expect(h.ledger?.cleanupPartition).toBe('watching');expect(h.ledger?.cleanupDue).toBe('2026-09-15T20:05:00.000Z');
  expect(h.s3.mock.calls.filter(([c])=>c.constructor.name==='ListObjectVersionsCommand')).toHaveLength(3);
  expect(JSON.stringify(h.ledger)).not.toMatch(/fileName|source.pdf|expiresAt/);
});
it('reconciles a late PUT after the job row has already been removed',async()=>{
  const h=setup();await reconcileLabDeletion(h.deps,id,scope);
  h.objects=[{Key:prefix+'document/source.pdf',VersionId:'late-version'}];
  await reconcileLabDeletion(h.deps,id,undefined,prefix+'document/source.pdf');
  expect(h.objects).toEqual([]);expect(h.job).toBeUndefined();
});
it('unknown jobs and ordinary live objects cannot authorize deletion',async()=>{
  const h=setup();h.ledger=undefined;
  expect(await reconcileLabDeletion(h.deps,id,undefined,prefix+'file')).toBeNull();
  expect(h.s3).not.toHaveBeenCalled();expect(h.job).toBeDefined();
});
it.each(['ownerSub','organizationId','personId'])('refuses another request scope %s',async field=>{
  const h=setup();await expect(reconcileLabDeletion(h.deps,id,{...scope,[field]:'30000000-0000-4000-8000-000000000001'})).rejects.toThrow();
  expect(h.s3).not.toHaveBeenCalled();
});
it.each(['queued','extracting','completed'])('does not purge a job that is not deletion-claimed: %s',async state=>{
  const h=setup();h.job!.state=state;await expect(reconcileLabDeletion(h.deps,id)).rejects.toThrow('lab_cleanup_state_conflict');
  expect(h.s3).not.toHaveBeenCalled();
});
it('refuses a changed owner, active lease, corrupt tombstone or unrelated event key',async()=>{
  for(const mutate of [
    (h:ReturnType<typeof setup>)=>{h.job!.ownerSub=id;},
    (h:ReturnType<typeof setup>)=>{h.job!.leaseUntil=now+1;},
    (h:ReturnType<typeof setup>)=>{h.ledger!.unexpectedClinicalPayload='must never be copied';},
  ]){const h=setup();mutate(h);await expect(reconcileLabDeletion(h.deps,id)).rejects.toThrow();expect(h.s3).not.toHaveBeenCalled();}
  const h=setup();await expect(reconcileLabDeletion(h.deps,id,undefined,'synthetic-labs/unrelated/file')).rejects.toThrow();
  expect(h.s3).not.toHaveBeenCalled();
});
it('retains retryable state on partial object-store deletion failure',async()=>{
  const h=setup();h.s3.mockImplementation(async c=>c.constructor.name==='ListObjectVersionsCommand'
    ? {Versions:h.objects} : {Errors:[{Code:'AccessDenied'}]} as never);
  await expect(reconcileLabDeletion(h.deps,id)).rejects.toThrow('lab_cleanup_retry_required');
  expect(h.job).toBeDefined();expect(h.ledger?.cleanupPartition).toBe('pending');
});
it('does not issue deletion for corrupt or cross-prefix version results',async()=>{
  const h=setup();h.s3.mockResolvedValue({Versions:[{Key:'unrelated/object',VersionId:'v'}]});
  await expect(reconcileLabDeletion(h.deps,id)).rejects.toThrow();
  expect(h.s3).toHaveBeenCalledOnce();expect(h.job).toBeDefined();
});
it('queries only the cleanup index and refuses an outage instead of reporting success',async()=>{
  const h=setup();await sweepLabDeletions(h.deps);
  const query=h.db.mock.calls.find(([c])=>c.constructor.name==='QueryCommand')![0];
  expect(query.input).toMatchObject({IndexName:'LabCleanupDue',Limit:20});
  expect(JSON.stringify(h.db.mock.calls)).not.toContain('ScanCommand');
  h.s3.mockRejectedValue(new Error('unavailable'));
  await expect(sweepLabDeletions(h.deps)).rejects.toThrow('lab_cleanup_retry_required');
});
it('continues to the next due page after a failed row and preserves an overall failure signal',async()=>{
  const h=setup(),badId='30000000-0000-4000-8000-000000000001',original=h.db.getMockImplementation()!;
  const cursor={pk:'cleanup#'+badId,cleanupPartition:'pending',cleanupDue:new Date(now).toISOString()};
  let page=0;
  h.db.mockImplementation(async command=>{
    if(command.constructor.name==='QueryCommand'){
      const values=command.input.ExpressionAttributeValues as Record<string,string>;
      if(values[':partition']==='watching')return {Items:[]};
      page++;
      if(page===1)return {Items:[{pk:'cleanup#'+badId}],LastEvaluatedKey:cursor};
      expect(command.input.ExclusiveStartKey).toEqual(cursor);return {Items:[{pk:'cleanup#'+id}]};
    }
    if(command.constructor.name==='GetCommand'&&(command.input.Key as {pk:string}).pk==='cleanup#'+badId)
      return {Item:{...h.ledger,pk:'cleanup#'+badId,unexpected:'invalid record'}};
    return original(command);
  });
  await expect(sweepLabDeletions(h.deps)).rejects.toThrow('lab_cleanup_retry_required');
  expect(page).toBe(2);expect(h.job).toBeUndefined();expect(h.objects).toEqual([]);
});
it('parses only owned source/artifact key shapes without decoding escaped separators',()=>{
  expect(cleanupJobFromObjectKey(prefix+'document/lab%2Fname.pdf')).toBe(id);
  expect(cleanupJobFromObjectKey('synthetic-labs/artifacts/'+id+'/result.json')).toBe(id);
  for(const key of ['unrelated/'+id,'synthetic-labs/artifacts/not-a-job/file',prefix.slice(0,-1),null,'x'.repeat(1025)])
    expect(cleanupJobFromObjectKey(key)).toBeNull();
});
