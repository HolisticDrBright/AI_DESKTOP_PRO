import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { ClinicalCoreDatabase } from "./database";
import { loadGovernedCatalogMigrations } from "./catalog-migrations";
import {
  catalogSha256, importGovernedCatalog, manifestContentForHash, offerContentForHash, productContentForHash, productLabelContentForHash,
  type CatalogProductLabelSeed, type CatalogProductSeed, type CommercialOfferSeed, type GovernedCatalogSeedManifest,
} from "./aws-governed-catalog";
import { approveGovernedCatalogRelease, reviewGovernedCatalogVersion } from "./aws-governed-catalog-review";
import { readHostedCatalogState, reconcileCatalogImport } from "./catalog-import-reconciliation";

/**
 * Read-only import accounting on the real catalog SQL (embedded engine). Five fictional histories: a product whose
 * environment never imported a release carrying its label or offer (the Takesumi shape: current product version 5,
 * no label row, no offer row, while the checked-in source carries both); a label from an older release than the
 * current product; a flagged label the release approval skipped; a rejected label; and a fully current product.
 */
let pg: PGlite;
const reviewer = "90000000-0000-4000-8000-000000000003";
const unwrap = (p: unknown) => p && typeof p === "object" && "kind" in p && p.kind === "uuid" && "value" in p ? p.value : p;
const admin: ClinicalCoreDatabase = { transaction: work => pg.transaction(async tx => work({ query: (sql, parameters = []) => tx.query(sql, parameters.map(unwrap)) })) };
const CLEAN = { labelFound: true, physicalLabelRequired: false, substantiveConflict: false, practitionerDecisionRequired: false };
function product(key: string, version: number): CatalogProductSeed {
  const base = { stableId: `prd_recon_${key}`, version, displayName: `Fictional reconciliation product ${key}`, productType: "supplement" as const, accessTier: "open" as const,
    declaredRestricted: false, directOrderAllowed: true, clinicalPayload: { ingredients: [`Fictional ingredient ${version}`] }, sourceRefs: ["synthetic:import-reconciliation"] };
  return { ...base, contentSha256: catalogSha256(productContentForHash(base)) };
}
function label(key: string, version = 1, flags: Partial<typeof CLEAN> = {}): CatalogProductLabelSeed {
  const base = { stableId: `lbl_recon_${key}`, version, productStableId: `prd_recon_${key}`, ...CLEAN, ...flags,
    labelPayload: { servingSize: `${version} fictional capsule` }, crosscheckPayload: {}, sourceRefs: ["synthetic:import-reconciliation"] };
  return { ...base, contentSha256: catalogSha256(productLabelContentForHash(base)) };
}
function offer(key: string, version = 1): CommercialOfferSeed {
  const base = { stableId: `off_recon_${key}`, version, productStableId: `prd_recon_${key}`, destinationUrl: `https://example.invalid/recon/${key}`,
    trackingMetadata: { approval: "catalog_owner_commercial_activation", approvalVersion: "1.0.0" }, declaredRestricted: false, directOrderAllowed: true };
  return { ...base, contentSha256: catalogSha256(offerContentForHash(base)) };
}
function manifest(id: string, version: number, parts: { products: CatalogProductSeed[]; labels?: CatalogProductLabelSeed[]; offers?: CommercialOfferSeed[] }): GovernedCatalogSeedManifest {
  const base = { contractVersion: "governed-catalog-seed/1" as const, sourcePackageId: `synthetic.recon.${id}`, sourcePackageVersion: version,
    targetEnvironment: "synthetic-staging" as const, dataClassification: "reference_only" as const, containsPhi: false as const,
    products: parts.products, productLabels: parts.labels ?? [], commercialOffers: parts.offers ?? [], protocolTemplates: [], safetyRules: [], knowledgeSources: [] };
  return { ...base, manifestSha256: catalogSha256(manifestContentForHash(base)) };
}
const approve = (m: GovernedCatalogSeedManifest) => approveGovernedCatalogRelease(admin, { manifest: m, reviewerPersonId: reviewer, reason: "Fictional test review only.", environment: "synthetic-staging" });
const review = (subjectType: "affiliate_offer_version" | "product_label_version", stableId: string, version: number, outcome: "approved" | "rejected" = "approved") =>
  reviewGovernedCatalogVersion(admin, { subjectType, stableId, version, reviewerPersonId: reviewer, outcome, reason: "Fictional test review only.", environment: "synthetic-staging" });
