import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import type { ClinicalCoreDatabase } from '../clinical-core/database';
import { loadGovernedCatalogMigrations } from '../clinical-core/catalog-migrations';
import {
  catalogSha256, importGovernedCatalog, manifestContentForHash, offerContentForHash, productContentForHash, productLabelContentForHash,
  type CatalogProductLabelSeed, type CatalogProductSeed, type CommercialOfferSeed, type GovernedCatalogSeedManifest,
} from '../clinical-core/aws-governed-catalog';
import { createAwsGovernedCatalogReader } from '../clinical-core/aws-governed-catalog-reader';
import { approveGovernedCatalogRelease, reviewGovernedCatalogVersion } from '../clinical-core/aws-governed-catalog-review';
import type { ProductActionBinding } from '@/contracts/fullscriptConsumerAction';
import {
  consumerCatalogFromReader, createConsumerPurchaseCandidate,
  type AdmissionRecord, type ConsumerPurchasePorts, type ConsumerSession, type ProductActionRecord,
} from './consumer-product-action';

/**
 * The disabled purchase candidate over the REAL catalog SQL (embedded engine, reduced API role), read
 * through the consumer audience. What the reader withholds from consumers, the candidate cannot issue: a
 * restricted product, an unlabelled one, one with two destinations, a version that is no longer current,
 * and a generic dispensary page. Fictional products, dispensary and accounts; not hosted acceptance.
 */
let pg: PGlite;
let serial = 0;
const reviewer = '90000000-0000-4000-8000-000000000002';
const CLINIC = '30000000-0000-4000-8000-000000000001';
const SLUG = 'fictional-db-dispensary';
const unwrap = (p: unknown) => p && typeof p === 'object' && 'kind' in p && p.kind === 'uuid' && 'value' in p ? p.value : p;
const driver = (role?: 'clinical_core_api'): ClinicalCoreDatabase => ({
  transaction: work => pg.transaction(async tx => {
    if (role) await tx.exec('set local role clinical_core_api');
    return work({ query: (sql, parameters = []) => tx.query(sql, parameters.map(unwrap)) });
  }),
});
const admin = driver();
const CLEAN = { labelFound: true, physicalLabelRequired: false, substantiveConflict: false, practitionerDecisionRequired: false };
function product(key: string, version = 1, patch: Partial<CatalogProductSeed> = {}): CatalogProductSeed {
  const base = { stableId: `prd_action_${key}`, version, displayName: `Fictional action product ${key}`, productType: 'supplement' as const,
    accessTier: 'open' as const, declaredRestricted: false, directOrderAllowed: true, clinicalPayload: { ingredients: [`Fictional ingredient ${version}`] },
    sourceRefs: ['synthetic:consumer-action'], ...patch };
  return { ...base, contentSha256: catalogSha256(productContentForHash(base)) };
}
function label(key: string, version = 1): CatalogProductLabelSeed {
  const base = { stableId: `lbl_action_${key}`, version, productStableId: `prd_action_${key}`, ...CLEAN,
    labelPayload: { servingSize: `${version} fictional capsule` }, crosscheckPayload: {}, sourceRefs: ['synthetic:consumer-action'] };
  return { ...base, contentSha256: catalogSha256(productLabelContentForHash(base)) };
}
const page = (key: string, suffix: string) => `https://us.fullscript.com/s/${SLUG}/shop/product/${Buffer.from(`${key}-${suffix}`).toString('base64url')}`;
function offer(key: string, suffix = 'a', destinationUrl = page(key, suffix), patch: Partial<CommercialOfferSeed> = {}): CommercialOfferSeed {
  const base = { stableId: `off_action_${key}_${suffix}`, version: 1, productStableId: `prd_action_${key}`, destinationUrl,
    trackingMetadata: { approval: 'catalog_owner_commercial_activation', approvalVersion: '1.0.0' }, declaredRestricted: false, directOrderAllowed: true, ...patch };
  return { ...base, contentSha256: catalogSha256(offerContentForHash(base)) };
}
function manifest(id: string, parts: { products: CatalogProductSeed[]; labels?: CatalogProductLabelSeed[]; offers?: CommercialOfferSeed[]; version?: number }): GovernedCatalogSeedManifest {
  const base = { contractVersion: 'governed-catalog-seed/1' as const, sourcePackageId: `synthetic.action.${id}`, sourcePackageVersion: parts.version ?? 1,
    targetEnvironment: 'synthetic-staging' as const, dataClassification: 'reference_only' as const, containsPhi: false as const,
    products: parts.products, productLabels: parts.labels ?? [], commercialOffers: parts.offers ?? [], protocolTemplates: [], safetyRules: [], knowledgeSources: [] };
  return { ...base, manifestSha256: catalogSha256(manifestContentForHash(base)) };
}
async function publish(m: GovernedCatalogSeedManifest, options: { offerReviewMayRefuse?: boolean } = {}) {
  await importGovernedCatalog(admin, m);
  await approveGovernedCatalogRelease(admin, { manifest: m, reviewerPersonId: reviewer, reason: 'Fictional test review only.', environment: 'synthetic-staging' });
  for (const o of m.commercialOffers) {
    const review = reviewGovernedCatalogVersion(admin, { subjectType: 'affiliate_offer_version', stableId: o.stableId, version: o.version,
      reviewerPersonId: reviewer, outcome: 'approved', reason: 'Fictional test review only.', environment: 'synthetic-staging' });
    // The catalog's own review refuses to activate a restricted product's offer; that refusal is not under test here.
    await (options.offerReviewMayRefuse ? review.catch(() => undefined) : review);
  }
}
const bindingFor = (key: string, versions: Partial<Record<'product' | 'label' | 'offer', number>> = {}, suffix = 'a'): ProductActionBinding => ({
  productStableId: `prd_action_${key}`, productVersion: versions.product ?? 1, labelStableId: `lbl_action_${key}`, labelVersion: versions.label ?? 1,
  offerStableId: `off_action_${key}_${suffix}`, offerVersion: versions.offer ?? 1 });

