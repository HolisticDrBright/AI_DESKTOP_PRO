import { describe, expect, test } from "vitest";
import { reconcileLabelServingConflict } from "./catalog-label-reconciliation";
import { sourceRecordVersion } from "./aws-governed-catalog-seed-adapter";

function fixture() {
  const adopted = "3 capsules (1,170 mg Takesumi; 390 mg per capsule)";
  return {
    label: { id: "synthetic-label", servingSize: adopted, practitionerDecisionRequired: false,
      conflictResolution: { adopted, previousValues: { claudeResearch_2026_08_19: "1 capsule (390 mg)", phase9f_2026_08_05: "3 capsules" },
        resolvedBy: "Synthetic reviewer", resolvedOn: "2026-09-14", via: "Synthetic test decision" } },
    crosscheck: { id: "synthetic-label", verdict: "substantive_conflict", physicalLabelRequired: true,
      servingSize: "CONFLICT: mine='1 capsule (390 mg)' prior='3 capsules'" },
    decisions: [{ id: "decision-synthetic", productId: "synthetic-label", decision: "adopt_3_capsules",
      decidedBy: "Synthetic reviewer", decisionDate: "2026-09-14" }],
  };
}
describe("exact label serving-size reconciliation", () => {
  test("records the decision and original evidence without modifying history or physical-label flag", () => {
    const f = fixture(), before = structuredClone(f);
    const result = reconcileLabelServingConflict(f.label, f.crosscheck, f.decisions);
    expect(result).toMatchObject({ unresolved: false, evidence: { scope: "serving_size_only", decisionId: "decision-synthetic",
      originalVerdict: "substantive_conflict" } });
    expect(result.evidence?.decisionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f).toEqual(before);
    expect(f.crosscheck.physicalLabelRequired).toBe(true);
  });
  test.each(["missing-decision", "duplicate-decision", "wrong-author", "stale-prior", "changed-adopted", "invalid-date", "open-conflict", "different-product"])("rejects %s", kind => {
    const f = fixture();
    if (kind === "missing-decision") f.decisions = [];
    if (kind === "duplicate-decision") f.decisions.push(f.decisions[0]!);
    if (kind === "wrong-author") f.decisions[0]!.decidedBy = "Other reviewer";
    if (kind === "stale-prior") f.label.conflictResolution.previousValues.phase9f_2026_08_05 = "4 capsules";
    if (kind === "changed-adopted") { f.label.servingSize = "4 capsules"; f.label.conflictResolution.adopted = "4 capsules"; }
    if (kind === "invalid-date") { f.label.conflictResolution.resolvedOn = "2026-02-30"; f.decisions[0]!.decisionDate = "2026-02-30"; }
    if (kind === "open-conflict") Object.assign(f.label, { conflict: { status: "unresolved" } });
    if (kind === "different-product") f.decisions[0]!.productId = "other";
    expect(() => reconcileLabelServingConflict(f.label, f.crosscheck, f.decisions)).toThrow("catalog_label_reconciliation_invalid");
  });
  test("does not clear an additional ingredient discrepancy", () => {
    const f = fixture();
    expect(reconcileLabelServingConflict(f.label, { ...f.crosscheck, ingredients: "CONFLICT: ingredient" }, f.decisions).unresolved).toBe(true);
  });
  test("existing unresolved records need no invented decision", () => {
    expect(reconcileLabelServingConflict({ id: "x" }, { id: "x", verdict: "substantive_conflict" }, [])).toEqual({ unresolved: true, evidence: null });
  });
  test("new catalog editions do not overwrite immutable version-one records", () => {
    expect(sourceRecordVersion(undefined)).toBe(1);
    expect(sourceRecordVersion("1.1.0")).toBe(1);
    expect(sourceRecordVersion("1.2.0")).toBe(102000);
    expect(sourceRecordVersion("1.2.1")).toBeGreaterThan(sourceRecordVersion("1.2.0"));
    for (const value of ["1.2", "1.2.0-beta", "01.2.0", "1.02.0", "1.2.1000", "1.0.1", null]) {
      expect(() => sourceRecordVersion(value)).toThrow();
    }
  });
});
