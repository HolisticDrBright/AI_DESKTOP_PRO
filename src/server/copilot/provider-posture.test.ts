import { describe, expect, test } from "vitest";
import {
  computeProviderPosture,
  deriveApprovalGates,
  unavailablePosture,
  type ActivationFacts,
  type PostureInput,
  type RegistryFacts,
} from "./provider-posture";

const REGISTRY: RegistryFacts = {
  providerName: "openai",
  providerKind: "openai_hipaa",
  approvedModelAllowlist: ["gpt-test-model"],
  approvalReference: "APPROVAL-2026-001",
  baaStatusReference: "BAA-2026-OPENAI-001",
  retentionMode: "zero",
  processingRegion: "us",
  hasSecretRef: true,
  revocationState: "not_revoked",
  expirationDate: null,
};

const ACTIVATION: ActivationFacts = {
  state: "approved_for_phi",
  legalRef: "LEGAL-2026-001",
  privacyRef: "PRIVACY-2026-001",
  clinicalRef: "CLINICAL-2026-001",
  infraRef: "INFRA-2026-001",
  retentionPosture: "zero",
  supervisedRunsRequired: 25,
  supervisedRunsCompleted: 0,
};

const NO_TX = {
  everTransacted: false,
  lastRunStatus: null,
  lastRunAt: null,
  lastFailureCategory: null,
} as const;

function input(over: Partial<PostureInput> = {}): PostureInput {
  return {
    mode: "live",
    runtimeAvailable: true,
    registry: REGISTRY,
    activation: ACTIVATION,
    transactions: { ...NO_TX },
    ...over,
  };
}

describe("the seven states are all reachable and distinct", () => {
  test("disabled", () => {
    const p = computeProviderPosture(input({ mode: "disabled" }));
    expect(p.state).toBe("disabled");
    expect(p.label).toBe("Disabled");
    expect(p.detail).toMatch(/^Not configured\./);
  });

  test("fixture_test_mode", () => {
    expect(computeProviderPosture(input({ mode: "fixture" })).state).toBe("fixture_test_mode");
  });

  test("live_unavailable when nothing is registered", () => {
    expect(computeProviderPosture(input({ registry: null })).state).toBe("live_unavailable");
  });

  test("configured_unapproved when a provider exists but approvals do not", () => {
    const p = computeProviderPosture(input({ activation: null }));
    expect(p.state).toBe("configured_unapproved");
    expect(p.configured).toBe(true);
    expect(p.approved).toBe(false);
    expect(p.detail).toMatch(/Nothing was sent/);
  });

  test("live_unavailable when approved but the runtime cannot build a path", () => {
    expect(computeProviderPosture(input({ runtimeAvailable: false })).state).toBe(
      "live_unavailable",
    );
  });

  test("live_failed carries a PHI-safe category and no fabricated content", () => {
    const p = computeProviderPosture(
      input({
        transactions: {
          everTransacted: true,
          lastRunStatus: "failed",
          lastRunAt: "2026-08-04T00:00:00Z",
          lastFailureCategory: "retryable_throttling",
        },
      }),
    );
    expect(p.state).toBe("live_failed");
    expect(p.detail).toContain("retryable_throttling");
    expect(p.detail).toMatch(/No content was fabricated/);
  });

  test("approved_never_transacted", () => {
    const p = computeProviderPosture(input());
    expect(p.state).toBe("approved_never_transacted");
    expect(p.detail).toMatch(/Approval is not transmission/);
  });

  test("live_transacted", () => {
    const p = computeProviderPosture(
      input({
        transactions: {
          everTransacted: true,
          lastRunStatus: "completed",
          lastRunAt: "2026-08-04T00:00:00Z",
          lastFailureCategory: null,
        },
      }),
    );
    expect(p.state).toBe("live_transacted");
  });

  test("every state label is unique", () => {
    const labels = new Set(
      (
        [
          input({ mode: "disabled" }),
          input({ mode: "fixture" }),
          input({ registry: null }),
          input({ activation: null }),
          input({ runtimeAvailable: false }),
          input({
            transactions: { everTransacted: true, lastRunStatus: "failed", lastRunAt: "x", lastFailureCategory: "c" },
          }),
          input(),
          input({
            transactions: { everTransacted: true, lastRunStatus: "completed", lastRunAt: "x", lastFailureCategory: null },
          }),
        ] as PostureInput[]
      ).map((i) => computeProviderPosture(i).label),
    );
    // 8 inputs, 7 distinct states (live_unavailable is reachable two ways).
    expect(labels.size).toBe(7);
  });
});

