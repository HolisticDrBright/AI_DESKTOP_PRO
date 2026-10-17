import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { classifyDatabaseRejection } from './rds-data-database';
import { createProductionClinicRecordsConsumer, createProductionClinicRecordsWorkforce, ClinicRecordError } from './production-clinic-records';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import type { ClinicalCoreDatabase } from './database';
import type { ClinicRecordConsumerRequest, ClinicRecordWorkforceRequest } from '../../contracts/clinicRecordRequests';

/**
 * HELD (D5), executed rather than read in source: a patient's copies of clinic-held records while the clinic is
 * suspended or archived, on the real 116-migration clinic-record privacy candidate, through the production adapters
 * under the actual API role. docs/suspended-clinic-custody-2026-10-16.md §3 recorded this cell as "refused at all three
 * stages ... read in source, not executed here". This pins what the source does; it decides nothing. Who fulfils a
 * patient's copy while the clinic is closed, and whether a copy already delivered stays readable, are the owner's D5.
 * Fictional rows and fictional disclosure releases only (never an approval). PGlite is one session, not Aurora.
 */
type Artifact = { manifest: { migrations: { version: string; file: string }[] }; files: Record<string, string>; candidate: Record<string, unknown> };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
let pg: PGlite;
let org: string, practitioner: string, consumer: string, patient: string;

type Caller = { who?: string; pool?: 'workforce' | 'consumer' };
const context = ({ who = practitioner, pool = 'workforce' }: Caller = {}): ProductionClinicalRequestContext => ({ actorPersonId: who, organizationId: org, identityPool: pool,
  identitySubject: 'subject-' + who, purpose: (pool === 'consumer' ? 'consent_management' : 'clinical_data') as 'clinical_data',
  environment: 'production-clinical', dataClassification: 'clinical_phi', containsPhi: true, realPatientData: true, productionBound: true });
const api: ClinicalCoreDatabase = { transaction: work => pg.transaction(async tx => { await tx.exec('set local role clinical_core_api'); return work({ query: async (sql, parameters = []) => {
  const values = parameters.map(value => value && typeof value === 'object' && (value as { kind?: string }).kind === 'uuid' ? (value as { value: string }).value : value);
  try { return await tx.query(sql, values); }
  catch (error) { throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message: `ERROR: ${error instanceof Error ? error.message : String(error)}` }) ?? error; }
} }); }) };
const asConsumer = (body: ClinicRecordConsumerRequest) => createProductionClinicRecordsConsumer(api)(context({ pool: 'consumer', who: consumer }), body);
const asWorkforce = (body: ClinicRecordWorkforceRequest) => createProductionClinicRecordsWorkforce(api)(context({ pool: 'workforce' }), body);
async function call<T = unknown>(sql: string, args: unknown[] = []) {
  return pg.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','production-clinical','clinical_phi')", [practitioner, org, 'subject-' + practitioner]);
    return (await tx.query<{ result: T }>(sql, args)).rows[0]?.result as T;
  });
}
const refusal = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error instanceof ClinicRecordError ? error.category : error instanceof Error ? error.message : String(error); }
  return 'no_error';
};
const count = async (sql: string, args: unknown[] = []) => (await pg.query<{ n: number }>(`select count(*)::int n from ${sql}`, args)).rows[0]!.n;
async function person(role: 'practitioner' | null, pool: 'workforce' | 'consumer' = 'workforce') {
  const id = randomUUID();
  await pg.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
  await pg.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [id, pool, 'subject-' + id]);
  if (role) await pg.query('insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,$3)', [org, id, role]);
  return id;
}
const decision = (requestId: string, expectedRevision: number) => ({ requestId, expectedRevision, decisionId: randomUUID() });

beforeAll(async () => {
  const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true })) as Artifact;
  expect(artifact.manifest.migrations).toHaveLength(116);
  expect(artifact.candidate).toMatchObject({ activation: 'blocked', phiAllowed: false, seededDisclosureReleases: false, seededRequests: false });
  pg = new PGlite({ extensions: { pgcrypto } });
  const migrations = artifact.manifest.migrations.map(entry => ({ version: entry.version, name: entry.file.slice(15, -4), sql: artifact.files[entry.file]!, sha256: sha(artifact.files[entry.file]!) }));
  const admin: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({ query: (sql, parameters = []) => tx.query(sql, [...parameters]) })) };
  await applyProductionClinicalCoreMigrations(admin, migrations.slice(0, 106));
  for (const entry of migrations.slice(106)) {
    await pg.exec(entry.sql);
    await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [entry.version, entry.name, entry.sha256]);
  }
}, 120000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  org = randomUUID();
  await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL')", [org]);
  practitioner = await person('practitioner');
  consumer = await person(null, 'consumer');
  patient = randomUUID();
  await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','PATIENT')", [patient, org, 'patient_' + patient.replaceAll('-', '')]);
  await pg.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())", [randomUUID(), org, patient, consumer]);
});

