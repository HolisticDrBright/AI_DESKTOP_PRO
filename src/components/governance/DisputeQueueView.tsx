"use client";

import type { DisputeWorkforceResponse, RevisionWorkforceResponse } from "@/contracts/clinicalDisputes";
import { Card, CardTitle } from "@/components/ui/bits";
import { Pill } from "@/components/ui/Pill";

/**
 * What the practice got wrong, according to the people it was wrong about — and whether the
 * revisions it announced have actually landed.
 *
 * Rendered from props so each state can be read back in a test. Two things it must say
 * correctly: an upheld disagreement is still listed after it is resolved, because resolving is
 * not disposing; and a notice that is only `delivered` is not the same as one the patient
 * acknowledged, which for a safety withdrawal is the whole distinction.
 */
type Disputes = Extract<DisputeWorkforceResponse, { action: "list" }>;
type Notices = Extract<RevisionWorkforceResponse, { action: "list" }>;

export const SUBJECT_LABEL: Record<string, string> = {
  program_assignment: "Guide sent to patient",
  lab_observation: "Lab result",
  intake_response: "Form answer",
};
export const REASON_LABEL: Record<string, string> = {
  not_true_of_me: "Not true of them", was_true_no_longer: "No longer true",
  never_discussed: "Never discussed", disagree_with_conclusion: "Disagrees with the conclusion",
  wrong_person: "Belongs to someone else", missing_context: "Missing context", other: "Other",
};

export type DisputeQueueState = {
  disputes: Disputes["disputes"] | null;
  notices: Notices["notices"] | null;
  busy: boolean;
  error: string | null;
  onAcknowledge: (disputeId: string, expectedRevision: string) => void;
  onResolve: (disputeId: string, expectedRevision: string, resolution: "corrected" | "upheld" | "declined") => void;
};

export function DisputeQueueView({ state }: { state: DisputeQueueState }) {
  const { disputes, notices, busy, error } = state;
  const unanswered = (disputes ?? []).filter(dispute => dispute.status === "open" || dispute.status === "acknowledged");
  const answered = (disputes ?? []).filter(dispute => dispute.status === "resolved");
  return (
    <Card data-testid="dispute-queue">
      <CardTitle>Contested records</CardTitle>
      {error && <p role="alert" data-testid="dispute-queue-error" className="mt-2 text-[13px] text-critical">{error}</p>}

      {disputes === null ? (
        <p role="status" data-testid="dispute-queue-loading" className="text-[13px] text-faint">Loading contested records.</p>
      ) : unanswered.length === 0 ? (
        <p data-testid="dispute-queue-empty" className="text-[13px] text-faint">
          Nothing is waiting for an answer. A patient can contest a guide, a lab result or an answer recorded for
          them, and it appears here until you answer it.
        </p>
      ) : (
        <ul className="mt-1 list-none p-0">
          {unanswered.map(dispute => (
            <li key={dispute.disputeId} data-testid="dispute-row" className="border-t border-hairline py-2 first:border-t-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] font-semibold">{SUBJECT_LABEL[dispute.subjectKind] ?? dispute.subjectKind}</span>
                <Pill tone={dispute.status === "open" ? "warning" : "slate"}>
                  {dispute.status === "open" ? "Not yet seen" : "Seen, unanswered"}
                </Pill>
              </div>
              <p className="mt-1 text-[12px] text-faint">{REASON_LABEL[dispute.reasonCode] ?? dispute.reasonCode}</p>
              {dispute.statements.map((said, index) => (
                <p key={index} className="mt-1 text-[13px]">&ldquo;{said.body}&rdquo;</p>
              ))}
              <div className="mt-2 flex flex-wrap gap-2">
                {dispute.status === "open" && (
                  <button type="button" disabled={busy} data-testid="dispute-acknowledge"
                    onClick={() => state.onAcknowledge(dispute.disputeId, dispute.revision)}
                    className="rounded-md border border-hairline px-2 py-1 text-[12px] disabled:opacity-50">
                    Mark as seen
                  </button>
                )}
                {(["corrected", "upheld", "declined"] as const).map(resolution => (
                  <button key={resolution} type="button" disabled={busy} data-testid={`dispute-resolve-${resolution}`}
                    onClick={() => state.onResolve(dispute.disputeId, dispute.revision, resolution)}
                    className="rounded-md border border-hairline px-2 py-1 text-[12px] disabled:opacity-50">
                    {resolution === "corrected" ? "I agree — corrected"
                      : resolution === "upheld" ? "Record stands" : "Not for here"}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[12px] text-faint">Answering requires a written response, which the patient sees.</p>
            </li>
          ))}
        </ul>
      )}

      {answered.length > 0 && (
        <>
          <h3 className="mt-4 text-[13px] font-semibold">Answered, and still on the record</h3>
          <ul className="mt-1 list-none p-0">
            {answered.map(dispute => (
              <li key={dispute.disputeId} data-testid="dispute-answered" className="border-t border-hairline py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[13px]">{SUBJECT_LABEL[dispute.subjectKind] ?? dispute.subjectKind}</span>
                  <Pill tone={dispute.resolution === "corrected" ? "positive" : "slate"}>
                    {dispute.resolution === "corrected" ? "Corrected"
                      : dispute.resolution === "upheld" ? "Record stands" : "Declined"}
                  </Pill>
                </div>
                {dispute.clinicianResponse && <p className="mt-1 text-[12px] text-faint">{dispute.clinicianResponse}</p>}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[12px] text-faint">
            A disagreement you did not accept stays attached to the record. It is not removed by being answered.
          </p>
        </>
      )}

      <h3 className="mt-4 text-[13px] font-semibold">Revisions you announced</h3>
      {notices === null ? (
        <p role="status" data-testid="notice-loading" className="text-[13px] text-faint">Loading revision notices.</p>
      ) : notices.length === 0 ? (
        <p data-testid="notice-empty" className="text-[13px] text-faint">
          None announced. When you publish a corrected version, tell the patients already holding the old one —
          nothing reaches them automatically.
        </p>
      ) : (
        <ul className="mt-1 list-none p-0">
          {notices.map(notice => (
            <li key={notice.noticeId} data-testid="notice-row" className="border-t border-hairline py-2 first:border-t-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px]">
                  {notice.revisionClass === "safety_withdrawal" ? "Safety withdrawal"
                    : notice.revisionClass === "correction" ? "Correction" : "Addition"}
                </span>
                <Pill tone={notice.status === "acknowledged" ? "positive"
                  : notice.revisionClass === "safety_withdrawal" ? "critical" : "warning"}>
                  {notice.status === "acknowledged" ? "Acknowledged"
                    : notice.status === "delivered" ? "Seen, not acknowledged" : "Not yet seen"}
                </Pill>
              </div>
              <p className="mt-1 text-[12px] text-faint">
                {notice.itemsRemoved} removed · {notice.itemsChanged} changed · {notice.itemsAdded} added
              </p>
              {notice.revisionClass === "safety_withdrawal" && notice.status !== "acknowledged" && (
                <p data-testid="notice-unacknowledged-safety" className="mt-1 text-[12px] text-critical">
                  This was a safety withdrawal and the patient has not acknowledged it. Contact them directly.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
