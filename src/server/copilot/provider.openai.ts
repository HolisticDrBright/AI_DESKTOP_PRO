/**
 * Phase 10B.1 — OpenAI provider adapter.
 *
 * SERVER-ONLY. Never bundled into the client. Never contacts OpenAI in
 * this PR — the adapter evaluates the approval gates and refuses. The
 * scaffold below is what the Phase 10B.2 supervised activation will
 * replace once every gate below is satisfied and recorded:
 *
 *   - executed OpenAI BAA (registry.baa_status_reference is not null)
 *   - Modified Retention posture (registry.retention_mode in ('zero','modified'))
 *   - per-org state = approved_for_synthetic OR approved_for_phi
 *   - PHI only allowed on approved_for_phi
 *   - active (not revoked, not expired, not suspended)
 *   - platform_governed OR org_byok key ref, RESOLVED FROM SECRET MANAGER
 *
 * If ANY gate fails, the adapter raises `CopilotUnavailable`. Consumer
 * ChatGPT (chat.openai.com) is REJECTED unconditionally — a governed
 * clinical provider is never the consumer product.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/provider.openai is server-only.");
}

import { CopilotUnavailable, type CopilotDraftOutput, type CopilotProvider, type CopilotRunType } from "./provider";

export type OpenAIProviderApproval = {
  providerName: string;
  providerKind: "openai_hipaa" | "anthropic_hipaa" | "platform_governed" | "synthetic_fixture";
  approvedModelAllowlist: string[];
  approvalReference: string;
  baaStatusReference: string | null;
  retentionMode: "zero" | "modified" | "standard" | "unspecified";
  processingRegion: string | null;
  keyOwnership: "platform_governed" | "org_byok";
  activationDate: string | null;
  expirationDate: string | null;
  revocationState: "not_revoked" | "revoked";
  orgActivationState:
    | "disabled"
    | "readiness_review"
    | "approved_for_synthetic"
    | "approved_for_phi"
    | "suspended"
    | "revoked";
  containsPHI: boolean;
};

/**
 * Deterministic pre-flight refusal decision. Runs BEFORE any secret
 * resolution and BEFORE any network attempt. The reasons returned are
 * PHI-safe categories, never raw error text.
 */
export function evaluateOpenAIApproval(approval: OpenAIProviderApproval): {
  activated: boolean;
  refusalCategory:
    | "not_approved"
    | "revoked"
    | "suspended"
    | "expired"
    | "unsupported_provider"
    | "unsupported_retention"
    | "phi_not_approved"
    | "consumer_provider"
    | "unapproved_model"
    | "baa_missing"
    | null;
} {
  if (approval.providerName.toLowerCase() === "chatgpt") {
    return { activated: false, refusalCategory: "consumer_provider" };
  }
  if (approval.providerKind !== "openai_hipaa" && approval.providerKind !== "platform_governed") {
    return { activated: false, refusalCategory: "unsupported_provider" };
  }
  if (approval.revocationState === "revoked" || approval.orgActivationState === "revoked") {
    return { activated: false, refusalCategory: "revoked" };
  }
  if (approval.orgActivationState === "suspended") {
    return { activated: false, refusalCategory: "suspended" };
  }
  if (approval.expirationDate && new Date(approval.expirationDate).getTime() < Date.now()) {
    return { activated: false, refusalCategory: "expired" };
  }
  if (approval.orgActivationState === "disabled" || approval.orgActivationState === "readiness_review") {
    return { activated: false, refusalCategory: "not_approved" };
  }
  if (!approval.baaStatusReference) {
    return { activated: false, refusalCategory: "baa_missing" };
  }
  if (approval.retentionMode !== "zero" && approval.retentionMode !== "modified") {
    return { activated: false, refusalCategory: "unsupported_retention" };
  }
  if (approval.containsPHI && approval.orgActivationState !== "approved_for_phi") {
    return { activated: false, refusalCategory: "phi_not_approved" };
  }
  return { activated: true, refusalCategory: null };
}

/**
 * Look up whether the approval names a model on its allowlist. Never
 * falls back to a "close" model; unknown model → refuse.
 */
export function isModelApproved(approval: OpenAIProviderApproval, model: string): boolean {
  return approval.approvedModelAllowlist.includes(model);
}

/**
 * Factory. Never invokes OpenAI in this PR. The `secretResolver` is
 * called ONLY after every approval gate has passed. In Phase 10B.1 the
 * resolver is not wired to a real secret manager, so the adapter
 * intentionally refuses.
 */
export type OpenAIAdapterOptions = {
  approval: OpenAIProviderApproval;
  model: string;
  containsPHI: boolean;
  // Provided by Phase 10B.2. In 10B.1 this is always `undefined` and the
  // adapter refuses with `CopilotUnavailable`.
  secretResolver?: (secretRef: string) => Promise<string>;
  // Optional injected `fetch` for future testability. Not used in this PR
  // (no request is made).
  fetch?: typeof globalThis.fetch;
};

export function createOpenAIAdapter(options: OpenAIAdapterOptions): CopilotProvider {
  const { approval, model, containsPHI, secretResolver } = options;
  const decision = evaluateOpenAIApproval({ ...approval, containsPHI });

  return {
    name: `openai:${approval.providerKind}`,
    model,
    async draft(_input: {
      runType: CopilotRunType;
      lens: string;
      inputSnapshot: Record<string, unknown>;
      allowedCitationIds: ReadonlySet<string>;
    }): Promise<CopilotDraftOutput> {
      if (!decision.activated) {
        throw new CopilotUnavailable(
          `OpenAI provider not activated (${decision.refusalCategory}). No external request was made.`,
        );
      }
      if (!isModelApproved(approval, model)) {
        throw new CopilotUnavailable(
          "OpenAI provider not activated (unapproved_model). No external request was made.",
        );
      }
      if (!secretResolver) {
        // Phase 10B.1: no secret resolver is wired. Phase 10B.2 supplies
        // one after Modified Retention + BAA are verified. Until then,
        // we refuse.
        throw new CopilotUnavailable(
          "OpenAI provider not activated (secret_resolver_missing). No external request was made.",
        );
      }
      // Phase 10B.2 will implement:
      //   1. `const secret = await secretResolver(approval.providerSecretRef);`
      //   2. build the OpenAI Responses API request from the minimized envelope
      //   3. call OpenAI with an explicit endpoint + timeout + no retries on
      //      policy / auth / safety failures
      //   4. validate the response schema and citation ids
      //   5. return CopilotDraftOutput
      // In this PR we never reach that path.
      throw new CopilotUnavailable(
        "OpenAI provider not activated in Phase 10B.1. Phase 10B.2 supervised activation required.",
      );
    },
  };
}
