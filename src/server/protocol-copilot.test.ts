import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * PHASE 9B — the protocol copilot boundary.
 *
 * The claim is that this module structurally cannot do the dangerous parts: it
 * cannot write, approve, activate, order, send or charge; it cannot invent a
 * dose; it cannot manufacture an interaction finding; and it cannot be
 * influenced by commercial data, because commercial data is not an input.
 */

const BASE_INPUT = {
  templateName: "Thyroid Reset",
  templateVersion: 3,
  items: [
    {
      position: 0,
      kind: "product" as const,
      label: "Magnesium Glycinate",
      dosageText: "200 mg",
      doseSourceKind: "product_label" as const,
      doseSourceRef: "Verify Labs 2026-01",
      catalogProductVersionId: "11111111-1111-4111-8111-111111111111",
      verificationStatus: "verified",
      interventionClassCode: null,
    },
    {
      position: 1,
      kind: "product" as const,
      label: "Mixed nuts blend",
      dosageText: null,
      doseSourceKind: null,
      doseSourceRef: null,
      catalogProductVersionId: null,
      verificationStatus: "incomplete",
      interventionClassCode: "peptide",
    },
  ],
  interventionClasses: [
    {
      code: "peptide",
      name: "Peptide therapy",
      jurisdictionSensitive: true,
      monitoringRequirements: ["Repeat IGF-1 at 12 weeks"],
      stoppingRules: ["Stop on new or worsening oedema"],
      contraindications: ["Active malignancy"],
    },
  ],
  patient: {
    allergies: ["nuts"],
    medications: ["levothyroxine"],
    medicationsHaveCodedIdentifiers: false,
  },
  governedInteractionReferenceLoaded: false,
};

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.PROTOCOL_COPILOT_ENABLED;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function copilot() {
  vi.resetModules();
  return import("./protocol-copilot");
}

async function enabled() {
  vi.stubEnv("PROTOCOL_COPILOT_ENABLED", "true");
  return copilot();
}

describe("configuration", () => {
  test("is disabled by default and says why", async () => {
    const { getProtocolCopilotConfig } = await copilot();
    const config = getProtocolCopilotConfig();
    expect(config.enabled).toBe(false);
    expect(config.problems.join(" ")).toContain("PROTOCOL_COPILOT_ENABLED");
  });

  test("drafting while disabled throws rather than returning an empty draft", async () => {
    const { draftProtocolFromTemplate, ProtocolCopilotDisabledError } =
      await copilot();
    expect(() => draftProtocolFromTemplate(BASE_INPUT)).toThrow(
      ProtocolCopilotDisabledError,
    );
    // An empty draft would be indistinguishable from "nothing to suggest".
    try {
      draftProtocolFromTemplate(BASE_INPUT);
    } catch (error) {
      expect((error as { code: string }).code).toBe("not_configured");
    }
  });

  test("only an explicit true or 1 enables it", async () => {
    for (const value of ["", "no", "0", "false", "yes", "TRUE "]) {
      vi.stubEnv("PROTOCOL_COPILOT_ENABLED", value);
      const { getProtocolCopilotConfig } = await copilot();
      const expected = value.trim().toLowerCase() === "true";
      expect(getProtocolCopilotConfig().enabled).toBe(expected);
    }
  });
});

