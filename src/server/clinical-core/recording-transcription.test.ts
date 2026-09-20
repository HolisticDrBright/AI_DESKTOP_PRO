import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createRecordingTranscriptionProcessor, createRecordingTranscriptionRepository, providerTranscriptText, transcriptionPrefix,
  RecordingTranscriptionError, MAX_TRANSCRIPTION_MEDIA_BYTES, type RecordingTranscriptionRepository, type TranscriptionMedia,
  type TranscriptionMediaStore, type TranscriptionProvider } from './recording-transcription';
import { createRecordingTranscriptionApi, RECORDING_TRANSCRIPTION_ROUTE, type RecordingTranscriptionConfiguration } from './recording-transcription-api';
import type { TranscriptionListing } from '@/contracts/encounterRecordingTranscription';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import type { ApiGatewayV2Event } from './aws-identity-api';

const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', third = '33333333-3333-4333-8333-333333333333';
const context: ProductionClinicalRequestContext = { actorPersonId: id, organizationId: id, identityPool: 'workforce',
  identitySubject: 'fictional-subject', purpose: 'clinical_data', environment: 'production-clinical',
  dataClassification: 'clinical_phi', containsPhi: true, realPatientData: true, productionBound: true };
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const storage = { bucket: 'fictional-recordings', expectedBucketOwner: '123456789012', region: 'us-east-2',
  kmsKeyArn: 'arn:aws:kms:us-east-2:123456789012:key/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', maxSegmentBytes: 4194304 };
const seg0 = Buffer.from('FICTIONAL AUDIO PART ONE'), seg1 = Buffer.from('FICTIONAL AUDIO PART TWO');
const at = '2026-09-20T00:00:00.000Z';
function media(status: 'requested' | 'processing' = 'requested'): TranscriptionMedia {
  return { jobId: other, recordingId: id, organizationId: id, contentType: 'audio/webm', status, providerJobName: status === 'processing' ? `alp-${other}` : null,
    storage, provider: { provider: 'aws_transcribe', region: 'us-east-2', languageCode: 'en-US' },
    segments: [{ sequence: 0, objectKey: 'k0', objectVersion: 'v0', sha256: sha(seg0), bytes: seg0.length },
      { sequence: 1, objectKey: 'k1', objectVersion: 'v1', sha256: sha(seg1), bytes: seg1.length }] };
}
function listing(status: TranscriptionListing['job'] extends infer J ? J extends { status: infer S } ? S : never : never, versions: TranscriptionListing['versions'] = []): TranscriptionListing {
  return { recordingId: id, status: 'closed', job: { jobId: other, status, providerJobName: status === 'requested' ? null : `alp-${other}`, failureCode: null,
    segmentCount: 2, inventorySha256: 'b'.repeat(64), createdAt: at, updatedAt: at }, versions };
}
const version = (n: number, text: string, kind: 'provider' | 'correction' = n === 1 ? 'provider' : 'correction') => ({ transcriptId: n === 1 ? third : other, version: n, kind,
  contentSha256: sha(text), byteLength: Buffer.byteLength(text), wordCount: text.split(/\s+/).length, supersedesId: n === 1 ? null : third, authorId: id,
  reason: n === 1 ? null : 'speaker name corrected', createdAt: at });
