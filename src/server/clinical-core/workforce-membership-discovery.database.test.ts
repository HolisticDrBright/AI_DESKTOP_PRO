import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
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

// Subject-only clinic discovery under the unactivated `database_current` authority: the real production handler and
// adapter over the assembled production schema plus the two UNREGISTERED candidates (the current-membership setter and
// the discovery function), in PGlite with fictional rows. Nothing here registers, applies or deploys SQL.
const SETTER = 'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql';
const DISCOVERY = 'infra/aws-clinical-core/source-candidates/workforce-membership-discovery.sql';
const ROLLBACK = 'infra/aws-clinical-core/source-candidates/workforce-membership-discovery-rollback.sql';
const ROUTE = 'GET /clinical-core/workforce/memberships/current';
const ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AZMa5gxSZ';
const AUDIENCE = '67moqjql53ms7247tphe5ftpd8';
const PILOT = randomUUID(), SECOND = randomUUID(), CLOSED = randomUUID();
const person = () => ({ person: randomUUID(), sub: randomUUID() });
// practitioner: active in PILOT and SECOND; applicant: pending in PILOT; suspended: suspended in PILOT;
// member: the non-clinical role in PILOT; closedOnly: active only in an archived clinic; newcomer: no membership.
const practitioner = person(), applicant = person(), suspended = person(), member = person(), closedOnly = person();
const newcomer = person(), inactive = person(), consumer = person();
const PATIENT = randomUUID();

let db: PGlite;
const queries: string[] = [];
const unwrap = (value: unknown) => value && typeof value === 'object' && 'kind' in value && value.kind === 'uuid'
  && 'value' in value && typeof value.value === 'string' ? value.value : value;
const database: ClinicalCoreDatabase = {
  transaction: async (work) => {
    try {
      return await db.transaction(async (tx) => {
        await tx.exec('set local role clinical_core_api');
        return work({ query: async (sql, parameters = []) => {
          queries.push(sql);
          return await tx.query(sql, parameters.map(unwrap)) as never;
        } });
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message }) ?? cause;
    }
  },
};
const adapter = createAwsProductionIdentityConsentAdapter(database);
const configuration = (overrides: Partial<ProductionIdentityApiConfiguration> = {}): ProductionIdentityApiConfiguration => ({
  workforceIssuer: ISSUER, workforceAudience: AUDIENCE,
  consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalConsumer',
  consumerAudience: 'fictionalconsumerclient0000',
  phiAllowed: true, activationState: 'approved', activationEvidenceSha256: 'f'.repeat(64),
  pilotScope: 'lab_intake_only', pilotOrganizationId: PILOT, authorityMode: 'database_current', ...overrides,
});
const handlerFor = (config = configuration()) => createAwsProductionIdentityApiHandler({
  adapter,
  clinicalStateAdapter: createAwsProductionClinicalStateAdapter(database),
  clinicalRecordsAdapter: createAwsProductionConsumerClinicalRecordsAdapter(database),
  desktopCompatibilityAdapter: createAwsProductionDesktopAdapter(database),
  configuration: config,
});

