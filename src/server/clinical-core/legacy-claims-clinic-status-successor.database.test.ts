import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ClinicalCoreDatabase } from './database';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { classifyDatabaseRejection } from './rds-data-database';

/**
 * The BLOCKED legacy-claims-clinic-status successor over the real 106-migration production schema
 * (infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status.sql). Without it, a workforce session whose
 * token already names a suspended or archived clinic keeps reading and writing clinical data there
 * (legacy-claims-clinic-status.database.test.ts pins that). With it, the one function every legacy workforce request
 * enters refuses that request, the same way it refuses an unknown identity, while the paths that must keep running in a
 * closed clinic (workforce consent management, every consumer request) are unchanged. The race orders need two
 * sessions, which PGlite cannot give: scripts/qualify-clinic-status-native.mjs runs them on a throwaway PostgreSQL.
 * Fictional rows only.
 */
const read = (path: string) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const CANDIDATE = read('infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status.sql');
const ROLLBACK = read('infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status-rollback.sql');
const PARENT_SHA = '36d00be99597f6b527863cece9b9e174a900b49b7c2cd2085224061954b2d0ea';
const SUCCESSOR_SHA = '4187ce781d95640caa788e1a9a2a49b7d59103bc3b0fa2f37ae85de99955201b';
const SIGNATURE = "to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)')";
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
let db: PGlite;
let org: string, person: string, stranger: string;
const subject = (id: string) => 'subject-' + id;

type Purpose = 'clinical_data' | 'consent_management' | 'identity_link';
async function asApi<T>(actor: string, clinic: string, work: (query: (sql: string, args?: unknown[]) => Promise<unknown[]>) => Promise<T>,
  pool: 'workforce' | 'consumer' = 'workforce', purpose: Purpose = 'clinical_data'): Promise<T> {
  return db.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',
      [actor, clinic, pool, subject(actor), purpose, 'production-clinical', 'clinical_phi']);
    return work(async (sql, args = []) => (await tx.query(sql, args)).rows);
  });
}
const createPatient = (actor: string, clinic = org) =>
  asApi(actor, clinic, query => query("select clinical_core.create_patient_profile($1,'Fictional','Patient') as created", [clinic]));
const myClinics = (actor: string, clinic = org) => asApi(actor, clinic, query => query('select organization_id from clinical_core.list_my_organizations()'));
const calendar = (actor: string) => asApi(actor, org, query => query("select clinical_core.get_desktop_calendar($1, now(), now() + interval '1 day') as calendar", [org]));
const patients = async () => (await db.query<{ n: number }>('select count(*)::integer as n from clinical_core.patient_records where organization_id=$1', [org])).rows[0]!.n;
const definition = async () => (await db.query<{ body: string; acl: string | null; owner: string; definer: boolean }>(
  `select encode(sha256(convert_to(prosrc,'UTF8')),'hex') as body, proacl::text as acl, pg_get_userbyid(proowner) as owner,
     prosecdef as definer from pg_proc where oid=${SIGNATURE}`)).rows[0]!;
/** What the service sees: the SQL refusal as the Data API client classifies it. */
const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (e: unknown) => e as Error & { code?: string });
  expect(error).not.toBeNull();
  return { code: error!.code, message: error!.message, classified: classifyDatabaseRejection({ name: 'DatabaseErrorException', message: error!.message })?.category };
};
async function refuses(sql: string, reason: string) {
  await expect(db.exec(sql)).rejects.toThrow(reason);
  await db.exec('rollback');
}

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }));
  db = new PGlite({ extensions: { pgcrypto } });
  const admin: ClinicalCoreDatabase = { transaction: work => db.transaction(tx => work({ query: (sql, parameters = []) => tx.query(sql, [...parameters]) as never })) };
  await applyProductionClinicalCoreMigrations(admin, manifest.migrations.map((m: { version: string; file: string }) => ({
    version: m.version, name: m.file.slice(15, -4), sql: files[m.file], sha256: sha(files[m.file]) })));
}, 120_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  [org, person, stranger] = [randomUUID(), randomUUID(), randomUUID()];
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL clinic')", [org]);
  for (const id of [person, stranger]) {
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [id, subject(id)]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'consumer',$2,true)", [id, subject(id)]);
  }
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [org, person]);
});

describe('legacy-claims-clinic-status: the candidate and its guards', () => {
  it('the parent is the reviewed definition, and the files carry the hashes the tests bind', async () => {
    expect(await definition()).toMatchObject({ body: PARENT_SHA, owner: 'postgres', definer: true });
    expect(CANDIDATE).toContain(PARENT_SHA);
    expect(CANDIDATE).toContain(SUCCESSOR_SHA);
    expect(ROLLBACK).toContain(PARENT_SHA);
    expect(ROLLBACK).toContain(SUCCESSOR_SHA);
    expect(CANDIDATE).toMatch(/^-- Unregistered source candidate \(legacy-claims-clinic-status\)\. BLOCKED:/);
  });

  it('a rollback before the successor exists refuses and changes nothing', async () => {
    const before = await definition();
    await refuses(ROLLBACK, 'clinic_status_rollback_refused');
    expect(await definition()).toEqual(before);
  });
});

