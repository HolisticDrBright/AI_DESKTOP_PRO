import { describe, expect, test } from "vitest";
import { assertExactExtractedMeasurements, buildMeasuredSupplementConsiderations, functionalRangeStatus, normalizeExtractedLabLines, normalizeExtractedLabTables, normalizeStructuredLabBiomarkers, reviewedMeasurementStatus, sanitizeMeasuredLabBiomarkers } from "./aws-lab-analysis-worker";

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
    expect(biomarkers[1]).toMatchObject({ value: 5.7, unit: "%" });
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

  test("numbers within analyte names are not results and missing units are not invented", () => {
    const biomarkers = normalizeExtractedLabLines({ lines: [
      { text: "Free T3 3.2 pg/mL Reference 2.0-4.4", confidence: 99, page: 1, documentId },
      { text: "Free T4 1.2 ng/dL Reference 0.8-1.8", confidence: 99, page: 1, documentId },
      { text: "Vitamin D, 25-Hydroxy 29 ng/mL Reference 30-100", confidence: 99, page: 1, documentId },
      { text: "Glucose 5.2 mmol/L Reference 3.9-5.5", confidence: 99, page: 1, documentId },
      { text: "TSH 3.4 Reference 0.4-4.5", confidence: 99, page: 1, documentId },
    ] });
    expect(biomarkers.map(row => row.value)).toEqual([3.2, 1.2, 29, 5.2, 3.4]);
    expect(biomarkers[3]).toMatchObject({ unit: "mmol/l", functionalMin: null, functionalMax: null, sourceId: null });
    expect(biomarkers[4]).toMatchObject({ unit: "not reported", functionalMin: null, functionalMax: null });
  });

  test("ratio and derived-marker names do not inherit an unrelated analyte range", () => {
    const rows = normalizeStructuredLabBiomarkers([
      { markerId: "ratio", canonicalName: "LDL Cholesterol / HDL ratio", value: 2.1, unit: "ratio", labMin: null, labMax: 3.5 },
      { markerId: "glucose", canonicalName: "Glucose", value: 5.2, unit: "mmol/L", labMin: 3.9, labMax: 5.5 },
    ], documentId);
    expect(rows[0]).toMatchObject({ canonicalName: "LDL Cholesterol / HDL ratio", functionalMin: null });
    expect(rows[1]).toMatchObject({ value: 5.2, unit: "mmol/l", functionalMin: null });
  });

  test("does not convert censored results into exact numeric measurements", () => {
    expect(normalizeExtractedLabTables({ lines: [], tableRows: [{ documentId, page: 1, cells: [
      { text: "Glucose", column: 1, confidence: 99 }, { text: ">500", column: 2, confidence: 99 },
      { text: "mg/dL", column: 3, confidence: 99 },
    ] }] })).toEqual([]);
  });

  test("a censored measurement stops plan synthesis rather than disappearing silently", () => {
    expect(() => assertExactExtractedMeasurements({ lines: [{ text: "Glucose >500 mg/dL", confidence: 99, page: 1, documentId }] })).toThrow("qualified_measurement_requires_review");
    expect(() => assertExactExtractedMeasurements({ lines: [{ text: "Glucose 90 mg/dL Reference <100", confidence: 99, page: 1, documentId }] })).not.toThrow();
  });

  test("keeps clinically meaningful parenthetical analyte names", () => {
    const rows = normalizeExtractedLabTables({ lines: [], tableRows: [{ documentId, page: 1, cells: [
      { text: "Lipoprotein(a)", column: 1, confidence: 99 }, { text: "42", column: 2, confidence: 99 }, { text: "nmol/L", column: 3, confidence: 99 },
    ] }] });
    expect(rows[0]).toMatchObject({ canonicalName: "Lipoprotein(a)", unit: "nmol/l" });
  });

  test("reviewed status never invents a normal result or arithmetic critical threshold", () => {
    const row = { canonicalName: "Fictional", reportedName: "Fictional", value: 40, unit: "widgets", labMin: null, labMax: null,
      functionalMin: null, functionalMax: null, sourceId: null, sourceVersion: null, population: null, confidence: 1, documentId, page: 1 };
    expect(reviewedMeasurementStatus(row)).toBe("unclassified");
    expect(reviewedMeasurementStatus({ ...row, functionalMin: 10, functionalMax: 20 })).toBe("suboptimal");
    expect(reviewedMeasurementStatus({ ...row, functionalMin: 10, functionalMax: 20, criticalAbove: 30 })).toBe("critical");
    expect(reviewedMeasurementStatus({ ...row, functionalMin: 30, functionalMax: 50, labMax: 35 })).toBe("suboptimal");
  });

  test("rebuilds governed ranges from saved measured biomarkers without claiming document verification", () => {
    const biomarkers = normalizeStructuredLabBiomarkers([
      { markerId: "local-glucose", canonicalName: "Glucose", value: 104, unit: "mg/dL", labMin: 70, labMax: 99 },
      { markerId: "local-custom", canonicalName: "Custom Marker", value: 12, unit: "ng/mL", labMin: 5, labMax: 20 },
    ], documentId);

    expect(biomarkers[0]).toMatchObject({ canonicalName: "Glucose", functionalMin: 75, functionalMax: 90, confidence: 0.79 });
    expect(biomarkers[1]).toMatchObject({ canonicalName: "Custom Marker", functionalMin: null, functionalMax: null, confidence: 0.79 });
  });

  test("keeps the March synthetic findings while discarding an OCR range copied across unrelated rows", () => {
    const rows = [
      ["hs-CRP", 0.6, "mg/L"],
      ["MPO", 671, "pmol/L"],
      ["Homocysteine", 10, "umol/L"],
      ["Ferritin", 213, "ng/mL"],
      ["Iron", 128, "ug/dL"],
      ["Fasting Insulin", 10.7, "uIU/mL"],
      ["HOMA-IR", 2.3, "ratio"],
    ] as const;
    const biomarkers = normalizeStructuredLabBiomarkers(rows.map(([canonicalName, value, unit], index) => ({
      markerId: `marker-${index}`,
      canonicalName,
      value,
      unit,
      labMin: 2,
      labMax: 23,
    })), documentId, "March 2025 Blood Test");

    expect(biomarkers).toHaveLength(7);
    expect(biomarkers.every((row) => row.labMin === null && row.labMax === null)).toBe(true);
    expect(biomarkers.find((row) => row.canonicalName === "Glucose")).toBeUndefined();
    expect(biomarkers.find((row) => row.canonicalName === "Ferritin")?.value).toBe(213);
  });

  test("discards an unproven functional range copied from the same corrupt OCR column", () => {
    const rows = [
      ["Vitamin D", 35, "ng/mL"],
      ["MPO", 671, "pmol/L"],
      ["Homocysteine", 10, "umol/L"],
      ["Ferritin", 213, "ng/mL"],
      ["Iron", 128, "ug/dL"],
    ].map(([canonicalName, value, unit]) => ({
      canonicalName: String(canonicalName), reportedName: String(canonicalName), value: Number(value), unit: String(unit),
      labMin: 2, labMax: 23, functionalMin: 2, functionalMax: 23,
      sourceId: null, sourceVersion: null, population: null, confidence: 0.79,
      documentId, page: 1,
    }));

    const biomarkers = sanitizeMeasuredLabBiomarkers(rows);
    expect(biomarkers).toHaveLength(5);
    expect(biomarkers.every((row) => row.labMin === null && row.labMax === null)).toBe(true);
    expect(biomarkers.every((row) => row.functionalMin === null && row.functionalMax === null)).toBe(true);
  });

  test("rejects impossible conventional values and ambiguous TruAge pseudo-markers", () => {
    const biomarkers = normalizeStructuredLabBiomarkers([
      { markerId: "glucose", canonicalName: "Glucose", value: -6, unit: "mg/dL", labMin: null, labMax: null },
      { markerId: "hscrp", canonicalName: "hs-CRP", value: 35, unit: "not reported", labMin: null, labMax: null },
      { markerId: "insulin", canonicalName: "Fasting Insulin", value: 2, unit: "not reported", labMin: 2, labMax: 2 },
      { markerId: "age", canonicalName: "Inflammation score", value: 35, unit: "score", labMin: null, labMax: null },
    ], documentId, "Advanced TruAge Report");

    expect(biomarkers).toEqual([]);
  });

  test("preserves exact March-style source ranges and classifies the broader pattern", () => {
    const rows = [
      { canonicalName: "hs-CRP", value: 0.6, unit: "mg/L", labMin: null, labMax: 0.9 },
      { canonicalName: "MPO", value: 671, unit: "pmol/L", labMin: null, labMax: 599.9 },
      { canonicalName: "Homocysteine", value: 10, unit: "umol/L", labMin: null, labMax: 9 },
      { canonicalName: "Ferritin", value: 213, unit: "ng/mL", labMin: 30, labMax: 400 },
      { canonicalName: "Iron", value: 128, unit: "ug/dL", labMin: 59, labMax: 158 },
      { canonicalName: "Fasting Insulin", value: 10.7, unit: "uIU/mL", labMin: 2.6, labMax: 24.9 },
      { canonicalName: "HOMA-IR", value: 2.3, unit: "ratio", labMin: 0.7, labMax: 2 },
    ].map((row, index) => ({
      ...row,
      reportedName: row.canonicalName,
      functionalMin: null,
      functionalMax: null,
      sourceId: null,
      sourceVersion: null,
      population: null,
      confidence: 0.99,
      documentId,
      page: 1,
    }));
    const biomarkers = sanitizeMeasuredLabBiomarkers(rows);

    expect(biomarkers).toHaveLength(7);
    expect(biomarkers.find((row) => row.canonicalName === "MPO")).toMatchObject({ labMax: 599.9 });
    expect(biomarkers.find((row) => row.canonicalName === "Homocysteine")).toMatchObject({ labMax: 9 });
    expect(biomarkers.find((row) => row.canonicalName === "HOMA-IR")).toMatchObject({ labMin: 0.7, labMax: 2 });
    expect(biomarkers.find((row) => row.canonicalName === "Ferritin")).toMatchObject({ labMin: 30, labMax: 400 });
  });

  test("creates cited review-before-starting considerations only for measured values below a reporting-lab bound", () => {
    const output = buildMeasuredSupplementConsiderations([
      { canonicalName: "Vitamin D", value: 18, unit: "ng/mL", labMin: 30 },
      { canonicalName: "Vitamin B12", value: 450, unit: "pg/mL", labMin: 200 },
      { canonicalName: "Magnesium", value: 1.5, unit: "mg/dL", labMin: null },
    ]);

    expect(output.recommendations).toHaveLength(1);
    expect(output.recommendations[0]).toMatchObject({
      name: "Vitamin D support consideration",
      dose: null,
      interactionReview: "required_before_starting",
      recommendationStatus: "suggested",
    });
    expect(output.recommendations[0]?.reason).toContain("18 ng/mL");
    expect(output.citations[0]?.url).toBe("https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/");
    expect(output.citations[0]?.claimIds).toEqual(output.recommendations[0]?.citationIds);
  });

  test("uses functional ranges and a measured high triglyceride signal without recommending iron for a high result", () => {
    const output = buildMeasuredSupplementConsiderations([
      { canonicalName: "Vitamin D", value: 42, unit: "ng/mL", labMin: 30, labMax: 100, functionalMin: 50, functionalMax: 80 },
      { canonicalName: "Triglycerides", value: 180, unit: "mg/dL", labMin: 0, labMax: 150, functionalMin: 40, functionalMax: 100 },
      { canonicalName: "Ferritin", value: 280, unit: "ng/mL", labMin: 20, labMax: 250, functionalMin: 40, functionalMax: 150 },
    ]);

    expect(output.recommendations.map((row) => row.name)).toEqual([
      "Vitamin D support consideration",
      "Omega-3 support consideration",
    ]);
    expect(output.recommendations[0]?.reason).toContain("below the available governed functional range");
    expect(output.recommendations.some((row) => row.name.includes("Iron"))).toBe(false);
  });

  test("never converts high or within-range nutrient measurements into deficiency support", () => {
    const output = buildMeasuredSupplementConsiderations([
      { canonicalName: "Vitamin D", value: 120, unit: "ng/mL", labMin: 30, labMax: 100, functionalMin: 40, functionalMax: 80 },
      { canonicalName: "Vitamin B12", value: 1400, unit: "pg/mL", labMin: 200, labMax: 900, functionalMin: 350, functionalMax: 800 },
      { canonicalName: "Folate", value: 30, unit: "ng/mL", labMin: 3, labMax: 17, functionalMin: 5, functionalMax: 15 },
      { canonicalName: "Iron", value: 200, unit: "mcg/dL", labMin: 50, labMax: 170, functionalMin: 60, functionalMax: 150 },
      { canonicalName: "Ferritin", value: 100, unit: "ng/mL", labMin: 20, labMax: 250, functionalMin: 40, functionalMax: 150 },
      { canonicalName: "Omega 3 Index", value: 10, unit: "%", labMin: 4, labMax: 12, functionalMin: 8, functionalMax: 12 },
    ]);
    expect(output.recommendations).toEqual([]);
    expect(output.citations).toEqual([]);
  });
});
