"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Card } from "@/components/ui/bits";
import type { ApplicationEntry } from "@/contracts/workforceApplication";
import type { BootstrapSuspensionReason, ClinicBootstrapState } from "@/contracts/workforceClinicBootstrap";
import { canSubmit, journeyState, type ApplicationAnswer, type JourneyState, type NotAuthorizedReason } from "@/lib/applicant-journey";
import {
  canCreateClinic, canProposeClinic, createOutcome, hasCreatedClinic, newClinicState,
  type BootstrapRead, type CreateOutcome, type CreatedNotAuthorizedReason, type NewClinicState,
} from "@/lib/clinic-bootstrap-journey";

/**
 * The applicant's own journey, with two doors: create a new clinic (workforce-clinic-bootstrap/1) or request to join an
 * existing one with its clinic code (workforce-application/1). src/lib/applicant-journey.ts and
 * src/lib/clinic-bootstrap-journey.ts derive every state from a server answer. The page never fills a gap: a step
 * nobody answered reads "Unknown", a missing service reads "unavailable", and a failed read is never shown as "no
 * application" or "no clinic".
 *
 * Each submission carries a request id made once per attempt and kept until the service gives a definite answer, so a
 * reply lost on the way back can be sent again safely: the same id converges on the same request or the same clinic.
 * The browser sends that id and a name or a clinic code, nothing else: never a role, subject, address or assurance.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reference = (id: string) => id.slice(0, 8);
const day = (value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const validName = (value: string) => value.trim().length >= 3 && value.trim().length <= 120 && !/[\u0000-\u001f\u007f]/.test(value);
const primary = "inline-flex h-9 items-center rounded-lg bg-action px-4 text-[12.5px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50";

const REASON_LABEL: Record<string, string> = {
  not_known_to_clinic: "The clinic doesn't know this applicant",
  credentials_not_verified: "Credentials not verified",
  clinic_not_accepting: "The clinic isn't accepting new members",
  duplicate_request: "Duplicate request",
  clinic_proposal_incomplete: "The proposal was incomplete",
  clinic_proposal_declined: "The proposal was declined",
};
const SUSPENSION_LABEL: Record<BootstrapSuspensionReason, string> = {
  security_concern: "A security concern",
  identity_not_verified: "Identity not verified",
  agreement_not_accepted: "Agreement not accepted",
  operator_request: "At the platform team's request",
};
const NOT_AUTHORIZED: Record<NotAuthorizedReason, string> = {
  clinic_activation_held: "Your new clinic was approved, but it isn't active yet. Activating a new clinic is a separate step that this app doesn't perform, so nobody has patient access through it yet.",
  membership_not_current: "This approval no longer gives access: the membership was removed or suspended, or the clinic isn't active. Contact the clinic.",
  access_unknown: "The application service didn't say whether your access is active, so this page doesn't claim it is.",
  desktop_not_on_current_membership: "This app still signs practitioners in with the older account settings, which an approval can't change. Sign-in by clinic membership isn't turned on here yet.",
  clinic_not_in_session: "Your session doesn't list this clinic yet. Sign out and sign in again; if it's still missing, contact the clinic.",
};
const CREATED_NOT_AUTHORIZED: Record<CreatedNotAuthorizedReason, string> = {
  membership_not_current: "The service says your owner membership doesn't admit this account now, so nobody has access to this clinic's records through it.",
  desktop_not_on_current_membership: "This app still signs practitioners in with the older account settings, which can't include a new clinic. Sign-in by clinic membership isn't turned on here yet.",
  clinic_not_in_session: "Your session doesn't list your new clinic yet. Sign out and sign in again; if it's still missing, contact the platform team.",
};
const STATUS_LABEL: Record<ApplicationEntry["status"], string> = {
  pending: "Waiting for a decision", approved: "Approved", rejected: "Declined", withdrawn: "Withdrawn",
};
const CREATE_MESSAGE: Record<CreateOutcome["kind"], string> = {
  created: "Your clinic was created.",
  already_created: "Your clinic was already created by your earlier attempt. No second clinic was made.",
  lost: "No confirmed answer arrived. Your clinic may have been created: check again, or send again. Sending again won't create a second clinic.",
  closed: "Creating a clinic isn't open in this app yet. Nothing was created.",
  exists: "This account has already created a clinic. Nothing new was created.",
  conflict: "This retry doesn't match the first attempt: the account or the clinic name changed. Nothing was created by it. Check again before trying once more.",
  proposal_pending: "You have a new-clinic proposal waiting for review. Withdraw it first to create a clinic directly. Nothing was created.",
  mfa: "Multi-factor authentication isn't set up on this account. Nothing was created.",
  email: "Your email address isn't verified. Nothing was created.",
  refused: "This account can't create a clinic from here. Nothing was created.",
  rate_limited: "Too many requests in a short time. Wait a few minutes, then send again: it will be the same request.",
  invalid: "Check the clinic name: 3 to 120 characters.",
  signed_out: "Your session ended. Sign in again; nothing was created by this attempt.",
  cross_site: "This request didn't come from this page, so it was refused. Nothing was created.",
  not_configured: "The application service isn't available here. Nothing was created.",
};

function newClinicHeadline(state: NewClinicState, syntheticOnly: boolean): { title: string; detail: string } | null {
  switch (state.state) {
    case "ready": return { title: "Your clinic is ready.", detail: `You're the owner of this new clinic (reference ${reference(state.clinic.organizationId)}). Your access is to this clinic's records only.${syntheticOnly ? " This build is for fictional test records only: don't enter real patient information." : ""}` };
    case "created_not_authorized": return { title: "Your clinic was created — clinical access isn't on yet.", detail: CREATED_NOT_AUTHORIZED[state.reason] };
    case "suspended": return { title: "Your clinic is suspended.", detail: `Reason: ${state.reason ? SUSPENSION_LABEL[state.reason] : "Unknown"}. Nobody can open its records while it's suspended. This app has no way to reinstate a clinic.` };
    default: return null;
  }
}

function headline(state: JourneyState): { title: string; detail: string } {
  switch (state.state) {
    case "signed_out": return { title: "Sign in to see your application.", detail: "Your application belongs to the account you sign in with." };
    case "unavailable": return { title: "Applications aren't open in this app yet.", detail: "The application service isn't available here, so this page can't show or submit a request. This is not a decision about you or your account." };
    case "failed": return { title: "We couldn't check your application.", detail: "This doesn't mean you have no application. Try again in a moment." };
    case "rate_limited": return { title: "Too many requests in a short time.", detail: "Wait a few minutes, then check again." };
    case "account_refused": return { title: "This account can't apply from here.", detail: "If you switched accounts, sign out and sign in with the account you applied with. Otherwise, contact the clinic." };
    case "account_unconfirmed": return { title: "Your email address isn't verified.", detail: "Verify the address on your account before applying. Confirming an address isn't available in this app while practitioner registration is closed." };
    case "mfa_incomplete": return { title: "Multi-factor authentication isn't set up.", detail: "Set up an authenticator app on this account, then come back. A clinic can't be created or joined without it." };
    case "not_submitted": return { title: "You haven't created or joined a clinic yet.", detail: "Create a new clinic, or request to join the clinic that gave you a clinic code." };
    case "join_pending": return { title: "Your request is waiting for the clinic.", detail: `Reference ${reference(state.request.id)}. Give the clinic this reference and the email address on your account; they need both to approve you. You can withdraw the request until they decide.` };
    case "proposal_pending": return { title: "Your new-clinic proposal is waiting for review.", detail: `Reference ${reference(state.request.id)}. The platform team reviews new clinics. Approving a proposal creates the clinic; it doesn't by itself give anyone access to patients.` };
    case "rejected": return { title: "Your request was declined.", detail: state.request.decisionReason ? `Reason: ${REASON_LABEL[state.request.decisionReason] ?? "Unknown"}.` : "Reason: Unknown." };
    case "withdrawn": return { title: "You withdrew your request.", detail: "You can ask again whenever you're ready." };
    case "approved_not_authorized": return { title: "Approved — clinical access isn't on yet.", detail: NOT_AUTHORIZED[state.reason] };
    case "clinical_access_available": return { title: "Clinical access is available.", detail: "Your membership at this clinic is active. Choose the clinic in Settings to start." };
  }
}

type Step = { label: string; value: string };
const NEW_CLINIC_STEP: Record<NewClinicState["state"], string> = {
  closed: "Not open in this app", unknown: "Unknown", none: "None created", ready: "Ready",
  created_not_authorized: "Created — access not on", suspended: "Suspended",
};
function steps(state: JourneyState, newClinic: NewClinicState): Step[] {
  const answered = !["signed_out", "unavailable", "failed", "rate_limited", "account_refused"].includes(state.state);
  const accountOk = answered && state.state !== "account_unconfirmed" && state.state !== "mfa_incomplete";
  const request = "request" in state ? state.request : null;
  return [
    { label: "Signed in", value: state.state === "signed_out" ? "No" : "Yes" },
    { label: "Email address verified", value: state.state === "account_unconfirmed" ? "Not yet" : accountOk || state.state === "mfa_incomplete" ? "Yes" : "Unknown" },
    { label: "Multi-factor authentication", value: state.state === "mfa_incomplete" ? "Not set up" : accountOk ? "Set up" : "Unknown" },
    { label: "Your new clinic", value: NEW_CLINIC_STEP[newClinic.state] },
    { label: "Request", value: !accountOk ? "Unknown" : request ? `${STATUS_LABEL[request.status]} (reference ${reference(request.id)})` : "Not submitted" },
    { label: "Clinical access", value: state.state === "clinical_access_available" || newClinic.state === "ready" ? "Available"
      : state.state === "approved_not_authorized" || newClinic.state === "created_not_authorized" || newClinic.state === "suspended" ? "Not yet"
      : accountOk ? "None" : "Unknown" },
  ];
}

async function read(): Promise<ApplicationAnswer> {
  try {
    const res = await fetch("/api/onboarding/application", { cache: "no-store" });
    const body = (await res.json().catch(() => ({}))) as { data?: { entries: ApplicationEntry[]; clinicSignIn: "current_membership" | "legacy_claims"; clinicIds: string[] | null }; error?: unknown };
    if (res.ok && body.data && Array.isArray(body.data.entries)) return { kind: "answered", ...body.data };
    if (res.status === 401) return { kind: "signed_out" };
    if (res.status === 503 && (body.error === "application_service_not_configured" || body.error === "workforce_application_not_released")) return { kind: "unavailable" };
    if (typeof body.error === "string" && res.status !== 503) return { kind: "refused", code: body.error };
    return { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

async function readNewClinic(): Promise<BootstrapRead> {
  try {
    const res = await fetch("/api/onboarding/clinic-bootstrap", { cache: "no-store" });
    const body = (await res.json().catch(() => ({}))) as { data?: { clinic: ClinicBootstrapState | null; clinicSignIn: "current_membership" | "legacy_claims"; inSession: boolean | null }; error?: unknown };
    if (res.ok && body.data && "clinic" in body.data) return { kind: "answered", clinic: body.data.clinic, clinicSignIn: body.data.clinicSignIn, inSession: body.data.inSession };
    if (res.status === 503 && body.error === "workforce_clinic_bootstrap_not_released") return { kind: "not_released" };
    if (res.status === 401) return { kind: "signed_out" };
    if (res.status === 503 && body.error === "application_service_not_configured") return { kind: "unavailable" };
    if (typeof body.error === "string" && res.status !== 503) return { kind: "refused", code: body.error };
    return { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

export function ApplicantJourney({ syntheticOnly }: { syntheticOnly: boolean }) {
  const [state, setState] = useState<{ application: JourneyState; newClinic: NewClinicState } | null>(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async (announce = false) => {
    setChecking(true);
    const [application, newClinic] = await Promise.all([read(), readNewClinic()]);
    setState({ application: journeyState(application), newClinic: newClinicState(newClinic) });
    setChecking(false);
    if (announce) titleRef.current?.focus();
  }, []);
  useEffect(() => { void load(); }, [load]);
  const done = useCallback(async (message: string, failed: boolean) => {
    if (failed) { setNotice(null); setProblem(message); } else { setProblem(null); setNotice(message); }
    await load(true);
  }, [load]);

  if (!state) return <p role="status" className="m-0 text-[13px] text-subtle">Checking your application…</p>;
  const { application, newClinic } = state;
  const { title, detail } = newClinicHeadline(newClinic, syntheticOnly) ?? headline(application);
  const joinOpen = canSubmit(application);
  const createOpen = canCreateClinic(newClinic, application);
  return (
    <div className="flex flex-col gap-4" data-testid="applicant-journey" data-state={application.state} data-new-clinic={newClinic.state}>
      <Card className="px-4 py-[16px]">
        <div aria-live="polite">
          <h2 ref={titleRef} tabIndex={-1} className="m-0 text-[15px] font-semibold text-ink outline-none" data-testid="applicant-state">{title}</h2>
          <p className="mt-[6px] mb-0 text-[12.5px] leading-[1.55] text-body">{detail}</p>
          {application.state === "proposal_pending" && newClinic.state === "none" && (
            <p className="mt-[6px] mb-0 text-[12.5px] leading-[1.55] text-body">To create your clinic directly instead, withdraw this proposal first.</p>
          )}
        </div>
        {application.state === "signed_out" && (
          <Link href="/login?next=/apply" className={`mt-3 ${primary}`}>Sign in</Link>
        )}
        {newClinic.state === "ready" && <OpenClinic clinic={newClinic.clinic} onProblem={setProblem} />}
        {newClinic.state !== "ready" && application.state === "clinical_access_available" && (
          <Link href="/settings#practice-preferences" className={`mt-3 ${primary}`}>Choose your clinic</Link>
        )}
        {application.state !== "signed_out" && (
          <button type="button" onClick={() => void load(true)} disabled={checking} aria-busy={checking}
            className="mt-3 ml-0 block h-8 rounded-md border border-line bg-card px-3 text-[12px] font-semibold text-body focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50">
            {checking ? "Checking…" : "Check again"}
          </button>
        )}
      </Card>

      <Card className="px-4 py-[14px]">
        <h2 className="m-0 mb-2 text-[12px] font-bold tracking-[0.04em] text-faint uppercase">Where things stand</h2>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-[6px] text-[12.5px]" data-testid="applicant-steps">
          {steps(application, newClinic).map((step) => (
            <div key={step.label} className="contents">
              <dt className="text-subtle">{step.label}</dt>
              <dd className="m-0 font-semibold text-body">{step.value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <div aria-live="assertive" className="text-[12.5px]">
        {notice && <p role="status" className="m-0 text-positive">{notice}</p>}
        {problem && <p role="alert" className="m-0 text-critical">{problem}</p>}
      </div>

      {(application.state === "join_pending" || application.state === "proposal_pending") && (
        <WithdrawRequest request={application.request} onDone={done} />
      )}
      {(joinOpen || createOpen) && (
        <ChooseDoor application={application} newClinic={newClinic} joinOpen={joinOpen} createOpen={createOpen} syntheticOnly={syntheticOnly} onDone={done} />
      )}
      {"history" in application && application.history.length > 0 && (
        <Card className="px-4 py-[14px]">
          <h2 className="m-0 mb-2 text-[12px] font-bold tracking-[0.04em] text-faint uppercase">Your requests</h2>
          <ul className="m-0 flex list-none flex-col gap-[6px] p-0 text-[12px]" data-testid="applicant-history">
            {application.history.map((entry) => (
              <li key={entry.id}>
                <span className="font-semibold text-body">{entry.kind === "join" ? "Join a clinic" : "New clinic proposal"} · {reference(entry.id)}</span>
                <span className="text-subtle"> — {STATUS_LABEL[entry.status]}, {day(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** Selects the new clinic through the ordinary switch, which checks it against this account's own clinics read now. */
