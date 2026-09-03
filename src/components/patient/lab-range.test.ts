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
});
