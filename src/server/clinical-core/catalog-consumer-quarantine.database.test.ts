import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { ClinicalCoreDatabase } from "./database";
import { loadGovernedCatalogMigrations } from "./catalog-migrations";
import {
  catalogSha256, importGovernedCatalog, manifestContentForHash, offerContentForHash, productContentForHash, productLabelContentForHash,
  type CatalogProductLabelSeed, type CatalogProductSeed, type CommercialOfferSeed, type GovernedCatalogSeedManifest,
} from "./aws-governed-catalog";
import { createAwsGovernedCatalogReader } from "./aws-governed-catalog-reader";
import { approveGovernedCatalogRelease, reviewGovernedCatalogVersion } from "./aws-governed-catalog-review";
import { CONSUMER_SUPPLEMENT_QUARANTINE } from "./catalog-consumer-quarantine";

/**
 * The three known non-supplement goods are held out of the consumer supplement read by exact stable ID, while the
 * workforce still sees them. Beside them: a real supplement, a product with two destinations, one whose label is
 * from an older release, and one with no label. Fictional content under the three real stable IDs; embedded engine,
 * reduced API role; not hosted evidence.
 */
let pg: PGlite;
const reviewer = "90000000-0000-4000-8000-000000000004";
const unwrap = (p: unknown) => p && typeof p === "object" && "kind" in p && p.kind === "uuid" && "value" in p ? p.value : p;
const driver = (role?: "clinical_core_api"): ClinicalCoreDatabase => ({ transaction: work => pg.transaction(async tx => {
  if (role) await tx.exec("set local role clinical_core_api");
  return work({ query: (sql, parameters = []) => tx.query(sql, parameters.map(unwrap)) });
}) });
const admin = driver(), api = driver("clinical_core_api");
const CLEAN = { labelFound: true, physicalLabelRequired: false, substantiveConflict: false, practitionerDecisionRequired: false };
const QUARANTINED = Object.keys(CONSUMER_SUPPLEMENT_QUARANTINE);
function product(stableId: string, version = 1): CatalogProductSeed {
  const base = { stableId, version, displayName: `Fictional ${stableId}`, productType: "supplement" as const, accessTier: "open" as const,
    declaredRestricted: false, directOrderAllowed: true, clinicalPayload: { ingredients: [`Fictional ${version}`] }, sourceRefs: ["synthetic:quarantine"] };
  return { ...base, contentSha256: catalogSha256(productContentForHash(base)) };
}
function label(productStableId: string, version = 1): CatalogProductLabelSeed {
  const base = { stableId: productStableId.replace(/^prd_/, "lbl_"), version, productStableId, ...CLEAN, labelPayload: { servingSize: "1 fictional unit" },
    crosscheckPayload: {}, sourceRefs: ["synthetic:quarantine"] };
  return { ...base, contentSha256: catalogSha256(productLabelContentForHash(base)) };
}
function offer(productStableId: string, suffix = "a"): CommercialOfferSeed {
  const base = { stableId: `${productStableId.replace(/^prd_/, "off_")}_${suffix}`, version: 1, productStableId, destinationUrl: `https://example.invalid/${productStableId}/${suffix}`,
    trackingMetadata: { approval: "catalog_owner_commercial_activation", approvalVersion: "1.0.0" }, declaredRestricted: false, directOrderAllowed: true };
  return { ...base, contentSha256: catalogSha256(offerContentForHash(base)) };
}
function manifest(id: string, version: number, parts: { products: CatalogProductSeed[]; labels?: CatalogProductLabelSeed[]; offers?: CommercialOfferSeed[] }): GovernedCatalogSeedManifest {
  const base = { contractVersion: "governed-catalog-seed/1" as const, sourcePackageId: `synthetic.quarantine.${id}`, sourcePackageVersion: version,
    targetEnvironment: "synthetic-staging" as const, dataClassification: "reference_only" as const, containsPhi: false as const,
    products: parts.products, productLabels: parts.labels ?? [], commercialOffers: parts.offers ?? [], protocolTemplates: [], safetyRules: [], knowledgeSources: [] };
  return { ...base, manifestSha256: catalogSha256(manifestContentForHash(base)) };
}
async function publish(m: GovernedCatalogSeedManifest) {
  await importGovernedCatalog(admin, m);
  await approveGovernedCatalogRelease(admin, { manifest: m, reviewerPersonId: reviewer, reason: "Fictional test review only.", environment: "synthetic-staging" });
  for (const o of m.commercialOffers) await reviewGovernedCatalogVersion(admin, { subjectType: "affiliate_offer_version", stableId: o.stableId, version: o.version,
    reviewerPersonId: reviewer, outcome: "approved", reason: "Fictional test review only.", environment: "synthetic-staging" });
}
async function readAll(audience: "consumer" | "workforce", limit: number) {
  const products: string[] = [], offers: string[] = [], orderable: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await createAwsGovernedCatalogReader(api, "synthetic-staging").listProducts({ limit, audience, ...(cursor ? { cursor } : {}) });
    products.push(...page.products.map(p => p.stableId)); orderable.push(...page.products.filter(p => p.directOrderAllowed).map(p => p.stableId));
    offers.push(...page.commercial.offers.map(o => o.productStableId));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { products, offers, orderable };
}
const REAL = "prd_quarantine_real_supplement", TWO = "prd_quarantine_two_destinations", OLD = "prd_quarantine_old_label", NONE = "prd_quarantine_no_label";

beforeAll(async () => {
  pg = new PGlite({ extensions: { pgcrypto } });
  for (const migration of loadGovernedCatalogMigrations()) await pg.exec(migration.sql);
  await publish(manifest("main", 1, { products: [...QUARANTINED, REAL, TWO, OLD, NONE].map(id => product(id)),
    labels: [...QUARANTINED, REAL, TWO, OLD].map(id => label(id)), offers: [...QUARANTINED, REAL, OLD, NONE].map(id => offer(id)).concat([offer(TWO, "a"), offer(TWO, "b")]) }));
  await publish(manifest("newer-old-label-product", 2, { products: [product(OLD, 2)] }));
});
afterAll(async () => { await pg?.close(); });

describe("the consumer supplement read holds out the three non-supplement goods by stable ID", () => {
  it.each([[100], [1], [3]])("at page size %i: quarantined goods absent, the rest truthfully gated, pagination stable", async (limit) => {
    const consumer = await readAll("consumer", limit);
    for (const id of QUARANTINED) {
      expect(consumer.products, id).not.toContain(id);
      expect(consumer.offers, id).not.toContain(id);
    }
    // A missing product is absent, not reported as "not needed"; the others are still listed with their real status.
    expect([...consumer.products].sort()).toEqual([NONE, OLD, REAL, TWO].sort());
    expect(new Set(consumer.products).size).toBe(consumer.products.length);
    expect(consumer.orderable).toEqual([REAL]);
    expect(consumer.offers).toEqual([REAL]);
  });
  it("the workforce still sees all seven, the quarantined three with their offers", async () => {
    const workforce = await readAll("workforce", 2);
    expect([...workforce.products].sort()).toEqual([...QUARANTINED, REAL, TWO, OLD, NONE].sort());
    for (const id of QUARANTINED) expect(workforce.offers, id).toContain(id);
  });
});
