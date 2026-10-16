"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Card } from "@/components/ui/bits";
import { PROPOSAL_REJECTION_REASONS } from "@/contracts/workforceJoinReview";
import { BOOTSTRAP_SUSPENSION_REASONS, type BootstrapSuspensionReason } from "@/contracts/workforceClinicBootstrap";
import type { BootstrappedClinic, OperatorProposal } from "@/contracts/platformOperatorConsole";
import { DECISION_LABEL, operatorRead, PROPOSAL_REJECTION_LABEL, SUSPENSION_REASON_LABEL, type OperatorRead } from "@/lib/operator-console";

/**
 * The platform operator console (platform-operator-console/1). Sign-in is the operator's own (operator pool, password
 * then TOTP), never a practitioner session. Every decision names a reason from a closed list and is shown back as the
 * service recorded it; the deciding operator appears only as a fingerprint. Approving a proposal is held: it creates a
 * clinic and gives nobody patient access. No reinstatement is defined, so none is offered.
 */
const primary = "inline-flex h-8 items-center rounded-md bg-action px-3 text-[12px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50";
const secondary = "inline-flex h-8 items-center rounded-md border border-line bg-card px-3 text-[12px] font-semibold text-body focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50";
const danger = "inline-flex h-8 items-center rounded-md border border-critical bg-card px-3 text-[12px] font-semibold text-critical focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50";
const reference = (id: string) => id.slice(0, 8);
const when = (value: string | null) => (value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Unknown");
const send = (method: "POST" | "DELETE", path: string, body?: unknown) => fetch(path, { method, headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body) });

type Session = { state: "checking" } | { state: "not_released" } | { state: "failed" } | { state: "signed_out"; notice?: string } | { state: "signed_in" };