function event(sub: string, options: { claims?: Record<string, string>; headers?: Record<string, string>; body?: string;
  query?: Record<string, string>; accountId?: string } = {}): ApiGatewayV2Event {
  const now = Math.floor(Date.now() / 1000);
  return {
    routeKey: ROUTE,
    headers: { ...options.headers },
    body: options.body ?? null,
    queryStringParameters: options.query ?? null,
    requestContext: { accountId: options.accountId ?? '173535830222', authorizer: { jwt: { claims: {
      iss: ISSUER, aud: AUDIENCE, token_use: 'id', sub, email_verified: 'true', exp: String(now + 3600), ...options.claims,
    } } } },
  };
}
async function discover(sub: string, options: Parameters<typeof event>[1] = {}, handler = handlerFor()) {
  const result = await handler(event(sub, options));
  return { status: result.statusCode, body: JSON.parse(result.body) as Record<string, unknown> };
}
const membership = (who: { person: string }, clinic: string, set: string) => db.query(
  `update clinical_core.organization_memberships set ${set} where organization_id=$1 and person_id=$2`, [clinic, who.person]);

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, [
    'scripts/build-aws-production-clinical-core.mjs', '--json',
  ], { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  expect(manifest.migrations.some((m: { file: string }) => /membership-discovery|current-membership-context/.test(m.file))).toBe(false);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
  await db.exec(readFileSync(SETTER, 'utf8'));
  await db.exec(readFileSync(DISCOVERY, 'utf8'));
  await db.query(`insert into clinical_core.organizations(id,organization_label) values
    ($1,'FICTIONAL PILOT CLINIC'),($2,'FICTIONAL SECOND CLINIC'),($3,'FICTIONAL CLOSED CLINIC')`, [PILOT, SECOND, CLOSED]);
  await db.query("update clinical_core.organizations set status='archived' where id=$1", [CLOSED]);
  const people = [[practitioner, 'workforce', true], [applicant, 'workforce', true], [suspended, 'workforce', true],
    [member, 'workforce', true], [closedOnly, 'workforce', true], [newcomer, 'workforce', true], [inactive, 'workforce', true],
    [consumer, 'consumer', true]] as const;
  for (const [who, pool, bound] of people) {
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [who.person, `subject_${who.person.replaceAll('-', '')}`]);
    await db.query(`insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound)
      values($1,$2,$3,$4)`, [who.person, pool, who.sub, bound]);
  }
  await db.query("update clinical_core.identities set status='disabled' where identity_subject=$1", [inactive.sub]);
  await db.query(`insert into clinical_core.organization_memberships(organization_id,person_id,role,status) values
    ($1,$2,'practitioner','active'),($3,$2,'staff','active'),($1,$4,'practitioner','pending'),($1,$5,'practitioner','suspended'),
    ($1,$6,'member','active'),($7,$8,'practitioner','active'),($1,$9,'practitioner','active'),($1,$10,'staff','active')`,
  [PILOT, practitioner.person, SECOND, applicant.person, suspended.person, member.person, CLOSED, closedOnly.person,
    inactive.person, consumer.person]);
  await db.query(`insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name)
    values($1,$2,$3,'Fictional','Patient')`, [PATIENT, PILOT, `patient_${PATIENT.replaceAll('-', '')}`]);
}, 120_000);
afterAll(async () => { await db?.close(); });
beforeEach(() => { queries.length = 0; });

describe('the subject-only discovery candidate', () => {
  it('lists active clinical memberships and pending ones separately, from current rows, with nothing about patients', async () => {
    const discovery = await adapter.currentMembership!.discoverMemberships(practitioner.sub);
    expect(discovery).toEqual({ clinics: [
      { organizationId: PILOT, name: 'FICTIONAL PILOT CLINIC', role: 'practitioner' },
      { organizationId: SECOND, name: 'FICTIONAL SECOND CLINIC', role: 'staff' },
    ].sort((a, b) => a.name.localeCompare(b.name)), pending: [] });
    expect(JSON.stringify(discovery)).not.toMatch(/Fictional Patient|patient/i);
    expect(await adapter.currentMembership!.discoverMemberships(applicant.sub))
      .toEqual({ clinics: [], pending: [{ organizationId: PILOT, name: 'FICTIONAL PILOT CLINIC' }] });
    // No membership, a suspended one, the non-clinical role and an archived clinic are all "no clinic", not access.
    for (const who of [newcomer, suspended, member, closedOnly]) {
      expect(await adapter.currentMembership!.discoverMemberships(who.sub), who === newcomer ? 'newcomer' : 'other')
        .toEqual({ clinics: [], pending: [] });
    }
    // It binds no request context and reads no clinical row.
    expect(queries.every((sql) => sql.includes('discover_current_workforce_memberships'))).toBe(true);
  });

  it('refuses an unknown, disabled or consumer identity instead of answering "no clinics"', async () => {
    // The production schema itself forbids an identity that is not production-bound; the function checks it anyway.
    for (const sub of [randomUUID(), inactive.sub, consumer.sub, 'not-a-uuid']) {
      await expect(adapter.currentMembership!.discoverMemberships(sub)).rejects.toMatchObject({ category: 'production_boundary_refused' });
    }
  });

  it('reads no patient, record or clinical table, and is granted only to the API role', () => {
    const source = readFileSync(DISCOVERY, 'utf8').split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(source).not.toMatch(/patient|encounter|record|note|consent|lab_/i);
    expect(source).not.toMatch(/set_config|set_request_context/);
    expect(source).toMatch(/revoke all on function clinical_private\.discover_current_workforce_memberships\(text\) from public/);
    expect(source).toMatch(/grant execute on function clinical_private\.discover_current_workforce_memberships\(text\) to clinical_core_api;/);
  });

  it('follows a revocation on the next discovery, and the setter refuses the revoked clinic', async () => {
    await membership(practitioner, SECOND, "status='suspended'");
    try {
      const after = await adapter.currentMembership!.discoverMemberships(practitioner.sub);
      expect(after.clinics.map((clinic) => clinic.organizationId)).toEqual([PILOT]);
      await expect(adapter.currentMembership!.posture({ subject: practitioner.sub, selectedOrganizationId: SECOND }))
        .rejects.toMatchObject({ category: 'production_boundary_refused' });
    } finally {
      await membership(practitioner, SECOND, "status='active'");
    }
  });
});

