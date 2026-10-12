import { z } from 'zod';

/**
 * Education progress (program-education-progress/1): a learner's own bookkeeping through the exact
 * course version they bought, and nothing more.
 *
 * Progress is not a clinical check-in, not a practitioner-controlled phase, not a supplement start
 * and not protocol adoption. It belongs to one enrollment of one active entitlement, and it names
 * lessons by the stable phase and item ids of the purchased curriculum version, pinned by version
 * id, number and digest. A lesson is completed only when the learner explicitly marks it; opening a
 * page records a resume position at most, never a completion. A supplement step is never completed
 * here: it is reviewed on My programs before anything is added.
 *
 * Every write carries the revision the device last read and a request id the device generated. The
 * same request id always answers with the same receipt, so a retry after a lost reply converges on
 * one recorded result. A write against an older revision is refused with the current progress, so a
 * second device can show what the first one recorded instead of overwriting it. A device shows a
 * completion as saved only after a receipt; until then it is pending, and a failure is a failure.
 *
 * This file is mirrored byte for byte into the consumer app.
 */
export const PROGRAM_EDUCATION_PROGRESS_CONTRACT = 'program-education-progress/1' as const;
const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
/** The stable id the curriculum gives a phase or an item; the same pattern the published content enforces. */
const stableId = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);

export const curriculumPin = z.object({ versionId: uuid, version: z.number().int().min(1), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type CurriculumPin = z.infer<typeof curriculumPin>;
export const lessonRef = z.object({ phaseId: stableId, itemId: stableId }).strict();
export type LessonRef = z.infer<typeof lessonRef>;

/** The item kinds a learner may mark complete. A supplement step is never one of them. */
export const COMPLETABLE_KINDS = ['lesson', 'diet', 'habit'] as const;
/** Upper bounds: the published content allows 52 phases of 100 items. */
export const MAX_LESSONS = 5200;

export const lessonCompletion = z.object({ lesson: lessonRef, completedAt: timestamp, requestId: uuid }).strict();
export type LessonCompletion = z.infer<typeof lessonCompletion>;

export const educationProgress = z.object({
  contract: z.literal(PROGRAM_EDUCATION_PROGRESS_CONTRACT),
  entitlementId: uuid,
  enrollmentId: uuid,
  curriculum: curriculumPin,
  /** 0 until the first write; every recorded write raises it by one. */
  revision: z.number().int().min(0),
  completed: z.array(lessonCompletion).max(MAX_LESSONS),
  /** Where the learner last was, as recorded; null until a position is recorded. */
  position: lessonRef.nullable(),
  updatedAt: timestamp.nullable(),
}).strict();
export type EducationProgress = z.infer<typeof educationProgress>;

const write = { entitlementId: uuid, enrollmentId: uuid, curriculum: curriculumPin, lesson: lessonRef, expectedRevision: z.number().int().min(0), requestId: uuid };
export const educationProgressRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read'), entitlementId: uuid }).strict(),
  /** The learner explicitly marked this lesson complete. */
  z.object({ action: z.literal('complete'), ...write }).strict(),
  /** The learner is on this lesson now; a resume point, never a completion. */
  z.object({ action: z.literal('position'), ...write }).strict(),
]);
export type EducationProgressRequest = z.infer<typeof educationProgressRequest>;

/** `request_conflict`: this request id already recorded a different write; a request id names exactly one write. */
export const PROGRESS_REFUSALS = ['not_owner', 'not_active', 'enrollment_mismatch', 'stale_version', 'unknown_lesson', 'not_completable', 'revision_stale', 'request_conflict', 'service_unavailable'] as const;
export type ProgressRefusal = (typeof PROGRESS_REFUSALS)[number];

/** The authoritative answer to one write: what was recorded, under which request id, at which revision. */
export const progressReceipt = z.object({
  requestId: uuid, action: z.enum(['complete', 'position']), lesson: lessonRef, recordedAt: timestamp, revision: z.number().int().min(1),
}).strict();
export type ProgressReceipt = z.infer<typeof progressReceipt>;

