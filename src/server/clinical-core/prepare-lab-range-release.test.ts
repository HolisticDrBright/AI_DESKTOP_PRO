import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { preparePreciseLabRangeRelease } from "./prepare-lab-range-release";
import type { PreciseLabRangeRelease } from "./lab-range-population";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const now = Date.parse("2026-09-14T12:00:00Z");
function fixture(mutateSource?: (r: Record<string, unknown>) => void) {
  const sourceRow: Record<string, unknown> = { id: "synthetic-source", marker: "Fictional", units: "widgets/L",
    reviewStatus: "approved", verification: "V", contentType: "pediatric_functional_range",
    sourceUrl: "https://example.invalid/source", contested: false,
    review: { decision: "approve", decidedBy: "Synthetic reviewer", decidedAt: "2026-09-01" } };
  mutateSource?.(sourceRow);
  const sourceText = JSON.stringify([sourceRow]);
  const parentSourceText = JSON.stringify([{ id: "synthetic-parent", reviewStatus: "approved",
    functionalStatementIds: ["synthetic-source"], conventionalIntervalIds: ["synthetic-source"],
    review: { decision: "approve", decidedBy: "Synthetic reviewer", decidedAt: "2026-09-01" },
    activation: { practitionerApproval: "approved", patientFacingEligible: true } }]);
  const packageReviewText = JSON.stringify({ package: "pediatric-optimal-ranges", reviewDate: "2026-09-01", decider: "Synthetic reviewer",
    openItems: [], rules: ["prule_scope", "prule_context", "prule_house", "prule_ferritin", "prule_vitd", "prule_thyroid", "prule_metabolic", "prule_verification"]
      .map(id => ({ id, rule: "Fictional reviewed rule", reviewStatus: "approved",
        review: { decision: "approve", decidedBy: "Synthetic reviewer", decidedAt: "2026-09-01" } })) });
  const pediatricPolicy = { schemaVersion: "pediatric-range-policy/1", packageReviewSha256: hash(packageReviewText),
    adultRangeFallback: "disabled", adultHouseTargets: "disabled", reviewedBy: "Synthetic policy reviewer", reviewedAt: "2026-09-02T00:00:00Z" };
  const manifestText = JSON.stringify({ package: "pediatric-optimal-ranges", version: "1.1.0", files: {
    "functional_statements.json": { sha256: hash(sourceText), bytes: Buffer.byteLength(sourceText) },
    "package_review.json": { sha256: hash(packageReviewText), bytes: Buffer.byteLength(packageReviewText) },
    "pediatric_optimal_ranges.json": { sha256: hash(parentSourceText), bytes: Buffer.byteLength(parentSourceText) },
  } });
  const candidate: PreciseLabRangeRelease = { schemaVersion: "lab-ranges/2", version: "synthetic/2",
    expiresAt: "2027-01-01T00:00:00Z", ranges: [{
      id: "11111111-1111-4111-8111-111111111111", canonicalName: "Fictional", aliases: [], unit: "widgets/L",
      rangeKind: "functional_target", min: 10, max: 20, population: { label: "Fictional interval",
        age: { unit: "years", min: 1, max: 2, minInclusive: true, maxInclusive: false }, sexes: ["male"],
        pregnancyStatuses: ["not_applicable"], cyclePhases: null, reproductiveStages: null, contraceptions: null,
        pregnancyTrimesters: null, assayIds: ["synthetic-assay"] },
      source: { id: "22222222-2222-4222-8222-222222222222", version: "synthetic/1", url: "https://example.invalid/source",
        packageSha256: hash(manifestText), recordId: "synthetic-source", recordSha256: hash(JSON.stringify(sourceRow)),
        verification: "V", verifiedBy: "Synthetic verifier", verifiedOn: "2026-09-01", verifiedAgainst: "Synthetic interval" },
      reviewedBy: "Synthetic mapping reviewer", reviewedAt: "2026-09-01T00:00:00Z",
    }] };
  return { manifestText, expectedManifestSha256: hash(manifestText), sourceFile: "functional_statements.json", sourceText, candidate,
    parentSourceText, packageReviewText, pediatricPolicy };
}
test("prepares an unsigned exact-source candidate without modifying approvals or source", () => {
  const input = fixture(), before = structuredClone(input);
  const result = preparePreciseLabRangeRelease(input, now);
  expect(result.status).toBe("unsigned_not_deployed");
  expect(result.release.schemaVersion).toBe("lab-ranges/2");
  expect(input).toEqual(before);
});

