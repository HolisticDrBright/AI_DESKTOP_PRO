import { describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { ClinicalRequestContext } from '../clinical-core/aws-identity-consent';
import { PROGRAM_LEARNER_MEDIA_CONTRACT, type LearnerMediaRequest } from '@/contracts/programLearnerMedia';
import { createLearnerMediaService, LearnerMediaError, type LearnerMediaDecision, type LearnerMediaLedger, type LearnerMediaStorage } from './learner-media';
import { createFictionalLearnerMediaStorage } from './learner-media-fictional';

/** The service's own rules over a fake ledger and the fictional storage reader (no database, no network). */
const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const id = (n: number) => '7d000000-0000-4000-8000-' + String(n).padStart(12, '0');
const clinic = id(1), program = id(2), artifact = id(3), entitlement = id(4), version = id(5), admission = id(6), publication = id(7);
const bytes = 'a'.repeat(64);
const learner: ClinicalRequestContext = { actorPersonId: id(10), organizationId: null as unknown as string, identityPool: 'consumer', identitySubject: 'sub:fictional-unit-learner',
  purpose: 'clinical_data', environment: 'synthetic-staging', dataClassification: 'synthetic_only', containsPhi: false, realPatientData: false };
const curriculum = { versionId: version, version: 1, sourceDigest: 'b'.repeat(64) };
const request: LearnerMediaRequest = { contractVersion: PROGRAM_LEARNER_MEDIA_CONTRACT, entitlementId: entitlement, curriculum, lesson: { phaseId: 'phase-1', itemId: 'lesson-a' }, slot: 0,
  expected: { artifactId: artifact, version: 3, sha256: bytes } };
const TEXT = 'Fictional transcript.';
const grant = (over: Partial<Extract<LearnerMediaDecision, { outcome: 'authorized' }>> = {}): LearnerMediaDecision => ({
  outcome: 'authorized', entitlementId: entitlement, curriculum, admissionId: admission, publicationId: publication, lesson: { phaseId: 'phase-1', itemId: 'lesson-a' }, slot: 0,
  media: { artifactId: artifact, version: 3, sha256: bytes, kind: 'video', contentType: 'video/mp4', bytes: 1024 },
  object: { key: `program-media/${clinic}/${program}/${artifact}/${bytes}.mp4`, version: 'fictional-object-version-1', clinic, programId: program },
  caption: { state: 'none' }, transcript: { state: 'available', source: 'supplied_vendor_file', format: 'plain', sha256: sha(TEXT), text: TEXT }, ...over,
} as LearnerMediaDecision);
const ledgerOf = (...answers: (LearnerMediaDecision | (() => Promise<LearnerMediaDecision>))[]): LearnerMediaLedger & { calls: number } => {
  const l = { calls: 0, forLearner: async () => { const next = answers[Math.min(l.calls, answers.length - 1)]!; l.calls += 1; return typeof next === 'function' ? next() : next; }, forStaff: async () => { throw new Error('not used'); } };
  return l;
};

describe('learner media service', () => {
  it('answers held without an installed storage reader and reads nothing', async () => {
    const ledger = ledgerOf(grant());
    expect(await createLearnerMediaService({ ledger, storage: null })(learner, request)).toEqual({ outcome: 'held' });
    expect(ledger.calls).toBe(0);
  });
  it('refuses a non-consumer caller and an invalid body before the ledger', async () => {
    const ledger = ledgerOf(grant()), service = createLearnerMediaService({ ledger, storage: createFictionalLearnerMediaStorage() });
    await expect(service({ ...learner, identityPool: 'workforce' }, request)).rejects.toMatchObject({ category: 'identity_refused' });
    await expect(service({ ...learner, containsPhi: true as false }, request)).rejects.toMatchObject({ category: 'identity_refused' });
    await expect(service(learner, { ...request, personId: id(99) })).rejects.toMatchObject({ category: 'request_invalid' });
    await expect(service(learner, { ...request, slot: 5 })).rejects.toMatchObject({ category: 'request_invalid' });
    expect(ledger.calls).toBe(0);
  });
  it('serves a grant that answers the request exactly, after deciding twice', async () => {
    const ledger = ledgerOf(grant()), storage = createFictionalLearnerMediaStorage();
    const reply = await createLearnerMediaService({ ledger, storage })(learner, request);
    expect(reply).toMatchObject({ outcome: 'available', transcript: { state: 'available', text: TEXT }, caption: { state: 'none' } });
    expect(ledger.calls).toBe(2);
    expect(storage.issued).toEqual([{ objectKey: `program-media/${clinic}/${program}/${artifact}/${bytes}.mp4`, objectVersion: 'fictional-object-version-1', contentType: 'video/mp4', bytes: 1024, sha256: bytes, clinic, programId: program, artifactId: artifact }]);
  });
  it('says not_available for a refusal and for a grant that is not this request\'s answer, without touching storage', async () => {
    const storage = createFictionalLearnerMediaStorage();
    for (const answer of [{ outcome: 'refused' } as LearnerMediaDecision, grant({ entitlementId: id(40) }), grant({ curriculum: { ...curriculum, version: 2 } }),
      grant({ lesson: { phaseId: 'phase-1', itemId: 'lesson-b' } }), grant({ slot: 1 }), grant({ media: { ...(grant() as { media: never }).media, version: 4 } })]) {
      expect(await createLearnerMediaService({ ledger: ledgerOf(answer), storage })(learner, request)).toEqual({ outcome: 'not_available' });
    }
    expect(storage.issued).toHaveLength(0);
  });
  it('discards the capability when the second decision differs or is refused', async () => {
    const storage = createFictionalLearnerMediaStorage();
    expect(await createLearnerMediaService({ ledger: ledgerOf(grant(), { outcome: 'refused' }), storage })(learner, request)).toEqual({ outcome: 'not_available' });
    expect(await createLearnerMediaService({ ledger: ledgerOf(grant(), grant({ admissionId: id(41) })), storage })(learner, request)).toEqual({ outcome: 'not_available' });
    expect(await createLearnerMediaService({ ledger: ledgerOf(grant(), grant({ object: { ...(grant() as { object: never }).object, version: 'another-version' } })), storage })(learner, request)).toEqual({ outcome: 'not_available' });
    expect(await createLearnerMediaService({ ledger: ledgerOf(grant(), { outcome: 'held' }), storage })(learner, request)).toEqual({ outcome: 'held' });
    expect(storage.issued).toHaveLength(4);
  });
  it('treats a text whose digest does not match, a malformed decision, a storage failure and a bad capability as an outage', async () => {
    const storage = createFictionalLearnerMediaStorage();
    const tampered = grant({ transcript: { state: 'available', source: 'supplied_vendor_file', format: 'plain', sha256: sha(TEXT), text: TEXT + ' (changed)' } });
    await expect(createLearnerMediaService({ ledger: ledgerOf(tampered), storage })(learner, request)).rejects.toMatchObject({ category: 'service_unavailable' });
    await expect(createLearnerMediaService({ ledger: ledgerOf({ outcome: 'authorized' } as LearnerMediaDecision), storage })(learner, request)).rejects.toMatchObject({ category: 'service_unavailable' });
    await expect(createLearnerMediaService({ ledger: { forLearner: async () => { throw new Error('database down'); }, forStaff: async () => { throw new Error('unused'); } }, storage })(learner, request)).rejects.toMatchObject({ category: 'service_unavailable' });
    await expect(createLearnerMediaService({ ledger: ledgerOf(grant()), storage: createFictionalLearnerMediaStorage({ fail: () => true }) })(learner, request)).rejects.toMatchObject({ category: 'service_unavailable' });
    const forged: LearnerMediaStorage = { issue: async () => ({ url: 'https://attacker.example/program-media/x?versionId=1&X-Amz-Expires=300&X-Amz-Signature=' + 'c'.repeat(64), expiresAt: new Date().toISOString() }) };
    await expect(createLearnerMediaService({ ledger: ledgerOf(grant()), storage: forged })(learner, request)).rejects.toMatchObject({ category: 'service_unavailable' });
    const longLived: LearnerMediaStorage = { issue: async () => ({ url: `https://alp-fictional-lessons.s3.us-east-2.amazonaws.com/program-media/x?versionId=1&X-Amz-Expires=86400&X-Amz-Signature=${'c'.repeat(64)}`, expiresAt: new Date().toISOString() }) };
    await expect(createLearnerMediaService({ ledger: ledgerOf(grant()), storage: longLived })(learner, request)).rejects.toMatchObject({ category: 'service_unavailable' });
  });
  it('a storage read past the deadline settles as an outage and its late capability is never returned', async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => undefined;
      const slow = createFictionalLearnerMediaStorage({ before: () => new Promise<void>(resolve => { release = resolve; }) });
      const pending = createLearnerMediaService({ ledger: ledgerOf(grant()), storage: slow, deadlineMs: 1_000 })(learner, request);
      const settled = pending.then(value => ({ value }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(1_001);
      release();
      const outcome = await settled;
      expect('error' in outcome && outcome.error instanceof LearnerMediaError && outcome.error.category).toBe('service_unavailable');
    } finally { vi.useRealTimers(); }
  });
  it('a session that ends while storage is read (the caller\'s live check) gets no capability', async () => {
    let signedIn = true;
    const storage = createFictionalLearnerMediaStorage({ before: () => { signedIn = false; } });
    const service = createLearnerMediaService({ ledger: ledgerOf(grant()), storage });
    await expect(service(learner, request, { assertLive: () => { if (!signedIn) throw new LearnerMediaError('identity_refused'); } })).rejects.toMatchObject({ category: 'identity_refused' });
  });
  it('a request for another course is refused identically to one for no course', async () => {
    const service = createLearnerMediaService({ ledger: ledgerOf({ outcome: 'refused' }), storage: createFictionalLearnerMediaStorage() });
    const a = await service(learner, { ...request, entitlementId: randomUUID() });
    const b = await service(learner, { ...request, lesson: { phaseId: 'phase-9', itemId: 'nothing' } });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe('{"outcome":"not_available"}');
  });
});
