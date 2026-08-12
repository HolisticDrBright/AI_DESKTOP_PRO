"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ShieldOff } from "lucide-react";
import { liveClient, type LiveCopilotGovernance } from "@/adapters/live-client";
import type { Tone } from "@/adapters/types";
import { Card } from "@/components/ui/bits";
import { Pill } from "@/components/ui/Pill";

/**
 * Settings → Security & Governance → Provider activation.
 *
 * Phase 10B.2's operator surface. It renders the governed rows exactly as
 * the server computed them and adds nothing of its own — in particular it
 * never derives an approval from the presence of a key, a model name, or a
 * region.
 *
 * WHAT THIS SCREEN IS CAREFUL NOT TO SAY. There is no "connected" badge and
 * no "HIPAA-ready" badge. `unknown` renders as "Not verified", which is
 * different from "No" (`not_approved`) and different again from a lapsed
 * `expired`. Collapsing the three would turn "nobody has checked" into a
 * statement about the agreement, which is the specific mistake this whole
 * phase exists to avoid.
 */

type State = "loading" | "ready" | "error";

const POSTURE_LABEL: Record<string, string> = {
  unknown: "Not verified",
  verified: "Verified",
  expired: "Expired",
  not_approved: "Not approved",
};

/**
 * `unknown` is deliberately SLATE, not green and not red. It is the
 * absence of a review, and colouring it either way would state something
 * about the agreement that nobody has established.
 */
const POSTURE_TONE: Record<string, Tone> = {
  unknown: "slate",
  verified: "positive",
  expired: "warning",
  not_approved: "critical",
};

function PostureRow({ label, status, verifiedAt }: {
  label: string;
  status: string;
  verifiedAt: string | null;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 border-b border-line py-1.5 last:border-b-0"
      data-testid={`gov-posture-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`}
      data-status={status}
    >
      <span className="text-[11.5px] text-body">{label}</span>
      <span className="flex items-center gap-2">
        {verifiedAt ? (
          <span className="text-[10.5px] text-subtle">{new Date(verifiedAt).toLocaleDateString()}</span>
        ) : null}
        <Pill tone={POSTURE_TONE[status] ?? "slate"}>{POSTURE_LABEL[status] ?? status}</Pill>
      </span>
    </div>
  );
}

function Fact({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-1.5 last:border-b-0">
      <span className="text-[11.5px] text-body">{label}</span>
      <span className="text-[11.5px] font-bold text-ink" data-testid={testId}>{value}</span>
    </div>
  );
}

