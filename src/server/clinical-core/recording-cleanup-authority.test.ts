import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createRecordingCleanupAuthority,type RecordingCleanupAdmission} from './recording-cleanup-authority';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';

const context:ProductionClinicalRequestContext={actorPersonId:randomUUID(),organizationId:randomUUID(),identityPool:'workforce',
  identitySubject:'fictional-subject',purpose:'consent_management',environment:'production-clinical',dataClassification:'clinical_phi',
  productionBound:true,containsPhi:true,realPatientData:true};
function fixture(){
  const request={recordingId:randomUUID(),version:2,cleanupReleaseId:randomUUID(),workerSha256:'a'.repeat(64)};
  const sessionId=randomUUID(),storageReleaseId=randomUUID();
  const admission:RecordingCleanupAdmission={...request,sessionId,organizationId:context.organizationId,patientRecordId:randomUUID(),
    storageReleaseId,storage:{bucket:'fictional-bucket',expectedBucketOwner:'123456789012',region:'us-east-2',
      kmsKeyArn:'arn:aws:kms:us-east-2:123456789012:key/11111111-1111-4111-8111-111111111111',maxSegmentBytes:1000000},
    inventory:[{segmentId:randomUUID(),sequence:0,sha256:'b'.repeat(64),bytes:3,status:'reserved',objectVersion:null,
      objectKey:`encounter-recordings/${context.organizationId}/${request.recordingId}/${sessionId}/0-${'b'.repeat(64)}`,
      storageReleaseId,authorityEpoch:1,participantIds:[randomUUID()],recordingGrantIds:[randomUUID()]}],
    inventorySha256:'c'.repeat(64),transcriptionInventory:[],transcriptionInventorySha256:'e'.repeat(64),scope:'recording',audioActionable:true,validUntil:new Date(Date.now()+5000).toISOString(),audioDeleted:false};
  let active=false;const commits=vi.fn(),rollbacks=vi.fn(),query=vi.fn();
  const db:ClinicalCoreDatabase={transaction:async work=>{
    active=true;
    try{const result=await work({query:async<Row extends Record<string,unknown>>(sql:string)=>{
      query(sql);return {rows:sql.includes('admit_recording_cleanup')?[{data:JSON.stringify(admission)} as unknown as Row]:[]};
    }});commits();return result;}catch(error){rollbacks();throw error;}finally{active=false;}
  }};
  return {request,admission,db,commits,rollbacks,query,active:()=>active};
}
afterEach(()=>{vi.useRealTimers();});
describe('cleanup guard: identity, scope, transaction and bounded uncertainty',()=>{
  it('keeps the operation within the admission transaction and does not manufacture deletion proof',async()=>{
    const f=fixture();
    const result=await createRecordingCleanupAuthority(f.db)(context,f.request,async(a,signal)=>{
      expect(f.active()).toBe(true);expect(a).toEqual(f.admission);expect(signal.aborted).toBe(false);return 'FICTIONAL READ ONLY';
    });
    expect(result).toBe('FICTIONAL READ ONLY');expect(f.commits).toHaveBeenCalledOnce();expect(f.query).toHaveBeenCalledTimes(2);
  });
  it.each(['identityPool','purpose','environment','dataClassification','productionBound','containsPhi','realPatientData','actorPersonId','identitySubject'])(
    'rejects invalid %s before opening a transaction',async key=>{
      const f=fixture(),operation=vi.fn();
      await expect(createRecordingCleanupAuthority(f.db)({...context,[key]:null} as unknown as ProductionClinicalRequestContext,f.request,operation)).rejects.toThrow('access_refused');
      expect(f.query).not.toHaveBeenCalled();expect(operation).not.toHaveBeenCalled();
    });
  it.each(['recordingId','organizationId','version','cleanupReleaseId','workerSha256'])(
    'rejects an admission for the wrong %s',async key=>{
      const f=fixture(),operation=vi.fn();Object.assign(f.admission,{[key]:key==='version'?3:key==='workerSha256'?'f'.repeat(64):randomUUID()});
      await expect(createRecordingCleanupAuthority(f.db)(context,f.request,operation)).rejects.toThrow('service_unavailable');expect(operation).not.toHaveBeenCalled();
    });
  it.each(['path','duplicate','storage','version','claim'])(
    'rejects malformed %s inventory before the callback',async mode=>{
      const f=fixture(),operation=vi.fn();
      if(mode==='path')f.admission.inventory[0].objectKey='other-patient/anything';
      if(mode==='duplicate')f.admission.inventory.push({...f.admission.inventory[0]});
      if(mode==='storage')f.admission.inventory[0].storageReleaseId=randomUUID();
      if(mode==='version')f.admission.inventory[0].status='stored';
      if(mode==='claim')Object.assign(f.admission,{audioDeleted:true});
      await expect(createRecordingCleanupAuthority(f.db)(context,f.request,operation)).rejects.toThrow('service_unavailable');expect(operation).not.toHaveBeenCalled();
    });
  it.each([['legal_hold','legal_hold'],['conflict','not_ready'],['identity_refused','access_refused']] as const)(
    'sanitizes database %s refusals',async(category,code)=>{
      const db:ClinicalCoreDatabase={transaction:async()=>{throw new ClinicalCoreDatabaseRejection(category);}},operation=vi.fn(),f=fixture();
      await expect(createRecordingCleanupAuthority(db)(context,f.request,operation)).rejects.toThrow(code);expect(operation).not.toHaveBeenCalled();
    });
  it('refuses expired admission without invoking storage',async()=>{
    const f=fixture(),operation=vi.fn();f.admission.validUntil=new Date(Date.now()-1).toISOString();
    await expect(createRecordingCleanupAuthority(f.db)(context,f.request,operation)).rejects.toThrow('service_unavailable');expect(operation).not.toHaveBeenCalled();
  });
  it('requires a matching prepared attempt receipt when authorizing a mutation',async()=>{
    const f=fixture(),operation=vi.fn(),attemptId=randomUUID();
    await expect(createRecordingCleanupAuthority(f.db)(context,{...f.request,attemptId},operation)).rejects.toThrow('service_unavailable');
    f.admission.attempt={id:randomUUID(),segmentId:f.admission.inventory[0].segmentId,artifactId:null,objectVersion:'version-1',kind:'object',evidenceSha256:'d'.repeat(64)};
    await expect(createRecordingCleanupAuthority(f.db)(context,{...f.request,attemptId},operation)).rejects.toThrow('service_unavailable');
    expect(operation).not.toHaveBeenCalled();
    f.admission.attempt.id=attemptId;operation.mockResolvedValue('FICTIONAL OPERATION');
    expect(await createRecordingCleanupAuthority(f.db)(context,{...f.request,attemptId},operation)).toBe('FICTIONAL OPERATION');
  });
  it('requires the exact run fence and caps work at its returned lease deadline',async()=>{
    vi.useFakeTimers();const f=fixture(),operation=vi.fn(),runId=randomUUID();
    await expect(createRecordingCleanupAuthority(f.db)(context,{...f.request,runId},operation)).rejects.toThrow('service_unavailable');
    f.admission.runId=randomUUID();
    await expect(createRecordingCleanupAuthority(f.db)(context,{...f.request,runId},operation)).rejects.toThrow('service_unavailable');
    expect(operation).not.toHaveBeenCalled();
    f.admission.runId=runId;f.admission.validUntil=new Date(Date.now()+200).toISOString();
    let signal:AbortSignal|undefined;
    const pending=createRecordingCleanupAuthority(f.db)(context,{...f.request,runId},async(_a,s)=>{signal=s;return new Promise(()=>{});});
    const rejected=expect(pending).rejects.toThrow('service_unavailable');
    await vi.advanceTimersByTimeAsync(201);await rejected;
    expect(signal?.aborted).toBe(true);expect(f.query).toHaveBeenCalledWith(expect.stringContaining('admit_recording_cleanup_run'));
    expect(f.commits).not.toHaveBeenCalled();
  });
  it('settles and rolls back independently of ignored cancellation; late completion cannot become a receipt',async()=>{
    vi.useFakeTimers();const f=fixture();let finish!:(v:string)=>void,signal:AbortSignal|undefined;
    const promise=createRecordingCleanupAuthority(f.db)(context,f.request,async(_a,s)=>{signal=s;return new Promise<string>(resolve=>{finish=resolve;});});
    const rejected=expect(promise).rejects.toThrow('service_unavailable');
    await vi.advanceTimersByTimeAsync(5001);await rejected;
    expect(signal?.aborted).toBe(true);expect(f.rollbacks).toHaveBeenCalledOnce();expect(f.commits).not.toHaveBeenCalled();
    finish('NOT A DELETION RECEIPT');await vi.runAllTimersAsync();expect(f.commits).not.toHaveBeenCalled();
  });
});