test("does not normalize an impossible policy date into a valid later month", () => {
  const input = fixture();
  const later = Date.parse("2026-11-01T00:00:00Z");
  input.pediatricPolicy.reviewedAt = "2026-10-01T00:00:00Z";
  expect(() => preparePreciseLabRangeRelease(input, later)).not.toThrow();
  input.pediatricPolicy.reviewedAt = "2026-09-31T00:00:00Z";
  expect(() => preparePreciseLabRangeRelease(input, later)).toThrow();
});
test.each(["needs_review", "on_hold", "rejected"])("freshly hashed %s source cannot be promoted", status => {
  expect(() => preparePreciseLabRangeRelease(fixture(row => { row.reviewStatus = status; }), now)).toThrow();
});

test("evidence-only approval is never an executable functional target", () => {
  expect(() => preparePreciseLabRangeRelease(fixture(row => { row.reviewStatus = "approved_as_evidence"; }), now)).toThrow();
});

function refreshEvidence(f: ReturnType<typeof fixture>) {
  const manifest = JSON.parse(f.manifestText);
  for (const [file, text] of [["package_review.json", f.packageReviewText], ["pediatric_optimal_ranges.json", f.parentSourceText]]) {
    manifest.files[file!] = { sha256: hash(text!), bytes: Buffer.byteLength(text!) };
  }
  f.pediatricPolicy.packageReviewSha256 = hash(f.packageReviewText);
  f.manifestText = JSON.stringify(manifest);
  f.expectedManifestSha256 = hash(f.manifestText);
  f.candidate.ranges[0]!.source.packageSha256 = f.expectedManifestSha256;
}
test.each(["on_hold", "rejected"])("even freshly hashed %s policy rules block preparation", status => {
  const f = fixture(), review = JSON.parse(f.packageReviewText);
  review.rules[0].reviewStatus = status; review.openItems = [review.rules[0].id];
  review.rules[0].review.decision = status === "on_hold" ? "hold" : "reject";
  f.packageReviewText = JSON.stringify(review); refreshEvidence(f);
  expect(() => preparePreciseLabRangeRelease(f, now)).toThrow();
});
test.each(["missing-review", "hidden-hold", "duplicate-rule", "missing-parent", "parent-on-hold", "parent-activation", "changed-review-hash", "no-typed-policy", "adult-fallback", "adult-house-target", "adult-population", "missing-reporter", "evidence-only", "future-rule"])("refuses pediatric %s", kind => {
  const f = fixture();
  if (kind === "missing-review") f.packageReviewText = "";
  if (kind === "hidden-hold") { const r = JSON.parse(f.packageReviewText); r.rules[0].reviewStatus = "on_hold"; f.packageReviewText = JSON.stringify(r); }
  if (kind === "duplicate-rule") { const r = JSON.parse(f.packageReviewText); r.rules[0] = r.rules[1]; f.packageReviewText = JSON.stringify(r); }
  if (kind === "missing-parent") f.parentSourceText = "[]";
  if (kind === "parent-on-hold") { const r = JSON.parse(f.parentSourceText); r[0].reviewStatus = "on_hold"; f.parentSourceText = JSON.stringify(r); }
  if (kind === "parent-activation") { const r = JSON.parse(f.parentSourceText); delete r[0].activation; f.parentSourceText = JSON.stringify(r); }
  if (kind === "adult-fallback") f.pediatricPolicy.adultRangeFallback = "enabled";
  if (kind === "adult-house-target") f.pediatricPolicy.adultHouseTargets = "enabled";
  if (kind === "adult-population") f.candidate.ranges[0]!.population.age.max = 19;
  if (kind === "missing-reporter") f.pediatricPolicy.reviewedBy = "";
  if (kind === "future-rule") { const r = JSON.parse(f.packageReviewText); r.rules[0].review.decidedAt = "2027-01-01"; f.packageReviewText = JSON.stringify(r); }
  if (kind === "evidence-only") {
    const r = JSON.parse(f.sourceText); r[0].reviewStatus = "approved_as_evidence"; f.sourceText = JSON.stringify(r);
  }
  refreshEvidence(f);
  if (kind === "changed-review-hash") f.pediatricPolicy.packageReviewSha256 = "a".repeat(64);
  const input = kind === "no-typed-policy" ? { ...f, pediatricPolicy: undefined } : f;
  expect(() => preparePreciseLabRangeRelease(input, now)).toThrow();
});
test.each(["R", "S"])("approval cannot substitute for %s source verification", status => {
  expect(() => preparePreciseLabRangeRelease(fixture(row => { row.verification = status; }), now)).toThrow();
});
test("contested statements and conventional references cannot become functional targets", () => {
  expect(() => preparePreciseLabRangeRelease(fixture(row => { row.contested = true; }), now)).toThrow();
  expect(() => preparePreciseLabRangeRelease(fixture(row => { row.contentType = "pediatric_reference_interval"; }), now)).toThrow();
});
test("valid conventional hormone preparation requires its separate activation block", () => {
  function hormone(activated: boolean) {
    const f = fixture(), row = JSON.parse(f.sourceText)[0];
    row.contentType = "population_reference_range";
    row.markerId = "synthetic-parent";
    row.review = { decision: "approve", decidedBy: "Synthetic reviewer", decidedAt: "2026-09-01" };
    if (activated) row.activation = { practitionerApproval: "approved", patientFacingEligible: true, sourceVerification: "V",
      verifiedBy: "Synthetic verifier", verifiedOn: "2026-09-01", verifiedAgainst: "Synthetic interval" };
    f.sourceFile = "hormone_population_ranges.json";
    f.sourceText = JSON.stringify({ records: [row] });
    const parentSourceText = JSON.stringify([{ id: "synthetic-parent" }]);
    f.manifestText = JSON.stringify({ package: "lab-optimal-ranges", files: {
      [f.sourceFile]: { sha256: hash(f.sourceText), bytes: Buffer.byteLength(f.sourceText) },
      "optimal_ranges.json": { sha256: hash(parentSourceText), bytes: Buffer.byteLength(parentSourceText) },
    } });
    f.expectedManifestSha256 = hash(f.manifestText);
    f.candidate.ranges[0]!.rangeKind = "conventional_reference";
    f.candidate.ranges[0]!.source.packageSha256 = f.expectedManifestSha256;
    f.candidate.ranges[0]!.source.recordSha256 = hash(JSON.stringify(row));
    return { ...f, parentSourceText };
  }
  expect(preparePreciseLabRangeRelease(hormone(true), now).status).toBe("unsigned_not_deployed");
  expect(() => preparePreciseLabRangeRelease(hormone(false), now)).toThrow();
  expect(() => preparePreciseLabRangeRelease({ ...hormone(true), parentSourceText: undefined }, now)).toThrow();
});
test.each(["source-hash", "record-hash", "unit", "marker", "source-url", "missing-evidence", "expired"])("rejects %s drift", kind => {
  const f = fixture(), row = f.candidate.ranges[0]!;
  if (kind === "source-hash") f.sourceText += " ";
  if (kind === "record-hash") row.source.recordSha256 = "0".repeat(64);
  if (kind === "unit") row.unit = "widgets/dL";
  if (kind === "marker") row.canonicalName = "Other";
  if (kind === "source-url") row.source.url = "https://example.invalid/other";
  if (kind === "missing-evidence") row.source.verifiedAgainst = "";
  if (kind === "expired") f.candidate.expiresAt = "2026-09-01T00:00:00Z";
  expect(() => preparePreciseLabRangeRelease(f, now)).toThrow("lab_range_preparation_refused");
});
