import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import type { ClinicalCoreDatabase } from './database';

// Fictional reduced-role proof. This candidate is not registered or applied to AWS.
const candidate = 'infra/aws-clinical-core/production-candidates/delegated-protocol-records.sql';
let db: PGlite;
const id = () => randomUUID();
const subject = (person: string) => 'fictional-' + person;
const queryAs = async (person: string, org: string, rel: string, scope = 'protocols_supplements') =>
  db.transaction(async (tx) => {
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,'consumer',$3,'clinical_data','production-clinical','clinical_phi')", [person, org, subject(person)]);
    const result = await tx.query<{ data: unknown }>(
      'select clinical_core.get_delegated_patient_records($1,$2) as data', [rel, scope]);
    return result.rows[0]!.data as { items: Record<string, unknown>[] };
  });

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath,
    ['scripts/build-telehealth-consent-copy-candidate.mjs', '--json'],
    { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  expect(manifest.migrations).toHaveLength(112);
  db = new PGlite({ extensions: { pgcrypto } });
  const entries = (manifest.migrations as Array<{ version: string; file: string }>).map((entry) => ({
    version: entry.version, name: entry.file.slice(15, -4), sql: files[entry.file] as string,
    sha256: createHash('sha256').update(files[entry.file] as string).digest('hex'),
  }));
  const admin: ClinicalCoreDatabase = { transaction: (work) => db.transaction((tx) => work({
    query: (sql, parameters = []) => tx.query(sql, [...parameters]),
  })) };
  await applyProductionClinicalCoreMigrations(admin, entries.slice(0, 106));
  // Forward source rehearsal: these ledger rows are fictional in-memory facts,
  // not evidence of an approved or deployed 107→112 preserving upgrade.
  for (const entry of entries.slice(106)) {
    await db.exec(entry.sql);
    await db.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',
      [entry.version, entry.name, entry.sha256]);
  }
  await db.exec(readFileSync(candidate, 'utf8'));
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('caregiver supplement payload at the database boundary', () => {
  it('sends only active practitioner-approved, verified non-peptide instructions, withholds other bytes and refuses other people', async () => {
    const org = id(), clinician = id(), recipient = id(), outsider = id(), patient = id(), rel = id();
    const protocol = id(), version = id(), safeItem = id(), peptideItem = id();
    const batch = id(), productVersion = id();
    const product = 'prd_fixture_' + id().replaceAll('-', '');
    await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL CLINIC')", [org]);
    for (const [person, pool] of [[clinician, 'workforce'], [recipient, 'consumer'], [outsider, 'consumer']] as const) {
      await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [person, 'subject_' + person.replaceAll('-', '')]);
      await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [person, pool, subject(person)]);
    }
    await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','PARENT')",
      [patient, org, 'patient_' + patient.replaceAll('-', '')]);
    await db.query(`insert into clinical_core.patient_relationships(id,organization_id,patient_record_id,recipient_person_id,display_name,
      masked_email,recipient_email_sha256,relationship_type,requested_scopes,granted_scopes,status,invitation_code_sha256,
      invitation_expires_at,access_duration_days,access_expires_at,invited_by_person_id,patient_approved_at,recipient_claimed_at)
      values($1,$2,$3,$4,'FICTIONAL RECIPIENT','f***@example.test',$5,'adult_child',
      array['protocols_supplements'],array['protocols_supplements'],'active',$6,
      now()+interval '1 day',30,now()+interval '30 days',$7,now(),now())`,
      [rel, org, patient, recipient, 'a'.repeat(64), 'b'.repeat(64), clinician]);
    await db.query(`insert into clinical_reference.catalog_import_batches(id,contract_version,source_package_id,source_package_version,manifest_sha256,environment,status)
      values($1,'FICTIONAL/1',$2,'FICTIONAL/1',$3,'production-clinical','succeeded')`, [batch, 'fixture-' + batch, batch.replaceAll('-', '').repeat(2)]);
    await db.query("insert into clinical_reference.catalog_products(stable_id,review_status,active_version,environment) values($1,'approved',1,'production-clinical')", [product]);
    await db.query(`insert into clinical_reference.catalog_product_versions(id,product_stable_id,version,display_name,product_type,access_tier,
      direct_order_allowed,label_sha256,content_sha256,clinical_payload,source_refs,review_status,import_batch_id)
      values($1,$2,1,'FICTIONAL magnesium','supplement','open',true,$3,$4,'{}','["fictional-source"]','approved',$5)`,
      [productVersion, product, 'b'.repeat(64), 'a'.repeat(64), batch]);
    await db.query("insert into clinical_reference.product_label_verifications(product_version_id,reviewer_person_id,verification_note) values($1,$2,'FICTIONAL verified label')", [productVersion, clinician]);
    await db.query("insert into clinical_core.patient_protocols(id,organization_id,patient_record_id,title,status,created_by_person_id,updated_by_person_id) values($1,$2,$3,'BPC SECRET TITLE','draft',$4,$4)", [protocol, org, patient, clinician]);
    await db.query(`insert into clinical_core.patient_protocol_versions(id,organization_id,protocol_id,patient_record_id,version,status,title,summary,
      approved_by_person_id,approved_at,activated_by_person_id,activated_at,created_by_person_id,updated_by_person_id)
      values($1,$2,$3,$4,1,'draft','BPC SECRET TITLE','BPC SECRET SUMMARY',$5,now(),$5,now(),$5,$5)`, [version, org, protocol, patient, clinician]);
    await db.query(`insert into clinical_core.patient_protocol_items(id,protocol_version_id,position,kind,label,instructions,
      catalog_product_stable_id,catalog_product_version,dosage_text,timing_text,verification_status,interaction_review_state,
      interaction_reviewed_by_person_id,interaction_reviewed_at)
      values($1,$2,0,'product','FICTIONAL magnesium','With food. Order https://example.test/buy',
      $3,1,'100 mg','morning','label_verified','reviewed_by_practitioner',$5,now()),
      ($4,$2,1,'product','BPC-157 SECRET','inject 250 mcg',null,null,'250 mcg','morning','unverified','not_completed',null,null)`,
      [safeItem, version, product, peptideItem, clinician]);
    await db.query("update clinical_core.patient_protocol_versions set status='active' where id=$1", [version]);
    await db.query("update clinical_core.patient_protocols set status='active',active_version_id=$2,current_version_id=$2 where id=$1", [protocol, version]);
    const before = await queryAs(recipient, org, rel);
    expect(before.items).toHaveLength(1);
    expect(before.items[0]).toMatchObject({ approvalSource: 'clinic_practitioner', heldItems: 1,
      items: [{ id: safeItem, sourceProductType: 'supplement', practitionerApproved: true, dosageText: '100 mg' }] });
    expect(JSON.stringify(before)).not.toMatch(/BPC|250 mcg|https?:\/\/example[.]test\/buy/);
    await expect(queryAs(outsider, org, rel)).rejects.toThrow(/delegated_access_refused/);
    await db.query("update clinical_core.patient_relationships set status='revoked',revoked_at=now() where id=$1", [rel]);
    await expect(queryAs(recipient, org, rel)).rejects.toThrow(/delegated_access_refused/);
  }, 120_000);

  it('refuses when the relationship is revoked after the content read but before release', async () => {
    const org = id(), clinician = id(), recipient = id(), patient = id(), rel = id();
    await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL RACE CLINIC')", [org]);
    for (const [person, pool] of [[clinician, 'workforce'], [recipient, 'consumer']] as const) {
      await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [person, 'subject_' + person.replaceAll('-', '')]);
      await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)',
        [person, pool, subject(person)]);
    }
    await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','PARENT')",
      [patient, org, 'patient_' + patient.replaceAll('-', '')]);
    await db.query(`insert into clinical_core.patient_relationships(id,organization_id,patient_record_id,recipient_person_id,display_name,
      masked_email,recipient_email_sha256,relationship_type,requested_scopes,granted_scopes,status,invitation_code_sha256,
      invitation_expires_at,access_duration_days,access_expires_at,invited_by_person_id,patient_approved_at,recipient_claimed_at)
      values($1,$2,$3,$4,'FICTIONAL RECIPIENT','f***@example.test',$5,'adult_child',
      array['protocols_supplements'],array['protocols_supplements'],'active',$6,
      now()+interval '1 day',30,now()+interval '30 days',$7,now(),now())`,
      [rel, org, patient, recipient, 'c'.repeat(64), 'd'.repeat(64), clinician]);
    // A deterministic surrogate for revocation during payload construction:
    // the access-audit write revokes this relationship before the function returns.
    await db.exec(`create function clinical_core.fixture_revoke_delegated_read() returns trigger
      language plpgsql security definer set search_path='' as $$ begin
        if new.relationship_id = '${rel}'::uuid then
          update clinical_core.patient_relationships set status='revoked',revoked_at=clock_timestamp()
            where id=new.relationship_id;
        end if;
        return new;
      end $$;
      create trigger fixture_revoke_delegated_read after insert on clinical_audit.patient_relationship_events
        for each row execute function clinical_core.fixture_revoke_delegated_read();`);
    try {
      await expect(queryAs(recipient, org, rel)).rejects.toThrow(/delegated_access_refused/);
      const result = await db.query<{ status: string }>('select status from clinical_core.patient_relationships where id=$1', [rel]);
      expect(result.rows[0]?.status).toBe('active'); // failed read and trigger are rolled back together
    } finally {
      await db.exec(`drop trigger fixture_revoke_delegated_read on clinical_audit.patient_relationship_events;
        drop function clinical_core.fixture_revoke_delegated_read();`);
    }
  }, 120_000);
});
