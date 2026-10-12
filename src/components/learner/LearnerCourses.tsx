"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { isAccessActive, type EducationCurriculumRead, type ProgramEntitlement } from "@/contracts/programEducationAccess";
import { isCompleted, neighbours, resumeLesson, sameLesson, type CourseLesson, type LessonRef } from "@/contracts/programEducationProgress";
import { createLearnerController, progressRefusalMessage, type LearnerController, type LearnerSnapshot, type ProgressState, type WriteCommand } from "@/lib/learner/learnerController";
import { createLearnerTransport } from "@/lib/learner/learnerTransport";

/**
 * My courses (see learnerController.ts for the lifecycle). Text lessons are the lesson as published;
 * lesson video is held, and the page says so rather than offering a preview address. Supplement steps
 * are reviewed with a practitioner before anything is added; nothing here starts that, and there is
 * no purchase link, price or protocol action on this page.
 */
const ENTITLEMENT_WORDS: Record<ProgramEntitlement["state"], string> = {
  awaiting_claim: "Bought, not yet claimed by any account.",
  active: "Access is active.",
  expired: "Access ended at the end of its period.",
  held_refund: "On hold: a refund was recorded. The clinic decides what follows.",
  held_dispute: "On hold: a payment dispute was recorded. The clinic decides what follows.",
  held_policy: "On hold: a renewal was cancelled or its payment did not go through.",
  revoked: "Access was withdrawn by the clinic.",
};
const WITHHELD: Record<Extract<EducationCurriculumRead, { outcome: "withheld" }>["reason"], string> = {
  not_active: "This course is not open on this account right now. Its status above says why.",
  not_owner: "This course belongs to a different account.",
  version_missing: "The version you bought could not be found by the course service. Nothing was changed; the clinic can help.",
  digest_mismatch: "The version you bought no longer matches what the service holds, so it is not shown. The clinic can help.",
  service_unavailable: "The course service is unavailable right now. Try again later.",
};

const uuid = () => globalThis.crypto.randomUUID();

export function LearnerCourses() {
  const [snapshot, setSnapshot] = useState<LearnerSnapshot | null>(null);
  const controller = useMemo<LearnerController | null>(() => (typeof window === "undefined" ? null
    : createLearnerController({ transport: createLearnerTransport({ fetch: (input, init) => fetch(input, init) }), requestId: uuid, onChange: setSnapshot })), []);
  useEffect(() => {
    if (!controller) return;
    void controller.start();
    // Back on this tab: everything is read again from the service, never from memory.
    let hidden = false;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hidden = true;
      else if (hidden) { hidden = false; void controller.resume(); }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { document.removeEventListener("visibilitychange", onVisibility); controller.dispose(); };
  }, [controller]);
  if (!controller || !snapshot) return <p className="text-[13px] text-subtle" data-testid="learner-loading">Reading your courses…</p>;
  return <LearnerView snapshot={snapshot} controller={controller} />;
}

