import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createAwsIdentityApiHandler, type ApiGatewayV2Event } from './aws-identity-api';
import type { ClinicalCoreDatabase } from './database';
import { classifyDatabaseRejection } from './rds-data-database';

/**
 * The synthetic identity boundary the Desktop still reaches under the legacy sign-in (`synthetic_identity_boundary` in
 * the route-authority inventory): GET /clinical-core/workforce/posture and POST /clinical-core/workforce/invitations on
 * the synthetic API, by the real handler over the real synthetic-staging schema (fictional rows, no PHI; embedded
 * engine, not hosted acceptance).
 *
 * - Invitations check the membership row (`has_clinical_role`), so a removed member is refused on the next request.
 *   Nothing on this boundary reads the clinic's status, so a member of a suspended or archived clinic still issues one.
 *   The production successor does not reach this schema.
 * - Posture is answered from the verified token alone: no row is read, so it answers the same until the token expires.
 *   It carries no clinic data (environment, pool, classification).
 */
const configuration = {
  workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', workforceAudience: 'workforceclient1234567890',
  consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer', consumerAudience: 'consumerclient12345678901',
};
let pg: PGlite;
let org: string, person: string, patient: string;
const subject = (id: string) => 'workforce:syn-' + id.replaceAll('-', '');
const unwrap = (value: unknown) => value && typeof value === 'object' && 'kind' in value && value.kind === 'uuid' && 'value' in value ? value.value : value;
/** The production dispatch in front of a real engine: a SQL error is classified as the RDS adapter classifies it. */
const database: ClinicalCoreDatabase = { transaction: async work => {
  try {
    return await pg.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      return work({ query: (sql, parameters = []) => tx.query(sql, parameters.map(unwrap)) as never });
    });
  } catch (error) {
    throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message: `ERROR: ${error instanceof Error ? error.message : String(error)}` }) ?? error;
  }
} };
const unreadable: ClinicalCoreDatabase = { transaction: async () => { throw new Error('no row may be read for posture'); } };
// An already-issued token: the same claims on every request.
const event = (routeKey: string, body?: unknown): ApiGatewayV2Event => ({
  routeKey, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  requestContext: { authorizer: { jwt: { claims: {
    iss: configuration.workforceIssuer, aud: configuration.workforceAudience, token_use: 'id', sub: subject(person),
    'custom:person_id': person, 'custom:organization_id': org, 'custom:synthetic_attested': 'true',
  } } } },
} as ApiGatewayV2Event);
const invite = () => createAwsIdentityApiHandler({ database, configuration })(event('POST /clinical-core/workforce/invitations',
  { patientRecordId: patient, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }));
const invitations = async () => (await pg.query<{ n: number }>('select count(*)::int as n from clinical_core.connection_invitations where organization_id=$1', [org])).rows[0]!.n;

beforeAll(async () => {
  pg = new PGlite({ extensions: { pgcrypto } });
  const manifest = JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json', 'utf8')) as { migrations: Array<{ file: string }> };
  for (const migration of manifest.migrations) await pg.exec(readFileSync('infra/aws-clinical-core/migrations/' + migration.file, 'utf8'));
}, 180_000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  [org, person, patient] = [randomUUID(), randomUUID(), randomUUID()];
  await pg.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'FICTIONAL synthetic clinic')", [org]);
  await pg.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [person, 'syn_' + person.replaceAll('-', '')]);
  await pg.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'workforce',$2,true)", [person, subject(person)]);
  await pg.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [org, person]);
  await pg.query('insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,$3)', [patient, org, 'patient_syn_' + patient.replaceAll('-', '')]);
});

describe('the synthetic identity boundary under the legacy sign-in', () => {
  it('control: a current practitioner issues a patient invitation', async () => {
    expect((await invite()).statusCode).toBe(201);
    expect(await invitations()).toBe(1);
  });

  it('invitations: a removed membership is refused on the next request, with the same token, and nothing is written', async () => {
    await pg.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [org, person]);
    expect((await invite()).statusCode).toBe(403);
    expect(await invitations()).toBe(0);
  });

  it('a disabled workforce identity (a revoked login): invitations refused on the next request, posture still answered from the token', async () => {
    expect((await invite()).statusCode).toBe(201);
    await pg.query("update clinical_core.identities set status='disabled' where person_id=$1 and identity_pool='workforce'", [person]);
    expect((await invite()).statusCode).toBe(403);
    expect(await invitations()).toBe(1);
    const posture = await createAwsIdentityApiHandler({ database: unreadable, configuration })(event('GET /clinical-core/workforce/posture'));
    expect(posture.statusCode).toBe(200);
    expect(JSON.stringify(JSON.parse(posture.body ?? '{}').data)).not.toContain(org);
  });

  it.each(['suspended', 'archived'])('invitations: a %s clinic — GAP: the already-selected session still issues one', async status => {
    await pg.query('update clinical_core.organizations set status=$2 where id=$1', [org, status]);
    expect((await invite()).statusCode).toBe(201);
    expect(await invitations()).toBe(1);
  });

  it('posture: answered from the token alone, so a removed member or a suspended clinic reads it until the token expires', async () => {
    await pg.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [org, person]);
    await pg.query("update clinical_core.organizations set status='suspended' where id=$1", [org]);
    const answer = await createAwsIdentityApiHandler({ database: unreadable, configuration })(event('GET /clinical-core/workforce/posture'));
    expect(answer.statusCode).toBe(200);
    const data = JSON.parse(answer.body ?? '{}').data;
    expect(data).toMatchObject({ environment: 'synthetic-staging', identityPool: 'workforce', phiAllowed: false, realPatientDataAllowed: false });
    expect(JSON.stringify(data)).not.toContain(org);
  });
});