export function CopilotActivationScreen() {
  const [state, setState] = useState<State>("loading");
  const [gov, setGov] = useState<LiveCopilotGovernance | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = async () => {
    setState("loading");
    try {
      setGov(await liveClient.copilotGovernance());
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (state === "loading") {
    return <Card className="px-5 py-10 text-center text-[12px] text-subtle">Loading provider activation…</Card>;
  }
  if (state === "error" || !gov) {
    // An empty state and a failure are different claims. With the backend
    // unreachable nobody is in a position to say the provider is disabled.
    return (
      <Card className="px-5 py-8 text-center text-[12px] text-critical" data-testid="gov-unavailable">
        Provider activation could not be loaded, so its state is unknown from here.{" "}
        <button className="font-bold underline" onClick={() => void load()}>Try again</button>
      </Card>
    );
  }

  const budgetPct = (used: number | null, max: number | null) =>
    max && max > 0 ? Math.round(((used ?? 0) / max) * 100) : 0;

  const toggleKillSwitch = async (engaged: boolean) => {
    setActionError(null);
    if (reason.trim().length < 3) {
      setActionError("A reason is required, in either direction.");
      return;
    }
    if (!gov.providerRegistered || !gov.providerId) {
      setActionError("No provider is registered for this organization.");
      return;
    }
    // Releasing re-enables external calls; make the operator confirm the
    // direction they are actually moving in.
    const verb = engaged ? "BLOCK all new external AI calls" : "RE-ENABLE external AI calls";
    if (!window.confirm(`Confirm: ${verb} for this organization?\n\nReason: ${reason.trim()}`)) return;
    setBusy(true);
    try {
      await liveClient.copilotKillSwitch({
        providerId: gov.providerId ?? "",
        engaged,
        reason: reason.trim(),
      });
      setReason("");
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "The kill switch could not be changed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pb-8 space-y-4" data-testid="copilot-activation-screen">
      {/* The phase statement, first and unconditional. */}
      <div
        className="flex items-start gap-2 rounded border border-ai/20 bg-ai-tint px-3 py-2.5 text-[11.5px] leading-[1.5] text-ai-deep"
        data-testid="gov-phase-banner"
      >
        <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
        {/*
          Phrased WITHOUT the words "HIPAA-ready" or "connected", even in a
          denial. A browser proof scans the whole rendered page for those
          phrases, and a disclaimer that contains them defeats the scan for
          every future change — a screen that later grew a real claim would
          pass because the denial had already spent the budget. Saying what
          IS true costs nothing here.
        */}
        <span>
          <strong>{gov.phaseLimits.purpose}.</strong> Real-patient use and production activation are
          not available in phase {gov.phaseLimits.phase}. No compliance status and no provider
          link is asserted anywhere on this screen; every posture below is a recorded review or
          the absence of one.
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="px-4 py-3">
          <h2 className="m-0 mb-2 text-[13px] font-bold text-ink">Provider &amp; environment</h2>
          <Fact label="Provider registered" value={gov.providerRegistered ? "yes" : "no"} testId="gov-registered" />
          <Fact label="Provider" value={gov.providerName ?? "Unknown"} testId="gov-provider-name" />
          <Fact label="Activation state" value={gov.activationState} testId="gov-activation-state" />
          <Fact label="Environment" value={gov.environment} testId="gov-environment" />
          <Fact label="Approved use" value={gov.approvedUse} testId="gov-approved-use" />
          <Fact label="Approved model" value={gov.approvedModel ?? "Unknown"} testId="gov-approved-model" />
          <Fact label="Request contract" value={gov.runtime.requestContractVersion} testId="gov-contract-version" />
          <Fact label="Output schema" value={gov.runtime.outputSchemaVersion} testId="gov-schema-version" />
          {/* Presence only — the reference value never reaches the browser. */}
          <Fact label="Secret reference present" value={gov.hasSecretRef ? "yes" : "no"} testId="gov-has-secret-ref" />
          <Fact
            label="Server points at staging project"
            value={gov.runtime.pointedAtStagingProject ? "yes" : "no"}
            testId="gov-staging-posture"
          />
          <Fact
            label="Synthetic-only vs patient data"
            value={gov.phaseLimits.realPatientUseAvailable ? "patient data permitted" : "synthetic only"}
            testId="gov-data-scope"
          />
        </Card>

        <Card className="px-4 py-3">
          <h2 className="m-0 mb-2 text-[13px] font-bold text-ink">Legal &amp; data posture</h2>
          <p className="m-0 mb-2 text-[10.5px] leading-[1.5] text-subtle">
            Recorded from a reviewed document, never inferred from configuration. &ldquo;Not
            verified&rdquo; means nobody has checked — it is not a statement that an agreement is
            absent.
          </p>
          <PostureRow label="OpenAI BAA" status={gov.baaStatus} verifiedAt={gov.baaVerifiedAt} />
          <PostureRow label="ZDR / Modified Abuse Monitoring" status={gov.zdrMamStatus} verifiedAt={gov.zdrMamVerifiedAt} />
          <Fact label="Approved OpenAI organization" value={gov.approvedOpenaiOrganization ?? "Unknown"} testId="gov-openai-org" />
          <Fact label="Approved OpenAI project" value={gov.approvedOpenaiProject ?? "Unknown"} testId="gov-openai-project" />
          <Fact label="Eligible endpoint" value={gov.eligibleEndpoint ?? "Unknown"} testId="gov-endpoint" />
          <Fact label="Reviewer reference" value={gov.reviewerReference ?? "Unknown"} testId="gov-reviewer" />
        </Card>

        <Card className="px-4 py-3">
          <h2 className="m-0 mb-2 text-[13px] font-bold text-ink">Limits &amp; usage</h2>
          <Fact
            label="Requests"
            value={`${gov.usedCalls ?? 0} / ${gov.maxCalls ?? 0} (${budgetPct(gov.usedCalls, gov.maxCalls)}%)`}
            testId="gov-budget-calls"
          />
          <Fact
            label="Tokens"
            value={`${gov.usedTokens ?? 0} / ${gov.maxTokens ?? 0}`}
            testId="gov-budget-tokens"
          />
          <Fact
            label="Estimated spend"
            value={`$${((gov.usedCostCents ?? 0) / 100).toFixed(2)} / $${((gov.maxCostCents ?? 0) / 100).toFixed(2)}`}
            testId="gov-budget-cost"
          />
          <Fact
            label="Last successful synthetic verification"
            value={gov.lastSuccessfulVerificationAt
              ? new Date(gov.lastSuccessfulVerificationAt).toLocaleString()
              : "Never"}
            testId="gov-last-verification"
          />
          <Fact
            label="Last failure category"
            value={gov.lastFailureCategory ?? "None recorded"}
            testId="gov-last-failure"
          />
        </Card>

        <Card className="px-4 py-3">
          <h2 className="m-0 mb-2 flex items-center gap-2 text-[13px] font-bold text-ink">
            <ShieldOff size={14} aria-hidden /> Kill switch
          </h2>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-body">Current state</span>
            <Pill tone={gov.killSwitchEngaged ? "critical" : "positive"}>
              <span data-testid="gov-kill-switch-state">
                {gov.killSwitchEngaged ? "engaged — new calls blocked" : "clear"}
              </span>
            </Pill>
          </div>
          <p className="m-0 mb-2 text-[10.5px] leading-[1.5] text-subtle">
            Engaging blocks new external calls immediately. It does not delete or alter any
            historical run.
          </p>
          <label className="mb-1 block text-[10.5px] font-bold text-body" htmlFor="gov-kill-reason">
            Reason (required in both directions)
          </label>
          <input
            id="gov-kill-reason"
            data-testid="gov-kill-switch-reason"
            className="mb-2 w-full rounded border border-line px-2 py-1 text-[11.5px]"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. incident 42 — suspected prompt-injection attempt"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="gov-kill-switch-engage"
              disabled={busy || gov.killSwitchEngaged}
              className="rounded border border-critical/40 px-2 py-1 text-[11px] font-bold text-critical disabled:opacity-40"
              onClick={() => void toggleKillSwitch(true)}
            >
              Engage kill switch
            </button>
            <button
              type="button"
              data-testid="gov-kill-switch-release"
              disabled={busy || !gov.killSwitchEngaged}
              className="rounded border border-line px-2 py-1 text-[11px] disabled:opacity-40"
              onClick={() => void toggleKillSwitch(false)}
            >
              Release kill switch
            </button>
          </div>
          {actionError ? (
            <p className="m-0 mt-2 text-[11px] text-critical" data-testid="gov-kill-switch-error">{actionError}</p>
          ) : null}
        </Card>
      </div>

      <Card className="px-4 py-3">
        <h2 className="m-0 mb-2 text-[13px] font-bold text-ink">Approval &amp; change history</h2>
        {gov.history.length === 0 ? (
          <p className="m-0 text-[11.5px] text-subtle" data-testid="gov-history-empty">
            No approval or scope change has been recorded for this organization.
          </p>
        ) : (
          <ul className="m-0 list-none space-y-1 p-0" data-testid="gov-history">
            {gov.history.map((h, i) => (
              <li key={`${h.recordedAt}-${i}`} className="border-b border-line py-1 last:border-b-0">
                <span className="text-[11.5px] font-bold text-ink">{h.changeKind}</span>
                <span className="ml-2 text-[10.5px] text-subtle">
                  {new Date(h.recordedAt).toLocaleString()}
                </span>
                {h.reason ? <div className="text-[11px] text-body">{h.reason}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