function OpenClinic({ clinic, onProblem }: { clinic: ClinicBootstrapState; onProblem: (message: string) => void }) {
  const [opening, setOpening] = useState(false);
  async function open() {
    setOpening(true);
    try {
      const res = await fetch("/api/auth/org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId: clinic.organizationId }) });
      if (res.ok) { window.location.assign("/"); return; }
      onProblem("Your clinic couldn't be opened from this session. Sign out and sign in again.");
    } catch {
      onProblem("No answer arrived. Try opening your clinic again.");
    }
    setOpening(false);
  }
  return (
    <button type="button" onClick={() => void open()} disabled={opening} aria-busy={opening} className={`mt-3 ${primary}`}>
      {opening ? "Opening…" : "Open your clinic"}
    </button>
  );
}

function ChooseDoor({ application, newClinic, joinOpen, createOpen, syntheticOnly, onDone }: {
  application: JourneyState; newClinic: NewClinicState; joinOpen: boolean; createOpen: boolean; syntheticOnly: boolean;
  onDone: (message: string, failed: boolean) => Promise<void>;
}) {
  const [door, setDoor] = useState<"create" | "join">(joinOpen && !createOpen && !canProposeClinic(newClinic) ? "join" : "create");
  const id = useId();
  return (
    <Card className="px-4 py-[14px]">
      <fieldset className="m-0 border-0 p-0" data-testid="applicant-doors">
        <legend className="mb-2 text-[13px] font-semibold text-ink">What would you like to do?</legend>
        <div className="flex flex-col gap-[6px] text-[12.5px]">
          <label className="flex items-center gap-2">
            <input type="radio" name={`${id}-door`} value="create" checked={door === "create"} onChange={() => setDoor("create")} />
            Create a new clinic
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name={`${id}-door`} value="join" checked={door === "join"} onChange={() => setDoor("join")} />
            Request to join an existing clinic
          </label>
        </div>
      </fieldset>
      <div className="mt-3">
        {door === "create" ? (
          createOpen ? <CreateClinic syntheticOnly={syntheticOnly} onDone={onDone} />
          : <CreateNotOffered application={application} newClinic={newClinic} joinOpen={joinOpen} syntheticOnly={syntheticOnly} onDone={onDone} />
        ) : joinOpen ? <JoinClinic onDone={onDone} />
          : <p className="m-0 text-[12.5px] text-body" data-testid="join-not-offered">You already have a request waiting for a decision. You can withdraw it above.</p>}
      </div>
    </Card>
  );
}

function SyntheticNotice() {
  return (
    <p className="mt-2 mb-0 rounded-md border border-line bg-panel px-3 py-2 text-[11.5px] leading-[1.5] text-body" data-testid="synthetic-clinic-notice">
      <strong>Fictional test records only.</strong> This build isn&apos;t for real patient care. Use a fictional clinic name, and
      don&apos;t enter real patient information here or in the clinic you create.
    </p>
  );
}

/** Why the create form isn't shown, and the held proposal where it is the way to ask for a new clinic. */
function CreateNotOffered({ application, newClinic, joinOpen, syntheticOnly, onDone }: {
  application: JourneyState; newClinic: NewClinicState; joinOpen: boolean; syntheticOnly: boolean;
  onDone: (message: string, failed: boolean) => Promise<void>;
}) {
  const proposeOpen = joinOpen && canProposeClinic(newClinic);
  const why = newClinic.state === "closed"
    ? "Creating a clinic directly isn't open in this app yet."
    : hasCreatedClinic(newClinic) ? "This account has already created its clinic. A further clinic goes through the platform team's review."
    : newClinic.state === "unknown" ? "We couldn't check whether this account already has a clinic, so this page doesn't offer to create one. Check again in a moment."
    : application.state === "proposal_pending" ? "Your new-clinic proposal is waiting for review. Withdraw it first to create a clinic directly."
    : "Creating a clinic isn't available for this account right now.";
  return (
    <div data-testid="create-not-offered">
      <p className="m-0 text-[12.5px] text-body">{why}</p>
      {proposeOpen && <ProposeClinic syntheticOnly={syntheticOnly} onDone={onDone} />}
    </div>
  );
}

function CreateClinic({ syntheticOnly, onDone }: { syntheticOnly: boolean; onDone: (message: string, failed: boolean) => Promise<void> }) {
  const [clinicName, setClinicName] = useState("");
  const [sending, setSending] = useState(false);
  // One id per attempt, kept across a lost or unconfirmed reply so a resend is the same clinic, never a second one.
  const attempt = useRef<string | null>(null);
  const id = useId();
  const valid = validName(clinicName);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || sending) return;
    attempt.current ??= crypto.randomUUID();
    setSending(true);
    let outcome: CreateOutcome;
    try {
      const res = await fetch("/api/onboarding/clinic-bootstrap", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: attempt.current, clinicLabel: clinicName.trim() }) });
      const answer = (await res.json().catch(() => ({}))) as { error?: unknown; data?: { duplicate?: unknown; requestId?: unknown } };
      const confirmed = (res.status !== 200 && res.status !== 201) || answer.data?.requestId === attempt.current;
      outcome = createOutcome(confirmed ? { status: res.status, error: answer.error, duplicate: answer.data?.duplicate } : "no_answer");
    } catch {
      outcome = createOutcome("no_answer");
    }
    if (!outcome.keep) attempt.current = null;
    setSending(false);
    await onDone(CREATE_MESSAGE[outcome.kind], outcome.kind !== "created" && outcome.kind !== "already_created");
  }

  return (
    <form onSubmit={(event) => void submit(event)} aria-describedby={`${id}-help`} data-testid="create-clinic">
      <label htmlFor={`${id}-name`} className="block text-[11px] font-bold tracking-[0.04em] text-faint uppercase">Clinic name</label>
      <input id={`${id}-name`} value={clinicName} onChange={(event) => { setClinicName(event.target.value); attempt.current = null; }}
        maxLength={120} autoComplete="off" aria-invalid={clinicName !== "" && !valid}
        className="mt-1 h-9 w-full rounded-md border border-line bg-card px-2 text-[12.5px] text-body focus-visible:outline-2 focus-visible:outline-action" />
      <p id={`${id}-help`} className="mt-2 mb-0 text-[11.5px] leading-[1.5] text-subtle">
        This account becomes the owner of a new, empty clinic, with access to that clinic&apos;s records only. An account can
        create one clinic this way.
      </p>
      {syntheticOnly && <SyntheticNotice />}
      <button type="submit" disabled={!valid || sending} aria-busy={sending} className={`mt-3 ${primary}`}>
        {sending ? "Creating…" : "Create clinic"}
      </button>
    </form>
  );
}

