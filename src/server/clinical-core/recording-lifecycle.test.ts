import { describe, expect, it, vi } from 'vitest';
import { createRecordingLifecycleRepository, recordingRecoveryStateSchema, recordingLifecycleReceiptSchema,
  type RecordingLifecycleReceipt, type RecordingRecoveryState } from './recording-lifecycle';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from './database';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';

const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const context: ProductionClinicalRequestContext = { actorPersonId: id, organizationId: id, identityPool: 'workforce',
  identitySubject: 'fictional-subject', purpose: 'clinical_data', environment: 'production-clinical',
  dataClassification: 'clinical_phi', containsPhi: true, realPatientData: true, productionBound: true };
const input = { recordingId: id, commandId: other, action: 'renew', expectedVersion: 0, inventorySha256: null };
const receipt: RecordingLifecycleReceipt = { recordingId: id, commandId: other, action: 'renew', statusAtCommand: 'capturing',
  credentialVersion: 1, expiresAt: '2026-09-17T00:02:00Z', inventorySha256: null, processingRequested: false, audioDeleted: false,
  replayed: false, captureToken: 'a'.repeat(64), requiresCredentialRecovery: false };
const state: RecordingRecoveryState = { recordingId: id, sessionId: other, status: 'capturing', credentialVersion: 0,
  authorityEpoch: 2, currentAuthorityEpoch: 2, tokenExpiresAt: '2026-09-17T00:02:00Z', deletionDeadline: '2026-09-18T00:00:00Z',
  storedSegments: 0, pendingSegments: 0, reservedBytes: 0, nextSequence: 0, inventorySha256: 'b'.repeat(64), disposition: null,
  processingRequested: false, audioDeleted: false };
function fixture(data: unknown = receipt, failure?: Error) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('set_request_context')) return { rows: [] };
    if (failure) throw failure;
    return { rows: [{ data }] };
  });
  const transaction = vi.fn(async work => work({ query } as ClinicalCoreTransaction));
  const database = { transaction } as ClinicalCoreDatabase;
  return { query, transaction, repository: createRecordingLifecycleRepository(database) };
}