describe("it never invents a dose", () => {
  test("a dose is carried forward only with a named source", async () => {
    const { draftProtocolFromTemplate } = await enabled();
    const draft = draftProtocolFromTemplate(BASE_INPUT);
    const carried = draft.suggestions.find((s) => s.kind === "carry_forward");
    expect(carried?.proposedDose).toBe("200 mg");
    expect(carried?.doseSource).toContain("exact product label");
  });

  test("an item with no recorded dose gets NO dose, not a plausible one", async () => {
    const { draftProtocolFromTemplate } = await enabled();
    const draft = draftProtocolFromTemplate(BASE_INPUT);
    const unavailable = draft.suggestions.find(
      (s) => s.kind === "dose_unavailable",
    );
    expect(unavailable).toBeDefined();
    expect(unavailable?.proposedDose).toBeNull();
    expect(unavailable?.doseSource).toBeNull();
    expect(unavailable?.severity).toBe("attention");
  });

  test("no suggestion carries a dose without a source", async () => {
    const { draftProtocolFromTemplate } = await enabled();
    const draft = draftProtocolFromTemplate(BASE_INPUT);
    for (const s of draft.suggestions) {
      if (s.proposedDose) expect(s.doseSource).toBeTruthy();
    }
  });
});

describe("it raises conflicts instead of hiding them", () => {
  test("an item matching a recorded allergy is surfaced, not removed", async () => {
    const { draftProtocolFromTemplate } = await enabled();
    const draft = draftProtocolFromTemplate(BASE_INPUT);
    const conflict = draft.suggestions.find((s) => s.kind === "allergy_conflict");
    expect(conflict?.itemLabel).toBe("Mixed nuts blend");
    expect(conflict?.derivedFrom).toContain("nuts");
    // The item is still present in the draft — it was not silently dropped.
    expect(
      draft.suggestions.some((s) => s.itemLabel === "Mixed nuts blend"),
    ).toBe(true);
  });

  test("an empty allergy list is reported as unknown, not as safe", async () => {
    const { draftProtocolFromTemplate } = await enabled();
    const draft = draftProtocolFromTemplate({
      ...BASE_INPUT,
      patient: { ...BASE_INPUT.patient, allergies: [] },
    });
    const missing = draft.suggestions.find(
      (s) => s.kind === "missing_assessment",
    );
    expect(missing?.rationale).toContain("not the same as no allergies");
  });
});

describe("interaction review is never claimed", () => {
  test("every draft reports interaction review as not completed", async () => {
    const { draftProtocolFromTemplate } = await enabled();
    const draft = draftProtocolFromTemplate(BASE_INPUT);
    expect(draft.interactionReviewState).toBe("not_completed");
    expect(
      draft.suggestions.some((s) => s.kind === "interaction_not_completed"),
    ).toBe(true);
  });

  test("the reason names the specific missing input", async () => {
    const { draftProtocolFromTemplate } = await enabled();

    const noRef = draftProtocolFromTemplate(BASE_INPUT);
    expect(noRef.interactionReviewReason).toContain(
      "No governed interaction reference is loaded",
    );

    const noMeds = draftProtocolFromTemplate({
      ...BASE_INPUT,
      governedInteractionReferenceLoaded: true,
      patient: { ...BASE_INPUT.patient, medications: [] },
    });
    expect(noMeds.interactionReviewReason).toContain(
      "not evidence the protocol is interaction-free",
    );

    const noCodes = draftProtocolFromTemplate({
      ...BASE_INPUT,
      governedInteractionReferenceLoaded: true,
    });
    expect(noCodes.interactionReviewReason).toContain("no coded identifiers");
  });

  test("no suggestion ever asserts an interaction finding", async () => {
    const { draftProtocolFromTemplate } = await enabled();
    const draft = draftProtocolFromTemplate({
      ...BASE_INPUT,
      governedInteractionReferenceLoaded: true,
      patient: {
        allergies: ["nuts"],
        medications: ["levothyroxine"],
        medicationsHaveCodedIdentifiers: true,
      },
    });
    const kinds = draft.suggestions.map((s) => s.kind);
    expect(kinds).not.toContain("interaction_finding");
    expect(draft.interactionReviewState).toBe("not_completed");
  });
});