type SubmitBody = { action: "submit"; requestId: string } & ({ kind: "join"; organizationId: string } | { kind: "create_clinic"; proposedLabel: string });
/** One application submission (a join or a held proposal) with a retry key kept across a lost reply. */
function useApplicationSubmit(onDone: (message: string, failed: boolean) => Promise<void>, refusal: string) {
  const [sending, setSending] = useState(false);
  const attempt = useRef<string | null>(null);
  async function send(body: (requestId: string) => SubmitBody) {
    attempt.current ??= crypto.randomUUID();
    setSending(true);
    try {
      const res = await fetch("/api/onboarding/application", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(attempt.current)) });
      const answer = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (res.status === 202) { attempt.current = null; await onDone("Your request was received.", false); return; }
      if (res.status === 409 && answer.error === "workforce_application_already_pending") { attempt.current = null; await onDone("You already have a request waiting for a decision.", true); return; }
      if (res.status === 400) { await onDone(refusal, true); return; }
      // The service does not say whether a clinic code exists, so a refused submission reads the same as an outage.
      attempt.current = null;
      await onDone(res.status === 503 || res.status >= 500
        ? "Your request wasn't submitted. If the clinic code is right, the service may be unavailable; try again later."
        : "Your request wasn't submitted.", true);
    } catch {
      await onDone("No answer arrived. Your request may have been received; check again, or send it again — sending again won't create a second request.", true);
    } finally {
      setSending(false);
    }
  }
  return { sending, send, reset: () => { attempt.current = null; } };
}

