import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
import { __resetProgramCommerceRuntime, selectProgramCheckout } from '@/server/commerce/program-commerce-runtime';

/**
 * The program-checkout webhook receiver: provider authentication over the raw bytes, no fixture
 * fallback, 503 when nothing is configured, 400 for a signature, tolerance, livemode, account or API
 * version refusal, 200 only after durable admission (a replay is a recorded duplicate), 500 when the
 * store cannot record. Settlement never happens in this route.
 */
const SECRET = 'whsec_fictional_secret_for_program_checkout';
function sign(rawBody: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')}`;
}
const event = (over: Record<string, unknown> = {}, object: Record<string, unknown> = {}) => JSON.stringify({ id: 'evt_fictional_webhook_1', type: 'checkout.session.completed', livemode: false, created: 1, api_version: '2025-08-27.basil', data: { object: { object: 'checkout.session', id: 'cs_test_fictionalSession1', ...object } }, ...over });
const post = (body: string, headers: Record<string, string> = {}) => POST(new Request('http://127.0.0.1:3000/api/live/commerce/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sign(body), ...headers }, body }));
const fixture = () => { vi.stubEnv('CLINICAL_CONTRACT_FIXTURE', '1'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('CLINICAL_SUPABASE_URL', 'http://127.0.0.1:3999'); vi.stubEnv('APP_RUNTIME_ENV', ''); vi.stubEnv('CLINICAL_AWS_RUNTIME_MODE', ''); };
const configure = () => { vi.stubEnv('STRIPE_TEST_MODE_ENABLED', '1'); vi.stubEnv('STRIPE_TEST_SECRET_KEY', 'sk_test_fictional'); vi.stubEnv('STRIPE_TEST_WEBHOOK_SECRET', SECRET); };
beforeEach(() => { __resetProgramCommerceRuntime(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('refusals before any intake', () => {
  it('answers 503 outside the fixture even with a configured boundary and a valid signature, and 503 under the fixture when the boundary is off', async () => {
    configure();
    const outside = await post(event());
    expect(outside.status).toBe(503);
    expect((await outside.json() as { error: { message: string } }).error.message).toBe('checkout_unconfigured');
    vi.unstubAllEnvs(); fixture();
    expect((await post(event())).status).toBe(503);
  });
  it.each([
    ['no signature', (body: string) => ({ body, headers: { 'stripe-signature': '' } })],
    ['a wrong secret', (body: string) => ({ body, headers: { 'stripe-signature': sign(body, 'whsec_other_secret_entirely') } })],
    ['a stale timestamp', (body: string) => ({ body, headers: { 'stripe-signature': sign(body, SECRET, Math.floor(Date.now() / 1000) - 3600) } })],
    ['a tampered body', (body: string) => ({ body: body.replace('cs_test_fictionalSession1', 'cs_test_fictionalSession2'), headers: { 'stripe-signature': sign(body) } })],
    ['a live-mode event', (_body: string) => ({ body: event({ livemode: true }), headers: {} })],
    ['another account', (_body: string) => ({ body: event({ account: 'acct_FictionalOther99' }), headers: {} })],
    ['an unpinned API version', (_body: string) => ({ body: event({ api_version: '2020-08-27' }), headers: {} })],
  ])('refuses %s with 400 and records nothing', async (_name, make) => {
    fixture(); configure();
    const base = event();
    const { body, headers } = make(base);
    const response = await post(body, headers);
    expect(response.status).toBe(400);
    const selection = selectProgramCheckout();
    expect(selection.kind === 'fictional' && selection.ledger.intake.size).toBe(0);
  });
  it('refuses an oversized body before verifying anything', async () => {
    fixture(); configure();
    expect((await post('{"pad":"' + 'x'.repeat(300_000) + '"}')).status).toBe(400);
  });
});

describe('durable intake', () => {
  beforeEach(() => { fixture(); configure(); });
  it('admits a signed event, answers 200, and a replay is a recorded duplicate; an unknown type is admitted and left unhandled', async () => {
    const first = await post(event());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true, outcome: 'admitted' });
    const selection = selectProgramCheckout();
    if (selection.kind !== 'fictional') throw new Error('fixture expected');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(selection.ledger.intake.get('evt_fictional_webhook_1')).toMatchObject({ eventType: 'checkout.session.completed', sessionRef: 'cs_test_fictionalSession1', apiVersion: '2025-08-27.basil', state: 'refused', lastOutcome: 'no order for session' });
    const replay = await post(event());
    expect(await replay.json()).toEqual({ received: true, outcome: 'duplicate' });
    expect(selection.ledger.intake.size).toBe(1);
    const unknown = await post(event({ id: 'evt_fictional_webhook_2', type: 'customer.created' }, { id: 'cus_fictional' }));
    expect(await unknown.json()).toEqual({ received: true, outcome: 'admitted' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(selection.ledger.intake.get('evt_fictional_webhook_2')).toMatchObject({ state: 'unhandled' });
    expect(selection.ledger.orders.size).toBe(0);
  });
  it('answers 500 when the event cannot be recorded, so the processor retries', async () => {
    const selection = selectProgramCheckout();
    if (selection.kind !== 'fictional') throw new Error('fixture expected');
    const original = selection.ledger.admitIntake;
    selection.ledger.admitIntake = async () => { throw new Error('fictional outage'); };
    try {
      const response = await post(event({ id: 'evt_fictional_webhook_3' }));
      expect(response.status).toBe(500);
    } finally { selection.ledger.admitIntake = original; }
  });
});
