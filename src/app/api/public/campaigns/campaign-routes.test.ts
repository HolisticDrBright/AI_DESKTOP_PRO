import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const session = vi.hoisted(() => vi.fn());
vi.mock('@/server/session', () => ({ getRequestSession: session }));
vi.mock('@/adapters/mode', () => ({ USE_LIVE_API: true }));
import { POST as join } from './join/route';
import { POST as confirm } from './confirm/route';
import { POST as unsubscribe } from './unsubscribe/route';
import { POST as live } from '../../live/campaigns/route';
import { marketingSignupDirectory } from '@/funnels/marketingSignup';

/**
 * The Desktop's campaign routes: they forward to the campaign engine's own API and hold nothing. Off, every one is
 * absent. The public forms post only fixed fields from this origin; the one-click unsubscribe takes exactly the
 * RFC 8058 body from anywhere; the staff route exchanges the cookie session for the workforce token and never puts
 * a practice in the request. Fictional people only.
 */
const upstream = vi.fn();
const host = 'clinic.fictional.example';
const API = 'https://abcdefghij.execute-api.us-east-2.amazonaws.com';
const TOKEN = 'A'.repeat(60);
const form = (url: string, body: string, headers: Record<string, string> = {}) => new Request(url, { method: 'POST', body,
  headers: { host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded', ...headers } });
const joinBody = (extra = '') => `practice=fictional-clinic&program=longevity-program&email=avery%40fictional.example&firstName=Avery&consent=yes&formToken=${TOKEN}&website=${extra}`;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('fetch', upstream);
  vi.stubEnv('CAMPAIGN_ENGINE_ENABLED', 'true'); vi.stubEnv('CAMPAIGN_API_ORIGIN', API);
  session.mockResolvedValue({ token: 'fictional-workforce-token' });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const reply = (status: number, data: unknown) => new Response(JSON.stringify(status < 300 ? { data } : data), { status, headers: { 'content-type': 'application/json' } });

describe('switched off (CAMPAIGN_ENGINE_ENABLED unset)', () => {
  it('every campaign route answers not-found and nothing is forwarded; no program page shows "Get updates"', async () => {
    vi.stubEnv('CAMPAIGN_ENGINE_ENABLED', '');
    expect((await join(form('https://x/api/public/campaigns/join', joinBody()))).status).toBe(404);
    expect((await confirm(form('https://x/api/public/campaigns/confirm', `t=${TOKEN}`))).status).toBe(404);
    expect((await unsubscribe(form(`https://x/api/public/campaigns/unsubscribe?t=${TOKEN}`, 'List-Unsubscribe=One-Click'))).status).toBe(404);
    expect((await live(new Request('https://x/api/live/campaigns', { method: 'POST', body: '{"action":"overview"}', headers: { host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin' } }))).status).toBe(404);
    expect(await marketingSignupDirectory({ FUNNEL_PRACTICE_SLUG: 'fictional-clinic', CAMPAIGN_API_ORIGIN: API }).practiceFor('longevity-program')).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  });
});

describe('the sign-up form post', () => {
  it('forwards the fixed fields and sends the visitor to "check your email", whatever happened to the address', async () => {
    upstream.mockResolvedValueOnce(reply(202, { outcome: 'check_your_email' }));
    const response = await join(form('https://x/api/public/campaigns/join', joinBody()));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`https://${host}/join/sent`);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/campaigns/public/join`);
    expect(JSON.parse(String(init.body))).toEqual({ practice: 'fictional-clinic', program: 'longevity-program', email: 'avery@fictional.example', firstName: 'Avery', consent: 'yes', formToken: TOKEN, website: '' });
    expect(response.headers.get('set-cookie')).toBeNull();
  });
  it('refuses a cross-site post and any field it does not know, before forwarding', async () => {
    expect((await join(form('https://x/api/public/campaigns/join', joinBody(), { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await join(form('https://x/api/public/campaigns/join', joinBody() + '&phone=%2B15555550101'))).status).toBe(400);
    expect((await join(form('https://x/api/public/campaigns/join', joinBody().replace('practice=fictional-clinic', 'practice=..%2Fadmin')))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('sends the visitor back with a problem they can fix: no consent, a bad address, or the engine unreachable', async () => {
    const back = async (body: string) => (await join(form('https://x/api/public/campaigns/join', body))).headers.get('location');
    expect(await back(joinBody().replace('consent=yes', 'consent=no'))).toBe(`https://${host}/join/fictional-clinic/longevity-program?problem=consent`);
    upstream.mockResolvedValueOnce(reply(400, { error: 'invalid', detail: 'email_invalid' }));
    expect(await back(joinBody())).toBe(`https://${host}/join/fictional-clinic/longevity-program?problem=email`);
    upstream.mockRejectedValueOnce(new Error('network'));
    expect(await back(joinBody())).toBe(`https://${host}/join/fictional-clinic/longevity-program?problem=unavailable`);
  });
});

describe('confirmation and unsubscribe', () => {
  it('confirms only from the page\'s button post, and passes the outcome to the page', async () => {
    upstream.mockResolvedValueOnce(reply(200, { outcome: 'list_full' }));
    const response = await confirm(form('https://x/api/public/campaigns/confirm', `t=${TOKEN}`));
    expect(response.headers.get('location')).toBe(`https://${host}/join/confirm?o=list_full`);
    expect(JSON.parse(String((upstream.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ token: TOKEN });
    expect((await confirm(form('https://x/api/public/campaigns/confirm', `t=${TOKEN}`, { origin: 'https://evil.example' }))).status).toBe(403);
  });
  it('takes the RFC 8058 one-click POST from a mail provider (no browser origin), and only that exact body', async () => {
    upstream.mockResolvedValueOnce(reply(200, { outcome: 'unsubscribed' }));
    const provider = new Request(`https://x/api/public/campaigns/unsubscribe?t=${TOKEN}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect((await unsubscribe(provider)).status).toBe(200);
    expect(JSON.parse(String((upstream.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ token: TOKEN });
    for (const body of ['', 'List-Unsubscribe=Yes', 'unsubscribe=all']) {
      expect((await unsubscribe(new Request(`https://x/api/public/campaigns/unsubscribe?t=${TOKEN}`, { method: 'POST', body }))).status, body).toBe(400);
    }
    expect((await unsubscribe(new Request('https://x/api/public/campaigns/unsubscribe?t=short', { method: 'POST', body: 'List-Unsubscribe=One-Click' }))).status).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe('the staff route', () => {
  const staff = (body: unknown, headers: Record<string, string> = {}) => new Request('https://x/api/live/campaigns', { method: 'POST', body: JSON.stringify(body),
    headers: { host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers } });
  it('forwards a valid request with the workforce token; a practice in the request is refused', async () => {
    upstream.mockResolvedValueOnce(reply(200, { action: 'check_template', templateId: '0e000000-0000-4000-8000-000000000001', problems: [] }));
    const ok = await live(staff({ action: 'check_template', templateId: '0e000000-0000-4000-8000-000000000001' }));
    expect(ok.status).toBe(200);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/campaigns/workforce`);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer fictional-workforce-token');
    expect((await live(staff({ action: 'overview', practiceId: '22222222-2222-4222-8222-222222222222' }))).status).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it('needs a session and a same-origin browser; a refusal passes through; an unreachable engine is 503, never an empty answer', async () => {
    session.mockResolvedValueOnce({ token: null });
    expect((await live(staff({ action: 'overview' }))).status).toBe(401);
    expect((await live(staff({ action: 'overview' }, { origin: 'https://evil.example' }))).status).toBe(403);
    upstream.mockResolvedValueOnce(reply(409, { error: 'not_ready', detail: 'attorney_signoff_required' }));
    const refused = await live(staff({ action: 'approve_template', templateId: '0e000000-0000-4000-8000-000000000001', version: 1 }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'not_ready', detail: 'attorney_signoff_required' });
    upstream.mockRejectedValueOnce(new Error('network'));
    expect((await live(staff({ action: 'overview' }))).status).toBe(503);
    vi.stubEnv('CAMPAIGN_API_ORIGIN', 'https://evil.example');
    expect((await live(staff({ action: 'overview' }))).status).toBe(503);
  });
});

describe('the "Get updates" directory', () => {
  const env = { CAMPAIGN_ENGINE_ENABLED: 'true', CAMPAIGN_API_ORIGIN: API, FUNNEL_PRACTICE_SLUG: 'fictional-clinic' };
  it('names the practice only while the engine says its sign-up page for that program is open', async () => {
    upstream.mockResolvedValueOnce(reply(200, { open: true }));
    expect(await marketingSignupDirectory(env).practiceFor('longevity-program')).toEqual({ practiceSlug: 'fictional-clinic' });
    expect((upstream.mock.calls[0] as [string])[0]).toBe(`${API}/campaigns/public/signup-open/fictional-clinic/longevity-program`);
    upstream.mockResolvedValueOnce(reply(200, { open: false }));
    expect(await marketingSignupDirectory(env).practiceFor('longevity-program')).toBeNull();
    upstream.mockRejectedValueOnce(new Error('network'));
    expect(await marketingSignupDirectory(env).practiceFor('longevity-program')).toBeNull();
    expect(await marketingSignupDirectory({ ...env, FUNNEL_PRACTICE_SLUG: '' }).practiceFor('longevity-program')).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(3);
  });
});
