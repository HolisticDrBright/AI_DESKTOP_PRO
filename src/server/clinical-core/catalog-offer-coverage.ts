import type { GovernedCatalogSeedManifest } from "./aws-governed-catalog";

/**
 * Offer coverage audit (catalog-offer-coverage/1): for every commercial offer in a release, whether a
 * consumer could order it once the release is approved, and if not, every reason why, by stable ID.
 * Reference data only: no patient, no address, no identity. The rule is the reader's: a consumer offer
 * needs a current open supplement, exactly one destination, and a label that is located, needs no
 * physical label, has no open conflict and no outstanding practitioner decision, and that ships in the
 * same release as the product. Explicit owner holds (NeuroGEVITY, the Black Walnut and Scutellaria label
 * conflicts) are reported as held whatever else is true.
 *
 * It never proposes a label. A candidate row that names an original product as its duplicate is
 * reported as `label_traceable_via_duplicate` so a reviewer can look; it does not become orderable.
 */
export const CATALOG_OFFER_COVERAGE_CONTRACT = "catalog-offer-coverage/1" as const;
export type OfferCoverageReason =
  | "product_missing" | "product_not_consumer_open" | "product_direct_order_withdrawn"
  | "no_label_record" | "label_not_found" | "physical_label_required" | "substantive_conflict" | "practitioner_decision_required"
  | "ambiguous_destinations" | "destination_shared_with_other_product" | "held_by_owner_decision";
export type OfferCoverageRow = {
  offerStableId: string; productStableId: string; origin: "original_primary" | "expanded_secondary" | "unknown";
  consumerActionableAfterApproval: boolean; reasons: OfferCoverageReason[]; labelTraceableViaDuplicateOf?: string;
};
export type OfferCoverageReport = {
  contract: typeof CATALOG_OFFER_COVERAGE_CONTRACT; sourcePackageId: string; sourcePackageVersion: number; manifestSha256: string;
  counts: { products: number; offers: number; productsWithAnyLabel: number; productsWithReadyLabel: number; actionableOffers: number; withheldOffers: number;
    byReason: Partial<Record<OfferCoverageReason, number>>; byOrigin: Record<string, { offers: number; actionable: number }> };
  held: { authoringId: string; productStableId: string | null; offerStableIds: string[]; consumerActionable: boolean }[];
  offers: OfferCoverageRow[];
};

/** Owner holds named by authoring ID (both packages), as decided in catalog_decisions.json. */
export const OWNER_HOLDS: readonly string[] = Object.freeze([
  "aff_healthgevity_neurogevity_026", "cand_healthgevity_neurogevity",
  "aff_supreme_nutrition_black_walnut_tincture_029", "aff_supreme_nutrition_scutellaria_tincture_032",
]);

export function auditCatalogOfferCoverage(manifest: GovernedCatalogSeedManifest, holds: readonly string[] = OWNER_HOLDS): OfferCoverageReport {
  const products = new Map(manifest.products.map(p => [p.stableId, p]));
  const labels = new Map(manifest.productLabels.map(l => [l.productStableId, l]));
  const ready = (productId: string) => { const l = labels.get(productId); return !!l && l.labelFound && !l.physicalLabelRequired && !l.substantiveConflict && !l.practitionerDecisionRequired; };
  const offersPerProduct = new Map<string, number>();
  const productsPerDestination = new Map<string, Set<string>>();
  for (const o of manifest.commercialOffers) {
    offersPerProduct.set(o.productStableId, (offersPerProduct.get(o.productStableId) ?? 0) + 1);
    const key = o.destinationUrl.trim().toLowerCase();
    productsPerDestination.set(key, (productsPerDestination.get(key) ?? new Set()).add(o.productStableId));
  }
  const authoringId = (productId: string) => { const a = products.get(productId)?.clinicalPayload.authoringId; return typeof a === "string" ? a : null; };
  const held = new Set(holds);
  const rows: OfferCoverageRow[] = manifest.commercialOffers.map((o): OfferCoverageRow => {
    const p = products.get(o.productStableId);
    const reasons: OfferCoverageReason[] = [];
    if (!p) reasons.push("product_missing");
    else {
      if (p.productType !== "supplement" || p.accessTier !== "open" || p.declaredRestricted) reasons.push("product_not_consumer_open");
      if (!p.directOrderAllowed || !o.directOrderAllowed || o.declaredRestricted) reasons.push("product_direct_order_withdrawn");
      const l = labels.get(p.stableId);
      if (!l) reasons.push("no_label_record");
      else {
        if (!l.labelFound) reasons.push("label_not_found");
        if (l.physicalLabelRequired) reasons.push("physical_label_required");
        if (l.substantiveConflict) reasons.push("substantive_conflict");
        if (l.practitionerDecisionRequired) reasons.push("practitioner_decision_required");
      }
      if ((offersPerProduct.get(p.stableId) ?? 0) > 1) reasons.push("ambiguous_destinations");
      if ((productsPerDestination.get(o.destinationUrl.trim().toLowerCase())?.size ?? 0) > 1) reasons.push("destination_shared_with_other_product");
      if (held.has(authoringId(p.stableId) ?? "")) reasons.push("held_by_owner_decision");
    }
    const group = p?.clinicalPayload.selectionPriorityGroup;
    const duplicateOf = p?.clinicalPayload.duplicateOfOriginalStableId;
    return {
      offerStableId: o.stableId, productStableId: o.productStableId,
      origin: group === "original_primary" ? "original_primary" : group === "expanded_secondary" ? "expanded_secondary" : "unknown",
      consumerActionableAfterApproval: reasons.length === 0, reasons,
      ...(typeof duplicateOf === "string" && ready(duplicateOf) && !labels.has(o.productStableId) ? { labelTraceableViaDuplicateOf: duplicateOf } : {}),
    };
  }).sort((a, b) => (a.offerStableId < b.offerStableId ? -1 : a.offerStableId > b.offerStableId ? 1 : 0));
  const byReason: Partial<Record<OfferCoverageReason, number>> = {};
  const byOrigin: Record<string, { offers: number; actionable: number }> = {};
  for (const r of rows) {
    for (const reason of r.reasons) byReason[reason] = (byReason[reason] ?? 0) + 1;
    const o = byOrigin[r.origin] ??= { offers: 0, actionable: 0 };
    o.offers++; if (r.consumerActionableAfterApproval) o.actionable++;
  }
  const heldRows = [...held].sort().map(id => {
    const product = manifest.products.find(p => p.clinicalPayload.authoringId === id) ?? null;
    const offerIds = product ? rows.filter(r => r.productStableId === product.stableId).map(r => r.offerStableId) : [];
    return { authoringId: id, productStableId: product?.stableId ?? null, offerStableIds: offerIds,
      consumerActionable: rows.some(r => offerIds.includes(r.offerStableId) && r.consumerActionableAfterApproval) };
  });
  const actionable = rows.filter(r => r.consumerActionableAfterApproval).length;
  return {
    contract: CATALOG_OFFER_COVERAGE_CONTRACT, sourcePackageId: manifest.sourcePackageId, sourcePackageVersion: manifest.sourcePackageVersion, manifestSha256: manifest.manifestSha256,
    counts: { products: manifest.products.length, offers: rows.length, productsWithAnyLabel: labels.size,
      productsWithReadyLabel: [...labels.keys()].filter(ready).length, actionableOffers: actionable, withheldOffers: rows.length - actionable, byReason, byOrigin },
    held: heldRows, offers: rows,
  };
}
