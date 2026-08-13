import { describe, expect, test } from "vitest";
import { functionalRangeStatus, normalizeExtractedLabLines } from "./aws-lab-analysis-worker";

const documentId = "22222222-2222-4222-8222-222222222222";

describe("synthetic AWS functional lab rules", () => {
  test("normalizes supported markers with governed range provenance", () => {
    const biomarkers = normalizeExtractedLabLines({ lines: [
      { text: "Glucose 104 mg/dL Reference 70-99", confidence: 99, page: 1, documentId },
      { text: "Hemoglobin A1c 5.7 % Reference 4.0-5.6", confidence: 97, page: 1, documentId },
      { text: "TSH 3.4 uIU/mL Reference 0.4-4.5", confidence: 96, page: 1, documentId },
      { text: "Unmapped Test 12 widgets", confidence: 100, page: 1, documentId },
    ] });

    expect(biomarkers.map((row) => row.canonicalName)).toEqual(["Glucose", "Hemoglobin A1c", "TSH"]);
    expect(biomarkers.every((row) => row.sourceVersion === "synthetic-functional-ranges/1")).toBe(true);
    expect(biomarkers[0]).toMatchObject({ value: 104, unit: "mg/dl", labMin: 70, labMax: 99 });
  });

  test("classifies functional ranges deterministically", () => {
    expect(functionalRangeStatus(85, 75, 90)).toBe("optimal");
    expect(functionalRangeStatus(104, 75, 90)).toBe("suboptimal");
    expect(functionalRangeStatus(200, 75, 90)).toBe("critical");
  });
});
