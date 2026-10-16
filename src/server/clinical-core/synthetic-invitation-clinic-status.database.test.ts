import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createAwsIdentityApiHandler, type ApiGatewayV2Event } from './aws-identity-api';
import type { ClinicalCoreDatabase } from './database';
import { classifyDatabaseRejection } from './rds-data-database';

/**
 * The fictional synthetic identity boundary, from patient invitation to verified connection, against a suspended or
 * archived clinic: the real synthetic handler and adapter over the real synthetic-staging schema (embedded engine, not
 * hosted acceptance), with and without the BLOCKED successor synthetic-invitation-clinic-status.sql.
 *
 * Without it (the deployed synthetic schema), a session already in a suspended clinic issues invitations, and an
 * invitation issued before the suspension is claimed after it, becoming a verified patient connection: the request path
 * never reads the clinic's status. With it, both refuse and nothing is written. Fictional rows only.
 */
const SUCCESSOR = 'infra/aws-clinical-core/source-candidates/synthetic-invitation-clinic-status.sql';
const ROLLBACK = 'infra/aws-clinical-core/source-candidates/synthetic-invitation-clinic-status-rollback.sql';
const configuration = {
  workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', workforceAudience: 'workforceclient1234567890',
  consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer', consumerAudience: 'consumerclient12345678901',
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const unwrap = (value: unknown) => value && typeof value === 'object' && 'kind' in value && value.kind === 'uuid' && 'value' in value ? value.value : value;
const prosrc = async (pg: PGlite, signature: string) => (await pg.query<{ h: string | null }>(
  "select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') as h from pg_proc p where p.oid = to_regprocedure($1)", [signature])).rows[0]?.h ?? null;
const ISSUE = 'clinical_core.issue_connection_invitation(uuid,uuid,text,timestamptz,text)';
const CLAIM = 'clinical_core.claim_connection_invitation(text,uuid)';
const PARENT = { issue: '5602dbabe5145e522e70c4b6e4d905dd18a39238f8d9052be75bd7d02d2125b7', claim: '7decec8ec32ec6e0fcc9c3597d4c1ba96fdc835414515159d37e9a650a19da30' };
const SUCCESSOR_BODY = { issue: 'd2b67c8228e9e092302c4100ad40b678708a1ad2c0f36cfe8668675b656649df', claim: '5f76b92ab1ef46cd583d7cee2fda01d9dba78cbc1c84a55fef65c03c0aff1baa' };

async function syntheticSchema() {
  const pg = new PGlite({ extensions: { pgcrypto } });
  const manifest = JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json', 'utf8')) as { migrations: Array<{ file: string }> };
  for (const migration of manifest.migrations) await pg.exec(readFileSync('infra/aws-clinical-core/migrations/' + migration.file, 'utf8'));
  return pg;
}

describe.each([false, true])('synthetic invitations and a closed clinic, successor applied: %s', withSuccessor => {
  let pg: PGlite;
  let clinicA: string, clinicB: string, practitionerA: string, practitionerB: string, consumer: string, patientA: string, patientB: string;
  const workforceSubject = (id: string) => 'workforce:syn-' + id.replaceAll('-', '');
  const consumerSubject = (id: string) => 'consumer:syn-' + id.replaceAll('-', '');
  /** The production dispatch in front of a real engine: a SQL error is classified as the RDS adapter classifies it. */
  const database = (): ClinicalCoreDatabase => ({ transaction: async work => {
    try {
      return await pg.transaction(async tx => {
        await tx.exec('set local role clinical_core_api');
        return work({ query: (sql, parameters = []) => tx.query(sql, parameters.map(unwrap)) as never });
      });
    } catch (error) {
      throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message: `ERROR: ${error instanceof Error ? error.message : String(error)}` }) ?? error;
    }
  } });
  // Already-issued tokens: the same claims on every request.
  const workforceEvent = (person: string, clinic: string, body: unknown): ApiGatewayV2Event => ({
    routeKey: 'POST /clinical-core/workforce/invitations', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    requestContext: { authorizer: { jwt: { claims: {
      iss: configuration.workforceIssuer, aud: configuration.workforceAudience, token_use: 'id', sub: workforceSubject(person),
      'custom:person_id': person, 'custom:organization_id': clinic, 'custom:synthetic_attested': 'true',
    } } } },
  } as ApiGatewayV2Event);
  const consumerEvent = (clinic: string, token: string): ApiGatewayV2Event => ({
    routeKey: 'POST /clinical-core/consumer/invitations/claim', body: JSON.stringify({ token }), headers: { 'content-type': 'application/json' },
    requestContext: { authorizer: { jwt: { claims: {
      iss: configuration.consumerIssuer, aud: configuration.consumerAudience, token_use: 'id', sub: consumerSubject(consumer),
      'custom:person_id': consumer, 'custom:organization_id': clinic, 'custom:synthetic_attested': 'true',
    } } } },
  } as ApiGatewayV2Event);
  const handler = () => createAwsIdentityApiHandler({ database: database(), configuration });
  const issue = async (person: string, clinic: string, patient: string) => {
    const answer = await handler()(workforceEvent(person, clinic, { patientRecordId: patient, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }));
    return { status: answer.statusCode, token: answer.statusCode === 201 ? JSON.parse(answer.body ?? '{}').data.token as string : null };
  };
  const claim = async (clinic: string, token: string) => (await handler()(consumerEvent(clinic, token))).statusCode;
  const connection = async (patient: string) => (await pg.query<{ state: string; consumer_person_id: string | null }>(
    'select state, consumer_person_id from clinical_core.patient_connections where patient_record_id=$1', [patient])).rows;
  const invitations = async (clinic: string) => (await pg.query<{ status: string }>(
    'select status from clinical_core.connection_invitations where organization_id=$1 order by created_at', [clinic])).rows.map(row => row.status);
  const setStatus = (clinic: string, status: string) => pg.query('update clinical_core.organizations set status=$2 where id=$1', [clinic, status]);

  beforeAll(async () => {
    pg = await syntheticSchema();
    if (withSuccessor) await pg.exec(readFileSync(SUCCESSOR, 'utf8'));
  }, 180_000);
  afterAll(async () => { await pg?.close(); });
  beforeEach(async () => {
    [clinicA, clinicB, practitionerA, practitionerB, consumer, patientA, patientB] = Array.from({ length: 7 }, () => randomUUID());
    await pg.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'FICTIONAL clinic A'),($2,'FICTIONAL clinic B')", [clinicA, clinicB]);
    for (const [id, pool, subject] of [[practitionerA, 'workforce', workforceSubject(practitionerA)], [practitionerB, 'workforce', workforceSubject(practitionerB)],
      [consumer, 'consumer', consumerSubject(consumer)]] as const) {
      await pg.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [id, 'syn_' + id.replaceAll('-', '')]);
      await pg.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,$2,$3,true)', [id, pool, subject]);
    }
    await pg.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner'),($3,$4,'practitioner')",
      [clinicA, practitionerA, clinicB, practitionerB]);
    for (const [patient, clinic] of [[patientA, clinicA], [patientB, clinicB]])
      await pg.query('insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,$3)', [patient, clinic, 'patient_syn_' + patient.replaceAll('-', '')]);
  });

  it('control: an active clinic issues an invitation and the patient claims it into a verified connection', async () => {
    const issued = await issue(practitionerA, clinicA, patientA);
    expect(issued.status).toBe(201);
    expect(await claim(clinicA, issued.token!)).toBe(200);
    expect(await connection(patientA)).toEqual([{ state: 'verified', consumer_person_id: consumer }]);
  });

  it.each(['suspended', 'archived'])(`a %s clinic, already-issued practitioner session: ${withSuccessor ? 'refused, nothing written' : 'GAP: issues an invitation'}`, async status => {
    await setStatus(clinicA, status);
    const issued = await issue(practitionerA, clinicA, patientA);
    if (withSuccessor) {
      expect(issued.status).toBe(403);
      expect(await invitations(clinicA)).toEqual([]);
      expect(await connection(patientA)).toEqual([]);
    } else {
      expect(issued.status).toBe(201);
      expect(await invitations(clinicA)).toEqual(['pending']);
    }
  });

  it(`an invitation issued before the suspension, claimed after it: ${withSuccessor ? 'refused, the connection stays unverified' : 'GAP: becomes a verified connection'}`, async () => {
    const issued = await issue(practitionerA, clinicA, patientA);
    expect(issued.status).toBe(201);
    await setStatus(clinicA, 'suspended');
    const claimed = await claim(clinicA, issued.token!);
    if (withSuccessor) {
      expect(claimed).toBe(403);
      expect(await connection(patientA)).toEqual([{ state: 'invitation_pending', consumer_person_id: null }]);
      expect(await invitations(clinicA)).toEqual(['pending']);
      // Reinstated, the same invitation can still be claimed once: nothing was consumed by the refusal.
      await setStatus(clinicA, 'active');
      expect(await claim(clinicA, issued.token!)).toBe(200);
      expect(await connection(patientA)).toEqual([{ state: 'verified', consumer_person_id: consumer }]);
    } else {
      expect(claimed).toBe(200);
      expect(await connection(patientA)).toEqual([{ state: 'verified', consumer_person_id: consumer }]);
    }
  });

  it(`a retry of the same request after the suspension (same idempotency key and token): ${withSuccessor ? 'refused, not replayed' : 'GAP: replays the invitation'}`, async () => {
    const key = randomUUID(), tokenHash = sha(randomUUID()), expires = new Date(Date.now() + 3_600_000).toISOString();
    const call = () => database().transaction(async tx => {
      await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'identity_link','synthetic-staging','synthetic_only')",
        [practitionerA, clinicA, workforceSubject(practitionerA)]);
      return (await tx.query<{ invitation_id: string }>('select * from clinical_core.issue_connection_invitation($1,$2,$3,$4::timestamptz,$5)',
        [clinicA, patientA, tokenHash, expires, key])).rows[0]!.invitation_id;
    });
    const first = await call();
    await setStatus(clinicA, 'suspended');
    if (withSuccessor) {
      await expect(call()).rejects.toMatchObject({ category: 'identity_refused' });
    } else {
      expect(await call()).toBe(first);
    }
    expect(await invitations(clinicA)).toEqual(['pending']);
  });

  it('two clinics: suspending A leaves B issuing and claiming', async () => {
    await setStatus(clinicA, 'suspended');
    const issued = await issue(practitionerB, clinicB, patientB);
    expect(issued.status).toBe(201);
    expect(await claim(clinicB, issued.token!)).toBe(200);
    expect(await connection(patientB)).toEqual([{ state: 'verified', consumer_person_id: consumer }]);
  });

  it('a connection verified before the suspension is not changed by it (the owner decides whether suspension ends it)', async () => {
    const issued = await issue(practitionerA, clinicA, patientA);
    expect(await claim(clinicA, issued.token!)).toBe(200);
    await setStatus(clinicA, 'suspended');
    expect(await connection(patientA)).toEqual([{ state: 'verified', consumer_person_id: consumer }]);
  });
});

