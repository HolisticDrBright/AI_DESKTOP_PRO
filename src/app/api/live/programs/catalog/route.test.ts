import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const session = vi.hoisted(() => vi.fn());
vi.mock('@/server/session', () => ({ getRequestSession: session }));
vi.mock('@/adapters/mode', () => ({ USE_LIVE_API: true }));
import { POST } from './route';

/**
 * The Studio's catalog route: same-origin and the workforce cookie before anything leaves the
 * process, the token exchanged server-side and never echoed, the request shape held to the
 * contract, and every upstream failure returned as the category it is.
 */
const upstream = vi.fn();
const host = 'penrnyupn3.us-east-2.awsapprunner.com';
const VERSION = '11111111-1111-4111-8111-111111111111';
const product = { stableId: 'prd_fictional_magnesium', version: 3, displayName: 'Fictional magnesium', productType: 'supplement', accessTier: 'open',
  declaredRestricted: false, directOrderAllowed: true, clinical: {}, sourceRefs: [], reviewStatus: 'approved', label: { stableId: 'lbl', version: 2, label: {}, crosscheck: {}, reviewStatus: 'approved' } };
const page = { contractVersion: 'governed-catalog-api/1', environment: 'synthetic-staging', dataClassification: 'reference_only', phiAllowed: false, realPatientDataAllowed: false, data: { products: [product], commercial: { offers: [] } } };
function req(body: unknown = { versionId: VERSION, query: 'magnes' }, headers: Record<string, string> = {}) {
  return new Request('http://0.0.0.0:3000/api/live/programs/catalog', { method: 'POST', headers: { host, origin: 'https://' + host, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('fetch', upstream);
  vi.stubEnv('CLINICAL_AWS_WORKFORCE_API_ORIGIN', 'https://abcdefghij.execute-api.us-east-2.amazonaws.com');
  vi.stubEnv('CLINICAL_AWS_RUNTIME_MODE', 'synthetic');
  vi.stubEnv('PHI_ALLOWED', 'false');
  session.mockResolvedValue({ token: 'fictional-workforce-token', orgId: 'clinic-a' });
  upstream.mockResolvedValue(Response.json(page));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('exchanges the cookie session for the workforce token, binds the reply to the session clinic and the named draft, and echoes no token', async () => {
  const response = await POST(req());
  expect(response.status).toBe(200);
  expect(upstream).toHaveBeenCalledOnce();
  const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('https://abcdefghij.execute-api.us-east-2.amazonaws.com/clinical-core/workforce/catalog/products?limit=100');
  expect((init.headers as Record<string, string>).authorization).toBe('Bearer fictional-workforce-token');
  expect(init.method).toBe('GET');
  const body = await response.json() as { data: Record<string, unknown> };
  expect(body.data).toMatchObject({ contractVersion: 'program-catalog-observation/2', clinic: 'clinic-a', versionId: VERSION, target: 'synthetic-staging', query: 'magnes', catalogSize: 1, complete: true });
  expect(JSON.stringify(body)).not.toContain('fictional-workforce-token');
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it('production reads only the exact-label reference contract and does not fall back to the synthetic product path', async () => {
  vi.stubEnv('CLINICAL_AWS_RUNTIME_MODE', 'production');
  upstream.mockResolvedValue(Response.json({
    contractVersion: 'production-catalog-reference-api/1', environment: 'production-clinical',
    dataClassification: 'reference_only', phiAllowed: false, realPatientDataAllowed: false,
    data: { contractVersion: 'production-catalog-reference/1', audience: 'workforce', nextCursor: null,
      products: [{ productId: 'prd_fictional_magnesium', productVersion: 3, displayName: 'Fictional magnesium', brand: null,
        productType: 'supplement', accessTier: 'open', declaredRestricted: false, declaredDirectOrderAllowed: true,
        labelVersionId: '22222222-2222-4222-8222-222222222222', labelSha256: 'b'.repeat(64),
        productContentSha256: 'a'.repeat(64), sourceRefs: ['fictional-source'], importManifestSha256: 'c'.repeat(64),
        sourceVerified: true }] },
  }));
  const response = await POST(req());
  expect(response.status).toBe(200);
  expect(upstream.mock.calls[0]![0]).toBe('https://abcdefghij.execute-api.us-east-2.amazonaws.com/clinical-core/workforce/catalog/reference?limit=100');
  expect(await response.json()).toMatchObject({ data: { contractVersion: 'program-catalog-observation/2',
    target: 'production-clinical', products: [{ labelVersion: null, sourceVerified: true }] } });
});
it.each<Record<string, string>>([
  { origin: 'https://evil.example' }, { origin: '' }, { host: '' }, { origin: 'http://' + host }, { 'sec-fetch-site': 'cross-site' },
])('refuses unsafe origins before touching credentials: %o', async headers => {
  expect((await POST(req(undefined, headers))).status).toBe(403);
  expect(session).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
});
it.each([
  ['no token', { token: null, orgId: 'clinic-a' }],
  ['no clinic', { token: 'fictional-workforce-token', orgId: null }],
])('requires the authenticated workforce cookie and its clinic: %s', async (_name, value) => {
  session.mockResolvedValue(value);
  expect((await POST(req())).status).toBe(401); expect(upstream).not.toHaveBeenCalled();
});
it.each([
  ['a missing draft version', { query: 'x' }],
  ['a draft version that is not a uuid', { versionId: 'draft-1', query: 'x' }],
  ['an over-long query', { versionId: VERSION, query: 'x'.repeat(121) }],
  ['an unexpected field', { versionId: VERSION, query: 'x', limit: 5 }],
  ['malformed JSON', '{'],
])('refuses a request outside the contract without calling upstream: %s', async (_name, body) => {
  expect((await POST(req(body))).status).toBe(400); expect(upstream).not.toHaveBeenCalled();
});
it('refuses to call anything but the configured workforce API origin', async () => {
  vi.stubEnv('CLINICAL_AWS_WORKFORCE_API_ORIGIN', 'https://evil.example');
  const response = await POST(req());
  expect(response.status).toBe(503); expect(upstream).not.toHaveBeenCalled();
  expect(await response.json()).toEqual({ error: { code: 'unavailable', message: 'service_unavailable' } });
});
it.each([
  ['an expired upstream session', () => Response.json({ error: 'identity_refused' }, { status: 401 }), 401, 'unauthenticated', 'reauth_required'],
  ['a refused upstream identity', () => Response.json({ error: 'identity_refused' }, { status: 403 }), 403, 'forbidden', 'identity_refused'],
  ['an upstream outage', () => Response.json({ error: 'service_unavailable' }, { status: 503 }), 503, 'unavailable', 'service_unavailable'],
  ['a network failure', () => { throw new Error('ECONNRESET'); }, 503, 'unavailable', 'service_unavailable'],
  ['an unverifiable reply', () => Response.json({ ...page, phiAllowed: true }), 503, 'unavailable', 'catalog_unverifiable'],
])('%s is returned as its own category, never as an empty catalog', async (_name, reply, status, code, message) => {
  upstream.mockImplementation(async () => reply());
  const response = await POST(req());
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: { code, message } });
});
