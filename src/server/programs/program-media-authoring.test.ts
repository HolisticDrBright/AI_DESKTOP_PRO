import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ClinicalRequestContext, SyntheticRequestContext } from '@/server/clinical-core/aws-identity-consent';
import { programMediaArtifact, programMediaReference, programMediaReservation, type ProgramMediaStorage } from '@/contracts/programMedia';
import { createProgramMediaAuthoring, PROGRAM_MEDIA_ACTIVATION, ProgramMediaError, type ProgramMediaAuthoring } from './program-media-authoring';
import { createFictionalProgramMediaLedger, createFictionalProgramMediaStore } from './program-media-fictional';

/**
 * The program-media authoring runtime against the FICTIONAL ledger and store. Positive journeys
 * (prepare, admit, caption, preview, publish, retire), every denial (disabled runtime, PHI
 * context, another clinic, a consumer, unauthorized program, type, size, name, expired
 * reservation, generated text), and the races (lost put response, concurrent admits of one
 * reservation, a repeated prepare, a failed write recovered by reconcile, cleanup against a
 * committed artifact). None of this certifies a hosted store; it fixes what the code promises.
 */
const KMS = 'arn:aws:kms:us-east-2:588966314750:key/c13ec29d-0e47-4c02-9136-f371bcbb7900';
const storage: ProgramMediaStorage = {
  purpose: 'educational_media', phiAllowed: false, dedicated: true, bucket: 'alp-fictional-program-media', expectedBucketOwner: '588966314750',
  region: 'us-east-2', kmsKeyArn: KMS, maxImageBytes: 1024, maxVideoBytes: 4096, publicOrigin: 'https://media.fictional.example/',
};
const clinic = '40000000-0000-4000-8000-000000000001', otherClinic = '40000000-0000-4000-8000-000000000002';
const program = '40000000-0000-4000-8000-000000000010', foreignProgram = '40000000-0000-4000-8000-000000000020';
const staff = '40000000-0000-4000-8000-000000000100';
const context = (over: Partial<SyntheticRequestContext> = {}): ClinicalRequestContext => ({
  actorPersonId: staff, organizationId: clinic, identityPool: 'workforce', identitySubject: 'syn_fictional_staff_1', purpose: 'clinical_data',
  environment: 'synthetic-staging', dataClassification: 'synthetic_only', containsPhi: false, realPatientData: false, ...over,
} as ClinicalRequestContext);
const bytesOf = (text: string) => new TextEncoder().encode(text);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const image = bytesOf('fictional png bytes');
const prepare = (over: Record<string, unknown> = {}) => ({ commandId: randomUUID(), programId: program, kind: 'image', contentType: 'image/png', bytes: image.byteLength, sha256: sha(image), fileName: 'fictional-lesson.png', ...over });
const code = async (work: Promise<unknown>) => { try { await work; } catch (error) { return error instanceof ProgramMediaError ? error.code : 'other:' + String(error); } return 'none'; };

let clock: Date;
let store: ReturnType<typeof createFictionalProgramMediaStore>;
let ledger: ReturnType<typeof createFictionalProgramMediaLedger>;
let authoring: ProgramMediaAuthoring;
beforeEach(() => {
  clock = new Date('2026-10-11T12:00:00Z');
  store = createFictionalProgramMediaStore({ kmsKeyArn: KMS, now: () => clock });
  ledger = createFictionalProgramMediaLedger({ authorized: (c, p) => c.organizationId === clinic && p === program });
  authoring = createProgramMediaAuthoring({ ledger, store, storage, activation: { enabled: true, reason: 'fictional store under test' }, now: () => clock });
});
async function ready() {
  const reservation = await authoring.prepare(context(), prepare());
  return authoring.admit(context(), { artifactId: reservation.artifactId, sha256: sha(image), bytes: image.byteLength }, image);
}

