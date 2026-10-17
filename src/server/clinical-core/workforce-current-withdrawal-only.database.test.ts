import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createAwsProductionIdentityConsentAdapter } from './aws-identity-consent';
import { type ClinicalCoreDatabase } from './database';

const CURRENT = 'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql';
const DECISION = 'infra/aws-clinical-core/source-candidates/workforce-consent-decision-clinic-status.sql';
const WITHDRAWAL = 'infra/aws-clinical-core/source-candidates/workforce-current-withdrawal-only.sql';
const WITHDRAWAL_ROLLBACK = 'infra/aws-clinical-core/source-candidates/workforce-current-withdrawal-only-rollback.sql';
const subject = randomUUID(), practitioner = randomUUID(), outsiderSubject = randomUUID(), outsider = randomUUID();
const clinicA = randomUUID(), clinicB = randomUUID(), owner = randomUUID(), consumer = randomUUID(), consumerB = randomUUID();
const patientA = randomUUID(), patientB = randomUUID(), connectionA = randomUUID(), connectionB = randomUUID();
const artifactA = randomUUID(), artifactB = randomUUID();
let db: PGlite;
let schema: { manifest: { migrations: Array<{ file: string }> }; files: Record<string, string> };

async function asApi<Row extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return db.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    return (await tx.query<Row>(sql, params)).rows;
  });
}

async function grant(connection = connectionA, artifact = artifactA, clinic = clinicA) {
  return db.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'consent_management','production-clinical','clinical_phi')",
      [practitioner, clinic, subject]);
    return (await tx.query("select * from clinical_core.record_consent_grant($1,$2,'forms_checkins','in_person','self')",
      [connection, artifact])).rows;
  });
}

async function withdrawal(who = subject, clinic = clinicA, connection = connectionA, reason = 'patient_request') {
  return asApi<{ status: string; version: number }>(
    "select * from clinical_private.revoke_current_workforce_consent($1,$2,$3,'forms_checkins',$4)",
    [who, clinic, connection, reason]);
}

async function history(connection = connectionA) {
  return (await db.query<{ status: string; version: number }>(
    'select status,version from clinical_core.consent_grants where connection_id=$1 order by version', [connection]))
    .rows.map(row => `${row.version}:${row.status}`);
}

