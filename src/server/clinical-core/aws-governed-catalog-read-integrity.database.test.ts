import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { ClinicalCoreDatabase } from "./database";
import { loadGovernedCatalogMigrations, loadHistoricalGovernedCatalogMigrations } from "./catalog-migrations";
import {
  catalogSha256, importGovernedCatalog, manifestContentForHash, offerContentForHash,
  productContentForHash, templateContentForHash, type CatalogProductSeed, type GovernedCatalogSeedManifest,
} from "./aws-governed-catalog";
import { createAwsGovernedCatalogReader } from "./aws-governed-catalog-reader";
import { approveGovernedCatalogRelease, reviewGovernedCatalogVersion } from "./aws-governed-catalog-review";

let pg: PGlite;
let serial = 0;
const reviewer = "90000000-0000-4000-8000-000000000001";
const unwrap = (p: unknown) => p && typeof p === "object" && "kind" in p && p.kind === "uuid" && "value" in p ? p.value : p;
const driver = (role?: "clinical_core_api", target = () => pg): ClinicalCoreDatabase => ({
  transaction: work => target().transaction(async tx => {
    if (role) await tx.exec("set local role clinical_core_api");
    return work({ query: (sql, parameters = []) => tx.query(sql, parameters.map(unwrap)) });
  }),
});
const admin = driver();
const api = driver("clinical_core_api");

function release(key: string, version = 1, overrides: Partial<CatalogProductSeed> = {},
  environment: "synthetic-staging" | "production-clinical" = "synthetic-staging"): GovernedCatalogSeedManifest {
  const productBase = {
    stableId: `prd_integrity_${key}`, version, displayName: "Fictional reference product",
    productType: "supplement" as const, accessTier: "open" as const,
    declaredRestricted: false, directOrderAllowed: true,
    clinicalPayload: { ingredients: ["Fictional ingredient"] }, sourceRefs: ["synthetic:catalog-integrity"],
    ...overrides,
  };
  const product = { ...productBase, contentSha256: catalogSha256(productContentForHash(productBase)) };
  const offerBase = {
    stableId: `off_integrity_${key}`, version: 1, productStableId: product.stableId,
    destinationUrl: `https://example.invalid/${key}?ref=fictional`,
    trackingMetadata: { approval: "catalog_owner_commercial_activation", approvalVersion: "1.0.0" },
    declaredRestricted: false, directOrderAllowed: true,
  };
  const base = {
    contractVersion: "governed-catalog-seed/1" as const, sourcePackageId: `synthetic.integrity.${key}`,
    sourcePackageVersion: version, targetEnvironment: environment, dataClassification: "reference_only" as const,
    containsPhi: false as const, products: [product], productLabels: [],
    commercialOffers: version === 1 ? [{ ...offerBase, contentSha256: catalogSha256(offerContentForHash(offerBase)) }] : [],
    protocolTemplates: [], safetyRules: [], knowledgeSources: [],
  };
  return { ...base, manifestSha256: catalogSha256(manifestContentForHash(base)) };
}
async function approve(manifest: GovernedCatalogSeedManifest) {
  await importGovernedCatalog(admin, manifest);
  await approveGovernedCatalogRelease(admin, {
    manifest, reviewerPersonId: reviewer, reason: "Fictional test review only.", environment: manifest.targetEnvironment,
  });
}
async function fixture() {
  const key = `case_${++serial}`;
  const manifest = release(key);
  await approve(manifest);
  await reviewGovernedCatalogVersion(admin, {
    subjectType: "affiliate_offer_version", stableId: manifest.commercialOffers[0]!.stableId, version: 1,
    reviewerPersonId: reviewer, outcome: "approved", reason: "Fictional test destination only.", environment: "synthetic-staging",
  });
  return { key, manifest, productId: manifest.products[0]!.stableId, offerId: manifest.commercialOffers[0]!.stableId };
}
async function page(database = api, environment: "synthetic-staging" | "production-clinical" = "synthetic-staging") {
  return createAwsGovernedCatalogReader(database, environment).listProducts({ limit: 100 });
}
async function rawOffers() {
  return api.transaction(async tx => {
    await tx.query("select set_config('clinical.catalog.environment', 'synthetic-staging', true)");
    return (await tx.query<{ offer_stable_id: string }>("select offer_stable_id from commercial_reference.affiliate_offer_versions")).rows;
  });
}

beforeAll(async () => {
  pg = new PGlite({ extensions: { pgcrypto } });
  for (const migration of loadGovernedCatalogMigrations()) await pg.exec(migration.sql);
});
afterAll(async () => { await pg?.close(); });