function JoinClinic({ onDone }: { onDone: (message: string, failed: boolean) => Promise<void> }) {
  const [clinicCode, setClinicCode] = useState("");
  const { sending, send, reset } = useApplicationSubmit(onDone, "Check the clinic code your clinic gave you.");
  const id = useId();
  const valid = UUID.test(clinicCode.trim());
  return (
    <form onSubmit={(event) => { event.preventDefault(); if (valid && !sending) void send((requestId) => ({ action: "submit", requestId, kind: "join", organizationId: clinicCode.trim().toLowerCase() })); }}
      aria-describedby={`${id}-help`} data-testid="applicant-submit">
      <label htmlFor={`${id}-code`} className="block text-[11px] font-bold tracking-[0.04em] text-faint uppercase">Clinic code</label>
      <input id={`${id}-code`} value={clinicCode} onChange={(event) => { setClinicCode(event.target.value); reset(); }}
        autoComplete="off" spellCheck={false} maxLength={36} aria-invalid={clinicCode !== "" && !valid}
        className="mt-1 h-9 w-full rounded-md border border-line bg-card px-2 font-mono text-[12px] text-body focus-visible:outline-2 focus-visible:outline-action" />
      <p id={`${id}-help`} className="mt-2 mb-0 text-[11.5px] leading-[1.5] text-subtle">
        There is no clinic search: your clinic gives you its code. Joining gives you no access until the clinic approves you.
      </p>
      <button type="submit" disabled={!valid || sending} aria-busy={sending} className={`mt-3 ${primary}`}>
        {sending ? "Sending…" : "Send request"}
      </button>
    </form>
  );
}

