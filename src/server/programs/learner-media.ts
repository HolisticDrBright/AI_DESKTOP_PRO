if (typeof window !== 'undefined') throw new Error('learner media service is server-only');
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { curriculumPin, lessonRef } from '@/contracts/programEducationProgress';
import {
  LEARNER_MEDIA_TEXT_MAX, learnerMediaAnswers, learnerMediaCapabilityShapeValid, learnerMediaReply, learnerMediaRequest, learnerMediaText,
  type LearnerMediaReply, type LearnerMediaRequest, type LearnerMediaText,
} from '@/contracts/programLearnerMedia';
import type { ClinicalRequestContext } from '../clinical-core/aws-identity-consent';

/**
 * Learner lesson media (program-learner-media/1), server side: ONE read of ONE admitted slot, decided
 * at request time and re-decided before anything is returned.
 *
 *   1. The caller is the verified consumer (or, on the staff host, the verified workforce member).
 *      Nothing in the body names a person, a clinic, an object key or an address.
 *   2. Without an installed storage reader the answer is `held`, and nothing is read.
 *   3. The database decides authority by its own clock (BLOCKED candidate
 *      program-media-learner-admission.sql): the caller's own active entitlement and enrollment, the
 *      exact purchased version re-digested, a released lesson, an admitted and unwithdrawn slot
 *      whose reference is exactly what this version carries. Every refusal is one `not_available`.
 *   4. The grant must answer THIS request (course, version, lesson, slot, published identity).
 *   5. Each piece of publication text is re-hashed against the digest recorded with it.
 *   6. The storage reader verifies the exact object version and issues a capability for it alone.
 *   7. Authority is decided AGAIN; a capability issued for a decision that no longer holds (access
 *      ended, slot withdrawn, anything changed while storage was being read) is discarded.
 * One deadline covers 3 to 7. A failure anywhere is `service_unavailable`, never `held` and never
 * "no media"; the written lesson is unaffected by any of it.
 */
export const PROGRAM_MEDIA_LEARNER_ADMISSION_SCHEMA_CANDIDATE_SHA256 = '773f7456122889154e9d767ecc6db45b275414cbe909a0f32e816c2871d440f2';
/** The exact parents the candidate is written against (LF bytes), in apply order. */
export const PROGRAM_MEDIA_LEARNER_ADMISSION_PARENTS = Object.freeze({
  'program-education-catalog-admission.sql': 'eac6f2f1ae0ff2d418da9f7a06b5086d50ba46374f31961726fd52fa0530ba1d',
  'program-media-ledger.sql': '6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d',
  'program-media-settlement.sql': '74f54bbb72539218dc6d12098a1773da572f4eb9230faae10010f69d5c95ff04',
  'program-media-native-ledger.sql': '69eb187cd22500014c1b79bf5dfdc7577e1c18376f30197eded0804f9114a6d7',
  'program-media-multipart.sql': 'a9b2a38d76f7a07569ed94342cc53a7810c6480ba6f28e0a24297265e9f70092',
  'program-commerce-runtime-sessions.sql': 'd2142ad80fead07f83fa23636434274037c87ebad91fa1ce59988ab973b2c037',
});
export const LEARNER_MEDIA_DEADLINE_MS = 20_000;
/** The consumer API route the V2 learner reader posts to; served by the education API function. */
export const LEARNER_MEDIA_ROUTE_SEAM = Object.freeze({ route: 'POST /clinical-core/consumer/education/media', contract: 'program-learner-media/1' });

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const contentType = z.enum(['video/mp4', 'video/webm', 'image/png', 'image/jpeg', 'image/webp']);
/** What the database grants: the slot, its object (for the storage reader only) and the publication's text. */
const grantBody = {
  admissionId: uuid, publicationId: uuid, lesson: lessonRef, slot: z.number().int().min(0).max(4),
  media: z.object({ artifactId: uuid, version: z.number().int().safe().min(1), sha256: digest, kind: z.enum(['video', 'image']), contentType, bytes: z.number().int().safe().min(1).max(268_435_456) }).strict(),
  object: z.object({ key: z.string().min(1).max(512), version: z.string().min(1).max(1024).refine(v => v !== 'null'), clinic: uuid, programId: uuid }).strict(),
  caption: learnerMediaText, transcript: learnerMediaText,
};
export const learnerMediaGrant = z.object({ outcome: z.literal('authorized'), entitlementId: uuid, curriculum: curriculumPin, ...grantBody }).strict();
export const staffMediaGrant = z.object({ outcome: z.literal('authorized'), curriculum: z.object({ versionId: uuid, version: z.number().int().min(1) }).strict(), ...grantBody }).strict();
const decision = <G extends z.ZodTypeAny>(grant: G) => z.union([grant, z.object({ outcome: z.literal('held') }).strict(), z.object({ outcome: z.literal('refused') }).strict()]);
export const learnerMediaDecision = decision(learnerMediaGrant);
export const staffMediaDecision = decision(staffMediaGrant);
export type LearnerMediaGrant = z.infer<typeof learnerMediaGrant>;
export type StaffMediaGrant = z.infer<typeof staffMediaGrant>;
export type LearnerMediaDecision = z.infer<typeof learnerMediaDecision>;
export type StaffMediaDecision = z.infer<typeof staffMediaDecision>;

