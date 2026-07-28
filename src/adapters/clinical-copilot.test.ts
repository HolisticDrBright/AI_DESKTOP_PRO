import { describe, expect, it } from "vitest";
import {
  evaluateClinicalCopilot,
  getAdaptiveQuestions,
  type CopilotPatientSession,
} from "./clinical-copilot.mock";

function session(
  patch: Partial<CopilotPatientSession> = {},
): CopilotPatientSession {
  return {
    concern: "thyroid",
    symptoms: ["Fatigue"],
    answers: {
      "urgent-red-flags": "no",
      "medications-confirmed": "yes",
      "allergies-confirmed": "yes",
      "pregnancy-status": "no",
      "thyroid-antibodies": "no",
      "thyroid-medication": "no",
    },
    reviewed: false,
    verifiedProductIds: [],
    ...patch,
  };
}

describe("governed clinical copilot", () => {
  it("adds differentiating questions when a selected symptom changes risk context", () => {
    const questions = getAdaptiveQuestions("thyroid", ["Fatigue", "Palpitations"]);
    expect(questions.some((question) => question.id === "palpitations-context")).toBe(true);
    expect(questions.filter((question) => question.id === "urgent-red-flags")).toHaveLength(1);
  });

  it("keeps exact products as label-verification-pending candidates", () => {
    const result = evaluateClinicalCopilot("p-78435", "Alexandra Morgan", session());

    expect(result.safetyBlocks).toEqual([]);
    expect(result.missingInformation).toEqual([]);
    expect(result.products.map((item) => item.productName)).toEqual([
      "ThyroPep",
      "Thyrotain",
    ]);
    expect(result.products.every((item) => item.eligibility === "eligible-after-review")).toBe(true);
    expect(result.products.every((item) => item.labelStatus === "pending-exact-label-verification")).toBe(true);
    expect(result.labs[0]?.panelId).toBe("lp-vibrant-thyroid");
  });

  it("does not select an autoimmune or non-autoimmune thyroid product when antibody status is unknown", () => {
    const result = evaluateClinicalCopilot(
      "p-78435",
      "Alexandra Morgan",
      session({
        answers: {
          ...session().answers,
          "thyroid-antibodies": "unknown",
        },
      }),
    );

    expect(result.products).toHaveLength(0);
    expect(result.missingInformation).toContain(
      "Thyroid antibody status before selecting an autoimmune or non-autoimmune product pathway",
    );
  });

  it("blocks a routine digestive protocol when alarm features are reported", () => {
    const result = evaluateClinicalCopilot(
      "p-78435",
      "Alexandra Morgan",
      session({
        concern: "digestive",
        symptoms: ["Abdominal pain"],
        answers: {
          "urgent-red-flags": "no",
          "medications-confirmed": "yes",
          "allergies-confirmed": "yes",
          "pregnancy-status": "no",
          "gi-alarm-features": "yes",
          "gi-testing": "no",
          "abdominal-pain-context": "yes",
        },
      }),
    );

    expect(result.safetyBlocks.join(" ")).toContain("GI alarm features");
    expect(result.products[0]?.eligibility).toBe("blocked");
  });

  it("invalidates product eligibility when pregnancy or another protected context is relevant", () => {
    const result = evaluateClinicalCopilot(
      "p-78435",
      "Alexandra Morgan",
      session({
        answers: {
          ...session().answers,
          "pregnancy-status": "yes",
        },
      }),
    );

    expect(result.missingInformation.join(" ")).toContain("pregnancy");
    expect(result.products.every((item) => item.eligibility === "insufficient-information")).toBe(true);
  });
});
