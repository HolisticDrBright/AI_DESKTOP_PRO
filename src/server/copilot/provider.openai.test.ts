import { describe, expect, test } from "vitest";
import { CopilotUnavailable } from "./provider";
import {
  createOpenAIAdapter,
  evaluateOpenAIApproval,
  isModelApproved,
  type OpenAIProviderApproval,
} from "./provider.openai";

function baseApproval(overrides: Partial<OpenAIProviderApproval> = {}): OpenAIProviderApproval {
  return {
    providerName: "openai",
    providerKind: "openai_hipaa",
    approvedModelAllowlist: ["gpt-5.6-sol"],
    approvalReference: "REF-1",
    baaStatusReference: "BAA-1",
    retentionMode: "modified",
    processingRegion: "us-east-1",
    keyOwnership: "platform_governed",
    organizationId: "org-1",
    providerRegistryId: "prov-1",
    providerSecretRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:openai-hipaa-live",
    organizationHeader: null,
    projectHeader: null,
    activationDate: null,
    expirationDate: null,
    revocationState: "not_revoked",
    orgActivationState: "approved_for_synthetic",
    containsPHI: false,
    ...overrides,
  };
}

describe("OpenAI provider — pre-flight approval gate", () => {
  test("consumer ChatGPT is refused unconditionally", () => {
    const d = evaluateOpenAIApproval(baseApproval({ providerName: "chatgpt" }));
    expect(d.activated).toBe(false);
    expect(d.refusalCategory).toBe("consumer_provider");
  });

  test("revoked provider refused", () => {
    const d = evaluateOpenAIApproval(baseApproval({ revocationState: "revoked" }));
    expect(d.refusalCategory).toBe("revoked");
  });

  test("suspended org activation refused", () => {
    const d = evaluateOpenAIApproval(baseApproval({ orgActivationState: "suspended" }));
    expect(d.refusalCategory).toBe("suspended");
  });

  test("expired provider refused", () => {
    const past = new Date(Date.now() - 86400 * 1000).toISOString();
    const d = evaluateOpenAIApproval(baseApproval({ expirationDate: past }));
    expect(d.refusalCategory).toBe("expired");
  });

  test("disabled / readiness_review states refuse", () => {
    for (const s of ["disabled", "readiness_review"] as const) {
      const d = evaluateOpenAIApproval(baseApproval({ orgActivationState: s }));
      expect(d.refusalCategory).toBe("not_approved");
    }
  });

  test("missing BAA reference refused", () => {
    const d = evaluateOpenAIApproval(baseApproval({ baaStatusReference: null }));
    expect(d.refusalCategory).toBe("baa_missing");
  });

  test("standard / unspecified retention refused (only zero + modified accepted)", () => {
    for (const r of ["standard", "unspecified"] as const) {
      const d = evaluateOpenAIApproval(baseApproval({ retentionMode: r }));
      expect(d.refusalCategory).toBe("unsupported_retention");
    }
  });

  test("PHI-carrying run refused unless approved_for_phi", () => {
    const d = evaluateOpenAIApproval(baseApproval({ containsPHI: true }));
    expect(d.refusalCategory).toBe("phi_not_approved");
  });

  test("PHI run allowed on approved_for_phi with BAA + modified retention", () => {
    const d = evaluateOpenAIApproval(
      baseApproval({ containsPHI: true, orgActivationState: "approved_for_phi" }),
    );
    expect(d.activated).toBe(true);
    expect(d.refusalCategory).toBeNull();
  });

  test("unsupported provider_kind refused", () => {
    const d = evaluateOpenAIApproval(baseApproval({ providerKind: "synthetic_fixture" }));
    expect(d.refusalCategory).toBe("unsupported_provider");
  });
});

describe("OpenAI provider — model allowlist", () => {
  test("unknown model refused", () => {
    const a = baseApproval();
    expect(isModelApproved(a, "gpt-4-preview-secret")).toBe(false);
  });

  test("only listed models accepted", () => {
    const a = baseApproval({ approvedModelAllowlist: ["gpt-5.6-sol"] });
    expect(isModelApproved(a, "gpt-5.6-sol")).toBe(true);
    expect(isModelApproved(a, "gpt-4o")).toBe(false);
  });
});

describe("OpenAI adapter — Phase 10B.1 makes NO external request", () => {
  test("adapter with approved gates but no secret resolver refuses (secret_resolver_missing)", async () => {
    const adapter = createOpenAIAdapter({
      approval: baseApproval(),
      model: "gpt-5.6-sol",
      containsPHI: false,
      // no secretResolver: Phase 10B.1 default
    });
    await expect(
      adapter.draft({
        runType: "practitioner_brief",
        lens: "western",
        inputSnapshot: {},
        allowedCitationIds: new Set<string>(),
      }),
    ).rejects.toBeInstanceOf(CopilotUnavailable);
  });

  test("adapter with default (refusal) transport never sends", async () => {
    // The default transport is refusalTransport. Every path must throw
    // CopilotUnavailable before any network call would happen.
    const { SecretResolver } = await import("./secrets");
    const adapter = createOpenAIAdapter({
      approval: baseApproval(),
      model: "gpt-5.6-sol",
      containsPHI: false,
      secretResolver: new SecretResolver({
        client: {
          async getSecret() {
            return { secretString: "TEST_FAKE_BEARER_abcdefghijklmnop1234", versionId: "v1" };
          },
        },
      }),
      // No transport → refusalTransport is the default.
    });
    await expect(
      adapter.draft({
        runType: "practitioner_brief",
        lens: "western",
        inputSnapshot: {},
        allowedCitationIds: new Set<string>(),
      }),
    ).rejects.toBeInstanceOf(CopilotUnavailable);
  });
});