describe('activation', () => {
  it('is disabled in source, and the default runtime refuses every operation before touching the ledger or the store', async () => {
    expect(PROGRAM_MEDIA_ACTIVATION.enabled).toBe(false);
    expect(PROGRAM_MEDIA_ACTIVATION.reason).toContain('docs/program-media-authoring-2026-10-11.md');
    const disabled = createProgramMediaAuthoring({ ledger, store, storage, now: () => clock });
    expect(disabled.activation()).toEqual({ enabled: false, reason: PROGRAM_MEDIA_ACTIVATION.reason });
    expect(await code(disabled.prepare(context(), prepare()))).toBe('program_media_disabled');
    expect(await code(disabled.preview(context(), { artifactId: randomUUID() }))).toBe('program_media_disabled');
    expect(await code(disabled.cleanupOrphans(context(), { programId: program }))).toBe('program_media_disabled');
    expect(ledger.size()).toBe(0); expect(store.log).toEqual([]);
  });
  it('refuses a storage declaration that is not dedicated to educational media', () => {
    for (const bad of [{ purpose: 'clinical_data' }, { phiAllowed: true }, { dedicated: false }, { bucket: 'alp-qualification-recordings-588966314750' },
      { bucket: 'owned-voice-notes' }, { publicOrigin: 'https://alp-fictional.s3.us-east-2.amazonaws.com/' }, { publicOrigin: 'http://media.fictional.example/' },
      { kmsKeyArn: 'arn:aws:kms:us-east-1:588966314750:key/c13ec29d-0e47-4c02-9136-f371bcbb7900' }]) {
      expect(() => createProgramMediaAuthoring({ ledger, store, storage: { ...storage, ...bad } as ProgramMediaStorage, now: () => clock })).toThrow();
    }
  });
});

