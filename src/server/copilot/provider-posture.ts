/**
 * Phase 10B.1 — provider posture.
 *
 * SERVER-ONLY computation, but the RESULT is designed to be rendered. This
 * module is the single source of truth for what the application is allowed
 * to claim about the AI provider, so the UI and the API cannot drift into
 * two different stories.
 *
 * THE CENTRAL RULE
 * ----------------
 * An approval is `approved` only when a governed record supplies a
 * reference for it. Not an environment variable, not an API key, not a
 * model name, not a successful secret lookup, not a passing fixture test.
 * `deriveApprovalGates` below reads ONLY fields that originate from
 * `clinical_copilot_provider_registry` and `clinical_copilot_org_activations`
 * — rows that a platform admin had to write through an audited RPC.
 *
 * CONFIGURED IS NOT TRANSACTED
 * ----------------------------
 * These are reported as two separate booleans and rendered as two separate
 * facts. "We have a key" and "we have sent something" are different
 * claims, and collapsing them is how an organization comes to believe it
 * is live when nothing has ever been sent — or that it is safe because
 * nothing has been sent, when in fact something has.
 *
 * The seven states below are the entire public vocabulary. There is no
 * "connected" and no "HIPAA-ready", because this phase is not entitled to
 * say either.
 */

export type CopilotPostureState =
  | "disabled"
  | "configured_unapproved"
  | "approved_never_transacted"
  | "fixture_test_mode"
  | "live_unavailable"
  | "live_failed"
  | "live_transacted";

export type ApprovalGateName =
  | "openai_baa_verified"
  | "abuse_monitoring_or_zdr"
  | "production_provider_approval"
  | "organization_opt_in"
  | "clinical_sign_off"
  | "privacy_sign_off"
  | "security_sign_off"
  | "live_transaction_executed"
  | "phi_transmission_approved";

export type ApprovalGateStatus = "approved" | "not_approved" | "not_run";

export type ApprovalGate = {
  name: ApprovalGateName;
  label: string;
  status: ApprovalGateStatus;
  /** The governed record that backs an `approved` status. Never a secret. */
  reference: string | null;
};

/** Facts read from `clinical_copilot_provider_registry`. */
export type RegistryFacts = {
  providerName: string;
  providerKind: "openai_hipaa" | "anthropic_hipaa" | "platform_governed" | "synthetic_fixture";
  approvedModelAllowlist: string[];
  approvalReference: string | null;
  baaStatusReference: string | null;
  retentionMode: "zero" | "modified" | "standard" | "unspecified";
  processingRegion: string | null;
  /** Presence only — the value itself never leaves the server. */
  hasSecretRef: boolean;
  revocationState: "not_revoked" | "revoked";
  expirationDate: string | null;
};

/** Facts read from `clinical_copilot_org_activations`. */
export type ActivationFacts = {
  state:
    | "disabled"
    | "readiness_review"
    | "approved_for_synthetic"
    | "approved_for_phi"
    | "suspended"
    | "revoked";
  legalRef: string | null;
  privacyRef: string | null;
  clinicalRef: string | null;
  infraRef: string | null;
  retentionPosture: "unspecified" | "zero" | "modified" | "standard";
  supervisedRunsRequired: number;
  supervisedRunsCompleted: number;
};

export type TransactionFacts = {
  /** True only if a LIVE provider call has ever completed for this org. */
  everTransacted: boolean;
  lastRunStatus: "completed" | "failed" | "unavailable" | null;
  lastRunAt: string | null;
  /** PHI-safe category of the most recent failure, if any. */
  lastFailureCategory: string | null;
};

export type PostureInput = {
  mode: "disabled" | "fixture" | "live";
  /** Whether the runtime could build a live path at all. */
  runtimeAvailable: boolean;
  /**
   * Whether THIS runtime is allowed to produce synthetic content at all —
   * `!isDeployedRuntime() && isContractFixtureAllowed()`.
   *
   * Required, not optional-defaulting-to-true. An organization approved for
   * synthetic evaluation still gets nothing in a deployed runtime, and the
   * posture must say so rather than announcing "fixture test mode" for
   * content that will never be produced. A default would let a caller that
   * forgot the field make exactly that false claim.
   */
  syntheticPermitted: boolean;
  registry: RegistryFacts | null;
  activation: ActivationFacts | null;
  transactions: TransactionFacts;
};

export type ProviderPosture = {
  state: CopilotPostureState;
  label: string;
  /** Plain-language sentence the UI renders verbatim. */
  detail: string;
  /** Separate fact #1: is a provider configured at all? */
  configured: boolean;
  /** Separate fact #2: has anything ever actually been sent? */
  transacted: boolean;
  /** Every approval gate, always all nine, in a stable order. */
  gates: ApprovalGate[];
  /** True only when every non-transaction gate is approved. */
  approved: boolean;
  providerName: string | null;
  providerKind: string | null;
  retentionMode: string | null;
  processingRegion: string | null;
  supervisedRunsRequired: number | null;
  supervisedRunsCompleted: number | null;
  lastFailureCategory: string | null;
};

