import { describe, expect, test } from "vitest";
import { functionalRangeStatus, normalizeExtractedLabLines, normalizeExtractedLabTables } from "./aws-lab-analysis-worker";

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

  test("retains an 80-marker table instead of limiting output to the governed range catalog", () => {
    const tableRows = Array.from({ length: 80 }, (_, index) => ({
      page: Math.floor(index / 20) + 1,
      documentId,
      cells: [
        { text: `Synthetic Biomarker ${index + 1} (mg/dL)`, confidence: 99, column: 1 },
        { text: String(50 + index), confidence: 99, column: 2 },
        { text: "10-200", confidence: 99, column: 3 },
      ],
    }));

    const biomarkers = normalizeExtractedLabTables({ lines: [], tableRows });

    expect(biomarkers).toHaveLength(80);
    expect(biomarkers.every((row) => row.functionalMin === null && row.functionalMax === null)).toBe(true);
    expect(biomarkers.every((row) => row.labMin === 10 && row.labMax === 200)).toBe(true);
  });

  test("refuses identifier and table-header rows while accepting bounded and one-sided ranges", () => {
    const rows = [
      ["Patient ID", "12345", ""],
      ["Result", "42", "Reference range"],
      ["Synthetic Marker A (ng/mL)", "42", "< 50"],
      ["Synthetic Marker B", "7.2", "> 5"],
    ].map((values) => ({
      page: 1,
      documentId,
      cells: values.map((text, column) => ({ text, confidence: 98, column: column + 1 })),
    }));

    const biomarkers = normalizeExtractedLabTables({ lines: [], tableRows: rows });

    expect(biomarkers.map((row) => row.canonicalName)).toEqual(["Synthetic Marker A", "Synthetic Marker B"]);
    expect(biomarkers[0]).toMatchObject({ labMin: null, labMax: 50, unit: "ng/ml" });
    expect(biomarkers[1]).toMatchObject({ labMin: 5, labMax: null, unit: "not reported" });
  });

  test("ignores a standalone parenthetical result flag instead of emitting an empty canonical name", () => {
    const rows = [
      ["(H)", "12", "10-20"],
      ["Valid Marker (mg/dL)", "42", "10-50"],
    ].map((values) => ({
      page: 1,
      documentId,
      cells: values.map((text, column) => ({ text, confidence: 98, column: column + 1 })),
    }));

    const biomarkers = normalizeExtractedLabTables({ lines: [], tableRows: rows });

    expect(biomarkers).toHaveLength(1);
    expect(biomarkers[0].canonicalName).toBe("Valid Marker");
    expect(biomarkers.every((row) => row.canonicalName.length > 0)).toBe(true);
  });
});