describe('internal recording lifecycle repository and strict receipts', () => {
  it('starts through qualified SQL, binds the configured release and refuses unknown input or mismatched receipts', async () => {
    const request = { encounterId: id, commandId: other, contentType: 'audio/webm' };
    const started = { ...request, recordingId: id, sessionId: other, status: 'capturing', replayed: false, captureToken: 'a'.repeat(64),
      credentialVersion: 0, authorityEpoch: 2, expiresAt: state.tokenExpiresAt, deletionDeadline: state.deletionDeadline };
    const f = fixture(started);
    expect(await f.repository.start(context, request, id)).toEqual(started);
    expect(f.query).toHaveBeenLastCalledWith('select clinical_private.start_qualified_recording_capture($1,$2,$3,$4) as data',
      [{ kind: 'uuid', value: id }, { kind: 'uuid', value: id }, { kind: 'uuid', value: other }, 'audio/webm']);
    expect(() => f.repository.start(context, { ...request, releaseId: other }, id)).toThrow('request_invalid');
    expect(() => f.repository.start(context, request, 'bad')).toThrow('request_invalid');
    for (const patch of [{ encounterId: other }, { commandId: id }, { contentType: 'audio/mp4' }, { captureToken: null }, { replayed: true }])
      await expect(fixture({ ...started, ...patch }).repository.start(context, request, id)).rejects.toThrow('service_unavailable');
    expect(await fixture({ ...started, replayed: true, captureToken: null }).repository.start(context, request, id))
      .toMatchObject({ replayed: true, captureToken: null });
  });
  it('uses fixed parameterized SQL with UUID context and a bigint version, and decodes Data API JSON', async () => {
    const f = fixture(JSON.stringify(receipt));
    expect(await f.repository.command(context, input)).toEqual(receipt);
    expect(f.query).toHaveBeenNthCalledWith(1, 'select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',
      [{ kind: 'uuid', value: id }, { kind: 'uuid', value: id }, 'workforce', 'fictional-subject', 'clinical_data', 'production-clinical', 'clinical_phi']);
    expect(f.query).toHaveBeenNthCalledWith(2, 'select clinical_private.command_recording_lifecycle($1,$2,$3,$4::bigint,$5) as data',
      [{ kind: 'uuid', value: id }, { kind: 'uuid', value: other }, 'renew', 0, null]);
  });
  it('reads current state separately from a historical retry receipt', async () => {
    const f = fixture(state);
    expect(await f.repository.state(context, id)).toEqual(state);
    expect(f.query).toHaveBeenLastCalledWith('select clinical_private.get_recording_recovery_state($1) as data', [{ kind: 'uuid', value: id }]);
    const replay = { ...receipt, replayed: true, captureToken: null, requiresCredentialRecovery: true };
    expect(await fixture(replay).repository.command(context, input)).toEqual(replay);
  });
  it.each([{ identityPool: 'consumer' }, { purpose: 'analytics' }, { environment: 'synthetic' }, { dataClassification: 'synthetic' },
    { productionBound: false }, { containsPhi: false }, { realPatientData: false }])('refuses incorrect context before SQL %j', async patch => {
    const f = fixture();
    await expect(f.repository.command({ ...context, ...patch } as ProductionClinicalRequestContext, input)).rejects.toMatchObject({ code: 'access_refused' });
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each([{ recordingId: 'bad' }, { commandId: 'bad' }, { action: 'delete' }, { expectedVersion: -1 },
    { expectedVersion: Number.MAX_SAFE_INTEGER }, { expectedVersion: 0.1 }, { inventorySha256: 'a'.repeat(64) },
    { action: 'finish' }, { action: 'discard', inventorySha256: 'bad' }, { captureToken: 'a'.repeat(64) }, { organizationId: other }])
    ('refuses malformed commands before SQL %j', patch => {
      const f = fixture();
      expect(() => f.repository.command(context, { ...input, ...patch })).toThrow('request_invalid');
      expect(f.transaction).not.toHaveBeenCalled();
    });
  it('rejects an invalid state identity before SQL', () => {
    const f = fixture(); expect(() => f.repository.state(context, 'bad')).toThrow('request_invalid');
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each([{ recordingId: other }, { commandId: id }, { credentialVersion: 2 }, { action: 'resume' },
    { captureToken: null }, { captureToken: 'secret' }, { replayed: true }, { requiresCredentialRecovery: true },
    { statusAtCommand: 'paused' }, { processingRequested: true }, { audioDeleted: true }, { extra: true }])
    ('rejects mismatched, untruthful or secret-bearing replay receipts %j', async patch => {
      await expect(fixture({ ...receipt, ...patch }).repository.command(context, input)).rejects.toMatchObject({ code: 'service_unavailable' });
    });
  it.each([{ recordingId: other }, { captureToken: 'a'.repeat(64) }, { objectKey: 'private' }, { nextSequence: 1 },
    { currentAuthorityEpoch: 1 }, { status: 'closed' }, { disposition: 'finish' }, { pendingSegments: 2 }, { audioDeleted: true }])
    ('rejects invalid recovery state or information leakage %j', async patch => {
      await expect(fixture({ ...state, ...patch }).repository.state(context, id)).rejects.toMatchObject({ code: 'service_unavailable' });
    });
  it.each(['pause', 'finish', 'discard'] as const)('allows a nonsecret %s receipt but not a fabricated capture credential', action => {
    const nonsecret = { ...receipt, action, statusAtCommand: action === 'pause' ? 'paused' : 'closed',
      inventorySha256: action === 'pause' ? null : 'b'.repeat(64), captureToken: null };
    expect(recordingLifecycleReceiptSchema.safeParse(nonsecret).success).toBe(true);
    expect(recordingLifecycleReceiptSchema.safeParse({ ...nonsecret, captureToken: 'a'.repeat(64) }).success).toBe(false);
  });
  it('accepts a closed pending-cleanup state without claiming deletion', () => {
    expect(recordingRecoveryStateSchema.safeParse({ ...state, status: 'closed', disposition: 'discard', pendingSegments: 1,
      nextSequence: 1, reservedBytes: 3 }).success).toBe(true);
  });
  it.each(['conflict', 'request_invalid', 'consent_required', 'operation_refused', 'identity_refused'] as const)
    ('maps a bounded database refusal %s', async category => {
      const expected = ['conflict', 'request_invalid', 'consent_required'].includes(category) ? category : 'access_refused';
      await expect(fixture(null, new ClinicalCoreDatabaseRejection(category)).repository.command(context, input))
        .rejects.toMatchObject({ code: expected, message: expected });
    });
  it('removes raw provider errors and malformed results', async () => {
    for (const f of [fixture(null, new Error('private SQL, token, patient details')), fixture('{'), fixture(null)])
      await expect(f.repository.command(context, input)).rejects.toMatchObject({ code: 'service_unavailable', message: 'service_unavailable' });
  });
});