const GATE_LABELS: Record<ApprovalGateName, string> = {
  openai_baa_verified: "OpenAI BAA verification",
  abuse_monitoring_or_zdr: "Modified Abuse Monitoring / Zero Data Retention",
  production_provider_approval: "Production provider approval",
  organization_opt_in: "Organization opt-in",
  clinical_sign_off: "Clinical sign-off",
  privacy_sign_off: "Privacy sign-off",
  security_sign_off: "Security sign-off",
  live_transaction_executed: "Live transaction execution",
  phi_transmission_approved: "PHI transmission approval",
};

const STATE_LABELS: Record<CopilotPostureState, string> = {
  disabled: "Disabled",
  configured_unapproved: "Configured but unapproved",
  approved_never_transacted: "Approved but never transacted",
  fixture_test_mode: "Fixture test mode",
  live_unavailable: "Live unavailable",
  live_failed: "Live failed",
  live_transacted: "Live transacted",
};

/** A reference counts only if it is a non-empty, non-placeholder string. */
function ref(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Placeholders are how an unapproved posture gets recorded as approved by
  // accident. They are refused rather than trusted.
  if (/^(n\/?a|none|tbd|pending|todo|test|placeholder)$/i.test(trimmed)) return null;
  return trimmed;
}

function gate(
  name: ApprovalGateName,
  reference: string | null,
  opts: { notRunWhenAbsent?: boolean } = {},
): ApprovalGate {
  return {
    name,
    label: GATE_LABELS[name],
    status: reference ? "approved" : opts.notRunWhenAbsent ? "not_run" : "not_approved",
    reference,
  };
}

/**
 * Derive all nine approval gates from governed records only.
 *
 * Every branch below reads a persisted reference. There is deliberately no
 * `process.env` access in this function — an operator cannot promote a
 * gate by redeploying with a new variable.
 */
export function deriveApprovalGates(input: PostureInput): ApprovalGate[] {
  const r = input.registry;
  const a = input.activation;
  const revoked = r?.revocationState === "revoked";
  const expired = r?.expirationDate ? new Date(r.expirationDate).getTime() < Date.now() : false;
  const registryUsable = !!r && !revoked && !expired;

  const baaRef = registryUsable ? ref(r!.baaStatusReference) : null;

  // A retention CLAIM without the agreement that grants it is not approval.
  // OpenAI grants ZDR / Modified Abuse Monitoring under the BAA or an
  // enterprise agreement, so the BAA reference is what backs this gate.
  const retentionOk =
    registryUsable &&
    (r!.retentionMode === "zero" || r!.retentionMode === "modified") &&
    (a?.retentionPosture === "zero" || a?.retentionPosture === "modified");
  const zdrRef = retentionOk && baaRef ? `${baaRef}#retention:${r!.retentionMode}` : null;

  const providerApprovalRef =
    registryUsable && ref(r!.approvalReference) && ref(a?.legalRef ?? null)
      ? `${ref(r!.approvalReference)}+${ref(a!.legalRef)}`
      : null;

  const optedIn =
    a?.state === "approved_for_synthetic" || a?.state === "approved_for_phi"
      ? `activation:${a.state}`
      : null;

  return [
    gate("openai_baa_verified", baaRef, { notRunWhenAbsent: true }),
    gate("abuse_monitoring_or_zdr", zdrRef, { notRunWhenAbsent: true }),
    gate("production_provider_approval", providerApprovalRef),
    gate("organization_opt_in", optedIn),
    gate("clinical_sign_off", ref(a?.clinicalRef ?? null)),
    gate("privacy_sign_off", ref(a?.privacyRef ?? null)),
    gate("security_sign_off", ref(a?.infraRef ?? null)),
    gate(
      "live_transaction_executed",
      input.transactions.everTransacted ? (input.transactions.lastRunAt ?? "executed") : null,
      { notRunWhenAbsent: true },
    ),
    gate("phi_transmission_approved", a?.state === "approved_for_phi" ? "activation:approved_for_phi" : null),
  ];
}

/**
 * Compute the posture.
 *
 * Branch order is the contract — read it top to bottom:
 *   disabled       → nothing was consulted, nothing was contacted.
 *   fixture        → deterministic in-process content; never a live claim.
 *   not configured → live was asked for but no provider exists.
 *   not approved   → a provider exists but no governed record permits it.
 *   unavailable    → approved, but the runtime could not build a live path.
 *   failed         → approved and attempted; the last attempt failed.
 *   never transacted / transacted → the honest end states.
 */