describe('the positive journey on the fictional store', () => {
  it('prepares, admits within bounds, commits with integrity proven, captions from supplied text, previews, publishes exactly, retires', async () => {
    const reservation = await authoring.prepare(context(), prepare());
    expect(programMediaReservation.parse(reservation)).toMatchObject({ clinic, programId: program, state: 'reserved', replayed: false, kind: 'image', bytes: image.byteLength });
    expect(reservation.objectKey).toBe(`program-media/${clinic}/${program}/${reservation.artifactId}/${sha(image)}.png`);
    expect(reservation.acceptBefore).toBe('2026-10-11T12:15:00.000Z');

    const artifact = await authoring.admit(context(), { artifactId: reservation.artifactId, sha256: sha(image), bytes: image.byteLength }, image);
    expect(programMediaArtifact.parse(artifact)).toMatchObject({ state: 'ready', version: 1, objectVersion: 'fv1', committedAt: '2026-10-11T12:00:00.000Z', caption: null });
    expect(store.log.map(l => l.op)).toEqual(['put', 'head']);

    const captioned = await authoring.attachText(context(), { artifactId: artifact.artifactId, expectedVersion: 1, slot: 'caption', text: 'A fictional clinician explains the step.', source: 'supplied_by_author', format: 'plain' });
    expect(captioned.version).toBe(2);
    expect(captioned.caption).toMatchObject({ source: 'supplied_by_author', format: 'plain', sha256: createHash('sha256').update('A fictional clinician explains the step.').digest('hex') });

    const preview = await authoring.preview(context(), { artifactId: artifact.artifactId });
    expect(preview).toMatchObject({ version: 2, state: 'ready', historical: false, previewToken: `fictional-preview-${artifact.artifactId}-fv1`, previewUntil: '2026-10-11T12:05:00.000Z' });
    expect(store.log.at(-1)).toEqual({ op: 'preview', key: reservation.objectKey });

    expect(await code(authoring.publish(context(), { artifactId: artifact.artifactId, expectedVersion: 1 }))).toBe('conflict');
    const reference = await authoring.publish(context(), { artifactId: artifact.artifactId, expectedVersion: 2 });
    expect(programMediaReference.parse(reference)).toMatchObject({ contractVersion: 'program-media-reference/1', version: 2, sha256: sha(image), origin: { clinic, programId: program },
      url: `https://media.fictional.example/${reservation.objectKey}`, caption: { source: 'supplied_by_author' }, transcript: null });
    expect(reference.url).not.toContain('amazonaws');
    expect(ledger.publications).toHaveLength(1);
    expect(await authoring.describeReference(context(), reference)).toEqual({ reference, historical: false, current: true });

    const retired = await authoring.retire(context(), { artifactId: artifact.artifactId, expectedVersion: 2 });
    expect(retired).toMatchObject({ state: 'retired', version: 3, retiredAt: '2026-10-11T12:00:00.000Z' });
    expect(await code(authoring.publish(context(), { artifactId: artifact.artifactId, expectedVersion: 3 }))).toBe('retired');
    expect(await code(authoring.attachText(context(), { artifactId: artifact.artifactId, expectedVersion: 3, slot: 'caption', text: 'x', source: 'supplied_by_author', format: 'plain' }))).toBe('retired');
    expect(await authoring.describeReference(context(), reference)).toEqual({ reference, historical: true, current: false });
    expect((await authoring.preview(context(), { artifactId: artifact.artifactId })).historical).toBe(true);
    expect(await authoring.retire(context(), { artifactId: artifact.artifactId, expectedVersion: 3 })).toMatchObject({ state: 'retired', version: 3 });
    expect(ledger.publications).toHaveLength(1);
  });
  it('admits a video with a vendor transcript file, and refuses a transcript on an image', async () => {
    const video = bytesOf('fictional webm bytes');
    const reservation = await authoring.prepare(context(), prepare({ kind: 'video', contentType: 'video/webm', bytes: video.byteLength, sha256: sha(video), fileName: 'fictional.webm' }));
    const artifact = await authoring.admit(context(), { artifactId: reservation.artifactId, sha256: sha(video), bytes: video.byteLength }, video);
    const withTranscript = await authoring.attachText(context(), { artifactId: artifact.artifactId, expectedVersion: 1, slot: 'transcript', text: 'WEBVTT\n\n00:00.000 --> 00:01.000\nFictional.', source: 'supplied_vendor_file', format: 'vtt' });
    expect(withTranscript.transcript).toMatchObject({ source: 'supplied_vendor_file', format: 'vtt' });
    const image1 = await ready();
    expect(await code(authoring.attachText(context(), { artifactId: image1.artifactId, expectedVersion: 1, slot: 'transcript', text: 'x', source: 'supplied_by_author', format: 'plain' }))).toBe('request_invalid');
    expect(await code(authoring.attachText(context(), { artifactId: image1.artifactId, expectedVersion: 1, slot: 'caption', text: 'x', source: 'supplied_by_author', format: 'vtt' }))).toBe('request_invalid');
  });
});

