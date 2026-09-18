import {describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createRecordingCleanupWorker,type CleanupInspection,type CleanupObjectVersion,type RecordingCleanupStore} from './recording-cleanup-worker';
import {RecordingCleanupError,type RecordingCleanupAdmission,type createRecordingCleanupAuthority} from './recording-cleanup-authority';
import type {CleanupPrepared,RecordingCleanupAttempts} from './recording-cleanup-attempts';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
function fixture(count=1){
  const context:ProductionClinicalRequestContext={actorPersonId:randomUUID(),organizationId:randomUUID(),identityPool:'workforce',identitySubject:'fictional-subject',
    purpose:'consent_management',environment:'production-clinical',dataClassification:'clinical_phi',productionBound:true,containsPhi:true,realPatientData:true};
  const request={recordingId:randomUUID(),version:2,cleanupReleaseId:randomUUID(),workerSha256:'a'.repeat(64)};
  const sessionId=randomUUID(),storageReleaseId=randomUUID(),key=`encounter-recordings/${context.organizationId}/${request.recordingId}/${sessionId}/0-${'b'.repeat(64)}`;
  const a:RecordingCleanupAdmission={...request,sessionId,organizationId:context.organizationId,patientRecordId:randomUUID(),storageReleaseId,
    storage:{bucket:'fictional-bucket',expectedBucketOwner:'123456789012',region:'us-east-2',kmsKeyArn:'arn:aws:kms:us-east-2:123456789012:key/11111111-1111-4111-8111-111111111111',maxSegmentBytes:10000},
    inventory:[{segmentId:randomUUID(),sequence:0,sha256:'b'.repeat(64),bytes:3,status:'reserved',objectKey:key,objectVersion:null,storageReleaseId,
      authorityEpoch:1,participantIds:[randomUUID()],recordingGrantIds:[randomUUID()]}],inventorySha256:'c'.repeat(64),validUntil:new Date(Date.now()+5000).toISOString(),audioDeleted:false};
  let versions:CleanupObjectVersion[]=Array.from({length:count},(_,i)=>({key,version:'version-'+i,kind:'object'}));
  let held=false;const prepared=new Map<string,CleanupPrepared>(),events:{id:string;outcome:string}[]=[];
  const authorize:ReturnType<typeof createRecordingCleanupAuthority>=async(_ctx,r,operation)=>{
    if(held)throw new RecordingCleanupError('legal_hold');
    const id=(r as {attemptId?:string}).attemptId,attempt=id?prepared.get(id):undefined;
    if(id&&!attempt)throw new Error('prepare must commit first');
    return operation({...a,attempt:attempt?{id:attempt.id,segmentId:attempt.segmentId,objectVersion:attempt.objectVersion,kind:attempt.kind,evidenceSha256:attempt.evidenceSha256}:undefined},new AbortController().signal);
  };
  const attempts:RecordingCleanupAttempts={prepare:vi.fn(async(_ctx,_r,attempt)=>{prepared.set(attempt.id,attempt);return attempt.id;}),
    record:vi.fn(async(_ctx,id,outcome)=>{events.push({id,outcome});})};
  const head=(v:CleanupObjectVersion):CleanupInspection=>({version:v.version,bytes:3,checksum:Buffer.from('b'.repeat(64),'hex').toString('base64'),
    checksumType:'FULL_OBJECT',encryption:'aws:kms',kmsKeyArn:a.storage.kmsKeyArn,metadata:{'segment-id':a.inventory[0].segmentId,
      'recording-id':a.recordingId,'session-id':a.sessionId,'authority-epoch':'1'},legalHold:'OFF',retentionVerified:true});
  const storage:RecordingCleanupStore={list:vi.fn(async()=>({versions:[...versions],truncated:false})),inspect:vi.fn(async(_a,v)=>head(v)),
    remove:vi.fn(async(admission,v)=>{expect(prepared.has(admission.attempt!.id)).toBe(true);versions=versions.filter(x=>x.version!==v.version);return {version:v.version,deleteMarker:v.kind==='delete_marker'};})};
  const worker=()=>createRecordingCleanupWorker({authorize,attempts,storage})(context,request);
  return {context,request,a,storage,attempts,prepared,events,worker,head,setHeld:(v:boolean)=>{held=v;},setVersions:(v:CleanupObjectVersion[])=>{versions=v;}};
}
describe('recording cleanup worker: exact-version mutations and honest observations',()=>{
  it('prepares each version before deletion, logs acknowledgments, and keeps later empty scans provisional',async()=>{
    const f=fixture(2);expect(await f.worker()).toEqual({state:'needs_recheck',deleteAcknowledged:2,audioDeleted:false,requiresRecheck:true});
    expect(f.prepared.size).toBe(2);expect(f.events.map(e=>e.outcome)).toEqual(['delete_acknowledged','delete_acknowledged']);
    expect(await f.worker()).toMatchObject({state:'empty_observed',audioDeleted:false,requiresRecheck:true});
    expect(f.storage.remove).toHaveBeenCalledTimes(2);
  });
  it('bounds a pass to25 versions and restarts at a fresh first page',async()=>{
    const f=fixture(27);expect((await f.worker()).deleteAcknowledged).toBe(25);expect((await f.worker()).deleteAcknowledged).toBe(2);
    expect((await f.worker()).state).toBe('empty_observed');expect(f.prepared.size).toBe(27);
  });
  it.each(['foreign-key','null-version','duplicate','empty-truncated'])('refuses %s inventory before any mutation',async mode=>{
    const f=fixture(),v={key:f.a.inventory[0].objectKey,version:'version-0',kind:'object' as const};
    if(mode==='foreign-key')f.setVersions([{...v,key:v.key+'-unknown'}]);
    if(mode==='null-version')f.setVersions([{...v,version:'null'}]);
    if(mode==='duplicate')f.setVersions([v,v]);
    if(mode==='empty-truncated')f.storage.list=vi.fn(async()=>({versions:[],truncated:true}));
    await expect(f.worker()).rejects.toThrow();expect(f.attempts.prepare).not.toHaveBeenCalled();expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it.each(['checksum','kmsKeyArn','bytes','metadata','legalHold','retentionVerified','retainUntil'])('refuses unverified/held %s',async field=>{
    const f=fixture();f.storage.inspect=vi.fn(async(_a,v)=>({...f.head(v),[field]:field==='bytes'?4:field==='metadata'?{}:field==='legalHold'?'ON':field==='retentionVerified'?false:field==='retainUntil'?new Date(Date.now()+60000).toISOString():'wrong'}));
    await expect(f.worker()).rejects.toThrow();expect(f.storage.remove).not.toHaveBeenCalled();expect(f.prepared.size).toBe(0);
  });
  it('rechecks database holds after preparing the durable attempt',async()=>{
    const f=fixture(),prepare=f.attempts.prepare;f.attempts.prepare=async(...args)=>{const id=await prepare(...args);f.setHeld(true);return id;};
    expect(await f.worker()).toMatchObject({state:'needs_recheck',deleteAcknowledged:0});expect(f.storage.remove).not.toHaveBeenCalled();
    expect(f.prepared.size).toBe(1);expect(f.events[0].outcome).toBe('retained');
  });
  it('rechecks storage holds immediately before mutation',async()=>{
    const f=fixture();let n=0;f.storage.inspect=async(_a,v)=>({...f.head(v),legalHold:++n===1?'OFF':'ON'});
    expect((await f.worker()).deleteAcknowledged).toBe(0);expect(f.storage.remove).not.toHaveBeenCalled();expect(f.events[0].outcome).toBe('retained');
  });
  it('never deletes when intent persistence fails',async()=>{
    const f=fixture();f.attempts.prepare=vi.fn(async()=>{throw new Error('FICTIONAL STORAGE UNAVAILABLE');});
    await expect(f.worker()).rejects.toThrow();expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it('preserves a durable uncertain attempt when deletion times out or returns the wrong version',async()=>{
    for(const failure of ['timeout','wrong-version']){
      const f=fixture();f.storage.remove=vi.fn(async()=>{if(failure==='timeout')throw new Error('FICTIONAL TIMEOUT');return {version:'other'};});
      expect((await f.worker()).deleteAcknowledged).toBe(0);expect(f.prepared.size).toBe(1);expect(f.events[0].outcome).toBe('unknown');
    }
  });
  it('does not hide an outcome-write failure after a remote acknowledgment',async()=>{
    const f=fixture();f.attempts.record=vi.fn(async()=>{throw new Error('FICTIONAL EVENT WRITE LOST');});
    await expect(f.worker()).rejects.toThrow();expect(f.prepared.size).toBe(1);expect(f.events).toEqual([]);
  });
  it('re-lists delete markers, deletes only their exact versions, and never performs HEAD on a marker',async()=>{
    const f=fixture();f.setVersions([{key:f.a.inventory[0].objectKey,version:'marker-1',kind:'delete_marker'}]);
    expect((await f.worker()).deleteAcknowledged).toBe(1);expect(f.storage.inspect).not.toHaveBeenCalled();expect(f.storage.list).toHaveBeenCalledTimes(3);
  });
});