const providerDocument = JSON.stringify({ jobName: `alp-${other}`, results: { transcripts: [{ transcript: 'fictional transcript text' }], items: [] }, status: 'COMPLETED' });
function fixture(state: 'requested' | 'processing' = 'requested') {
  const objects = new Map<string, Uint8Array>([['k0', seg0], ['k1', seg1]]);
  const versionOf = (key: string) => 'v-' + createHash('sha256').update(key).digest('hex').slice(0, 8);
  const store: TranscriptionMediaStore & { puts: { key: string; contentType: string; tags: unknown }[] } = { puts: [],
    get: vi.fn(async (_s, key, _v, max) => { const b = objects.get(key); if (!b) throw new RecordingTranscriptionError('storage_unverified');
      if (b.length > max) throw new RecordingTranscriptionError('storage_unverified'); return { bytes: b, version: versionOf(key) }; }),
    put: vi.fn(async (_s, key, bytes, contentType, tags) => { if (objects.has(key)) throw new RecordingTranscriptionError('conflict'); objects.set(key, bytes);
      store.puts.push({ key, contentType, tags }); return { version: versionOf(key) }; }) };
  const artifacts: { jobId: string; kind: string; key: string; version: string; sha256: string; bytes: number; transcriptId?: string }[] = [];
  const provider: TranscriptionProvider = { start: vi.fn(async () => undefined), status: vi.fn(async () => ({ state: 'processing' as const })) };
  let current = media(state), list = listing(state);
  const repository: RecordingTranscriptionRepository = {
    request: vi.fn(async (_c, recordingId, commandId) => ({ jobId: other, recordingId, commandId, status: 'requested' as const, segmentCount: 2, inventorySha256: 'b'.repeat(64), replayed: false })),
    media: vi.fn(async () => current),
    markProcessing: vi.fn(async (_c, _j, name) => { current = { ...current, status: 'processing', providerJobName: name }; list = listing('processing'); }),
    fail: vi.fn(async (_c, _j, code) => { list = { ...listing('failed'), job: { ...listing('failed').job!, failureCode: code } }; }),
    complete: vi.fn(async (_c, jobId, _key, contentSha256, byteLength, wordCount) => {
      list = listing('completed', [{ ...version(1, 'fictional transcript text'), contentSha256, byteLength, wordCount }]);
      return { jobId, status: 'completed' as const, transcriptId: third, version: 1, contentSha256, replayed: false }; }),
    correct: vi.fn(async (_c, _r, _key, contentSha256, byteLength, wordCount, reason) => {
      list = { ...list, versions: [...list.versions, { ...version(2, ''), contentSha256, byteLength, wordCount, reason }] };
      return { transcriptId: other, jobId: other, version: 2, supersedesId: third, contentSha256 }; }),
    list: vi.fn(async () => list),
    object: vi.fn(async (_c, transcriptId) => { const v = list.versions.find(v => v.transcriptId === transcriptId); if (!v) throw new RecordingTranscriptionError('refused');
      return { transcriptId, recordingId: id, version: v.version, objectKey: `${transcriptionPrefix(current)}/transcript-v${v.version}.txt`, contentSha256: v.contentSha256, byteLength: v.byteLength, storage }; }),
    registerArtifact: vi.fn(async (_c, jobId, kind, key, version, sha256, bytes, transcriptId) => {
      artifacts.push({ jobId, kind, key, version, sha256, bytes, transcriptId }); return { artifactId: third, jobId, kind, replayed: false }; }),
  };
  const processor = createRecordingTranscriptionProcessor({ repository, media: store, provider, releaseId: third });
  return { objects, store, provider, repository, processor, artifacts, versionOf, setMedia: (m: TranscriptionMedia) => { current = m; } };
}
describe('bounded encounter transcription processor', () => {
  it('requests only under the deployed release and assembles verified media before starting the provider once', async () => {
    const f = fixture();
    const receipt = await f.processor.request(context, id, third);
    expect(receipt.status).toBe('requested');
    expect(f.repository.request).toHaveBeenCalledWith(context, id, third, third);
    const after = await f.processor.advance(context, id);
    expect(after.job?.status).toBe('processing');
    const mediaKey = `${transcriptionPrefix(media())}/media.webm`;
    expect(f.store.puts).toEqual([{ key: mediaKey, contentType: 'audio/webm', tags: { recordingId: id, jobId: other, kind: 'media' } }]);
    expect(f.objects.get(mediaKey)).toEqual(Buffer.concat([seg0, seg1]));
    // The assembled media object is registered with its exact version and digest before the provider starts.
    expect(f.artifacts).toEqual([{ jobId: other, kind: 'media', key: mediaKey, version: f.versionOf(mediaKey), sha256: sha(Buffer.concat([seg0, seg1])), bytes: seg0.length + seg1.length, transcriptId: undefined }]);
    expect(vi.mocked(f.repository.registerArtifact).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.provider.start).mock.invocationCallOrder[0]);
    expect(f.provider.start).toHaveBeenCalledWith({ jobName: `alp-${other}`, storage, mediaKey, contentType: 'audio/webm',
      outputKey: `${transcriptionPrefix(media())}/provider.json`, languageCode: 'en-US' });
    // Authority is re-read after the segment reads and before the media object is written.
    expect(f.repository.media).toHaveBeenCalledTimes(2);
    expect(f.repository.markProcessing).toHaveBeenCalledWith(context, other, `alp-${other}`);
    // Polling while the provider is still working changes nothing.
    expect((await f.processor.advance(context, id)).job?.status).toBe('processing');
    expect(f.provider.start).toHaveBeenCalledOnce(); expect(f.repository.complete).not.toHaveBeenCalled();
  });
  it('refuses tampered, oversized or reordered media without writing or starting anything', async () => {
    const tampered = fixture(); tampered.objects.set('k1', Buffer.from('FICTIONAL AUDIO PART TWO!'));
    await expect(tampered.processor.advance(context, id)).rejects.toMatchObject({ code: 'storage_unverified' });
    const huge = fixture(); huge.setMedia({ ...media(), segments: [{ sequence: 0, objectKey: 'k0', objectVersion: 'v0', sha256: sha(seg0), bytes: 4194304 },
      ...Array.from({ length: 64 }, (_, i) => ({ sequence: i + 1, objectKey: 'k1', objectVersion: 'v1', sha256: sha(seg1), bytes: 4194304 }))] });
    await expect(huge.processor.advance(context, id)).rejects.toMatchObject({ code: 'media_too_large' });
    expect(65 * 4194304).toBeGreaterThan(MAX_TRANSCRIPTION_MEDIA_BYTES);
    const reordered = fixture(); reordered.setMedia({ ...media(), segments: [...media().segments].reverse() });
    await expect(reordered.processor.advance(context, id)).rejects.toMatchObject({ code: 'storage_unverified' });
    for (const f of [tampered, huge, reordered]) {
      expect(f.store.puts).toEqual([]); expect(f.provider.start).not.toHaveBeenCalled(); expect(f.repository.markProcessing).not.toHaveBeenCalled();
      expect(f.artifacts).toEqual([]);
    }
    // A store that cannot name the version it wrote is refused: cleanup could never verify the object.
    const versionless = fixture(); vi.mocked(versionless.store.put).mockResolvedValueOnce({ version: null });
    await expect(versionless.processor.advance(context, id)).rejects.toMatchObject({ code: 'storage_unverified' });
    expect(versionless.provider.start).not.toHaveBeenCalled(); expect(versionless.artifacts).toEqual([]);
    expect(huge.store.get).not.toHaveBeenCalled();
  });
  it('stores the provider result as an immutable digest-recorded version and records provider failure instead of a transcript', async () => {
    const f = fixture('processing');
    f.objects.set(`${transcriptionPrefix(media())}/provider.json`, Buffer.from(providerDocument));
    vi.mocked(f.provider.status).mockResolvedValueOnce({ state: 'completed' });
    const done = await f.processor.advance(context, id);
    expect(done.job?.status).toBe('completed'); expect(done.versions).toHaveLength(1);
    const key = `${transcriptionPrefix(media())}/transcript-v1.txt`, providerKey = `${transcriptionPrefix(media())}/provider.json`;
    expect(f.store.puts).toEqual([{ key, contentType: 'text/plain; charset=utf-8', tags: { recordingId: id, jobId: other, kind: 'transcript' } }]);
    expect(f.repository.complete).toHaveBeenCalledWith(context, other, key, sha('fictional transcript text'), 25, 3);
    // Provider output is registered as read, the transcript after completion names its version row.
    expect(f.artifacts).toEqual([
      { jobId: other, kind: 'provider', key: providerKey, version: f.versionOf(providerKey), sha256: sha(providerDocument), bytes: Buffer.byteLength(providerDocument), transcriptId: undefined },
      { jobId: other, kind: 'transcript', key, version: f.versionOf(key), sha256: sha('fictional transcript text'), bytes: 25, transcriptId: third }]);
    const content = await f.processor.read(context, third);
    expect(content).toEqual({ transcriptId: third, recordingId: id, version: 1, contentSha256: sha('fictional transcript text'), text: 'fictional transcript text' });
    f.objects.set(key, Buffer.from('fictional transcript TEXT'));
    await expect(f.processor.read(context, third)).rejects.toMatchObject({ code: 'storage_unverified' });
    const failed = fixture('processing');
    vi.mocked(failed.provider.status).mockResolvedValueOnce({ state: 'failed', failure: 'Unsupported media format detected' });
    const outcome = await failed.processor.advance(context, id);
    expect(outcome.job).toMatchObject({ status: 'failed', failureCode: 'provider_failed:Unsupported media format detected' });
    expect(failed.repository.complete).not.toHaveBeenCalled(); expect(failed.store.puts).toEqual([]); expect(failed.artifacts).toEqual([]);
    const malformed = fixture('processing');
    malformed.objects.set(`${transcriptionPrefix(media())}/provider.json`, Buffer.from('{"results":{}}'));
    vi.mocked(malformed.provider.status).mockResolvedValueOnce({ state: 'completed' });
    await expect(malformed.processor.advance(context, id)).rejects.toMatchObject({ code: 'storage_unverified' });
    expect(malformed.repository.complete).not.toHaveBeenCalled();
    // Even a malformed provider object is registered, so cleanup can remove it.
    expect(malformed.artifacts.map(a => a.kind)).toEqual(['provider']);
    expect(() => providerTranscriptText('not json')).toThrow(RecordingTranscriptionError);
    expect(providerTranscriptText(providerDocument)).toBe('fictional transcript text');
  });
  it('appends corrections as new versions and refuses empty, identical or unanchored corrections', async () => {
    const f = fixture('processing');
    f.objects.set(`${transcriptionPrefix(media())}/provider.json`, Buffer.from(providerDocument));
    vi.mocked(f.provider.status).mockResolvedValueOnce({ state: 'completed' });
    await f.processor.advance(context, id);
    await expect(f.processor.correct(context, id, 'fictional transcript text', 'no change')).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.processor.correct(context, id, '', 'empty')).rejects.toMatchObject({ code: 'request_invalid' });
    const corrected = await f.processor.correct(context, id, 'fictional corrected transcript text', 'speaker name corrected');
    expect(corrected).toMatchObject({ version: 2, supersedesId: third, contentSha256: sha('fictional corrected transcript text') });
    expect(f.store.puts.map(p => p.key)).toEqual([`${transcriptionPrefix(media())}/transcript-v1.txt`, `${transcriptionPrefix(media())}/transcript-v2.txt`]);
    expect(f.repository.correct).toHaveBeenCalledWith(context, id, `${transcriptionPrefix(media())}/transcript-v2.txt`,
      sha('fictional corrected transcript text'), 35, 4, 'speaker name corrected');
    expect(f.artifacts.at(-1)).toEqual({ jobId: other, kind: 'transcript', key: `${transcriptionPrefix(media())}/transcript-v2.txt`,
      version: f.versionOf(`${transcriptionPrefix(media())}/transcript-v2.txt`), sha256: sha('fictional corrected transcript text'), bytes: 35, transcriptId: other });
    expect((await f.processor.read(context, third)).text).toBe('fictional transcript text');
    const none = fixture();
    await expect(none.processor.correct(context, id, 'text', 'reason')).rejects.toMatchObject({ code: 'refused' });
    expect(none.store.puts).toEqual([]);
  });
  it('maps database refusals to bounded codes and never queries outside the production workforce PHI context', async () => {
    const rejections: [ClinicalCoreDatabaseRejection['category'], string][] = [['legal_hold', 'legal_hold'], ['consent_required', 'consent_required'],
      ['operation_refused', 'refused'], ['conflict', 'conflict'], ['request_invalid', 'request_invalid'], ['identity_refused', 'access_refused'],
      ['account_deletion_write_blocked', 'access_refused']];
    for (const [category, expected] of rejections) {
      const database = { transaction: vi.fn(async () => { throw new ClinicalCoreDatabaseRejection(category); }) } as unknown as ClinicalCoreDatabase;
      await expect(createRecordingTranscriptionRepository(database).list(context, id)).rejects.toMatchObject({ code: expected });
    }
    const broken = { transaction: vi.fn(async () => { throw new Error('socket closed'); }) } as unknown as ClinicalCoreDatabase;
    const repository = createRecordingTranscriptionRepository(broken);
    await expect(repository.list(context, id)).rejects.toMatchObject({ code: 'service_unavailable' });
    await expect(repository.list(context, 'not-a-uuid')).rejects.toMatchObject({ code: 'request_invalid' });
    await expect(repository.markProcessing(context, id, 'bad name with spaces')).rejects.toMatchObject({ code: 'request_invalid' });
    for (const patch of [{ identityPool: 'consumer' }, { purpose: 'research' }, { environment: 'staging' }, { containsPhi: false }, { productionBound: false }])
      await expect(repository.list({ ...context, ...patch } as ProductionClinicalRequestContext, id)).rejects.toMatchObject({ code: 'access_refused' });
    expect(broken.transaction).toHaveBeenCalledOnce();
  });
});
const now = Date.now(), seconds = Math.floor(now / 1000);
const config: RecordingTranscriptionConfiguration = { workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/fictional', workforceAudience: '12345678901234567890',
  organizationId: id, phiAllowed: true, activation: 'approved', activationEvidenceSha256: 'a'.repeat(64), databaseReviewSha256: 'b'.repeat(64), mfaReviewSha256: 'c'.repeat(64),
  transcriptionReleaseId: third, transcriptionReviewSha256: 'd'.repeat(64), providerReviewSha256: 'e'.repeat(64), storageReviewSha256: 'f'.repeat(64) };
