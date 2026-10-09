import { beforeAll, afterAll, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Provenance has to be provable from a row, not argued from table names: which records are consumer records, and can a
// clinic's protected information have landed among them. These cases run the real SQL against the built artifact.
const owner = randomUUID(), org = randomUUID();
let db: PGlite;
async function actor(sql: string, params: unknown[] = [], purpose = 'clinical_data') {
  return db.transaction(async (tx) => {
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,'consumer',$3,$4,'production-clinical','clinical_phi')", [owner, org, 'subject-' + owner, purpose]);
    return tx.query(sql, params);
  });
}
const write = (recordId: string, revision: number, payload: Record<string, unknown>, request = randomUUID()) => actor(
  "select clinical_core.write_owned_consumer_record('symptom_logs',$1,$2,$3,$4::jsonb,false,1) as result", [recordId, revision, request, JSON.stringify(payload)]);

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15000 }));
  db = new PGlite({ extensions: { pgcrypto } });
  for (const m of manifest.migrations) await db.exec(files[m.file]);
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'Fictional provenance test')", [org]);
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [owner, 'subject_' + owner.replaceAll('-', '')]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'consumer',$2,true)", [owner, 'subject-' + owner]);
  await db.exec("insert into clinical_private.consumer_storage_consent_releases(scope,version,content,content_sha256,approved_by,approved_at) values('symptoms_adherence','fictional-provenance','Fictional only',encode(public.digest('Fictional only','sha256'),'hex'),'TEST NOT APPROVAL',now())");
  await actor("select clinical_core.set_owned_consumer_consent('symptoms_adherence','granted','fictional-provenance',0)", [], 'consent_management');
}, 60000);
afterAll(async () => { await db?.close(); });

it('sets the regime at ingestion, on every revision, and reports it to the writer', async () => {
  const recordId = randomUUID();
  const first = await write(recordId, 0, { severity: 2 });
  expect((first.rows[0] as { result: Record<string, unknown> }).result).toMatchObject({ revision: 1, sourceRegime: 'consumer_self_entered' });
  const second = await write(recordId, 1, { severity: 3 });
  expect((second.rows[0] as { result: Record<string, unknown> }).result).toMatchObject({ revision: 2, sourceRegime: 'consumer_self_entered' });
  const stored = await db.query<{ revision: number; source_regime: string }>(
    'select revision, source_regime from clinical_core.owned_consumer_record_versions where owner_id=$1 and record_id=$2 order by revision', [owner, recordId]);
  expect(stored.rows).toEqual([{ revision: 1, source_regime: 'consumer_self_entered' }, { revision: 2, source_regime: 'consumer_self_entered' }]);
});

it('cannot hold a clinic-authority record at all, and cannot be reclassified later', async () => {
  const recordId = randomUUID();
  await write(recordId, 0, { severity: 1 });
  // The store admits one regime. A clinic-authority row is refused by the column itself, not by a convention.
  await expect(db.query(
    `insert into clinical_core.owned_consumer_record_versions(owner_id,collection,record_id,revision,request_id,command_sha256,payload,deleted,consent_revision,source_regime)
     values($1,'symptom_logs',$2,9,$3,repeat('a',64),'{}'::jsonb,false,1,'practitioner_connected_phi')`,
    [owner, randomUUID(), randomUUID()])).rejects.toThrow();
  // A later revision may not restate the regime differently: reclassification after the fact is the inference this rules out.
  await expect(db.query(
    `insert into clinical_core.owned_consumer_record_versions(owner_id,collection,record_id,revision,request_id,command_sha256,payload,deleted,consent_revision,source_regime)
     values($1,'symptom_logs',$2,2,$3,repeat('b',64),'{}'::jsonb,false,1,'clinic_authority')`,
    [owner, recordId, randomUUID()])).rejects.toThrow();
  // Nor may a stored row be rewritten to another regime.
  await expect(db.query("update clinical_core.owned_consumer_record_versions set source_regime='clinic_authority' where owner_id=$1 and record_id=$2", [owner, recordId]))
    .rejects.toThrow();
  const after = await db.query<{ source_regime: string }>('select distinct source_regime from clinical_core.owned_consumer_record_versions where owner_id=$1', [owner]);
  expect(after.rows).toEqual([{ source_regime: 'consumer_self_entered' }]);
});
