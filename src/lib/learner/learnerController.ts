import { isAccessActive, type EducationAccessView, type EducationCurriculumRead, type EducationEnrollment, type ProgramEntitlement } from '@/contracts/programEducationAccess';
import { courseLessons, sameLesson, type EducationProgress, type EducationProgressRequest, type LessonRef, type ProgressRefusal } from '@/contracts/programEducationProgress';
import { LearnerTransportError, type LearnerHostKind, type LearnerTransport, type ProgressBinding } from './learnerTransport';

/**
 * My courses, the page's lifecycle without the page: what is shown, and when it is cleared.
 *
 *   - Nothing private is held before the service has answered for this learner, and everything
 *     private (the access view, the course, its lessons, progress, a pending save) is dropped at
 *     once on a sign-in or access refusal, on a change of account, or when another course is opened.
 *   - Every asynchronous answer belongs to a generation; an answer from an earlier generation is
 *     discarded unread. One operation runs at a time.
 *   - Reads and writes name the course they are for (entitlement, enrollment, purchased pin).
 *   - A completion is shown as saved only after the service's receipt. A failed save says it was
 *     not saved and can be retried with the same request, which the service answers once. A save
 *     that is behind (another tab or device moved on) shows the saved progress, never a merge.
 *   - Returning to the page re-reads access, the course and progress from the service.
 * An empty course list and an unavailable service are different things, and are said differently.
 */
export type WriteCommand = Extract<EducationProgressRequest, { action: 'complete' | 'position' }>;
export type ProgressState = { state: 'none' } | { state: 'ready'; progress: EducationProgress } | { state: 'unavailable' } | { state: 'refused'; reason: ProgressRefusal };
export type LearnerSnapshot = {
  phase: 'loading' | 'ready' | 'signin' | 'host_unavailable' | 'unavailable';
  host: LearnerHostKind | null;
  view: EducationAccessView | null;
  course: { entitlement: ProgramEntitlement; read: EducationCurriculumRead } | null;
  outline: ReturnType<typeof courseLessons> | null;
  progress: ProgressState;
  lesson: LessonRef | null;
  pending: { command: WriteCommand; state: 'saving' | 'unsaved' } | null;
  busy: boolean;
  error: string;
  notice: string;
  placeNote: string;
};
const empty = (phase: LearnerSnapshot['phase']): LearnerSnapshot => ({ phase, host: null, view: null, course: null, outline: null, progress: { state: 'none' }, lesson: null, pending: null, busy: false, error: '', notice: '', placeNote: '' });

export function readBinding(entitlement: ProgramEntitlement, enrollments: readonly EducationEnrollment[]): ProgressBinding {
  const mine = enrollments.filter(enrollment => enrollment.entitlementId === entitlement.entitlementId);
  return { entitlementId: entitlement.entitlementId, enrollmentId: mine.length === 1 ? mine[0]!.enrollmentId : null, curriculum: entitlement.curriculum };
}