export type LessonSlot = { lesson: { phaseId: string; itemId: string }; slot: number };
/** The database's answer, through the reviewed functions only. */
export interface LearnerMediaLedger {
  forLearner(context: ClinicalRequestContext, entitlementId: string, at: LessonSlot): Promise<LearnerMediaDecision>;
  forStaff(context: ClinicalRequestContext, versionId: string, at: LessonSlot): Promise<StaffMediaDecision>;
}
export type LearnerMediaObject = {
  objectKey: string; objectVersion: string; contentType: z.infer<typeof contentType>; bytes: number; sha256: string;
  clinic: string; programId: string; artifactId: string;
};
/** The installed storage reader: verifies ONE exact object version and issues a capability for it alone. */
export interface LearnerMediaStorage {
  issue(object: LearnerMediaObject, signal: AbortSignal, assertLive: () => void): Promise<{ url: string; expiresAt: string }>;
}
export class LearnerMediaError extends Error {
  constructor(readonly category: 'request_invalid' | 'identity_refused' | 'service_unavailable') { super(category); this.name = 'LearnerMediaError'; }
}
export type LearnerMediaLive = { assertLive?: () => void };

const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
function verifiedText(text: LearnerMediaText): LearnerMediaText {
  if (text.state !== 'available') return text;
  if (text.text.length > LEARNER_MEDIA_TEXT_MAX || sha(text.text) !== text.sha256) throw new LearnerMediaError('service_unavailable');
  return text;
}
const sameGrant = (a: { admissionId: string; publicationId: string; object: { key: string; version: string }; media: { sha256: string } }, b: typeof a) =>
  a.admissionId === b.admissionId && a.publicationId === b.publicationId && a.object.key === b.object.key && a.object.version === b.object.version && a.media.sha256 === b.media.sha256;
const grantAnswers = (request: LearnerMediaRequest, grant: LearnerMediaGrant) => grant.entitlementId === request.entitlementId
  && grant.curriculum.versionId === request.curriculum.versionId && grant.curriculum.version === request.curriculum.version
  && grant.curriculum.sourceDigest === request.curriculum.sourceDigest
  && grant.lesson.phaseId === request.lesson.phaseId && grant.lesson.itemId === request.lesson.itemId && grant.slot === request.slot
  && grant.media.artifactId === request.expected.artifactId && grant.media.version === request.expected.version && grant.media.sha256 === request.expected.sha256;
