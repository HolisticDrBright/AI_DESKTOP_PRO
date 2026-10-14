import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import type { ClinicalCoreDatabase } from './database';

/** Source-only, fictional role test. The SQL candidate is not registered or deployed. */
let db: PGlite;
let org: string, otherOrg: string, practitioner: string, outsider: string, patient: string, encounter: string;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const candidatePath = 'infra/aws-clinical-core/production-candidates/emr-note-save-settlement.sql';
const candidate = readFileSync(candidatePath, 'utf8');

async function asCaller<T>(sql: string, args: unknown[], who = practitioner, organization = org): Promise<T> {
  return db.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','production-clinical','clinical_phi')",
      [who, organization, 'subject-' + who]);
    return (await tx.query<{ result: T }>(sql, args)).rows[0]?.result as T;
  });
}
type Receipt = { note_id: string; version: number; saved_at: string; replayed: boolean };
const args = (requestId: string, content: Record<string, string>, noteId: string | null = null, expectedVersion = 0) =>
  [org, encounter, 'soap', JSON.stringify(content), expectedVersion, noteId, 'manual', '[]', requestId];
const SAVE = 'select clinical_core.save_note_draft_idempotent($1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb,$9) as result';
const STATUS = 'select clinical_core.get_note_save_receipt($1,$2,$3) as result';
const save = (requestId: string, content = { S: 'Fictional history' }, noteId: string | null = null, expectedVersion = 0) =>
  asCaller<Receipt>(SAVE, args(requestId, content, noteId, expectedVersion));
const reason = async (promise: Promise<unknown>) => {
  try { await promise; return 'no_error'; } catch (error) { return error instanceof Error ? error.message : String(error); }
};

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 20000 })) as {
    manifest: { migrations: Array<{ version: string; file: string }> };
    files: Record<string, string>;
  };
  const migrations = artifact.manifest.migrations.map(entry => {
    const sql = artifact.files[entry.file];
    return { version: entry.version, name: entry.file.slice(15, -4), sql, sha256: sha(sql) };
  });
  const admin: ClinicalCoreDatabase = { transaction: work => db.transaction(tx => work({ query: (sql, parameters = []) => tx.query(sql, [...parameters]) })) };
  await applyProductionClinicalCoreMigrations(admin, migrations);
  await db.exec(candidate);
  [org, otherOrg, practitioner, outsider, patient, encounter] = Array.from({ length: 6 }, () => randomUUID());
  for (const id of [org, otherOrg]) await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL')", [id]);
  for (const [id, organization] of [[practitioner, org], [outsider, otherOrg]]) {
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [id, 'subject-' + id]);
    await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [organization, id]);
  }
  await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','PATIENT')",
    [patient, org, 'patient_' + patient.replaceAll('-', '')]);
  await db.query("insert into clinical_core.encounters(id,organization_id,patient_record_id,visit_type,status,practitioner_person_id) values($1,$2,$3,'follow-up','in_progress',$4)",
    [encounter, org, patient, practitioner]);
}, 120000);
afterAll(async () => { await db?.close(); });

describe('blocked idempotent EMR note save candidate', () => {
  it('replays a lost first-create reply without a second draft, version or audit event', async () => {
    const requestId = randomUUID();
    const first = await save(requestId);
    const replay = await save(requestId);
    expect(first).toMatchObject({ version: 1, replayed: false });
    expect(replay).toMatchObject({ note_id: first.note_id, version: 1, replayed: true });
    const rows = await db.query<{ notes: number; versions: number; events: number }>(`select
      (select count(*)::int from clinical_core.clinical_notes where id=$1) notes,
      (select count(*)::int from clinical_core.clinical_note_versions where note_id=$1) versions,
      (select count(*)::int from clinical_audit.events where resource_id=$1 and action='note.draft_created') events`, [first.note_id]);
    expect(rows.rows[0]).toEqual({ notes: 1, versions: 1, events: 1 });
    expect(await asCaller<{ state: string; note_id: string }>(STATUS, [org, encounter, requestId]))
      .toMatchObject({ state: 'saved', note_id: first.note_id });
  });

  it('refuses changed payload under the same request identity', async () => {
    const requestId = randomUUID();
    const first = await save(requestId);
    expect(await reason(save(requestId, { S: 'Changed text' }))).toContain('note_save_request_mismatch');
    const count = await db.query<{ n: number }>('select count(*)::int n from clinical_core.clinical_notes where id=$1', [first.note_id]);
    expect(count.rows[0].n).toBe(1);
  });

  it('a failed original transaction has no receipt or note and permits an exact retry', async () => {
    const requestId = randomUUID();
    expect(await reason(save(requestId, { S: 'x'.repeat(70000) }))).toContain('note_content_invalid');
    expect(await asCaller<{ state: string }>(STATUS, [org, encounter, requestId])).toEqual({ state: 'unconfirmed' });
    const receipt = await save(requestId);
    expect(receipt).toMatchObject({ version: 1, replayed: false });
  });

  it('replays a known-note update and does not make version three', async () => {
    const first = await save(randomUUID());
    const requestId = randomUUID();
    const updated = await save(requestId, { S: 'Fictional updated history' }, first.note_id, 1);
    expect(updated).toMatchObject({ note_id: first.note_id, version: 2, replayed: false });
    expect(await save(requestId, { S: 'Fictional updated history' }, first.note_id, 1))
      .toMatchObject({ note_id: first.note_id, version: 2, replayed: true });
    const rows = await db.query<{ n: number }>('select count(*)::int n from clinical_core.clinical_note_versions where note_id=$1', [first.note_id]);
    expect(rows.rows[0].n).toBe(2);
  });

  it('does not reveal a receipt to a different practitioner or clinic', async () => {
    const requestId = randomUUID();
    await save(requestId);
    expect(await reason(asCaller(STATUS, [org, encounter, requestId], outsider, otherOrg))).not.toBe('no_error');
    expect(await reason(asCaller(SAVE, args(requestId, { S: 'Fictional history' }), outsider, otherOrg))).not.toBe('no_error');
  });

  it('has no API-role table access and cannot mutate a saved receipt', async () => {
    const requestId = randomUUID();
    await save(requestId);
    expect(await reason(asCaller('select count(*)::int as result from clinical_private.note_save_receipts', []))).toContain('permission denied');
    expect(await reason(asCaller('update clinical_private.note_save_receipts set request_sha256=$1 where request_id=$2 returning request_id as result',
      ['0'.repeat(64), requestId]))).toContain('permission denied');
  });
});
