import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { ClinicalCoreDatabase } from "./database";
import { loadGovernedCatalogMigrations } from "./catalog-migrations";
import {
  catalogSha256, importGovernedCatalog, manifestContentForHash, offerContentForHash, productContentForHash, productLabelContentForHash,
  validateGovernedCatalogManifest, type CatalogProductLabelSeed, type CatalogProductSeed, type CommercialOfferSeed, type GovernedCatalogSeedManifest,
} from "./aws-governed-catalog";
import { createAwsGovernedCatalogReader } from "./aws-governed-catalog-reader";
import { approveGovernedCatalogRelease, reviewGovernedCatalogVersion } from "./aws-governed-catalog-review";

/**
 * The consumer offer gate on the real catalog SQL (embedded engine; not hosted acceptance). A consumer
 * offer is actionable only for the CURRENT product whose label is approved AND clean: found, no physical
 * label required, no substantive conflict, no practitioner decision outstanding. A label approved by an
 * individual review despite one of those flags (an open Black Walnut style conflict) is not enough. A
 * product with more than one active destination is ambiguous and orders nothing. Workforce sees the
 * rows with their truthful status. Fictional products and destinations only.
 */
let pg: PGlite;
let serial = 0;
const reviewer = "90000000-0000-4000-8000-000000000002";
const unwrap = (p: unknown) => p && typeof p === "object" && "kind" in p && p.kind === "uuid" && "value" in p ? p.value : p;
const driver = (role?: "clinical_core_api"): ClinicalCoreDatabase => ({
  transaction: work => pg.transaction(async tx => {
    if (role) await tx.exec("set local role clinical_core_api");
    return work({ query: (sql, parameters = []) => tx.query(sql, parameters.map(unwrap)) });
  }),
});
const admin = driver();
const api = driver("clinical_core_api");
type LabelFlags = Pick<CatalogProductLabelSeed, "labelFound" | "physicalLabelRequired" | "substantiveConflict" | "practitionerDecisionRequired">;
const CLEAN: LabelFlags = { labelFound: true, physicalLabelRequired: false, substantiveConflict: false, practitionerDecisionRequired: false };

function product(key: string, version = 1, payload: Record<string, unknown> = { ingredients: ["Fictional ingredient"] }): CatalogProductSeed {
  const base = { stableId: `prd_gate_${key}`, version, displayName: `Fictional gate product ${key}`, productType: "supplement" as const, accessTier: "open" as const,
    declaredRestricted: false, directOrderAllowed: true, clinicalPayload: payload, sourceRefs: ["synthetic:label-gate"] };
  return { ...base, contentSha256: catalogSha256(productContentForHash(base)) };
}
function label(key: string, flags: LabelFlags, version = 1): CatalogProductLabelSeed {
  const base = { stableId: `lbl_gate_${key}`, version, productStableId: `prd_gate_${key}`, ...flags,
    labelPayload: { servingSize: "1 fictional capsule" }, crosscheckPayload: {}, sourceRefs: ["synthetic:label-gate"] };
  return { ...base, contentSha256: catalogSha256(productLabelContentForHash(base)) };
}
function offer(key: string, suffix = "a", productKey = key): CommercialOfferSeed {
  const base = { stableId: `off_gate_${key}_${suffix}`, version: 1, productStableId: `prd_gate_${productKey}`, destinationUrl: `https://example.invalid/${key}/${suffix}`,
    trackingMetadata: { approval: "catalog_owner_commercial_activation", approvalVersion: "1.0.0" }, declaredRestricted: false, directOrderAllowed: true };
  return { ...base, contentSha256: catalogSha256(offerContentForHash(base)) };
}
function manifest(id: string, parts: { products: CatalogProductSeed[]; labels?: CatalogProductLabelSeed[]; offers?: CommercialOfferSeed[]; version?: number }): GovernedCatalogSeedManifest {
  const base = { contractVersion: "governed-catalog-seed/1" as const, sourcePackageId: `synthetic.gate.${id}`, sourcePackageVersion: parts.version ?? 1,
    targetEnvironment: "synthetic-staging" as const, dataClassification: "reference_only" as const, containsPhi: false as const,
    products: parts.products, productLabels: parts.labels ?? [], commercialOffers: parts.offers ?? [], protocolTemplates: [], safetyRules: [], knowledgeSources: [] };
  return { ...base, manifestSha256: catalogSha256(manifestContentForHash(base)) };
}
const review = (subjectType: "affiliate_offer_version" | "product_label_version", stableId: string, version = 1) =>
  reviewGovernedCatalogVersion(admin, { subjectType, stableId, version, reviewerPersonId: reviewer, outcome: "approved", reason: "Fictional test review only.", environment: "synthetic-staging" });
