import {describe, it, expect, vi} from 'vitest';
import {FullscriptApiClient, readFullscriptConfiguration} from './client';
import {FULLSCRIPT_DRAFT_SCOPES} from './draft-scopes';
import {createFullscriptDraftProvider} from './draft-provider';
const id = (n: number) => 'e0000000-0000-4000-8000-' + String(n).padStart(12, '0');
const key = 'alp-cart-' + 'a'.repeat(64);
const input = () => ({fullscriptPatientId: id(1), practitionerId: id(2), idempotencyKey: key,
  recommendations: [{variantId: id(3), unitsToPurchase: '2', instructions: 'Original fictional protocol directions'},
    {variantId: id(5), unitsToPurchase: '1', instructions: 'Other fictional directions'}]});
// Documented wire types with fictional values, not a provider acceptance claim.
const rawPlan = () => ({treatment_plan: {id: id(4), patient: {id: id(1)}, practitioner: {id: id(2)},
  state: 'draft', available_at: null, source: 'api', personal_message: null,
  lab_recommendations: [], resources: [], metadata: {id: key},
  recommendations: input().recommendations.map(r => ({variant_id: r.variantId,
    units_to_purchase: Number(r.unitsToPurchase), refill: false, take_with: null,
    dosage: {amount: '', frequency: '', duration: null, format: '', time_of_day: [], additional_info: r.instructions}})),
  invitation_url: 'https://untrusted.example/never-follow?token=sensitive',
  checkout_url: 'https://untrusted.example/never-follow', treatment_plan_text: 'Discard derived provider text',
}});
const metadata = () => ({metadata: [{id: key, type: 'treatment_plan', data: {id: id(4)}}],
  meta: {current_page: 1, next_page: null, prev_page: null, total_pages: 1, total_count: 1}});
const config = () => readFullscriptConfiguration({NODE_ENV: 'test', FULLSCRIPT_ENVIRONMENT: 'sandbox_us',
  FULLSCRIPT_CLIENT_ID: 'fictional-client-id-1234567890', FULLSCRIPT_CLIENT_SECRET: 'fictional-client-secret-1234567890',
  FULLSCRIPT_REDIRECT_URI: 'https://desktop.example.test/api/live/fullscript/oauth/callback',
  FULLSCRIPT_OAUTH_STATE_SECRET: 'fictional-state-secret-longer-than-thirty-two'});
