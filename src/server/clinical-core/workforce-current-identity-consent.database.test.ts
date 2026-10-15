import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createAwsProductionIdentityApiHandler, type ApiGatewayV2Event, type ProductionIdentityApiConfiguration } from './aws-identity-api';
import { createAwsProductionIdentityConsentAdapter } from './aws-identity-consent';
import { createAwsProductionClinicalStateAdapter } from './aws-clinical-state';
import { createAwsProductionConsumerClinicalRecordsAdapter } from './aws-consumer-clinical-records';
import { createAwsProductionDesktopAdapter } from './aws-production-desktop';
import type { ClinicalCoreDatabase } from './database';
import { classifyDatabaseRejection } from './rds-data-database';

// The workforce identity and consent family under the unactivated `database_current` authority: the real production
// handler and adapters over the assembled production schema plus the UNREGISTERED current-membership setter, in PGlite
// with fictional rows. Nothing here registers, applies or deploys SQL.
const CANDIDATE = 'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql';
const ROLLBACK = 'infra/aws-clinical-core/source-candidates/workforce-current-membership-context-rollback.sql';
const ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AZMa5gxSZ';
const AUDIENCE = '67moqjql53ms7247tphe5ftpd8';
const CLINIC = randomUUID(), OTHER = randomUUID(), FOREIGN = randomUUID();
const person = () => ({ person: randomUUID(), sub: randomUUID() });
const practitioner = person(), staff = person(), applicant = person(), outsider = person(), consumer = person();
const unlinkedSub = randomUUID();
// `patient` has a verified app connection (consent); `invitee` has none yet (invitations).
const patient = randomUUID(), invitee = randomUUID(), connection = randomUUID(), artifact = randomUUID();

// Every route the current authority now answers, beside the Desktop compatibility route converted before this change.
const CONVERTED = [
  'GET /clinical-core/workforce/posture',
  'POST /clinical-core/workforce/invitations',
  'POST /clinical-core/workforce/consents/grant',
  'POST /clinical-core/workforce/consents/revoke',
  'GET /clinical-core/workforce/consent-artifact',
  'GET /clinical-core/workforce/consents/current',
  'POST /clinical-core/workforce/data-compatibility',
];

// Answered by the current authority with no selected clinic (workforce-membership-discovery.database.test.ts).
const SUBJECT_ONLY = ['GET /clinical-core/workforce/memberships/current'];

let db: PGlite;
let outage = false;
let atStart: ((tx: Transaction) => Promise<void>) | undefined;
let afterBinding: ((tx: Transaction) => Promise<void>) | undefined;
const queries: string[] = [];
const unwrap = (value: unknown) => value && typeof value === 'object' && 'kind' in value && value.kind === 'uuid'
  && 'value' in value && typeof value.value === 'string' ? value.value : value;
const database: ClinicalCoreDatabase = {
  transaction: async (work) => {
    if (outage) throw new Error('connect ECONNREFUSED 10.0.0.1:5432');
    try {
      return await db.transaction(async (tx) => {
        if (atStart) await atStart(tx);
        await tx.exec('set local role clinical_core_api');
        return work({ query: async (sql, parameters = []) => {
          queries.push(sql);
          const result = await tx.query(sql, parameters.map(unwrap));
          if (sql.includes('set_current_workforce_context') && afterBinding) await afterBinding(tx);
          return result as never;
        } });
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message }) ?? cause;
    }
  },
};

const legacy = createAwsProductionIdentityConsentAdapter(database);
const desktop = createAwsProductionDesktopAdapter(database);
const configuration: ProductionIdentityApiConfiguration = {
  workforceIssuer: ISSUER, workforceAudience: AUDIENCE,
  consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalConsumer',
  consumerAudience: 'fictionalconsumerclient0000',
  phiAllowed: true, activationState: 'approved', activationEvidenceSha256: 'f'.repeat(64),
  pilotScope: 'lab_intake_only', pilotOrganizationId: CLINIC, authorityMode: 'database_current',
};
const handler = createAwsProductionIdentityApiHandler({
  adapter: legacy,
  clinicalStateAdapter: createAwsProductionClinicalStateAdapter(database),
  clinicalRecordsAdapter: createAwsProductionConsumerClinicalRecordsAdapter(database),
  desktopCompatibilityAdapter: desktop,
  configuration,
});

