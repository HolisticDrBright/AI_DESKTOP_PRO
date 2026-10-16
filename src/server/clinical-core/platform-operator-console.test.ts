import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AdminGetUserCommand, DescribeUserPoolCommand } from '@aws-sdk/client-cognito-identity-provider';
import { createPlatformOperatorAuthenticator } from './platform-operator-authenticator';
import { createPlatformOperatorConsoleApi, PLATFORM_OPERATOR_CONSOLE_RELEASE, PLATFORM_OPERATOR_ROUTES } from './platform-operator-console';
import type { ClinicalCoreDatabase } from './database';

/**
 * The operator console API composed with the real operator sign-in: which tokens reach a database transaction at all.
 * Fictional pools, clients, subjects and clinics; the JWT verifier, Cognito and the database are substituted at their
 * boundary. The SQL itself is exercised in workforce-new-clinic-bootstrap.database.test.ts.
 */
const OPERATOR_POOL = 'us-east-2_OpErAtOr1', OPERATOR_CLIENT = 'o'.repeat(26);
const WORKFORCE_POOL = 'us-east-2_ueGlFRbNB', WORKFORCE_CLIENT = '4s7jgr4o8sqdq7cvo9gmq96e2h';
const target = { account: '588966314750', operatorPoolId: OPERATOR_POOL, operatorClientId: OPERATOR_CLIENT,
  otherPoolIds: [WORKFORCE_POOL, 'us-east-2_CoNsUmEr1'], otherClientIds: [WORKFORCE_CLIENT, 'c'.repeat(26)] };
const NOW = Date.parse('2026-10-16T01:00:00Z');
const operator = randomUUID(), clinic = randomUUID();
const claims = (over: Record<string, unknown> = {}) => ({ iss: `https://cognito-idp.us-east-2.amazonaws.com/${OPERATOR_POOL}`, aud: OPERATOR_CLIENT,
  token_use: 'id', sub: operator, exp: NOW / 1000 + 600, iat: NOW / 1000 - 60, auth_time: NOW / 1000 - 120, ...over });
const LISTED = [{ organizationId: clinic, clinicLabel: 'FICTIONAL CLINIC', status: 'active', createdAt: '2026-10-16T00:00:00Z', suspendedAt: null,
  suspensionReason: null, events: [{ action: 'bootstrapped', reason: null, occurredAt: '2026-10-16T00:00:00Z', operator: null, byCaller: false }] }];

function setup(options: { claims?: Record<string, unknown>; pool?: Record<string, unknown>; signIn?: 'blocked' | 'qualification'; console?: 'blocked' | 'qualification';
  review?: 'blocked' | 'qualification'; suspension?: 'blocked' | 'qualification'; answer?: unknown } = {}) {
  const verify = vi.fn(async () => claims(options.claims));
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof DescribeUserPoolCommand) return { UserPool: { Id: OPERATOR_POOL, Arn: `arn:aws:cognito-idp:us-east-2:588966314750:userpool/${OPERATOR_POOL}`,
      MfaConfiguration: 'ON', LastModifiedDate: new Date(NOW - 86_400_000), ...options.pool } };
    if (command instanceof AdminGetUserCommand) return { Enabled: true, UserStatus: 'CONFIRMED', UserMFASettingList: ['SOFTWARE_TOKEN_MFA'],
      PreferredMfaSetting: 'SOFTWARE_TOKEN_MFA', UserLastModifiedDate: new Date(NOW - 86_400_000),
      UserAttributes: [{ Name: 'sub', Value: operator }, { Name: 'email_verified', Value: 'true' }] };
    throw new Error('unexpected command');
  });
  const queries: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const database: ClinicalCoreDatabase = { transaction: async work => work({ query: async (sql, parameters = []) => {
    queries.push({ sql, parameters });
    return { rows: [{ data: options.answer ?? LISTED }] } as never;
  } }) };
  const api = createPlatformOperatorConsoleApi({ database, release: options.console ?? 'qualification',
    proposalReviewRelease: options.review ?? 'qualification', suspensionRelease: options.suspension ?? 'qualification',
    verifiedOperatorSubject: createPlatformOperatorAuthenticator({ target, jwt: { verify }, cognito: { send }, release: options.signIn ?? 'qualification', now: () => NOW }) });
  const call = async (routeKey: string, body?: unknown, headers: Record<string, string> = { Authorization: 'Bearer aaa.bbb.ccc' }) => {
    const answer = await api({ routeKey, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Record<string, unknown>, headers: answer.headers };
  };
  return { call, verify, send, queries };
}
const LIST = 'GET /clinical-core/platform-operator/bootstrapped-clinics';
const SUSPEND = 'POST /clinical-core/platform-operator/bootstrapped-clinics/suspension';

