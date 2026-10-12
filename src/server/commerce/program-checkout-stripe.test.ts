import { afterEach, describe, expect, it, vi } from 'vitest';
import { StripeNotConfiguredError } from '../stripe-boundary';
import { DEADLINE_MS, MAX_REPLY_BYTES, createStripeCheckoutProcessor, requireStripeCheckoutProcessor, sessionFromStripeObject, stripeCheckoutConfig, STRIPE_CHECKOUT_CONFIG_NAMES } from './program-checkout-stripe';
import { encodeCreationRequest } from '../../contracts/programCheckout';
import { ProcessorError } from './program-checkout-processor';

/**
 * The Stripe test-mode Checkout transport with an injected fetch and no network: default off, live
 * keys refused, the account and the pinned API version required; the account is proven by the key
 * itself (account retrieval), never taken from the configured label; the request is the order's
 * SAVED creation request, sent byte for byte on every replay under its key; an idempotency error is
 * named as such; the deadline covers the body and the parse; replies are read as bounded bytes
 * whatever Content-Length says; redirects, live objects and malformed replies refuse; and nothing
 * missing from a reply is filled in.
 */
const config = { secretKey: 'sk_test_fictional', accountRef: 'acct_FictionalAccount1', apiVersion: '2025-08-27.basil' };
const stripeSession = (over: Record<string, unknown> = {}) => ({ id: 'cs_test_fictional12345', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_test_fictional12345', expires_at: 1_800_000_000, status: 'open', payment_status: 'unpaid', mode: 'payment', livemode: false, amount_total: 1999, currency: 'usd', client_reference_id: '11111111-1111-4111-8111-111111111111', metadata: { order_id: '11111111-1111-4111-8111-111111111111' }, line_items: { data: [{ price: { id: 'price_FictionalAbc123' } }] }, ...over });
const ORDER = '11111111-1111-4111-8111-111111111111';
const request = {
  idempotencyKey: `program-order:${ORDER}`,
  request: { mode: 'payment' as const, priceRef: 'price_FictionalAbc123', quantity: 1 as const, successUrl: `https://clinic.fictional.example/buy/return?order=${ORDER}&returned=success`, cancelUrl: `https://clinic.fictional.example/buy/return?order=${ORDER}&returned=cancel`, clientReferenceId: ORDER, metadataOrderId: ORDER, expiresAtUnix: 1_800_000_000 },
  requestSha256: 'c'.repeat(64), recordedAt: '2026-10-11T12:00:00.000Z',
};
/** A fetch that answers account retrieval with the key's own account and sends every other path to `session`. */
const routed = (session: (url: string, init: RequestInit) => Promise<Response>, account = 'acct_FictionalAccount1') => async (url: string, init: RequestInit) =>
  url === 'https://api.stripe.com/v1/account' ? Response.json({ id: account, object: 'account' }) : session(url, init);
/** A body that streams `total` bytes in chunks and counts how many the reader actually pulled. */
function streamed(total: number, chunk = 16_384, delayMs = 0) {
  let sent = 0;
  const counter = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      if (sent >= total) { controller.close(); return; }
      const size = Math.min(chunk, total - sent);
      sent += size; counter.pulled += size;
      controller.enqueue(new Uint8Array(size).fill(0x78));
    },
  });
  return { body, counter };
}
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
  it('proves the account from the key, sends the saved request byte for byte under its key, and reads the reply into the contract without filling anything in', async () => {
    const calls: [string, RequestInit][] = [];
    const processor = createStripeCheckoutProcessor(config, routed(async (url, init) => { calls.push([url, init]); return Response.json(stripeSession({ success_url: request.request.successUrl, cancel_url: request.request.cancelUrl })); }));
    expect(await processor.authority()).toEqual({ accountRef: 'acct_FictionalAccount1', livemode: false });
    const session = await processor.createSession(request);
    expect(session).toMatchObject({ sessionRef: 'cs_test_fictional12345', status: 'open', paymentStatus: 'unpaid', paymentIntentStatus: null, mode: 'payment', livemode: false, amountTotal: 1999, currency: 'usd', clientReferenceId: ORDER, metadata: { order_id: ORDER }, priceRefs: ['price_FictionalAbc123'], accountRef: 'acct_FictionalAccount1', successUrl: request.request.successUrl, cancelUrl: request.request.cancelUrl });
    const [url, init] = calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk_test_fictional');
    expect(headers['stripe-version']).toBe('2025-08-27.basil');
    expect(headers['idempotency-key']).toBe(request.idempotencyKey);
    expect(init.redirect).toBe('error');
    expect(String(init.body)).toBe(encodeCreationRequest(request.request) + '&expand%5B0%5D=line_items&expand%5B1%5D=payment_intent');
    expect(String(init.body)).not.toMatch(/email|name|program|health|diagnos|1999/i);
    // A replay sends the same bytes.
    await processor.createSession(structuredClone(request));
    expect(String(calls[1]![1].body)).toBe(String(init.body));
    // A completed session has no hosted address, and none is invented.
    expect(sessionFromStripeObject(stripeSession({ url: null, status: 'complete' }), config.accountRef).url).toBeNull();
  });
  it('attributes sessions to the account the key proves, not to the configured label, and refuses a live key outright', async () => {
    const processor = createStripeCheckoutProcessor(config, routed(async () => Response.json(stripeSession()), 'acct_FictionalOther99'));
    expect(await processor.authority()).toEqual({ accountRef: 'acct_FictionalOther99', livemode: false });
    expect((await processor.createSession(request)).accountRef).toBe('acct_FictionalOther99');
    const live = createStripeCheckoutProcessor({ ...config, secretKey: 'sk_live_fictional' }, routed(async () => Response.json(stripeSession())));
    await expect(live.authority()).rejects.toMatchObject({ failure: 'refused' });
    await expect(live.createSession(request)).rejects.toMatchObject({ failure: 'refused' });
  });
  it.each<[string, () => Promise<Response>, string]>([
    ['a network failure', async () => { throw new TypeError('fetch failed'); }, 'unavailable'],
    ['a timeout', async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }, 'timeout'],
    ['a redirect', async () => new Response('', { status: 302, headers: { location: 'https://evil.example' } }), 'redirect_reply'],
    ['a server error', async () => new Response('{}', { status: 503 }), 'unavailable'],
    ['a concurrent request with the same key', async () => Response.json({ error: { type: 'idempotency_error' } }, { status: 409 }), 'unavailable'],
    ['a rate limit', async () => Response.json({ error: { type: 'rate_limit_error' } }, { status: 429 }), 'unavailable'],
    ['the same key with other parameters', async () => Response.json({ error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters' } }, { status: 400 }), 'idempotency_mismatch'],
    ['a refusal', async () => Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing' } }, { status: 400 }), 'refused'],
    ['a live object', async () => Response.json(stripeSession({ livemode: true })), 'refused'],
    ['a malformed body', async () => new Response('<html>', { status: 200 }), 'malformed_reply'],
    ['invalid UTF-8', async () => new Response(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]), { status: 200 }), 'malformed_reply'],
    ['a reply missing fields', async () => Response.json({ id: 'cs_test_fictional12345' }), 'malformed_reply'],
    ['an oversized reply', async () => new Response('{"pad":"' + 'x'.repeat(300_000) + '"}', { status: 200 }), 'malformed_reply'],
    ['a non-https checkout url', async () => Response.json(stripeSession({ url: 'http://checkout.stripe.com/x' })), 'malformed_reply'],
  ])('refuses %s on the session reply as the failure it is', async (_name, reply, failure) => {
    const processor = createStripeCheckoutProcessor(config, routed(reply));
    await expect(processor.createSession(request)).rejects.toMatchObject({ failure });
    await expect(processor.createSession(request)).rejects.toBeInstanceOf(ProcessorError);
  });
  it('bounds what it reads by bytes, whatever Content-Length says, and stops pulling once the bound is passed', async () => {
    for (const headers of [{}, { 'content-length': '20' }, { 'content-length': 'nonsense' }] as Record<string, string>[]) {
      const { body, counter } = streamed(4 * MAX_REPLY_BYTES);
      const processor = createStripeCheckoutProcessor(config, routed(async () => new Response(body, { status: 200, headers })));
      await expect(processor.createSession(request)).rejects.toMatchObject({ failure: 'malformed_reply' });
      expect(counter.pulled).toBeLessThanOrEqual(MAX_REPLY_BYTES + 65_536);
    }
    // Multi-byte text: the bound is bytes, not characters.
    const wide = '{"pad":"' + '€'.repeat(Math.ceil(MAX_REPLY_BYTES / 3) + 10) + '"}';
    expect(wide.length).toBeLessThan(MAX_REPLY_BYTES);
    const processor = createStripeCheckoutProcessor(config, routed(async () => new Response(wide, { status: 200 })));
    await expect(processor.createSession(request)).rejects.toMatchObject({ failure: 'malformed_reply' });
  });
  it('one deadline covers the whole reply: a body that trickles past it is a timeout', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { body } = streamed(1_000, 10);
      let first = true;
      const processor = createStripeCheckoutProcessor(config, routed(async () => {
        // The headers arrive; then the clock passes the deadline before the body finishes.
        const reader = body.getReader();
        const slow = new ReadableStream<Uint8Array>({ async pull(controller) { if (first) { first = false; vi.setSystemTime(Date.now() + DEADLINE_MS + 1); } const part = await reader.read(); if (part.done) controller.close(); else controller.enqueue(part.value); } });
        return new Response(slow, { status: 200 });
      }));
      await expect(processor.createSession(request)).rejects.toMatchObject({ failure: 'timeout' });
    } finally { vi.useRealTimers(); }
  });
  it('retrieves only a test session reference, with line items and the payment intent expanded, attributed to the proven account', async () => {
    const processor = createStripeCheckoutProcessor(config, routed(async url => { expect(url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_test_fictional12345?expand[0]=line_items&expand[1]=payment_intent'); return Response.json(stripeSession({ status: 'complete', payment_status: 'unpaid', url: null, payment_intent: { id: 'pi_fictional', status: 'processing' } })); }));
    expect(await processor.retrieveSession('cs_test_fictional12345')).toMatchObject({ status: 'complete', paymentStatus: 'unpaid', paymentIntentStatus: 'processing', url: null, accountRef: 'acct_FictionalAccount1' });
    await expect(processor.retrieveSession('cs_live_fictional12345')).rejects.toMatchObject({ failure: 'refused' });
    await expect(processor.retrieveSession('../customers')).rejects.toMatchObject({ failure: 'refused' });
  });
  it('reads a Stripe object exactly, with no price when line items are absent and no intent status it does not know', () => {
    expect(sessionFromStripeObject(stripeSession({ line_items: undefined }), config.accountRef).priceRefs).toEqual([]);
    expect(sessionFromStripeObject(stripeSession({ payment_intent: 'pi_unexpanded' }), config.accountRef).paymentIntentStatus).toBeNull();
    expect(sessionFromStripeObject(stripeSession({ payment_intent: { status: 'invented' } }), config.accountRef).paymentIntentStatus).toBeNull();
    expect(() => sessionFromStripeObject(stripeSession({ status: 'paid' }), config.accountRef)).toThrow(ProcessorError);
    expect(() => sessionFromStripeObject(stripeSession({ id: 'cs_live_x' }), config.accountRef)).toThrow(ProcessorError);
  });
});
