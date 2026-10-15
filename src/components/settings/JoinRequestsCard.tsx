"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { UserCheck } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/bits";
import {
  JOIN_REJECTION_REASONS, REVOCATION_REASONS, type JoinRejectionReason, type JoinRequestEntry, type RevocationReason,
} from "@/contracts/workforceJoinReview";

/**
 * Practitioners asking to join this clinic (workforce-join-review/1), for the clinic's owners and admins. The queue
 * shows a request's reference and dates, never who applied: the applicant tells the clinic their reference and email
 * address, and an approval carries that address, which the database checks against the applicant's verified account.
 *
 * "No requests" is said only when the service answered with none. While the service is not deployed, or the session is
 * not under clinic-membership sign-in, the card says the queue is unavailable instead, because nobody is then in a
 * position to say the queue is empty.
 */
const REJECTION_LABEL: Record<JoinRejectionReason, string> = {
  not_known_to_clinic: "We don't know this applicant",
  credentials_not_verified: "Credentials not verified",
  clinic_not_accepting: "Not accepting new members",
  duplicate_request: "Duplicate request",
};
const REVOCATION_LABEL: Record<RevocationReason, string> = {
  left_clinic: "Left the clinic",
  credentials_lapsed: "Credentials lapsed",
  access_no_longer_needed: "Access no longer needed",
  security_concern: "Security concern",
};
const STATUS_LABEL: Record<JoinRequestEntry["status"], string> = {
  pending: "Waiting for a decision", approved: "Approved", rejected: "Declined", withdrawn: "Withdrawn by the applicant",
};
const REFUSAL: Record<string, string> = {
  applicant_mismatch: "That address doesn't match the applicant's verified account. Check it with the applicant.",
  not_found: "That request isn't available to this clinic.",
  conflict: "Another admin already decided this request. The list has been refreshed.",
  self_approval_refused: "You can't decide your own request or remove your own access.",
  already_member: "That practitioner is already a member of this clinic.",
  clinic_unavailable: "This clinic can't accept new members right now.",
  identity_refused: "Only this clinic's current owners and admins can review join requests.",
  reauth_required: "Your session has expired. Sign in again.",
  request_invalid: "That request couldn't be sent. Check the details and try again.",
  clinic_selection_required: "Choose your clinic in Settings before reviewing requests.",
  clinic_selection_changed: "Your clinic changed in another tab. Reload this page.",
};
const UNAVAILABLE = "Join requests aren't available yet. They need clinic-membership sign-in and the join-review service, which this deployment doesn't run.";

type State =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "ready"; requests: JoinRequestEntry[] };

const reference = (id: string) => id.slice(0, 8);
const day = (value: string | null) => (value ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "service_unavailable";
}