describe("governed class requirements are carried, not summarised away", () => {
  test("monitoring, stopping and jurisdiction all appear", async () => {
    const { draftProtocolFromTemplate } = await enabled();
    const draft = draftProtocolFromTemplate(BASE_INPUT);
    const kinds = draft.suggestions.map((s) => s.kind);
    expect(kinds).toContain("monitoring_required");
    expect(kinds).toContain("stopping_rule");
    expect(kinds).toContain("jurisdiction_review");
  });

  test("jurisdiction wording makes no legality determination", async () => {
    const { draftProtocolFromTemplate } = await enabled();
    const draft = draftProtocolFromTemplate(BASE_INPUT);
    const j = draft.suggestions.find((s) => s.kind === "jurisdiction_review");
    expect(j?.rationale).toContain("NO determination");
  });

  test("an unverified product is flagged rather than quietly accepted", async () => {
    const { draftProtocolFromTemplate } = await enabled();
    const draft = draftProtocolFromTemplate(BASE_INPUT);
    expect(
      draft.suggestions.some((s) => s.kind === "unverified_product"),
    ).toBe(true);
  });
});

describe("the draft cannot be mistaken for a finished protocol", () => {
  test("every suggestion is marked a draft", async () => {
    const { draftProtocolFromTemplate } = await enabled();
    const draft = draftProtocolFromTemplate(BASE_INPUT);
    expect(draft.suggestions.length).toBeGreaterThan(0);
    for (const s of draft.suggestions) expect(s.isDraft).toBe(true);
  });

  test("the payload carries its own disclaimer and provenance kind", async () => {
    const { draftProtocolFromTemplate } = await enabled();
    const draft = draftProtocolFromTemplate(BASE_INPUT);
    expect(draft.provenanceKind).toBe("copilot_draft");
    expect(draft.disclaimer).toContain("nothing is saved");
    expect(draft.disclaimer).toContain("no product has been ordered");
  });

  test("every suggestion attributes itself to a recorded input", async () => {
    const { draftProtocolFromTemplate } = await enabled();
    const draft = draftProtocolFromTemplate(BASE_INPUT);
    for (const s of draft.suggestions) {
      expect(s.derivedFrom.trim().length).toBeGreaterThan(0);
      expect(s.rationale.trim().length).toBeGreaterThan(0);
    }
  });

  test("it is deterministic — the same input gives the same draft", async () => {
    const { draftProtocolFromTemplate } = await enabled();
    const a = draftProtocolFromTemplate(BASE_INPUT);
    const b = draftProtocolFromTemplate(BASE_INPUT);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

/**
 * The structural claim, checked against the source rather than the behaviour.
 *
 * A behavioural test can only show that the module did not order anything on
 * the inputs it was given. Reading the source shows it has no way to.
 */
describe("structural limits", () => {
  const source = readFileSync(
    join(process.cwd(), "src/server/protocol-copilot.ts"),
    "utf8",
  );

  /**
   * Comments stripped. The first version of these tests scanned the raw file
   * and failed on the module's own sentence "there is no scoring function here
   * at all" — a doc comment describing the guarantee tripped the check for the
   * thing it was describing. A structural claim is about the code.
   */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  test("commercial data is not an input to the copilot contract", () => {
    const contract = code.slice(
      code.indexOf("export interface CopilotTemplateItem"),
      code.indexOf("export type ProtocolSuggestionKind"),
    );
    for (const term of [
      "affiliate",
      "commission",
      "price",
      "cost",
      "supplier",
      "commercial",
      "url",
      "revenue",
    ]) {
      expect(contract.toLowerCase()).not.toContain(term);
    }
  });

  test("the module has no write, order, charge or send path", () => {
    for (const forbidden of [
      "supabase",
      "createClient",
      "fetch(",
      "adapters/",
      "insert",
      "approve_",
      "activate_",
      "checkout",
      "stripe",
    ]) {
      expect(code.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  test("it is server-only and guards against being bundled for the browser", () => {
    expect(source).toContain('typeof window !== "undefined"');
  });

  test("it has no ranking or scoring function", () => {
    for (const forbidden of ["score", "rank(", "ranking", "weight ="]) {
      expect(code.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