function ProposeClinic({ syntheticOnly, onDone }: { syntheticOnly: boolean; onDone: (message: string, failed: boolean) => Promise<void> }) {
  const [clinicName, setClinicName] = useState("");
  const { sending, send, reset } = useApplicationSubmit(onDone, "Check the clinic name: 3 to 120 characters.");
  const id = useId();
  const valid = validName(clinicName);
  return (
    <form onSubmit={(event) => { event.preventDefault(); if (valid && !sending) void send((requestId) => ({ action: "submit", requestId, kind: "create_clinic", proposedLabel: clinicName.trim() })); }}
      aria-describedby={`${id}-help`} data-testid="applicant-submit" className="mt-3">
      <label htmlFor={`${id}-name`} className="block text-[11px] font-bold tracking-[0.04em] text-faint uppercase">Proposed clinic name</label>
      <input id={`${id}-name`} value={clinicName} onChange={(event) => { setClinicName(event.target.value); reset(); }}
        maxLength={120} aria-invalid={clinicName !== "" && !valid}
        className="mt-1 h-9 w-full rounded-md border border-line bg-card px-2 text-[12.5px] text-body focus-visible:outline-2 focus-visible:outline-action" />
      <p id={`${id}-help`} className="mt-2 mb-0 text-[11.5px] leading-[1.5] text-subtle">
        You can ask the platform team to review a new clinic instead. Approval creates the clinic; it doesn&apos;t give anyone
        access to patients by itself.
      </p>
      {syntheticOnly && <SyntheticNotice />}
      <button type="submit" disabled={!valid || sending} aria-busy={sending} className={`mt-3 ${primary}`}>
        {sending ? "Sending…" : "Send proposal"}
      </button>
    </form>
  );
}