describe("real catalog SQL, review transitions and API-role RLS (local, not hosted acceptance)", () => {
  it("imports remain inert and clinical approval does not approve a destination", async () => {
    const manifest = release(`case_${++serial}`);
    await importGovernedCatalog(admin, manifest);
    expect((await page()).products.some(p => p.stableId === manifest.products[0]!.stableId)).toBe(false);
    await approve(manifest);
    const result = await page();
    expect(result.products.find(p => p.stableId === manifest.products[0]!.stableId)).toBeDefined();
    expect(result.commercial.offers.some(o => o.productStableId === manifest.products[0]!.stableId)).toBe(false);
  });

  it("preserves the exact separately approved eligible destination without inventing a label requirement", async () => {
    const f = await fixture();
    const result = await page();
    expect(result.products.find(p => p.stableId === f.productId)?.label).toBeUndefined();
    expect(result.commercial.offers.find(o => o.stableId === f.offerId)).toMatchObject({
      destinationUrl: f.manifest.commercialOffers[0]!.destinationUrl, trackingMetadata: f.manifest.commercialOffers[0]!.trackingMetadata,
    });
  });

  for (const [name, overrides] of [
    ["restricted", { accessTier: "practitioner_gated", declaredRestricted: true, directOrderAllowed: false }],
    ["direct order withdrawn", { directOrderAllowed: false }],
    ["practitioner gated", { accessTier: "practitioner_gated", directOrderAllowed: false }],
    ["oral peptide", { productType: "oral_peptide", directOrderAllowed: true }],
  ] as const) {
    it(`withholds an old offer when the current product becomes ${name}, including raw RLS reads`, async () => {
      const f = await fixture();
      await approve(release(f.key, 2, overrides));
      const result = await page();
      expect(result.products.find(p => p.stableId === f.productId)?.version).toBe(2);
      expect(result.commercial.offers.some(o => o.stableId === f.offerId)).toBe(false);
      expect((await rawOffers()).some(o => o.offer_stable_id === f.offerId)).toBe(false);
    });
  }

  for (const subjectType of ["product_version", "affiliate_offer_version"] as const) {
    for (const outcome of ["rejected", "changes_requested"] as const) {
      it(`a ${outcome} review actually withdraws the active ${subjectType}`, async () => {
        const f = await fixture();
        await reviewGovernedCatalogVersion(admin, {
          subjectType, stableId: subjectType === "product_version" ? f.productId : f.offerId,
          version: 1, reviewerPersonId: reviewer, outcome, reason: "Fictional withdrawal test.", environment: "synthetic-staging",
        });
        const result = await page();
        expect(result.commercial.offers.some(o => o.stableId === f.offerId)).toBe(false);
        if (subjectType === "product_version") expect(result.products.some(p => p.stableId === f.productId)).toBe(false);
        expect((await rawOffers()).some(o => o.offer_stable_id === f.offerId)).toBe(false);
        const events = await pg.query<{ outcome: string }>(
          "select outcome from clinical_reference.catalog_review_events where subject_stable_id=$1 order by reviewed_at desc",
          [subjectType === "product_version" ? f.productId : f.offerId]);
        expect(events.rows[0]!.outcome).toBe(outcome);
      });
    }
  }

  it("rejecting an inactive successor preserves the last approved version and immutable history", async () => {
    const f = await fixture();
    await importGovernedCatalog(admin, release(f.key, 2, { displayName: "Fictional unapproved successor" }));
    await reviewGovernedCatalogVersion(admin, {
      subjectType: "product_version", stableId: f.productId, version: 2,
      reviewerPersonId: reviewer, outcome: "rejected", reason: "Fictional successor review.", environment: "synthetic-staging",
    });
    expect((await page()).products.find(p => p.stableId === f.productId)?.version).toBe(1);
    expect((await page()).commercial.offers.some(o => o.stableId === f.offerId)).toBe(true);
    expect((await pg.query("select version from clinical_reference.catalog_product_versions where product_stable_id=$1", [f.productId])).rows).toHaveLength(2);
  });

  for (const overrides of [
    { accessTier: "practitioner_gated" as const, declaredRestricted: true, directOrderAllowed: false },
    { directOrderAllowed: false },
    { productType: "oral_peptide" as const },
  ]) {
    it(`cannot reapprove a destination for a current ineligible product ${JSON.stringify(overrides)}`, async () => {
      const f = await fixture();
      await approve(release(f.key, 2, overrides));
      const count = (await pg.query<{ n: number }>("select count(*)::integer n from clinical_reference.catalog_review_events")).rows[0]!.n;
      await expect(reviewGovernedCatalogVersion(admin, {
        subjectType: "affiliate_offer_version", stableId: f.offerId, version: 1,
        reviewerPersonId: reviewer, outcome: "approved", reason: "Fictional refused reapproval.", environment: "synthetic-staging",
      })).rejects.toMatchObject({ category: "review_precondition_failed" });
      expect((await pg.query<{ n: number }>("select count(*)::integer n from clinical_reference.catalog_review_events")).rows[0]!.n).toBe(count);
    });
  }

  it("an environment must be set for raw reads and the API role cannot mutate approvals", async () => {
    expect(await api.transaction(async tx => (await tx.query("select * from clinical_reference.catalog_products")).rows)).toEqual([]);
    await expect(api.transaction(tx => tx.query("update clinical_reference.catalog_products set review_status='approved'"))).rejects.toThrow(/permission denied/i);
    await expect(api.transaction(tx => tx.query("insert into clinical_reference.catalog_review_events default values"))).rejects.toThrow(/permission denied/i);
  });

  it("binds products and offers to the requested environment even on a privileged transport", async () => {
    const key = `case_${++serial}`;
    const manifest = release(key, 1, {}, "production-clinical");
    await approve(manifest);
    await reviewGovernedCatalogVersion(admin, {
      subjectType: "affiliate_offer_version", stableId: manifest.commercialOffers[0]!.stableId, version: 1,
      reviewerPersonId: reviewer, outcome: "approved", reason: "Fictional environment test.", environment: "production-clinical",
    });
    expect((await page()).products.some(p => p.stableId === manifest.products[0]!.stableId)).toBe(false);
    expect((await page(admin)).products.some(p => p.stableId === manifest.products[0]!.stableId)).toBe(false);
    expect((await page(api, "production-clinical")).products.map(p => p.stableId)).toEqual([manifest.products[0]!.stableId]);
  });

  it("the reader repair also withholds an obsolete destination on the unchanged registered two-migration schema", async () => {
    const legacy = new PGlite({ extensions: { pgcrypto } });
    try {
      for (const migration of loadHistoricalGovernedCatalogMigrations()) await legacy.exec(migration.sql);
      const legacyAdmin = driver(undefined, () => legacy);
      const legacyApi = driver("clinical_core_api", () => legacy);
      const key = `case_${++serial}`;
      const manifest = release(key);
      for (const version of [manifest, release(key, 2, { declaredRestricted: true, directOrderAllowed: false, accessTier: "practitioner_gated" })]) {
        await importGovernedCatalog(legacyAdmin, version);
        await approveGovernedCatalogRelease(legacyAdmin, { manifest: version, reviewerPersonId: reviewer,
          reason: "Fictional compatibility review.", environment: "synthetic-staging" });
        if (version.sourcePackageVersion === 1) {
          await reviewGovernedCatalogVersion(legacyAdmin, { subjectType: "affiliate_offer_version",
            stableId: manifest.commercialOffers[0]!.stableId, version: 1, reviewerPersonId: reviewer,
            outcome: "approved", reason: "Fictional destination review.", environment: "synthetic-staging" });
          expect((await page(legacyApi)).commercial.offers).toHaveLength(1);
        }
      }
      expect((await page(legacyApi)).commercial.offers).toEqual([]);
      // Explicitly document why API repair is NOT proof of the candidate RLS
      // rollout: the historical raw policy still exposes the obsolete offer.
      expect(await legacyApi.transaction(async tx => {
        await tx.query("select set_config('clinical.catalog.environment', 'synthetic-staging', true)");
        return (await tx.query("select offer_stable_id from commercial_reference.affiliate_offer_versions")).rows;
      })).toHaveLength(1);
    } finally { await legacy.close(); }
  });

  it("a privileged template read returns only the current version's steps", async () => {
    const key = `case_${++serial}`;
    for (const version of [1, 2]) {
      const templateBase = {
        stableId: `tpl_integrity_${key}`, version, title: "Fictional template", sourceRefs: ["synthetic:template"], items: [],
        steps: [{ stableId: `stp_integrity_${key}_${version}`, sequence: 1, phase: "Fictional phase",
          instructions: `Fictional version ${version}.`, prerequisites: "Fictional prerequisite", monitoring: "Fictional monitoring",
          stopCriteria: "Fictional stop", conditionalLogic: "Fictional condition", sourceRefs: ["synthetic:template"] }],
      };
      const base = { ...release(key, version), protocolTemplates: [{ ...templateBase,
        contentSha256: catalogSha256(templateContentForHash(templateBase)) }] };
      delete (base as Partial<GovernedCatalogSeedManifest>).manifestSha256;
      await approve({ ...base, manifestSha256: catalogSha256(manifestContentForHash(base)) });
    }
    const template = (await createAwsGovernedCatalogReader(admin, "synthetic-staging").listProtocolTemplates({ limit: 100 }))
      .protocolTemplates.find(t => t.stableId === `tpl_integrity_${key}`);
    expect(template?.version).toBe(2);
    expect(template?.steps.map(s => s.stableId)).toEqual([`stp_integrity_${key}_2`]);
  });
});
