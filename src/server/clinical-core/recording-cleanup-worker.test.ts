import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createRecordingCleanupWorker,type CleanupInspection,type CleanupObjectVersion,type RecordingCleanupStore} from './recording-cleanup-worker';
import {RecordingCleanupError,type RecordingCleanupAdmission,type createRecordingCleanupAuthority} from './recording-cleanup-authority';
import type {CleanupPrepared,RecordingCleanupAttempts} from './recording-cleanup-attempts';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
function fixture(count=1){
  const context:ProductionClinicalRequestContext={actorPersonId:randomUUID(),organizationId:randomUUID(),identityPool:'workforce',identitySubject:'fictional-subject',
    purpose:'consent_management',environment:'production-clinical',dataClassification:'clinical_phi',productionBound:true,containsPhi:true,realPatientData:true};
  const request={recordingId:randomUUID(),version:2,cleanupReleaseId:randomUUID(),workerSha256:'a'.repeat(64),runId:randomUUID()};
  const sessionId=randomUUID(),storageReleaseId=randomUUID(),key=`encounter-recordings/${context.organizationId}/${request.recordingId}/${sessionId}/0-${'b'.repeat(64)}`;
  const a:RecordingCleanupAdmission={...request,sessionId,organizationId:context.organizationId,patientRecordId:randomUUID(),storageReleaseId,
    storage:{bucket:'fictional-bucket',expectedBucketOwner:'123456789012',region:'us-east-2',kmsKeyArn:'arn:aws:kms:us-east-2:123456789012:key/11111111-1111-4111-8111-111111111111',maxSegmentBytes:10000},
    inventory:[{segmentId:randomUUID(),sequence:0,sha256:'b'.repeat(64),bytes:3,status:'reserved',objectKey:key,objectVersion:null,storageReleaseId,
      authorityEpoch:1,participantIds:[randomUUID()],recordingGrantIds:[randomUUID()]}],inventorySha256:'c'.repeat(64),
    transcriptionInventory:[],transcriptionInventorySha256:'e'.repeat(64),scope:'recording',audioActionable:true,validUntil:new Date(Date.now()+5000).toISOString(),audioDeleted:false};
  let versions:CleanupObjectVersion[]=Array.from({length:count},(_,i)=>({key,version:'version-'+i,kind:'object'}));
  let held=false;const prepared=new Map<string,CleanupPrepared>(),events:{id:string;outcome:string}[]=[];
  const authorize:ReturnType<typeof createRecordingCleanupAuthority>=async(_ctx,r,operation)=>{
    if(held)throw new RecordingCleanupError('legal_hold');
    const id=(r as {attemptId?:string}).attemptId,attempt=id?prepared.get(id):undefined;
    if(id&&!attempt)throw new Error('prepare must commit first');
    return operation({...a,attempt:attempt?{id:attempt.id,segmentId:attempt.segmentId,artifactId:attempt.artifactId,objectVersion:attempt.objectVersion,kind:attempt.kind,evidenceSha256:attempt.evidenceSha256}:undefined},new AbortController().signal);
  };
  const attempts:RecordingCleanupAttempts={prepare:vi.fn(async(_ctx,_r,attempt)=>{prepared.set(attempt.id,attempt);return attempt.id;}),
    record:vi.fn(async(_ctx,id,outcome)=>{events.push({id,outcome});})};
  const head=(v:CleanupObjectVersion):CleanupInspection=>({version:v.version,bytes:3,checksum:Buffer.from('b'.repeat(64),'hex').toString('base64'),
    checksumType:'FULL_OBJECT',encryption:'aws:kms',kmsKeyArn:a.storage.kmsKeyArn,metadata:{'segment-id':a.inventory[0].segmentId,
      'recording-id':a.recordingId,'session-id':a.sessionId,'authority-epoch':'1'},legalHold:'OFF',retentionVerified:true});
  const storage:RecordingCleanupStore={list:vi.fn(async()=>({versions:[...versions],truncated:false})),inspect:vi.fn(async(_a,v)=>head(v)),
    remove:vi.fn(async(admission,v)=>{expect(prepared.has(admission.attempt!.id)).toBe(true);versions=versions.filter(x=>x.version!==v.version);return {version:v.version,deleteMarker:v.kind==='delete_marker'};})};
  const worker=(maximumMs?:number)=>createRecordingCleanupWorker({authorize,attempts,storage,maximumMs})(context,request);
  return {context,request,a,storage,attempts,prepared,events,worker,head,setHeld:(v:boolean)=>{held=v;},setVersions:(v:CleanupObjectVersion[])=>{versions=v;}};
}
describe('recording cleanup worker: exact-version mutations and honest observations',()=>{
  afterEach(()=>vi.useRealTimers());
  it.each([0,-1,Infinity,NaN,60001,1.5])('refuses invalid pass budget %s before work',maximumMs=>{
    const f=fixture();expect(()=>f.worker(maximumMs)).toThrow('recording_cleanup_budget_invalid');expect(f.storage.list).not.toHaveBeenCalled();
  });
  it('bounds an uncooperative listing and never continues after its late result',async()=>{
    vi.useFakeTimers();const f=fixture();let settle!:(v:{versions:CleanupObjectVersion[];truncated:boolean})=>void;
    let signal:AbortSignal|undefined;
    f.storage.list=vi.fn<RecordingCleanupStore['list']>((_a,s)=>{signal=s;return new Promise(resolve=>{settle=resolve;});});
    const result=expect(f.worker(20)).rejects.toThrow('recording_storage_deadline');
    await vi.advanceTimersByTimeAsync(21);await result;expect(signal?.aborted).toBe(true);
    settle({versions:[{key:f.a.inventory[0].objectKey,version:'version-0',kind:'object'}],truncated:false});
    await vi.advanceTimersByTimeAsync(0);expect(f.attempts.prepare).not.toHaveBeenCalled();expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it('does not delete after a timed-out attempt commit later succeeds',async()=>{
    vi.useFakeTimers();const f=fixture();let settle!:(v:string)=>void,id='';
    f.attempts.prepare=vi.fn(async(_c,_r,attempt)=>{id=attempt.id;return new Promise<string>(resolve=>{settle=resolve;});});
    const result=expect(f.worker(20)).rejects.toThrow('recording_storage_deadline');
    await vi.advanceTimersByTimeAsync(21);await result;expect(id).not.toBe('');settle(id);
    await vi.advanceTimersByTimeAsync(0);expect(f.storage.remove).not.toHaveBeenCalled();expect(f.attempts.record).not.toHaveBeenCalled();
  });
  it('does not delete after a late pre-delete inspection ignores cancellation',async()=>{
    vi.useFakeTimers();const f=fixture();let settle!:(v:CleanupInspection)=>void,n=0;let version:CleanupObjectVersion|undefined;
    f.storage.inspect=vi.fn(async(_a,v)=>{version=v;if(++n===1)return f.head(v);return new Promise<CleanupInspection>(resolve=>{settle=resolve;});});
    const result=expect(f.worker(20)).rejects.toThrow('recording_storage_deadline');
    await vi.advanceTimersByTimeAsync(21);await result;expect(f.prepared.size).toBe(1);settle(f.head(version!));
    await vi.advanceTimersByTimeAsync(0);expect(f.storage.remove).not.toHaveBeenCalled();expect(f.attempts.record).not.toHaveBeenCalled();
  });
  it('does not record a late delete acknowledgment or start another object after timeout',async()=>{
    vi.useFakeTimers();const f=fixture(2);let settle!:(v:{version:string})=>void;let version='';
    f.storage.remove=vi.fn(async(_a,v)=>{version=v.version;return new Promise<{version:string}>(resolve=>{settle=resolve;});});
    const result=expect(f.worker(20)).rejects.toThrow('recording_storage_deadline');
    await vi.advanceTimersByTimeAsync(21);await result;settle({version});await vi.advanceTimersByTimeAsync(0);
    expect(f.storage.remove).toHaveBeenCalledOnce();expect(f.prepared.size).toBe(1);expect(f.attempts.record).not.toHaveBeenCalled();
  });
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
describe('recording cleanup worker: transcription artifacts under the same holds',()=>{
  function artifactFixture(kind:'media'|'provider'|'transcript'='transcript'){
    const f=fixture(0);
    const jobId=randomUUID(),artifactId=randomUUID(),sha='d'.repeat(64),transcriptId=kind==='transcript'?randomUUID():null;
    const key=`encounter-recordings/${f.a.organizationId}/${f.a.recordingId}/transcription/${jobId}/${kind==='media'?'media.webm':kind==='provider'?'provider.json':'transcript-v1.txt'}`;
    f.a.transcriptionInventory=[{artifactId,jobId,kind,objectKey:key,objectVersion:'artifact-version',sha256:sha,bytes:7,transcriptId}];
    f.a.transcriptionInventorySha256='f'.repeat(64);
    const v:CleanupObjectVersion={key,version:'artifact-version',kind:'object'};
    const head=():CleanupInspection=>({version:v.version,bytes:7,checksum:Buffer.from(sha,'hex').toString('base64'),checksumType:'FULL_OBJECT',encryption:'aws:kms',
      kmsKeyArn:f.a.storage.kmsKeyArn,metadata:{'recording-id':f.a.recordingId,'job-id':jobId,'artifact-kind':kind},legalHold:'OFF',retentionVerified:true});
    let inspection=head();
    f.storage.inspect=vi.fn(async()=>inspection);
    f.setVersions([v]);
    return {...f,v,artifactId,jobId,head,setInspection:(patch:Partial<CleanupInspection>)=>{inspection={...head(),...patch};}};
  }
  it('verifies, prepares by artifact and deletes exactly one registered transcript version',async()=>{
    const f=artifactFixture();
    expect(await f.worker()).toMatchObject({state:'needs_recheck',deleteAcknowledged:1,audioDeleted:false});
    const prepared=[...f.prepared.values()];
    expect(prepared).toHaveLength(1);expect(prepared[0]).toMatchObject({segmentId:null,artifactId:f.artifactId,objectVersion:'artifact-version',kind:'object'});
    expect(f.storage.remove).toHaveBeenCalledOnce();expect(f.events).toEqual([{id:prepared[0].id,outcome:'delete_acknowledged'}]);
  });
  it('accepts provider output without a checksum but refuses a wrong version, size, key owner or metadata',async()=>{
    const provider=artifactFixture('provider');provider.setInspection({checksum:undefined,checksumType:undefined,metadata:undefined});
    expect((await provider.worker()).deleteAcknowledged).toBe(1);
    for(const patch of [{bytes:8},{kmsKeyArn:'arn:aws:kms:us-east-2:123456789012:key/22222222-2222-4222-8222-222222222222'},{version:'other-version'},
      {metadata:{'recording-id':randomUUID(),'job-id':'x','artifact-kind':'transcript'}},{checksum:Buffer.from('e'.repeat(64),'hex').toString('base64')}]){
      const f=artifactFixture();f.setInspection(patch as Partial<CleanupInspection>);
      await expect(f.worker()).rejects.toThrow('access_refused');expect(f.storage.remove).not.toHaveBeenCalled();expect(f.attempts.prepare).not.toHaveBeenCalled();
    }
    const listedOther=artifactFixture();listedOther.setVersions([{...listedOther.v,version:'unregistered-version'}]);
    await expect(listedOther.worker()).rejects.toThrow('access_refused');expect(listedOther.storage.remove).not.toHaveBeenCalled();
  });
  it('stops on an unregistered object under the recording prefix and on a changed artifact inventory',async()=>{
    const f=artifactFixture();f.setVersions([f.v,{key:`encounter-recordings/${f.a.organizationId}/${f.a.recordingId}/transcription/${f.jobId}/notes.txt`,version:'v',kind:'object'}]);
    await expect(f.worker()).rejects.toThrow('access_refused');expect(f.storage.inspect).not.toHaveBeenCalled();expect(f.attempts.prepare).not.toHaveBeenCalled();
    const changed=artifactFixture();let n=0;
    const original=changed.storage.inspect;
    changed.storage.inspect=vi.fn(async(a,v,s)=>{if(++n===1)changed.a.transcriptionInventorySha256='0'.repeat(64);return original(a,v,s);});
    // The attempt phase re-reads both inventories; a change is an unknown outcome for that attempt, never a delete.
    expect(await changed.worker()).toMatchObject({state:'needs_recheck',deleteAcknowledged:0});
    expect(changed.storage.remove).not.toHaveBeenCalled();expect(changed.events).toEqual([{id:[...changed.prepared.keys()][0],outcome:'unknown'}]);
  });
  it('under a processing-scope admission deletes only transcription and drafting objects and leaves audio segments and their markers in place',async()=>{
    const f=artifactFixture();
    const segment=f.a.inventory[0],segmentKey=segment.objectKey;
    Object.assign(f.a,{scope:'processing',audioActionable:false});
    f.setVersions([{key:segmentKey,version:'segment-version',kind:'object'},{key:segmentKey,version:'marker-version',kind:'delete_marker'},f.v]);
    expect(await f.worker()).toMatchObject({state:'needs_recheck',deleteAcknowledged:1,audioDeleted:false});
    const prepared=[...f.prepared.values()];
    expect(prepared).toHaveLength(1);expect(prepared[0]).toMatchObject({segmentId:null,artifactId:f.artifactId});
    expect(f.storage.remove).toHaveBeenCalledOnce();expect(vi.mocked(f.storage.remove).mock.calls[0][1]).toEqual(f.v);
    // Only audio left: nothing is deleted and the pass stays provisional rather than reporting an empty recording.
    const audioOnly=artifactFixture();Object.assign(audioOnly.a,{scope:'processing',audioActionable:false});
    audioOnly.setVersions([{key:audioOnly.a.inventory[0].objectKey,version:'segment-version',kind:'object'}]);
    expect(await audioOnly.worker()).toMatchObject({state:'needs_recheck',deleteAcknowledged:0});
    expect(audioOnly.storage.inspect).not.toHaveBeenCalled();expect(audioOnly.attempts.prepare).not.toHaveBeenCalled();
    // Once the recording's own deadline arrives the same processing intent covers audio too.
    const due=artifactFixture();Object.assign(due.a,{scope:'processing',audioActionable:true});
    due.setVersions([due.v]);expect(await due.worker()).toMatchObject({deleteAcknowledged:1});
  });
  it('stops an attempt when the admission scope or audio actionability changes between verification and deletion',async()=>{
    const f=artifactFixture();let n=0;const original=f.storage.inspect;
    f.storage.inspect=vi.fn(async(a,v,s)=>{if(++n===1)Object.assign(f.a,{scope:'processing',audioActionable:false});return original(a,v,s);});
    expect(await f.worker()).toMatchObject({state:'needs_recheck',deleteAcknowledged:0});
    expect(f.storage.remove).not.toHaveBeenCalled();expect(f.events).toEqual([{id:[...f.prepared.keys()][0],outcome:'unknown'}]);
  });
  it('treats an artifact legal hold like an audio hold: the pass stops held and nothing is deleted',async()=>{
    const f=artifactFixture('media');f.setInspection({legalHold:'ON'});
    await expect(f.worker()).rejects.toThrow('legal_hold');
    expect(f.storage.remove).not.toHaveBeenCalled();expect(f.attempts.prepare).not.toHaveBeenCalled();
  });
});