describe("configured and transacted are separate facts", () => {
  test("configured true, transacted false", () => {
    const p = computeProviderPosture(input());
    expect(p.configured).toBe(true);
    expect(p.transacted).toBe(false);
  });

  test("a registry row without a secret reference is not configured", () => {
    const p = computeProviderPosture(
      input({ registry: { ...REGISTRY, hasSecretRef: false } }),
    );
    expect(p.configured).toBe(false);
  });

  test("configured never implies transacted", () => {
    for (const state of ["approved_for_synthetic", "approved_for_phi"] as const) {
      const p = computeProviderPosture(input({ activation: { ...ACTIVATION, state } }));
      expect(p.configured).toBe(true);
      expect(p.transacted).toBe(false);
    }
  });
});

describe("nothing outside a governed record counts as approval", () => {
  test("all nine gates are always reported", () => {
    expect(deriveApprovalGates(input()).map((g) => g.name)).toEqual([
      "openai_baa_verified",
      "abuse_monitoring_or_zdr",
      "production_provider_approval",
      "organization_opt_in",
      "clinical_sign_off",
      "privacy_sign_off",
      "security_sign_off",
      "live_transaction_executed",
      "phi_transmission_approved",
    ]);
  });

  test("with no governed records every gate is not_run or not_approved", () => {
    const gates = deriveApprovalGates(
      input({ registry: null, activation: null }),
    );
    expect(gates.every((g) => g.status !== "approved")).toBe(true);
    expect(gates.every((g) => g.reference === null)).toBe(true);
  });

  test("a secret being present approves nothing", () => {
    const gates = deriveApprovalGates(
      input({
        registry: { ...REGISTRY, hasSecretRef: true, baaStatusReference: null, approvalReference: null },
        activation: null,
      }),
    );
    expect(gates.find((g) => g.name === "openai_baa_verified")!.status).toBe("not_run");
    expect(gates.find((g) => g.name === "production_provider_approval")!.status).toBe("not_approved");
  });

  test("placeholder references are refused, not trusted", () => {
    for (const placeholder of ["", "  ", "TBD", "pending", "n/a", "none", "TODO", "test"]) {
      const gates = deriveApprovalGates(
        input({ activation: { ...ACTIVATION, clinicalRef: placeholder } }),
      );
      expect(gates.find((g) => g.name === "clinical_sign_off")!.status).toBe("not_approved");
    }
  });

  test("a revoked provider approves nothing", () => {
    const gates = deriveApprovalGates(
      input({ registry: { ...REGISTRY, revocationState: "revoked" } }),
    );
    expect(gates.find((g) => g.name === "openai_baa_verified")!.status).toBe("not_run");
    expect(gates.find((g) => g.name === "production_provider_approval")!.status).toBe("not_approved");
  });

  test("an expired provider approves nothing", () => {
    const gates = deriveApprovalGates(
      input({ registry: { ...REGISTRY, expirationDate: "2020-01-01T00:00:00Z" } }),
    );
    expect(gates.find((g) => g.name === "openai_baa_verified")!.status).toBe("not_run");
  });

  test("a retention claim without a BAA reference does not approve ZDR", () => {
    const gates = deriveApprovalGates(
      input({ registry: { ...REGISTRY, baaStatusReference: null, retentionMode: "zero" } }),
    );
    expect(gates.find((g) => g.name === "abuse_monitoring_or_zdr")!.status).toBe("not_run");
  });

  test("standard retention never approves ZDR even with a BAA", () => {
    const gates = deriveApprovalGates(
      input({
        registry: { ...REGISTRY, retentionMode: "standard" },
        activation: { ...ACTIVATION, retentionPosture: "standard" },
      }),
    );
    expect(gates.find((g) => g.name === "abuse_monitoring_or_zdr")!.status).toBe("not_run");
  });

  test("provider approval requires BOTH the registry reference and legal sign-off", () => {
    const withoutLegal = deriveApprovalGates(
      input({ activation: { ...ACTIVATION, legalRef: null } }),
    );
    expect(withoutLegal.find((g) => g.name === "production_provider_approval")!.status).toBe(
      "not_approved",
    );
  });

  test("readiness_review is not opt-in and does not approve PHI", () => {
    const gates = deriveApprovalGates(
      input({ activation: { ...ACTIVATION, state: "readiness_review" } }),
    );
    expect(gates.find((g) => g.name === "organization_opt_in")!.status).toBe("not_approved");
    expect(gates.find((g) => g.name === "phi_transmission_approved")!.status).toBe("not_approved");
  });

  test("approved_for_synthetic opts in but never approves PHI transmission", () => {
    const gates = deriveApprovalGates(
      input({ activation: { ...ACTIVATION, state: "approved_for_synthetic" } }),
    );
    expect(gates.find((g) => g.name === "organization_opt_in")!.status).toBe("approved");
    expect(gates.find((g) => g.name === "phi_transmission_approved")!.status).toBe("not_approved");
  });

  test("live transaction is NOT RUN until something is actually sent", () => {
    const gates = deriveApprovalGates(input());
    const tx = gates.find((g) => g.name === "live_transaction_executed")!;
    expect(tx.status).toBe("not_run");
    expect(tx.reference).toBeNull();
  });

  test("a passing fixture run does not mark a live transaction", () => {
    const gates = deriveApprovalGates(input({ mode: "fixture" }));
    expect(gates.find((g) => g.name === "live_transaction_executed")!.status).toBe("not_run");
  });

  test("gate derivation reads no environment variable", () => {
    // Setting every plausible activation-looking variable must not move a
    // single gate: approval lives in governed records, not the process env.
    const before = deriveApprovalGates(input({ registry: null, activation: null }));
    const saved = { ...process.env };
    try {
      process.env.CLINICAL_COPILOT_MODE = "live";
      process.env.OPENAI_API_KEY = "TEST_FAKE_BEARER_abcdefghijklmnop1234";
      process.env.CLINICAL_COPILOT_BAA_APPROVED = "true";
      process.env.CLINICAL_COPILOT_APPROVED = "1";
      const after = deriveApprovalGates(input({ registry: null, activation: null }));
      expect(after).toEqual(before);
      expect(after.every((g) => g.status !== "approved")).toBe(true);
    } finally {
      process.env = saved;
    }
  });
});

