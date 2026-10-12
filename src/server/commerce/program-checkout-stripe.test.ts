import { afterEach, describe, expect, it, vi } from 'vitest';
import { StripeNotConfiguredError } from '../stripe-boundary';
import { createStripeCheckoutProcessor, requireStripeCheckoutProcessor, sessionFromStripeObject, stripeCheckoutConfig, STRIPE_CHECKOUT_CONFIG_NAMES } from './program-checkout-stripe';
import { ProcessorError } from './program-checkout-processor';

/**
 * The Stripe test-mode Checkout transport with an injected fetch and no network: default off, live
 * keys refused, the account and the pinned API version required; the request carries the price,
 * the opaque order id, the server's return destinations and the idempotency key and nothing about
 * a person; the deadline, the reply bound, redirects, live objects and malformed replies refuse.
 */
const config = { secretKey: 'sk_test_fictional', accountRef: 'acct_FictionalAccount1', apiVersion: '2025-08-27.basil' };
const stripeSession = (over: Record<string, unknown> = {}) => ({ id: 'cs_test_fictional12345', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_test_fictional12345', expires_at: 1_800_000_000, status: 'open', payment_status: 'unpaid', mode: 'payment', livemode: false, amount_total: 1999, currency: 'usd', client_reference_id: '11111111-1111-4111-8111-111111111111', metadata: { order_id: '11111111-1111-4111-8111-111111111111' }, line_items: { data: [{ price: { id: 'price_FictionalAbc123' } }] }, ...over });
const request = { orderId: '11111111-1111-4111-8111-111111111111', providerPriceRef: 'price_FictionalAbc123', pricing: { currency: 'USD' as const, amountMinor: 1999, billing: { kind: 'one_time' as const } }, successUrl: 'https://clinic.fictional.example/buy/return?order=11111111-1111-4111-8111-111111111111&returned=success', cancelUrl: 'https://clinic.fictional.example/buy/return?order=11111111-1111-4111-8111-111111111111&returned=cancel', idempotencyKey: 'program-order:11111111-1111-4111-8111-111111111111', expiresAt: '2027-01-15T00:00:00.000Z' };
afterEach(() => { vi.unstubAllEnvs(); });

describe('configuration', () => {
  it('is disabled by default and names its configuration as schema only', () => {
    const report = stripeCheckoutConfig({});
    expect(report.configured).toBe(false);
    expect(report.configured ? [] : report.problems.join(' ')).toContain('STRIPE_TEST_MODE_ENABLED');
    expect(STRIPE_CHECKOUT_CONFIG_NAMES).toEqual(['STRIPE_TEST_MODE_ENABLED', 'STRIPE_TEST_SECRET_KEY', 'STRIPE_TEST_WEBHOOK_SECRET', 'STRIPE_TEST_ACCOUNT_ID', 'STRIPE_API_VERSION_PINNED']);
    expect(() => requireStripeCheckoutProcessor(async () => new Response())).toThrow(StripeNotConfiguredError);
  });
  it('refuses a live key, a missing account, and an unpinned API version even when the base boundary is on', () => {
    const base = { STRIPE_TEST_MODE_ENABLED: '1', STRIPE_TEST_SECRET_KEY: 'sk_test_fictional', STRIPE_TEST_WEBHOOK_SECRET: 'whsec_fictional' };
    for (const [key, value] of Object.entries(base)) vi.stubEnv(key, value);
    expect(stripeCheckoutConfig({ ...base })).toMatchObject({ configured: false, problems: expect.arrayContaining([expect.stringContaining('STRIPE_TEST_ACCOUNT_ID'), expect.stringContaining('STRIPE_API_VERSION_PINNED')]) });
    expect(stripeCheckoutConfig({ ...base, STRIPE_TEST_ACCOUNT_ID: 'acct_FictionalAccount1', STRIPE_API_VERSION_PINNED: '2025-08-27.basil' })).toMatchObject({ configured: true, config });
    vi.stubEnv('STRIPE_TEST_SECRET_KEY', 'sk_live_fictional');
    expect(stripeCheckoutConfig({ ...base, STRIPE_TEST_SECRET_KEY: 'sk_live_fictional', STRIPE_TEST_ACCOUNT_ID: 'acct_FictionalAccount1', STRIPE_API_VERSION_PINNED: '2025-08-27.basil' }).configured).toBe(false);
  });
});

describe('the transport', () => {
  it('creates a session with the price, the order id, the return destinations and the idempotency key, and reads the reply into the contract', async () => {
    const calls: [string, RequestInit][] = [];
    const fetchImpl = async (url: string, init: RequestInit) => { calls.push([url, init]); return Response.json(stripeSession()); };
    const processor = createStripeCheckoutProcessor(config, fetchImpl);
    const session = await processor.createSession(request);
    expect(session).toMatchObject({ sessionRef: 'cs_test_fictional12345', status: 'open', paymentStatus: 'unpaid', mode: 'payment', livemode: false, amountTotal: 1999, currency: 'usd', clientReferenceId: request.orderId, metadata: { order_id: request.orderId }, priceRefs: ['price_FictionalAbc123'], accountRef: 'acct_FictionalAccount1' });
    const [url, init] = calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk_test_fictional');
    expect(headers['stripe-version']).toBe('2025-08-27.basil');
    expect(headers['idempotency-key']).toBe(request.idempotencyKey);
    expect(init.redirect).toBe('error');
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body)).toEqual({ mode: 'payment', 'line_items[0][price]': 'price_FictionalAbc123', 'line_items[0][quantity]': '1', success_url: request.successUrl, cancel_url: request.cancelUrl, client_reference_id: request.orderId, 'metadata[order_id]': request.orderId, expires_at: '1799971200', 'expand[0]': 'line_items' });
    expect(String(init.body)).not.toMatch(/email|name|program|health|diagnos/i);
    expect(await processor.findSessionByIdempotencyKey(request.idempotencyKey)).toBeNull();
  });
  it.each<[string, () => Promise<Response>, string]>([
    ['a network failure', async () => { throw new TypeError('fetch failed'); }, 'unavailable'],
    ['a timeout', async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }, 'timeout'],
    ['a redirect', async () => new Response('', { status: 302, headers: { location: 'https://evil.example' } }), 'redirect_reply'],
    ['a server error', async () => new Response('{}', { status: 503 }), 'unavailable'],
    ['a refusal', async () => Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing' } }, { status: 400 }), 'refused'],
    ['a live object', async () => Response.json(stripeSession({ livemode: true })), 'refused'],
    ['a malformed body', async () => new Response('<html>', { status: 200 }), 'malformed_reply'],
    ['a reply missing fields', async () => Response.json({ id: 'cs_test_fictional12345' }), 'malformed_reply'],
    ['an oversized reply', async () => new Response('{"pad":"' + 'x'.repeat(300_000) + '"}', { status: 200 }), 'malformed_reply'],
    ['a non-https checkout url', async () => Response.json(stripeSession({ url: 'http://checkout.stripe.com/x' })), 'malformed_reply'],
  ])('refuses %s as the failure it is', async (_name, reply, failure) => {
    const processor = createStripeCheckoutProcessor(config, reply);
    await expect(processor.createSession(request)).rejects.toMatchObject({ failure });
    await expect(processor.createSession(request)).rejects.toBeInstanceOf(ProcessorError);
  });
  it('retrieves only a test session reference and binds the configured account to the object', async () => {
    const processor = createStripeCheckoutProcessor(config, async url => { expect(url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_test_fictional12345?expand[0]=line_items'); return Response.json(stripeSession({ status: 'complete', payment_status: 'paid' })); });
    expect(await processor.retrieveSession('cs_test_fictional12345')).toMatchObject({ status: 'complete', paymentStatus: 'paid', accountRef: 'acct_FictionalAccount1' });
    await expect(processor.retrieveSession('cs_live_fictional12345')).rejects.toMatchObject({ failure: 'refused' });
    await expect(processor.retrieveSession('../customers')).rejects.toMatchObject({ failure: 'refused' });
  });
  it('reads a Stripe object exactly, with no price when line items are absent', () => {
    expect(sessionFromStripeObject(stripeSession({ line_items: undefined }), config.accountRef).priceRefs).toEqual([]);
    expect(() => sessionFromStripeObject(stripeSession({ status: 'paid' }), config.accountRef)).toThrow(ProcessorError);
    expect(() => sessionFromStripeObject(stripeSession({ id: 'cs_live_x' }), config.accountRef)).toThrow(ProcessorError);
  });
});