describe('denials', () => {
  it.each([
    ['a context that carries PHI', { environment: 'production-clinical', dataClassification: 'clinical_phi', containsPhi: true, realPatientData: true, productionBound: true }],
    ['a consumer identity', { identityPool: 'consumer' }],
    ['another clinic', { organizationId: otherClinic }],
  ] as const)('refuses %s before the ledger or the store is touched', async (_name, over) => {
    expect(await code(authoring.prepare(context(over as Partial<SyntheticRequestContext>), prepare()))).toBe('access_refused');
    expect(ledger.size()).toBe(0); expect(store.log).toEqual([]);
  });
  it('refuses a program the actor is not authorized for', async () => {
    expect(await code(authoring.prepare(context(), prepare({ programId: foreignProgram })))).toBe('access_refused');
  });
  it.each([
    ['a content type the kind does not admit', prepare({ contentType: 'video/mp4' })],
    ['a file name whose extension does not match', prepare({ fileName: 'fictional.jpg' })],
    ['an unsafe file name', prepare({ fileName: '../fictional.png' })],
    ['a name with a space', prepare({ fileName: 'fictional lesson.png' })],
    ['a document', prepare({ kind: 'document', contentType: 'application/pdf', fileName: 'f.pdf' })],
    ['more bytes than the image limit', prepare({ bytes: 1025 })],
    ['zero bytes', prepare({ bytes: 0 })],
    ['a sha that is not hex', prepare({ sha256: 'z'.repeat(64) })],
    ['a patient field smuggled in', prepare({ patientId: randomUUID() })],
  ])('refuses %s as request_invalid', async (_name, request) => {
    expect(await code(authoring.prepare(context(), request))).toBe('request_invalid');
    expect(ledger.size()).toBe(0);
  });
  it('refuses a video above the video limit and admits one within it', async () => {
    expect(await code(authoring.prepare(context(), prepare({ kind: 'video', contentType: 'video/mp4', fileName: 'f.mp4', bytes: 4097 })))).toBe('request_invalid');
    expect((await authoring.prepare(context(), prepare({ kind: 'video', contentType: 'video/mp4', fileName: 'f.mp4', bytes: 4096 }))).state).toBe('reserved');
  });
  it('refuses bytes that do not match the reservation, without writing', async () => {
    const reservation = await authoring.prepare(context(), prepare());
    const other = bytesOf('different bytes');
    expect(await code(authoring.admit(context(), { artifactId: reservation.artifactId, sha256: sha(other), bytes: other.byteLength }, other))).toBe('request_invalid');
    expect(await code(authoring.admit(context(), { artifactId: reservation.artifactId, sha256: sha(image), bytes: image.byteLength }, other))).toBe('request_invalid');
    expect(store.log).toEqual([]);
  });
  it('refuses an expired reservation and marks it abandoned', async () => {
    const reservation = await authoring.prepare(context(), prepare());
    clock = new Date('2026-10-11T12:15:00Z');
    expect(await code(authoring.admit(context(), { artifactId: reservation.artifactId, sha256: sha(image), bytes: image.byteLength }, image))).toBe('reservation_expired');
    expect((await ledger.reservation(context(), reservation.artifactId))?.state).toBe('abandoned');
    expect(await code(authoring.admit(context(), { artifactId: reservation.artifactId, sha256: sha(image), bytes: image.byteLength }, image))).toBe('reservation_expired');
    expect(store.log).toEqual([]);
  });
  it('refuses a generated caption: the only admissible sources are supplied material', async () => {
    const artifact = await ready();
    expect(await code(authoring.attachText(context(), { artifactId: artifact.artifactId, expectedVersion: 1, slot: 'caption', text: 'x', source: 'generated', format: 'plain' }))).toBe('text_source_refused');
    expect(await code(authoring.attachText(context(), { artifactId: artifact.artifactId, expectedVersion: 1, slot: 'caption', text: 'x', source: 'ai_transcription', format: 'plain' }))).toBe('text_source_refused');
    expect((await ledger.artifact(context(), artifact.artifactId))?.caption).toBeNull();
  });
  it('another clinic cannot see, preview, publish or retire the artifact', async () => {
    const artifact = await ready();
    const foreign = context({ organizationId: otherClinic });
    for (const work of [authoring.preview(foreign, { artifactId: artifact.artifactId }), authoring.publish(foreign, { artifactId: artifact.artifactId, expectedVersion: 1 }),
      authoring.retire(foreign, { artifactId: artifact.artifactId, expectedVersion: 1 }), authoring.reconcile(foreign, { artifactId: artifact.artifactId })]) {
      expect(await code(work)).toBe('not_found');
    }
  });
  it('a reservation that is not yet admitted cannot be previewed or published', async () => {
    const reservation = await authoring.prepare(context(), prepare());
    expect(await code(authoring.preview(context(), { artifactId: reservation.artifactId }))).toBe('not_found');
    expect(await code(authoring.publish(context(), { artifactId: reservation.artifactId, expectedVersion: 1 }))).toBe('not_found');
  });
});

