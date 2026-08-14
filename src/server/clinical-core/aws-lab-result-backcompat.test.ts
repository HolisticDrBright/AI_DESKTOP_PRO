import { describe, expect, test } from "vitest";
import { sanitizeStoredResult } from "./aws-lab-analysis-api";

describe("AWS lab result backward compatibility", () => {
  test("removes a legacy empty-name OCR row without changing valid biomarkers", () => {
    const valid = { canonicalName: "Glucose", reportedName: "Glucose" };
    const malformed = { canonicalName: "", reportedName: "(mOsm/kg)" };
    const result = { analysisId: "analysis", biomarkers: [valid, malformed] };

    expect(sanitizeStoredResult(result)).toEqual({ analysisId: "analysis", biomarkers: [valid] });
  });

  test("returns already-valid and non-result payloads unchanged", () => {
    const result = { biomarkers: [{ canonicalName: "TSH" }] };
    expect(sanitizeStoredResult(result)).toBe(result);
    expect(sanitizeStoredResult(null)).toBeNull();
  });
});
