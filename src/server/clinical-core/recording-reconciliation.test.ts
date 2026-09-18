import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecordingReconciler, createRecordingReconciliationRepository, type RecordingReconciliationRepository } from './recording-reconciliation';
import { RecordingUploadError, type RecordingSegmentReservation, type RecordingStoredObject, type RecordingObjectStore } from './recording-segments';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const hash = 'a'.repeat(64), now = Date.parse('2026-09-17T00:00:00Z');
afterEach(() => vi.useRealTimers());
const context: ProductionClinicalRequestContext = { actorPersonId: id, organizationId: id, identityPool: 'workforce',
  identitySubject: 'fictional-subject', purpose: 'clinical_data', environment: 'production-clinical',
  dataClassification: 'clinical_phi', containsPhi: true, realPatientData: true, productionBound: true };
function fixture() {
  const reservation: RecordingSegmentReservation = { recordingId: id, sessionId: id, segmentId: other, authorityEpoch: 1,
    sequence: 0, bytes: 4, sha256: hash, status: 'reserved', objectVersion: null, contentType: 'audio/webm',
    acceptBefore: new Date(now + 30000).toISOString(), objectKey: `encounter-recordings/${id}/${id}/${id}/0-${hash}`,
    storage: { bucket: 'fictional-storage', expectedBucketOwner: '123456789012', region: 'us-east-2',
      kmsKeyArn: `arn:aws:kms:us-east-2:123456789012:key/${id}`, maxSegmentBytes: 4194304 } };
  const receipt = { recordingId: id, segmentId: other, authorityEpoch: 1, sequence: 0, bytes: 4, sha256: hash, status: 'stored' as const };
  const head: RecordingStoredObject = { version: 'fictional-version', bytes: 4, contentType: 'audio/webm', checksumType: 'FULL_OBJECT',
    checksum: Buffer.from(hash, 'hex').toString('base64'), encryption: 'aws:kms', kmsKeyArn: reservation.storage.kmsKeyArn,
    metadata: { 'recording-id': id, 'session-id': id, 'segment-id': other, 'authority-epoch': '1' } };
  const repository = { prepare: vi.fn<RecordingReconciliationRepository['prepare']>().mockResolvedValue(reservation),
    complete: vi.fn<RecordingReconciliationRepository['complete']>().mockResolvedValue(receipt) };
  const storage = { head: vi.fn<RecordingObjectStore['head']>(async () => head) };
  return { reservation, receipt, head, repository, storage, reconcile: createRecordingReconciler(repository, storage, () => now) };
}
describe('recording reconciliation without replacement upload or old capture token', () => {
  it('settles at the deadline even if HEAD ignores cancellation; late evidence cannot commit', async () => {
    vi.useFakeTimers(); const f=fixture(); let resolve!: (value: RecordingStoredObject) => void;
    f.storage.head.mockImplementation(() => new Promise(done => { resolve=done; }));
    const result=f.reconcile(context,{recordingId:id});
    let settled=false; const checked=expect(result.finally(()=>{settled=true;})).rejects.toMatchObject({code:'service_unavailable'});
    await vi.advanceTimersByTimeAsync(10000);
    expect(settled).toBe(true);
    await checked;
    expect(f.storage.head.mock.calls[0][2].aborted).toBe(true);
    resolve(f.head); await vi.advanceTimersByTimeAsync(0);
    expect(f.repository.complete).not.toHaveBeenCalled();
  });
  it('uses only server inventory and HEAD outside transactions, then reauthorizes receipt completion', async () => {
    const f = fixture();
    expect(await f.reconcile(context, { recordingId: id })).toEqual({ recordingId: id, outcome: 'stored', segment: f.receipt });
    expect(f.repository.prepare).toHaveBeenCalledWith(context, id);
    expect(f.storage.head).toHaveBeenCalledWith(f.reservation, undefined, expect.any(AbortSignal));
    expect(f.repository.complete).toHaveBeenCalledWith(context, id, other, 'fictional-version');
    expect(f.repository.prepare.mock.invocationCallOrder[0]).toBeLessThan(f.storage.head.mock.invocationCallOrder[0]);
    expect(f.storage.head.mock.invocationCallOrder[0]).toBeLessThan(f.repository.complete.mock.invocationCallOrder[0]);
  });
  it('reports no pending segment without storage access or a fabricated receipt', async () => {
    const f = fixture(); f.repository.prepare.mockResolvedValue(null);
    expect(await f.reconcile(context, { recordingId: id })).toEqual({ recordingId: id, outcome: 'no_pending_segment' });
    expect(f.storage.head).not.toHaveBeenCalled(); expect(f.repository.complete).not.toHaveBeenCalled();
  });
  it.each([{ recordingId:'bad' }, { recordingId:id, bucket:'other' }, { recordingId:id, version:'selected' },
    { recordingId:id, captureToken:hash }, { recordingId:id, segmentId:other }])('refuses client-selected recovery evidence %o', async input => {
    const f = fixture(); await expect(f.reconcile(context, input)).rejects.toMatchObject({ code:'request_invalid' });
    expect(f.repository.prepare).not.toHaveBeenCalled(); expect(f.storage.head).not.toHaveBeenCalled();
  });
  it.each([{ recordingId:other }, { objectKey:'other-key' }, { status:'stored', objectVersion:'v1' },
    { storage:{ bucket:'other' } }])('refuses inconsistent reservation before storage %o', async patch => {
    const f = fixture(); Object.assign(f.reservation, patch);
    await expect(f.reconcile(context, { recordingId:id })).rejects.toBeInstanceOf(RecordingUploadError);
    expect(f.storage.head).not.toHaveBeenCalled(); expect(f.repository.complete).not.toHaveBeenCalled();
  });
  it.each([{ version:undefined }, { version:'null' }, { checksum:'bad' }, { checksumType:'COMPOSITE' },
    { contentType:'text/plain' }, { bytes:5 }, { encryption:'AES256' }, { kmsKeyArn:'wrong' }, { metadata:{} }, { deleteMarker:true }])
    ('never accepts unverifiable storage evidence %o', async patch => {
      const f = fixture(); f.storage.head.mockResolvedValue({ ...f.head, ...patch });
      await expect(f.reconcile(context, { recordingId:id })).rejects.toMatchObject({ code:'storage_unverified' });
      expect(f.repository.complete).not.toHaveBeenCalled();
    });
  it.each(['recording-id','session-id','segment-id','authority-epoch'])('requires exact object %s provenance', async key => {
    const f = fixture(); f.head.metadata![key] = 'wrong';
    await expect(f.reconcile(context,{recordingId:id})).rejects.toMatchObject({code:'storage_unverified'});
    expect(f.repository.complete).not.toHaveBeenCalled();
  });
  it('withholds acceptance on missing object, denied storage or withdrawal during HEAD', async () => {
    const f = fixture(); f.storage.head.mockRejectedValue(new Error('404 patient object secret'));
    await expect(f.reconcile(context, {recordingId:id})).rejects.toMatchObject({code:'service_unavailable'});
    expect(f.repository.complete).not.toHaveBeenCalled();
    const g = fixture(); g.repository.complete.mockRejectedValue(new RecordingUploadError('consent_required'));
    await expect(g.reconcile(context,{recordingId:id})).rejects.toMatchObject({code:'consent_required'});
  });
  it('refuses an expired lease before storage and a late HEAD before completion', async () => {
    const f = fixture(); f.reservation.acceptBefore = new Date(now-1).toISOString();
    await expect(f.reconcile(context,{recordingId:id})).rejects.toMatchObject({code:'service_unavailable'});
    expect(f.storage.head).not.toHaveBeenCalled();
    const g = fixture(); let clock = now; g.storage.head.mockImplementation(async () => {clock+=10001;return g.head;});
    await expect(createRecordingReconciler(g.repository,g.storage,()=>clock)(context,{recordingId:id})).rejects.toMatchObject({code:'service_unavailable'});
    expect(g.repository.complete).not.toHaveBeenCalled();
  });
  it('withholds a valid-looking receipt for a different segment or epoch', async () => {
    for(const patch of [{segmentId:id},{authorityEpoch:2},{bytes:5},{sha256:'b'.repeat(64)}]) {
      const f=fixture(); f.repository.complete.mockResolvedValue({...f.receipt,...patch});
      await expect(f.reconcile(context,{recordingId:id})).rejects.toMatchObject({code:'storage_unverified'});
    }
  });
});
describe('typed reconciliation repository', () => {
  it('sets transaction-local identity with typed UUIDs; decodes native or Data API JSON', async () => {
    const f=fixture(), query=vi.fn().mockResolvedValue({rows:[{data:JSON.stringify(f.reservation)}]});
    const repository=createRecordingReconciliationRepository({transaction:async op=>op({query})} as ClinicalCoreDatabase);
    expect(await repository.prepare(context,id)).toEqual(f.reservation);
    expect(query.mock.calls[0][0]).toContain('set_request_context');
    expect(query.mock.calls[1][1]).toEqual([{kind:'uuid',value:id}]);
    query.mockResolvedValue({rows:[{data:null}]}); expect(await repository.prepare(context,id)).toBeNull();
    query.mockResolvedValue({rows:[]}); await expect(repository.prepare(context,id)).rejects.toMatchObject({code:'service_unavailable'});
  });
  it('refuses consumer context and invalid identifiers before querying', async () => {
    const transaction=vi.fn(), repository=createRecordingReconciliationRepository({transaction});
    await expect(repository.prepare({...context,identityPool:'consumer'},id)).rejects.toMatchObject({code:'access_refused'});
    expect(()=>repository.prepare(context,'bad')).toThrow('request_invalid');
    expect(()=>repository.complete(context,id,other,'null')).toThrow('request_invalid');
    expect(transaction).not.toHaveBeenCalled();
  });
  it('preserves only bounded SQL rejection categories', async () => {
    const repository=createRecordingReconciliationRepository({transaction:async()=>{throw new ClinicalCoreDatabaseRejection('conflict');}});
    await expect(repository.prepare(context,id)).rejects.toMatchObject({code:'conflict'});
  });
});