const consumerContext = (c: ClinicalRequestContext) => c.identityPool === 'consumer' && c.purpose === 'clinical_data' && c.environment === 'synthetic-staging'
  && c.dataClassification === 'synthetic_only' && c.containsPhi === false && c.realPatientData === false;
const workforceContext = (c: ClinicalRequestContext) => c.identityPool === 'workforce' && c.purpose === 'clinical_data' && c.environment === 'synthetic-staging'
  && c.dataClassification === 'synthetic_only' && c.containsPhi === false && c.realPatientData === false;

/** One deadline over the decision, the storage read and the re-decision; the abort reaches every await that honours it. */
async function withinDeadline<T>(ms: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new LearnerMediaError('service_unavailable')); }, ms); });
  const work = task(controller.signal);
  work.catch(() => undefined);
  try { return await Promise.race([work, expired]); }
  finally { clearTimeout(timer); }
}

type Grantable = { admissionId: string; publicationId: string; media: LearnerMediaGrant['media']; object: LearnerMediaGrant['object']; caption: LearnerMediaText; transcript: LearnerMediaText };
async function issueFor(storage: LearnerMediaStorage, grant: Grantable, signal: AbortSignal, live: LearnerMediaLive) {
  const caption = verifiedText(grant.caption), transcript = verifiedText(grant.transcript);
  const assertLive = () => { if (signal.aborted) throw new LearnerMediaError('service_unavailable'); live.assertLive?.(); };
  let playback: { url: string; expiresAt: string };
  try {
    playback = await storage.issue({
      objectKey: grant.object.key, objectVersion: grant.object.version, contentType: grant.media.contentType, bytes: grant.media.bytes,
      sha256: grant.media.sha256, clinic: grant.object.clinic, programId: grant.object.programId, artifactId: grant.media.artifactId,
    }, signal, assertLive);
  } catch (error) { if (error instanceof LearnerMediaError) throw error; throw new LearnerMediaError('service_unavailable'); }
  assertLive();
  if (!learnerMediaCapabilityShapeValid(playback.url) || !z.string().datetime({ offset: true }).safeParse(playback.expiresAt).success) throw new LearnerMediaError('service_unavailable');
  return { playback, caption, transcript };
}

export function createLearnerMediaService(deps: { ledger: LearnerMediaLedger; storage: LearnerMediaStorage | null; deadlineMs?: number }) {
  const deadline = deps.deadlineMs ?? LEARNER_MEDIA_DEADLINE_MS;
  return async (context: ClinicalRequestContext, body: unknown, live: LearnerMediaLive = {}): Promise<LearnerMediaReply> => {
    if (!consumerContext(context)) throw new LearnerMediaError('identity_refused');
    let request: LearnerMediaRequest;
    try { request = learnerMediaRequest.parse(body); } catch { throw new LearnerMediaError('request_invalid'); }
    const storage = deps.storage;
    if (!storage) return { outcome: 'held' };
    const at = { lesson: request.lesson, slot: request.slot };
    const decide = async () => {
      let raw: unknown;
      try { raw = await deps.ledger.forLearner(context, request.entitlementId, at); } catch (error) { throw error instanceof LearnerMediaError ? error : new LearnerMediaError('service_unavailable'); }
      const parsed = learnerMediaDecision.safeParse(raw);
      if (!parsed.success) throw new LearnerMediaError('service_unavailable');
      return parsed.data;
    };
    return withinDeadline(deadline, async signal => {
      const first = await decide();
      if (first.outcome === 'held') return { outcome: 'held' } as const;
      if (first.outcome === 'refused') return { outcome: 'not_available' } as const;
      // The grant must be for exactly what the device asked about; anything else is not this request's answer.
      if (!grantAnswers(request, first)) return { outcome: 'not_available' } as const;
      const issued = await issueFor(storage, first, signal, live);
      const again = await decide();
      if (again.outcome !== 'authorized' || !sameGrant(first, again) || again.entitlementId !== first.entitlementId) {
        return again.outcome === 'held' ? { outcome: 'held' } as const : { outcome: 'not_available' } as const;
      }
      live.assertLive?.();
      const reply = learnerMediaReply.safeParse({
        outcome: 'available', entitlementId: first.entitlementId, curriculum: first.curriculum, lesson: first.lesson, slot: first.slot, media: first.media, ...issued,
      });
      if (!reply.success || !learnerMediaAnswers(request, reply.data)) throw new LearnerMediaError('service_unavailable');
      return reply.data;
    });
  };
}

