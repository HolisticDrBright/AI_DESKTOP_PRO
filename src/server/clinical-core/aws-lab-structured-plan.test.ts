import { describe, expect, test } from "vitest";
import { safeStructuredLabBiomarkers } from "./aws-lab-analysis-api";

describe("saved measured lab plan input", () => {
  test("accepts finite measured rows and preserves reporting-lab bounds", () => {
    expect(safeStructuredLabBiomarkers([
      { markerId: "marker_1", canonicalName: "Glucose", value: 104, unit: "mg/dL", labMin: 70, labMax: 99 },
    ])).toHaveLength(1);
  });

  test("refuses duplicate analyte/unit rows, reversed ranges, and hidden fields", () => {
    expect(() => safeStructuredLabBiomarkers([
      { markerId: "a", canonicalName: "Glucose", value: 100, unit: "mg/dL", labMin: 70, labMax: 99 },
      { markerId: "b", canonicalName: "glucose", value: 101, unit: "MG/DL", labMin: 70, labMax: 99 },
    ])).toThrow("structured_biomarkers_duplicate");
    expect(() => safeStructuredLabBiomarkers([
      { markerId: "a", canonicalName: "Glucose", value: 100, unit: "mg/dL", labMin: 99, labMax: 70 },
    ])).toThrow("structured_biomarkers_invalid");
    expect(() => safeStructuredLabBiomarkers([
      { markerId: "a", canonicalName: "Glucose", value: 100, unit: "mg/dL", labMin: 70, labMax: 99, hiddenDefault: true },
    ])).toThrow("structured_biomarkers_invalid");
  });
});