function event(body: unknown, claims: Record<string, string | number | boolean | undefined> = {}, route = RECORDING_TRANSCRIPTION_ROUTE): ApiGatewayV2Event {
  return { routeKey: route, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { iss: config.workforceIssuer, aud: config.workforceAudience, token_use: 'id', sub: 'fictional-subject',
      'custom:person_id': id, 'custom:organization_id': id, 'custom:production_bound': 'true', email_verified: 'true', iat: seconds, exp: seconds + 600, auth_time: seconds, ...claims } } } } };
}
function api(configuration = config) {
  const f = fixture('processing');
  const factory = vi.fn(() => f.processor);
  return { ...f, factory, handler: createRecordingTranscriptionApi({ configuration, processor: factory, now: () => now }) };
}
describe('workforce transcription API', () => {
  it('serves the five operations only with fresh workforce identity and rejects caller-chosen releases, queries and extra fields', async () => {
    const a = api();
    a.objects.set(`${transcriptionPrefix(media())}/provider.json`, Buffer.from(providerDocument));
    vi.mocked(a.provider.status).mockResolvedValueOnce({ state: 'completed' });
    const listed = await a.handler(event({ operation: 'list', input: { recordingId: id } }));
    expect(listed.statusCode).toBe(200); expect(JSON.parse(listed.body).capabilities).toEqual({ transcription: true, aiDrafting: false, reason: 'ai_drafting_not_configured' });
    expect((await a.handler(event({ operation: 'request', input: { recordingId: id, commandId: third } }))).statusCode).toBe(200);
    expect(a.repository.request).toHaveBeenCalledWith(expect.objectContaining({ identityPool: 'workforce', actorPersonId: id }), id, third, third);
    const advanced = JSON.parse((await a.handler(event({ operation: 'advance', input: { recordingId: id } }))).body);
    expect(advanced.data.job.status).toBe('completed'); expect(JSON.stringify(advanced)).not.toContain('fictional transcript text');
    const read = JSON.parse((await a.handler(event({ operation: 'read', input: { transcriptId: third } }))).body);
    expect(read.data.text).toBe('fictional transcript text');
    const corrected = await a.handler(event({ operation: 'correct', input: { recordingId: id, text: 'fictional corrected transcript text', reason: 'speaker name corrected' } }));
    expect(JSON.parse(corrected.body).data.versions).toHaveLength(2);
    for (const bad of [{ operation: 'request', input: { recordingId: id, commandId: third, releaseId: other } }, { operation: 'list', input: { recordingId: id, organizationId: other } },
      { operation: 'read', input: { transcriptId: 'x' } }, { operation: 'correct', input: { recordingId: id, text: 'x', reason: '' } }, { operation: 'delete', input: { recordingId: id } }])
      expect((await a.handler(event(bad))).statusCode).toBe(400);
    expect((await a.handler({ ...event({ operation: 'list', input: { recordingId: id } }), queryStringParameters: { recordingId: other } })).statusCode).toBe(400);
    expect((await a.handler(event({ operation: 'list', input: { recordingId: id } }, {}, 'POST /clinical-core/workforce/encounter-recording/state'))).statusCode).toBe(404);
    const stale = api();
    expect((await stale.handler(event({ operation: 'list', input: { recordingId: id } }, { auth_time: seconds - 901 }))).statusCode).toBe(401);
    expect(stale.factory).not.toHaveBeenCalled();
  });
  it('maps processor refusals to bounded statuses without leaking detail', async () => {
    const cases: [string, number][] = [['consent_required', 403], ['legal_hold', 403], ['refused', 403], ['access_refused', 403], ['conflict', 409],
      ['media_too_large', 413], ['request_invalid', 400], ['storage_unverified', 503], ['service_unavailable', 503]];
    for (const [code, status] of cases) {
      const a = api();
      vi.mocked(a.repository.list).mockRejectedValueOnce(new RecordingTranscriptionError(code as RecordingTranscriptionError['code']));
      const response = await a.handler(event({ operation: 'list', input: { recordingId: id } }));
      expect(response.statusCode).toBe(status); expect(JSON.parse(response.body)).toEqual({ error: code });
    }
    const a = api();
    vi.mocked(a.repository.list).mockRejectedValueOnce(new Error('arn:aws:secret detail'));
    const response = await a.handler(event({ operation: 'list', input: { recordingId: id } }));
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain('arn:aws');
  });
  it('stays blocked without PHI activation and every transcription, provider and storage review', async () => {
    const blocked = api({ ...config, phiAllowed: false, activation: 'blocked', transcriptionReleaseId: '' });
    expect(JSON.parse((await blocked.handler(event({ operation: 'list', input: { recordingId: id } }))).body)).toEqual({ error: 'production_not_activated', phiAllowed: false });
    expect(blocked.factory).not.toHaveBeenCalled();
    for (const key of ['transcriptionReleaseId', 'transcriptionReviewSha256', 'providerReviewSha256', 'storageReviewSha256', 'activationEvidenceSha256', 'mfaReviewSha256'] as const)
      expect(() => api({ ...config, [key]: '' })).toThrow('recording_api_activation_invalid');
    expect(() => api({ ...config, transcriptionReleaseId: 'not-a-uuid' })).toThrow('recording_api_activation_invalid');
    expect(() => api({ ...config, activation: 'blocked' })).toThrow('recording_api_activation_invalid');
  });
});
