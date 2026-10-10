if (typeof window !== 'undefined') throw Error('fictional identity mapping is server-only');
import { clinicalUuid, type ClinicalCoreDatabase } from './database';
import { inventoryCanonical, inventoryRecord, inventoryRefuse, inventorySha } from './inventory-qualification-artifacts';
import { assertInventoryQualificationLedger, type InventoryLedgerRow } from './inventory-qualification-ledger';
import { isInventoryCognitoSubject } from './inventory-cognito-subject';
import { fixtureBindingHash } from './inventory-qualification-fixtures';
import { inventoryIdentitySnapshotSql, inspectInventoryIdentitySnapshot, type InventoryDatabaseIdentityBinding } from './inventory-qualification-database-identity';

const roles = ['consumer', 'foreignConsumer', 'workforce'] as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const refuse = (): never => inventoryRefuse('fictional_database_mapping_refused');
/** Supplied only by the native read-only observer, never from CLI JSON, environment or review declarations. */
export type FictionalIdentityMapping = {
  bindingSha256: string; organizationId: string;
  people: Record<typeof roles[number], string>; subjects: Record<typeof roles[number], string>;
  personBindingsSha256: string;
};
function binding(raw: FictionalIdentityMapping): FictionalIdentityMapping {
  const b = structuredClone(raw);
  if (!inventoryRecord(b) || Object.keys(b).sort().join(',') !== 'bindingSha256,organizationId,people,personBindingsSha256,subjects'
    || b.bindingSha256 !== fixtureBindingHash || !uuid.test(b.organizationId)) return refuse();
  for (const v of [b.people, b.subjects]) if (!inventoryRecord(v) || Object.keys(v).sort().join(',') !== 'consumer,foreignConsumer,workforce') return refuse();
  if (Object.values(b.people).some(p => !uuid.test(p)) || new Set(Object.values(b.people)).size !== 3
    || Object.values(b.people).includes(b.organizationId) || Object.values(b.subjects).some(s => !isInventoryCognitoSubject(s))
    || new Set(Object.values(b.subjects)).size !== 3 || inventorySha(inventoryCanonical(b.people)) !== b.personBindingsSha256) return refuse();
  return b;
}
const derived = (b: FictionalIdentityMapping, label: string) => {
  const h = inventorySha(inventoryCanonical({ binding: b, label }));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export function fictionalMappingIds(b: FictionalIdentityMapping) {
  const checked = binding(b);
  return { patientRecordId: derived(checked, 'patient'), connectionId: derived(checked, 'connection') };
}

/** Ten identity/link rows only. No consent, provider release, policy, contact,
 * clinical payload, catalog approval, role escalation or production activation.
 * Everything is create-only and one transaction; changed or partial mappings
 * are refused instead of repaired in place. Unknown COMMIT is not retried. */
export async function mapFictionalInventoryIdentities(database: ClinicalCoreDatabase, supplied: FictionalIdentityMapping,
  expected: InventoryLedgerRow[]) {
  const b = binding(supplied), ledger = structuredClone(expected), ids = fictionalMappingIds(b);
  assertInventoryQualificationLedger('clinical_core_qualification', ledger, ledger);
  let commitAttempted = false;
  try {
    const result = await database.transaction(async tx => {
      await tx.query("set local statement_timeout='30s'"); await tx.query("set local lock_timeout='5s'");
      if ((await tx.query<{ name: string }>('select current_database() as name')).rows[0]?.name !== 'clinical_core_qualification') return refuse();
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', ['ai-desktop-pro:qualification-fixtures']);
      await tx.query('lock table clinical_core.schema_migrations in share mode');
      assertInventoryQualificationLedger('clinical_core_qualification', (await tx.query<InventoryLedgerRow>(
        'select version,sha256 from clinical_core.schema_migrations order by version')).rows, ledger);
      // Serialize the exact authority tables against other administrators too.
      await tx.query('lock table clinical_core.organizations,clinical_core.persons,clinical_core.identities,clinical_core.organization_memberships,clinical_core.patient_records,clinical_core.patient_connections in share row exclusive mode');
      const people = roles.map(r => clinicalUuid(b.people[r])), org = clinicalUuid(b.organizationId), patient = clinicalUuid(ids.patientRecordId);
      const values = [...people, org, patient];
      const countSql = `select (
        (select count(*) from clinical_core.organizations where id=$4)+
        (select count(*) from clinical_core.persons where id in($1,$2,$3))+
        (select count(*) from clinical_core.identities where person_id in($1,$2,$3) or identity_subject in($6,$7,$8))+
        (select count(*) from clinical_core.organization_memberships where organization_id=$4 or person_id in($1,$2,$3))+
        (select count(*) from clinical_core.patient_records where id=$5 or organization_id=$4)+
        (select count(*) from clinical_core.patient_connections where consumer_person_id in($1,$2,$3) or organization_id=$4 or patient_record_id=$5)
      )::int as n`;
      const countArgs = [...values, ...roles.map(r => b.subjects[r])];
      const before = Number((await tx.query<{ n: number }>(countSql, countArgs)).rows[0]?.n);
      if (![0, 10].includes(before)) return refuse();
      let inserted = 0;
      const insert = async (sql: string, args: readonly unknown[]) => { inserted += (await tx.query(sql + ' returning 1 as n', args)).rows.length; };
      if (before === 0) {
        await insert('insert into clinical_core.organizations(id,organization_label) values($1,$2)', [org, `Fictional inventory qualification ${b.organizationId}`]);
        for (const role of roles) {
          const person = clinicalUuid(b.people[role]);
          await insert('insert into clinical_core.persons(id,subject_key) values($1,$2)', [person, `subject_inventory_${role.toLowerCase()}_${b.people[role].replaceAll('-', '')}`]);
          await insert('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [person, role === 'workforce' ? 'workforce' : 'consumer', b.subjects[role]]);
        }
        await insert("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [org, people[2]]);
        await insert("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Qualification')", [patient, org, `patient_inventory_${ids.patientRecordId.replaceAll('-', '')}`]);
        await insert("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',clock_timestamp())", [clinicalUuid(ids.connectionId), org, patient, people[0]]);
      }
      if (Number((await tx.query<{ n: number }>(countSql, countArgs)).rows[0]?.n) !== 10 || inserted !== (before === 0 ? 10 : 0)) return refuse();
      const params = { consumer: b.subjects.consumer, foreignConsumer: b.subjects.foreignConsumer, workforce: b.subjects.workforce, organization: b.organizationId };
      const names = Object.keys(params), snapshotSql = inventoryIdentitySnapshotSql.replace(/:(consumer|foreignConsumer|workforce|organization)\b/g, (_m, name: string) => `$${names.indexOf(name) + 1}`);
      const raw = (await tx.query<{ snapshot: string }>(`select (${snapshotSql}) as snapshot`, Object.values(params))).rows[0]?.snapshot;
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65536) return refuse();
      let snapshot: unknown; try { snapshot = JSON.parse(raw); } catch { return refuse(); }
      const databaseBinding: InventoryDatabaseIdentityBinding = { database: { DatabaseName: 'clinical_core_qualification', DatabaseClusterArn: '', DatabaseSecretArn: '' },
        organizationId: b.organizationId, subjects: b.subjects, cognitoPersonBindingsSha256: b.personBindingsSha256 };
      inspectInventoryIdentitySnapshot(snapshot, databaseBinding);
      if (!inventoryRecord(snapshot) || !Array.isArray(snapshot.connections) || snapshot.connections[0]?.id !== ids.connectionId
        || snapshot.connections[0]?.patient_record_id !== ids.patientRecordId) return refuse();
      // Validate exact immutable labels and absence of contact fields on replay.
      const matched = await tx.query<{ n: number }>(`select (
        (select count(*) from clinical_core.organizations where id=$4 and organization_label=$6)+
        (select count(*) from clinical_core.persons where (id=$1 and subject_key=$7) or (id=$2 and subject_key=$8) or (id=$3 and subject_key=$9))+
        (select count(*) from clinical_core.patient_records where id=$5 and first_name='Fictional' and last_name='Qualification' and patient_key=$10 and email is null and phone is null and mrn is null and date_of_birth is null)
      )::int as n`, [...values, `Fictional inventory qualification ${b.organizationId}`, ...roles.map(r => `subject_inventory_${r.toLowerCase()}_${b.people[r].replaceAll('-', '')}`), `patient_inventory_${ids.patientRecordId.replaceAll('-', '')}`]);
      if (Number(matched.rows[0]?.n) !== 5) return refuse();
      commitAttempted = true;
      return { inserted, mappingSha256: inventorySha(inventoryCanonical(snapshot)), ...ids };
    });
    return { contract: 'inventory-qualification-identity-mapping/1', ...result, execution: 'qualification',
      mappingCommitAcknowledged: true, identityRowsMapped: 10, sourceBoundOnly: true,
      databaseIdentityAuthorityVerified: false, consentReleasesWritten: 0, providerReleasesWritten: 0,
      runtimeIsolationVerified: false, retentionServiceIdentityVerified: false, physicalLoginVerified: false,
      acceptance: false, humanReviewsVerified: false, phiAllowed: false, activation: 'blocked' };
  } catch (error) {
    if (commitAttempted) return inventoryRefuse('fictional_mapping_commit_not_observed');
    throw error;
  }
}