export function JoinRequestsCard() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [working, setWorking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const headingId = useId();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/live/org/join-requests", { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { data?: { action?: string; requests?: JoinRequestEntry[] } };
        if (body.data?.action !== "list" || !Array.isArray(body.data.requests)) throw new Error("invalid");
        setState({ kind: "ready", requests: body.data.requests });
        return;
      }
      const code = await errorCode(res);
      if (res.status === 503) setState({ kind: "unavailable", message: UNAVAILABLE });
      else setState({ kind: "failed", message: REFUSAL[code] ?? "The join-request queue couldn't be loaded." });
    } catch {
      setState({ kind: "failed", message: "The join-request queue couldn't be reached. This is not an empty queue; try again." });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function send(key: string, body: Record<string, unknown>, done: string) {
    setWorking(key); setNotice(null); setProblem(null);
    try {
      const res = await fetch("/api/live/org/join-requests", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (res.ok) {
        const answer = (await res.json()) as { data?: { duplicate?: boolean } };
        setNotice(answer.data?.duplicate ? "This was already decided; the recorded decision stands." : done);
      } else {
        const code = await errorCode(res);
        setProblem(res.status === 503 ? UNAVAILABLE : REFUSAL[code] ?? "The decision couldn't be recorded. Nothing was changed.");
      }
    } catch {
      // A lost reply is not a failure we can describe: the decision may or may not have been recorded. Re-reading the
      // queue shows which; sending the same decision again is safe, because a retry answers the recorded decision.
      setProblem("No answer arrived. The decision may have been recorded; the list below shows the current state.");
    } finally {
      setWorking(null);
      await load();
    }
  }

  return (
    <div className="mx-auto max-w-[420px] px-6 pb-6" data-testid="join-requests-card">
      <Card className="px-4 py-[16px]">
        <section aria-labelledby={headingId}>
          <CardTitle className="mb-[4px]">
            <UserCheck size={13} strokeWidth={2.2} className="text-brand" aria-hidden />
            <span id={headingId}>Requests to join this clinic</span>
          </CardTitle>
          <p className="m-0 text-[11px] leading-[1.5] text-subtle">
            Applicants give you their request reference and the email address on their account. Approving asks for that
            address and gives practitioner access to this clinic only.
          </p>
          <div aria-live="polite" className="mt-2 text-[12px]">
            {notice && <p role="status" className="m-0 text-positive">{notice}</p>}
            {problem && <p role="alert" className="m-0 text-critical">{problem}</p>}
          </div>
          {state.kind === "loading" && <p role="status" className="m-0 mt-2 text-[12px] text-subtle">Loading join requests…</p>}
          {state.kind === "unavailable" && <p data-testid="join-requests-unavailable" className="m-0 mt-2 text-[12px] leading-[1.5] text-subtle">{state.message}</p>}
          {state.kind === "failed" && (
            <div role="alert" data-testid="join-requests-failed" className="mt-2 text-[12px] text-critical">
              <p className="m-0">{state.message}</p>
              <button type="button" onClick={() => void load()} className="mt-1 h-7 rounded-md border border-line bg-card px-2 text-[11.5px] font-semibold text-body focus-visible:outline-2 focus-visible:outline-action">Try again</button>
            </div>
          )}
          {state.kind === "ready" && (
            <ul className="m-0 mt-2 flex list-none flex-col gap-[12px] p-0" data-testid="join-requests-list">
              {state.requests.length === 0 && <li className="text-[12px] text-subtle">No one has asked to join this clinic.</li>}
              {state.requests.map((entry) => (
                <JoinRequestRow key={entry.id} entry={entry} working={working} send={send} />
              ))}
            </ul>
          )}
        </section>
      </Card>
    </div>
  );
}

function JoinRequestRow({ entry, working, send }: {
  entry: JoinRequestEntry; working: string | null;
  send: (key: string, body: Record<string, unknown>, done: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [rejection, setRejection] = useState<JoinRejectionReason>("not_known_to_clinic");
  const [revocation, setRevocation] = useState<RevocationReason>("left_clinic");
  const id = useId();
  const busy = working !== null;
  const control = "h-8 rounded-md border border-line bg-card px-2 text-[12px] text-body focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50";
  return (
    <li className="border-b border-hairline pb-[12px] last:border-b-0 last:pb-0" aria-label={`Request ${reference(entry.id)}`}>
      <div className="text-[12.5px] font-semibold text-body">Request {reference(entry.id)}</div>
      <div className="text-[11px] text-subtle">
        {STATUS_LABEL[entry.status]} · received {day(entry.createdAt)}
        {entry.decidedAt ? ` · decided ${day(entry.decidedAt)}` : ""}
        {entry.decisionReason && entry.status === "rejected" && entry.decisionReason in REJECTION_LABEL
          ? ` · ${REJECTION_LABEL[entry.decisionReason as JoinRejectionReason]}` : ""}
      </div>
      {entry.status === "pending" && (
        <div className="mt-2 flex flex-col gap-2">
          <form className="flex flex-wrap items-end gap-[6px]" onSubmit={(event) => {
            event.preventDefault();
            void send(`approve:${entry.id}`, { action: "approve", requestId: entry.id, applicantEmail: email }, `Request ${reference(entry.id)} approved.`);
          }}>
            <label htmlFor={`${id}-email`} className="block w-full text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Applicant&apos;s email, as they gave it to you</label>
            <input id={`${id}-email`} type="email" required autoComplete="off" value={email} disabled={busy}
              onChange={(event) => setEmail(event.target.value)} className={`${control} min-w-0 flex-1`} />
            <button type="submit" disabled={busy || email.trim() === ""} className={`${control} font-semibold`}>
              {working === `approve:${entry.id}` ? "Approving…" : "Approve"}
            </button>
          </form>
          <form className="flex flex-wrap items-end gap-[6px]" onSubmit={(event) => {
            event.preventDefault();
            void send(`reject:${entry.id}`, { action: "reject", requestId: entry.id, reason: rejection }, `Request ${reference(entry.id)} declined.`);
          }}>
            <label htmlFor={`${id}-reject`} className="sr-only">Reason to decline request {reference(entry.id)}</label>
            <select id={`${id}-reject`} value={rejection} disabled={busy} onChange={(event) => setRejection(event.target.value as JoinRejectionReason)} className={control}>
              {JOIN_REJECTION_REASONS.map((reason) => <option key={reason} value={reason}>{REJECTION_LABEL[reason]}</option>)}
            </select>
            <button type="submit" disabled={busy} className={`${control} font-semibold text-critical`}>
              {working === `reject:${entry.id}` ? "Declining…" : "Decline"}
            </button>
          </form>
        </div>
      )}
      {entry.status === "approved" && entry.membershipId && (
        <form className="mt-2 flex flex-wrap items-end gap-[6px]" onSubmit={(event) => {
          event.preventDefault();
          void send(`revoke:${entry.id}`, { action: "revoke", membershipId: entry.membershipId, reason: revocation }, `Access from request ${reference(entry.id)} removed.`);
        }}>
          <label htmlFor={`${id}-revoke`} className="sr-only">Reason to remove access granted by request {reference(entry.id)}</label>
          <select id={`${id}-revoke`} value={revocation} disabled={busy} onChange={(event) => setRevocation(event.target.value as RevocationReason)} className={control}>
            {REVOCATION_REASONS.map((reason) => <option key={reason} value={reason}>{REVOCATION_LABEL[reason]}</option>)}
          </select>
          <button type="submit" disabled={busy} className={`${control} font-semibold text-critical`}>
            {working === `revoke:${entry.id}` ? "Removing…" : "Remove access"}
          </button>
        </form>
      )}
    </li>
  );
}
