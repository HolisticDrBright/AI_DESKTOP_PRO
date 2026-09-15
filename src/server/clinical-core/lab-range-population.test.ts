import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "vitest";
import { collectionRangeContextSchema, preciseLabRangeReleaseSchema, type CollectionRangeContext, type PreciseLabRangeRelease } from "./lab-range-population";
import { verifyLabRangeRelease, resolveReviewedLabRange } from "./lab-range-release";
import { normalizeStructuredLabBiomarkers } from "./aws-lab-analysis-worker";
import { safeStructuredLabBiomarkers } from "./aws-lab-analysis-api";

const now = Date.parse("2026-09-14T12:00:00Z");
const keys = generateKeyPairSync("ed25519");
function context(): CollectionRangeContext {
  return { dateOfBirth: "2026-01-01", observedOn: "2026-01-14", sex: "male", pregnancyStatus: "not_applicable",
    cyclePhase: null, reproductiveStage: null, contraception: null, pregnancyTrimester: null, assayId: "synthetic-assay" };
}
function release(): PreciseLabRangeRelease {
  return { schemaVersion: "lab-ranges/2", version: "synthetic/2", expiresAt: "2027-01-01T00:00:00Z", ranges: [{
    id: "11111111-1111-4111-8111-111111111111", canonicalName: "Fictional", aliases: ["Fixture"], unit: "widgets/L",
    rangeKind: "functional_target", min: 10, max: 20,
    population: { label: "Synthetic 4 to under 15 days", age: { unit: "days", min: 4, max: 15, minInclusive: true, maxInclusive: false },
      sexes: ["male"], pregnancyStatuses: ["not_applicable"], cyclePhases: null, reproductiveStages: null,
      contraceptions: null, pregnancyTrimesters: null, assayIds: ["synthetic-assay"] },
    source: { id: "22222222-2222-4222-8222-222222222222", version: "synthetic/1", url: "https://example.invalid/reference",
      packageSha256: "a".repeat(64), recordId: "synthetic-row", recordSha256: "b".repeat(64), verification: "V",
      verifiedBy: "Synthetic reviewer", verifiedOn: "2026-09-01", verifiedAgainst: "Fictional test interval only" },
    reviewedBy: "Synthetic reviewer", reviewedAt: "2026-09-01T00:00:00Z",
  }] };
}
function verified(value = release()) {
  const payload = JSON.stringify(value);
  return verifyLabRangeRelease({ payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64") },
    { sha256: createHash("sha256").update(payload).digest("hex"), publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }, now);
}
function resolve(value = release(), collection: unknown = context(), name = "Fixture", unit = "widgets/L") {
  return resolveReviewedLabRange(verified(value), name, unit,
    { ageYears: 40, sex: "female", pregnancyStatus: "pregnant", collection: collection as CollectionRangeContext }, now);
}
describe("precise population range release", () => {
  test.each([["2026-01-04", false], ["2026-01-05", true], ["2026-01-15", true], ["2026-01-16", false]])(
    "calendar day boundary %s", (observedOn, matched) => expect(resolve(release(), { ...context(), observedOn }).rangeReview).toBe(matched ? "matched" : "no_applicable_reviewed_range"));
  test("calendar months use month-end anniversaries, never thirty-day approximation", () => {
    const r = release(); r.ranges[0]!.population.age = { unit: "months", min: 1, max: 2, minInclusive: true, maxInclusive: false };
    expect(resolve(r, { ...context(), dateOfBirth: "2026-01-31", observedOn: "2026-02-27" }).functionalMin).toBeNull();
    expect(resolve(r, { ...context(), dateOfBirth: "2026-01-31", observedOn: "2026-02-28" }).functionalMin).toBe(10);
    expect(resolve(r, { ...context(), dateOfBirth: "2026-01-31", observedOn: "2026-03-31" }).functionalMin).toBeNull();
  });
  test("leap-year age anniversaries are deterministic", () => {
    const r = release(); r.ranges[0]!.population.age = { unit: "years", min: 1, max: 2, minInclusive: true, maxInclusive: false };
    expect(resolve(r, { ...context(), dateOfBirth: "2024-02-29", observedOn: "2025-02-28" }).functionalMin).toBe(10);
  });
  test("ancient birth years are not coerced into the twentieth century", () => {
    const r = release(); r.ranges[0]!.population.age = { unit: "years", min: 120, max: 125, minInclusive: true, maxInclusive: true };
    expect(resolve(r, { ...context(), dateOfBirth: "0001-01-01", observedOn: "2026-01-01" }).functionalMin).toBeNull();
  });
  test.each([undefined, null, {}, { ...context(), dateOfBirth: "2026-02-30" }, { ...context(), observedOn: "2025-12-31" },
    { ...context(), observedOn: "2099-01-01" }, { ...context(), sex: null }, { ...context(), assayId: null },
    { ...context(), assayId: "other-assay" }])("missing or incompatible collection context refuses %#", c => {
    expect(resolve(release(), c === undefined ? {} : c).functionalMin).toBeNull();
  });
  test("never treats conventional reference intervals as functional targets", () => {
    const r = release(); r.ranges[0]!.rangeKind = "conventional_reference"; expect(resolve(r).functionalMin).toBeNull();
  });
  test("unit mismatch and overlapping intervals do not choose a best guess", () => {
    expect(resolve(release(), context(), "Fixture", "widgets/dL").functionalMin).toBeNull();
    const r = release(); r.ranges.push({ ...r.ranges[0]!, id: "33333333-3333-4333-8333-333333333333" });
    expect(resolve(r).rangeReview).toBe("ambiguous_reviewed_range");
  });
  test.each(["cyclePhases", "reproductiveStages", "contraceptions", "pregnancyTrimesters"] as const)("requires known %s when scoped", dimension => {
    const r = release(), p = r.ranges[0]!.population;
    if (dimension === "cyclePhases") p.cyclePhases = ["luteal"];
    if (dimension === "reproductiveStages") p.reproductiveStages = ["perimenopause"];
    if (dimension === "contraceptions") p.contraceptions = ["hormonal"];
    if (dimension === "pregnancyTrimesters") { p.pregnancyTrimesters = [2]; p.pregnancyStatuses = ["pregnant"]; }
    expect(resolve(r).functionalMin).toBeNull();
  });
  test("matching reproductive dimensions are honored rather than inferred", () => {
    const r = release(), p = r.ranges[0]!.population;
    p.age = { unit: "years", min: 18, max: 65, minInclusive: true, maxInclusive: false };
    p.sexes = ["female"]; p.pregnancyStatuses = ["not_pregnant"]; p.cyclePhases = ["luteal"];
    p.reproductiveStages = ["perimenopause"]; p.contraceptions = ["none"];
    const c = { ...context(), dateOfBirth: "1980-01-01", observedOn: "2026-09-01", sex: "female",
      pregnancyStatus: "not_pregnant", cyclePhase: "luteal", reproductiveStage: "perimenopause", contraception: "none" };
    expect(resolve(r, c).functionalMin).toBe(10);
    expect(resolve(r, { ...c, contraception: "hormonal" }).functionalMin).toBeNull();
  });
  test("signed releases still require verified provenance and valid interval structure", () => {
    const r = release(); r.ranges[0]!.source.verifiedBy = ""; expect(() => verified(r)).toThrow();
    const duplicate = release(); duplicate.ranges.push(duplicate.ranges[0]!); expect(() => verified(duplicate)).toThrow();
    expect(collectionRangeContextSchema.safeParse({ ...context(), pregnancyTrimester: 1 }).success).toBe(false);
    expect(preciseLabRangeReleaseSchema.safeParse({ ...release(), unknown: true }).success).toBe(false);
  });
  test("structured API and worker preserve per-observation context, never inherit today's profile", () => {
    const rows = safeStructuredLabBiomarkers([{ markerId: "fixture", canonicalName: "Fixture", value: 25, unit: "widgets/L",
      labMin: 1, labMax: 30, collectionContext: context() }]);
    const catalog = verified(), population = { ageYears: 60, sex: "female", pregnancyStatus: "pregnant" };
    expect(normalizeStructuredLabBiomarkers(rows, "synthetic-doc", "", { catalog, population })[0]!.functionalMin).toBe(10);
    delete rows[0]!.collectionContext;
    expect(normalizeStructuredLabBiomarkers(rows, "synthetic-doc", "", { catalog, population })[0]!.functionalMin).toBeNull();
    expect(() => safeStructuredLabBiomarkers([{ ...rows[0], collectionContext: { ...context(), dateOfBirth: "bad" } }])).toThrow();
  });
});
