import {describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createRecordingCleanupQueue,createRecordingCleanupRunner,type RecordingCleanupQueue} from './recording-cleanup-queue';
import {RecordingCleanupError} from './recording-cleanup-authority';
import type {createRecordingCleanupWorker} from './recording-cleanup-worker';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import type {ClinicalCoreDatabase} from './database';
const context:ProductionClinicalRequestContext={actorPersonId:randomUUID(),organizationId:randomUUID(),identityPool:'workforce',identitySubject:'fictional-subject',
  purpose:'consent_management',environment:'production-clinical',dataClassification:'clinical_phi',productionBound:true,containsPhi:true,realPatientData:true};
const request={recordingId:randomUUID(),version:2,cleanupReleaseId:randomUUID(),workerSha256:'a'.repeat(64)};
function fixture(){
  const runId=randomUUID();
  const queue:RecordingCleanupQueue={claim:vi.fn(async()=>({runId,recordingId:request.recordingId,version:2,claimed:true,leaseUntil:new Date(Date.now()+300000).toISOString()})),
    finish:vi.fn<RecordingCleanupQueue['finish']>(async(_c,id,recordingId,outcome)=>({runId:id,recordingId,outcome,appliedToSchedule:true,nextCheckAt:new Date(Date.now()+3600000).toISOString(),audioDeleted:false,requiresRecheck:true})),
    list:vi.fn(async()=>({items:[],nextAfter:null}))};
  const worker=vi.fn<ReturnType<typeof createRecordingCleanupWorker>>(async()=>({state:'empty_observed',deleteAcknowledged:0,audioDeleted:false,requiresRecheck:true}));
  return {runId,queue,worker,run:()=>createRecordingCleanupRunner(queue,worker)(context,request,runId)};
}
describe('durable recording cleanup runner',()=>{
  it('claims before work, propagates the run fence and persists a recheck rather than completion',async()=>{
    const f=fixture();const result=await f.run();
    expect(f.worker).toHaveBeenCalledWith(context,{...request,runId:f.runId});
    expect(result).toMatchObject({outcome:'empty_observed',audioDeleted:false,requiresRecheck:true});
    expect(f.queue.finish).toHaveBeenCalledWith(context,f.runId,request.recordingId,'empty_observed',0,expect.stringMatching(/^[a-f0-9]{64}$/));
  });
  it('never executes storage or rewrites results for a replayed claim',async()=>{
    const f=fixture();vi.mocked(f.queue.claim).mockResolvedValue({runId:f.runId,recordingId:request.recordingId,version:2,claimed:false,leaseUntil:new Date().toISOString()});
    expect(await f.run()).toMatchObject({state:'already_claimed'});expect(f.worker).not.toHaveBeenCalled();expect(f.queue.finish).not.toHaveBeenCalled();
  });
  it('does not start if claiming fails or the returned lease is already expired',async()=>{
    const f=fixture();vi.mocked(f.queue.claim).mockRejectedValueOnce(new RecordingCleanupError('not_ready'));
    await expect(f.run()).rejects.toThrow('not_ready');expect(f.worker).not.toHaveBeenCalled();
    vi.mocked(f.queue.claim).mockResolvedValue({runId:f.runId,recordingId:request.recordingId,version:2,claimed:true,leaseUntil:new Date(0).toISOString()});
    expect(await f.run()).toMatchObject({outcome:'unavailable'});expect(f.worker).not.toHaveBeenCalled();
  });
  it.each([['legal_hold','held'],['access_refused','refused'],['service_unavailable','unavailable']] as const)(
    'persists %s with unknown rather than invented zero deletion count',async(code,outcome)=>{
      const f=fixture();vi.mocked(f.worker).mockRejectedValueOnce(new RecordingCleanupError(code));
      expect(await f.run()).toMatchObject({outcome});expect(f.queue.finish).toHaveBeenCalledWith(context,f.runId,request.recordingId,outcome,null,expect.any(String));
    });
  it('does not accept an unverified erasure claim from a worker result',async()=>{
    const f=fixture();vi.mocked(f.worker).mockResolvedValue({state:'empty_observed',deleteAcknowledged:0,audioDeleted:true,requiresRecheck:false} as never);
    expect(await f.run()).toMatchObject({outcome:'unavailable',audioDeleted:false,requiresRecheck:true});
  });
  it('keeps result-write failure visible; it does not rerun remote work',async()=>{
    const f=fixture();vi.mocked(f.queue.finish).mockRejectedValue(new Error('FICTIONAL LOST WRITE'));
    await expect(f.run()).rejects.toThrow('FICTIONAL LOST WRITE');expect(f.worker).toHaveBeenCalledOnce();expect(f.queue.claim).toHaveBeenCalledOnce();
  });
});
function databaseResponse(data:unknown){
  const calls:string[]=[];const db:ClinicalCoreDatabase={transaction:async work=>work({query:async<Row extends Record<string,unknown>>(sql:string)=>{
    calls.push(sql);return {rows:sql.includes(' as data')?[{data:JSON.stringify(data)} as unknown as Row]:[]};
  }})};return {db,calls};
}
describe('cleanup queue repository receipt and scope validation',()=>{
  it('bounds lock/statement waits and rejects claims for the wrong recording',async()=>{
    const runId=randomUUID(),f=databaseResponse({runId,recordingId:randomUUID(),version:2,claimed:true,leaseUntil:new Date(Date.now()+300000).toISOString()});
    await expect(createRecordingCleanupQueue(f.db).claim(context,request,runId)).rejects.toThrow('service_unavailable');
    expect(f.calls.slice(0,2)).toEqual(["set local lock_timeout='2s'","set local statement_timeout='10s'"]);
  });
  it('refuses consumer context before querying the queue',async()=>{
    const f=databaseResponse([]);await expect(createRecordingCleanupQueue(f.db).list({...context,identityPool:'consumer'})).rejects.toThrow('access_refused');expect(f.calls).toEqual([]);
  });
  it('rejects an invalid pagination cursor before database work',async()=>{
    const f=databaseResponse([]);await expect(createRecordingCleanupQueue(f.db).list(context,'bad')).rejects.toThrow('request_invalid');expect(f.calls).toEqual([]);
  });
  it('does not replace malformed queue data with an empty list',async()=>{
    const f=databaseResponse([{recordingId:request.recordingId,audioDeleted:true}]);await expect(createRecordingCleanupQueue(f.db).list(context)).rejects.toThrow('service_unavailable');
  });
});
