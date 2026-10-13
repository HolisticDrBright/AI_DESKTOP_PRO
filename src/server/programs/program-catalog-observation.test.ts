import { describe, expect, it, vi } from 'vitest';
import {
  CatalogObservationError, normaliseCatalogQuery, observeProgramCatalog, productMatchesQuery, workforceApiOrigin,
} from './program-catalog-observation';

/**
 * The Studio's read of the governed catalog API, with the upstream stubbed: every page is checked
 * against the published envelope, the target must hold across pages, narrowing is a plain match,
 * and each way the catalog cannot be observed is its own category. Nothing commercial or clinical
 * reaches the reply.
 */
const ORIGIN = 'https://abcdefghij.execute-api.us-east-2.amazonaws.com';
const VERSION = '11111111-1111-4111-8111-111111111111';
const page = (products: unknown[], over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
  contractVersion: 'governed-catalog-api/1', environment: 'synthetic-staging', dataClassification: 'reference_only',
  phiAllowed: false, realPatientDataAllowed: false,
  data: { products, commercial: { offers: [{ stableId: 'off_fictional', version: 1, productStableId: 'prd_fictional_magnesium', destinationUrl: 'https://shop.example.com/x', trackingMetadata: {}, reviewStatus: 'approved' }] }, ...data },
  ...over,
});
const product = (stableId: string, over: Record<string, unknown> = {}) => ({
  stableId, version: 3, displayName: `Fictional ${stableId.slice(4).replace(/_/g, ' ')}`, productType: 'supplement', accessTier: 'open',
  declaredRestricted: false, directOrderAllowed: true, clinical: { secret: 'must not leave' }, sourceRefs: ['src_1'], reviewStatus: 'approved',
  label: { stableId: 'lbl_fictional', version: 2, label: { dose: 'as labelled' }, crosscheck: {}, reviewStatus: 'approved' }, ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const read = (fetchImpl: typeof fetch, query = '', maxPages?: number) =>
  observeProgramCatalog({ token: 'fictional-workforce-token', clinic: 'clinic-a', versionId: VERSION, query, origin: ORIGIN, fetchImpl, now: () => new Date('2026-10-11T12:00:00Z'), maxPages });
const failure = async (fetchImpl: typeof fetch, query = '', maxPages?: number) => {
  try { await read(fetchImpl, query, maxPages); } catch (error) { return error instanceof CatalogObservationError ? error.category : 'other'; }
  return 'none';
};

describe('observing the governed catalog', () => {
  it('presents the workforce token, follows the cursor, requires one target and returns identity and declared facts only', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(page([product('prd_fictional_magnesium')], {}, { nextCursor: 'prd_fictional_magnesium' })))
      .mockResolvedValueOnce(json(page([product('prd_fictional_zinc', { label: undefined, declaredRestricted: true })])));
    const result = await read(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(firstUrl).toBe(ORIGIN + '/clinical-core/workforce/catalog/products?limit=100');
    expect((firstInit.headers as Record<string, string>).authorization).toBe('Bearer fictional-workforce-token');
    expect(fetchImpl.mock.calls[1]![0]).toBe(ORIGIN + '/clinical-core/workforce/catalog/products?limit=100&cursor=prd_fictional_magnesium');
    expect(result).toEqual({
      contractVersion: 'program-catalog-observation/1', clinic: 'clinic-a', versionId: VERSION, target: 'synthetic-staging',
      observedAt: '2026-10-11T12:00:00.000Z', query: '', catalogSize: 2, complete: true,
      products: [
        { stableId: 'prd_fictional_magnesium', version: 3, displayName: 'Fictional fictional magnesium', productType: 'supplement', accessTier: 'open', declaredRestricted: false, directOrderAllowed: true, labelVersion: 2 },
        { stableId: 'prd_fictional_zinc', version: 3, displayName: 'Fictional fictional zinc', productType: 'supplement', accessTier: 'open', declaredRestricted: true, directOrderAllowed: true, labelVersion: null },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/shop\.example\.com|must not leave|off_fictional/);
  });
  it('narrows by a plain substring on the name or the stable id, and an empty match is a result with the catalog size', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json(page([product('prd_fictional_magnesium'), product('prd_fictional_zinc')])));
    expect((await read(fetchImpl, '  MAGNES ')).products.map(p => p.stableId)).toEqual(['prd_fictional_magnesium']);
    expect((await read(fetchImpl, 'prd_fictional_z')).products.map(p => p.stableId)).toEqual(['prd_fictional_zinc']);
    const none = await read(fetchImpl, 'selenium');
    expect(none.products).toEqual([]);
    expect(none.catalogSize).toBe(2);
    expect(none.complete).toBe(true);
    expect(normaliseCatalogQuery('  Two   Words ')).toBe('two words');
    expect(productMatchesQuery({ displayName: 'Fictional peptide', stableId: 'prd_x_y' }, '')).toBe(true);
  });
  it('reports an incomplete list when the catalog has more pages than the reader may follow', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(page([product('prd_fictional_a')], {}, { nextCursor: 'prd_fictional_a' })))
      .mockResolvedValueOnce(json(page([product('prd_fictional_b')], {}, { nextCursor: 'prd_fictional_b' })));
    const result = await read(fetchImpl, '', 2);
    expect(result.complete).toBe(false);
    expect(result.catalogSize).toBe(2);
  });
  it('retries a transient cold-start 503 once for a read-only page, then accepts the exact reviewed response', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: 'catalog_unavailable' }, 503))
      .mockResolvedValueOnce(json(page([product('prd_fictional_magnesium')])));
    const result = await read(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]![0]).toBe(fetchImpl.mock.calls[1]![0]);
    expect(result.products.map((row) => row.stableId)).toEqual(['prd_fictional_magnesium']);
  });
  it('never retries a refused identity or an invalid catalog reply', async () => {
    for (const reply of [json({ error: 'identity_refused' }, 403), json({ bad: true })]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply);
      expect(await failure(fetchImpl)).not.toBe('none');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
  it('does not hide a persistent cold-start failure as an empty catalog', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ error: 'catalog_unavailable' }, 503));
    expect(await failure(fetchImpl)).toBe('service_unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['an expired session', () => json({ error: 'identity_refused' }, 401), 'reauth_required'],
    ['a refused identity', () => json({ error: 'identity_refused' }, 403), 'identity_refused'],
    ['a service error', () => json({ error: 'service_unavailable' }, 503), 'service_unavailable'],
    ['a network failure', () => { throw new Error('ECONNRESET'); }, 'service_unavailable'],
    ['a non-JSON reply', () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'catalog_unverifiable'],
    ['malformed JSON', () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }), 'catalog_unverifiable'],
    ['the wrong contract version', () => json(page([product('prd_fictional_a')], { contractVersion: 'governed-catalog-api/2' })), 'catalog_unverifiable'],
    ['a reply that permits PHI', () => json(page([product('prd_fictional_a')], { phiAllowed: true })), 'catalog_unverifiable'],
    ['an unknown target', () => json(page([product('prd_fictional_a')], { environment: 'production' })), 'catalog_unverifiable'],
    ['a product that is not approved', () => json(page([product('prd_fictional_a', { reviewStatus: 'draft' })])), 'catalog_unverifiable'],
    ['a product with a free-text stable id', () => json(page([product('Magnesium')])), 'catalog_unverifiable'],
    ['a product whose label is not approved', () => json(page([product('prd_fictional_a', { label: { stableId: 'lbl', version: 1, reviewStatus: 'pending' } })])), 'catalog_unverifiable'],
    ['the same stable id twice', () => json(page([product('prd_fictional_a'), product('prd_fictional_a', { version: 4 })])), 'catalog_unverifiable'],
  ])('%s is its own category and never an empty catalog', async (_name, reply, category) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => reply());
    expect(await failure(fetchImpl)).toBe(category);
  });
  it('refuses a read whose pages report different targets', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(page([product('prd_fictional_a')], {}, { nextCursor: 'prd_fictional_a' })))
      .mockResolvedValueOnce(json(page([product('prd_fictional_b')], { environment: 'production-clinical' })));
    expect(await failure(fetchImpl)).toBe('catalog_target_changed');
  });
  it('refuses a cursor that repeats, rather than looping', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(page([product('prd_fictional_a')], {}, { nextCursor: 'prd_fictional_a' })))
      .mockResolvedValueOnce(json(page([product('prd_fictional_b')], {}, { nextCursor: 'prd_fictional_a' })));
    expect(await failure(fetchImpl)).toBe('catalog_unverifiable');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('an empty catalog is a complete observation of nothing, not a failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json(page([])));
    const result = await read(fetchImpl);
    expect(result).toMatchObject({ products: [], catalogSize: 0, complete: true, target: 'synthetic-staging' });
  });
});

describe('the workforce API origin', () => {
  it.each([
    ['https://abcdefghij.execute-api.us-east-2.amazonaws.com', ORIGIN],
    ['https://abcdefghij.execute-api.us-east-2.amazonaws.com/', ORIGIN],
    ['http://abcdefghij.execute-api.us-east-2.amazonaws.com', null],
    ['https://abcdefghij.execute-api.us-east-2.amazonaws.com/path', null],
    ['https://user:pw@abcdefghij.execute-api.us-east-2.amazonaws.com', null],
    ['https://abcdefghij.execute-api.us-east-2.amazonaws.com:8443', null],
    ['https://evil.example', null],
    ['', null],
    [undefined, null],
  ])('%s -> %s', (value, expected) => {
    expect(workforceApiOrigin(value)).toBe(expected);
  });
});
