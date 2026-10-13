if (typeof window !== "undefined") {
  throw new Error("clinical-core/catalog-import-reconciliation is server-only.");
}

import type { ClinicalCoreDatabase } from "./database";
import type { GovernedCatalogSeedManifest } from "./aws-governed-catalog";
import type { CatalogEnvironment } from "./aws-governed-catalog-reader";

/**
 * Catalog import reconciliation (catalog-import-reconciliation/1): read-only accounting of what a catalog
 * environment actually holds for a product, against the checked-in source releases.
 *
 * For each product it reports the current product version and the import batch (source package, version,
 * manifest digest) it came from, and classifies the label and the offer:
 *  - `missing_row`: the environment has no row at all, so no release it imported carried one;
 *  - `older_release_than_product`: a label exists but arrived in an earlier batch than the current product;
 *  - `not_approved` / `rejected`: a row exists but its review never approved it, or rejected it;
 *  - `current` (label) / `active` (offer): present and approved for the current product.
 * Each finding names which checked-in source releases DO carry the label or offer, so a missing row is never
 * mistaken for a source gap. It writes nothing, approves nothing and inserts nothing.
 */
export const CATALOG_IMPORT_RECONCILIATION = "catalog-import-reconciliation/1" as const;
type Versioned = { version: number; importBatchId: string };
export type HostedCatalogState = {
  batches: { id: string; sourcePackageId: string; sourcePackageVersion: number; manifestSha256: string; status: string }[];
  products: { stableId: string; reviewStatus: string; activeVersion: number | null; versions: (Versioned & { directOrderAllowed: boolean })[] }[];
  labels: { stableId: string; productStableId: string; reviewStatus: string; activeVersion: number | null; versions: Versioned[] }[];
  offers: { stableId: string; productStableId: string; reviewStatus: string; activeVersion: number | null; versions: Versioned[] }[];
};
export type LabelFinding = "missing_row" | "older_release_than_product" | "not_approved" | "rejected" | "current";
export type OfferFinding = "missing_row" | "not_approved" | "rejected" | "active";
export type ImportReconciliationRow = {
  productStableId: string;
  hosted: {
    product: { reviewStatus: string; activeVersion: number | null; batch: HostedCatalogState["batches"][number] | null; batchIsCheckedInSource: boolean } | null;
    label: { stableId: string; reviewStatus: string; activeVersion: number | null; batchId: string | null } | null;
    offer: { stableId: string; reviewStatus: string; activeVersion: number | null } | null;
  };
  source: { sourcePackageId: string; sourcePackageVersion: number; manifestSha256: string; productVersion: number; label: string | null; offer: string | null }[];
  labelFinding: LabelFinding;
  offerFinding: OfferFinding;
  explanation: string[];
};

const activeBatch = (versions: Versioned[], active: number | null) => versions.find(v => v.version === active)?.importBatchId ?? null;

export function reconcileCatalogImport(sources: GovernedCatalogSeedManifest[], hosted: HostedCatalogState, productStableIds: string[]): ImportReconciliationRow[] {
  const sourceDigests = new Set(sources.map(m => m.manifestSha256));
  return [...productStableIds].sort().map((productStableId): ImportReconciliationRow => {
    const source = sources.filter(m => m.products.some(p => p.stableId === productStableId)).map(m => ({
      sourcePackageId: m.sourcePackageId, sourcePackageVersion: m.sourcePackageVersion, manifestSha256: m.manifestSha256,
      productVersion: m.products.find(p => p.stableId === productStableId)!.version,
      label: m.productLabels.find(l => l.productStableId === productStableId)?.stableId ?? null,
      offer: m.commercialOffers.find(o => o.productStableId === productStableId)?.stableId ?? null,
    }));
    const product = hosted.products.find(p => p.stableId === productStableId) ?? null;
    const productBatchId = product ? activeBatch(product.versions, product.activeVersion) : null;
    const batch = hosted.batches.find(b => b.id === productBatchId) ?? null;
    const label = hosted.labels.find(l => l.productStableId === productStableId) ?? null;
    const offers = hosted.offers.filter(o => o.productStableId === productStableId);
    const offer = offers.find(o => o.reviewStatus === "approved") ?? offers[0] ?? null;
    const labelBatch = label ? activeBatch(label.versions, label.activeVersion) : null;

    const labelFinding: LabelFinding = !label ? "missing_row" : label.reviewStatus === "rejected" ? "rejected"
      : label.reviewStatus !== "approved" ? "not_approved" : labelBatch !== productBatchId ? "older_release_than_product" : "current";
    const offerFinding: OfferFinding = !offer ? "missing_row" : offer.reviewStatus === "rejected" ? "rejected"
      : offer.reviewStatus !== "approved" ? "not_approved" : "active";

    const carrying = (kind: "label" | "offer") => source.filter(s => s[kind]).map(s => `${s.sourcePackageId} v${s.sourcePackageVersion}`);
    const explanation: string[] = [];
    if (!product) explanation.push("No product row: no imported release carried this product.");
    else if (batch && !sourceDigests.has(batch.manifestSha256)) {
      explanation.push(`The current product version ${product.activeVersion} came from batch ${batch.id} (${batch.sourcePackageId} v${batch.sourcePackageVersion}), whose manifest is none of the checked-in source releases.`);
    } else if (!batch) explanation.push("The current product version has no recorded import batch.");
    if (labelFinding === "missing_row") explanation.push(carrying("label").length
      ? `No label row, although ${carrying("label").join(", ")} carr${carrying("label").length === 1 ? "ies" : "y"} one: no release this environment imported included it.`
      : "No label row, and no checked-in source release carries one either.");
    if (labelFinding === "older_release_than_product") explanation.push("The approved label arrived in an earlier release than the current product version; it does not describe the current bottle until both are released together.");
    if (labelFinding === "not_approved") explanation.push("A label row exists but was never approved (for example a flagged label the release approval skipped).");
    if (labelFinding === "rejected") explanation.push("A label row exists and was rejected in review.");
    if (offerFinding === "missing_row") explanation.push(carrying("offer").length
      ? `No offer row, although ${carrying("offer").join(", ")} carr${carrying("offer").length === 1 ? "ies" : "y"} one: no release this environment imported included it.`
      : "No offer row, and no checked-in source release carries one either.");
    if (offerFinding === "not_approved") explanation.push("An offer row exists but was never activated by a commercial review.");
    if (offerFinding === "rejected") explanation.push("An offer row exists and was rejected in review.");
    return {
      productStableId,
      hosted: {
        product: product ? { reviewStatus: product.reviewStatus, activeVersion: product.activeVersion, batch, batchIsCheckedInSource: batch ? sourceDigests.has(batch.manifestSha256) : false } : null,
        label: label ? { stableId: label.stableId, reviewStatus: label.reviewStatus, activeVersion: label.activeVersion, batchId: labelBatch } : null,
        offer: offer ? { stableId: offer.stableId, reviewStatus: offer.reviewStatus, activeVersion: offer.activeVersion } : null,
      },
      source, labelFinding, offerFinding, explanation,
    };
  });
}