export function createLearnerController(deps: { transport: LearnerTransport; requestId: () => string; now?: () => Date; onChange: (snapshot: LearnerSnapshot) => void }) {
  let snapshot = empty('loading');
  let generation = 0, working = false, lastOpened: string | null = null, subject: string | null = null, disposed = false;
  const now = deps.now ?? (() => new Date());
  const emit = (next: Partial<LearnerSnapshot>) => { if (disposed) return; snapshot = { ...snapshot, ...next }; deps.onChange(snapshot); };
  /** Drop everything private and start a new generation: nothing in flight may commit after this. */
  const clear = (phase: LearnerSnapshot['phase'], error = '') => { generation += 1; working = false; snapshot = { ...empty(phase), host: snapshot.host, error }; if (!disposed) deps.onChange(snapshot); };

  async function run(work: (current: () => boolean) => Promise<void>) {
    if (working || disposed) return;
    const mine = generation; working = true;
    const current = () => !disposed && generation === mine;
    emit({ busy: true, error: '', notice: '' });
    try { await work(current); }
    catch (cause) {
      if (!current()) return;
      const reason = cause instanceof LearnerTransportError ? cause.reason : 'unavailable';
      if (reason === 'signin') { lastOpened = null; subject = null; clear('signin', 'Sign in with your course account to see your courses.'); return; }
      if (reason === 'access') { lastOpened = null; subject = null; clear('signin', 'Access changed. Sign in again to see your courses.'); return; }
      if (reason === 'host_unavailable') { clear('host_unavailable'); return; }
      if (reason === 'invalid') emit({ error: 'The course service did not accept this request. Nothing was changed.' });
      else emit({ phase: snapshot.view ? snapshot.phase : 'unavailable', error: 'Your courses are unavailable right now. This does not mean you have none; try again to check.' });
    } finally { if (current()) { working = false; emit({ busy: false }); } }
  }

  /** Accept an access view only for the account this page has been showing; another account starts over. */
  const adopt = (view: EducationAccessView): boolean => {
    if (subject !== null && view.consumerSubject !== subject) { lastOpened = null; subject = null; clear('loading', 'A different account is signed in now. Its courses are read fresh.'); return false; }
    subject = view.consumerSubject;
    return true;
  };

  async function openCourse(entitlement: ProgramEntitlement, enrollments: readonly EducationEnrollment[], current: () => boolean) {
    // Opening another course drops the previous one first, so nothing of it can be shown under the new title.
    emit({ course: null, outline: null, lesson: null, pending: null, placeNote: '', progress: { state: 'none' } });
    const { read, host } = await deps.transport.curriculum(entitlement.entitlementId, entitlement.curriculum);
    if (!current()) return;
    lastOpened = entitlement.entitlementId;
    emit({ host, course: { entitlement, read }, outline: read.outcome === 'served' ? courseLessons(read.phases) : null });
    if (read.outcome !== 'served') return;
    try {
      const { reply } = await deps.transport.progress({ action: 'read', entitlementId: entitlement.entitlementId }, readBinding(entitlement, enrollments));
      if (!current() || reply.action !== 'read') return;
      emit({ progress: reply.read.outcome === 'read' ? { state: 'ready', progress: reply.read.progress } : { state: 'refused', reason: reply.read.reason } });
    } catch (cause) {
      if (cause instanceof LearnerTransportError && (cause.reason === 'signin' || cause.reason === 'access' || cause.reason === 'host_unavailable')) throw cause;
      if (current()) emit({ progress: { state: 'unavailable' } });
    }
  }

  const refresh = (reopen = false) => run(async current => {
    emit({ course: null, outline: null, lesson: null, progress: { state: 'none' }, pending: null, placeNote: '' });
    const { view, host } = await deps.transport.access();
    if (!current() || !adopt(view)) return;
    emit({ phase: 'ready', host, view });
    const again = reopen ? view.entitlements.find(e => e.entitlementId === lastOpened && isAccessActive(e, now())) : undefined;
    if (again) await openCourse(again, view.enrollments, current);
  });

  const usable = () => snapshot.outline !== null && snapshot.outline.problem !== 'ambiguous' && snapshot.outline.problem !== 'oversized';
  const ready = () => (snapshot.progress.state === 'ready' ? snapshot.progress.progress : null);

  /** A lesson of the readable outline; a completion must also be completable there. */
  const inOutline = (target: LessonRef, completable = false) => (snapshot.outline?.lessons ?? []).some(entry => sameLesson(entry.ref, target) && (!completable || entry.completable));

  const send = (command: WriteCommand) => run(async current => {
    const course = snapshot.course, saved = ready();
    if (!course || !saved) return;
    const isComplete = command.action === 'complete';
    // Access is checked when the write is sent, not when its button was drawn: a window that lapsed in between, or a
    // retry of an earlier command, sends nothing. Only a lesson of the readable outline is ever named.
    if (!isAccessActive(course.entitlement, now())) { if (isComplete) emit({ pending: null, error: progressRefusalMessage('not_active') }); return; }
    if (!inOutline(command.lesson, isComplete)) { if (isComplete) emit({ pending: null }); return; }
    const binding: ProgressBinding = { entitlementId: course.entitlement.entitlementId, enrollmentId: saved.enrollmentId, curriculum: course.entitlement.curriculum };
    if (isComplete) emit({ pending: { command, state: 'saving' } });
    let reply;
    try { ({ reply } = await deps.transport.progress(command, binding)); }
    catch (cause) {
      if (!current()) return;
      if (cause instanceof LearnerTransportError && (cause.reason === 'signin' || cause.reason === 'access' || cause.reason === 'host_unavailable')) throw cause;
      if (isComplete) emit({ pending: { command, state: 'unsaved' }, error: 'Not saved: the course service could not be reached. The lesson is not marked complete; try again.' });
      else emit({ placeNote: 'Your place in the course could not be saved just now.' });
      return;
    }
    if (!current() || reply.action === 'read') return;
    const outcome = reply.outcome;
    if (outcome.outcome === 'recorded') {
      emit({ progress: { state: 'ready', progress: outcome.progress }, placeNote: '', ...(isComplete ? { pending: null, notice: 'Marked complete. Saved for this account.' } : {}) });
      return;
    }
    if (outcome.reason === 'revision_stale' && outcome.progress) {
      emit({ progress: { state: 'ready', progress: outcome.progress }, ...(isComplete ? { pending: null, notice: 'This course was updated in another tab or on another device. Your progress is shown as it is saved now; nothing from here was added.' } : {}) });
      return;
    }
    if (outcome.reason === 'not_active' || outcome.reason === 'not_owner') {
      // Access ended (revoked, expired, refunded) or the course is someone else's: the lesson closes, nothing of it
      // stays, and the access view is read again so the course is listed as it now stands.
      lastOpened = null;
      emit({ course: null, outline: null, lesson: null, pending: null, placeNote: '', progress: { state: 'none' }, error: progressRefusalMessage(outcome.reason) });
      const { view, host } = await deps.transport.access();
      if (current() && adopt(view)) emit({ phase: 'ready', host, view });
      return;
    }
    if (isComplete) emit({ pending: null, error: progressRefusalMessage(outcome.reason) });
    else emit({ placeNote: progressRefusalMessage(outcome.reason) });
  });

  return {
    snapshot: () => snapshot,
    start: () => refresh(),
    refresh: () => refresh(),
    /**
     * The page is visible again: read everything again from the service, never from memory. Whatever
     * was in flight is superseded, so its answer, arriving later, is discarded unread; a save that was
     * in flight is shown as the service has it now.
     */
    resume: () => { generation += 1; working = false; return refresh(true); },
    open: (entitlementId: string) => run(async current => {
      const view = snapshot.view;
      const entitlement = view?.entitlements.find(e => e.entitlementId === entitlementId);
      if (!view || !entitlement || !isAccessActive(entitlement, now())) return;
      await openCourse(entitlement, view.enrollments, current);
    }),
    /** Show a lesson; when it is not already the recorded place, record it as the resume point (never a completion). */
    goTo: (target: LessonRef | null): Promise<void> => {
      // A target outside the readable outline is not a lesson: it is neither opened nor sent as a place.
      if (target && !inOutline(target)) return Promise.resolve();
      emit({ lesson: target, pending: null, error: '', notice: '' });
      const course = snapshot.course, saved = ready();
      if (!target || !course || !saved || !usable() || !isAccessActive(course.entitlement, now())) return Promise.resolve();
      if (sameLesson(saved.position, target)) return Promise.resolve();
      return send({ action: 'position', entitlementId: course.entitlement.entitlementId, enrollmentId: saved.enrollmentId, curriculum: course.entitlement.curriculum, lesson: target, expectedRevision: saved.revision, requestId: deps.requestId() });
    },
    complete: (target: LessonRef) => {
      const course = snapshot.course, saved = ready();
      if (!course || !saved || !usable() || !isAccessActive(course.entitlement, now())) return;
      return send({ action: 'complete', entitlementId: course.entitlement.entitlementId, enrollmentId: saved.enrollmentId, curriculum: course.entitlement.curriculum, lesson: target, expectedRevision: saved.revision, requestId: deps.requestId() });
    },
    retry: (command: WriteCommand) => send(command),
    dispose: () => { disposed = true; generation += 1; },
  };
}
export type LearnerController = ReturnType<typeof createLearnerController>;

export function progressRefusalMessage(reason: ProgressRefusal): string {
  switch (reason) {
    case 'not_owner': return 'This course belongs to a different account.';
    case 'not_active': return 'This course is not open on this account right now, so progress cannot be saved. Its status says why.';
    case 'enrollment_mismatch': return 'This progress belongs to a different enrollment. Refresh and open the course again.';
    case 'stale_version': return 'This course changed version on the service. Refresh and open it again; nothing was saved.';
    case 'unknown_lesson': return 'This lesson is not part of the version you bought. Nothing was saved.';
    case 'not_completable': return 'This step cannot be marked complete here. Supplement steps are reviewed with your practitioner before anything is added.';
    case 'revision_stale': return 'This course was updated elsewhere. Refresh to see your progress as it is saved now.';
    case 'request_conflict': return 'This save could not be matched to what you asked. Nothing new was saved; refresh and try again.';
    case 'service_unavailable': return 'The course service is unavailable right now. Nothing was saved; try again later.';
  }
}
