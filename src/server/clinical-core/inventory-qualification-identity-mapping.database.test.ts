import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { clinicalUuid, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from './database';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { inventoryQualificationLedgerArtifact, type InventoryLedgerRow } from './inventory-qualification-ledger';
import { inventoryCanonical, inventorySha } from './inventory-qualification-artifacts';
import { fixtureBindingHash } from './inventory-qualification-fixtures';
import { mapFictionalInventoryIdentities, fictionalMappingIds, type FictionalIdentityMapping } from './inventory-qualification-identity-mapping';

let pg: PGlite, ledger: InventoryLedgerRow[];
const unwrap = (v: unknown) => v && typeof v === 'object' && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v;
function database(options: { databaseName?: string; afterQuery?: (sql: string) => void; loseCommit?: boolean } = {}): ClinicalCoreDatabase {
  return { transaction: async work => {
    const result = await pg.transaction(tx => work({ query: async (sql: string, params: readonly unknown[] = []) => {
      if (sql === 'select current_database() as name') return { rows: [{ name: options.databaseName ?? 'clinical_core_qualification' }] } as never;
      const result = await tx.query(sql, params.map(unwrap)); options.afterQuery?.(sql); return result;
    } } as ClinicalCoreTransaction));
    if (options.loseCommit) throw Error('fictional lost controller receipt after commit');
    return result;
  } };
}
function mapping(): FictionalIdentityMapping {
  const people = { consumer: randomUUID(), foreignConsumer: randomUUID(), workforce: randomUUID() };
  return { bindingSha256: fixtureBindingHash, organizationId: randomUUID(), people,
    subjects: { consumer: `FictionalConsumer_${randomUUID()}`, foreignConsumer: `FictionalForeign_${randomUUID()}`, workforce: `FictionalWorkforce_${randomUUID()}` },
    personBindingsSha256: inventorySha(inventoryCanonical(people)) };
}
const count = async (table: string) => Number((await pg.query<{ n: number }>(`select count(*)::int n from ${table}`)).rows[0].n);
beforeAll(async () => {
  const a = JSON.parse(execFileSync(process.execPath, ['scripts/build-adopted-plan-inventory-candidate.mjs', '--json'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }));
  ledger = inventoryQualificationLedgerArtifact(a);
  pg = new PGlite({ extensions: { pgcrypto } });
  await applyProductionClinicalCoreMigrations(database(), a.manifest.migrations.map((m: { file: string; version: string }) => ({
    version: m.version, name: m.file.slice(15, -4), sql: a.files[m.file], sha256: createHash('sha256').update(a.files[m.file]).digest('hex'),
  })));
}, 90000);
afterAll(async () => { await pg?.close(); });

it('maps only ten fictional authority rows against the real107 schema and replay performs no inserts or approval writes', async () => {
  const b = mapping(), before = await count('clinical_core.identities');
  const result = await mapFictionalInventoryIdentities(database(), b, ledger);
  expect(result).toMatchObject({ inserted: 10, identityRowsMapped: 10, mappingCommitAcknowledged: true,
    consentReleasesWritten: 0, providerReleasesWritten: 0, databaseIdentityAuthorityVerified: false,
    runtimeIsolationVerified: false, physicalLoginVerified: false, acceptance: false, phiAllowed: false, activation: 'blocked' });
  expect(await count('clinical_core.identities')).toBe(before + 3);
  const audit = await count('clinical_audit.events');
  expect(await mapFictionalInventoryIdentities(database(), b, ledger)).toMatchObject({ inserted: 0, mappingSha256: result.mappingSha256 });
  expect(await count('clinical_audit.events')).toBe(audit);
  expect(await count('clinical_core.consent_artifacts')).toBe(0);
  expect(await count('clinical_core.consent_grants')).toBe(0);
  expect(await count('clinical_core.sync_providers')).toBe(0);
});

it('refuses staging and unknown/changed ledger before any identity insertion', async () => {
  const b = mapping(), before = await count('clinical_core.identities');
  await expect(mapFictionalInventoryIdentities(database({ databaseName: 'clinical_core' }), b, ledger)).rejects.toThrow();
  await pg.query("update clinical_core.schema_migrations set sha256=$1 where version=$2", ['f'.repeat(64), ledger[106].version]);
  try { await expect(mapFictionalInventoryIdentities(database(), b, ledger)).rejects.toThrow(); }
  finally { await pg.query('update clinical_core.schema_migrations set sha256=$1 where version=$2', [ledger[106].sha256, ledger[106].version]); }
  expect(await count('clinical_core.identities')).toBe(before);
});

it('a denied intermediate write rolls back every new row and is not retried', async () => {
  const b = mapping(), before = await count('clinical_core.organizations'); let attempted = 0;
  await expect(mapFictionalInventoryIdentities(database({ afterQuery: sql => {
    if (sql.startsWith('insert into clinical_core.identities')) { attempted++; throw Error('fictional interrupted transaction'); }
  } }), b, ledger)).rejects.toThrow();
  expect(attempted).toBe(1); expect(await count('clinical_core.organizations')).toBe(before);
  expect((await pg.query('select id from clinical_core.persons where id=$1', [b.people.consumer])).rows).toEqual([]);
});

it('a lost commit receipt is unknown, and a separately inspected exact replay inserts nothing', async () => {
  const b = mapping();
  await expect(mapFictionalInventoryIdentities(database({ loseCommit: true }), b, ledger)).rejects.toThrow('fictional_mapping_commit_not_observed');
  expect(await mapFictionalInventoryIdentities(database(), b, ledger)).toMatchObject({ inserted: 0 });
});

it('refuses partial pre-existing mappings without filling missing authority', async () => {
  const b = mapping();
  await pg.query('insert into clinical_core.organizations(id,organization_label) values($1,$2)', [b.organizationId, 'Fictional partial baseline']);
  await expect(mapFictionalInventoryIdentities(database(), b, ledger)).rejects.toThrow('fictional_database_mapping_refused');
  expect((await pg.query('select id from clinical_core.persons where id=$1', [b.people.consumer])).rows).toEqual([]);
});

it('refuses alias pollution and wrong patient bindings on exact replay instead of changing them', async () => {
  const b = mapping(); await mapFictionalInventoryIdentities(database(), b, ledger);
  await pg.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [b.people.consumer, `FictionalAlias_${randomUUID()}`]);
  await expect(mapFictionalInventoryIdentities(database(), b, ledger)).rejects.toThrow();
  const c = mapping(); await mapFictionalInventoryIdentities(database(), c, ledger);
  await pg.query('update clinical_core.patient_connections set consumer_person_id=$1 where id=$2', [c.people.foreignConsumer, fictionalMappingIds(c).connectionId]);
  await expect(mapFictionalInventoryIdentities(database(), c, ledger)).rejects.toThrow();
});