describe('lost responses and races', () => {
  it('a repeated prepare returns the earlier reservation, replayed, and a changed payload under the same command conflicts', async () => {
    const request = prepare();
    const first = await authoring.prepare(context(), request);
    const again = await authoring.prepare(context(), request);
    expect(again).toEqual({ ...first, replayed: true });
    expect(ledger.size()).toBe(1);
    expect(await code(authoring.prepare(context(), { ...request, fileName: 'other.png', sha256: 'a'.repeat(64) }))).toBe('other:Error: conflict');
  });
  it('a lost put response does not duplicate the upload: the retry proves the stored object and commits it once', async () => {
    const reservation = await authoring.prepare(context(), prepare());
    store.inject('lose_put_response');
    const artifact = await authoring.admit(context(), { artifactId: reservation.artifactId, sha256: sha(image), bytes: image.byteLength }, image);
    expect(artifact).toMatchObject({ state: 'ready', objectVersion: 'fv1' });
    expect(store.versionsOf(reservation.objectKey)).toEqual(['fv1']);
    expect(store.log.filter(l => l.op === 'put')).toHaveLength(1);
    const again = await authoring.admit(context(), { artifactId: reservation.artifactId, sha256: sha(image), bytes: image.byteLength }, image);
    expect(again).toEqual(artifact);
    expect(store.log.filter(l => l.op === 'put')).toHaveLength(1);
  });
  it('a lost response never claims a publication: a reference exists only when the ledger recorded it', async () => {
    const artifact = await ready();
    ledger.recordPublication = async () => { throw new Error('fictional_ledger_lost'); };
    expect(await code(authoring.publish(context(), { artifactId: artifact.artifactId, expectedVersion: 1 }))).toBe('other:Error: fictional_ledger_lost');
    expect(ledger.publications).toHaveLength(0);
  });
  it('two admits of one reservation at once write one object and commit one artifact', async () => {
    const reservation = await authoring.prepare(context(), prepare());
    const request = { artifactId: reservation.artifactId, sha256: sha(image), bytes: image.byteLength };
    const results = await Promise.all([authoring.admit(context(), request, image), authoring.admit(context(), request, image)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].state).toBe('ready');
    expect(store.versionsOf(reservation.objectKey)).toEqual(['fv1']);
  });
  it('a failed write leaves the reservation in error for retry, and reconcile after a later successful write commits it', async () => {
    const reservation = await authoring.prepare(context(), prepare());
    store.inject('fail_put');
    expect(await code(authoring.admit(context(), { artifactId: reservation.artifactId, sha256: sha(image), bytes: image.byteLength }, image))).toBe('service_unavailable');
    expect((await ledger.artifact(context(), reservation.artifactId))).toMatchObject({ state: 'error', failure: 'store_write_failed' });
    expect(await authoring.reconcile(context(), { artifactId: reservation.artifactId })).toMatchObject({ state: 'error' });
    const artifact = await authoring.admit(context(), { artifactId: reservation.artifactId, sha256: sha(image), bytes: image.byteLength }, image);
    expect(artifact).toMatchObject({ state: 'ready', version: 2, objectVersion: 'fv1' });
  });
  it('an object that does not match its reservation is held, never committed and never deleted', async () => {
    const reservation = await authoring.prepare(context(), prepare());
    store.inject('corrupt_object');
    expect(await code(authoring.admit(context(), { artifactId: reservation.artifactId, sha256: sha(image), bytes: image.byteLength }, image))).toBe('storage_unverified');
    expect((await ledger.artifact(context(), reservation.artifactId))).toMatchObject({ state: 'held', failure: 'storage_unverified', objectVersion: null });
    expect(await code(authoring.admit(context(), { artifactId: reservation.artifactId, sha256: sha(image), bytes: image.byteLength }, image))).toBe('conflict');
    expect(await code(authoring.publish(context(), { artifactId: reservation.artifactId, expectedVersion: 1 }))).toBe('not_ready');
    clock = new Date('2026-10-11T13:00:00Z');
    const receipt = await authoring.cleanupOrphans(context(), { programId: program });
    expect(receipt.actions).toEqual([{ artifactId: reservation.artifactId, outcome: 'kept_pending' }]);
    expect(store.versionsOf(reservation.objectKey)).toEqual(['fv1']);
  });
  it('an unreachable store during proof leaves the reservation in error, not ready', async () => {
    const reservation = await authoring.prepare(context(), prepare());
    store.inject('fail_head');
    expect(await code(authoring.admit(context(), { artifactId: reservation.artifactId, sha256: sha(image), bytes: image.byteLength }, image))).toBe('service_unavailable');
    expect((await ledger.artifact(context(), reservation.artifactId))).toMatchObject({ state: 'error' });
    expect(await authoring.reconcile(context(), { artifactId: reservation.artifactId })).toMatchObject({ state: 'ready', objectVersion: 'fv1' });
  });
  it('a stale version refuses text, publication and retirement', async () => {
    const artifact = await ready();
    await authoring.attachText(context(), { artifactId: artifact.artifactId, expectedVersion: 1, slot: 'caption', text: 'one', source: 'supplied_by_author', format: 'plain' });
    expect(await code(authoring.attachText(context(), { artifactId: artifact.artifactId, expectedVersion: 1, slot: 'caption', text: 'two', source: 'supplied_by_author', format: 'plain' }))).toBe('conflict');
    expect(await code(authoring.publish(context(), { artifactId: artifact.artifactId, expectedVersion: 1 }))).toBe('conflict');
    expect(await code(authoring.retire(context(), { artifactId: artifact.artifactId, expectedVersion: 1 }))).toBe('conflict');
  });
});