describe('the BLOCKED synthetic successor itself', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await syntheticSchema(); }, 180_000);
  afterAll(async () => { await pg?.close(); });
  /** A refused file stops inside its own transaction; the operator's session then rolls it back, as psql would. */
  const refused = async (sql: string, reason: RegExp) => { await expect(pg.exec(sql)).rejects.toThrow(reason); await pg.exec('rollback'); };

  it('pins its parents, applies once, and its rollback restores both parents byte for byte', async () => {
    expect(await prosrc(pg, ISSUE)).toBe(PARENT.issue);
    expect(await prosrc(pg, CLAIM)).toBe(PARENT.claim);
    await refused(readFileSync(ROLLBACK, 'utf8'), /synthetic_invitation_rollback_refused/);
    await pg.exec(readFileSync(SUCCESSOR, 'utf8'));
    expect(await prosrc(pg, ISSUE)).toBe(SUCCESSOR_BODY.issue);
    expect(await prosrc(pg, CLAIM)).toBe(SUCCESSOR_BODY.claim);
    // The helper is private: neither PUBLIC nor the API role may call it directly.
    expect((await pg.query<{ api: boolean }>("select has_function_privilege('clinical_core_api', to_regprocedure('clinical_private.require_active_synthetic_clinic(uuid)'), 'EXECUTE') as api")).rows[0]!.api).toBe(false);
    await refused(readFileSync(SUCCESSOR, 'utf8'), /synthetic_invitation_parent_refused/);
    await pg.exec(readFileSync(ROLLBACK, 'utf8'));
    expect(await prosrc(pg, ISSUE)).toBe(PARENT.issue);
    expect(await prosrc(pg, CLAIM)).toBe(PARENT.claim);
    expect((await pg.query<{ f: string | null }>("select to_regprocedure('clinical_private.require_active_synthetic_clinic(uuid)')::text as f")).rows[0]!.f).toBeNull();
  });

  it('refuses a drifted parent, and leaves the production clinic-status candidate byte-pinned', async () => {
    const drifted = readFileSync('infra/aws-clinical-core/migrations/20260812220000_identity_function_column_qualification.sql', 'utf8')
      .replace("message = 'clinical_role_required';", "message = 'clinical_role_required' ;");
    await pg.exec(drifted);
    expect(await prosrc(pg, ISSUE)).not.toBe(PARENT.issue);
    await refused(readFileSync(SUCCESSOR, 'utf8'), /synthetic_invitation_parent_refused/);
    expect(sha(readFileSync('infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status.sql', 'utf8').replaceAll('\r\n', '\n')))
      .toBe('c3788dc20bed9fe6aae40cc939a08a69773d45d56dc297dea21ae99ed6c7cc66');
    expect(sha(readFileSync('infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status-rollback.sql', 'utf8').replaceAll('\r\n', '\n')))
      .toBe('4c311c01148367b82d58e2143c2cce6f21f391fa04d50f1f21e27935224b29a0');
  });
});
