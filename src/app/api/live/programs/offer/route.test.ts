import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const session = vi.hoisted(() => vi.fn());
const upsertOffer = vi.hoisted(() => vi.fn());
vi.mock('@/server/session', () => ({ getRequestSession: session }));
vi.mock('@/adapters/mode', () => ({ USE_LIVE_API: true }));
vi.mock('@/adapters/programs.live', () => ({ programsLive: { upsertOffer } }));
import { POST } from './route';

/**
 * The legacy offer route, reproduced first. On 08d07b3 it turned a payment mode it did not know
 * into `free`, a price that was not a finite number into 0, and absent flags into open/active, so
 * malformed paid terms reached the dispatcher as a free, open, active offer. It also parsed the
 * body with no byte bound and no origin check. These cases fail on that source and pass after the
 * repair: a malformed body is refused with 400 and the adapter is never called.
 */
const host = 'penrnyupn3.us-east-2.awsapprunner.com';
function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://0.0.0.0:3000/api/live/programs/offer', { method: 'POST', headers: { host, origin: 'https://' + host, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
const PROGRAM = '11111111-1111-4111-8111-111111111111';
const complete = { programId: PROGRAM, offerId: null, name: 'Fictional tier', priceCents: 1999, currency: 'usd', accessDurationDays: null, paymentMode: 'manual_comp', enrollmentOpen: false, status: 'active' };
beforeEach(() => { vi.clearAllMocks(); session.mockResolvedValue({ token: 'fictional-token', orgId: 'clinic-a' }); upsertOffer.mockResolvedValue({ ok: true, message: 'saved' }); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('malformed paid terms never become a free, open, active offer', () => {
  it.each([
    ['an unknown payment mode', { ...complete, paymentMode: 'complimentary' }],
    ['a paid mode the route does not know', { ...complete, paymentMode: 'stripe_checkout' }],
    ['a price as a decimal string', { ...complete, priceCents: '19.99' }],
    ['a fractional price', { ...complete, priceCents: 19.99 }],
    ['a negative price', { ...complete, priceCents: -1 }],
    ['an overflowing price', { ...complete, priceCents: 2 ** 40 }],
    ['a non-finite price', { ...complete, priceCents: Number.NaN }],
    ['an unsupported currency', { ...complete, currency: 'eur' }],
    ['a missing payment mode', (({ paymentMode: _m, ...rest }) => rest)(complete)],
    ['a missing price', (({ priceCents: _p, ...rest }) => rest)(complete)],
    ['a missing enrollment flag', (({ enrollmentOpen: _e, ...rest }) => rest)(complete)],
    ['a missing status', (({ status: _s, ...rest }) => rest)(complete)],
    ['an unknown status', { ...complete, status: 'live' }],
    ['a fractional access duration', { ...complete, accessDurationDays: 1.5 }],
    ['an unexpected field', { ...complete, refundPolicy: 'none' }],
    ['malformed JSON', '{'],
  ])('refuses %s with 400 and never reaches the dispatcher', async (_name, body) => {
    const response = await POST(req(body) as never);
    expect(response.status).toBe(400);
    expect(upsertOffer).not.toHaveBeenCalled();
  });
  it('forwards a complete, well-formed body exactly, defaulting nothing', async () => {
    const response = await POST(req(complete) as never);
    expect(response.status).toBe(200);
    expect(upsertOffer).toHaveBeenCalledWith({ ...complete }, 'fictional-token');
  });
});

describe('the request guard', () => {
  it.each<Record<string, string>>([{ origin: 'https://evil.example' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }])('refuses an unsafe origin before reading the body: %o', async headers => {
    const response = await POST(req(complete, headers) as never);
    expect(response.status).toBe(403);
    expect(upsertOffer).not.toHaveBeenCalled();
  });
  it('bounds the body', async () => {
    const response = await POST(req({ ...complete, name: 'x'.repeat(9000) }) as never);
    expect(response.status).toBe(400);
    expect(upsertOffer).not.toHaveBeenCalled();
  });
});