describe('legacy-claims-clinic-status: applied', () => {
  let parentAcl: string | null;
  beforeAll(async () => {
    parentAcl = (await definition()).acl;
    await db.exec(CANDIDATE);
  });

  it('is exactly the successor, with the parent\'s owner, security and grants, and cannot be applied twice', async () => {
    expect(await definition()).toEqual({ body: SUCCESSOR_SHA, acl: parentAcl, owner: 'postgres', definer: true });
    await refuses(CANDIDATE, 'clinic_status_parent_refused');
    expect((await definition()).body).toBe(SUCCESSOR_SHA);
  });

  it('control: an active practitioner of an active clinic still writes, lists it and reads its calendar', async () => {
    await expect(createPatient(person)).resolves.toHaveLength(1);
    expect(await myClinics(person)).toEqual([{ organization_id: org }]);
    await expect(calendar(person)).resolves.toHaveLength(1);
  });

  it.each(['suspended', 'archived'])('a %s clinic: an already-selected session can neither write nor read in it', async status => {
    await expect(createPatient(person)).resolves.toHaveLength(1);
    await db.query('update clinical_core.organizations set status=$2 where id=$1', [org, status]);
    await expect(createPatient(person)).rejects.toThrow('request_context_refused');
    await expect(myClinics(person)).rejects.toThrow('request_context_refused');
    await expect(calendar(person)).rejects.toThrow('request_context_refused');
    expect(await patients()).toBe(1);
  });

  it('reinstating the clinic restores access: suspension destroys nothing', async () => {
    await db.query("update clinical_core.organizations set status='suspended' where id=$1", [org]);
    await expect(createPatient(person)).rejects.toThrow('request_context_refused');
    await db.query("update clinical_core.organizations set status='active' where id=$1", [org]);
    await expect(createPatient(person)).resolves.toHaveLength(1);
  });

  it('the refusal is the unknown-identity refusal, so it says neither whether the clinic exists nor why it is closed', async () => {
    await db.query("update clinical_core.organizations set status='suspended' where id=$1", [org]);
    const archived = randomUUID();
    await db.query("insert into clinical_core.organizations(id,organization_label,status) values($1,'FICTIONAL archived','archived')", [archived]);
    await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [archived, person]);
    const answers = [
      await refusal(createPatient(person)),
      await refusal(createPatient(person, archived)),
      await refusal(createPatient(person, randomUUID())),
      await refusal(asApi(randomUUID(), org, async () => null)),
    ];
    expect(answers[0]).toEqual({ code: '42501', message: 'request_context_refused', classified: 'identity_refused' });
    for (const answer of answers) expect(answer).toEqual(answers[0]);
  });

  it('a closed clinic refuses workforce identity linking too (posture, discovery, issuing patient invitations)', async () => {
    await db.query("update clinical_core.organizations set status='archived' where id=$1", [org]);
    await expect(asApi(person, org, async () => null, 'workforce', 'identity_link')).rejects.toThrow('request_context_refused');
  });

  it('unchanged in a closed clinic: workforce consent management (retention, erasure, cleanup) and every consumer request', async () => {
    await db.query("update clinical_core.organizations set status='archived' where id=$1", [org]);
    for (const [pool, purpose] of [['workforce', 'consent_management'],
      ['consumer', 'clinical_data'], ['consumer', 'consent_management'], ['consumer', 'identity_link']] as const) {
      await expect(asApi(person, org, async query => query("select current_setting('clinical.claim.organization_id') as clinic"), pool, purpose),
        `${pool} ${purpose}`).resolves.toEqual([{ clinic: org }]);
    }
  });

  it('unchanged refusals: an unapproved account and a removed membership in an active clinic', async () => {
    await expect(createPatient(stranger)).rejects.toThrow();
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [org, person]);
    await expect(createPatient(person)).rejects.toThrow();
    expect(await patients()).toBe(0);
  });

  it('the rollback restores the parent exactly, keeps the grants, and the gap returns', async () => {
    await db.exec(ROLLBACK);
    expect(await definition()).toEqual({ body: PARENT_SHA, acl: parentAcl, owner: 'postgres', definer: true });
    await db.query("update clinical_core.organizations set status='suspended' where id=$1", [org]);
    await expect(createPatient(person)).resolves.toHaveLength(1);
    await refuses(ROLLBACK, 'clinic_status_rollback_refused');
    await db.exec(CANDIDATE);
    expect((await definition()).body).toBe(SUCCESSOR_SHA);
  });
});