function LearnerView({ snapshot, controller }: { snapshot: LearnerSnapshot; controller: LearnerController }) {
  const { phase, view, course, outline, progress, lesson, pending, busy, error, notice, placeNote, host } = snapshot;
  const now = new Date();
  const ready = progress.state === "ready" ? progress.progress : null;
  const served = course?.read.outcome === "served" ? course.read : null;
  const usable = !!outline && outline.problem !== "ambiguous" && outline.problem !== "oversized";
  const lessons = usable ? outline!.lessons : [];
  const current = lesson ? lessons.find(entry => sameLesson(entry.ref, lesson)) ?? null : null;
  const completable = lessons.filter(entry => entry.completable);
  const resume = ready && usable ? resumeLesson(lessons, ready) : null;
  return (
    <div className="flex flex-col gap-3" data-testid="learner-courses" data-phase={phase}>
      <h1 className="m-0 text-[22px] font-semibold text-body">My courses</h1>
      {(host === "fictional_fixture" || host === "fictional_sql_fixture") && <p role="note" className="m-0 rounded-md border border-line px-3 py-2 text-[12.5px] font-semibold text-critical" data-testid="learner-fixture-host">FICTIONAL FIXTURE HOST — test data only. No real learner, course or purchase is shown here.</p>}
      <p className="m-0 text-[13px] text-subtle">Courses you bought appear here once the course service confirms them for your account. A course is reading and practice material; it is not a clinical program and it adds nothing to a protocol.</p>
      {error && <p role="alert" className="m-0 text-[13px] text-critical" data-testid="learner-error">{error}</p>}
      {notice && <p role="status" className="m-0 text-[13px] text-body" data-testid="learner-notice">{notice}</p>}
      {phase === "host_unavailable" && (
        <p role="status" className="m-0 text-[13px] text-body" data-testid="learner-host-unavailable">
          My courses is not connected on this server. Courses are read only through a reviewed sign-in and course service, and none is configured here, so nothing is shown rather than something unverified. This does not mean you have no courses.
        </p>
      )}
      <div><Btn type="button" size="sm" disabled={busy} onClick={() => void controller.refresh()} data-testid="learner-refresh">{busy ? "Working…" : phase === "ready" ? "Refresh" : "Try again"}</Btn></div>
      {phase === "ready" && view && view.entitlements.length === 0 && !error && <p className="m-0 text-[13px] text-subtle" data-testid="learner-empty">No courses are on this account yet.</p>}
      {phase === "ready" && view?.entitlements.map(entitlement => {
        const active = isAccessActive(entitlement, now);
        return (
          <Card key={entitlement.entitlementId} className="px-4 py-3"><div data-testid={`learner-course-${entitlement.entitlementId}`}>
            <CardTitle className="mb-1">Course, version {entitlement.curriculum.version}</CardTitle>
            <p className="m-0 text-[13px] text-body" data-testid={`learner-course-state-${entitlement.entitlementId}`}>{ENTITLEMENT_WORDS[entitlement.state]}{entitlement.window?.endsAt ? ` Access ends ${entitlement.window.endsAt.slice(0, 10)}.` : ""}</p>
            {active && <div className="mt-2"><Btn type="button" size="sm" disabled={busy} onClick={() => void controller.open(entitlement.entitlementId)} data-testid={`learner-open-${entitlement.entitlementId}`}>Open the course</Btn></div>}
          </div></Card>
        );
      })}
      {course && !current && (
        <Card className="px-4 py-3"><div data-testid="learner-curriculum">
          {served ? (
            <>
              <CardTitle className="mb-1">{served.title} (version {served.curriculum.version})</CardTitle>
              {outline?.problem === "ambiguous" && <p role="alert" className="m-0 text-[13px] text-critical" data-testid="learner-outline-ambiguous">This course could not be shown: two of its lessons or phases carry the same identifier, so progress could not be matched to the right one. Nothing was changed; the clinic can help.</p>}
              {outline?.problem === "oversized" && <p role="alert" className="m-0 text-[13px] text-critical" data-testid="learner-outline-oversized">This course is larger than a published course can be, so it is not shown rather than shown in part. Nothing was changed; the clinic can help.</p>}
              {usable && (
                <>
                  <p className={progress.state === "ready" ? "m-0 text-[13px] text-body" : "m-0 text-[13px] text-critical"} data-testid="learner-progress">{progressLine(progress, completable.length, ready ? completable.filter(entry => isCompleted(ready, entry.ref)).length : 0)}</p>
                  {resume && <div className="mt-2"><Btn type="button" size="sm" disabled={busy} onClick={() => void controller.goTo(resume.ref)} data-testid="learner-resume">{ready && (ready.position || ready.completed.length) ? "Continue: " : "Start: "}{resume.title}</Btn></div>}
                  {outline?.problem === "partial" && <p role="alert" className="m-0 mt-2 text-[13px] text-critical" data-testid="learner-outline-partial">Part of this course could not be shown. Nothing was changed; the clinic can help.</p>}
                  <Outline lessons={lessons} progress={ready} busy={busy} onOpen={ref => void controller.goTo(ref)} />
                </>
              )}
            </>
          ) : course.read.outcome === "withheld" ? <p role="alert" className="m-0 text-[13px] text-critical" data-testid="learner-withheld">{WITHHELD[course.read.reason]}</p> : null}
        </div></Card>
      )}
      {course && current && (
        <LessonView lesson={current} lessons={lessons} progress={progress} pending={pending} placeNote={placeNote} busy={busy} active={isAccessActive(course.entitlement, now)}
          onGo={ref => void controller.goTo(ref)} onComplete={ref => void controller.complete(ref)} onRetry={command => void controller.retry(command)} />
      )}
    </div>
  );
}

function progressLine(progress: ProgressState, total: number, done: number): string {
  if (progress.state === "ready") return `${done} of ${total} lessons marked complete.`;
  if (progress.state === "refused") return progressRefusalMessage(progress.reason);
  if (progress.state === "unavailable") return "Your progress could not be read right now. This does not mean you have none; nothing is shown as complete until it is read.";
  return "Reading your progress…";
}

