import { describe, expect, test } from "vitest";
import { importedLabStatus, rangeGeometry, rangeText } from "./lab-range";

describe("imported lab range presentation", () => {
  test("uses governed functional bounds when supplied", () => {
    expect(importedLabStatus({ value: 95, referenceMin: 70, referenceMax: 99, functionalMin: 75, functionalMax: 90 }))
      .toEqual({ status: "above", label: "Above functional range", basis: "functional" });
  });

  test("falls back to the reporting laboratory interval without inventing a functional range", () => {
    expect(importedLabStatus({ value: 68, referenceMin: 70, referenceMax: 99 }))
      .toEqual({ status: "below", label: "Below lab range", basis: "laboratory" });
    expect(rangeText(undefined, undefined)).toBe("Not provided");
  });

  test("renders exact source targets and bounded marker geometry", () => {
    expect(rangeText(4, 4)).toBe("Target 4");
    const geometry = rangeGeometry({ value: 4, referenceMin: 4, referenceMax: 4 });
    expect(geometry.resultPercent).toBeGreaterThan(0);
    expect(geometry.resultPercent).toBeLessThan(100);
    expect(geometry.referenceWidthPercent).toBeGreaterThan(0);
  });

  // Follow-up 2026-10-13 (safety WP2). A patient-app import's status is the app's reading of an unreviewed result. It was
  // shown as "Critical source flag" or "Within source range", as if the laboratory had printed it.
  test("a patient-app status is named as an unreviewed app flag, never as the laboratory's (fails before: 'Critical source flag')", () => {
    expect(importedLabStatus({ value: 420, sourceStatus: "critical" }, "patient_app_unreviewed"))
      .toEqual({ status: "unknown", label: "Range not provided · app flag critical (unreviewed, not a laboratory flag)", basis: "none" });
    expect(importedLabStatus({ value: 80, sourceStatus: "normal" }, "patient_app_unreviewed").label).not.toContain("source range");
    expect(importedLabStatus({ value: 420, referenceMin: 30, referenceMax: 400, sourceStatus: "critical" }, "patient_app_unreviewed"))
      .toEqual({ status: "above", label: "Above lab range · app flag critical (unreviewed)", basis: "laboratory" });
    expect(importedLabStatus({ value: 80, sourceStatus: "unknown" }, "patient_app_unreviewed")).toEqual({ status: "unknown", label: "Range unavailable", basis: "none" });
  });
  test("a laboratory's own flag keeps its meaning (coverage)", () => {
    expect(importedLabStatus({ value: 420, sourceStatus: "critical" })).toEqual({ status: "critical", label: "Critical source flag", basis: "source" });
  });
  test("the patient-app intake card reads every status as an unreviewed app flag", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(new URL("./PatientAppIntakeCard.tsx", import.meta.url), "utf8")).toContain('importedLabStatus(range, "patient_app_unreviewed")');
  });
});
