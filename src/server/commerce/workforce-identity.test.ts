import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkforceIdentity } from './workforce-identity';
import type { RequestSession } from '@/server/session';

/**
 * The identity the Studio's commerce routes act under: cookie first; the env fallback only inside the
 * contract-fixture boundary; outside it, a missing cookie or a missing clinic is "no identity", never
 * a guessed clinic. The person id is deterministic for one email and never the email itself.
 */
const session = (over: Partial<RequestSession> = {}): RequestSession => ({ signedIn: true, email: 'practitioner@fictional.example', expired: false, expiresAt: null, orgId: '33333333-3333-4333-8333-333333333333', token: 'fictional-token', ...over });

beforeEach(() => { vi.stubEnv('CLINICAL_CONTRACT_FIXTURE', ''); vi.stubEnv('CLINICAL_DEMO_EMAIL', ''); vi.stubEnv('CLINICAL_DEMO_PASSWORD', ''); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('resolveWorkforceIdentity', () => {
  it('takes the clinic and the token from the cookie session and derives a fictional person id that is not the email', async () => {
    const identity = await resolveWorkforceIdentity(session());
    expect(identity).toMatchObject({ token: 'fictional-token', organizationId: '33333333-3333-4333-8333-333333333333' });
    expect(identity?.personId).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity?.personId).not.toContain('practitioner');
    expect((await resolveWorkforceIdentity(session()))?.personId).toBe(identity?.personId);
    expect((await resolveWorkforceIdentity(session({ email: 'other@fictional.example' })))?.personId).not.toBe(identity?.personId);
  });
  it('is null without a token outside the fixture boundary, whatever env credentials are present', async () => {
    vi.stubEnv('CLINICAL_DEMO_EMAIL', 'demo@local'); vi.stubEnv('CLINICAL_DEMO_PASSWORD', 'demo');
    expect(await resolveWorkforceIdentity(session({ token: null }))).toBeNull();
  });
  it('is null without a clinic when no env fallback clinic is configured, rather than a guessed clinic', async () => {
    const identity = await resolveWorkforceIdentity(session({ orgId: null }));
    // The env fallback clinic is read at module load; in a run that sets CLINICAL_ORG_ID it is that clinic, never an invented one.
    if (process.env.CLINICAL_ORG_ID || process.env.NEXT_PUBLIC_DEV_ORG_ID) expect(identity?.organizationId).toBe(process.env.CLINICAL_ORG_ID || process.env.NEXT_PUBLIC_DEV_ORG_ID);
    else expect(identity).toBeNull();
  });
  it('names the clinic, not the person, when the session has no email', async () => {
    const identity = await resolveWorkforceIdentity(session({ email: null }));
    expect(identity?.personId).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity?.personId).not.toBe((await resolveWorkforceIdentity(session()))?.personId);
  });
});