const ids = ["gap", "older", "flagged", "rejected", "current"].map(k => `prd_recon_${k}`);
// What the checked-in source carries for every product: label and offer included.
const source = manifest("source", 102000, { products: ["gap", "older", "flagged", "rejected", "current"].map(k => product(k, 102000)),
  labels: ["gap", "older", "flagged", "rejected", "current"].map(k => label(k, 102000)), offers: ["gap", "older", "flagged", "rejected", "current"].map(k => offer(k, 102000)) });

beforeAll(async () => {
  pg = new PGlite({ extensions: { pgcrypto } });
  for (const migration of loadGovernedCatalogMigrations()) await pg.exec(migration.sql);
  // The gap: an environment that imported only the product, at version 5, from a release that is not the source.
  const gap = manifest("hosted-gap", 5, { products: [product("gap", 5)] });
  await importGovernedCatalog(admin, gap); await approve(gap);
  // An older label: released with version 1, then the product moved to version 2 alone.
  const r1 = manifest("older-1", 1, { products: [product("older", 1)], labels: [label("older", 1)], offers: [offer("older", 1)] });
  await importGovernedCatalog(admin, r1); await approve(r1); await review("affiliate_offer_version", "off_recon_older", 1);
  const r2 = manifest("older-2", 2, { products: [product("older", 2)] });
  await importGovernedCatalog(admin, r2); await approve(r2);
  // A flagged label the release approval skipped, with its offer never activated.
  const f = manifest("flagged", 1, { products: [product("flagged", 1)], labels: [label("flagged", 1, { physicalLabelRequired: true })], offers: [offer("flagged", 1)] });
  await importGovernedCatalog(admin, f); await approve(f);
  // A rejected label.
  const x = manifest("rejected", 1, { products: [product("rejected", 1)], labels: [label("rejected", 1, { physicalLabelRequired: true })], offers: [offer("rejected", 1)] });
  await importGovernedCatalog(admin, x); await approve(x); await review("product_label_version", "lbl_recon_rejected", 1, "rejected");
  // Fully current.
  const c = manifest("current", 1, { products: [product("current", 1)], labels: [label("current", 1)], offers: [offer("current", 1)] });
  await importGovernedCatalog(admin, c); await approve(c); await review("affiliate_offer_version", "off_recon_current", 1);
});
afterAll(async () => { await pg?.close(); });

describe("catalog import reconciliation tells a missing row from an older, unapproved or rejected one", () => {
  it("classifies every history and names the source releases that do carry the label and offer", async () => {
    const state = await readHostedCatalogState(admin, "synthetic-staging", ids);
    const rows = Object.fromEntries(reconcileCatalogImport([source], state, ids).map(r => [r.productStableId.replace("prd_recon_", ""), r]));
    expect(rows.gap).toMatchObject({ labelFinding: "missing_row", offerFinding: "missing_row",
      hosted: { product: { reviewStatus: "approved", activeVersion: 5, batchIsCheckedInSource: false, batch: { sourcePackageId: "synthetic.recon.hosted-gap", sourcePackageVersion: 5 } }, label: null, offer: null } });
    expect(rows.gap!.explanation.join(" ")).toMatch(/No label row, although synthetic\.recon\.source v102000 carries one/);
    expect(rows.gap!.explanation.join(" ")).toMatch(/No offer row, although synthetic\.recon\.source v102000 carries one/);
    expect(rows.older).toMatchObject({ labelFinding: "older_release_than_product", offerFinding: "active" });
    expect(rows.flagged).toMatchObject({ labelFinding: "not_approved", offerFinding: "not_approved" });
    expect(rows.rejected).toMatchObject({ labelFinding: "rejected" });
    expect(rows.current).toMatchObject({ labelFinding: "current", offerFinding: "active", hosted: { product: { batchIsCheckedInSource: false } } });
  });
  it("writes nothing: the read runs in a read-only transaction", async () => {
    const before = (await pg.query<{ n: number }>("select count(*)::int n from clinical_reference.catalog_import_batches")).rows[0]!.n;
    await readHostedCatalogState(admin, "synthetic-staging", ids);
    expect((await pg.query<{ n: number }>("select count(*)::int n from clinical_reference.catalog_import_batches")).rows[0]!.n).toBe(before);
    await expect(admin.transaction(async tx => { await tx.query("set transaction read only"); await tx.query("delete from clinical_reference.catalog_import_batches"); })).rejects.toThrow();
  });
  it("refuses a malformed request rather than reading everything", async () => {
    await expect(readHostedCatalogState(admin, "synthetic-staging", [])).rejects.toThrow("catalog_import_reconciliation_request_invalid");
    await expect(readHostedCatalogState(admin, "synthetic-staging", ["prd_ok", "not-a-product"])).rejects.toThrow("catalog_import_reconciliation_request_invalid");
  });
});
