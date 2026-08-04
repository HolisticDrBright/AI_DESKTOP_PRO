import { afterEach, describe, expect, test } from "vitest";
import { CopilotUnavailable, selectGovernedProvider } from "./provider";

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

const draftInput = {
  runType: "practitioner_brief" as const,
  lens: "western",
  inputSnapshot: {},
  allowedCitationIds: new Set<string>(),
};

const APPROVED_SYNTHETIC = {
  registryKind: "synthetic_fixture",
  activationState: "approved_for_synthetic",
  containsPHI: false,
  mode: "live" as const,
};

describe("selectGovernedProvider — the synthetic path is governed, not env-driven", () => {
  test("all four conditions together select the governed synthetic provider", async () => {
    const p = await selectGovernedProvider(APPROVED_SYNTHETIC);
    expect(p.name).toBe("fixture:governed-synthetic");
  });

  test("the governed synthetic provider works in a DEPLOYED runtime", async () => {
    // This is the deliberate difference from the env-flag path: a governed
    // record survives deployment, an env flag must not.
    process.env.VERCEL_ENV = "production";
    const p = await selectGovernedProvider(APPROVED_SYNTHETIC);
    expect(p.name).toBe("fixture:governed-synthetic");
    await expect(p.draft(draftInput)).resolves.toBeTruthy();
  });

  test("CLINICAL_COPILOT_MODE=fixture is still refused in a deployed runtime", async () => {
    // The env-flag route is unchanged and still fails closed.
    process.env.VERCEL_ENV = "production";
    await expect(
      selectGovernedProvider({
        registryKind: "synthetic_fixture",
        activationState: "approved_for_synthetic",
        containsPHI: false,
        mode: "fixture",
      }),
    ).rejects.toThrow(/refused in a deployed environment/);
  });
});

describe("selectGovernedProvider — every missing condition refuses", () => {
  test("disabled mode never reaches the synthetic path", async () => {
    const p = await selectGovernedProvider({ ...APPROVED_SYNTHETIC, mode: "disabled" });
    expect(p.name).toBe("disabled");
    await expect(p.draft(draftInput)).rejects.toBeInstanceOf(CopilotUnavailable);
  });

  test("a non-synthetic registry kind refuses", async () => {
    for (const kind of ["openai_hipaa", "anthropic_hipaa", "platform_governed", null]) {
      const p = await selectGovernedProvider({ ...APPROVED_SYNTHETIC, registryKind: kind });
      expect(p.name).toBe("live");
      await expect(p.draft(draftInput)).rejects.toBeInstanceOf(CopilotUnavailable);
    }
  });

  test("an activation state other than approved_for_synthetic refuses", async () => {
    for (const state of [
      "disabled",
      "readiness_review",
      "approved_for_phi",
      "suspended",
      "revoked",
      null,
    ]) {
      const p = await selectGovernedProvider({ ...APPROVED_SYNTHETIC, activationState: state });
      expect(p.name).toBe("live");
    }
  });

  test("approved_for_phi does NOT select the fixture", async () => {
    // The two states mean different things. PHI approval is about sending
    // real data to a real provider; it must never resolve to synthetic
    // content standing in for a live answer.
    const p = await selectGovernedProvider({
      ...APPROVED_SYNTHETIC,
      activationState: "approved_for_phi",
    });
    expect(p.name).toBe("live");
    await expect(p.draft(draftInput)).rejects.toThrow(/not activated/i);
  });

  test("PHI present refuses the synthetic path outright", async () => {
    const p = await selectGovernedProvider({ ...APPROVED_SYNTHETIC, containsPHI: true });
    expect(p.name).toBe("live");
    await expect(p.draft(draftInput)).rejects.toBeInstanceOf(CopilotUnavailable);
  });
});

describe("no fallback from a failed live call to fabricated output", () => {
  test("the live provider refuses rather than degrading to the fixture", async () => {
    const p = await selectGovernedProvider({
      registryKind: "openai_hipaa",
      activationState: "approved_for_phi",
      containsPHI: true,
      mode: "live",
    });
    expect(p.name).toBe("live");
    const err = await p.draft(draftInput).catch((e) => e);
    expect(err).toBeInstanceOf(CopilotUnavailable);
    // Nothing resembling drafted content came back.
    expect(err).not.toHaveProperty("content");
  });
});
