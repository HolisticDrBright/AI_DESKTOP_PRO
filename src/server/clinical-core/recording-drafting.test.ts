import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createRecordingDraftingProcessor, createRecordingDraftingRepository, proposedNoteFromProvider, draftingPrefix, RecordingDraftingError,
  type DraftingInput, type DraftingProvider, type RecordingDraftingRepository } from './recording-drafting';
import { createRecordingDraftingApi, RECORDING_DRAFTING_ROUTE, type RecordingDraftingConfiguration } from './recording-drafting-api';
import type { TranscriptionMediaStore } from './recording-transcription';
import type { DraftingListing } from '@/contracts/encounterRecordingDrafting';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import type { ApiGatewayV2Event } from './aws-identity-api';

const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', third = '33333333-3333-4333-8333-333333333333', fourth = '44444444-4444-4444-8444-444444444444';
const context: ProductionClinicalRequestContext = { actorPersonId: id, organizationId: id, identityPool: 'workforce', identitySubject: 'fictional-subject',
  purpose: 'clinical_data', environment: 'production-clinical', dataClassification: 'clinical_phi', containsPhi: true, realPatientData: true, productionBound: true };
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const storage = { bucket: 'fictional-recordings', expectedBucketOwner: '123456789012', region: 'us-east-2',
  kmsKeyArn: 'arn:aws:kms:us-east-2:123456789012:key/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', maxSegmentBytes: 4194304 };
const transcriptText = 'Patient reports fictional fatigue for two weeks. Clinician notes fictional plan to recheck labs.';
const transcriptKey = `encounter-recordings/${id}/${id}/transcription/${third}/transcript-v1.txt`, at = '2026-09-20T00:00:00.000Z';
function input(noteType: DraftingInput['noteType'] = 'soap'): DraftingInput {
  return { jobId: other, recordingId: id, organizationId: id, noteType, status: 'requested', storage,
    transcript: { transcriptId: third, version: 1, objectKey: transcriptKey, contentSha256: sha(transcriptText), byteLength: Buffer.byteLength(transcriptText) },
    provider: { provider: 'openai_responses', model: 'fictional-model-1', promptSha256: '7'.repeat(64), zeroDataRetention: true } };
}
const goodOutput = { sections: [{ key: 'S', text: 'Reports fictional fatigue for two weeks.' }, { key: 'O', text: 'Not stated in transcript.' }, { key: 'A', text: 'Fatigue, cause not established in transcript.' },
  { key: 'P', text: 'Clinician stated plan to recheck labs.' }], cautions: ['No examination findings were spoken.'] };