describe('orphan cleanup', () => {
  it('abandons an expired reservation with no object, removes an object that provably belongs to an uncommitted one, and never touches a committed artifact', async () => {
    const empty = await authoring.prepare(context(), prepare());
    const orphan = await authoring.prepare(context(), prepare({ fileName: 'orphan.png' }));
    store.inject('lose_put_response'); store.inject('fail_head');
    expect(await code(authoring.admit(context(), { artifactId: orphan.artifactId, sha256: sha(image), bytes: image.byteLength }, image))).toBe('service_unavailable');
    expect(store.versionsOf(orphan.objectKey)).toEqual(['fv1']);
    const committed = await ready();
    const foreignEmpty = await authoring.prepare(context(), prepare({ fileName: 'later.png' }));
    clock = new Date('2026-10-11T12:10:00Z');
    expect((await authoring.cleanupOrphans(context(), { programId: program })).actions).toEqual([]);
    clock = new Date('2026-10-11T12:20:00Z');
    const receipt = await authoring.cleanupOrphans(context(), { programId: program });
    expect(receipt.actions).toEqual(expect.arrayContaining([
      { artifactId: empty.artifactId, outcome: 'abandoned_no_object' },
      { artifactId: orphan.artifactId, outcome: 'abandoned_object_removed' },
      { artifactId: foreignEmpty.artifactId, outcome: 'abandoned_no_object' },
    ]));
    expect(receipt.actions.map(a => a.artifactId)).not.toContain(committed.artifactId);
    expect(store.versionsOf(orphan.objectKey)).toEqual([]);
    expect(store.versionsOf(committed.objectKey)).toEqual(['fv2']);
    expect((await ledger.artifact(context(), committed.artifactId))?.state).toBe('ready');
    expect(store.log.filter(l => l.op === 'remove')).toEqual([{ op: 'remove', key: orphan.objectKey }]);
  });
  it('cleanup is scoped to the actor\'s clinic and an authorized program', async () => {
    expect(await code(authoring.cleanupOrphans(context({ organizationId: otherClinic }), { programId: program }))).toBe('access_refused');
    expect(await code(authoring.cleanupOrphans(context(), { programId: foreignProgram }))).toBe('access_refused');
  });
});
