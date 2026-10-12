import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const session = vi.hoisted(() => vi.fn());
const getStudio = vi.hoisted(() => vi.fn());
vi.mock('@/server/session', () => ({ getRequestSession: session }));
vi.mock('@/adapters/mode', () => ({ USE_LIVE_API: true }));
vi.mock('@/adapters/programs.live', () => ({ programsLive: { getStudio } }));
import { POST } from './route';
import { __resetProgramCommerceRuntime } from '@/server/commerce/program-commerce-runtime';

/**
 * The offer authoring route: same-origin and the practitioner's cookie before anything else, the
 * command held to the contract, the actor and clinic taken from the session and never the body,
 * an honest 503 when no ledger is reviewed for this process, and under the local fixture the full
 * authoring journey through the fictional ledger with every refusal returned as its category.
 */
const host = 'penrnyupn3.us-east-2.awsapprunner.com';
const PROGRAM = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';
const phases = [{ id: 'phase-1', title: 'Phase one', days: 1, transition: 'scheduled', items: [{ id: 'l1', title: 'Fictional lesson', kind: 'lesson', instructions: 'Read.', released: true }] }];
const studio = (published: unknown = { id: VERSION, version: 2, consumerProgram: { title: 'Fictional', phases } }) => ({ program: { id: PROGRAM }, published, editable: null, offers: [], roster: [] });
function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:3000/api/live/commerce/offers', { method: 'POST', headers: { host, origin: 'https://' + host, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
const paid = (over: Record<string, unknown> = {}) => ({ mode: 'paid', name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/2', accessDurationDays: null, ...over });
const fixture = () => {
  vi.stubEnv('CLINICAL_CONTRACT_FIXTURE', '1'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('CLINICAL_SUPABASE_URL', 'http://127.0.0.1:3999');
  vi.stubEnv('APP_RUNTIME_ENV', ''); vi.stubEnv('CLINICAL_AWS_RUNTIME_MODE', '');
};
const body = async (response: Response) => response.json() as Promise<{ data?: { action: string; offer?: { offerId: string; revision: number; state: string; organizationId: string; authoredBy: string; curriculum: { versionId: string; version: number } }; offers?: unknown[]; curriculum?: unknown }; error?: { code: string; message: string; holds?: string[] } }>;

beforeEach(() => {
  vi.clearAllMocks(); __resetProgramCommerceRuntime();
  session.mockResolvedValue({ token: 'fictional-token', orgId: '33333333-3333-4333-8333-333333333333', email: 'practitioner@fictional.example' });
  getStudio.mockResolvedValue(studio());
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('the guard', () => {
  it.each<Record<string, string>>([{ origin: 'https://evil.example' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }])('refuses an unsafe origin before reading the session: %o', async headers => {
    expect((await POST(req({ action: 'list', programId: PROGRAM }, headers))).status).toBe(403);
    expect(session).not.toHaveBeenCalled();
  });
  it.each([['no token', { token: null, orgId: 'x', email: 'a@b' }], ['no clinic', { token: 't', orgId: null, email: 'a@b' }]])('requires the workforce cookie: %s', async (_name, value) => {
    session.mockResolvedValue(value);
    expect((await POST(req({ action: 'list', programId: PROGRAM }))).status).toBe(401);
  });
  it.each([
    ['an unknown action', { action: 'price', programId: PROGRAM }],
    ['a caller-named curriculum', { action: 'create', programId: PROGRAM, terms: paid(), curriculum: { versionId: VERSION } }],
    ['a caller-named clinic', { action: 'create', programId: PROGRAM, organizationId: 'other', terms: paid() }],
    ['a zero price', { action: 'create', programId: PROGRAM, terms: paid({ pricing: { currency: 'USD', amountMinor: 0, billing: { kind: 'one_time' } } }) }],
    ['a mode that is not a mode', { action: 'create', programId: PROGRAM, terms: paid({ mode: 'free' }) }],
    ['malformed JSON', '{'],
    ['an oversized body', { action: 'create', programId: PROGRAM, terms: paid({ name: 'x'.repeat(9000) }) }],
  ])('refuses %s with 400 before choosing a ledger', async (_name, value) => {
    fixture();
    expect((await POST(req(value))).status).toBe(400);
    expect(getStudio).not.toHaveBeenCalled();
  });
  it('answers 503 commerce_disabled outside the local fixture, so nothing looks saved', async () => {
    const response = await POST(req({ action: 'create', programId: PROGRAM, terms: paid() }));
    expect(response.status).toBe(503);
    expect((await body(response)).error).toMatchObject({ code: 'unavailable', message: 'commerce_disabled' });
    expect(getStudio).not.toHaveBeenCalled();
  });
});

describe('under the local fixture', () => {
  beforeEach(fixture);
  it('binds a created draft to the published version the Studio read, names the session clinic and a fictional actor, and echoes no token', async () => {
    const response = await POST(req({ action: 'create', programId: PROGRAM, terms: paid() }));
    expect(response.status).toBe(200);
    expect(getStudio).toHaveBeenCalledWith(PROGRAM, 'fictional-token');
    const { data } = await body(response);
    expect(data?.offer).toMatchObject({ revision: 1, state: 'draft', organizationId: '33333333-3333-4333-8333-333333333333', curriculum: { versionId: VERSION, version: 2 } });
    expect(data?.offer?.authoredBy).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(data)).not.toContain('fictional-token');
    expect(JSON.stringify(data)).not.toContain('practitioner@fictional.example');
  });
  it('refuses a program with nothing published, and a failed Studio read is "unverifiable", not "unpublished"', async () => {
    getStudio.mockResolvedValue(studio(null));
    const response = await POST(req({ action: 'create', programId: PROGRAM, terms: paid() }));
    expect(response.status).toBe(409);
    expect((await body(response)).error).toMatchObject({ code: 'conflict', message: 'curriculum_unpublished' });
    getStudio.mockRejectedValue(new Error('fictional outage'));
    const failed = await POST(req({ action: 'create', programId: PROGRAM, terms: paid() }));
    expect(failed.status).toBe(503);
    expect((await body(failed)).error).toMatchObject({ message: 'commerce_unverifiable' });
  });
  it('walks the authoring journey: stale revisions refused, publication held until approved, then published, then retired', async () => {
    const created = (await body(await POST(req({ action: 'create', programId: PROGRAM, terms: paid() })))).data!.offer!;
    const held = await POST(req({ action: 'publish', offerId: created.offerId, expectedRevision: 1 }));
    expect(held.status).toBe(409);
    expect((await body(held)).error).toMatchObject({ message: 'publish_refused', holds: ['provider_mapping_unapproved'] });
    const approved = (await body(await POST(req({ action: 'approve_provider_mapping', offerId: created.offerId, expectedRevision: 1 })))).data!.offer!;
    expect(approved.revision).toBe(2);
    const stale = await POST(req({ action: 'revise', offerId: created.offerId, expectedRevision: 1, terms: paid({ name: 'Stale' }) }));
    expect(stale.status).toBe(409);
    expect((await body(stale)).error).toMatchObject({ message: 'revision_stale' });
    const published = (await body(await POST(req({ action: 'publish', offerId: created.offerId, expectedRevision: 2 })))).data!.offer!;
    expect(published).toMatchObject({ state: 'published', revision: 3 });
    const immutable = await POST(req({ action: 'revise', offerId: created.offerId, expectedRevision: 3, terms: paid({ pricing: { currency: 'USD', amountMinor: 1, billing: { kind: 'one_time' } } }) }));
    expect((await body(immutable)).error).toMatchObject({ message: 'state_invalid' });
    const listed = (await body(await POST(req({ action: 'list', programId: PROGRAM })))).data!;
    expect(listed.offers).toHaveLength(1);
    expect(listed.curriculum).toMatchObject({ versionId: VERSION, version: 2 });
    const retired = (await body(await POST(req({ action: 'retire', offerId: created.offerId, expectedRevision: 3, reason: 'Fictional retirement' })))).data!.offer!;
    expect(retired.state).toBe('retired');
  });
  it('another clinic cannot see or change the offer: not found, never forbidden', async () => {
    const created = (await body(await POST(req({ action: 'create', programId: PROGRAM, terms: paid() })))).data!.offer!;
    session.mockResolvedValue({ token: 'fictional-token', orgId: '44444444-4444-4444-8444-444444444444', email: 'other@fictional.example' });
    const response = await POST(req({ action: 'retire', offerId: created.offerId, expectedRevision: 1, reason: 'not mine' }));
    expect(response.status).toBe(404);
    expect((await body(response)).error).toMatchObject({ message: 'offer_not_found' });
  });
});