export function OperatorConsole() {
  const [session, setSession] = useState<Session>({ state: "checking" });
  const check = useCallback(async (notice?: string) => {
    try {
      const res = await fetch("/api/operator/session", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { data?: { signedIn?: unknown }; error?: unknown } | null;
      if (res.status === 503 && body?.error === "platform_operator_not_released") { setSession({ state: "not_released" }); return; }
      if (!res.ok || typeof body?.data?.signedIn !== "boolean") { setSession({ state: "failed" }); return; }
      setSession(body.data.signedIn ? { state: "signed_in" } : { state: "signed_out", notice });
    } catch { setSession({ state: "failed" }); }
  }, []);
  useEffect(() => { void check(); }, [check]);
  const endSession = useCallback(() => void check("Your operator sign-in ended or was refused. Sign in again."), [check]);

  if (session.state === "checking") return <p role="status" className="m-0 text-[13px] text-subtle">Checking the operator console…</p>;
  return (
    <div className="flex flex-col gap-4" data-testid="operator-console" data-state={session.state}>
      {session.state === "not_released" && (
        <Card className="px-4 py-[16px]">
          <h2 className="m-0 text-[15px] font-semibold text-ink" data-testid="operator-state">The operator console isn&apos;t released in this build.</h2>
          <p className="mt-[6px] mb-0 text-[12.5px] leading-[1.55] text-body">Nothing here can review a proposal or suspend a clinic. Operator sign-in is separate from practitioner sign-in and isn&apos;t available yet.</p>
        </Card>
      )}
      {session.state === "failed" && (
        <Card className="px-4 py-[16px]">
          <h2 className="m-0 text-[15px] font-semibold text-ink" data-testid="operator-state">We couldn&apos;t check the operator console.</h2>
          <button type="button" className={`mt-3 ${secondary}`} onClick={() => void check()}>Check again</button>
        </Card>
      )}
      {session.state === "signed_out" && <OperatorSignIn notice={session.notice} onSignedIn={() => void check()} />}
      {session.state === "signed_in" && (
        <>
          <Card className="flex items-center justify-between px-4 py-[12px]">
            <p className="m-0 text-[12.5px] text-body" data-testid="operator-state">Signed in as a platform operator. The session ends after 15 minutes.</p>
            <button type="button" className={secondary} onClick={async () => { await send("DELETE", "/api/operator/session").catch(() => undefined); void check(); }}>Sign out</button>
          </Card>
          <ProposalQueue onSessionEnded={endSession} />
          <BootstrappedClinics onSessionEnded={endSession} />
        </>
      )}
    </div>
  );
}

function OperatorSignIn({ notice, onSignedIn }: { notice?: string; onSignedIn: () => void }) {
  const [step, setStep] = useState<"password" | "code">("password");
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [code, setCode] = useState("");
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState<string | null>(notice ?? null);
  const id = useId();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setProblem(null);
    try {
      const res = await send("POST", "/api/operator/session", step === "password" ? { email, password } : { code });
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (step === "password" && res.status === 202) { setPassword(""); setStep("code"); return; }
      if (step === "code" && res.ok) { onSignedIn(); return; }
      setPassword(""); setCode(""); setStep("password");
      setProblem(body?.error === "platform_operator_rate_limited" ? "Too many attempts. Wait a minute, then try again."
        : body?.error === "operator_service_not_configured" ? "Operator sign-in isn't configured on this deployment."
        : res.status >= 500 ? "The operator sign-in service didn't answer. Try again." : "Sign-in failed. Check your details and try again.");
    } catch {
      setProblem("No answer arrived. Try again.");
    } finally { setBusy(false); }
  }
  return (
    <Card className="px-4 py-[16px]">
      <form onSubmit={(event) => void submit(event)} data-testid="operator-sign-in">
        <h2 className="m-0 text-[15px] font-semibold text-ink" data-testid="operator-state">Operator sign-in</h2>
        <p className="mt-[6px] mb-3 text-[12px] leading-[1.5] text-subtle">This isn&apos;t your practitioner sign-in. Use your platform operator account and its authenticator app.</p>
        {step === "password" ? (
          <>
            <label htmlFor={`${id}-email`} className="block text-[11px] font-bold tracking-[0.04em] text-faint uppercase">Operator email</label>
            <input id={`${id}-email`} type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254}
              className="mt-1 mb-2 h-9 w-full rounded-md border border-line bg-card px-2 text-[12.5px] text-body focus-visible:outline-2 focus-visible:outline-action" />
            <label htmlFor={`${id}-password`} className="block text-[11px] font-bold tracking-[0.04em] text-faint uppercase">Password</label>
            <input id={`${id}-password`} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={256}
              className="mt-1 h-9 w-full rounded-md border border-line bg-card px-2 text-[12.5px] text-body focus-visible:outline-2 focus-visible:outline-action" />
          </>
        ) : (
          <>
            <label htmlFor={`${id}-code`} className="block text-[11px] font-bold tracking-[0.04em] text-faint uppercase">Authenticator code</label>
            <input id={`${id}-code`} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              className="mt-1 h-9 w-full rounded-md border border-line bg-card px-2 font-mono text-[12.5px] text-body focus-visible:outline-2 focus-visible:outline-action" />
          </>
        )}
        <button type="submit" disabled={busy || (step === "password" ? !email || !password : code.length !== 6)} aria-busy={busy} className={`mt-3 ${primary}`}>
          {busy ? "Signing in…" : step === "password" ? "Continue" : "Verify and sign in"}
        </button>
        <div aria-live="assertive" className="mt-2 text-[12.5px]">{problem && <p role="alert" className="m-0 text-critical">{problem}</p>}</div>
      </form>
    </Card>
  );
}

function useOperatorList<T>(path: string, pick: (data: unknown) => T | null, onSessionEnded: () => void) {
  const [read, setRead] = useState<OperatorRead<T> | null>(null);
  const load = useCallback(async () => {
    let next: OperatorRead<T>;
    try {
      const res = await fetch(path, { cache: "no-store" });
      next = operatorRead(res.status, await res.json().catch(() => null), pick);
    } catch { next = { kind: "failed" }; }
    if (next.kind === "signed_out" || next.kind === "refused") { onSessionEnded(); return; }
    setRead(next);
  }, [path, pick, onSessionEnded]);
  useEffect(() => { void load(); }, [load]);
  return { read, load };
}
function ListState({ read, empty, label }: { read: OperatorRead<unknown[]> | null; empty: string; label: string }) {
  if (!read) return <p role="status" className="m-0 text-[12.5px] text-subtle">Loading {label}…</p>;
  if (read.kind === "answered") return read.value.length === 0 ? <p className="m-0 text-[12.5px] text-body" data-testid={`${label}-empty`}>{empty}</p> : null;
  return (
    <p role="alert" className="m-0 text-[12.5px] text-critical" data-testid={`${label}-unavailable`}>
      {read.kind === "not_released" ? "This part of the console isn't released." : read.kind === "not_configured" ? "The operator service isn't configured on this deployment."
        : `We couldn't load ${label}. This doesn't mean there are none.`}
    </p>
  );
}
async function decide(path: string, body: unknown): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; status: number; error: unknown }> {
  try {
    const res = await send("POST", path, body);
    const answer = (await res.json().catch(() => null)) as { data?: Record<string, unknown>; error?: unknown } | null;
    return res.ok && answer?.data ? { ok: true, data: answer.data } : { ok: false, status: res.status, error: answer?.error };
  } catch { return { ok: false, status: 0, error: "no_answer" }; }
}
const refusalText = (status: number, error: unknown) => error === "no_answer" ? "No answer arrived. Reload the list to see whether the decision was recorded."
  : error === "operator_self_approval_refused" ? "You can't decide about a clinic you own."
  : error === "not_found" ? "That request or clinic wasn't found." : error === "conflict" ? "It was already decided; reload the list."
  : status === 400 ? "The decision wasn't valid. Choose a reason from the list." : "The decision wasn't recorded. Reload the list and try again.";