/** The environment's rows for these products, read only. The caller supplies a read-capable connection. */
export async function readHostedCatalogState(database: ClinicalCoreDatabase, environment: CatalogEnvironment, productStableIds: string[]): Promise<HostedCatalogState> {
  if (productStableIds.length === 0 || productStableIds.length > 2_000 || productStableIds.some(id => !/^prd_[a-z0-9][a-z0-9_-]{2,95}$/.test(id))) {
    throw new Error("catalog_import_reconciliation_request_invalid");
  }
  const ids = JSON.stringify(productStableIds);
  return database.transaction(async (tx) => {
    await tx.query("set transaction read only");
    const products = (await tx.query<{ stable_id: string; review_status: string; active_version: number | null; versions: string }>(
      `select p.stable_id, p.review_status, p.active_version,
              coalesce((select json_agg(json_build_object('version', v.version, 'importBatchId', v.import_batch_id::text, 'directOrderAllowed', v.direct_order_allowed) order by v.version)
                        from clinical_reference.catalog_product_versions v where v.product_stable_id = p.stable_id), '[]')::text as versions
       from clinical_reference.catalog_products p
       where p.environment = $2 and p.stable_id in (select jsonb_array_elements_text($1::jsonb))`, [ids, environment])).rows;
    const labels = (await tx.query<{ stable_id: string; product_stable_id: string; review_status: string; active_version: number | null; versions: string }>(
      `select l.stable_id, l.product_stable_id, l.review_status, l.active_version,
              coalesce((select json_agg(json_build_object('version', v.version, 'importBatchId', v.import_batch_id::text) order by v.version)
                        from clinical_reference.product_label_versions v where v.label_stable_id = l.stable_id), '[]')::text as versions
       from clinical_reference.product_labels l
       where l.environment = $2 and l.product_stable_id in (select jsonb_array_elements_text($1::jsonb))`, [ids, environment])).rows;
    const offers = (await tx.query<{ stable_id: string; product_stable_id: string; review_status: string; active_version: number | null; versions: string }>(
      `select o.stable_id, v0.product_stable_id, o.review_status, o.active_version,
              coalesce((select json_agg(json_build_object('version', v.version, 'importBatchId', v.import_batch_id::text) order by v.version)
                        from commercial_reference.affiliate_offer_versions v where v.offer_stable_id = o.stable_id), '[]')::text as versions
       from commercial_reference.affiliate_offers o
       join lateral (select product_stable_id, environment from commercial_reference.affiliate_offer_versions v
                     where v.offer_stable_id = o.stable_id order by v.version desc limit 1) v0 on true
       where v0.environment = $2 and v0.product_stable_id in (select jsonb_array_elements_text($1::jsonb))`, [ids, environment])).rows;
    const batchIds = [...new Set([...products, ...labels, ...offers].flatMap(r => (JSON.parse(r.versions) as Versioned[]).map(v => v.importBatchId)))];
    const batches = batchIds.length === 0 ? [] : (await tx.query<{ id: string; source_package_id: string; source_package_version: number; manifest_sha256: string; status: string }>(
      `select id::text, source_package_id, source_package_version, manifest_sha256, status
       from clinical_reference.catalog_import_batches where id::text in (select jsonb_array_elements_text($1::jsonb))`, [JSON.stringify(batchIds)])).rows;
    return {
      batches: batches.map(b => ({ id: b.id, sourcePackageId: b.source_package_id, sourcePackageVersion: Number(b.source_package_version), manifestSha256: b.manifest_sha256, status: b.status })),
      products: products.map(p => ({ stableId: p.stable_id, reviewStatus: p.review_status, activeVersion: p.active_version === null ? null : Number(p.active_version), versions: JSON.parse(p.versions) })),
      labels: labels.map(l => ({ stableId: l.stable_id, productStableId: l.product_stable_id, reviewStatus: l.review_status, activeVersion: l.active_version === null ? null : Number(l.active_version), versions: JSON.parse(l.versions) })),
      offers: offers.map(o => ({ stableId: o.stable_id, productStableId: o.product_stable_id, reviewStatus: o.review_status, activeVersion: o.active_version === null ? null : Number(o.active_version), versions: JSON.parse(o.versions) })),
    };
  });
}
