import { describe, expect, it } from 'vitest';
import {
  catalogHold, governedCatalogProductPage, productionCatalogReferencePage, programCatalogObservation, programCatalogObservationRequest, programCatalogSelection,
} from './programCatalogObservation';
import { programProductCatalogBinding } from './programAssignments';
import type { ObservedCatalogProduct } from './programCatalogObservation';

/** The reader contract: it reads exactly the deployed governed catalog envelope and records exactly the shared binding. */
const product = { stableId: 'prd_fictional_magnesium', version: 3, displayName: 'Fictional magnesium', productType: 'supplement', accessTier: 'open',
  declaredRestricted: false, directOrderAllowed: true, clinical: { anything: true }, sourceRefs: ['src_1'], reviewStatus: 'approved',
  label: { stableId: 'lbl_1', version: 2, label: {}, crosscheck: {}, reviewStatus: 'approved' } };
const page = { contractVersion: 'governed-catalog-api/1', environment: 'synthetic-staging', dataClassification: 'reference_only', phiAllowed: false, realPatientDataAllowed: false, data: { products: [product], commercial: { offers: [] } } };

describe('the governed catalog page', () => {
  it('accepts the deployed envelope as the catalog API handler emits it, including fields the Studio ignores', () => {
    expect(governedCatalogProductPage.safeParse(page).success).toBe(true);
    expect(governedCatalogProductPage.safeParse({ ...page, data: { ...page.data, nextCursor: 'prd_fictional_magnesium' } }).success).toBe(true);
    expect(governedCatalogProductPage.safeParse({ ...page, data: { products: [{ ...product, label: undefined }] } }).success).toBe(true);
  });
  it.each([
    ['another contract', { ...page, contractVersion: 'governed-catalog-api/0' }],
    ['a reply that permits PHI', { ...page, phiAllowed: true }],
    ['a reply that permits real patient data', { ...page, realPatientDataAllowed: true }],
    ['a classification other than reference-only', { ...page, dataClassification: 'clinical' }],
    ['a target outside the two services', { ...page, environment: 'local' }],
    ['a product not approved', { ...page, data: { products: [{ ...product, reviewStatus: 'pending' }] } }],
    ['a product type nobody declared', { ...page, data: { products: [{ ...product, productType: 'nootropic' }] } }],
    ['a cursor that is not a product id', { ...page, data: { ...page.data, nextCursor: 'page-2' } }],
    ['more than one page of products', { ...page, data: { products: Array.from({ length: 101 }, (_, i) => ({ ...product, stableId: `prd_fictional_${i}` })) } }],
  ])('refuses %s', (_name, value) => {
    expect(governedCatalogProductPage.safeParse(value).success).toBe(false);
  });
});

describe('the production reference page', () => {
  const item = { productId: 'prd_fictional_magnesium', productVersion: 3, displayName: 'Fictional magnesium', brand: null,
    productType: 'supplement', accessTier: 'open', declaredRestricted: false, declaredDirectOrderAllowed: true,
    labelVersionId: '22222222-2222-4222-8222-222222222222', labelSha256: 'b'.repeat(64),
    productContentSha256: 'a'.repeat(64), sourceRefs: ['fictional-source'], importManifestSha256: 'c'.repeat(64), sourceVerified: true };
  const value = { contractVersion: 'production-catalog-reference-api/1', environment: 'production-clinical',
    dataClassification: 'reference_only', phiAllowed: false, realPatientDataAllowed: false,
    data: { contractVersion: 'production-catalog-reference/1', audience: 'workforce', products: [item], nextCursor: null } };
  it('requires the exact version UUID and source state without a commercial field', () => {
    expect(productionCatalogReferencePage.safeParse(value).success).toBe(true);
    expect(productionCatalogReferencePage.safeParse({ ...value, data: { ...value.data,
      products: [{ ...item, destinationUrl: 'https://shop.example.invalid' }] } }).success).toBe(false);
    expect(productionCatalogReferencePage.safeParse({ ...value, data: { ...value.data,
      products: [{ ...item, labelVersionId: 'lbl_1' }] } }).success).toBe(false);
    expect(productionCatalogReferencePage.safeParse({ ...value, data: { ...value.data,
      products: [{ ...item, sourceVerified: 'true' }] } }).success).toBe(false);
    expect(productionCatalogReferencePage.safeParse({ ...value, data: { ...value.data,
      products: [{ ...item, labelSha256: null }] } }).success).toBe(false);
    expect(productionCatalogReferencePage.safeParse({ ...value, data: { ...value.data,
      products: [{ ...item, sourceRefs: ['fictional-source', 'fictional-source'] }] } }).success).toBe(false);
    expect(productionCatalogReferencePage.safeParse({ ...value, data: { ...value.data,
      nextCursor: 'prd_another' } }).success).toBe(false);
  });
});

describe('the observation and the selection', () => {
  const observation = { contractVersion: 'program-catalog-observation/2', clinic: 'clinic-a', versionId: '11111111-1111-4111-8111-111111111111', target: 'synthetic-staging',
    observedAt: '2026-10-11T12:00:00.000Z', query: '', products: [{ stableId: 'prd_fictional_magnesium', version: 3, displayName: 'Fictional magnesium', productType: 'supplement', accessTier: 'open', declaredRestricted: false, directOrderAllowed: true, labelVersion: 2 } satisfies ObservedCatalogProduct], catalogSize: 1, complete: true };
  it('is strict: nothing commercial or clinical rides along', () => {
    expect(programCatalogObservation.safeParse(observation).success).toBe(true);
    expect(programCatalogObservation.safeParse({ ...observation, offers: [] }).success).toBe(false);
    expect(programCatalogObservation.safeParse({ ...observation, products: [{ ...observation.products[0], clinical: {} }] }).success).toBe(false);
    expect(programCatalogObservation.safeParse({ ...observation, products: [{ ...observation.products[0], destinationUrl: 'https://shop.example.com' }] }).success).toBe(false);
  });
  it('the request names the draft and bounds the query', () => {
    expect(programCatalogObservationRequest.parse({ versionId: observation.versionId })).toEqual({ versionId: observation.versionId, query: '' });
    expect(programCatalogObservationRequest.safeParse({ versionId: 'v1', query: '' }).success).toBe(false);
  });
  it('a selection is the shared binding, by identity', () => {
    expect(programCatalogSelection).toBe(programProductCatalogBinding);
  });
  it('a hold is a declared value', () => {
    expect(catalogHold(observation.products[0]!)).toBeNull();
    expect(catalogHold({ ...observation.products[0]!, declaredRestricted: true })).toBe('declared_restricted');
  });
  it('production observations cannot claim a numbered synthetic label or omit exact source status', () => {
    const production = { ...observation, target: 'production-clinical', products: [{ ...observation.products[0],
      labelVersion: null, labelVersionId: '22222222-2222-4222-8222-222222222222', sourceVerified: false }] };
    expect(programCatalogObservation.safeParse(production).success).toBe(true);
    expect(programCatalogObservation.safeParse({ ...production, products: [{ ...production.products[0], labelVersion: 2 }] }).success).toBe(false);
    expect(programCatalogObservation.safeParse({ ...production, products: [{ ...production.products[0], sourceVerified: undefined }] }).success).toBe(false);
    expect(catalogHold(production.products[0] as ObservedCatalogProduct, 'production-clinical')).toBe('source_unverified');
  });
});