type Call = { sub: string; clinic?: string | null; body?: unknown; query?: Record<string, string>;
  claims?: Record<string, string>; headers?: Record<string, string> };
function event(routeKey: string, call: Call): ApiGatewayV2Event {
  const now = Math.floor(Date.now() / 1000);
  return {
    routeKey,
    headers: { 'content-type': 'application/json',
      ...(call.clinic === null ? {} : { 'x-alp-selected-organization-id': call.clinic ?? CLINIC }), ...call.headers },
    body: call.body === undefined ? null : JSON.stringify(call.body),
    queryStringParameters: call.query ?? null,
    requestContext: { accountId: '173535830222', authorizer: { jwt: { claims: {
      iss: ISSUER, aud: AUDIENCE, token_use: 'id', sub: call.sub, email_verified: 'true',
      iat: String(now - 60), auth_time: String(now - 60), exp: String(now + 3600), ...call.claims,
    } } } },
  };
}
async function call(routeKey: string, input: Call) {
  const result = await handler(event(routeKey, input));
  return { status: result.statusCode, body: JSON.parse(result.body) as Record<string, unknown> };
}
const posture = (input: Call) => call('GET /clinical-core/workforce/posture', input);
const issue = (input: Call, key = `issue-${randomUUID()}`) => call('POST /clinical-core/workforce/invitations', {
  ...input, body: { patientRecordId: invitee, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), idempotencyKey: key } });
const grant = (input: Call) => call('POST /clinical-core/workforce/consents/grant', {
  ...input, body: { connectionId: connection, artifactId: artifact, scope: 'forms_checkins', method: 'in_person', representativeAuthority: 'self' } });
const revoke = (input: Call) => call('POST /clinical-core/workforce/consents/revoke', {
  ...input, body: { connectionId: connection, scope: 'forms_checkins', reasonCode: 'patient_request' } });
const organizations = (input: Call) => call('POST /clinical-core/workforce/data-compatibility', {
  ...input, body: { kind: 'rpc', functionName: 'list_my_organizations', args: {} } });
const count = async (sql: string, parameters: unknown[] = []) =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, parameters)).rows[0]!.n);
const membership = (who: { person: string }, clinic: string, set: string) => db.query(
  `update clinical_core.organization_memberships set ${set} where organization_id=$1 and person_id=$2`, [clinic, who.person]);
