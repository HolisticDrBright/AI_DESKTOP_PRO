import { createHash } from "node:crypto";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// These are the exact source decision identifiers/values, NOT new dosing rules.
// This helper can close only the recorded serving-size discrepancy.
const adoptedValues: Record<string, string> = {
  adopt_2_ml_per_50_lb: "2 mL per 50 lb body weight",
  adopt_3_capsules: "3 capsules (1,170 mg Takesumi; 390 mg per capsule)",
};
export type LabelReconciliation = { unresolved: boolean; evidence: Record<string, unknown> | null };

export function reconcileLabelServingConflict(label: unknown, crosscheck: unknown, decisions: unknown[]): LabelReconciliation {
  if (!object(label) || !object(crosscheck)) throw new Error("catalog_label_reconciliation_invalid");
  const unresolved = crosscheck.verdict === "substantive_conflict";
  if (!label.conflictResolution) return { unresolved, evidence: null };
  const r = label.conflictResolution;
  const matched = decisions.filter(row => object(row) && row.productId === label.id);
  if (!unresolved || label.conflict || label.practitionerDecisionRequired !== false || label.id !== crosscheck.id
    || !object(r) || !object(r.previousValues) || matched.length !== 1 || !object(matched[0])) {
    throw new Error("catalog_label_reconciliation_invalid");
  }
  const decision = matched[0];
  const previous = r.previousValues;
  const mine = previous.claudeResearch_2026_08_19, prior = previous.phase9f_2026_08_05;
  const when = typeof r.resolvedOn === "string" ? Date.parse(r.resolvedOn) : NaN;
  if (!text(decision.id) || !text(decision.decision) || !Object.hasOwn(adoptedValues, decision.decision)
    || adoptedValues[decision.decision] !== r.adopted || r.adopted !== label.servingSize
    || !text(r.resolvedBy) || decision.decidedBy !== r.resolvedBy || decision.decisionDate !== r.resolvedOn
    || !text(r.via) || !Number.isFinite(when) || new Date(when).toISOString().slice(0, 10) !== r.resolvedOn
    || !text(mine) || !text(prior) || Object.keys(previous).length !== 2
    || crosscheck.servingSize !== `CONFLICT: mine='${mine}' prior='${prior}'`) {
    throw new Error("catalog_label_reconciliation_invalid");
  }
  // A serving-size decision never clears additional ingredient/identity conflicts.
  if (Object.entries(crosscheck).some(([key, value]) => key !== "servingSize" && key !== "conflictNote"
      && typeof value === "string" && /CONFLICT:/i.test(value))) return { unresolved: true, evidence: null };
  return { unresolved: false, evidence: { scope: "serving_size_only", decisionId: decision.id,
    decisionSha256: digest(decision), labelSha256: digest(label), originalCrosscheckSha256: digest(crosscheck),
    resolvedBy: r.resolvedBy, resolvedOn: r.resolvedOn, adopted: r.adopted, previousValues: previous,
    originalVerdict: crosscheck.verdict } };
}
