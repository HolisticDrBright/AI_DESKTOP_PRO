import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A session with no selected clinic (an unapproved self-signed-up account, a selection cleared after a failed
 * membership read, a membership that was removed) must not be given a clinic by configuration. The env clinic exists
 * for the contract-fixture browser suite and headless local runs, the same boundary as the env demo credentials
 * (session.server.ts): outside it, a missing selection is a refusal, never `CLINICAL_ORG_ID`.
 */
const FIXTURE = { CLINICAL_CONTRACT_FIXTURE: '1', CLINICAL_SUPABASE_URL: 'http://127.0.0.1:3999', CLINICAL_SUPABASE_ANON_KEY: 'stub' };
const CLEAR = ['CLINICAL_ORG_ID', 'NEXT_PUBLIC_DEV_ORG_ID', 'CLINICAL_CONTRACT_FIXTURE', 'CLINICAL_SUPABASE_URL', 'CLINICAL_SUPABASE_ANON_KEY',
  'APP_RUNTIME_ENV', 'VERCEL_ENV', 'AWS_EXECUTION_ENV', 'AWS_LAMBDA_FUNCTION_NAME'];
async function configWith(env: Record<string, string>) {
  vi.resetModules();
  for (const name of CLEAR) vi.stubEnv(name, undefined as unknown as string);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return import('./config');
}
afterEach(() => { vi.unstubAllEnvs(); });

describe('the env clinic is admitted only inside the contract-fixture boundary', () => {
  it.each([
    ['CLINICAL_ORG_ID set, no fixture', { CLINICAL_ORG_ID: 'org-configured' }],
    ['NEXT_PUBLIC_DEV_ORG_ID set, no fixture', { NEXT_PUBLIC_DEV_ORG_ID: 'org-configured' }],
    ['the fixture flag in a deployed runtime', { CLINICAL_ORG_ID: 'org-configured', ...FIXTURE, APP_RUNTIME_ENV: 'production' }],
    ['the fixture flag against a hosted backend', { CLINICAL_ORG_ID: 'org-configured', ...FIXTURE, CLINICAL_SUPABASE_URL: 'https://example.supabase.co' }],
  ])('%s: a session with no selected clinic is refused, not given the configured clinic', async (_label, env) => {
    const { resolveOrgId } = await configWith(env);
    for (const missing of [null, undefined, '']) {
      expect(() => resolveOrgId(missing)).toThrow('No organization selected. Choose your organization in Settings.');
    }
  });
  it('inside the boundary the fixture suite keeps its clinic', async () => {
    const { resolveOrgId } = await configWith({ CLINICAL_ORG_ID: 'org-fixture', ...FIXTURE });
    expect(resolveOrgId(null)).toBe('org-fixture');
  });
  it.each([
    ['no fixture', { CLINICAL_ORG_ID: 'org-configured' }],
    ['the fixture', { CLINICAL_ORG_ID: 'org-fixture', ...FIXTURE }],
  ])('with %s, the session\'s own selection always wins', async (_label, env) => {
    const { resolveOrgId } = await configWith(env);
    expect(resolveOrgId('org-selected')).toBe('org-selected');
  });
});
