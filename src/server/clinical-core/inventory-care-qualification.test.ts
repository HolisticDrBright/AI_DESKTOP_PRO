import { beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ADOPTED_INVENTORY_UPGRADE } from './adopted-plan-inventory-schema-upgrade';
import { INVENTORY_QUALIFICATION_PROFILE } from './adopted-plan-inventory-qualification-profile';
import { createCareMessagingHandler, createInventoryCareMessagingHandler, type CareMessagingBuild, type InventoryCareMessagingBuild } from './care-messaging-deployment';
import { createCareConnectionsHandler, createInventoryCareConnectionsHandler, type CareConnectionsBuild, type InventoryCareConnectionsBuild } from './care-connections-deployment';
import type { ApiGatewayV2Event } from './aws-identity-api';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';

// Fictional identities and review-shaped values for transport tests only.
// These are never written to deployment parameters or claimed as approvals.
const sourceCommit = '1'.repeat(40), review = '2'.repeat(64), now = 1800000000000;
const org = '11111111-1111-4111-8111-111111111111', person = '22222222-2222-4222-8222-222222222222';
let messaging: InventoryCareMessagingBuild, connections: InventoryCareConnectionsBuild;
beforeAll(() => {
  const scriptPins = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    "import {INVENTORY_PROFILE,INVENTORY_PARENT,INVENTORY_RELEASE} from './scripts/inventory-care-qualification-template.mjs';process.stdout.write(JSON.stringify({profile:INVENTORY_PROFILE,parent:INVENTORY_PARENT,release:INVENTORY_RELEASE}));"],
  { encoding: 'utf8', timeout: 10000 }));
  expect(scriptPins).toEqual({ profile: INVENTORY_QUALIFICATION_PROFILE, parent: ADOPTED_INVENTORY_UPGRADE.from, release: ADOPTED_INVENTORY_UPGRADE.to });
  const a = JSON.parse(execFileSync(process.execPath, ['scripts/build-adopted-plan-inventory-candidate.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15000 }));
  const common = { sourceCommit, sourceClean: true, migrationCount: 107 as const,
    migrationReleaseSha256: ADOPTED_INVENTORY_UPGRADE.to, qualificationProfile: INVENTORY_QUALIFICATION_PROFILE };
  const sha = (v: string) => createHash('sha256').update(v).digest('hex');
  messaging = { ...common, functions: [...a.files['20261006010000_production_care_messaging.sql'].matchAll(
    /create function (clinical_(?:core|private))\.(production_care_message_[a-z]+)\([^]*?security definer set search_path='' as \$\$([^]*?)\$\$/g)]
    .map(([, schema, name, body]) => ({ schema, name, sha256: sha(body), callable: schema === 'clinical_core' })) };
  const pins = (sql: string) => [...sql.matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
    .map(([, name, body]) => ({ name, bodySha256: sha(body), apiExecute: name.startsWith('clinical_core.') }));
  connections = { ...common, functions: pins(a.files['20261006020000_production_care_connections.sql']),
    claimFunctions: pins(a.files['20261006030000_production_care_claim_recovery.sql']) };
});
const env = (): Record<string, string | undefined> => ({ SOURCE_COMMIT: sourceCommit, MIGRATION_RELEASE_SHA256: ADOPTED_INVENTORY_UPGRADE.to,
  INVENTORY_QUALIFICATION_PROFILE, AWS_REGION: 'us-east-2', PHI_ALLOWED: 'false', DEPLOYMENT_ACCOUNT_ID: '588966314750',
  CARE_MESSAGING_ACTIVATION: 'blocked', CARE_CONNECTIONS_ACTIVATION: 'blocked',
  CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12', CLINICAL_DATABASE_NAME: 'clinical_core_qualification',
  CONSUMER_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer', CONSUMER_AUDIENCE: 'c'.repeat(26),
  WORKFORCE_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', WORKFORCE_AUDIENCE: 'w'.repeat(26),
  CARE_MESSAGING_ORGANIZATION_ID: org, CARE_CONNECTIONS_ORGANIZATION_ID: org, DATABASE_REVIEW_SHA256: review,
  WORKFORCE_MFA_REVIEW_SHA256: review, MESSAGING_REVIEW_SHA256: review, CONNECTION_REVIEW_SHA256: review,
  CONSENT_REVIEW_SHA256: review, RETENTION_REVIEW_SHA256: review, ENABLED_CONSENT_SCOPES: 'messaging',
  QUALIFICATION_EXECUTION: 'enabled', QUALIFICATION_REVIEW_SHA256: review, QUALIFICATION_ACCOUNT_ID: '588966314750',
  QUALIFICATION_IDENTITY_SUBJECTS: 'fictional-consumer-00001,fictional-workforce-00001',
});
const event = (kind: 'messaging' | 'connections', pool: 'consumer' | 'workforce' = 'consumer'): ApiGatewayV2Event => ({
  routeKey: `POST /clinical-core/${pool}/${kind === 'messaging' ? 'messages' : 'connection'}`,
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(kind === 'messaging' ? { action: 'list' }
    : pool === 'workforce' ? { action: 'issue', patientRecordId: person } : { action: 'connection' }),
  requestContext: { authorizer: { jwt: { claims: { iss: env()[pool === 'consumer' ? 'CONSUMER_ISSUER' : 'WORKFORCE_ISSUER'],
    aud: env()[pool === 'consumer' ? 'CONSUMER_AUDIENCE' : 'WORKFORCE_AUDIENCE'], sub: `fictional-${pool}-00001`, token_use: 'id',
    'custom:person_id': person, 'custom:organization_id': org, 'custom:production_bound': 'true', email_verified: true,
    iat: now / 1000 - 10, exp: now / 1000 + 1000, auth_time: now / 1000 - 10 } } } },
});
function transport(valid = true) {
  const query = vi.fn(async (sql: string, args: readonly unknown[] = []) => sql.startsWith('with expected') ? { rows: [{ valid }] }
    : sql.includes('production_care_message_request') ? { rows: [{ data: { action: 'list', threads: [], nextBefore: null } }] }
      : sql.includes('production_care_connection_request') ? { rows: [{ data: String(args[0]).includes('issue')
        ? { ok: true, message: 'Invitation created', connectionId: org, invitationId: person, token: 'ABCDEFGHJKLMN',
          expiresAt: '2027-01-01T00:00:00Z', state: 'invitation_pending', version: 1 } : { connection: null } }] } : { rows: [] });
  const database: ClinicalCoreDatabase = { transaction: work => work({ query } as unknown as ClinicalCoreTransaction) };
  return { query, factory: vi.fn(() => database) };
}
for (const kind of ['messaging', 'connections'] as const) describe(`distinct 107 ${kind} qualification entry point (fictional transport)`, () => {
  const make = (e: Record<string, string | undefined>, t: ReturnType<typeof transport>, b = kind === 'messaging' ? messaging : connections) =>
    kind === 'messaging' ? createInventoryCareMessagingHandler(e, b as InventoryCareMessagingBuild, t.factory, () => now)
      : createInventoryCareConnectionsHandler(e, b as InventoryCareConnectionsBuild, t.factory, () => now);
  it('admits designated identities with qualification markings and rechecks metadata on every transaction', async () => {
    const t = transport(), handle = make(env(), t);
    for (const pool of ['consumer', 'workforce'] as const) expect(await handle(event(kind, pool))).toMatchObject({
      statusCode: 200, headers: { 'x-clinical-execution': 'qualification' } });
    expect(t.factory).toHaveBeenCalledOnce(); expect(t.query.mock.calls.filter(([sql]) => sql.startsWith('with expected'))).toHaveLength(2);
  });
  it('is disabled by default without constructing a database client', async () => {
    const t = transport(); expect((await make({ ...env(), QUALIFICATION_EXECUTION: 'disabled' }, t)(event(kind))).statusCode).toBe(503);
    expect(t.factory).not.toHaveBeenCalled();
  });
  it('requires the service-specific reviews without substituting a general qualification review', async () => {
    for (const key of kind === 'messaging' ? ['MESSAGING_REVIEW_SHA256'] : ['CONNECTION_REVIEW_SHA256', 'CONSENT_REVIEW_SHA256']) {
      const t = transport(); expect((await make({ ...env(), [key]: '' }, t)(event(kind))).statusCode).toBe(503);
      expect(t.factory).not.toHaveBeenCalled();
    }
  });
  it.each([
    ['INVENTORY_QUALIFICATION_PROFILE', ''], ['INVENTORY_QUALIFICATION_PROFILE', 'legacy'], ['SOURCE_COMMIT', '3'.repeat(40)],
    ['MIGRATION_RELEASE_SHA256', ADOPTED_INVENTORY_UPGRADE.from], ['PHI_ALLOWED', 'true'], ['AWS_REGION', 'us-west-2'],
    ['DEPLOYMENT_ACCOUNT_ID', '173535830222'], ['CLINICAL_DATABASE_NAME', 'clinical_core'],
    ['CLINICAL_DATABASE_NAME', 'other_qualification'], ['QUALIFICATION_EXECUTION', 'invented'], ['QUALIFICATION_ACCOUNT_ID', '173535830222'],
    ['CLINICAL_DATABASE_CLUSTER_ARN', 'arn:aws:rds:us-east-2:173535830222:cluster:fictional'],
    ['CLINICAL_DATABASE_SECRET_ARN', 'arn:aws:secretsmanager:us-east-2:173535830222:secret:fictional'],
    ['DATABASE_REVIEW_SHA256', ''], ['WORKFORCE_MFA_REVIEW_SHA256', ''], ['RETENTION_REVIEW_SHA256', ''],
    ['QUALIFICATION_REVIEW_SHA256', ''], ['QUALIFICATION_IDENTITY_SUBJECTS', ''],
  ])('refuses changed %s before data construction or qualification marking', async (key, value) => {
    const t = transport(), response = await make({ ...env(), [key]: value }, t)(event(kind));
    expect(response.statusCode).toBe(503); expect(response.headers).not.toHaveProperty('x-clinical-execution'); expect(t.factory).not.toHaveBeenCalled();
  });
  it('cannot enable production or substitute 106 metadata at the 107 entry point', async () => {
    const base = kind === 'messaging' ? messaging : connections;
    for (const b of [{ ...base, migrationCount: 106 }, { ...base, sourceClean: false }, { ...base, functions: [] },
      { ...base, qualificationProfile: 'legacy' }, { ...base, migrationReleaseSha256: ADOPTED_INVENTORY_UPGRADE.from }]) {
      const t = transport(); expect((await make(env(), t, b as typeof base)(event(kind))).statusCode).toBe(503); expect(t.factory).not.toHaveBeenCalled();
    }
    const t = transport(); expect((await make({ ...env(), [kind === 'messaging' ? 'CARE_MESSAGING_ACTIVATION' : 'CARE_CONNECTIONS_ACTIVATION']: 'approved' }, t)(event(kind))).statusCode).toBe(503);
    expect(t.factory).not.toHaveBeenCalled();
  });
  it('leaves the historical 106 entry point refusing a 107 build', async () => {
    const t = transport(); const handle = kind === 'messaging'
      ? createCareMessagingHandler(env(), messaging as unknown as CareMessagingBuild, t.factory, () => now)
      : createCareConnectionsHandler(env(), connections as unknown as CareConnectionsBuild, t.factory, () => now);
    expect((await handle(event(kind))).statusCode).toBe(503); expect(t.factory).not.toHaveBeenCalled();
  });
  it('captures environment and compiled metadata before lazy initialization', async () => {
    const e = env(), b = structuredClone(kind === 'messaging' ? messaging : connections), t = transport(), handle = make(e, t, b);
    e.CLINICAL_DATABASE_NAME = 'clinical_core'; e.PHI_ALLOWED = 'true'; b.functions = []; b.sourceClean = false;
    expect((await handle(event(kind))).statusCode).toBe(200);
    expect(t.factory).toHaveBeenCalledWith(expect.objectContaining({ databaseName: 'clinical_core_qualification' }));
  });
  it('refuses absent, foreign and stale identities before database access', async () => {
    const t = transport(), handle = make(env(), t), noClaims = { ...event(kind), requestContext: undefined };
    expect((await handle(noClaims)).statusCode).toBe(401);
    const foreign = event(kind); foreign.requestContext!.authorizer!.jwt!.claims!.sub = 'fictional-other-owner';
    expect((await handle(foreign)).statusCode).toBe(503);
    const stale = event(kind, 'workforce'); stale.requestContext!.authorizer!.jwt!.claims!.auth_time = now / 1000 - 901;
    expect((await handle(stale)).statusCode).toBe(401); expect(t.factory).not.toHaveBeenCalled();
  });
  it('refuses metadata drift without querying business data or exposing database errors', async () => {
    const t = transport(false), reply = await make(env(), t)(event(kind));
    expect(reply).toMatchObject({ statusCode: 503, body: '{"error":"service_unavailable"}' }); expect(t.query).toHaveBeenCalledOnce();
  });
});
