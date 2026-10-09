import { describe, it, expect, vi } from 'vitest';
import {FullscriptApiClient, readFullscriptConfiguration} from './client';
const config = () => readFullscriptConfiguration({NODE_ENV: 'test', FULLSCRIPT_ENVIRONMENT: 'sandbox_us',
  FULLSCRIPT_CLIENT_ID: 'fictional-client-id-1234567890', FULLSCRIPT_CLIENT_SECRET: 'fictional-client-secret-1234567890',
  FULLSCRIPT_REDIRECT_URI: 'https://desktop.example.test/api/live/fullscript/oauth/callback',
  FULLSCRIPT_OAUTH_STATE_SECRET: 'fictional-state-secret-longer-than-thirty-two'});
const id = (n: number) => 'e0000000-0000-4000-8000-' + String(n).padStart(12, '0');
const key = 'alp-cart-' + 'a'.repeat(64);
const input = () => ({fullscriptPatientId: id(1), practitionerId: id(2), idempotencyKey: key,
  recommendations: [{variantId: id(3), unitsToPurchase: '2', instructions: 'Original fictional protocol directions'}]});
const fixture = (scopes: string[] = ['clinic:write', 'clinic:read']) => {
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({treatment_plan: {id: id(4)}}), {headers: {'content-type': 'application/json'}}));
  const configuration = config(), client = new FullscriptApiClient(configuration, 'fictional-access-token-abcdefghijklmnopqrstuvwxyz', fetcher as typeof fetch, scopes);
  return {fetcher, client, configuration};
};
describe('Fullscript sandbox draft transport, not durable delivery or response certification', () => {
  it('always creates a draft with no patient email, activation, order, guessed quantity or guessed dose', async () => {
    const {client, fetcher} = fixture(); await client.createSupplementDraft(input());
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://api-us-snd.fullscript.io/api/clinic/patients/' + id(1) + '/treatment_plans');
    expect(options).toMatchObject({method: 'POST', redirect: 'manual', headers: {'idempotency-key': key}});
    expect(JSON.parse(String(options?.body))).toEqual({practitioner_id: id(2), state: 'draft', send_to_patient: false,
      skip_email_notification: true, metadata: {id: key}, partner_order_id: key,
      recommendations: [{variant_id: id(3), units_to_purchase: '2', dosage: {additional_info: 'Original fictional protocol directions'}}]});
    expect(String(options?.body)).not.toMatch(/labs|checkout|personal_message|amount|frequency/);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('reuses the identical key/path/body and offers bounded reads for explicit reconciliation', async () => {
    const {client, fetcher} = fixture(); await client.createSupplementDraft(input()); await client.createSupplementDraft(input());
    expect(String(fetcher.mock.calls[0][0])).toBe(String(fetcher.mock.calls[1][0]));
    expect(fetcher.mock.calls[0][1]?.body).toBe(fetcher.mock.calls[1][1]?.body);
    await client.retrieveTreatmentPlan(id(4)); await client.findTreatmentPlanByMetadata(key);
    expect(new URL(String(fetcher.mock.calls[2][0])).pathname).toBe('/api/clinic/treatment_plans/' + id(4));
    const metadata = new URL(String(fetcher.mock.calls[3][0]));
    expect(metadata.pathname).toBe('/api/clinic/metadata'); expect(metadata.searchParams.get('id')).toBe(key);
    expect(metadata.searchParams.get('type')).toBe('treatment_plan');
  });
  it('refuses unknown or insufficient scopes before contacting the provider', async () => {
    for (const scopes of [[], ['patients:write'], ['clinic:read']]) {
      const {client, fetcher} = fixture(scopes);
      expect(() => client.createSupplementDraft(input())).toThrow('Fullscript'); expect(fetcher).not.toHaveBeenCalled();
    }
    const {client, fetcher} = fixture(['clinic:write']);
    expect(() => client.retrieveTreatmentPlan(id(4))).toThrow('Fullscript');
    expect(() => client.findTreatmentPlanByMetadata(key)).toThrow('Fullscript'); expect(fetcher).not.toHaveBeenCalled();
  });
  it('snapshots configuration and scopes so later object mutation cannot redirect a token or grant writes', async () => {
    const f = fixture(); f.configuration.apiOrigin = 'https://attacker.example/api';
    f.configuration.environment = 'production_us'; await f.client.createSupplementDraft(input());
    expect(new URL(String(f.fetcher.mock.calls[0][0])).hostname).toBe('api-us-snd.fullscript.io');
    const scopes = ['clinic:read'], denied = fixture(scopes); scopes.push('clinic:write');
    expect(() => denied.client.createSupplementDraft(input())).toThrow('Fullscript'); expect(denied.fetcher).not.toHaveBeenCalled();
  });
  it('refuses noncanonical destinations at construction and all production draft calls', () => {
    for (const value of [{...config(), apiOrigin: 'https://attacker.example/api'}, {...config(), authorizeUrl: 'https://attacker.example/oauth'}])
      expect(() => new FullscriptApiClient(value, 'fictional-access-token-abcdefghijklmnopqrstuvwxyz')).toThrow('Fullscript');
    const production = readFullscriptConfiguration({NODE_ENV: 'test', FULLSCRIPT_ENVIRONMENT: 'production_us', PHI_ALLOWED: 'true', FULLSCRIPT_PRODUCTION_APPROVED: 'true',
      FULLSCRIPT_CLIENT_ID: 'fictional-client-id-1234567890', FULLSCRIPT_CLIENT_SECRET: 'fictional-client-secret-1234567890',
      FULLSCRIPT_REDIRECT_URI: 'https://desktop.example.test/api/live/fullscript/oauth/callback', FULLSCRIPT_OAUTH_STATE_SECRET: 'fictional-state-secret-longer-than-thirty-two'});
    const fetcher = vi.fn(), client = new FullscriptApiClient(production, 'fictional-access-token-abcdefghijklmnopqrstuvwxyz', fetcher, ['clinic:read', 'clinic:write']);
    expect(() => client.createSupplementDraft(input())).toThrow('Fullscript'); expect(() => client.retrieveTreatmentPlan(id(4))).toThrow('Fullscript');
    expect(() => client.findTreatmentPlanByMetadata(key)).toThrow('Fullscript'); expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses caller injection, unknown variants, absent units and active/send fields without a request', () => {
    const {client, fetcher} = fixture();
    for (const extra of ['state', 'send_to_patient', 'labs', 'checkout_url', 'skip_email_notification'])
      expect(() => client.createSupplementDraft({...input(), [extra]: true})).toThrow('Fullscript');
    for (const bad of ['0', '1.5', '01', '101', ''])
      expect(() => client.createSupplementDraft({...input(), recommendations: [{...input().recommendations[0], unitsToPurchase: bad}]})).toThrow('Fullscript');
    expect(() => client.retrieveTreatmentPlan('../unsafe')).toThrow('Fullscript');
    expect(() => client.findTreatmentPlanByMetadata('different-key')).toThrow('Fullscript'); expect(fetcher).not.toHaveBeenCalled();
  });
  it('never retries an uncertain POST or follows a redirect', async () => {
    for (const response of [new Error('sensitive-provider-error'), new Response(null, {status: 302, headers: {location: 'https://attacker.example'}}),
      new Response(JSON.stringify({error: 'request_in_progress'}), {status: 409, headers: {'content-type': 'application/json'}})]) {
      const fetcher = vi.fn(async () => {if (response instanceof Error) throw response; return response;});
      const client = new FullscriptApiClient(config(), 'fictional-access-token-abcdefghijklmnopqrstuvwxyz', fetcher, ['clinic:write']);
      await expect(client.createSupplementDraft(input())).rejects.toThrow('Fullscript'); expect(fetcher).toHaveBeenCalledOnce();
    }
  });
});