export const educationProgressRead = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('read'), progress: educationProgress }).strict(),
  z.object({ outcome: z.literal('refused'), reason: z.enum(PROGRESS_REFUSALS) }).strict(),
]);
export type EducationProgressRead = z.infer<typeof educationProgressRead>;
export const educationProgressOutcome = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('recorded'), receipt: progressReceipt, progress: educationProgress }).strict(),
  /** `progress` is the current record when the refusal is about the record (a stale revision); null otherwise. */
  z.object({ outcome: z.literal('refused'), reason: z.enum(PROGRESS_REFUSALS), progress: educationProgress.nullable() }).strict(),
]);
export type EducationProgressOutcome = z.infer<typeof educationProgressOutcome>;

/* ------------------------------------------------------- course navigation */

const servedItem = z.object({ id: stableId, title: z.string().min(1).max(240), kind: z.enum(['lesson', 'diet', 'habit', 'supplement']), instructions: z.string().max(4000), released: z.boolean() }).passthrough();
const servedPhase = z.object({ id: stableId, title: z.string().min(1).max(240), items: z.array(z.unknown()).max(100) }).passthrough();

export type CourseLesson = {
  ref: LessonRef; phaseIndex: number; itemIndex: number; phaseTitle: string;
  title: string; kind: (typeof COMPLETABLE_KINDS)[number] | 'supplement'; instructions: string; released: boolean; completable: boolean;
};

/**
 * The lessons of a served curriculum, in order. Anything that does not have the published shape is
 * left out rather than guessed at; `complete` says whether everything was readable, so a screen can
 * say a part of the course could not be shown instead of presenting a shorter course as the whole.
 */
export function courseLessons(phases: readonly unknown[]): { lessons: CourseLesson[]; complete: boolean } {
  const lessons: CourseLesson[] = [];
  let complete = true;
  phases.forEach((rawPhase, phaseIndex) => {
    const phase = servedPhase.safeParse(rawPhase);
    if (!phase.success) { complete = false; return; }
    phase.data.items.forEach((rawItem, itemIndex) => {
      const item = servedItem.safeParse(rawItem);
      if (!item.success) { complete = false; return; }
      const kind = item.data.kind;
      lessons.push({
        ref: { phaseId: phase.data.id, itemId: item.data.id }, phaseIndex, itemIndex, phaseTitle: phase.data.title,
        title: item.data.title, kind, instructions: item.data.instructions, released: item.data.released,
        completable: item.data.released && (COMPLETABLE_KINDS as readonly string[]).includes(kind),
      });
    });
  });
  return { lessons, complete };
}

export const sameLesson = (a: LessonRef | null | undefined, b: LessonRef | null | undefined) => !!a && !!b && a.phaseId === b.phaseId && a.itemId === b.itemId;

export function neighbours(lessons: readonly CourseLesson[], ref: LessonRef): { previous: CourseLesson | null; next: CourseLesson | null } {
  const index = lessons.findIndex(lesson => sameLesson(lesson.ref, ref));
  if (index < 0) return { previous: null, next: null };
  return { previous: lessons[index - 1] ?? null, next: lessons[index + 1] ?? null };
}

export const isCompleted = (progress: Pick<EducationProgress, 'completed'> | null, ref: LessonRef) => !!progress?.completed.some(entry => sameLesson(entry.lesson, ref));

/**
 * Where to resume: the recorded position while it is still a lesson of this version; otherwise the
 * first released lesson not yet completed; otherwise the first lesson. Null for an empty course.
 */
export function resumeLesson(lessons: readonly CourseLesson[], progress: Pick<EducationProgress, 'completed' | 'position'> | null): CourseLesson | null {
  if (!lessons.length) return null;
  const recorded = progress?.position ? lessons.find(lesson => sameLesson(lesson.ref, progress.position)) : undefined;
  if (recorded) return recorded;
  return lessons.find(lesson => lesson.completable && !isCompleted(progress, lesson.ref)) ?? lessons[0]!;
}