function candidate() {
  const admissions = new Map<string, AdmissionRecord>(), actions = new Map<string, ProductActionRecord>(), used = new Set<string>();
  const ports: ConsumerPurchasePorts = {
    catalog: consumerCatalogFromReader(createAwsGovernedCatalogReader(driver('clinical_core_api'), 'synthetic-staging')),
    patientLinks: { forAccount: async () => [] },
    practitionerAuthority: { verifiedJurisdictions: async org => org === CLINIC ? ['US-TX'] : [] },
    admissions: { current: async a => admissions.get(a) ?? null, record: async r => { admissions.set(r.accountId, r); } },
    actions: {
      insertIfNew: async r => { if (used.has(r.requestId)) return false; used.add(r.requestId); actions.set(r.actionId, { ...r }); return true; },
      get: async id => actions.get(id) ?? null,
      spend: async (id, at) => { const r = actions.get(id); if (!r || r.redeemedAt) return false; r.redeemedAt = at; return true; },
    },
    clock: { now: () => new Date('2026-10-13T12:00:00Z') },
  };
  const issuer = createConsumerPurchaseCandidate(ports, 'synthetic-staging', [{ contract: 'consumer-purchase-release/1', environment: 'synthetic-staging',
    tier: 'consumer', jurisdictions: ['US-TX'], provider: { name: 'fullscript', dispensarySlug: SLUG, organizationId: CLINIC },
    disclosure: 'FICTIONAL disclosure for tests only.', effectiveFrom: '2026-01-01T00:00:00Z' }]);
  const session: ConsumerSession = { accountId: 'fictional-account', sessionId: 'fictional-session', authenticatedAt: '2026-10-13T11:59:00Z', revoked: false };
  return { issuer, session };
}
async function attempt(binding: ProductActionBinding) {
  const { issuer, session } = candidate();
  await issuer.declare(session, { contract: 'purchase-admission/1', jurisdiction: 'US-TX', practitioner: { relationship: 'none' } });
  const issued = await issuer.issue(session, { contract: 'fullscript-consumer-action/2', kind: 'product_patient_action', purpose: 'supplement_purchase',
    requestId: `60000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`, binding });
  if (!issued.ok) return issued;
  return issuer.redeem(session, { contract: 'fullscript-consumer-action/2', actionId: issued.issued.data.actionId });
}

