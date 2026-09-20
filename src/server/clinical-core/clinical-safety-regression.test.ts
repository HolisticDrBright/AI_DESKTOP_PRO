import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { runClinicalSafetyRegression, type ClinicalSafetyRegressionReport } from "./clinical-safety-regression";
import { LAB_INPUT_MARKERS, LAB_PLAUSIBILITY_MARKERS } from "./aws-lab-analysis-worker";
import type { PreciseLabRange, PreciseLabRangeRelease } from "./lab-range-population";

const now = Date.parse("2026-09-20T12:00:00Z");
const sourceId = "22222222-2222-4222-8222-222222222222";
let n = 0;
function range(name: string, unit: string, sex: "female" | "male", patch: Partial<PreciseLabRange> = {}): PreciseLabRange {
  n += 1;
  return { id: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`, canonicalName: name, aliases: [], unit, rangeKind: "functional_target", min: 1, max: 2,
    population: { label: `Synthetic adult ${sex}`, age: { unit: "years", min: 18, max: 65, minInclusive: true, maxInclusive: false }, sexes: [sex],
      pregnancyStatuses: ["not_applicable"], cyclePhases: null, reproductiveStages: null, contraceptions: null, pregnancyTrimesters: null, assayIds: null },
    source: { id: sourceId, version: "synthetic/1", url: "https://example.invalid/reference", packageSha256: "a".repeat(64), recordId: "row", recordSha256: "b".repeat(64),
      verification: "V", verifiedBy: "Synthetic reviewer", verifiedOn: "2026-09-01", verifiedAgainst: "Fictional interval only" },
    reviewedBy: "Synthetic reviewer", reviewedAt: "2026-09-01T00:00:00Z", ...patch };
}
/** A release that represents every extraction marker for both adult sexes. */
function fullRelease(): PreciseLabRangeRelease {
  const ranges = LAB_INPUT_MARKERS.flatMap(m => (["female", "male"] as const).map(sex => range(m.name, m.units[0], sex)));
  return { schemaVersion: "lab-ranges/2", version: "synthetic/2", expiresAt: "2027-01-01T00:00:00Z", ranges };
}
const exclusions = LAB_PLAUSIBILITY_MARKERS.map(marker => ({ marker, reason: "Fictional: plausibility-only analyte, no reviewed functional target", reviewedBy: "Synthetic reviewer", reviewedAt: "2026-09-02T00:00:00Z" }));
const ids = (report: ClinicalSafetyRegressionReport, status: string) => report.checks.filter(c => c.status === status).map(c => c.id);
describe("clinical safety regression evidence", () => {
  test("passes a fully represented, sourced release with reviewed exclusions, binds to the prepared bytes and digests itself", () => {
    const release = fullRelease();
    const report = runClinicalSafetyRegression(release, { exclusions }, now);
    expect(report.status).toBe("pass"); expect(ids(report, "fail")).toEqual([]);
    expect(ids(report, "not_applicable")).toEqual(["catalog_iron_and_reproductive_exclusions", "offers_and_counts_agree", "knowledge_aliases_resolve"]);
    expect(report.payloadSha256).toBe(createHash("sha256").update(JSON.stringify(release)).digest("hex"));
    // Every extraction rule plus each plausibility-only analyte that is not already an extraction rule.
    expect(report.inputMarkers).toBe(LAB_INPUT_MARKERS.length + LAB_PLAUSIBILITY_MARKERS.filter(m => !LAB_INPUT_MARKERS.some(r => r.name.toLowerCase() === m.toLowerCase())).length);
    expect(report.ranges).toBe(release.ranges.length);
    const { evidenceSha256, ...body } = report;
    expect(evidenceSha256).toBe(createHash("sha256").update(JSON.stringify(body)).digest("hex"));
    expect(report).toMatchObject({ approvalPerformed: false, activationPerformed: false, coverage: "partial" });
    expect(runClinicalSafetyRegression(release, { exclusions }, now)).toEqual(report);
  });
  test("a declared full run fails when catalog or knowledge is missing or the population list is empty, and reports full coverage only when nothing was skipped", () => {
    const release = fullRelease();
    const missing = runClinicalSafetyRegression(release, { exclusions, coverage: "full" }, now);
    expect(missing.status).toBe("fail"); expect(missing.coverage).toBe("partial");
    expect(missing.checks.find(c => c.id === "full_release_inputs_supplied")!.findings).toEqual([
      "check not applicable in a full run: catalog_iron_and_reproductive_exclusions", "check not applicable in a full run: offers_and_counts_agree", "check not applicable in a full run: knowledge_aliases_resolve"]);
    const empty = runClinicalSafetyRegression(release, { exclusions, requiredPopulations: [] }, now);
    expect(ids(empty, "fail")).toEqual(["regression_inputs_valid"]);
    const catalog = { products: [{ stableId: "safe", displayName: "Fictional safe", productType: "supplement", accessTier: "open", declaredRestricted: false, directOrderAllowed: true,
      clinicalPayload: { contraindicationRuleIds: [], autoSelectionEligible: true, ingredients: ["fictional herb"], cautionFlags: [], restrictions: [] } }],
      commercialOffers: [{ stableId: "o1", productStableId: "safe", destinationUrl: "https://example.invalid/safe", declaredRestricted: false, directOrderAllowed: true }], counts: { products: 1, commercialOffers: 1 } };
    const knowledge = { entries: [{ id: "k1", biomarkerAliases: ["glucose"], reviewStatus: "approved", contested: false }] };
    const full = runClinicalSafetyRegression(release, { exclusions, coverage: "full", catalog, knowledgeRelease: knowledge }, now);
    expect(full.status).toBe("pass"); expect(full.coverage).toBe("full"); expect(ids(full, "not_applicable")).toEqual([]);
    expect(full.checks.find(c => c.id === "full_release_inputs_supplied")).toMatchObject({ status: "pass", findings: [] });
    // Supplying every artifact without declaring a full run stays partial evidence.
    expect(runClinicalSafetyRegression(release, { exclusions, catalog, knowledgeRelease: knowledge }, now).coverage).toBe("partial");
  });
  test("fails when an input marker is neither represented nor excluded, or an exclusion is unknown, future-dated or contradicts a range", () => {
    const release = fullRelease();
    const missing = runClinicalSafetyRegression(release, { exclusions: exclusions.slice(1) }, now);
    expect(ids(missing, "fail")).toEqual(["input_markers_represented_or_excluded"]);
    expect(missing.checks[0].findings).toEqual([`marker not represented and not excluded: ${LAB_PLAUSIBILITY_MARKERS[0]}`]);
    const unknown = runClinicalSafetyRegression(release, { exclusions: [...exclusions, { ...exclusions[0], marker: "Fictional analyte" }] }, now);
    expect(unknown.checks[0].findings).toEqual(["exclusion names an unknown marker: Fictional analyte"]);
    const future = runClinicalSafetyRegression(release, { exclusions: [{ ...exclusions[0], reviewedAt: "2027-01-01T00:00:00Z" }, ...exclusions.slice(1)] }, now);
    expect(future.checks[0].findings[0]).toContain("exclusion reviewed in the future");
    const both = runClinicalSafetyRegression(release, { exclusions: [...exclusions, { ...exclusions[0], marker: "Glucose" }] }, now);
    expect(both.checks[0].findings).toEqual(["marker both represented and wholly excluded: Glucose"]);
  });
  test("fails on future dates, duplicates, expiry, foreign units and missing required populations", () => {
    const release = fullRelease();
    release.ranges[0]!.reviewedAt = "2027-01-01T00:00:00Z";
    release.ranges.push({ ...release.ranges[1]!, id: "11111111-1111-4111-8111-999999999999" });
    release.ranges[2] = { ...release.ranges[2]!, unit: "mmol/L" };
    const glucoseMale = release.ranges.findIndex(r => r.canonicalName === "TSH" && r.population.sexes[0] === "male");
    release.ranges.splice(glucoseMale, 1);
    const report = runClinicalSafetyRegression({ ...release, expiresAt: "2026-09-20T11:00:00Z" }, { exclusions }, now);
    expect(ids(report, "fail")).toEqual(["ranges_sourced_verified_and_dated", "units_match_extraction_vocabulary", "required_populations_covered"]);
    const sourcing = report.checks.find(c => c.id === "ranges_sourced_verified_and_dated")!.findings;
    expect(sourcing).toEqual(expect.arrayContaining([expect.stringContaining("future review date"), expect.stringContaining("duplicate population band"), "release already expired"]));
    expect(report.checks.find(c => c.id === "units_match_extraction_vocabulary")!.findings[0]).toContain("mmol/L");
    expect(report.checks.find(c => c.id === "required_populations_covered")!.findings).toEqual(["TSH has no functional target for adult male (not pregnant)"]);
    const excusedPopulation = runClinicalSafetyRegression(release, { exclusions: [...exclusions, { marker: "TSH", reason: "Fictional: male band under review", reviewedBy: "Synthetic reviewer", reviewedAt: "2026-09-02T00:00:00Z", populations: ["adult male"] }] }, now);
    expect(excusedPopulation.checks.find(c => c.id === "required_populations_covered")!.status).toBe("pass");
  });
  test("checks catalog eligibility, offers and counts, and knowledge aliases when the artifacts are supplied", () => {
    const product = (stableId: string, patch: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => ({ stableId, displayName: `Fictional ${stableId}`, productType: "supplement", accessTier: "open",
      declaredRestricted: false, directOrderAllowed: true, clinicalPayload: { contraindicationRuleIds: [], autoSelectionEligible: true, ingredients: ["fictional herb"], cautionFlags: [], restrictions: [], ...payload }, ...patch });
    const catalog = { products: [product("safe"), product("iron-a", {}, { ingredients: ["Iron bisglycinate"] }), product("preg", {}, { cautionFlags: ["Pregnancy: consult clinician"] }),
      product("iron-b", {}, { ingredients: ["heme iron"], autoSelectionEligible: false, cautionFlags: ["High iron: exclude when ferritin elevated"] }), product("restricted", { declaredRestricted: true, directOrderAllowed: false })],
      commercialOffers: [{ stableId: "o1", productStableId: "safe", destinationUrl: "https://example.invalid/safe", declaredRestricted: false, directOrderAllowed: true },
        { stableId: "o2", productStableId: "missing", destinationUrl: "https://example.invalid/x", declaredRestricted: false, directOrderAllowed: true },
        { stableId: "o3", productStableId: "safe", destinationUrl: "http://user:pw@example.invalid/safe", declaredRestricted: false, directOrderAllowed: true },
        { stableId: "o4", productStableId: "restricted", destinationUrl: "https://example.invalid/r", declaredRestricted: true, directOrderAllowed: true }],
      counts: { products: 4, commercialOffers: 4 } };
    const knowledge = { entries: [{ id: "k1", biomarkerAliases: ["glucose"], reviewStatus: "approved", contested: false }, { id: "k2", biomarkerAliases: ["fictional unknown analyte"], reviewStatus: "approved", contested: false },
      { id: "k3", biomarkerAliases: ["tsh"], reviewStatus: "approved", contested: true }] };
    const report = runClinicalSafetyRegression(fullRelease(), { exclusions, catalog, knowledgeRelease: knowledge }, now);
    expect(ids(report, "fail")).toEqual(["catalog_iron_and_reproductive_exclusions", "offers_and_counts_agree", "knowledge_aliases_resolve"]);
    expect(report.checks.find(c => c.id === "catalog_iron_and_reproductive_exclusions")!.findings).toEqual([
      "auto-selectable despite iron content: iron-a", "iron-containing product carries no contraindication rule or iron caution flag: iron-a", "auto-selectable despite pregnancy or nursing caution: preg", "auto-selectable despite restriction: restricted"]);
    expect(report.checks.find(c => c.id === "offers_and_counts_agree")!.findings).toEqual([
      "offer without an approved product: o2", "offer destination is not a plain https url: o3", "offer allows direct order for a product that does not: o4", "declared product count 4 differs from 5"]);
    expect(report.checks.find(c => c.id === "knowledge_aliases_resolve")!.findings).toEqual(["no alias resolves to a recognized marker: k2", "entry not approved or contested: k3"]);
    const clean = runClinicalSafetyRegression(fullRelease(), { exclusions, catalog: { products: [product("safe"), product("iron-b", {}, { ingredients: ["heme iron"], autoSelectionEligible: false, contraindicationRuleIds: ["iron-high"] })],
      commercialOffers: [catalog.commercialOffers[0]], counts: { products: 2, commercialOffers: 1 } }, knowledgeRelease: { entries: [knowledge.entries[0]] } }, now);
    expect(clean.status).toBe("pass"); expect(ids(clean, "not_applicable")).toEqual([]);
  });
  test("refuses malformed inputs and releases without reading further, and never reports approval", () => {
    const badInputs = runClinicalSafetyRegression(fullRelease(), { exclusions: "x" }, now);
    expect(badInputs).toMatchObject({ status: "fail", payloadSha256: null, checks: [{ id: "regression_inputs_valid", status: "fail" }], approvalPerformed: false });
    const badRelease = runClinicalSafetyRegression({ schemaVersion: "lab-ranges/1" }, { exclusions }, now);
    expect(badRelease.checks).toEqual([{ id: "release_schema_valid", status: "fail", findings: ["prepared release is not a valid lab-ranges/2 document"] }]);
    expect(JSON.stringify(badRelease)).not.toMatch(/approved|activated/);
  });
});
