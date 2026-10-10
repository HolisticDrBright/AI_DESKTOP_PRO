"use client";

import type { ClinicRecordRequestRecord, ClinicRecordWorkforceResponse } from "@/contracts/clinicRecordRequests";
import { CLINIC_RECORD_SECTION_LABEL } from "@/contracts/clinicRecordRequests";
import { Card, CardTitle } from "@/components/ui/bits";
import { Pill } from "@/components/ui/Pill";

/**
 * Patients asking for their clinic-held records, or for a correction — and what
 * the practice did about it.
 *
 * Rendered from props so each state can be read back in a test. What it must
 * say correctly: a submitted request is not fulfilled; a fulfilled copy names
 * what was included and what was excluded and why; a declined correction keeps
 * the record and shows the disagreement; nothing here deletes anything; and
 * fulfilment that fails for want of a reviewed disclosure release says so
 * rather than looking like an outage.
 */
export type ClinicRecordReview = Extract<ClinicRecordWorkforceResponse, { action: "review" }>;
export type ClinicRecordQueueState = {
  requests: ClinicRecordRequestRecord[] | null;
  review: ClinicRecordReview | null;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  onOpen: (requestId: string) => void;
  onBeginReview: (request: ClinicRecordRequestRecord) => void;
  onFulfill: (request: ClinicRecordRequestRecord, include: string[], excluded: Array<{ section: string; reason: string }>) => void;
  onRefuse: (request: ClinicRecordRequestRecord) => void;
  onAmend: (request: ClinicRecordRequestRecord) => void;
  onDecline: (request: ClinicRecordRequestRecord) => void;
};
export const STATUS_LABEL: Record<ClinicRecordRequestRecord["status"], string> = {
  submitted: "Submitted — not yet reviewed", in_review: "In review", fulfilled: "Fulfilled", refused: "Refused", withdrawn: "Withdrawn by the patient", superseded: "Superseded by a newer request",
};
export const ERROR_TEXT: Record<string, string> = {
  disclosure_release_required: "No reviewed disclosure release covers these sections for this clinic. Nothing was prepared; the request stays open until the owner's review registers a release.",
  conflict: "This request changed since it was loaded (another decision, a withdrawal or a newer request). Reload it before deciding.",
  not_found: "This request is not in this clinic's queue.",
  reauth_required: "Sign out and sign in again to continue.",
  identity_refused: "Your role cannot review clinic-record requests for this patient.",
  service_unavailable: "The clinic service did not answer. Nothing was decided.",
};
const REASON_LABEL: Record<string, string> = {
  not_true_of_me: "Not true of them", was_true_no_longer: "No longer true", never_discussed: "Never discussed",
  disagree_with_conclusion: "Disagrees with the conclusion", wrong_person: "Belongs to someone else", missing_context: "Missing context", other: "Other",
};
const open = (r: ClinicRecordRequestRecord) => r.status === "submitted" || r.status === "in_review";