/* -------------------------------------------------------------- the staff host's read */

/** A clinician viewing an admitted slot of a published version of their OWN clinic's program. Not an author preview, not learner progress. */
export const staffMediaRequest = z.object({
  contractVersion: z.literal('program-learner-media-staff/1'),
  curriculum: z.object({ versionId: uuid, version: z.number().int().min(1) }).strict(),
  lesson: lessonRef, slot: z.number().int().min(0).max(4),
  expected: z.object({ artifactId: uuid, version: z.number().int().safe().min(1), sha256: digest }).strict(),
}).strict();
export type StaffMediaRequest = z.infer<typeof staffMediaRequest>;
export type StaffMediaReply =
  | { outcome: 'held' } | { outcome: 'not_available' }
  | { outcome: 'available'; curriculum: StaffMediaRequest['curriculum']; lesson: StaffMediaRequest['lesson']; slot: number; media: LearnerMediaGrant['media']; playback: { url: string; expiresAt: string }; caption: LearnerMediaText; transcript: LearnerMediaText };

export function createStaffMediaService(deps: { ledger: LearnerMediaLedger; storage: LearnerMediaStorage | null; deadlineMs?: number }) {
  const deadline = deps.deadlineMs ?? LEARNER_MEDIA_DEADLINE_MS;
  return async (context: ClinicalRequestContext, body: unknown, live: LearnerMediaLive = {}): Promise<StaffMediaReply> => {
    if (!workforceContext(context) || !context.organizationId) throw new LearnerMediaError('identity_refused');
    let request: StaffMediaRequest;
    try { request = staffMediaRequest.parse(body); } catch { throw new LearnerMediaError('request_invalid'); }
    const storage = deps.storage;
    if (!storage) return { outcome: 'held' };
    const at = { lesson: request.lesson, slot: request.slot };
    const decide = async () => {
      let raw: unknown;
      try { raw = await deps.ledger.forStaff(context, request.curriculum.versionId, at); } catch (error) { throw error instanceof LearnerMediaError ? error : new LearnerMediaError('service_unavailable'); }
      const parsed = staffMediaDecision.safeParse(raw);
      if (!parsed.success) throw new LearnerMediaError('service_unavailable');
      return parsed.data;
    };
    return withinDeadline(deadline, async signal => {
      const first = await decide();
      if (first.outcome === 'held') return { outcome: 'held' } as const;
      if (first.outcome === 'refused') return { outcome: 'not_available' } as const;
      if (first.curriculum.versionId !== request.curriculum.versionId || first.curriculum.version !== request.curriculum.version
        || first.lesson.phaseId !== request.lesson.phaseId || first.lesson.itemId !== request.lesson.itemId || first.slot !== request.slot
        || first.media.artifactId !== request.expected.artifactId || first.media.version !== request.expected.version || first.media.sha256 !== request.expected.sha256) {
        return { outcome: 'not_available' } as const;
      }
      const issued = await issueFor(storage, first, signal, live);
      const again = await decide();
      if (again.outcome !== 'authorized' || !sameGrant(first, again)) return again.outcome === 'held' ? { outcome: 'held' } as const : { outcome: 'not_available' } as const;
      live.assertLive?.();
      return { outcome: 'available', curriculum: request.curriculum, lesson: first.lesson, slot: first.slot, media: first.media, ...issued };
    });
  };
}
