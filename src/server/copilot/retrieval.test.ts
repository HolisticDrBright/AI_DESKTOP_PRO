import { describe, expect, test } from "vitest";
import { assembleRetrieval, validateCitations } from "./retrieval";

describe("governed retrieval envelope", () => {
  test("empty inputs → empty allowedCitationIds + empty sources", () => {
    const r = assembleRetrieval({
      approvedKnowledgeReferenceIds: [],
      verifiedLabelIds: [],
      approvedProtocolTemplateIds: [],
      approvedDietTemplateIds: [],
    });
    expect(r.allowedCitationIds.size).toBe(0);
    expect(r.sources.length).toBe(0);
  });

  test("sources include only the four governed types", () => {
    const r = assembleRetrieval({
      approvedKnowledgeReferenceIds: ["kr-1"],
      verifiedLabelIds: ["lbl-2"],
      approvedProtocolTemplateIds: ["pt-3"],
      approvedDietTemplateIds: ["dt-4"],
    });
    expect(r.sources.map((s) => s.type)).toEqual(
      ["knowledge_reference", "product_label", "protocol_template", "diet_template"],
    );
    expect([...r.allowedCitationIds]).toEqual(["kr-1", "lbl-2", "pt-3", "dt-4"]);
  });
});

describe("citation validation — hallucinated citations rejected", () => {
  test("every emitted citation must be in the allowed set", () => {
    const allowed = new Set<string>(["kr-1", "lbl-2"]);
    const { accepted, rejected } = validateCitations(
      [{ refId: "kr-1" }, { refId: "lbl-2" }, { refId: "hallucinated-99" }],
      allowed,
    );
    expect(accepted.map((a) => a.refId)).toEqual(["kr-1", "lbl-2"]);
    expect(rejected).toEqual(["hallucinated-99"]);
  });

  test("empty allowed set rejects everything (governed empty state)", () => {
    const { accepted, rejected } = validateCitations(
      [{ refId: "x" }, { refId: "y" }],
      new Set<string>(),
    );
    expect(accepted).toEqual([]);
    expect(rejected).toEqual(["x", "y"]);
  });
});
