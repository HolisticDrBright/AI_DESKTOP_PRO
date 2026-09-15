import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { preparePreciseLabRangeRelease } from "./prepare-lab-range-release";
import type { PreciseLabRangeRelease } from "./lab-range-population";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const now = Date.parse("2026-09-14T12:00:00Z");
function fixture(mutateSource?: (r: Record<string, unknown>) => void) {
  const sourceRow: Record<string, unknown> = { id: "synthetic-source", marker: "Fictional", units: "widgets/L",
    reviewStatus: "approved", verification: "V", contentType: "pediatric_functional_range",
    sourceUrl: "https://example.invalid/source", contested: false };
  mutateSource?.(sourceRow);
  const sourceText = JSON.stringify([sourceRow]);
  const manifestText = JSON.stringify({ package: "pediatric-optimal-ranges", files: {
    "functional_statements.json": { sha256: hash(sourceText), bytes: Buffer.byteLength(sourceText) },
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
  return { manifestText, expectedManifestSha256: hash(manifestText), sourceFile: "functional_statements.json", sourceText, candidate };
}
test("prepares an unsigned exact-source candidate without modifying approvals or source", () => {
  const input = fixture(), before = structuredClone(input);
  const result = preparePreciseLabRangeRelease(input, now);
  expect(result.status).toBe("unsigned_not_deployed");
  expect(result.release.schemaVersion).toBe("lab-ranges/2");
  expect(input).toEqual(before);
});
test.each(["needs_review", "on_hold", "rejected"])("freshly hashed %s source cannot be promoted", status => {
  expect(() => preparePreciseLabRangeRelease(fixture(row => { row.reviewStatus = status; }), now)).toThrow();
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