beforeAll(async () => {
  schema = JSON.parse(execFileSync(process.execPath,
    ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }));
  expect(schema.manifest.migrations.some((entry: { file: string }) => /current-withdrawal-only|consent-decision-clinic-status/.test(entry.file))).toBe(false);
}, 30_000);
beforeEach(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of schema.manifest.migrations) await db.exec(schema.files[migration.file]!);
  await db.exec(readFileSync(CURRENT, 'utf8'));
  await db.exec(readFileSync(DECISION, 'utf8'));
  await db.exec(readFileSync(WITHDRAWAL, 'utf8'));
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL A'),($2,'FICTIONAL B')", [clinicA, clinicB]);
  for (const [person, pool, identitySubject] of [
    [practitioner, 'workforce', subject], [outsider, 'workforce', outsiderSubject],
    [owner, 'workforce', randomUUID()], [consumer, 'consumer', randomUUID()],
    [consumerB, 'consumer', randomUUID()],
  ]) {
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',
      [person, `subject_${person!.replaceAll('-', '')}`]);
    await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)',
      [person, pool, identitySubject]);
  }
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$3,'practitioner'),($2,$3,'practitioner'),($1,$4,'owner')",
    [clinicA, clinicB, practitioner, owner]);
  for (const [patient, clinic, connection, artifact, consumerPerson] of [
    [patientA, clinicA, connectionA, artifactA, consumer], [patientB, clinicB, connectionB, artifactB, consumerB],
  ]) {
    await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Patient')",
      [patient, clinic, `patient_${patient!.replaceAll('-', '')}`]);
    await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',clock_timestamp())",
      [connection, clinic, patient, consumerPerson]);
    await db.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
      values($1,$2,'forms_checkins','fictional-1',$3,'US-FICTIONAL','approved',clock_timestamp(),$4)`,
    [artifact, clinic, 'a'.repeat(64), owner]);
  }
}, 180_000);
afterEach(async () => { await db?.close(); });

describe('blocked current-membership withdrawal-only operation', () => {
  it.each(['suspended', 'archived'] as const)('allows exact withdrawal in a %s clinic, without leaving a reusable context', async status => {
    await grant();
    await db.query('update clinical_core.organizations set status=$2 where id=$1', [clinicA, status]);
    await expect(asApi('select clinical_private.set_current_workforce_context($1,$2,$3)',
      [subject, clinicA, 'consent_management'])).rejects.toThrow(/workforce_membership_refused/);
    const rows = await db.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      const result = await tx.query<{ status: string; version: number }>(
        "select * from clinical_private.revoke_current_workforce_consent($1,$2,$3,'forms_checkins','patient_request')",
        [subject, clinicA, connectionA]);
      const claims = await tx.query<{ cleared: boolean }>(`select
        nullif(current_setting('clinical.claim.actor_person_id',true),'') is null
        and nullif(current_setting('clinical.claim.organization_id',true),'') is null
        and nullif(current_setting('clinical.claim.identity_pool',true),'') is null
        and nullif(current_setting('clinical.claim.identity_subject',true),'') is null
        and nullif(current_setting('clinical.claim.purpose',true),'') is null
        and nullif(current_setting('clinical.claim.environment',true),'') is null
        and nullif(current_setting('clinical.claim.data_classification',true),'') is null as cleared`);
      expect(claims.rows[0]).toEqual({ cleared: true });
      await tx.exec('savepoint no_context_reuse');
      await expect(tx.query("select * from clinical_core.record_consent_grant($1,$2,'forms_checkins','in_person','self')",
        [connectionA, artifactA])).rejects.toThrow();
      await tx.exec('rollback to savepoint no_context_reuse');
      return result.rows;
    });
    expect(rows[0]).toMatchObject({ status: 'revoked', version: 2 });
    expect(await history()).toEqual(['1:granted', '2:revoked']);
  });

  it('refuses other clinics, other subjects, a removed member and a disabled credential', async () => {
    await grant();
    await db.query("update clinical_core.organizations set status='suspended' where id=$1", [clinicA]);
    await expect(withdrawal(subject, clinicB, connectionA)).rejects.toThrow(/workforce_membership_refused/);
    await expect(withdrawal(outsiderSubject)).rejects.toThrow(/workforce_membership_refused/);
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2",
      [clinicA, practitioner]);
    await expect(withdrawal()).rejects.toThrow(/workforce_membership_refused/);
    await db.query("update clinical_core.organization_memberships set status='active' where organization_id=$1 and person_id=$2",
      [clinicA, practitioner]);
    await db.query("update clinical_core.identities set status='disabled' where identity_subject=$1", [subject]);
    await expect(withdrawal()).rejects.toThrow(/workforce_membership_refused/);
    expect(await history()).toEqual(['1:granted']);
  });

  it('accepts only reviewed reasons and clinical roles, and never creates a new grant', async () => {
    await grant();
    await db.query("update clinical_core.organizations set status='suspended' where id=$1", [clinicA]);
    await expect(withdrawal(subject, clinicA, connectionA, 'anything')).rejects.toThrow(/workforce_membership_refused/);
    await db.query("update clinical_core.organization_memberships set role='staff' where organization_id=$1 and person_id=$2",
      [clinicA, practitioner]);
    await expect(withdrawal()).rejects.toThrow(/workforce_membership_refused/);
    expect(await history()).toEqual(['1:granted']);
  });

  it('refuses a missing reason, a missing grant and a second withdrawal without writing history', async () => {
    await expect(asApi("select * from clinical_private.revoke_current_workforce_consent($1,$2,$3,'forms_checkins',$4)",
      [subject, clinicA, connectionA, null])).rejects.toThrow(/workforce_membership_refused/);
    await expect(withdrawal()).rejects.toThrow(/active_consent_required/);
    await grant();
    await withdrawal();
    await expect(withdrawal()).rejects.toThrow(/active_consent_required/);
    expect(await history()).toEqual(['1:granted', '2:revoked']);
  });

  it('exposes one operation only to the API role, not PUBLIC', async () => {
    const { rows } = await db.query<{ api: boolean; publicGrant: boolean }>(`select
      has_function_privilege('clinical_core_api',
        'clinical_private.revoke_current_workforce_consent(text,uuid,uuid,text,text)','EXECUTE') as api,
      exists(select 1 from information_schema.routine_privileges
        where routine_schema='clinical_private' and routine_name='revoke_current_workforce_consent'
          and grantee='PUBLIC' and privilege_type='EXECUTE') as "publicGrant"`);
    expect(rows[0]).toEqual({ api: true, publicGrant: false });
  });

  it('routes the production current-member adapter through one bounded withdrawal statement', async () => {
    await grant();
    await db.query("update clinical_core.organizations set status='suspended' where id=$1", [clinicA]);
    const calledSql: string[] = [];
    const database: ClinicalCoreDatabase = {
      transaction: work => db.transaction(async tx => {
        await tx.exec('set local role clinical_core_api');
        return work({ query: <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
          calledSql.push(sql);
          return tx.query<Row>(sql, params.map(value =>
            value && typeof value === 'object' && 'kind' in value && value.kind === 'uuid' && 'value' in value
              ? value.value : value));
        } });
      }),
    };
    const adapter = createAwsProductionIdentityConsentAdapter(database).currentMembership!;
    const result = await adapter.revokeConsent({ subject, selectedOrganizationId: clinicA },
      { connectionId: connectionA, scope: 'forms_checkins', reasonCode: 'patient_request' });
    expect(result).toMatchObject({ status: 'revoked', version: 2 });
    expect(await history()).toEqual(['1:granted', '2:revoked']);
    expect(calledSql).toEqual([
      'select * from clinical_private.revoke_current_workforce_consent($1,$2,$3,$4,$5)',
    ]);
  });

  it('rolls back only the wrapper, preserving the parent authority and consent history', async () => {
    await grant();
    await db.query("update clinical_core.organizations set status='archived' where id=$1", [clinicA]);
    await withdrawal();
    await db.exec(readFileSync(WITHDRAWAL_ROLLBACK, 'utf8'));
    const { rows } = await db.query<{ wrapper: string | null; context: string | null; revoke: string | null }>(`select
      to_regprocedure('clinical_private.revoke_current_workforce_consent(text,uuid,uuid,text,text)')::text as wrapper,
      to_regprocedure('clinical_private.set_current_workforce_context(text,uuid,text)')::text as context,
      to_regprocedure('clinical_core.revoke_consent_grant(uuid,text,text)')::text as revoke`);
    expect(rows[0]!.wrapper).toBeNull();
    expect(rows[0]!.context).toContain('set_current_workforce_context');
    expect(rows[0]!.revoke).toContain('revoke_consent_grant');
    expect(await history()).toEqual(['1:granted', '2:revoked']);
  });

  it('refuses reapplication over a drifted current-membership parent', async () => {
    await db.exec(readFileSync(WITHDRAWAL_ROLLBACK, 'utf8'));
    await db.exec(`create or replace function clinical_private.set_current_workforce_context(
      _subject text,_selected_organization_id uuid,_purpose text)
      returns jsonb language sql security definer set search_path='' as $$ select '{}'::jsonb $$`);
    await expect(db.exec(readFileSync(WITHDRAWAL, 'utf8'))).rejects.toThrow(/current_withdrawal_parent_refused/);
    await db.exec('rollback');
    const { rows } = await db.query<{ present: string | null }>(`select
      to_regprocedure('clinical_private.revoke_current_workforce_consent(text,uuid,uuid,text,text)')::text as present`);
    expect(rows[0]!.present).toBeNull();
  });

  it('refuses rollback of a drifted wrapper', async () => {
    await db.exec(`create or replace function clinical_private.revoke_current_workforce_consent(
      _subject text,_selected_organization_id uuid,_connection_id uuid,_scope text,_reason_code text)
      returns table(consent_id uuid,connection_id uuid,scope text,status text,version integer,recorded_at timestamptz)
      language plpgsql security definer set search_path='' as $$ begin return; end $$`);
    await expect(db.exec(readFileSync(WITHDRAWAL_ROLLBACK, 'utf8'))).rejects.toThrow(/current_withdrawal_rollback_refused/);
    await db.exec('rollback');
    const { rows } = await db.query<{ present: string | null }>(`select
      to_regprocedure('clinical_private.revoke_current_workforce_consent(text,uuid,uuid,text,text)')::text as present`);
    expect(rows[0]!.present).toContain('revoke_current_workforce_consent');
  });
});
