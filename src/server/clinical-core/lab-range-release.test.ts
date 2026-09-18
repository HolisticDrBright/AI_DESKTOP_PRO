import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveReviewedLabRange, verifyLabRangeRelease, type LabRangeRelease } from "./lab-range-release";
import { normalizeStructuredLabBiomarkers } from "./aws-lab-analysis-worker";

const keys = generateKeyPairSync("ed25519");
const now = Date.parse("2026-09-08T00:00:00Z");
beforeEach(() => vi.setSystemTime(now));
afterEach(() => vi.useRealTimers());
const population = { ageYears: 40, sex: "male", pregnancyStatus: "not_applicable" };
function source(): LabRangeRelease {
  return { schemaVersion: "lab-ranges/1", version: "fictional-test-release/1", expiresAt: "2027-01-01T00:00:00Z", ranges: [{
    id: "11111111-1111-4111-8111-111111111111", canonicalName: "Fictional Test Marker", aliases: ["Fixture"], unit: "widgets/L", min: 10, max: 20,
    population: { label: "Fictional test adult", minAge: 18, maxAge: 90, sexes: ["male"], pregnancyStatuses: ["not_applicable"] },
    source: { id: "22222222-2222-4222-8222-222222222222", version: "fixture/1", url: "https://example.invalid/fictional-reference" },
    reviewedBy: "synthetic-reviewer", reviewedAt: "2026-09-01T00:00:00Z",
  }] };
}
function signed(release = source()) {
  const payload = JSON.stringify(release);
  return { envelope: { payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64") },
    trust: { sha256: createHash("sha256").update(payload).digest("hex"), publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() } };
}
function verified(release = source()) { const value = signed(release); return verifyLabRangeRelease(value.envelope, value.trust, now); }

describe("reviewed functional range releases", () => {
  test("verifies exact bytes, trusted signer and per-row provenance", () => {
    expect(resolveReviewedLabRange(verified(), "Fixture", "widgets/L", population, now)).toMatchObject({ functionalMin: 10, functionalMax: 20, sourceVersion: "fixture/1", rangeReview: "matched" });
  });
  test("rejects modified bytes even when the supplied row claims approval", () => {
    const value = signed(); value.envelope.payload = value.envelope.payload.replace('"max":20', '"max":99');
    expect(() => verifyLabRangeRelease(value.envelope, value.trust, now)).toThrow("lab_range_release_refused");
  });
  test("a matching hash alone cannot replace a trusted signature", () => {
    const value = signed(); value.envelope.signature = Buffer.alloc(64).toString("base64");
    expect(() => verifyLabRangeRelease(value.envelope, value.trust, now)).toThrow();
  });
  test.each(["unit", "reviewedBy"] as const)("refuses a signed release missing %s", field => {
    const release = source(); release.ranges[0][field] = ""; expect(() => verified(release)).toThrow();
  });
  test("expired releases are rejected even after being cached", () => {
    expect(() => resolveReviewedLabRange(verified(), "Fixture", "widgets/L", population, Date.parse("2027-02-01"))).toThrow();
  });
  test.each([
    { ...population, ageYears: null }, { ...population, ageYears: 10 }, { ...population, sex: null },
    { ...population, sex: "female" }, { ...population, pregnancyStatus: "unsure" },
  ])("never assumes missing or incompatible population data %o", p => {
    expect(resolveReviewedLabRange(verified(), "Fixture", "widgets/L", p, now)).toMatchObject({ functionalMin: null, rangeReview: "no_applicable_reviewed_range" });
  });
  test("unit mismatch and partial marker names do not match", () => {
    expect(resolveReviewedLabRange(verified(), "Fixture", "widgets/dL", population, now).functionalMin).toBeNull();
    expect(resolveReviewedLabRange(verified(), "Fixture ratio", "widgets/L", population, now).functionalMin).toBeNull();
  });
  test("overlapping approved rows fail closed rather than picking the first", () => {
    const release = source(); release.ranges.push({ ...release.ranges[0], id: "33333333-3333-4333-8333-333333333333", min: 5 });
    expect(resolveReviewedLabRange(verified(release), "Fixture", "widgets/L", population, now)).toMatchObject({ functionalMin: null, rangeReview: "ambiguous_reviewed_range" });
  });
  test("worker normalization uses the reviewed catalog and never falls back to fixture ranges", () => {
    const rows = normalizeStructuredLabBiomarkers([
      { markerId: "fixture", canonicalName: "Fixture", value: 22, unit: "widgets/L", labMin: 1, labMax: 30 },
      { markerId: "glucose", canonicalName: "Glucose", value: 95, unit: "mg/dL", labMin: 70, labMax: 99 },
    ], "11111111-1111-4111-8111-111111111111", "", { catalog: verified(), population });
    expect(rows[0]).toMatchObject({ functionalMin: 10, functionalMax: 20, sourceVersion: "fixture/1", value: 22 });
    expect(rows[1]).toMatchObject({ functionalMin: null, sourceVersion: null, labMin: 70 });
  });
});