export function ClinicRecordRequestsView({ state }: { state: ClinicRecordQueueState }) {
  const { requests, review, busy, error } = state;
  const waiting = (requests ?? []).filter(open), settled = (requests ?? []).filter(r => !open(r));
  return (
    <Card data-testid="clinic-record-queue">
      <div className="flex items-center justify-between gap-2">
        <CardTitle>Patient record requests</CardTitle>
        <button type="button" className="rounded-md border px-2 py-1 text-[12px]" onClick={state.onRefresh} disabled={busy}>Refresh</button>
      </div>
      <p className="text-[12px] text-faint">A copy is a snapshot of signed, reviewed records prepared under a reviewed disclosure release. A correction is answered with an append-only addendum or declined; the signed original never changes. Nothing here deletes anything.</p>
      {error && <p role="alert" data-testid="clinic-record-error" className="mt-2 text-[13px] text-critical">{ERROR_TEXT[error] ?? ERROR_TEXT.service_unavailable}</p>}
      {requests === null ? (
        <p role="status" data-testid="clinic-record-loading" className="text-[13px] text-faint">Loading patient record requests.</p>
      ) : waiting.length === 0 ? (
        <p data-testid="clinic-record-empty" className="text-[13px] text-faint">No patient is waiting on a copy or a correction. A request appears here until it is fulfilled, refused or withdrawn.</p>
      ) : (
        <ul className="mt-1 list-none p-0">
          {waiting.map(r => (
            <li key={r.requestId} data-testid="clinic-record-row" className="border-t border-hairline py-2 first:border-t-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] font-semibold">{r.kind === "copy" ? "Copy of clinic records" : "Correction of a signed note"}</span>
                <Pill tone={r.status === "in_review" ? "slate" : "warning"}>{STATUS_LABEL[r.status]}</Pill>
              </div>
              <p className="text-[12px] text-faint">Patient record {r.patientRecordId ?? "unknown"} · submitted {r.submittedAt} · revision {r.revision}</p>
              {r.kind === "copy" && <p className="text-[12px]">Sections asked for: {r.sections.map(s => CLINIC_RECORD_SECTION_LABEL[s]).join(", ")}</p>}
              {r.kind === "correction" && r.subject && (
                <p className="text-[12px]">Note {r.subject.id} (signed version {r.subject.revision}) · {REASON_LABEL[r.reasonCode ?? "other"]}: “{r.statement}”</p>
              )}
              <div className="mt-1 flex flex-wrap gap-2">
                <button type="button" className="rounded-md border px-2 py-1 text-[12px]" disabled={busy} onClick={() => state.onOpen(r.requestId)}>Review request</button>
                {r.status === "submitted" && <button type="button" className="rounded-md border px-2 py-1 text-[12px]" disabled={busy} onClick={() => state.onBeginReview(r)}>Mark in review</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {review && <ReviewDetail review={review} state={state} />}
      {settled.length > 0 && (
        <details className="mt-2"><summary className="text-[12px] text-faint">Decided and closed ({settled.length})</summary>
          <ul className="list-none p-0">
            {settled.map(r => (
              <li key={r.requestId} data-testid="clinic-record-settled" className="py-1 text-[12px]">
                {r.kind === "copy" ? "Copy" : "Correction"} · {STATUS_LABEL[r.status]}{r.outcome ? ` · ${r.outcome.replaceAll("_", " ")}` : ""}{r.decisionReasonCode ? ` · ${r.decisionReasonCode.replaceAll("_", " ")}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function ReviewDetail({ review, state }: { review: ClinicRecordReview; state: ClinicRecordQueueState }) {
  const r = review.request, canDecide = open(r) && !state.busy;
  const readable = (review.preview ?? []).filter(p => p.readable);
  const unreadable = (review.preview ?? []).filter(p => !p.readable);
  return (
    <section data-testid="clinic-record-review" className="mt-3 rounded-lg border border-hairline p-3">
      <h3 className="text-[13px] font-semibold">{r.kind === "copy" ? "Copy request" : "Correction request"} · {STATUS_LABEL[r.status]}</h3>
      {review.release ? (
        <p className="text-[12px]" data-testid="clinic-record-release">Disclosure release {review.release.releaseVersion} covers: {review.release.sections.map(s => CLINIC_RECORD_SECTION_LABEL[s]).join(", ")}.</p>
      ) : (
        <p className="text-[12px] text-critical" data-testid="clinic-record-no-release">No reviewed disclosure release is registered for this clinic. A copy cannot be prepared until the owner&apos;s review registers one.</p>
      )}
      {r.kind === "copy" && review.preview && (
        <ul className="list-none p-0" data-testid="clinic-record-preview">
          {readable.map(p => (
            <li key={p.section} className="text-[12px]">
              {CLINIC_RECORD_SECTION_LABEL[p.section]}: {p.includable} to include
              {Object.entries(p.excluded).length > 0 && <> · not disclosable: {Object.entries(p.excluded).map(([k, v]) => `${v} ${k.replaceAll("_", " ")}`).join(", ")}</>}
            </li>
          ))}
          {unreadable.map(p => (
            <li key={p.section} className="text-[12px] text-faint">{CLINIC_RECORD_SECTION_LABEL[p.section]}: not readable here ({(p.exclusionReason ?? "").replaceAll("_", " ")})</li>
          ))}
        </ul>
      )}
      {r.kind === "correction" && review.subjectNote && (
        <p className="text-[12px]" data-testid="clinic-record-subject">Signed note {review.subjectNote.noteId}: status {review.subjectNote.status}, version {review.subjectNote.currentVersion}, {review.subjectNote.addenda} addenda. Accepting adds an addendum; the signed text is never rewritten.</p>
      )}
      {review.copy && (
        <p className="text-[12px]" data-testid="clinic-record-copy">Copy prepared {review.copy.asOf}: {review.copy.itemCount} records, {review.copy.byteTotal} bytes, release {review.copy.manifest.releaseVersion}. Excluded: {review.copy.manifest.sections.filter(s => !s.included).map(s => `${CLINIC_RECORD_SECTION_LABEL[s.section]} (${s.exclusionReason ?? "not released"})`).join(", ") || "none"}.</p>
      )}
      <ol className="list-none p-0 text-[12px] text-faint" data-testid="clinic-record-events">
        {review.events.map(e => <li key={e.seq}>{e.seq}. {e.action.replaceAll("_", " ")} by {e.actorPool} at {e.at}{e.reasonCode ? ` · ${e.reasonCode.replaceAll("_", " ")}` : ""}</li>)}
      </ol>
      {canDecide && (
        <div className="mt-2 flex flex-wrap gap-2">
          {r.kind === "copy" ? (
            <>
              <button type="button" className="rounded-md bg-primary px-3 py-1 text-[12px] font-semibold text-white" disabled={!review.release}
                onClick={() => {
                  const covered = new Set(review.release?.sections ?? []);
                  const include = readable.map(p => p.section).filter(s => covered.has(s));
                  const excluded = (review.preview ?? []).filter(p => !include.includes(p.section)).map(p => ({ section: p.section, reason: p.readable ? "Not covered by the registered disclosure release" : (p.exclusionReason ?? "not readable") }));
                  state.onFulfill(r, include, excluded);
                }}>Prepare the copy under the release</button>
              <button type="button" className="rounded-md border px-3 py-1 text-[12px]" onClick={() => state.onRefuse(r)}>Refuse with a reason</button>
            </>
          ) : (
            <>
              <button type="button" className="rounded-md bg-primary px-3 py-1 text-[12px] font-semibold text-white" onClick={() => state.onAmend(r)}>Accept: add an addendum</button>
              <button type="button" className="rounded-md border px-3 py-1 text-[12px]" onClick={() => state.onDecline(r)}>Decline: record stands</button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