function WithdrawRequest({ request, onDone }: { request: ApplicationEntry; onDone: (message: string, failed: boolean) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  async function withdraw() {
    setSending(true);
    try {
      const res = await fetch("/api/onboarding/application", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "withdraw", requestId: request.id }) });
      if (res.ok) await onDone("Your request was withdrawn.", false);
      else if (res.status === 409) await onDone("The clinic already decided this request, so it can't be withdrawn.", true);
      else await onDone("Your request wasn't withdrawn. Try again.", true);
    } catch {
      await onDone("No answer arrived. Check again to see whether your request was withdrawn.", true);
    } finally { setSending(false); setConfirming(false); }
  }
  return (
    <Card className="px-4 py-[14px]">
      {!confirming ? (
        <button type="button" onClick={() => setConfirming(true)} className="h-8 rounded-md border border-line bg-card px-3 text-[12px] font-semibold text-critical focus-visible:outline-2 focus-visible:outline-action">
          Withdraw request {reference(request.id)}
        </button>
      ) : (
        <div role="group" aria-label={`Confirm withdrawing request ${reference(request.id)}`} className="flex flex-wrap items-center gap-2 text-[12.5px]">
          <span>Withdraw request {reference(request.id)}?</span>
          <button type="button" onClick={() => void withdraw()} disabled={sending} aria-busy={sending} className="h-8 rounded-md border border-critical bg-card px-3 text-[12px] font-semibold text-critical focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50">
            {sending ? "Withdrawing…" : "Yes, withdraw"}
          </button>
          <button type="button" onClick={() => setConfirming(false)} disabled={sending} className="h-8 rounded-md border border-line bg-card px-3 text-[12px] font-semibold text-body focus-visible:outline-2 focus-visible:outline-action">Keep it</button>
        </div>
      )}
    </Card>
  );
}