function fixture(body: unknown = rawPlan(), scopes: readonly string[] = FULLSCRIPT_DRAFT_SCOPES) {
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify(
    new URL(String(url)).pathname.endsWith('/metadata') ? metadata() : body),
    {status: init?.method === 'POST' ? 201 : 200, headers: {'content-type': 'application/json'}}));
  const client = new FullscriptApiClient(config(), 'fictional-access-token-abcdefghijklmnopqrstuvwxyz', fetcher, scopes);
  return {provider: createFullscriptDraftProvider(client), fetcher};
}
describe('documented Fullscript response adapter with fictional HTTP, not hosted acceptance', () => {
  it('normalizes integer response units, exact directions and recipients without retaining or following URLs/text', async () => {
    const f = fixture();
    const result = await f.provider.create(input());
    expect(result).toEqual({contract: 'fullscript-draft-observation/1', planId: id(4), patientId: id(1),
      practitionerId: id(2), state: 'draft', metadataId: key, labs: [], recommendations: input().recommendations});
    expect(JSON.stringify(result)).not.toMatch(/sensitive|untrusted|Discard|checkout/);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toMatchObject({state: 'draft', send_to_patient: false,
      skip_email_notification: true, metadata: {id: key}});
  });
  it('requires every recovery permission before POST, not only clinic read/write', async () => {
    for (const missing of FULLSCRIPT_DRAFT_SCOPES) {
      const f = fixture(rawPlan(), FULLSCRIPT_DRAFT_SCOPES.filter(s => s !== missing));
      await expect(f.provider.create(input())).rejects.toThrow('fullscript_delivery_refused');
      expect(f.fetcher).not.toHaveBeenCalled();
    }
  });
  it('retrieves the unique metadata ID, then independently verifies the GET identity and key', async () => {
    const f = fixture(); expect(await f.provider.findByMetadata(key)).toHaveLength(1);
    expect(f.fetcher.mock.calls.map(c => new URL(String(c[0])).pathname))
      .toEqual(['/api/clinic/metadata', '/api/clinic/treatment_plans/' + id(4)]);
    expect(f.fetcher.mock.calls.every(c => c[1]?.method === 'GET')).toBe(true);
  });
  it('allows read-only reconciliation scopes but will not use them to POST', async () => {
    const f = fixture(rawPlan(), ['catalog:read', 'patients:treatment_plan_history']);
    expect(await f.provider.findByMetadata(key)).toHaveLength(1);
    await expect(f.provider.create(input())).rejects.toThrow('fullscript_delivery_refused');
    expect(f.fetcher.mock.calls.every(c => c[1]?.method === 'GET')).toBe(true);
    const partial = fixture(rawPlan(), ['catalog:read']);
    await expect(partial.provider.findByMetadata(key)).rejects.toThrow('fullscript_delivery_refused');
    expect(partial.fetcher).not.toHaveBeenCalled();
  });
  it.each(['active', 'sent', 'wrong-patient', 'wrong-practitioner', 'wrong-key', 'extra-product', 'missing-product',
    'duplicate-product', 'instructions', 'string-quantity', 'fraction', 'zero', 'missing-labs', 'labs', 'resource',
    'refill', 'take-with', 'amount', 'frequency', 'duration', 'format', 'time-of-day', 'unknown-dose', 'unknown-plan']
  )('refuses %s rather than recording an exact governed draft', async reason => {
    const body: Record<string, unknown> = rawPlan();
    const p = body.treatment_plan as Record<string, unknown>;
    const recs = p.recommendations as Array<Record<string, unknown>>;
    const dose = recs[0].dosage as Record<string, unknown>;
    if (reason === 'active') p.state = 'active';
    if (reason === 'sent') p.available_at = '2026-10-09T12:00:00Z';
    if (reason === 'wrong-patient') p.patient = {id: id(99)};
    if (reason === 'wrong-practitioner') p.practitioner = {id: id(99)};
    if (reason === 'wrong-key') p.metadata = {id: 'alp-cart-' + 'b'.repeat(64)};
    if (reason === 'extra-product') recs.push({...recs[0], variant_id: id(99)});
    if (reason === 'missing-product') recs.pop();
    if (reason === 'duplicate-product') recs[1] = {...recs[0]};
    if (reason === 'instructions') dose.additional_info = 'Changed directions';
    if (reason === 'string-quantity') recs[0].units_to_purchase = '2';
    if (reason === 'fraction') recs[0].units_to_purchase = 1.5;
    if (reason === 'zero') recs[0].units_to_purchase = 0;
    if (reason === 'missing-labs') delete p.lab_recommendations;
    if (reason === 'labs') p.lab_recommendations = [{id: id(99)}];
    if (reason === 'resource') p.resources = [{id: id(99)}];
    if (reason === 'refill') recs[0].refill = true;
    if (reason === 'take-with') recs[0].take_with = 'food';
    if (['amount', 'frequency', 'duration', 'format'].includes(reason)) dose[reason] = 'Added advice';
    if (reason === 'time-of-day') dose.time_of_day = ['morning'];
    if (reason === 'unknown-dose') dose.new_dosing_rule = 'unreviewed';
    if (reason === 'unknown-plan') p.new_advice = 'unreviewed';
    const f = fixture(body); await expect(f.provider.create(input())).rejects.toThrow('fullscript_delivery_refused');
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('accepts different recommendation order but no content change', async () => {
    const body = rawPlan(); body.treatment_plan.recommendations.reverse();
    expect(await fixture(body).provider.create(input())).toMatchObject({planId: id(4)});
  });
  it.each(['next-page', 'prev-page', 'missing-pagination', 'wrong-count', 'wrong-key', 'wrong-type', 'ambiguous', 'bad-id']
  )('refuses %s metadata before making any plan GET', async reason => {
    const body: Record<string, unknown> = metadata();
    const page = body.meta as Record<string, unknown>, rows = body.metadata as Array<Record<string, unknown>>;
    if (reason === 'next-page') page.next_page = 2;
    if (reason === 'prev-page') page.prev_page = 1;
    if (reason === 'missing-pagination') delete body.meta;
    if (reason === 'wrong-count') page.total_count = 0;
    if (reason === 'wrong-key') rows[0].id = 'alp-cart-' + 'b'.repeat(64);
    if (reason === 'wrong-type') rows[0].type = 'patient';
    if (reason === 'ambiguous') rows.push({...rows[0], data: {id: id(90)}});
    if (reason === 'bad-id') rows[0].data = {id: '../unsafe', url: 'https://attacker.example'};
    const f = fixture(); f.fetcher.mockImplementation(async () => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}}));
    await expect(f.provider.findByMetadata(key)).rejects.toThrow('fullscript_delivery_refused');
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('empty complete metadata is not a retry permission or an absence certificate', async () => {
    const f = fixture(); f.fetcher.mockImplementation(async () => new Response(JSON.stringify({metadata: [],
      meta: {current_page: 1, next_page: null, prev_page: null, total_pages: 0, total_count: 0}}), {headers: {'content-type': 'application/json'}}));
    expect(await f.provider.findByMetadata(key)).toEqual([]); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(['id', 'metadata'])('refuses a different %s on independent plan retrieval', async field => {
    const body = rawPlan();
    if (field === 'id') body.treatment_plan.id = id(99);
    else body.treatment_plan.metadata.id = 'alp-cart-' + 'b'.repeat(64);
    const f = fixture(body); await expect(f.provider.findByMetadata(key)).rejects.toThrow('fullscript_delivery_refused');
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([200, 202, 302, 403, 409])('refuses POST status %s without reading a provider error or retrying', async status => {
    const cancel = vi.fn();
    const f = fixture(); f.fetcher.mockImplementation(async () => new Response(new ReadableStream({
      start(c) {c.enqueue(new TextEncoder().encode('sensitive provider body'));}, cancel,
    }), {status, headers: {'content-type': 'application/json'}}));
    await expect(f.provider.create(input())).rejects.toThrow('fullscript_delivery_refused');
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  });
  it('refuses a normalized fictional receipt masquerading as a provider wire response', async () => {
    const f = fixture({contract: 'fullscript-draft-observation/1', planId: id(4)});
    await expect(f.provider.create(input())).rejects.toThrow('fullscript_delivery_refused');
  });
});