export function computeProviderPosture(input: PostureInput): ProviderPosture {
  const gates = deriveApprovalGates(input);
  const approvalGates = gates.filter((g) => g.name !== "live_transaction_executed");
  const approved = approvalGates.every((g) => g.status === "approved");
  const configured = !!input.registry && input.registry.hasSecretRef;
  const transacted = input.transactions.everTransacted;

  const base = {
    configured,
    transacted,
    gates,
    approved,
    providerName: input.registry?.providerName ?? null,
    providerKind: input.registry?.providerKind ?? null,
    retentionMode: input.registry?.retentionMode ?? null,
    processingRegion: input.registry?.processingRegion ?? null,
    supervisedRunsRequired: input.activation?.supervisedRunsRequired ?? null,
    supervisedRunsCompleted: input.activation?.supervisedRunsCompleted ?? null,
    lastFailureCategory: input.transactions.lastFailureCategory,
  };

  const make = (state: CopilotPostureState, detail: string): ProviderPosture => ({
    ...base,
    state,
    label: STATE_LABELS[state],
    detail,
  });

  if (input.mode === "disabled") {
    return make(
      "disabled",
      "Not configured. External AI is disabled. No provider was contacted and no secret was requested.",
    );
  }
  if (input.mode === "fixture") {
    return make(
      "fixture_test_mode",
      "Fixture test mode. Content is deterministic and generated in-process. No external AI provider was contacted.",
    );
  }
  if (!configured) {
    // The process is capable of live, but this organization has registered
    // no provider. "Not configured" is the honest phrase — the org's
    // external AI is off, and saying "unavailable" would imply something
    // exists that is temporarily out of reach.
    return make(
      "disabled",
      "Not configured. No AI provider is registered for this organization. No provider was contacted and no secret was requested.",
    );
  }
  if (input.activation?.state === "approved_for_synthetic") {
    // The organization opted in to deterministic synthetic evaluation.
    // That is a real, recorded state — and it is emphatically NOT a live
    // claim, so it is reported before the approval roll-up.
    //
    // But the record only describes what the ORGANIZATION accepted. Whether
    // this RUNTIME may produce synthetic content is a separate question
    // answered categorically elsewhere: a deployed process never may, and
    // no governed row is an exception to that. Announcing "fixture test
    // mode" here would promise deterministic content that the provider
    // layer is about to refuse.
    if (!input.syntheticPermitted) {
      return make(
        "live_unavailable",
        "Synthetic evaluation is not available in this runtime. This organization is approved for " +
          "synthetic evaluation only, and synthetic content is never produced in a deployed runtime. " +
          "Nothing was sent, and no example content is shown.",
      );
    }
    return make(
      "fixture_test_mode",
      "Fixture test mode. This organization is approved for synthetic evaluation only. Content is deterministic and generated in-process; no external AI provider was contacted and no PHI was transmitted.",
    );
  }
  if (!approved) {
    const missing = approvalGates.filter((g) => g.status !== "approved").map((g) => g.label);
    return make(
      "configured_unapproved",
      `A provider is configured but not approved. Outstanding: ${missing.join(", ")}. Nothing was sent.`,
    );
  }
  if (!input.runtimeAvailable) {
    return make(
      "live_unavailable",
      "The provider is approved but the runtime could not establish a credentialed path. Nothing was sent.",
    );
  }
  if (input.transactions.lastRunStatus === "failed") {
    return make(
      `live_failed`,
      `The most recent live run failed (${input.transactions.lastFailureCategory ?? "unknown_failure"}). No content was fabricated in its place.`,
    );
  }
  if (!transacted) {
    return make(
      "approved_never_transacted",
      "Approved, but no live request has ever been sent. Approval is not transmission.",
    );
  }
  return make(
    "live_transacted",
    "A live request has been sent under the recorded approvals. Every output remains a draft.",
  );
}

/** The default posture when the backend cannot be reached at all. */
export function unavailablePosture(reason: string): ProviderPosture {
  return {
    state: "live_unavailable",
    label: STATE_LABELS.live_unavailable,
    detail: reason,
    configured: false,
    transacted: false,
    gates: deriveApprovalGates({
      mode: "live",
      runtimeAvailable: false,
      syntheticPermitted: false,
      registry: null,
      activation: null,
      transactions: { everTransacted: false, lastRunStatus: null, lastRunAt: null, lastFailureCategory: null },
    }),
    approved: false,
    providerName: null,
    providerKind: null,
    retentionMode: null,
    processingRegion: null,
    supervisedRunsRequired: null,
    supervisedRunsCompleted: null,
    lastFailureCategory: null,
  };
}