const pickProposals = (data: unknown) => Array.isArray((data as { proposals?: unknown })?.proposals) ? (data as { proposals: OperatorProposal[] }).proposals : null;
function ProposalQueue({ onSessionEnded }: { onSessionEnded: () => void }) {
  const { read, load } = useOperatorList("/api/operator/clinic-proposals", pickProposals, onSessionEnded);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const done = async (text: string, failed: boolean) => { setMessage({ text, failed }); await load(); };
  return (
    <Card className="px-4 py-[14px]">
      <h2 className="m-0 mb-1 text-[13px] font-semibold text-ink">New-clinic proposals</h2>
      <p className="m-0 mb-3 text-[11.5px] leading-[1.5] text-subtle">Approving a proposal creates the clinic under an activation hold. It gives nobody access to patients.</p>
      <div aria-live="polite" className="mb-2 text-[12.5px]">{message && <p role={message.failed ? "alert" : "status"} className={`m-0 ${message.failed ? "text-critical" : "text-positive"}`}>{message.text}</p>}</div>
      <ListState read={read as OperatorRead<unknown[]> | null} empty="No proposals have been submitted." label="proposals" />
      {read?.kind === "answered" && read.value.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="operator-proposals">
          {read.value.map((proposal) => <ProposalRow key={proposal.id} proposal={proposal} onDone={done} />)}
        </ul>
      )}
    </Card>
  );
}
function ProposalRow({ proposal, onDone }: { proposal: OperatorProposal; onDone: (text: string, failed: boolean) => Promise<void> }) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false);
  const id = useId();
  async function submit(action: "approve" | "reject") {
    setBusy(true);
    const answer = await decide("/api/operator/clinic-proposals", action === "approve" ? { action, requestId: proposal.id } : { action, requestId: proposal.id, reason });
    setBusy(false); setConfirming(false);
    await onDone(answer.ok ? (action === "approve" ? `Proposal ${reference(proposal.id)} approved. The clinic is held: nobody has patient access through it.` : `Proposal ${reference(proposal.id)} declined.`)
      : refusalText(answer.status, answer.error), !answer.ok);
  }
  return (
    <li aria-label={`Proposal ${reference(proposal.id)}`} className="rounded-md border border-line px-3 py-2 text-[12.5px]">
      <p className="m-0 font-semibold text-body">{proposal.proposedLabel} · {reference(proposal.id)}</p>
      <p className="m-0 text-subtle">Submitted {when(proposal.createdAt)} · {proposal.status === "pending" ? "Waiting for a decision"
        : `${proposal.status[0]!.toUpperCase()}${proposal.status.slice(1)} ${when(proposal.decidedAt)} — ${proposal.decisionReason ? DECISION_LABEL[proposal.decisionReason] ?? "Unknown" : "Unknown"}`}</p>
      {proposal.status === "pending" && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          {!confirming ? <button type="button" className={primary} disabled={busy} onClick={() => setConfirming(true)}>Approve</button> : (
            <span role="group" aria-label={`Confirm approving proposal ${reference(proposal.id)}`} className="flex items-center gap-2">
              <button type="button" className={primary} disabled={busy} onClick={() => void submit("approve")}>Yes, approve (held)</button>
              <button type="button" className={secondary} disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
            </span>
          )}
          <label htmlFor={`${id}-reason`} className="sr-only">Reason to decline proposal {reference(proposal.id)}</label>
          <select id={`${id}-reason`} value={reason} onChange={(event) => setReason(event.target.value)} className="h-8 rounded-md border border-line bg-card px-2 text-[12px] text-body">
            <option value="">Reason to decline…</option>
            {PROPOSAL_REJECTION_REASONS.map((value) => <option key={value} value={value}>{PROPOSAL_REJECTION_LABEL[value]}</option>)}
          </select>
          <button type="button" className={danger} disabled={busy || !reason} onClick={() => void submit("reject")}>Decline</button>
        </div>
      )}
    </li>
  );
}

