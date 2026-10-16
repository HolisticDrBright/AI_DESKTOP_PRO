import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chooserRead, chooserState } from './clinic-chooser';

// The explicit clinic choice after sign-in: each state from the answer that supports it. Fictional identifiers only.
const a = randomUUID(), b = randomUUID(), p = randomUUID();
const live = (organizations: unknown[], extra: Record<string, unknown> = {}) => ({ data: { mode: 'live', organizations, activeOrgId: null, pending: [], ...extra } });
const org = (organizationId: string, name: string | null = 'FICTIONAL CLINIC') => ({ organizationId, name, role: 'owner' });

describe('clinic chooser', () => {
  it('a failed or malformed read is never "no clinic"', () => {
    for (const [status, body] of [[500, { error: { code: 'unknown' } }], [503, null], [200, { data: { mode: 'live' } }], [200, live([{ organizationId: 'not an id!' }])],
      [200, { data: { mode: 'other', organizations: [] } }]] as const) {
      expect(chooserState(chooserRead(status, body)).state).toBe('failed');
    }
    expect(chooserState(chooserRead(401, null)).state).toBe('signed_out');
    expect(chooserState(chooserRead(200, { data: { mode: 'mock', organizations: [], activeOrgId: null } })).state).toBe('demo');
  });

  it('no active clinic is "none", with pending memberships listed apart and never as choices', () => {
    expect(chooserState(chooserRead(200, live([], { pending: [{ organizationId: p, name: 'FICTIONAL PENDING' }] }))))
      .toEqual({ state: 'none', pending: [{ organizationId: p, name: 'FICTIONAL PENDING' }] });
  });

  it('one clinic is offered by itself; several are offered with none chosen for the practitioner', () => {
    expect(chooserState(chooserRead(200, live([org(a)], { activeOrgId: a })))).toMatchObject({ state: 'one', current: true });
    const several = chooserState(chooserRead(200, live([org(a), org(b, null)], { activeOrgId: null })));
    expect(several).toMatchObject({ state: 'several', activeOrgId: null });
    // A selection that is no longer among the account's clinics (suspended, revoked) is not reported as current.
    expect(chooserState(chooserRead(200, live([org(a), org(b)], { activeOrgId: p })))).toMatchObject({ state: 'several', activeOrgId: null });
    // A pending row for a clinic that is also active is not shown twice.
    expect(chooserState(chooserRead(200, live([org(a)], { pending: [{ organizationId: a, name: 'FICTIONAL CLINIC' }] })))).toMatchObject({ state: 'one', pending: [] });
  });
});