describe('the platform operator console API', () => {
  it('ships blocked, and while blocked reads no header, token or row on any route', async () => {
    expect(PLATFORM_OPERATOR_CONSOLE_RELEASE).toBe('blocked');
    const f = setup({ console: 'blocked' });
    for (const route of PLATFORM_OPERATOR_ROUTES) {
      expect((await f.call(route, route.startsWith('POST') ? { organizationId: clinic, reason: 'security_concern' } : undefined)).body)
        .toEqual({ error: 'platform_operator_not_released' });
    }
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.queries).toEqual([]);
  });

  it('with the console released but the operator sign-in blocked, says which, and still reads nothing', async () => {
    const f = setup({ signIn: 'blocked' });
    expect(await f.call(LIST)).toMatchObject({ status: 503, body: { error: 'platform_operator_sign_in_not_released' } });
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.queries).toEqual([]);
  });

  it.each([
    ['a practitioner (workforce) token', { claims: { iss: `https://cognito-idp.us-east-2.amazonaws.com/${WORKFORCE_POOL}`, aud: WORKFORCE_CLIENT } }],
    ['an operator sign-in older than 15 minutes', { claims: { auth_time: NOW / 1000 - 16 * 60 } }],
    ['an operator pool whose MFA is only optional', { pool: { MfaConfiguration: 'OPTIONAL' } }],
  ])('refuses %s before any database transaction', async (_label, options) => {
    const f = setup(options);
    expect(await f.call(SUSPEND, { organizationId: clinic, reason: 'security_concern' })).toMatchObject({ status: 403, body: { error: 'platform_operator_refused' } });
    expect(f.queries).toEqual([]);
  });

  it('requires a sign-in, and refuses a selected clinic, a query or an unknown field before asking who the operator is', async () => {
    const f = setup();
    expect((await f.call(LIST, undefined, {})).body).toEqual({ error: 'operator_sign_in_required' });
    expect((await f.call(LIST, undefined, { Authorization: 'Bearer aaa.bbb.ccc', 'x-alp-selected-organization-id': clinic })).status).toBe(400);
    for (const body of [{ organizationId: clinic, reason: 'because' }, { organizationId: clinic, reason: 'security_concern', reinstate: true }, 'x'.repeat(2000)]) {
      expect((await f.call(SUSPEND, body)).body).toEqual({ error: 'request_invalid' });
    }
    expect((await f.call('POST /clinical-core/platform-operator/clinic-proposals/decision', { action: 'approve', requestId: randomUUID(), organizationId: clinic })).status).toBe(400);
    expect((await f.call('POST /clinical-core/platform-operator/bootstrapped-clinics/reinstatement', { organizationId: clinic })).status).toBe(404);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.queries).toEqual([]);
  });

  it('a verified operator is asked about once, and only the verified subject reaches the SQL', async () => {
    const f = setup();
    const listed = await f.call(LIST);
    expect(listed).toMatchObject({ status: 200, body: { data: { clinics: LISTED } } });
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.queries).toEqual([{ sql: 'select clinical_private.list_bootstrapped_workforce_clinics($1) as data', parameters: [operator] }]);
  });

  it('each service keeps its own release, and an answer outside the contract is never passed on', async () => {
    expect((await setup({ suspension: 'blocked' }).call(SUSPEND, { organizationId: clinic, reason: 'security_concern' })).body).toEqual({ error: 'platform_operator_not_released' });
    expect((await setup({ review: 'blocked' }).call('GET /clinical-core/platform-operator/clinic-proposals')).body).toEqual({ error: 'platform_operator_not_released' });
    const leaky = setup({ answer: [{ ...LISTED[0], ownerSubject: randomUUID() }] });
    expect((await leaky.call(LIST)).body).toEqual({ error: 'platform_operator_unavailable' });
    // An approval answered as anything but held is never shown as a decision.
    const unheld = setup({ answer: { status: 'approved', organizationId: clinic, membershipId: randomUUID(), decisionReason: 'clinic_proposal_verified', activation: null, duplicate: false } });
    expect((await unheld.call('POST /clinical-core/platform-operator/clinic-proposals/decision', { action: 'approve', requestId: randomUUID() })).body)
      .toEqual({ error: 'platform_operator_unavailable' });
  });
});