async function publish(m: GovernedCatalogSeedManifest, extra: { approveAllLabels?: boolean } = {}) {
  await importGovernedCatalog(admin, m);
  await approveGovernedCatalogRelease(admin, { manifest: m, reviewerPersonId: reviewer, reason: "Fictional test review only.", environment: "synthetic-staging" });
  // The release approves only clean labels; an individual review can still approve a flagged one.
  if (extra.approveAllLabels) for (const l of m.productLabels) await review("product_label_version", l.stableId, l.version).catch(() => undefined);
  for (const o of m.commercialOffers) await review("affiliate_offer_version", o.stableId, o.version);
}
const read = (audience: "consumer" | "workforce", cursor?: string, limit = 100) =>
  createAwsGovernedCatalogReader(api, "synthetic-staging").listProducts({ limit, audience, ...(cursor ? { cursor } : {}) });
async function readAll(audience: "consumer" | "workforce", limit: number) {
  const products = [], offers = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await read(audience, cursor, limit);
    products.push(...page.products); offers.push(...page.commercial.offers);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { products, offers };
}
const fresh = () => `k${++serial}`;

beforeAll(async () => {
  pg = new PGlite({ extensions: { pgcrypto } });
  for (const migration of loadGovernedCatalogMigrations()) await pg.exec(migration.sql);
});
afterAll(async () => { await pg?.close(); });