function Outline({ lessons, progress, busy, onOpen }: { lessons: CourseLesson[]; progress: Parameters<typeof isCompleted>[0]; busy: boolean; onOpen: (ref: LessonRef) => void }) {
  const phases: { title: string; lessons: CourseLesson[] }[] = [];
  for (const lesson of lessons) {
    const last = phases[phases.length - 1];
    if (last && last.lessons[0]!.phaseIndex === lesson.phaseIndex) last.lessons.push(lesson); else phases.push({ title: lesson.phaseTitle, lessons: [lesson] });
  }
  return (
    <div className="mt-2 flex flex-col gap-2">
      {phases.map((phase, index) => (
        <div key={index} data-testid={`learner-phase-${index}`}>
          <p className="m-0 text-[13px] font-semibold text-body">{phase.title}</p>
          <ul className="m-0 list-none p-0">
            {phase.lessons.map(lesson => (
              <li key={lesson.ref.itemId}>
                <button type="button" disabled={busy} className="text-left text-[13px] text-action underline" onClick={() => onOpen(lesson.ref)} data-testid={`learner-lesson-open-${lesson.ref.itemId}`}>
                  {lesson.title}{lesson.kind === "supplement" ? " (a supplement step: reviewed with your practitioner before it is ever added)" : ""}{lesson.released ? "" : " (not released yet)"}{isCompleted(progress, lesson.ref) ? " (completed)" : ""}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function LessonView({ lesson, lessons, progress, pending, placeNote, busy, active, onGo, onComplete, onRetry }: { lesson: CourseLesson; lessons: CourseLesson[]; progress: ProgressState; pending: LearnerSnapshot["pending"]; placeNote: string; busy: boolean; active: boolean; onGo: (ref: LessonRef | null) => void; onComplete: (ref: LessonRef) => void; onRetry: (command: WriteCommand) => void }) {
  const { previous, next } = neighbours(lessons, lesson.ref);
  const ready = progress.state === "ready" ? progress.progress : null;
  const done = isCompleted(ready, lesson.ref);
  const mine = pending && sameLesson(pending.command.lesson, lesson.ref) ? pending : null;
  return (
    <Card className="px-4 py-3"><div data-testid="learner-lesson">
      <p className="m-0 text-[12px] text-subtle">{lesson.phaseTitle}</p>
      <CardTitle className="mb-1"><span data-testid="learner-lesson-title">{lesson.title}</span></CardTitle>
      {lesson.kind === "supplement" && <p className="m-0 text-[12.5px] text-subtle" data-testid="learner-lesson-supplement">This is a supplement step. It is reviewed with your practitioner before anything is added, and it cannot be marked complete here.</p>}
      {lesson.released ? <p className="m-0 whitespace-pre-wrap text-[14px] text-body" data-testid="learner-lesson-text">{lesson.instructions}</p> : <p className="m-0 text-[13px] text-subtle" data-testid="learner-lesson-unreleased">This lesson is not released yet.</p>}
      {lesson.released && lesson.hasMedia && <p className="m-0 mt-2 text-[12.5px] text-subtle" data-testid="learner-lesson-media-held">Lesson media is not available here yet. The written lesson above is the lesson as published.</p>}
      {done && <p className="m-0 mt-2 text-[13px] text-body" data-testid="learner-lesson-completed">Completed.</p>}
      {mine?.state === "saving" && <p className="m-0 mt-2 text-[12.5px] text-subtle" data-testid="learner-lesson-pending">Saving… not marked complete until the course service confirms it.</p>}
      {mine?.state === "unsaved" && <div className="mt-2"><Btn type="button" size="sm" disabled={busy} onClick={() => onRetry(mine.command)} data-testid="learner-lesson-retry">Try saving again</Btn></div>}
      {lesson.completable && !done && !mine && ready && active && <div className="mt-2"><Btn type="button" size="sm" disabled={busy} onClick={() => onComplete(lesson.ref)} data-testid="learner-lesson-complete">Mark this lesson complete</Btn></div>}
      {lesson.completable && !done && progress.state !== "ready" && <p className="m-0 mt-2 text-[12.5px] text-subtle" data-testid="learner-lesson-progress-unknown">Whether this lesson is complete cannot be read right now.</p>}
      {placeNote && <p className="m-0 mt-2 text-[12.5px] text-subtle" data-testid="learner-lesson-place-note">{placeNote}</p>}
      <div className="mt-3 flex gap-2">
        <Btn type="button" size="sm" disabled={busy || !previous} onClick={() => previous && onGo(previous.ref)} data-testid="learner-lesson-previous">Back</Btn>
        <Btn type="button" size="sm" disabled={busy || !next} onClick={() => next && onGo(next.ref)} data-testid="learner-lesson-next">Next</Btn>
        <button type="button" className="text-[13px] text-action underline" onClick={() => onGo(null)} data-testid="learner-lesson-overview">All lessons in this course</button>
      </div>
    </div></Card>
  );
}