function fixture(state: 'none' | 'requested' | 'completed' = 'requested', noteType: DraftingInput['noteType'] = 'soap') {
  const objects = new Map<string, Uint8Array>([[transcriptKey, Buffer.from(transcriptText)]]);
  const versionOf = (key: string) => 'v-' + sha(key).slice(0, 8);
  const store: TranscriptionMediaStore & { puts: { key: string; contentType: string; tags: unknown }[] } = { puts: [],
    get: vi.fn(async (_s, key, _v, max) => { const b = objects.get(key); if (!b || b.length > max) throw new RecordingDraftingError('storage_unverified'); return { bytes: b, version: versionOf(key) }; }),
    put: vi.fn(async (_s, key, bytes, contentType, tags) => { if (objects.has(key)) throw new RecordingDraftingError('conflict'); objects.set(key, bytes); store.puts.push({ key, contentType, tags }); return { version: versionOf(key) }; }),
    head: vi.fn(async (_s, key) => { const b = objects.get(key); return b ? { version: versionOf(key), bytes: b.length, sha256: sha(b) } : null; }) };
  let unregistered: import('./recording-transcription').UnregisteredObject[] = [];
  const provider: DraftingProvider = { draft: vi.fn(async () => goodOutput) };
  let listing: DraftingListing = { recordingId: id, status: 'closed', latestTranscript: { transcriptId: third, version: 1 }, versions: [],
    job: state === 'none' ? null : { jobId: other, status: state, noteType, transcriptId: third, failureCode: null, createdAt: at, updatedAt: at } };
  const artifacts: { jobId: string; key: string; version: string; sha256: string; bytes: number; proposedNoteId: string }[] = [];
  const repository: RecordingDraftingRepository = {
    request: vi.fn(async (_c, recordingId, transcriptId, commandId, _release, type) => { listing = { ...listing, job: { jobId: other, status: 'requested', noteType: type, transcriptId, failureCode: null, createdAt: at, updatedAt: at } };
      return { jobId: other, recordingId, transcriptId, commandId, noteType: type, status: 'requested' as const, replayed: false }; }),
    input: vi.fn(async () => input(noteType)),
    fail: vi.fn(async (_c, _j, code) => { listing = { ...listing, job: { ...listing.job!, status: 'failed', failureCode: code } }; }),
    complete: vi.fn(async (_c, jobId, _key, contentSha256, byteLength, sectionCount, model) => {
      listing = { ...listing, job: { ...listing.job!, status: 'completed' }, versions: [...listing.versions, { proposedNoteId: fourth, version: listing.versions.length + 1, noteType, transcriptId: third,
        contentSha256, byteLength, sectionCount, model, createdBy: id, createdAt: at }] };
      return { jobId, status: 'completed' as const, proposedNoteId: fourth, version: 1, contentSha256, replayed: false }; }),
    list: vi.fn(async () => listing),
    object: vi.fn(async (_c, proposedNoteId) => { const v = listing.versions.find(v => v.proposedNoteId === proposedNoteId); if (!v) throw new RecordingDraftingError('refused');
      return { proposedNoteId, recordingId: id, transcriptId: third, noteType, version: v.version, objectKey: `${draftingPrefix(input())}/proposed-v${v.version}.json`, contentSha256: v.contentSha256, byteLength: v.byteLength, storage }; }),
    registerArtifact: vi.fn(async (_c, jobId, key, version, sha256, bytes, proposedNoteId) => { artifacts.push({ jobId, key, version, sha256, bytes, proposedNoteId }); unregistered = unregistered.filter(o => o.objectKey !== key); return { artifactId: fourth, jobId, kind: 'proposed_note' as const, replayed: false }; }),
    unregistered: vi.fn(async () => unregistered),
  };
  const processor = createRecordingDraftingProcessor({ repository, media: store, provider, releaseId: third, providerTimeoutMs: 1000 });
  return { objects, store, provider, repository, processor, artifacts, versionOf, setListing: (patch: Partial<DraftingListing>) => { listing = { ...listing, ...patch }; },
    setUnregistered: (o: import('./recording-transcription').UnregisteredObject[]) => { unregistered = o; } };
}
describe('review-only drafting processor', () => {
  it('reads the verified transcript, calls the provider once with the exact note structure, stores an immutable proposed note and registers it', async () => {
    const f = fixture();
    const after = await f.processor.advance(context, id);
    expect(after.job?.status).toBe('completed'); expect(after.versions).toHaveLength(1);
    expect(f.provider.draft).toHaveBeenCalledOnce();
    const call = vi.mocked(f.provider.draft).mock.calls[0][0];
    expect(call).toMatchObject({ model: 'fictional-model-1', promptSha256: '7'.repeat(64), noteType: 'soap', transcript: transcriptText, jobId: other });
    expect(call.sections.map(s => s.key)).toEqual(['S', 'O', 'A', 'P']);
    const key = `${draftingPrefix(input())}/proposed-v1.json`;
    expect(f.store.puts).toEqual([{ key, contentType: 'application/json', tags: { recordingId: id, jobId: other, kind: 'proposed_note' } }]);
    const stored = JSON.parse(Buffer.from(f.objects.get(key)!).toString('utf8'));
    expect(stored).toMatchObject({ contract: 'proposed-note/1', noteType: 'soap', transcriptId: third, transcriptSha256: sha(transcriptText), model: 'fictional-model-1', cautions: ['No examination findings were spoken.'] });
    expect(stored.sections.map((s: { key: string; label: string }) => [s.key, s.label])).toEqual([['S', 'Subjective'], ['O', 'Objective'], ['A', 'Assessment'], ['P', 'Plan']]);
    expect(f.repository.complete).toHaveBeenCalledWith(context, other, key, sha(f.objects.get(key)!), f.objects.get(key)!.length, 4, 'fictional-model-1');
    expect(f.artifacts).toEqual([{ jobId: other, key, version: f.versionOf(key), sha256: sha(f.objects.get(key)!), bytes: f.objects.get(key)!.length, proposedNoteId: fourth }]);
    const content = await f.processor.read(context, fourth);
    expect(content.document.sections[0]).toEqual({ key: 'S', label: 'Subjective', text: 'Reports fictional fatigue for two weeks.' });
    f.objects.set(key, Buffer.from('{"tampered":true}'));
    await expect(f.processor.read(context, fourth)).rejects.toMatchObject({ code: 'storage_unverified' });
    // Nothing to do when no job is open.
    const idle = fixture('none'); expect((await idle.processor.advance(context, id)).job).toBeNull(); expect(idle.provider.draft).not.toHaveBeenCalled();
    // A proposed note from an earlier interrupted step is registered during the next step; absent ones are skipped.
    const g = fixture();
    const orphan = `${draftingPrefix(input())}/proposed-v7.json`, missing = `${draftingPrefix(input())}/proposed-v8.json`;
    g.objects.set(orphan, Buffer.from('{"contract":"proposed-note/1"}'));
    g.setUnregistered([{ kind: 'proposed_note', jobId: other, objectKey: orphan, sha256: sha('{"contract":"proposed-note/1"}'), bytes: 30, transcriptId: null, proposedNoteId: third },
      { kind: 'proposed_note', jobId: other, objectKey: missing, sha256: 'f'.repeat(64), bytes: 10, transcriptId: null, proposedNoteId: fourth },
      { kind: 'media', jobId: other, objectKey: 'not-mine', sha256: null, bytes: null, transcriptId: null, proposedNoteId: null }]);
    await g.processor.advance(context, id);
    expect(g.artifacts.map(a => a.key)).toEqual([`${draftingPrefix(input())}/proposed-v1.json`, orphan]);
    expect(g.artifacts[1]).toMatchObject({ version: g.versionOf(orphan), sha256: sha('{"contract":"proposed-note/1"}'), bytes: 30, proposedNoteId: third });
  });
  it('records provider failure, invalid output, oversized or tampered transcripts as failed jobs without storing text', async () => {
    const down = fixture(); vi.mocked(down.provider.draft).mockRejectedValueOnce(new Error('socket closed'));
    expect((await down.processor.advance(context, id)).job).toMatchObject({ status: 'failed', failureCode: 'provider_unavailable' });
    const invalid = fixture(); vi.mocked(invalid.provider.draft).mockResolvedValueOnce({ sections: [{ key: 'S', text: 'only one' }], cautions: [] });
    expect((await invalid.processor.advance(context, id)).job).toMatchObject({ status: 'failed', failureCode: 'provider_output_invalid' });
    const extra = fixture(); vi.mocked(extra.provider.draft).mockResolvedValueOnce({ ...goodOutput, sections: [...goodOutput.sections, { key: 'X', text: 'extra' }] });
    expect((await extra.processor.advance(context, id)).job).toMatchObject({ status: 'failed', failureCode: 'provider_output_invalid' });
    const empty = fixture(); vi.mocked(empty.provider.draft).mockResolvedValueOnce({ sections: goodOutput.sections.map(s => ({ ...s, text: '  ' })), cautions: [] });
    expect((await empty.processor.advance(context, id)).job).toMatchObject({ status: 'failed', failureCode: 'provider_output_invalid' });
    const huge = fixture(); vi.mocked(huge.repository.input).mockResolvedValueOnce({ ...input(), transcript: { ...input().transcript, byteLength: 3 * 1024 * 1024 } });
    expect((await huge.processor.advance(context, id)).job).toMatchObject({ status: 'failed', failureCode: 'transcript_too_large' });
    expect(huge.provider.draft).not.toHaveBeenCalled(); expect(huge.store.get).not.toHaveBeenCalled();
    for (const f of [down, invalid, extra, empty, huge]) { expect(f.store.puts).toEqual([]); expect(f.repository.complete).not.toHaveBeenCalled(); expect(f.artifacts).toEqual([]); }
    const tampered = fixture(); tampered.objects.set(transcriptKey, Buffer.from(transcriptText + ' extra'));
    await expect(tampered.processor.advance(context, id)).rejects.toMatchObject({ code: 'storage_unverified' });
    expect(tampered.provider.draft).not.toHaveBeenCalled(); expect(tampered.repository.fail).not.toHaveBeenCalled();
    const versionless = fixture(); vi.mocked(versionless.store.put).mockResolvedValueOnce({ version: null });
    await expect(versionless.processor.advance(context, id)).rejects.toMatchObject({ code: 'storage_unverified' });
    expect(versionless.repository.complete).not.toHaveBeenCalled();
    expect(() => proposedNoteFromProvider({ sections: goodOutput.sections, cautions: ['x'.repeat(500)] }, input(), sha(transcriptText))).toThrow(RecordingDraftingError);
    expect(proposedNoteFromProvider({ sections: [{ key: 'text', text: 'Narrative only.' }], cautions: [] }, input('narrative'), sha(transcriptText)).sections).toEqual([{ key: 'text', label: 'Narrative', text: 'Narrative only.' }]);
  });
  it('maps database refusals to bounded codes and never queries outside the production workforce PHI context', async () => {
    const rejections: [ClinicalCoreDatabaseRejection['category'], string][] = [['legal_hold', 'legal_hold'], ['consent_required', 'consent_required'], ['operation_refused', 'refused'],
      ['conflict', 'conflict'], ['request_invalid', 'request_invalid'], ['identity_refused', 'access_refused']];
    for (const [category, expected] of rejections) {
      const database = { transaction: vi.fn(async () => { throw new ClinicalCoreDatabaseRejection(category); }) } as unknown as ClinicalCoreDatabase;
      await expect(createRecordingDraftingRepository(database).list(context, id)).rejects.toMatchObject({ code: expected });
    }
    const broken = { transaction: vi.fn(async () => { throw new Error('socket closed'); }) } as unknown as ClinicalCoreDatabase;
    const repository = createRecordingDraftingRepository(broken);
    await expect(repository.list(context, id)).rejects.toMatchObject({ code: 'service_unavailable' });
    await expect(repository.list(context, 'not-a-uuid')).rejects.toMatchObject({ code: 'request_invalid' });
    await expect(repository.registerArtifact(context, id, 'k', 'null', 'a'.repeat(64), 1, id)).rejects.toMatchObject({ code: 'storage_unverified' });
    for (const patch of [{ identityPool: 'consumer' }, { purpose: 'research' }, { containsPhi: false }, { productionBound: false }])
      await expect(repository.list({ ...context, ...patch } as ProductionClinicalRequestContext, id)).rejects.toMatchObject({ code: 'access_refused' });
    expect(broken.transaction).toHaveBeenCalledOnce();
  });
});
const now = Date.now(), seconds = Math.floor(now / 1000);
const config: RecordingDraftingConfiguration = { workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/fictional', workforceAudience: '12345678901234567890',
  organizationId: id, phiAllowed: true, activation: 'approved', activationEvidenceSha256: 'a'.repeat(64), databaseReviewSha256: 'b'.repeat(64), mfaReviewSha256: 'c'.repeat(64),
  draftingReleaseId: third, draftingReviewSha256: 'd'.repeat(64), providerReviewSha256: 'e'.repeat(64), storageReviewSha256: 'f'.repeat(64),
  openAiSecretArn: 'arn:aws:secretsmanager:us-east-2:123456789012:secret:fictional/drafting-AbCdEf' };