describe("honest claims", () => {
  test("no posture detail claims the provider is connected or HIPAA-ready", () => {
    const inputs: PostureInput[] = [
      input({ mode: "disabled" }),
      input({ mode: "fixture" }),
      input({ registry: null }),
      input({ activation: null }),
      input({ runtimeAvailable: false }),
      input(),
      input({
        transactions: { everTransacted: true, lastRunStatus: "completed", lastRunAt: "x", lastFailureCategory: null },
      }),
      input({
        transactions: { everTransacted: true, lastRunStatus: "failed", lastRunAt: "x", lastFailureCategory: "c" },
      }),
    ];
    for (const i of inputs) {
      const p = computeProviderPosture(i);
      const text = `${p.label} ${p.detail}`.toLowerCase();
      expect(text).not.toContain("hipaa-ready");
      expect(text).not.toContain("hipaa compliant");
      expect(text).not.toMatch(/\bconnected\b/);
      expect(text).not.toMatch(/\bsecure and approved\b/);
    }
  });

  test("unavailablePosture never claims configuration or approval", () => {
    const p = unavailablePosture("The clinical backend could not be reached.");
    expect(p.state).toBe("live_unavailable");
    expect(p.configured).toBe(false);
    expect(p.transacted).toBe(false);
    expect(p.approved).toBe(false);
    expect(p.gates).toHaveLength(9);
    expect(p.gates.every((g) => g.status !== "approved")).toBe(true);
  });

  test("posture never exposes a secret reference value, only its presence", () => {
    const p = computeProviderPosture(input());
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("arn:aws");
    expect(serialized).not.toContain("sk-");
    expect(Object.keys(p)).not.toContain("providerSecretRef");
  });
});
