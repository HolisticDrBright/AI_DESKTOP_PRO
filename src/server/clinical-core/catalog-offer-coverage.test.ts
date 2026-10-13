import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  catalogSha256, manifestContentForHash, offerContentForHash, productContentForHash, productLabelContentForHash,
  type CatalogProductLabelSeed, type CatalogProductSeed, type CommercialOfferSeed, type GovernedCatalogSeedManifest,
} from "./aws-governed-catalog";
import { auditCatalogOfferCoverage } from "./catalog-offer-coverage";

/** The offer coverage audit on fictional releases, and the committed report for the real checked-in packages. */
const product = (key: string, over: Partial<CatalogProductSeed> = {}, payload: Record<string, unknown> = {}): CatalogProductSeed => {
  const base = { stableId: `prd_cov_${key}`, version: 1, displayName: `Fictional ${key}`, productType: "supplement" as const, accessTier: "open" as const,
    declaredRestricted: false, directOrderAllowed: true, clinicalPayload: { authoringId: `auth_${key}`, ...payload }, sourceRefs: ["synthetic:coverage"], ...over };
  return { ...base, contentSha256: catalogSha256(productContentForHash(base)) };
};
const label = (key: string, over: Partial<CatalogProductLabelSeed> = {}): CatalogProductLabelSeed => {
  const base = { stableId: `lbl_cov_${key}`, version: 1, productStableId: `prd_cov_${key}`, labelFound: true, physicalLabelRequired: false, substantiveConflict: false,
    practitionerDecisionRequired: false, labelPayload: {}, crosscheckPayload: {}, sourceRefs: ["synthetic:coverage"], ...over };
  return { ...base, contentSha256: catalogSha256(productLabelContentForHash(base)) };
};
const offer = (key: string, suffix = "a", url = `https://example.invalid/${key}/${suffix}`): CommercialOfferSeed => {
  const base = { stableId: `off_cov_${key}_${suffix}`, version: 1, productStableId: `prd_cov_${key}`, destinationUrl: url, trackingMetadata: {}, declaredRestricted: false, directOrderAllowed: true };
  return { ...base, contentSha256: catalogSha256(offerContentForHash(base)) };
};
function release(products: CatalogProductSeed[], labels: CatalogProductLabelSeed[], offers: CommercialOfferSeed[]): GovernedCatalogSeedManifest {
  const base = { contractVersion: "governed-catalog-seed/1" as const, sourcePackageId: "synthetic.coverage", sourcePackageVersion: 1, targetEnvironment: "synthetic-staging" as const,
    dataClassification: "reference_only" as const, containsPhi: false as const, products, productLabels: labels, commercialOffers: offers, protocolTemplates: [], safetyRules: [], knowledgeSources: [] };
  return { ...base, manifestSha256: catalogSha256(manifestContentForHash(base)) };
}

describe("offer coverage audit", () => {
  it("names every reason an offer is not consumer-actionable, and only a clean single-destination labelled open product passes", () => {
    const r = auditCatalogOfferCoverage(release(
      [product("ok"), product("nolabel"), product("conflict"), product("found"), product("two"), product("gated", { accessTier: "practitioner_gated", declaredRestricted: true, directOrderAllowed: false }),
        product("shareA"), product("shareB"), product("held")],
      [label("ok"), label("conflict", { substantiveConflict: true }), label("found", { labelFound: false, physicalLabelRequired: true }), label("two"), label("gated"), label("shareA"), label("shareB"), label("held")],
      [offer("ok"), offer("nolabel"), offer("conflict"), offer("found"), offer("two", "a"), offer("two", "b"), offer("gated"),
        offer("shareA", "a", "https://brand.example.invalid/"), offer("shareB", "a", "https://BRAND.example.invalid/"), offer("held")],
    ), ["auth_held"]);
    const by = Object.fromEntries(r.offers.map(o => [o.offerStableId, o.reasons]));
    expect(by.off_cov_ok_a).toEqual([]);
    expect(by.off_cov_nolabel_a).toEqual(["no_label_record"]);
    expect(by.off_cov_conflict_a).toEqual(["substantive_conflict"]);
    expect(by.off_cov_found_a).toEqual(["label_not_found", "physical_label_required"]);
    expect(by.off_cov_two_a).toEqual(["ambiguous_destinations"]);
    expect(by.off_cov_gated_a).toEqual(["product_not_consumer_open", "product_direct_order_withdrawn"]);
    expect(by.off_cov_shareA_a).toEqual(["destination_shared_with_other_product"]);
    expect(by.off_cov_held_a).toEqual(["held_by_owner_decision"]);
    expect(r.counts).toMatchObject({ offers: 10, actionableOffers: 1, withheldOffers: 9, productsWithAnyLabel: 8, productsWithReadyLabel: 6 });
    expect(r.held).toEqual([{ authoringId: "auth_held", productStableId: "prd_cov_held", offerStableIds: ["off_cov_held_a"], consumerActionable: false }]);
  });
  it("reports a duplicate-of link to a labelled original for review, and never makes it orderable", () => {
    const r = auditCatalogOfferCoverage(release([product("orig"), product("dup", {}, { duplicateOfOriginalStableId: "prd_cov_orig" })], [label("orig")], [offer("dup")]), []);
    expect(r.offers[0]).toMatchObject({ consumerActionableAfterApproval: false, reasons: ["no_label_record"], labelTraceableViaDuplicateOf: "prd_cov_orig" });
  });
});

describe("the committed report for the checked-in packages (docs/evidence/2026-10-13-catalog-offer-coverage.json)", () => {
  const report = JSON.parse(readFileSync("docs/evidence/2026-10-13-catalog-offer-coverage.json", "utf8")) as Record<"expandedRelease" | "originalRelease", ReturnType<typeof auditCatalogOfferCoverage>>;
  it("explains the hosted gap: every expanded-catalog offer lacks a label record, so none is consumer-actionable", () => {
    expect(report.expandedRelease.counts).toMatchObject({ products: 847, offers: 598, actionableOffers: 0 });
    expect(report.expandedRelease.counts.byReason.no_label_record).toBe(598);
    expect(report.expandedRelease.offers.every(o => o.reasons.includes("no_label_record"))).toBe(true);
  });
  it("keeps NeuroGEVITY and the Black Walnut and Scutellaria conflicts non-actionable in both releases", () => {
    for (const r of Object.values(report)) for (const h of r.held) expect(h.consumerActionable, h.authoringId).toBe(false);
    const original = Object.fromEntries(report.originalRelease.offers.map(o => [o.productStableId, o.reasons]));
    expect(original.prd_aff_supreme_nutrition_black_walnut_tincture_029).toEqual(expect.arrayContaining(["substantive_conflict", "held_by_owner_decision"]));
    expect(original.prd_aff_supreme_nutrition_scutellaria_tincture_032).toEqual(expect.arrayContaining(["substantive_conflict", "held_by_owner_decision"]));
  });
  it("is reference data only: stable ids, reasons and counts, no address or person", () => {
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/@|https?:\/\//);
    for (const r of Object.values(report)) expect(r.counts.actionableOffers + r.counts.withheldOffers).toBe(r.counts.offers);
  });
});
