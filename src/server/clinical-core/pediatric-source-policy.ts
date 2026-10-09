import { createHash } from "node:crypto";
import { calendarDate, type PreciseLabRangeRelease } from "./lab-range-population";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const refuse = (): never => { throw new Error("lab_range_preparation_refused"); };
const RULES = ["prule_scope", "prule_context", "prule_house", "prule_ferritin", "prule_vitd", "prule_thyroid", "prule_metabolic", "prule_verification"];

/** Review metadata can authorize preparing a candidate, never activate it.
 * Display-context/evidence approval cannot bypass policy holds or supply
 * missing numeric age/sex/assay mappings. No free-text amendment is executed. */
export function verifyPediatricSourcePolicy(input: {
  manifest: Record<string, unknown>; packageReviewText?: string; parentSourceText?: string;
  policy?: unknown; sourceFile: string; rows: Record<string, unknown>[];
}, now: number): (range: PreciseLabRangeRelease["ranges"][number]) => void {
  const files = input.manifest.files;
  if (!object(files)) return refuse();
  const load = (name: string, raw: string | undefined): unknown => {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 2_000_000) return refuse();
    const normalized = raw.replace(/\r\n/g, "\n"), metadata = files[name];
    if (!object(metadata) || metadata.sha256 !== hash(normalized) || metadata.bytes !== Buffer.byteLength(normalized)) return refuse();
    try { return JSON.parse(normalized); } catch { return refuse(); }
  };
  const review = load("package_review.json", input.packageReviewText);
  const parents = load("pediatric_optimal_ranges.json", input.parentSourceText);
  const policy = input.policy;
  const policyKeys = ["schemaVersion", "packageReviewSha256", "adultRangeFallback", "adultHouseTargets", "reviewedBy", "reviewedAt"];
  if (!object(review) || review.package !== "pediatric-optimal-ranges" || !calendarDate.safeParse(review.reviewDate).success
    || !text(review.decider) || !Array.isArray(review.rules) || review.rules.length !== RULES.length
    || !Array.isArray(review.openItems) || review.openItems.length !== 0
    || !Array.isArray(parents)
    || !object(policy) || Object.keys(policy).length !== policyKeys.length || Object.keys(policy).some(key => !policyKeys.includes(key))
    || policy.schemaVersion !== "pediatric-range-policy/1"
    || policy.packageReviewSha256 !== hash(input.packageReviewText!.replace(/\r\n/g, "\n"))
    || policy.adultRangeFallback !== "disabled" || policy.adultHouseTargets !== "disabled"
    || !text(policy.reviewedBy) || !text(policy.reviewedAt) || !Number.isFinite(Date.parse(policy.reviewedAt))
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(policy.reviewedAt)
    || new Date(policy.reviewedAt).toISOString().slice(0, 19) !== policy.reviewedAt.slice(0, 19)
    || Date.parse(policy.reviewedAt) > now || Date.parse(policy.reviewedAt) < Date.parse(String(review.reviewDate))) return refuse();
  const ids = new Set<string>();
  for (const rule of review.rules) {
    if (!object(rule) || typeof rule.id !== "string" || !RULES.includes(rule.id) || ids.has(rule.id)
      || rule.reviewStatus !== "approved" || !text(rule.rule) || !object(rule.review)
      || rule.review.decision !== "approve" || !text(rule.review.decidedBy)
      || !calendarDate.safeParse(rule.review.decidedAt).success
      || Date.parse(String(rule.review.decidedAt)) > Date.parse(policy.reviewedAt)) return refuse();
    ids.add(rule.id);
  }
  const parentIds = new Set<string>();
  for (const parent of parents) {
    if (!object(parent) || !text(parent.id) || parentIds.has(parent.id)) return refuse();
    parentIds.add(parent.id);
  }
  return mapping => {
    const row = input.rows.find(row => row.id === mapping.source.recordId);
    const field = input.sourceFile === "conventional_intervals.json" ? "conventionalIntervalIds" : "functionalStatementIds";
    const linked = parents.filter(parent => object(parent) && Array.isArray(parent[field]) && parent[field].includes(mapping.source.recordId));
    if (!row || row.reviewStatus !== "approved" || !object(row.review) || row.review.decision !== "approve"
      || !text(row.review.decidedBy) || !calendarDate.safeParse(row.review.decidedAt).success
      || !linked.length || linked.some(parent => !object(parent) || parent.reviewStatus !== "approved"
        || !object(parent.review) || parent.review.decision !== "approve" || !text(parent.review.decidedBy)
        || !calendarDate.safeParse(parent.review.decidedAt).success || !object(parent.activation)
        || parent.activation.practitionerApproval !== "approved" || parent.activation.patientFacingEligible !== true
        || Date.parse(String(parent.review.decidedAt)) > Date.parse(mapping.reviewedAt))
      || Date.parse(String(row.review.decidedAt)) > Date.parse(mapping.reviewedAt)) return refuse();
    const age = mapping.population.age;
    // Conservative upper bounds; no adult fallback can enter a pediatric release.
    const adultBoundary = age.unit === "years" ? 18 : age.unit === "months" ? 216 : 6570;
    if (age.max > adultBoundary || age.max === adultBoundary && age.maxInclusive) return refuse();
  };
}
