import { beforeEach, describe, expect, it } from "vitest";
import {
  getMockKnowledgeImports,
  resetMockKnowledgeImports,
  reviewMockKnowledgeImportItem,
  stageMockKnowledgeImport,
} from "./clinical-import.mock";
import type { KnowledgeImportBundle } from "./clinical-import.types";
import { getKnowledgePathways, resetKnowledgeDemo } from "./clinical-knowledge.mock";

const bundle: KnowledgeImportBundle = {
  schemaVersion: "clinical-knowledge-import-v1",
  sourceName: "Test clinical authoring pack",
  sourceRevision: "test-v1",
  items: [
    {
      entityType: "pathway",
      externalKey: "test-pathway",
      displayName: "Test pathway",
      sourceSheet: "Conditions",
      warnings: ["Practitioner review required"],
      payload: {
        code: "test-pathway",
        name: "Test pathway",
        domainCode: "testing",
        description: "Test-only governed pathway",
        sourceRefs: [{ label: "Test authoring source" }],
        content: {
          differentiatingQuestions: ["Which feature distinguishes the alternatives?"],
          labStrategy: [],
          productCandidates: [],
          nutrition: [],
          lifestyle: [],
          safetyStops: ["Stop when urgent symptoms are present"],
        },
      },
    },
    {
      entityType: "product_label",
      externalKey: "incomplete-product",
      displayName: "Incomplete product",
      sourceSheet: "Product Formulary",
      warnings: ["Affiliate link is not clinical eligibility"],
      payload: {
        productCode: "incomplete-product",
        productName: "Incomplete product",
        brand: "Test brand",
        exactLabel: {},
        affiliateUrl: "https://example.test/affiliate",
      },
    },
  ],
};

beforeEach(() => {
  resetMockKnowledgeImports();
  resetKnowledgeDemo();
});

describe("governed clinical knowledge imports", () => {
  it("stages every item for review and reports source validation gaps", () => {
    const staged = stageMockKnowledgeImport(bundle);
    expect(staged.status).toBe("in_review");
    expect(staged.items).toHaveLength(2);
    expect(staged.items[0]?.validationErrors).toEqual([]);
    expect(staged.items[1]?.validationErrors).toEqual([
      "Ingredient amounts and units are required",
      "Serving size is required",
      "Current manufacturer label URL is required",
    ]);
  });

  it("accepts a valid pathway only as a draft", () => {
    const staged = stageMockKnowledgeImport(bundle);
    const pathwayItem = staged.items[0]!;
    reviewMockKnowledgeImportItem(staged.id, pathwayItem.id, "accept");

    const imported = getKnowledgePathways().find((pathway) => pathway.code === "test-pathway");
    expect(imported?.versions).toHaveLength(1);
    expect(imported?.versions[0]?.status).toBe("draft");
    expect(getMockKnowledgeImports()[0]?.items[0]?.status).toBe("applied");
  });

  it("blocks incomplete product labels but preserves explicit rejection", () => {
    const staged = stageMockKnowledgeImport(bundle);
    const productItem = staged.items[1]!;
    expect(() => reviewMockKnowledgeImportItem(staged.id, productItem.id, "accept"))
      .toThrow("Resolve validation errors");

    reviewMockKnowledgeImportItem(staged.id, productItem.id, "reject");
    expect(getMockKnowledgeImports()[0]?.items[1]?.status).toBe("rejected");
  });
});
