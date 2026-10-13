import { z } from 'zod';
import { curriculumPin, lessonRef } from './programEducationProgress';
import { programLessonNativeMedia, type ProgramLessonMediaReference } from './programLessonMedia';

/**
 * Learner lesson media (program-learner-media/1): one read of one admitted media slot of one lesson
 * of the exact course version a learner bought, and nothing more.
 *
 * The request names the course the device has open (entitlement, the purchased curriculum pin, the
 * lesson, the slot) and the published identity it is rendering (artifact, version, bytes). It names
 * no person, clinic, object key or address: the server resolves the learner from the verified
 * session and decides, at request time, whether this learner may read this slot of this version.
 *
 * Answers:
 *   available      the server verified the object and issued a short-lived playback capability for
 *                  that ONE exact object version, plus the publication's own caption and transcript
 *                  text when it was captured with the publication. The capability is a bearer URL:
 *                  it is never stored, logged, cached or put in a curriculum, and it is dropped the
 *                  moment the learner's access ends on the device.
 *   held           learner media delivery is not enabled on the service. The written lesson stands.
 *   not_available  this learner may not read this slot now. One answer for every reason (another
 *                  learner's course, another clinic, a newer version not bought, a withdrawn or
 *                  superseded publication, ended or revoked access), so a refusal reveals nothing.
 * A failure to answer is not an answer: the transport reports it as unavailable, never as held or
 * as "no media".
 *
 * Text is the publication's: `available` carries the exact text published with this version and its
 * digest; `none` means the publication had no such text; `unavailable` means it had one but no
 * trustworthy copy of that version's text exists (publications recorded before text capture), and
 * nothing current is substituted.
 *
 * This file is mirrored byte for byte into the consumer app.
 */
export const PROGRAM_LEARNER_MEDIA_CONTRACT = 'program-learner-media/1' as const;
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const LEARNER_MEDIA_TEXT_MAX = 200_000;
/** The longest capability the server issues: an exact-version signed GET with temporary credentials. */
export const LEARNER_MEDIA_CAPABILITY_MAX = 16_384;
/** How long a capability lives at most, in seconds. */
export const LEARNER_MEDIA_CAPABILITY_SECONDS = 300;

export const learnerMediaRequest = z.object({
  contractVersion: z.literal(PROGRAM_LEARNER_MEDIA_CONTRACT),
  entitlementId: uuid,
  curriculum: curriculumPin,
  lesson: lessonRef,
  slot: z.number().int().min(0).max(4),
  expected: z.object({ artifactId: uuid, version: z.number().int().safe().min(1), sha256: digest }).strict(),
}).strict();
export type LearnerMediaRequest = z.infer<typeof learnerMediaRequest>;

export const learnerMediaText = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('available'),
    source: z.enum(['supplied_by_author', 'supplied_vendor_file']),
    format: z.enum(['plain', 'vtt']),
    sha256: digest,
    text: z.string().min(1).max(LEARNER_MEDIA_TEXT_MAX),
  }).strict(),
  z.object({ state: z.literal('none') }).strict(),
  z.object({ state: z.literal('unavailable') }).strict(),
]);
export type LearnerMediaText = z.infer<typeof learnerMediaText>;

/** The playback capability's shape: https to one regional bucket host, exact version, no credentials, port or fragment. */
export function learnerMediaCapabilityShapeValid(url: string): boolean {
  if (url.length > LEARNER_MEDIA_CAPABILITY_MAX) return false;
  try {
    const u = new URL(url), q = u.searchParams;
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash
      && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.s3\.us-east-2\.amazonaws\.com$/.test(u.hostname)
      && u.pathname.startsWith('/program-media/')
      && q.getAll('versionId').length === 1 && (q.get('versionId') ?? '').length > 0 && q.get('versionId') !== 'null'
      && q.getAll('X-Amz-Expires').length === 1 && Number(q.get('X-Amz-Expires')) > 0 && Number(q.get('X-Amz-Expires')) <= LEARNER_MEDIA_CAPABILITY_SECONDS
      && q.getAll('X-Amz-Signature').length === 1 && /^[a-f0-9]{64}$/.test(q.get('X-Amz-Signature') ?? '');
  } catch { return false; }
}

const available = z.object({
  outcome: z.literal('available'),
  entitlementId: uuid,
  curriculum: curriculumPin,
  lesson: lessonRef,
  slot: z.number().int().min(0).max(4),
  media: z.object({
    artifactId: uuid, version: z.number().int().safe().min(1), sha256: digest,
    kind: z.enum(['video', 'image']),
    contentType: z.enum(['video/mp4', 'video/webm', 'image/png', 'image/jpeg', 'image/webp']),
    bytes: z.number().int().safe().min(1).max(268_435_456),
  }).strict(),
  playback: z.object({ url: z.string().max(LEARNER_MEDIA_CAPABILITY_MAX), expiresAt: z.string().datetime({ offset: true }) }).strict(),
  caption: learnerMediaText,
  transcript: learnerMediaText,
}).strict().superRefine((reply, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if ((reply.media.kind === 'video') !== reply.media.contentType.startsWith('video/')) fail('learner_media_kind_mismatch');
  if (reply.media.kind === 'image' && (reply.transcript.state !== 'none' || reply.media.bytes > 16_777_216)) fail('learner_media_image_invalid');
  if (!learnerMediaCapabilityShapeValid(reply.playback.url)) fail('learner_media_capability_invalid');
});
export const learnerMediaReply = z.union([
  available,
  z.object({ outcome: z.literal('held') }).strict(),
  z.object({ outcome: z.literal('not_available') }).strict(),
]);
export type LearnerMediaReply = z.infer<typeof learnerMediaReply>;
export type LearnerMediaAvailable = Extract<LearnerMediaReply, { outcome: 'available' }>;

/** Whether an available reply answers exactly this request: the same course, version, lesson, slot and published identity. */
export function learnerMediaAnswers(request: LearnerMediaRequest, reply: LearnerMediaReply): boolean {
  if (reply.outcome !== 'available') return true;
  return reply.entitlementId === request.entitlementId
    && reply.curriculum.versionId === request.curriculum.versionId && reply.curriculum.version === request.curriculum.version
    && reply.curriculum.sourceDigest === request.curriculum.sourceDigest
    && reply.lesson.phaseId === request.lesson.phaseId && reply.lesson.itemId === request.lesson.itemId && reply.slot === request.slot
    && reply.media.artifactId === request.expected.artifactId && reply.media.version === request.expected.version
    && reply.media.sha256 === request.expected.sha256;
}

/**
 * The native media references one lesson of a served curriculum carries, in slot order: [] when it
 * carries none, null when the lesson cannot be found once or its references do not parse (then no
 * media is requested and the written lesson stands). The reference is identity only; nothing in it
 * is fetched.
 */
export function lessonMediaReferences(phases: unknown, lesson: { phaseId: string; itemId: string }): ProgramLessonMediaReference[] | null {
  if (!Array.isArray(phases)) return null;
  const found: unknown[] = [];
  for (const phase of phases) {
    if (!phase || typeof phase !== 'object' || (phase as { id?: unknown }).id !== lesson.phaseId) continue;
    const items = (phase as { items?: unknown }).items;
    if (!Array.isArray(items)) continue;
    for (const item of items) if (item && typeof item === 'object' && (item as { id?: unknown }).id === lesson.itemId) found.push(item);
  }
  if (found.length !== 1) return null;
  const native = (found[0] as { nativeMedia?: unknown }).nativeMedia;
  if (native === undefined) return [];
  const parsed = programLessonNativeMedia.safeParse(native);
  return parsed.success ? parsed.data : null;
}
