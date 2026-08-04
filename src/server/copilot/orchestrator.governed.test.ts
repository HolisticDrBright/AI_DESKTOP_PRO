import { afterEach, describe, expect, test } from "vitest";
import { orchestrateRun } from "./orchestrator";
import { ADVERSARIAL_SYNTHETIC_NAME } from "./provider";

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

const RETRIEVAL_IDS = {
  approvedKnowledgeReferenceIds: ["kr-1", "kr-2"],
  verifiedLabelIds: [],
  approvedProtocolTemplateIds: [],
  approvedDietTemplateIds: [],
};

function base(governed: Record<string, unknown>) {
  return {
    runType: "practitioner_brief" as const,
    lens: "western",
    ...RETRIEVAL_IDS,
    governed,
  };
}

describe("governed synthetic orchestration", () => {
  test("approved_for_synthetic produces a completed DRAFT, never an activation", async () => {
    process.env.CLINICAL_COPILOT_MODE = "live";
    const env = await orchestrateRun(
      base({
        registryKind: "synthetic_fixture",
        registryName: "synthetic_fixture",
        activationState: "approved_for_synthetic",
        containsPHI: false,
      }),
    );
    expect(env.status).toBe("completed");
    expect(env.providerName).toBe("fixture:governed-synthetic");
    expect(env.draft).not.toBeNull();
    expect(env.outputHash).toBeTruthy();
    // Every emitted citation came from the governed envelope.
    for (const c of env.draft!.citations) {
      expect(["kr-1", "kr-2"]).toContain(c.refId);
    }
    expect(env.rejectedCitations).toEqual([]);
  });

  test("the run is deterministic — same input, same output hash", async () => {
    process.env.CLINICAL_COPILOT_MODE = "live";
    const governed = {
      registryKind: "synthetic_fixture",
      registryName: "synthetic_fixture",
      activationState: "approved_for_synthetic",
      containsPHI: false,
    };
    const a = await orchestrateRun(base(governed));
    const b = await orchestrateRun(base(governed));
    expect(a.outputHash).toBe(b.outputHash);
    expect(a.inputSnapshotHash).toBe(b.inputSnapshotHash);
  });

  test("safety items are identical across every lens", async () => {
    process.env.CLINICAL_COPILOT_MODE = "live";
    const governed = {
      registryKind: "synthetic_fixture",
      registryName: "synthetic_fixture",
      activationState: "approved_for_synthetic",
      containsPHI: false,
    };
    const lenses = ["western", "functional", "naturopathy", "tcm", "biohacking", "synergistic"];
    const summaries = new Set<string>();
    for (const lens of lenses) {
      const env = await orchestrateRun({ ...base(governed), lens });
      summaries.add(
        env.safetyItems.map((i) => `${i.category}:${i.severity}:${i.pinned}`).sort().join("|"),
      );
    }
    expect(summaries.size).toBe(1);
  });
});

describe("hallucinated citations fail closed", () => {
  test("a citation outside the envelope fails the run and keeps NO draft", async () => {
    process.env.CLINICAL_COPILOT_MODE = "live";
    const env = await orchestrateRun(
      base({
        registryKind: "synthetic_fixture",
        registryName: ADVERSARIAL_SYNTHETIC_NAME,
        activationState: "approved_for_synthetic",
        containsPHI: false,
      }),
    );
    expect(env.status).toBe("failed");
    // The point of failing closed: no partially-sourced body survives.
    expect(env.draft).toBeNull();
    expect(env.outputHash).toBeNull();
    expect(env.rejectedCitations).toContain("hallucinated-reference-not-in-envelope");
    expect(env.message).toContain("citation_validation");
  });

  test("the failure message carries a category, not provider prose", async () => {
    process.env.CLINICAL_COPILOT_MODE = "live";
    const env = await orchestrateRun(
      base({
        registryKind: "synthetic_fixture",
        registryName: ADVERSARIAL_SYNTHETIC_NAME,
        activationState: "approved_for_synthetic",
        containsPHI: false,
      }),
    );
    expect(env.message).toMatch(/Category: citation_validation/);
    expect(env.message).not.toMatch(/producedBy|fixture-copilot-v1|summary/);
  });
});

describe("governed refusals produce unavailable, never fabricated content", () => {
  test("PHI present refuses even with approved_for_synthetic", async () => {
    process.env.CLINICAL_COPILOT_MODE = "live";
    const env = await orchestrateRun(
      base({
        registryKind: "synthetic_fixture",
        registryName: "synthetic_fixture",
        activationState: "approved_for_synthetic",
        containsPHI: true,
      }),
    );
    expect(env.status).toBe("unavailable");
    expect(env.draft).toBeNull();
  });

  test("no activation refuses and drafts nothing", async () => {
    process.env.CLINICAL_COPILOT_MODE = "live";
    const env = await orchestrateRun(
      base({
        registryKind: "openai_hipaa",
        registryName: "openai",
        activationState: "readiness_review",
        containsPHI: false,
      }),
    );
    expect(env.status).toBe("unavailable");
    expect(env.draft).toBeNull();
    expect(env.outputHash).toBeNull();
  });

  test("disabled mode never consults the governed records at all", async () => {
    process.env.CLINICAL_COPILOT_MODE = "disabled";
    const env = await orchestrateRun(
      base({
        registryKind: "synthetic_fixture",
        registryName: "synthetic_fixture",
        activationState: "approved_for_synthetic",
        containsPHI: false,
      }),
    );
    expect(env.status).toBe("unavailable");
    expect(env.providerName).toBe("disabled");
    expect(env.message).toMatch(/provider was NOT called/i);
  });
});