async function suspended<T>(who: { person: string }, clinic: string, work: () => Promise<T>) {
  await membership(who, clinic, "status='suspended'");
  try { return await work(); } finally { await membership(who, clinic, "status='active'"); }
}
const REFUSED = { status: 403, body: { error: 'production_boundary_refused' } };
const HANDLER_REFUSED = { status: 403, body: { error: 'identity_refused' } };

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, [
    'scripts/build-aws-production-clinical-core.mjs', '--json',
  ], { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  expect(manifest.migrations.some((m: { file: string }) => m.file.includes('current-membership-context'))).toBe(false);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
  await db.exec(readFileSync(CANDIDATE, 'utf8'));
  await db.query(`insert into clinical_core.organizations(id,organization_label)
    values($1,'FICTIONAL PILOT CLINIC'),($2,'FICTIONAL SECOND CLINIC'),($3,'FICTIONAL FOREIGN CLINIC')`, [CLINIC, OTHER, FOREIGN]);
  for (const [who, pool] of [[practitioner, 'workforce'], [staff, 'workforce'], [applicant, 'workforce'], [outsider, 'workforce'], [consumer, 'consumer']] as const) {
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [who.person, `subject_${who.person.replaceAll('-', '')}`]);
    await db.query(`insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound)
      values($1,$2,$3,true)`, [who.person, pool, who.sub]);
  }
  await db.query(`insert into clinical_core.organization_memberships(organization_id,person_id,role,status) values
    ($1,$2,'practitioner','active'),($3,$2,'staff','active'),($1,$4,'staff','active'),($1,$5,'practitioner','pending'),
    ($6,$7,'practitioner','active')`, [CLINIC, practitioner.person, OTHER, staff.person, applicant.person, FOREIGN, outsider.person]);
  await db.query(`insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name)
    values($1,$2,$3,'Fictional','Patient'),($4,$2,$5,'Fictional','Invitee')`,
    [patient, CLINIC, `patient_${patient.replaceAll('-', '')}`, invitee, `patient_${invitee.replaceAll('-', '')}`]);
  await db.query(`insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at)
    values($1,$2,$3,$4,'verified',clock_timestamp())`, [connection, CLINIC, patient, consumer.person]);
  await db.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,
    status,approved_at,approved_by_person_id) values($1,$2,'forms_checkins','fictional-1',$3,'US-FICTIONAL','approved',clock_timestamp(),$4)`,
  [artifact, CLINIC, 'c'.repeat(64), practitioner.person]);
}, 120_000);
afterAll(async () => { await db?.close(); });
beforeEach(() => {
  outage = false; atStart = undefined; afterBinding = undefined; queries.length = 0;
  vi.restoreAllMocks();
  for (const name of ['getCurrentConsentArtifact', 'getCurrentConsent', 'issueInvitation', 'claimInvitation', 'recordConsent', 'revokeConsent'] as const) {
    vi.spyOn(legacy, name);
  }
  vi.spyOn(desktop, 'execute');
});
function expectNoLegacyAuthority() {
  for (const name of ['getCurrentConsentArtifact', 'getCurrentConsent', 'issueInvitation', 'claimInvitation', 'recordConsent', 'revokeConsent'] as const) {
    expect(legacy[name], name).not.toHaveBeenCalled();
  }
  expect(desktop.execute).not.toHaveBeenCalled();
  expect(queries.filter((sql) => sql.includes('set_request_context'))).toEqual([]);
}

describe('workforce identity and consent under current database membership', () => {
  it('serves an approved one-login practitioner with no clinic claims, from current rows in the operation transaction', async () => {
    const who = { sub: practitioner.sub };
    expect(await posture(who)).toMatchObject({ status: 200, body: { data: {
      contractVersion: 'clinical-core/1', identityPool: 'workforce', authenticated: true, pilotScope: 'lab_intake_only',
      membership: { organizationId: CLINIC, role: 'practitioner' },
    } } });
    const issued = await issue(who);
    expect(issued.status).toBe(201);
    const invitation = (issued.body.data as { invitationId: string }).invitationId;
    expect((await db.query('select created_by_person_id from clinical_core.connection_invitations where id=$1', [invitation])).rows)
      .toEqual([{ created_by_person_id: practitioner.person }]);
    const artifactRead = await call('GET /clinical-core/workforce/consent-artifact', { ...who, query: { scope: 'forms_checkins' } });
    expect(artifactRead).toEqual({ status: 403, body: { error: 'pilot_scope_refused' } });
    const granted = await grant(who);
    expect(granted).toMatchObject({ status: 201, body: { data: { connectionId: connection, scope: 'forms_checkins', status: 'granted' } } });
    expect((await db.query(`select recorded_by_person_id from clinical_core.consent_grants where id=$1`,
      [(granted.body.data as { consentId: string }).consentId])).rows).toEqual([{ recorded_by_person_id: practitioner.person }]);
    expect(await revoke(who)).toMatchObject({ status: 201, body: { data: { status: 'revoked' } } });
    expect(queries.filter((sql) => sql.includes('set_current_workforce_context'))).toHaveLength(4);
    expectNoLegacyAuthority();
  });

  it('ignores clinic, person and role claims in the token: the subject current rows decide', async () => {
    const forged = { 'custom:person_id': outsider.person, 'custom:organization_id': FOREIGN, 'custom:role': 'owner',
      'custom:production_bound': 'true', 'cognito:groups': 'owner' };
    const granted = await grant({ sub: practitioner.sub, claims: forged });
    expect(granted.status).toBe(201);
    expect((await db.query('select recorded_by_person_id from clinical_core.consent_grants where id=$1',
      [(granted.body.data as { consentId: string }).consentId])).rows).toEqual([{ recorded_by_person_id: practitioner.person }]);
    expect((await revoke({ sub: practitioner.sub })).status).toBe(201);
    // A staff member's token claiming owner cannot issue; a foreign clinic's practitioner claiming this clinic cannot either.
    const before = await count('clinical_core.connection_invitations');
    expect(await issue({ sub: staff.sub, claims: forged })).toEqual(REFUSED);
    expect(await issue({ sub: outsider.sub, claims: { ...forged, 'custom:organization_id': CLINIC } })).toEqual(REFUSED);
    expect(await count('clinical_core.connection_invitations')).toBe(before);
    expectNoLegacyAuthority();
  });

  it('refuses no membership, a pending application, a suspension and an unlinked subject, before any write', async () => {
    const before = await count('clinical_core.connection_invitations');
    const grants = await count('clinical_core.consent_grants');
    for (const sub of [outsider.sub, applicant.sub, unlinkedSub]) {
      expect(await posture({ sub }), sub).toEqual(REFUSED);
      expect(await issue({ sub }), sub).toEqual(REFUSED);
      expect(await grant({ sub }), sub).toEqual(REFUSED);
    }
    await suspended(practitioner, CLINIC, async () => {
      expect(await posture({ sub: practitioner.sub })).toEqual(REFUSED);
      expect(await issue({ sub: practitioner.sub })).toEqual(REFUSED);
      expect(await grant({ sub: practitioner.sub })).toEqual(REFUSED);
    });
    await db.query("update clinical_core.identities set status='disabled' where identity_subject=$1", [practitioner.sub]);
    try { expect(await posture({ sub: practitioner.sub })).toEqual(REFUSED); }
    finally { await db.query("update clinical_core.identities set status='active' where identity_subject=$1", [practitioner.sub]); }
    await db.query("update clinical_core.organizations set status='suspended' where id=$1", [CLINIC]);
    try { expect(await posture({ sub: practitioner.sub })).toEqual(REFUSED); }
    finally { await db.query("update clinical_core.organizations set status='active' where id=$1", [CLINIC]); }
    expect(await count('clinical_core.connection_invitations')).toBe(before);
    expect(await count('clinical_core.consent_grants')).toBe(grants);
    expectNoLegacyAuthority();
  });

  it('refuses a wrong, missing or ambiguous clinic selection', async () => {
    // Outside the pilot: refused by the handler before the database is reached, even where the person is a member.
    expect(await posture({ sub: practitioner.sub, clinic: OTHER })).toEqual(HANDLER_REFUSED);
    expect(await posture({ sub: practitioner.sub, clinic: null })).toEqual(HANDLER_REFUSED);
    expect(await posture({ sub: practitioner.sub, clinic: `${CLINIC},${OTHER}` })).toEqual(HANDLER_REFUSED);
    // Two selections in one request: refused, not decided by whichever header is read first. This was admitted on the
    // Desktop compatibility route before this change.
    for (const second of [OTHER, CLINIC]) {
      const headers = { 'X-ALP-Selected-Organization-Id': second };
      expect(await posture({ sub: practitioner.sub, headers })).toEqual(HANDLER_REFUSED);
      expect(await organizations({ sub: practitioner.sub, headers })).toEqual(HANDLER_REFUSED);
    }
    expect(queries).toEqual([]);
    // In the pilot clinic, but not a clinic this person belongs to: refused by current rows.
    expect(await posture({ sub: outsider.sub })).toEqual(REFUSED);
    expectNoLegacyAuthority();
  });

  it('applies a role change on the next request: demoted to staff keeps posture only; demoted to member is refused', async () => {
    const who = { sub: practitioner.sub };
    await membership(practitioner, CLINIC, "role='staff'");
    try {
      expect(await posture(who)).toMatchObject({ status: 200, body: { data: { membership: { organizationId: CLINIC, role: 'staff' } } } });
      expect(await issue(who)).toEqual(REFUSED);
      expect(await grant(who)).toEqual(REFUSED);
      await membership(practitioner, CLINIC, "role='member'");
      expect(await posture(who)).toEqual(REFUSED);
    } finally { await membership(practitioner, CLINIC, "role='practitioner'"); }
    expect((await issue(who)).status).toBe(201);
    expectNoLegacyAuthority();
  });

  it('refuses a stale session: an expired token at the handler, and an unexpired token after its membership ended', async () => {
    const expired = { exp: String(Math.floor(Date.now() / 1000) - 1) };
    expect(await posture({ sub: practitioner.sub, claims: expired })).toEqual(HANDLER_REFUSED);
    expect(await organizations({ sub: practitioner.sub, claims: expired })).toEqual(HANDLER_REFUSED);
    expect(await posture({ sub: practitioner.sub, claims: { exp: '' } })).toEqual(HANDLER_REFUSED);
    expect(queries).toEqual([]);
    const signedInLongAgo = { auth_time: String(Math.floor(Date.now() / 1000) - 30 * 86_400) };
    expect((await posture({ sub: practitioner.sub, claims: signedInLongAgo })).status).toBe(200);
    await suspended(practitioner, CLINIC, async () => {
      expect(await posture({ sub: practitioner.sub, claims: signedInLongAgo })).toEqual(REFUSED);
      expect(await organizations({ sub: practitioner.sub })).toEqual({ status: 403, body: { error: 'identity_refused' } });
    });
    expectNoLegacyAuthority();
  });

  it('changes nothing twice for a duplicate request: a repeated invitation key, a second grant and a second revoke', async () => {
    const who = { sub: practitioner.sub }, key = `duplicate-${randomUUID()}`;
    expect((await issue(who, key)).status).toBe(201);
    expect(await issue(who, key)).toEqual({ status: 400, body: { error: 'request_context_invalid' } });
    expect(await count('clinical_core.connection_invitations where idempotency_key=$1', [key])).toBe(1);
    const grants = await count('clinical_core.consent_grants where connection_id=$1', [connection]);
    expect((await grant(who)).status).toBe(201);
    expect(await grant(who)).toEqual({ status: 409, body: { error: 'consent_precondition_failed' } });
    expect((await revoke(who)).status).toBe(201);
    expect(await revoke(who)).toEqual({ status: 409, body: { error: 'consent_precondition_failed' } });
    expect(await count('clinical_core.consent_grants where connection_id=$1', [connection])).toBe(grants + 2);
    expectNoLegacyAuthority();
  });

  it('decides each device on its own request: a second session is admitted, and one suspension stops both', async () => {
    const now = Math.floor(Date.now() / 1000);
    const deviceA = { sub: practitioner.sub, claims: { iat: String(now - 7200), auth_time: String(now - 7200), jti: randomUUID() } };
    const deviceB = { sub: practitioner.sub, claims: { iat: String(now - 30), auth_time: String(now - 30), jti: randomUUID() } };
    expect((await posture(deviceA)).status).toBe(200);
    expect((await posture(deviceB)).status).toBe(200);
    expect(await posture({ ...deviceB, clinic: OTHER })).toEqual(HANDLER_REFUSED);
    expect((await posture(deviceA)).status).toBe(200);
    await suspended(practitioner, CLINIC, async () => {
      expect(await posture(deviceA)).toEqual(REFUSED);
      expect(await issue(deviceB)).toEqual(REFUSED);
    });
    expect((await issue(deviceB)).status).toBe(201);
    expectNoLegacyAuthority();
  });

  it('selects the clinic per request at the adapter: two approved clinics keep their own roles', async () => {
    const current = legacy.currentMembership!;
    expect(await current.posture({ subject: practitioner.sub, selectedOrganizationId: CLINIC })).toEqual({ organizationId: CLINIC, role: 'practitioner' });
    expect(await current.posture({ subject: practitioner.sub, selectedOrganizationId: OTHER })).toEqual({ organizationId: OTHER, role: 'staff' });
    await expect(current.issueInvitation({ subject: practitioner.sub, selectedOrganizationId: OTHER }, {
      patientRecordId: invitee, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })).rejects.toMatchObject({ category: 'production_boundary_refused' });
    expect(await current.posture({ subject: practitioner.sub, selectedOrganizationId: CLINIC })).toEqual({ organizationId: CLINIC, role: 'practitioner' });
    await expect(current.posture({ subject: 'not-a-subject', selectedOrganizationId: CLINIC })).rejects.toMatchObject({ category: 'production_boundary_refused' });
    expect(queries.filter((sql) => sql.includes('set_request_context'))).toEqual([]);
  });

  it('answers an outage with 503 and never falls back: database unreachable, or the membership setter not installed', async () => {
    outage = true;
    expect(await posture({ sub: practitioner.sub })).toEqual({ status: 503, body: { error: 'database_unavailable' } });
    expect(await grant({ sub: practitioner.sub })).toEqual({ status: 503, body: { error: 'database_unavailable' } });
    outage = false;
    atStart = async (tx) => { await tx.exec('drop function clinical_private.set_current_workforce_context(text,uuid,text)'); };
    const before = await count('clinical_core.connection_invitations');
    expect(await posture({ sub: practitioner.sub })).toEqual({ status: 503, body: { error: 'database_unavailable' } });
    expect(await issue({ sub: practitioner.sub })).toEqual({ status: 503, body: { error: 'database_unavailable' } });
    atStart = undefined;
    expect(await count('clinical_core.connection_invitations')).toBe(before);
    expect((await posture({ sub: practitioner.sub })).status).toBe(200);
    expectNoLegacyAuthority();
  });

  it('rolls the candidate back preservingly: only the setter goes, and current-mode requests then refuse with 503', async () => {
    const catalog = (tx: Transaction) => tx.query<{ entry: string }>(`select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'
      ||md5(pg_get_functiondef(p.oid))||coalesce(array_to_string(p.proacl,','),'') as entry from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname like 'clinical%' order by 1`).then((result) => result.rows.map((row) => row.entry));
    const rows = (tx: Transaction) => tx.query<{ entry: string }>(`select relname||':'||n_live_tup as entry from pg_stat_user_tables
      where schemaname like 'clinical%' order by 1`).then((result) => result.rows.map((row) => row.entry));
    const policies = (tx: Transaction) => tx.query<{ entry: string }>(`select schemaname||'.'||tablename||'.'||policyname||md5(coalesce(qual,'')||coalesce(with_check,''))
      as entry from pg_policies order by 1`).then((result) => result.rows.map((row) => row.entry));
    await db.transaction(async (tx) => {
      const [beforeCatalog, beforeRows, beforePolicies] = [await catalog(tx), await rows(tx), await policies(tx)];
      await tx.exec(readFileSync(ROLLBACK, 'utf8'));
      const afterCatalog = await catalog(tx);
      expect(beforeCatalog.filter((entry) => !afterCatalog.includes(entry)).map((entry) => entry.split('(')[0]))
        .toEqual(['clinical_private.set_current_workforce_context']);
      expect(afterCatalog.filter((entry) => !beforeCatalog.includes(entry))).toEqual([]);
      expect(await rows(tx)).toEqual(beforeRows);
      expect(await policies(tx)).toEqual(beforePolicies);
      await expect(tx.exec(readFileSync(ROLLBACK, 'utf8'))).rejects.toThrow(/does not exist/);
      await tx.rollback();
    });
    // Inside each request, the same rollback leaves the handler refusing rather than falling back.
    atStart = async (tx) => { await tx.exec(readFileSync(ROLLBACK, 'utf8')); };
    expect(await posture({ sub: practitioner.sub })).toEqual({ status: 503, body: { error: 'database_unavailable' } });
    expect(await grant({ sub: practitioner.sub })).toEqual({ status: 503, body: { error: 'database_unavailable' } });
    expect(await organizations({ sub: practitioner.sub })).toEqual({ status: 503, body: { error: 'database_unavailable' } });
    atStart = undefined;
    expect((await posture({ sub: practitioner.sub })).status).toBe(200);
    expectNoLegacyAuthority();
  });

  it('rolls the write back when authority is lost inside the operation, after the membership was bound', async () => {
    afterBinding = async (tx) => {
      await tx.exec(`reset role; update clinical_core.organization_memberships set status='suspended'
        where organization_id='${CLINIC}' and person_id='${practitioner.person}'; set local role clinical_core_api`);
    };
    const invitations = await count('clinical_core.connection_invitations');
    const grants = await count('clinical_core.consent_grants where connection_id=$1', [connection]);
    expect(await issue({ sub: practitioner.sub })).toEqual(REFUSED);
    expect(await grant({ sub: practitioner.sub })).toEqual(REFUSED);
    afterBinding = undefined;
    expect(await count('clinical_core.connection_invitations')).toBe(invitations);
    expect(await count('clinical_core.consent_grants where connection_id=$1', [connection])).toBe(grants);
    // The simulated revocation ran inside the refused transaction and rolled back with it.
    expect((await posture({ sub: practitioner.sub })).status).toBe(200);
    expectNoLegacyAuthority();
  });

  it('neither infers nor requires MFA from the token: an MFA-looking claim admits no one and its absence refuses no member', async () => {
    const mfa = { amr: 'mfa', 'custom:mfa_verified': 'true' };
    expect(await posture({ sub: applicant.sub, claims: mfa })).toEqual(REFUSED);
    expect(await posture({ sub: outsider.sub, claims: mfa })).toEqual(REFUSED);
    expect((await posture({ sub: practitioner.sub })).status).toBe(200);
    expect((await posture({ sub: practitioner.sub, claims: mfa })).status).toBe(200);
    expectNoLegacyAuthority();
  });

  it('refuses every unconverted workforce route with 503 before reading the database; consumer routes keep their own path', async () => {
    const source = readFileSync('src/server/clinical-core/aws-identity-api.ts', 'utf8');
    const routes = [...source.matchAll(/"((?:GET|POST) \/clinical-core\/workforce\/[^"]+)"/g)].map((match) => match[1]!);
    // The handler's own list must be exactly this one: a route cannot join the current authority unnoticed.
    expect((await import('./aws-identity-api')).CURRENT_MEMBERSHIP_WORKFORCE_ROUTES).toEqual([...CONVERTED].sort());
    // The one subject-only route (first-clinic discovery) is named too; it is tested in its own file.
    expect((await import('./aws-identity-api')).SUBJECT_ONLY_WORKFORCE_ROUTES).toEqual([...SUBJECT_ONLY]);
    const unconverted = [...new Set(routes)].filter((route) => !CONVERTED.includes(route) && !SUBJECT_ONLY.includes(route));
    expect(new Set(routes).size).toBe(unconverted.length + CONVERTED.length + SUBJECT_ONLY.length);
    for (const route of unconverted) {
      const result = await handler(event(route, { sub: practitioner.sub, body: {}, claims: {
        'custom:person_id': practitioner.person, 'custom:organization_id': CLINIC, 'custom:production_bound': 'true' } }));
      expect([route, result.statusCode, JSON.parse(result.body)]).toEqual(
        [route, ...(PILOT_ROUTE(route) ? [503, { error: 'membership_authority_not_configured' }] : [403, { error: 'pilot_scope_refused' }])]);
    }
    expect(queries).toEqual([]);
    expectNoLegacyAuthority();
  });
});

function PILOT_ROUTE(route: string) {
  return ['GET /clinical-core/workforce/lab-imports', 'POST /clinical-core/workforce/lab-imports/review',
    'GET /clinical-core/workforce/patient-labs'].includes(route);
}