describe("consumer offers need the exact current product's clean, approved label", () => {
  it("an unlabelled offer is reference-only for the consumer and visible with its status to the workforce", async () => {
    const k = fresh();
    await publish(manifest(k, { products: [product(k)], offers: [offer(k)] }));
    const consumer = await read("consumer"), workforce = await read("workforce");
    expect(consumer.products.find(p => p.stableId === `prd_gate_${k}`)).toMatchObject({ directOrderAllowed: false });
    expect(consumer.commercial.offers.some(o => o.productStableId === `prd_gate_${k}`)).toBe(false);
    expect(workforce.commercial.offers.some(o => o.productStableId === `prd_gate_${k}`)).toBe(true);
    expect(workforce.products.find(p => p.stableId === `prd_gate_${k}`)?.label).toBeUndefined();
  });
  it("a clean, approved label makes the single offer actionable", async () => {
    const k = fresh();
    await publish(manifest(k, { products: [product(k)], labels: [label(k, CLEAN)], offers: [offer(k)] }));
    const consumer = await read("consumer");
    expect(consumer.products.find(p => p.stableId === `prd_gate_${k}`)).toMatchObject({ directOrderAllowed: true, label: { stableId: `lbl_gate_${k}` } });
    expect(consumer.commercial.offers.filter(o => o.productStableId === `prd_gate_${k}`).map(o => o.stableId)).toEqual([`off_gate_${k}_a`]);
  });
  for (const [name, flags] of [
    ["has an open substantive conflict", { ...CLEAN, substantiveConflict: true }],
    ["was never found", { ...CLEAN, labelFound: false }],
    ["needs the physical label", { ...CLEAN, physicalLabelRequired: true }],
    ["awaits a practitioner decision", { ...CLEAN, practitionerDecisionRequired: true }],
  ] as const) {
    it(`a label that ${name} cannot be approved, and its offer is not actionable`, async () => {
      const k = fresh();
      const m = manifest(k, { products: [product(k)], labels: [label(k, flags)], offers: [offer(k)] });
      await publish(m);
      await expect(review("product_label_version", m.productLabels[0]!.stableId)).rejects.toThrow();
      const consumer = await read("consumer"), workforce = await read("workforce");
      expect(consumer.commercial.offers.some(o => o.productStableId === `prd_gate_${k}`)).toBe(false);
      expect(consumer.products.find(p => p.stableId === `prd_gate_${k}`)?.directOrderAllowed).toBe(false);
      // The workforce still sees the product and its destination with no approved label: its true status.
      expect(workforce.products.find(p => p.stableId === `prd_gate_${k}`)?.label).toBeUndefined();
      expect(workforce.commercial.offers.some(o => o.productStableId === `prd_gate_${k}`)).toBe(true);
    });
  }
  it("a product with two active destinations is ambiguous: the consumer gets neither", async () => {
    const k = fresh();
    await publish(manifest(k, { products: [product(k)], labels: [label(k, CLEAN)], offers: [offer(k, "a"), offer(k, "b")] }));
    const consumer = await read("consumer"), workforce = await read("workforce");
    expect(consumer.commercial.offers.some(o => o.productStableId === `prd_gate_${k}`)).toBe(false);
    expect(consumer.products.find(p => p.stableId === `prd_gate_${k}`)?.directOrderAllowed).toBe(false);
    expect(workforce.commercial.offers.filter(o => o.productStableId === `prd_gate_${k}`)).toHaveLength(2);
  });
  it("a changed current product version is not ordered under the label approved for the old one", async () => {
    const k = fresh();
    await publish(manifest(k, { products: [product(k)], labels: [label(k, CLEAN)], offers: [offer(k)] }));
    expect((await read("consumer")).commercial.offers.some(o => o.productStableId === `prd_gate_${k}`)).toBe(true);
    // A new release changes the product's ingredients; its label is not re-reviewed.
    await publish(manifest(`${k}-v2`, { products: [product(k, 2, { ingredients: ["A different fictional ingredient"] })], version: 2 }));
    const consumer = await read("consumer");
    expect(consumer.products.find(p => p.stableId === `prd_gate_${k}`)?.version).toBe(2);
    expect(consumer.commercial.offers.some(o => o.productStableId === `prd_gate_${k}`)).toBe(false);
  });
  it("labels and offers stay with their own product across pages", async () => {
    const keys = [fresh(), fresh(), fresh(), fresh()];
    await publish(manifest(keys.join("-"), {
      products: keys.map(k => product(k)), labels: [label(keys[0]!, CLEAN), label(keys[2]!, CLEAN)], offers: keys.map(k => offer(k)),
    }));
    const paged = await readAll("consumer", 1), whole = await read("consumer");
    const mine = (ids: { productStableId: string }[]) => ids.filter(o => keys.some(k => o.productStableId === `prd_gate_${k}`)).map(o => o.productStableId).sort();
    expect(mine(paged.offers)).toEqual([`prd_gate_${keys[0]}`, `prd_gate_${keys[2]}`].sort());
    expect(mine(paged.offers)).toEqual(mine(whole.commercial.offers));
    expect(new Set(paged.products.map(p => p.stableId)).size).toBe(paged.products.length);
  });
  it("a release with a duplicate product, a second label for one product, or a dangling offer is refused before import", () => {
    const k = fresh();
    expect(() => validateGovernedCatalogManifest(manifest(k, { products: [product(k), product(k)] }))).toThrow();
    expect(() => validateGovernedCatalogManifest(manifest(k, { products: [product(k)], labels: [label(k, CLEAN), { ...label(k, CLEAN), stableId: `lbl_gate_${k}_second` }] }))).toThrow();
    expect(() => validateGovernedCatalogManifest(manifest(k, { products: [product(k)], offers: [offer(k, "a", "missing")] }))).toThrow();
  });
});
