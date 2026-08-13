import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * PHASE 9A — the nutrition copilot boundary.
 *
 * The claim is that this thing structurally cannot do the dangerous parts:
 * it cannot write, cannot approve, cannot set a clinical number, cannot claim
 * evidence, and cannot quietly remove a food rule that clashes with an allergy.
 */

const TEMPLATE = {
  templateName: "Low FODMAP — structured elimination and reintroduction",
  versionNumber: 3,
  requiresPractitionerReview: true,
  foodRules: [
    { disposition: "emphasize" as const, label: "Lower-fermentable fruits" },
    { disposition: "include" as const, label: "Peanut butter" },
    { disposition: "include" as const, label: "Lactose-free milk and yoghurt" },
    { disposition: "avoid" as const, label: "Onion and garlic bulbs" },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.NUTRITION_COPILOT_ENABLED;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function copilot() {
  vi.resetModules();
  return import("./nutrition-copilot");
}

describe("nutrition copilot configuration", () => {
  test("is disabled by default and says why", async () => {
    const { getCopilotConfig } = await copilot();
    const report = getCopilotConfig();
    expect(report.enabled).toBe(false);
    expect(report.problems.join(" ")).toMatch(/NUTRITION_COPILOT_ENABLED is not set/);
  });

  test("refuses to draft while disabled, rather than returning something plausible", async () => {
    const mod = await copilot();
    expect(() =>
      mod.draftPlanFromTemplate({ template: TEMPLATE, constraints: [] }),
    ).toThrow(mod.CopilotDisabledError);
  });
});

describe("nutrition copilot output", () => {
  beforeEach(() => vi.stubEnv("NUTRITION_COPILOT_ENABLED", "1"));

  test("labels every suggestion a draft and repeats the disclaimer on the payload", async () => {
    const { draftPlanFromTemplate } = await copilot();
    const draft = draftPlanFromTemplate({ template: TEMPLATE, constraints: [] });

    expect(draft.provenanceKind).toBe("copilot_draft");
    expect(draft.disclaimer).toMatch(/nothing is saved/i);
    expect(draft.disclaimer).toMatch(/none of it is advice until a practitioner/i);
    for (const suggestion of draft.suggestions) {
      expect(suggestion.isDraft).toBe(true);
      expect(suggestion.derivedFrom).toBeTruthy();
      expect(suggestion.rationale).toBeTruthy();
    }
  });

  test("RAISES an allergy conflict instead of silently dropping the rule", async () => {
    const { draftPlanFromTemplate } = await copilot();
    const draft = draftPlanFromTemplate({
      template: TEMPLATE,
      constraints: [{ kind: "allergy", label: "Peanut", severity: "severe" }],
    });

    const conflict = draft.suggestions.find((s) => s.kind === "conflict_with_constraint");
    expect(conflict).toBeDefined();
    expect(conflict?.ruleLabel).toBe("Peanut butter");
    expect(conflict?.severity).toBe("attention");
    expect(conflict?.derivedFrom).toMatch(/recorded allergy: Peanut/);

    // The rule is still present in the draft — surfaced, not disappeared.
    const labels = draft.suggestions.map((s) => s.ruleLabel);
    expect(labels).toContain("Peanut butter");
  });

  test("treats a non-safety constraint as a substitution note, not a conflict", async () => {
    const { draftPlanFromTemplate } = await copilot();
    const draft = draftPlanFromTemplate({
      template: TEMPLATE,
      constraints: [{ kind: "preference", label: "Lactose-free milk and yoghurt" }],
    });
    const kinds = draft.suggestions.map((s) => s.kind);
    expect(kinds).toContain("needs_substitution");
    expect(kinds).not.toContain("conflict_with_constraint");
  });

  test("does not flag a rule that already tells the patient to avoid the food", async () => {
    const { draftPlanFromTemplate } = await copilot();
    const draft = draftPlanFromTemplate({
      template: TEMPLATE,
      constraints: [{ kind: "intolerance", label: "Onion and garlic bulbs" }],
    });
    // The template already says avoid; there is nothing to resolve.
    expect(draft.suggestions.filter((s) => s.kind === "conflict_with_constraint")).toHaveLength(0);
  });

  test("says so when there is nothing recorded to tailor against", async () => {
    const { draftPlanFromTemplate } = await copilot();
    const draft = draftPlanFromTemplate({ template: TEMPLATE, constraints: [] });
    const missing = draft.suggestions.find((s) => s.kind === "missing_assessment");
    expect(missing?.severity).toBe("attention");
    expect(missing?.rationale).toMatch(/should not be read as though it has been/i);
  });

  test("carries the template's review requirement into the draft", async () => {
    const { draftPlanFromTemplate } = await copilot();
    const draft = draftPlanFromTemplate({ template: TEMPLATE, constraints: [] });
    expect(draft.suggestions.some((s) => s.kind === "review_required")).toBe(true);
  });

  test("emits no clinical number and no evidence claim", async () => {
    const { draftPlanFromTemplate } = await copilot();
    const draft = draftPlanFromTemplate({
      template: TEMPLATE,
      constraints: [{ kind: "allergy", label: "Peanut" }],
    });
    const serialised = JSON.stringify(draft);
    for (const forbidden of [
      "energyTarget",
      "proteinG",
      "carbohydrateG",
      "fatG",
      "kcal",
      "evidenceGrade",
      "governed_reference",
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  test("exposes no verb that could write, approve or activate", async () => {
    const mod = await copilot();
    const surface = Object.keys(mod).join(" ");
    for (const forbidden of ["save", "write", "approve", "activate", "publish", "commit"]) {
      expect(surface.toLowerCase()).not.toContain(forbidden);
    }
  });

  test("is deterministic — the same inputs give the same draft", async () => {
    const { draftPlanFromTemplate } = await copilot();
    const input = {
      template: TEMPLATE,
      constraints: [{ kind: "allergy", label: "Peanut" }],
    };
    expect(JSON.stringify(draftPlanFromTemplate(input))).toBe(
      JSON.stringify(draftPlanFromTemplate(input)),
    );
  });
});