const pickClinics = (data: unknown) => Array.isArray((data as { clinics?: unknown })?.clinics) ? (data as { clinics: BootstrappedClinic[] }).clinics : null;
function BootstrappedClinics({ onSessionEnded }: { onSessionEnded: () => void }) {
  const { read, load } = useOperatorList("/api/operator/bootstrapped-clinics", pickClinics, onSessionEnded);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const done = async (text: string, failed: boolean) => { setMessage({ text, failed }); await load(); };
  return (
    <Card className="px-4 py-[14px]">
      <h2 className="m-0 mb-1 text-[13px] font-semibold text-ink">Clinics created by their owners</h2>
      <p className="m-0 mb-3 text-[11.5px] leading-[1.5] text-subtle">Suspending a clinic ends access to its records for its owner and staff at once. No reinstatement process is defined, so this console can&apos;t reinstate a clinic.</p>
      <div aria-live="polite" className="mb-2 text-[12.5px]">{message && <p role={message.failed ? "alert" : "status"} className={`m-0 ${message.failed ? "text-critical" : "text-positive"}`}>{message.text}</p>}</div>
      <ListState read={read as OperatorRead<unknown[]> | null} empty="No clinics have been created this way." label="clinics" />
      {read?.kind === "answered" && read.value.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="operator-clinics">
          {read.value.map((clinic) => <ClinicRow key={clinic.organizationId} clinic={clinic} onDone={done} />)}
        </ul>
      )}
    </Card>
  );
}
function ClinicRow({ clinic, onDone }: { clinic: BootstrappedClinic; onDone: (text: string, failed: boolean) => Promise<void> }) {
  const [reason, setReason] = useState<BootstrapSuspensionReason | "">(""), [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false);
  const id = useId();
  async function suspend() {
    if (!reason) return;
    setBusy(true);
    const answer = await decide("/api/operator/bootstrapped-clinics", { organizationId: clinic.organizationId, reason });
    setBusy(false); setConfirming(false);
    await onDone(answer.ok ? `${clinic.clinicLabel} suspended: ${SUSPENSION_REASON_LABEL[reason]}.${answer.data.duplicate === true ? " It was already suspended; nothing new was recorded." : ""}`
      : refusalText(answer.status, answer.error), !answer.ok);
  }
  return (
    <li aria-label={`Clinic ${reference(clinic.organizationId)}`} className="rounded-md border border-line px-3 py-2 text-[12.5px]">
      <p className="m-0 font-semibold text-body">{clinic.clinicLabel} · {reference(clinic.organizationId)} · {clinic.status === "active" ? "Active" : "Suspended"}</p>
      <ol className="m-0 mt-1 list-none p-0 text-subtle" aria-label="Recorded decisions">
        {clinic.events.map((event, index) => (
          <li key={index}>{event.action === "bootstrapped" ? `Created by its owner ${when(event.occurredAt)}`
            : `Suspended ${when(event.occurredAt)} — ${event.reason ? SUSPENSION_REASON_LABEL[event.reason] : "Unknown"} — by operator ${event.operator ?? "Unknown"}${event.byCaller ? " (you)" : ""}`}</li>
        ))}
      </ol>
      {clinic.status === "active" ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label htmlFor={`${id}-reason`} className="sr-only">Reason to suspend {clinic.clinicLabel}</label>
          <select id={`${id}-reason`} value={reason} onChange={(event) => setReason(event.target.value as BootstrapSuspensionReason | "")} className="h-8 rounded-md border border-line bg-card px-2 text-[12px] text-body">
            <option value="">Reason to suspend…</option>
            {BOOTSTRAP_SUSPENSION_REASONS.map((value) => <option key={value} value={value}>{SUSPENSION_REASON_LABEL[value]}</option>)}
          </select>
          {!confirming ? <button type="button" className={danger} disabled={busy || !reason} onClick={() => setConfirming(true)}>Suspend</button> : (
            <span role="group" aria-label={`Confirm suspending ${clinic.clinicLabel}`} className="flex items-center gap-2">
              <button type="button" className={danger} disabled={busy} onClick={() => void suspend()}>Yes, suspend</button>
              <button type="button" className={secondary} disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
            </span>
          )}
        </div>
      ) : <p className="m-0 mt-1 text-body">Suspended. No reinstatement process is defined.</p>}
    </li>
  );
}