it('refuses changed fixture labels, contact data and insufficient workforce role on replay', async () => {
  for (const change of ['label', 'contact', 'role']) {
    const b = mapping(); await mapFictionalInventoryIdentities(database(), b, ledger);
    if (change === 'label') await pg.query('update clinical_core.organizations set organization_label=$1 where id=$2', ['Changed fictional label', b.organizationId]);
    if (change === 'contact') await pg.query('update clinical_core.patient_records set email=$1 where id=$2', ['fictional@example.invalid', fictionalMappingIds(b).patientRecordId]);
    if (change === 'role') await pg.query("update clinical_core.organization_memberships set role='staff' where person_id=$1", [b.people.workforce]);
    await expect(mapFictionalInventoryIdentities(database(), b, ledger)).rejects.toThrow();
  }
});

it('validates binding, separation and observed person digest before opening a database transaction', async () => {
  const b = mapping(); let opened = 0;
  const never: ClinicalCoreDatabase = { transaction: async () => { opened++; throw Error('should not open'); } };
  for (const bad of [ { ...b, bindingSha256: 'a'.repeat(64) }, { ...b, personBindingsSha256: 'b'.repeat(64) },
    { ...b, people: { ...b.people, foreignConsumer: b.people.consumer } },
    { ...b, subjects: { ...b.subjects, workforce: b.subjects.consumer } }, { ...b, organizationId: b.people.consumer },
    { ...b, approved: true }, { ...b, people: { ...b.people, consumer: 'not-a-person-id' } } ]) {
    await expect(mapFictionalInventoryIdentities(never, bad as FictionalIdentityMapping, ledger)).rejects.toThrow();
  }
  expect(opened).toBe(0);
});

it('real clinical role sees its own link and the foreign consumer cannot use or impersonate it', async () => {
  const b = mapping(); await mapFictionalInventoryIdentities(database(), b, ledger);
  const read = (person: string, subject: string) => pg.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',
      [person, b.organizationId, 'consumer', subject, 'consent_management', 'production-clinical', 'clinical_phi']);
    return (await tx.query('select id from clinical_core.patient_connections where id=$1', [fictionalMappingIds(b).connectionId])).rows;
  });
  expect(await read(b.people.consumer, b.subjects.consumer)).toHaveLength(1);
  expect(await read(b.people.foreignConsumer, b.subjects.foreignConsumer)).toHaveLength(0);
  await expect(read(b.people.consumer, b.subjects.foreignConsumer)).rejects.toThrow();
  const badRole = await pg.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    return tx.query('select id from clinical_core.patient_connections');
  });
  expect(badRole.rows).toHaveLength(0);
  // This uses a real SQL role and RLS in embedded Postgres, not an AWS runtime proof.
  expect(clinicalUuid(b.people.consumer).value).toBe(b.people.consumer);
});