describe('GET /clinical-core/workforce/memberships/current', () => {
  it('answers a verified subject with no selected clinic, filtered to the pilot clinic', async () => {
    const result = await discover(practitioner.sub);
    expect(result).toEqual({ status: 200, body: { data: { clinics: [{ organizationId: PILOT, name: 'FICTIONAL PILOT CLINIC', role: 'practitioner' }], pending: [] } } });
    expect((await discover(applicant.sub)).body).toEqual({ data: { clinics: [], pending: [{ organizationId: PILOT, name: 'FICTIONAL PILOT CLINIC' }] } });
    expect((await discover(newcomer.sub)).body).toEqual({ data: { clinics: [], pending: [] } });
    expect(await discover(randomUUID())).toEqual({ status: 403, body: { error: 'production_boundary_refused' } });
  });

  it('refuses a selected clinic, a body or a query on the subject-only route', async () => {
    for (const options of [{ headers: { 'x-alp-selected-organization-id': PILOT } }, { body: '{}' }, { query: { organizationId: PILOT } }]) {
      expect(await discover(practitioner.sub, options)).toEqual({ status: 400, body: { error: 'request_invalid' } });
    }
    expect(queries).toEqual([]);
  });

  it.each([
    ['an expired token', { claims: { exp: String(Math.floor(Date.now() / 1000) - 1) } }],
    ['an unverified email', { claims: { email_verified: 'false' } }],
    ['a synthetic attestation', { claims: { 'custom:synthetic_attested': 'true' } }],
    ['an access token', { claims: { token_use: 'access' } }],
    ['another audience', { claims: { aud: 'another-client' } }],
    ['another AWS account', { accountId: '000000000000' }],
  ])('refuses %s before any database call', async (_label, options) => {
    expect(await discover(practitioner.sub, options)).toEqual({ status: 403, body: { error: 'identity_refused' } });
    expect(queries).toEqual([]);
  });

  it('answers nothing under the legacy authority, and 503 once the candidate is rolled back', async () => {
    expect(await discover(practitioner.sub, {}, handlerFor(configuration({ authorityMode: 'legacy_claims' }))))
      .toEqual({ status: 503, body: { error: 'membership_authority_not_configured' } });
    await db.exec(readFileSync(ROLLBACK, 'utf8'));
    try {
      expect(await discover(practitioner.sub)).toEqual({ status: 503, body: { error: 'database_unavailable' } });
      await expect(db.exec(readFileSync(ROLLBACK, 'utf8'))).rejects.toThrow();
    } finally {
      await db.exec(readFileSync(DISCOVERY, 'utf8'));
    }
    expect((await discover(practitioner.sub)).status).toBe(200);
  });
});
