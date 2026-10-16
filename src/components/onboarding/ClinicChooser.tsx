"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Card } from "@/components/ui/bits";
import { chooserRead, chooserState, type ChooserClinic, type ChooserState } from "@/lib/clinic-chooser";
import { localReturnPath } from "@/lib/local-return-path";
import { announceWorkforceSessionChange } from "@/lib/workforce-session-change";

/**
 * Choose the clinic to work in (src/lib/clinic-chooser.ts derives each state). The server checks the choice against
 * this account's own clinics read at that moment and binds it to this account; other tabs are told to drop their
 * state, and any write they still send under the previous clinic is refused by the expected-clinic fence.
 */
const primary = "inline-flex h-9 items-center rounded-lg bg-action px-4 text-[12.5px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50";
const label = (clinic: ChooserClinic) => clinic.name ?? `Clinic ${clinic.organizationId.slice(0, 8)}`;

export function ClinicChooser() {
  const [state, setState] = useState<ChooserState | null>(null);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const load = useCallback(async (announce = false) => {
    setChecking(true);
    let next: ChooserState;
    try {
      const res = await fetch("/api/auth/org", { cache: "no-store" });
      next = chooserState(chooserRead(res.status, await res.json().catch(() => null)));
    } catch {
      next = { state: "failed" };
    }
    setState(next);
    setChecking(false);
    if (announce) titleRef.current?.focus();
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!state) return <p role="status" className="m-0 text-[13px] text-subtle">Checking your clinics…</p>;
  const title = state.state === "signed_out" ? "Sign in to choose a clinic."
    : state.state === "failed" ? "We couldn't read your clinics."
    : state.state === "demo" ? "This build has no clinics to choose."
    : state.state === "none" ? "This account isn't an active member of any clinic yet."
    : state.state === "one" ? "Your clinic" : "Choose the clinic to work in";
  const detail = state.state === "failed" ? "This doesn't mean you have none. Try again in a moment."
    : state.state === "none" ? "Create a new clinic, or request to join the clinic that gave you a clinic code."
    : state.state === "several" ? "You belong to more than one clinic. Choose one; you can switch later in Settings." : null;
  return (
    <div className="flex flex-col gap-4" data-testid="clinic-chooser" data-state={state.state}>
      <Card className="px-4 py-[16px]">
        <h2 ref={titleRef} tabIndex={-1} className="m-0 text-[15px] font-semibold text-ink outline-none" data-testid="clinic-chooser-state">{title}</h2>
        {detail && <p className="mt-[6px] mb-0 text-[12.5px] leading-[1.55] text-body">{detail}</p>}
        {state.state === "signed_out" && <Link href="/login?next=/select-clinic" className={`mt-3 ${primary}`}>Sign in</Link>}
        {state.state === "none" && <Link href="/apply" className={`mt-3 ${primary}`}>Create or join a clinic</Link>}
        {(state.state === "failed" || state.state === "none") && (
          <button type="button" onClick={() => void load(true)} disabled={checking} aria-busy={checking}
            className="mt-3 block h-8 rounded-md border border-line bg-card px-3 text-[12px] font-semibold text-body focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50">
            {checking ? "Checking…" : "Check again"}
          </button>
        )}
        {(state.state === "one" || state.state === "several") && (
          <ChooseForm clinics={state.state === "one" ? [state.clinic] : state.clinics}
            current={state.state === "one" ? (state.current ? state.clinic.organizationId : null) : state.activeOrgId}
            onProblem={async (message) => { setProblem(message); await load(true); }} />
        )}
        <div aria-live="assertive" className="mt-2 text-[12.5px]">{problem && <p role="alert" className="m-0 text-critical">{problem}</p>}</div>
      </Card>
      {"pending" in state && state.pending.length > 0 && (
        <Card className="px-4 py-[14px]">
          <h2 className="m-0 mb-2 text-[12px] font-bold tracking-[0.04em] text-faint uppercase">Waiting for approval</h2>
          <ul className="m-0 flex list-none flex-col gap-[6px] p-0 text-[12.5px]" data-testid="clinic-chooser-pending">
            {state.pending.map((clinic) => <li key={clinic.organizationId} className="text-body">{clinic.name} — not available until the clinic approves you</li>)}
          </ul>
        </Card>
      )}
    </div>
  );
}

function ChooseForm({ clinics, current, onProblem }: { clinics: ChooserClinic[]; current: string | null; onProblem: (message: string) => Promise<void> }) {
  // Several clinics: nothing is chosen until the practitioner chooses.
  const [chosen, setChosen] = useState<string | null>(clinics.length === 1 ? clinics[0]!.organizationId : null);
  const [opening, setOpening] = useState(false);
  const id = useId();
  async function open() {
    if (!chosen || opening) return;
    setOpening(true);
    announceWorkforceSessionChange();
    try {
      const res = await fetch("/api/auth/org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId: chosen }) });
      if (res.ok) {
        window.location.replace(localReturnPath(new URLSearchParams(window.location.search).get("next")));
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: unknown } };
      setOpening(false);
      await onProblem(res.status === 403 && typeof body.error?.message === "string" ? body.error.message : "That clinic couldn't be opened. Check again, or sign out and sign in again.");
    } catch {
      setOpening(false);
      await onProblem("No answer arrived. Try again.");
    }
  }
  return (
    <form className="mt-3" onSubmit={(event) => { event.preventDefault(); void open(); }} data-testid="clinic-chooser-form">
      {clinics.length > 1 ? (
        <fieldset className="m-0 border-0 p-0">
          <legend className="sr-only">Your clinics</legend>
          <div className="flex flex-col gap-[6px] text-[12.5px]">
            {clinics.map((clinic) => (
              <label key={clinic.organizationId} className="flex items-center gap-2">
                <input type="radio" name={`${id}-clinic`} value={clinic.organizationId} checked={chosen === clinic.organizationId} onChange={() => setChosen(clinic.organizationId)} />
                {label(clinic)}{clinic.organizationId === current ? " (current)" : ""}
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <p className="m-0 text-[12.5px] font-semibold text-body">{label(clinics[0]!)}{clinics[0]!.organizationId === current ? " (current)" : ""}</p>
      )}
      <button type="submit" disabled={!chosen || opening} aria-busy={opening} className={`mt-3 ${primary}`}>
        {opening ? "Opening…" : clinics.length > 1 ? "Open clinic" : `Open ${label(clinics[0]!)}`}
      </button>
    </form>
  );
}
