import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The public consult route with the received email: the answer to the visitor is the same whether the email
 * is off, on, or failing; only a request that was actually received is followed by one email, to the address
 * the visitor typed; a throttled submission sends nothing. Fictional people only.
 */
const { sesSend, calls } = vi.hoisted(() => ({ sesSend: vi.fn(), calls: [] as Array<{ action: string }> }));
vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class SESv2Client { send = sesSend; },
  SendEmailCommand: class SendEmailCommand { constructor(readonly input: unknown) {} },
}));
vi.mock('@aws-sdk/client-secrets-manager', () => ({ SecretsManagerClient: class SecretsManagerClient {} }));
vi.mock('@/server/consult/consultContactKey', () => ({
  ConsultKeyError: class ConsultKeyError extends Error {},
  createConsultContactKeyResolver: () => async () => Buffer.alloc(32, 7),
}));
vi.mock('@/server/same-browser-origin', () => ({ sameBrowserOrigin: () => true }));
vi.mock('@/app/api/live/route-helpers', () => ({ liveGuard: () => null }));
let outcome: 'received' | 'throttled' = 'received';
let describeFails = false;
vi.mock('@/server/consult/consultPublicApi', () => ({
  ConsultPublicApiError: class ConsultPublicApiError extends Error { status = 503; },
  consultPublicCall: () => async (request: { action: string; slug?: string }) => {
    calls.push(request);
    if (request.action === 'describe') {
      if (describeFails) throw new Error('down');
      return { action: 'describe', slug: request.slug, label: 'Fictional link', clinic: 'Fictional Clinic', visitTypes: ['initial'], reasonCodes: ['program_question'], acceptingRequests: true };
    }
    return outcome === 'received'
      ? { action: 'submit', outcome: 'received', reference: 'ABCDEFGHJK', receivedAt: '2026-10-14T12:00:00.000Z', status: 'received' }
      : { action: 'submit', outcome: 'throttled', reference: null, retryAfterSeconds: 3600 };
  },
}));

import { POST } from './route';

const submission = { action: 'submit', slug: 'longevity-program-email', name: 'Ava Fictional', email: 'ava.fictional@example.test', phone: null,
  visitType: 'initial', reasonCode: 'program_question', preferredWindows: [], timeZone: 'America/Los_Angeles' };
const post = () => POST(new Request('https://clinic.fictional.example/api/public/consult', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://clinic.fictional.example' }, body: JSON.stringify(submission) }));
const on = { CONSULT_ENQUIRER_EMAILS_ENABLED: 'true', CONSULT_ENQUIRER_SENDER: 'Fictional Clinic <hello@clinic.fictional.example>', CONSULT_ENQUIRER_CONFIGURATION_SET: 'alp-transactional',
  CONSULT_ENQUIRER_CONTACT_LINE: 'call (555) 010-0000' };
const withEnv = async (env: Record<string, string>, run: () => Promise<Response>) => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  try { return await run(); } finally { vi.unstubAllEnvs(); }
};

beforeEach(() => { sesSend.mockReset(); sesSend.mockResolvedValue({ MessageId: 'fictional' }); calls.length = 0; outcome = 'received'; describeFails = false; });

describe('the public consult route and the received email', () => {
  it('with the setting off sends nothing, and answers exactly as before', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { action: 'submit', outcome: 'received', reference: 'ABCDEFGHJK', receivedAt: '2026-10-14T12:00:00.000Z', status: 'received' } });
    expect(sesSend).not.toHaveBeenCalled();
    expect(calls.map(c => c.action)).toEqual(['submit']);
  });
  it('with the setting on, a received request is followed by one email to the typed address, and the answer is unchanged', async () => {
    const off = await (await post()).json();
    const response = await withEnv(on, post);
    expect(await response.json()).toEqual(off);
    expect(sesSend).toHaveBeenCalledTimes(1);
    const input = (sesSend.mock.calls[0]![0] as { input: { Destination: { ToAddresses: string[] }; ConfigurationSetName: string; Content: { Simple: { Body: { Text: { Data: string } } } } } }).input;
    expect(input.Destination.ToAddresses).toEqual(['ava.fictional@example.test']);
    expect(input.ConfigurationSetName).toBe('alp-transactional');
    expect(input.Content.Simple.Body.Text.Data).toContain('Fictional Clinic received your request');
    expect(JSON.stringify(input)).not.toMatch(/Ava Fictional|program|initial|ABCDEFGHJK|longevity/i);
  });
  it('a throttled submission sends nothing', async () => {
    outcome = 'throttled';
    const response = await withEnv(on, post);
    expect((await response.json()).data.outcome).toBe('throttled');
    expect(sesSend).not.toHaveBeenCalled();
  });
  it('a failing email or an unreadable clinic never changes the answer', async () => {
    sesSend.mockRejectedValue(new Error('ses down'));
    expect((await (await withEnv(on, post)).json()).data.outcome).toBe('received');
    describeFails = true; sesSend.mockReset();
    const response = await withEnv(on, post);
    expect(response.status).toBe(200);
    expect((await response.json()).data.outcome).toBe('received');
    expect(sesSend).not.toHaveBeenCalled();
  });
});