beforeAll(async () => {
  pg = new PGlite({ extensions: { pgcrypto } });
  for (const migration of loadGovernedCatalogMigrations()) await pg.exec(migration.sql);
});
afterAll(async () => { await pg?.close(); });

describe('the purchase candidate issues only what the consumer catalog SQL makes orderable', () => {
  it('issues and redeems the current product, label and single offer', async () => {
    await publish(manifest('ok', { products: [product('ok')], labels: [label('ok')], offers: [offer('ok')] }));
    expect(await attempt(bindingFor('ok'))).toMatchObject({ ok: true, redeemed: { data: { destinationUrl: page('ok', 'a') } } });
  });
  it('refuses a product version that is no longer current, and issues the new one once relabelled', async () => {
    await publish(manifest('chg', { products: [product('chg')], labels: [label('chg')], offers: [offer('chg')] }));
    await publish(manifest('chg-v2', { products: [product('chg', 2)], version: 2 }));
    expect(await attempt(bindingFor('chg'))).toEqual({ ok: false, refused: 'product_changed' });
    // The changed product has no label in its own release yet: nothing is orderable for it.
    expect(await attempt(bindingFor('chg', { product: 2 }))).toMatchObject({ ok: false });
    await publish(manifest('chg-v3', { products: [product('chg', 3)], labels: [label('chg', 3)], offers: [offer('chg', 'a', page('chg', 'a'), { version: 3 })], version: 3 }));
    expect(await attempt(bindingFor('chg', { product: 3 }))).toEqual({ ok: false, refused: 'label_changed' });
    expect(await attempt(bindingFor('chg', { product: 3, label: 3 }))).toEqual({ ok: false, refused: 'offer_changed' });
    expect(await attempt(bindingFor('chg', { product: 3, label: 3, offer: 3 }))).toMatchObject({ ok: true });
  });
  it('refuses an unlabelled product', async () => {
    await publish(manifest('nolabel', { products: [product('nolabel')], offers: [offer('nolabel')] }));
    expect(await attempt(bindingFor('nolabel'))).toEqual({ ok: false, refused: 'label_missing' });
  });
  it('refuses a product with two destinations', async () => {
    await publish(manifest('two', { products: [product('two')], labels: [label('two')], offers: [offer('two', 'a'), offer('two', 'b')] }));
    expect(await attempt(bindingFor('two'))).toEqual({ ok: false, refused: 'offer_unavailable' });
  });
  it.each([
    ['declared restricted', { declaredRestricted: true, accessTier: 'practitioner_gated' as const, directOrderAllowed: false }],
    ['practitioner gated', { declaredRestricted: false, accessTier: 'practitioner_gated' as const, directOrderAllowed: false }],
    ['an injectable peptide', { productType: 'injectable_peptide' as const, accessTier: 'injectable' as const, declaredRestricted: true, directOrderAllowed: false }],
  ])('refuses a product that is %s: the consumer catalog never returns it', async (_name, patch) => {
    const key = `restricted${++serial}`;
    const restrictedOffer = offer(key, 'a', page(key, 'a'), { declaredRestricted: patch.declaredRestricted, directOrderAllowed: false });
    await publish(manifest(key, { products: [product(key, 1, patch)], labels: [label(key)], offers: [restrictedOffer] }), { offerReviewMayRefuse: true });
    expect(await attempt(bindingFor(key))).toEqual({ ok: false, refused: 'product_unavailable' });
  });
  it("refuses a generic dispensary page and another dispensary's product page", async () => {
    await publish(manifest('welcome', { products: [product('welcome')], labels: [label('welcome')], offers: [offer('welcome', 'a', `https://us.fullscript.com/welcome/${SLUG}/signup`)] }));
    expect(await attempt(bindingFor('welcome'))).toEqual({ ok: false, refused: 'destination_unverified' });
    await publish(manifest('other', { products: [product('other')], labels: [label('other')], offers: [offer('other', 'a', page('other', 'a').replace(SLUG, 'someone-else'))] }));
    expect(await attempt(bindingFor('other'))).toEqual({ ok: false, refused: 'destination_unverified' });
  });
});