function event(body: unknown, claims: Record<string, string | number | boolean | undefined> = {}, route = RECORDING_DRAFTING_ROUTE): ApiGatewayV2Event {
  return { routeKey: route, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { iss: config.workforceIssuer, aud: config.workforceAudience, token_use: 'id', sub: 'fictional-subject',
      'custom:person_id': id, 'custom:organization_id': id, 'custom:production_bound': 'true', email_verified: 'true', iat: seconds, exp: seconds + 600, auth_time: seconds, ...claims } } } } };
}
function api(configuration = config) {
  const f = fixture('requested');
  const factory = vi.fn(() => f.processor);
  return { ...f, factory, handler: createRecordingDraftingApi({ configuration, processor: factory, now: () => now }) };
}
describe('workforce drafting API', () => {
  it('serves the four operations with fresh workforce identity, declares that it never writes notes, and rejects caller-chosen releases and extra fields', async () => {
    const a = api();
    const listed = await a.handler(event({ operation: 'list', input: { recordingId: id } }));
    expect(listed.statusCode).toBe(200); expect(JSON.parse(listed.body).capabilities).toEqual({ aiDrafting: true, writesClinicalNotes: false, reason: 'review_only' });
    expect((await a.handler(event({ operation: 'request', input: { recordingId: id, transcriptId: third, commandId: fourth, noteType: 'soap' } }))).statusCode).toBe(200);
    expect(a.repository.request).toHaveBeenCalledWith(expect.objectContaining({ identityPool: 'workforce', actorPersonId: id }), id, third, fourth, third, 'soap');
    const advanced = JSON.parse((await a.handler(event({ operation: 'advance', input: { recordingId: id } }))).body);
    expect(advanced.data.job.status).toBe('completed'); expect(JSON.stringify(advanced)).not.toContain('fictional fatigue');
    const read = JSON.parse((await a.handler(event({ operation: 'read', input: { proposedNoteId: fourth } }))).body);
    expect(read.data.document.sections).toHaveLength(4);
    for (const bad of [{ operation: 'request', input: { recordingId: id, transcriptId: third, commandId: fourth, noteType: 'soap', releaseId: other } },
      { operation: 'request', input: { recordingId: id, transcriptId: third, commandId: fourth, noteType: 'letter' } }, { operation: 'correct', input: { recordingId: id } },
      { operation: 'list', input: { recordingId: id, organizationId: other } }, { operation: 'read', input: { proposedNoteId: 'x' } }])
      expect((await a.handler(event(bad))).statusCode).toBe(400);
    expect((await a.handler({ ...event({ operation: 'list', input: { recordingId: id } }), queryStringParameters: { recordingId: other } })).statusCode).toBe(400);
    expect((await a.handler(event({ operation: 'list', input: { recordingId: id } }, {}, 'POST /clinical-core/workforce/encounter-recording/transcription'))).statusCode).toBe(404);
    const stale = api();
    expect((await stale.handler(event({ operation: 'list', input: { recordingId: id } }, { auth_time: seconds - 901 }))).statusCode).toBe(401);
    expect(stale.factory).not.toHaveBeenCalled();
  });
  it('maps refusals to bounded statuses and stays blocked without PHI activation, provider secret and every review', async () => {
    for (const [code, status] of [['consent_required', 403], ['legal_hold', 403], ['refused', 403], ['conflict', 409], ['request_invalid', 400], ['storage_unverified', 503],
      ['provider_unavailable', 503], ['provider_output_invalid', 503]] as const) {
      const a = api(); vi.mocked(a.repository.list).mockRejectedValueOnce(new RecordingDraftingError(code));
      const response = await a.handler(event({ operation: 'list', input: { recordingId: id } }));
      expect(response.statusCode).toBe(status); expect(JSON.parse(response.body)).toEqual({ error: code });
    }
    const blocked = api({ ...config, phiAllowed: false, activation: 'blocked', draftingReleaseId: '', openAiSecretArn: '' });
    expect(JSON.parse((await blocked.handler(event({ operation: 'list', input: { recordingId: id } }))).body)).toEqual({ error: 'production_not_activated', phiAllowed: false });
    expect(blocked.factory).not.toHaveBeenCalled();
    for (const key of ['draftingReleaseId', 'draftingReviewSha256', 'providerReviewSha256', 'storageReviewSha256', 'openAiSecretArn', 'activationEvidenceSha256'] as const)
      expect(() => api({ ...config, [key]: '' })).toThrow('recording_api_activation_invalid');
    expect(() => api({ ...config, openAiSecretArn: 'arn:aws:secretsmanager:us-east-2:123456789012:secret:x;rm' })).toThrow('recording_api_activation_invalid');
  });
});
