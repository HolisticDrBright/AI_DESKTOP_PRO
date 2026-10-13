"use client";

import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { isAccessActive, type EducationCurriculumRead, type ProgramEntitlement } from "@/contracts/programEducationAccess";
import { isCompleted, neighbours, resumeLesson, sameLesson, type CourseLesson, type LessonRef } from "@/contracts/programEducationProgress";
import { createLearnerController, progressRefusalMessage, type LearnerController, type LearnerSnapshot, type MediaSlotState, type ProgressState, type WriteCommand } from "@/lib/learner/learnerController";
import type { LearnerMediaAvailable, LearnerMediaText } from "@/contracts/programLearnerMedia";
import { createLearnerTransport } from "@/lib/learner/learnerTransport";

/**
 * My courses (see learnerController.ts for the lifecycle). Text lessons are the lesson as published.
 * Lesson media is shown only from the course service's own answer for this learner (program-learner-
 * media/1): a short-lived capability for one exact object version, with the publication's own caption
 * and transcript text. Without that answer the page says media is held, not available or could not be
 * checked, and the written lesson stands; a reference's address is never loaded. Supplement steps
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
    // Hidden or leaving: media capabilities and transcripts are dropped from the page synchronously, before the browser can keep a frame of them.
    const drop = () => flushSync(() => controller.hide());
    const onVisibility = () => {
      if (document.visibilityState === "hidden") { hidden = true; drop(); }
      else if (hidden) { hidden = false; void controller.resume(); }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", drop);
    return () => { document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("pagehide", drop); controller.dispose(); };
  }, [controller]);
  if (!controller || !snapshot) return <p className="text-[13px] text-subtle" data-testid="learner-loading">Reading your courses…</p>;
  return <LearnerView snapshot={snapshot} controller={controller} />;
}

function LearnerView({ snapshot, controller }: { snapshot: LearnerSnapshot; controller: LearnerController }) {
  const { phase, view, course, outline, progress, lesson, pending, busy, error, notice, placeNote, host, media } = snapshot;
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
      {phase === "signin" && host !== "fictional_fixture" && host !== "fictional_sql_fixture" && (
        <div><a className="text-[13px] text-action underline" href="/api/my-courses/session" data-testid="learner-signin">Sign in with your course account</a></div>
      )}
      {host === "reviewed" && phase === "ready" && (
        <div><Btn type="button" size="sm" disabled={busy} onClick={() => void fetch("/api/my-courses/session/signout", { method: "POST", credentials: "same-origin" }).finally(() => window.location.assign("/courses"))} data-testid="learner-signout">Sign out on every device</Btn></div>
      )}
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
        <LessonView lesson={current} lessons={lessons} progress={progress} pending={pending} placeNote={placeNote} busy={busy} active={isAccessActive(course.entitlement, now)} media={media}
          onGo={ref => void controller.goTo(ref)} onComplete={ref => void controller.complete(ref)} onRetry={command => void controller.retry(command)} onReloadMedia={slots => void controller.reloadMedia(slots)} />
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

function LessonView({ lesson, lessons, progress, pending, placeNote, busy, active, media, onGo, onComplete, onRetry, onReloadMedia }: { lesson: CourseLesson; lessons: CourseLesson[]; progress: ProgressState; pending: LearnerSnapshot["pending"]; placeNote: string; busy: boolean; active: boolean; media: MediaSlotState[]; onGo: (ref: LessonRef | null) => void; onComplete: (ref: LessonRef) => void; onRetry: (command: WriteCommand) => void; onReloadMedia: (slots: number[]) => void }) {
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
      {lesson.released && lesson.hasMedia && media.length === 0 && <p className="m-0 mt-2 text-[12.5px] text-subtle" data-testid="learner-lesson-media-held">Lesson media is not available here yet. The written lesson above is the lesson as published.</p>}
      {lesson.released && media.map(slot => <MediaSlot key={slot.slot} slot={slot} onReload={() => onReloadMedia([slot.slot])} />)}
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

const MEDIA_WORDS: Record<Exclude<MediaSlotState["state"], "available">, string> = {
  loading: "Checking this lesson's media for your account…",
  held: "Lesson media is not available here yet. The written lesson above is the lesson as published.",
  not_available: "This media is not available on your account now. The written lesson above is the lesson as published.",
  unavailable: "This lesson's media could not be checked right now. This does not mean it has none; try again.",
  expired: "The link for this media has lapsed. Open it again to keep watching.",
};
function MediaSlot({ slot, onReload }: { slot: MediaSlotState; onReload: () => void }) {
  if (slot.state !== "available") {
    return (
      <div className="mt-2" data-testid={`learner-media-${slot.slot}`} data-media-state={slot.state}>
        <p className="m-0 text-[12.5px] text-subtle" data-testid={`learner-media-${slot.slot}-note`}>{MEDIA_WORDS[slot.state]}</p>
        {(slot.state === "unavailable" || slot.state === "expired") && <Btn type="button" size="sm" onClick={onReload} data-testid={`learner-media-${slot.slot}-reload`}>{slot.state === "expired" ? "Open the media again" : "Try again"}</Btn>}
      </div>
    );
  }
  return <MediaPlayer slot={slot.slot} reply={slot.reply} />;
}
function MediaPlayer({ slot, reply }: { slot: number; reply: LearnerMediaAvailable }) {
  // Captions published as WebVTT become a track from the publication's own text; the object URL lives only while this player does.
  const vtt = reply.caption.state === "available" && reply.caption.format === "vtt" ? reply.caption.text : null;
  const [track, setTrack] = useState<string | null>(null);
  useEffect(() => {
    if (!vtt) { setTrack(null); return; }
    const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
    setTrack(url);
    return () => URL.revokeObjectURL(url);
  }, [vtt]);
  return (
    <div className="mt-2 flex flex-col gap-1" data-testid={`learner-media-${slot}`} data-media-state="available">
      {reply.media.kind === "video" ? (
        <video controls preload="metadata" playsInline className="max-w-full rounded-md" src={reply.playback.url} data-testid={`learner-media-${slot}-video`}>
          {track && <track kind="captions" src={track} default label="Captions" />}
        </video>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- a short-lived, exact-version capability; never optimized, cached or proxied
        <img className="max-w-full rounded-md" src={reply.playback.url} alt={reply.caption.state === "available" ? reply.caption.text.slice(0, 240) : "Lesson image"} referrerPolicy="no-referrer" data-testid={`learner-media-${slot}-image`} />
      )}
      <MediaText label="Captions" text={reply.caption} testId={`learner-media-${slot}-caption`} />
      {reply.media.kind === "video" && <MediaText label="Transcript" text={reply.transcript} testId={`learner-media-${slot}-transcript`} />}
    </div>
  );
}
function MediaText({ label, text, testId }: { label: string; text: LearnerMediaText; testId: string }) {
  if (text.state === "none") return null;
  if (text.state === "unavailable") return <p className="m-0 text-[12.5px] text-subtle" data-testid={`${testId}-unavailable`}>{label}: text was published with this media, but no verified copy of that version&apos;s text is available, so none is shown.</p>;
  return (
    <details className="text-[13px] text-body" data-testid={testId}>
      <summary>{label} ({text.source === "supplied_vendor_file" ? "supplied as a vendor file" : "supplied by the author"})</summary>
      <p className="m-0 whitespace-pre-wrap" data-testid={`${testId}-text`}>{text.text}</p>
    </details>
  );
}
