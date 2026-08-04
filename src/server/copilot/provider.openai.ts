/**
 * Phase 10B.1 — OpenAI provider adapter.
 *
 * SERVER-ONLY. Composes: approval gate → secret resolver → request
 * builder → transport (with retry + timeout) → response validator.
 *
 * Nothing calls `fetch` directly. In this PR the transport is
 * `refusalTransport` by default, and the secret resolver is undefined by
 * default — either condition alone forces `CopilotUnavailable` before
 * any network attempt.
 *
 * Consumer ChatGPT (`chatgpt` provider_name) is REJECTED unconditionally.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/provider.openai is server-only.");
}

import {
  CopilotUnavailable,
  type CopilotDraftOutput,
  type CopilotProvider,
  type CopilotRunType,
} from "./provider";
import type { MinimizedEnvelope } from "./data-minimizer";
import { buildOpenAIRequest, parseAndValidateOpenAIResponse } from "./provider.openai.request";
import { refusalTransport, type Transport } from "./http-transport";
import {
  classifyProviderError,
  DEFAULT_RETRY_POLICY,
  withRetry,
  type FailureCategory,
  type RetryPolicy,
} from "./retry";
import type { SecretResolver, SecretResolverContext } from "./secrets";

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
  organizationId: string;
  providerRegistryId: string;
  providerSecretRef: string | null;
  organizationHeader: string | null;
  projectHeader: string | null;
};

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

export function isModelApproved(approval: OpenAIProviderApproval, model: string): boolean {
  return approval.approvedModelAllowlist.includes(model);
}

export type OpenAIAdapterOptions = {
  approval: OpenAIProviderApproval;
  model: string;
  containsPHI: boolean;
  envelope?: MinimizedEnvelope;
  transport?: Transport;
  secretResolver?: SecretResolver;
  retryPolicy?: RetryPolicy;
};

/**
 * Compose the full adapter. Every branch below evaluates the approval
 * gate BEFORE any I/O, and the transport is refusal-only by default.
 */
export function createOpenAIAdapter(options: OpenAIAdapterOptions): CopilotProvider {
  const { approval, model, containsPHI, envelope, secretResolver, retryPolicy } = options;
  const transport = options.transport ?? refusalTransport;
  const decision = evaluateOpenAIApproval({ ...approval, containsPHI });

  return {
    name: `openai:${approval.providerKind}`,
    model,
    async draft(input: {
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
        throw new CopilotUnavailable(
          "OpenAI provider not activated (secret_resolver_missing). No external request was made.",
        );
      }
      if (!envelope) {
        throw new CopilotUnavailable(
          "OpenAI provider not activated (envelope_missing). No external request was made.",
        );
      }
      if (!approval.providerSecretRef) {
        throw new CopilotUnavailable(
          "OpenAI provider not activated (provider_secret_ref_missing). No external request was made.",
        );
      }
      if (transport === refusalTransport) {
        // Phase 10B.1: default transport refuses. Phase 10B.2 replaces
        // this with the AWS-Secrets-Manager + fetch transport once the
        // BAA + Modified Retention posture are recorded on the row.
        throw new CopilotUnavailable(
          "OpenAI provider not activated (transport_refused). No external request was made.",
        );
      }
      const resolverCtx: SecretResolverContext = {
        organizationId: approval.organizationId,
        providerRegistryId: approval.providerRegistryId,
        providerSecretRef: approval.providerSecretRef,
      };
      const resolved = await secretResolver.resolve(resolverCtx);
      const request = buildOpenAIRequest({
        envelope,
        model,
        apiKey: resolved.bearer,
        organizationHeader: approval.organizationHeader,
        projectHeader: approval.projectHeader,
      });
      const policy = retryPolicy ?? DEFAULT_RETRY_POLICY;
      const raw = await withRetry(
        async () => {
          const res = await transport.send({
            endpoint: request.endpoint,
            method: request.method,
            headers: request.headers,
            body: request.body,
          });
          if (res.status < 200 || res.status >= 300) {
            const err = new Error("http_status_" + res.status) as Error & {
              httpStatus: number;
              providerCode?: string;
            };
            err.httpStatus = res.status;
            try {
              const parsed = JSON.parse(res.bodyText);
              const code = parsed?.error?.code ?? parsed?.error?.type;
              if (typeof code === "string") err.providerCode = code;
            } catch {
              /* body may not be JSON */
            }
            throw err;
          }
          return res.bodyText;
        },
        (err) => {
          const errAny = err as { httpStatus?: number; providerCode?: string; message?: string; category?: FailureCategory };
          if (errAny.category) return errAny.category;
          return classifyProviderError({
            httpStatus: errAny.httpStatus,
            providerCode: errAny.providerCode,
            parseError: errAny.message,
          });
        },
        { policy },
      );
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        throw new CopilotUnavailable("openai_malformed_output");
      }
      const parsed = parseAndValidateOpenAIResponse({
        raw: parsedJson,
        allowedCitationIds: input.allowedCitationIds,
        expectedModelPrefix: model.split("-")[0],
      });
      return {
        runType: parsed.runType as CopilotRunType,
        content: parsed.content as unknown as Record<string, unknown>,
        citations: parsed.citations,
        contentSha256: parsed.contentSha256,
        providerName: `openai:${approval.providerKind}`,
        providerModel: parsed.providerModel,
      };
    },
  };
}