/** A signed note, a copy request, and its fulfilment under a fictional release, all while the clinic is active. */
async function deliveredCopy() {
  const encounter = await call<string>("select clinical_core.start_encounter($1,$2,'follow-up',null) as result", [org, patient]);
  const saved = await call<{ note_id: string }>("select clinical_core.save_note_draft($1,$2,'narrative',$3::jsonb,0,null,'manual','[]'::jsonb) as result", [org, encounter, JSON.stringify({ text: 'Fictional signed narrative.' })]);
  await call('select clinical_core.sign_note($1,1) as result', [saved.note_id]);
  await pg.query("insert into clinical_private.clinic_disclosure_releases(organization_id,release_version,sections,reviewed_by,review_sha256) values($1,$2,$3,'FICTIONAL REVIEWER (test fixture, not an approval)',$4)",
    [org, 'fictional-review-' + randomUUID().slice(0, 8), ['signed_notes'], sha('fictional ' + org)]);
  const requestId = randomUUID();
  await asConsumer({ action: 'submit_copy', requestId, sections: ['signed_notes'] });
  await asWorkforce({ action: 'begin_review', ...decision(requestId, 1) });
  const fulfilled = await asWorkforce({ action: 'fulfill', ...decision(requestId, 2), sections: ['signed_notes'] });
  expect(fulfilled).toMatchObject({ action: 'fulfill', request: { status: 'fulfilled', outcome: 'copy_delivered' } });
  expect(await asConsumer({ action: 'read_copy', requestId, section: 'signed_notes', limit: 10 })).toMatchObject({ action: 'read_copy', items: [{ recordKind: 'clinical_note' }] });
  return requestId;
}
const close = (status: string) => pg.query('update clinical_core.organizations set status=$2 where id=$1', [org, status]);

describe('HELD (D5): patient copies of clinic-held records while the clinic is closed', () => {
  it.each(['suspended', 'archived'])('in a %s clinic the patient can neither ask for a copy nor read one already delivered; the copy is kept', async status => {
    const requestId = await deliveredCopy();
    const copies = await count('clinical_core.clinic_record_copies where organization_id=$1', [org]);
    const items = await count('clinical_core.clinic_record_copy_items i join clinical_core.clinic_record_copies c on c.id=i.copy_id where c.organization_id=$1', [org]);
    await close(status);
    expect(await refusal(asConsumer({ action: 'read_copy', requestId, section: 'signed_notes', limit: 10 }))).toBe('identity_refused');
    expect(await refusal(asConsumer({ action: 'get', requestId }))).toBe('identity_refused');
    expect(await refusal(asConsumer({ action: 'overview' }))).toBe('identity_refused');
    expect(await refusal(asConsumer({ action: 'submit_copy', requestId: randomUUID(), sections: ['signed_notes'] }))).toBe('identity_refused');
    // Custody: nothing delivered is deleted or rewritten by the closure.
    expect(await count('clinical_core.clinic_record_copies where organization_id=$1', [org])).toBe(copies);
    expect(await count('clinical_core.clinic_record_copy_items i join clinical_core.clinic_record_copies c on c.id=i.copy_id where c.organization_id=$1', [org])).toBe(items);
  });

  it('in a suspended clinic no member of the clinic can fulfil or even list a pending request; nothing is written', async () => {
    await pg.query("insert into clinical_private.clinic_disclosure_releases(organization_id,release_version,sections,reviewed_by,review_sha256) values($1,$2,$3,'FICTIONAL REVIEWER (test fixture, not an approval)',$4)",
      [org, 'fictional-review-' + randomUUID().slice(0, 8), ['signed_notes'], sha('fictional pending ' + org)]);
    const requestId = randomUUID();
    await asConsumer({ action: 'submit_copy', requestId, sections: ['signed_notes'] });
    await close('suspended');
    expect(await refusal(asWorkforce({ action: 'queue', limit: 10 }))).toBe('identity_refused');
    expect(await refusal(asWorkforce({ action: 'begin_review', ...decision(requestId, 1) }))).toBe('identity_refused');
    expect(await count('clinical_core.clinic_record_request_events where request_id=$1', [requestId])).toBe(1);
    expect(await count('clinical_core.clinic_record_copies where organization_id=$1', [org])).toBe(0);
  });

  it('the refusal is the deployed care_connection_actor, which every clinic-records action calls; the 116 artifact has no other path', async () => {
    const dispatcher = (await pg.query<{ src: string }>("select prosrc src from pg_proc where oid=to_regprocedure('clinical_core.clinic_record_request(jsonb)')")).rows[0]!.src;
    expect(dispatcher).toContain('clinical_private.care_connection_actor(');
    const actor = (await pg.query<{ src: string }>("select prosrc src from pg_proc where oid=to_regprocedure('clinical_private.care_connection_actor(text,text)')")).rows[0]!.src;
    expect(actor).toContain("from clinical_core.organizations where id=_org and status='active'");
  });
});
