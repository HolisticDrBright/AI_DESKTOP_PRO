import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { BeginTransactionCommand, ExecuteStatementCommand, RollbackTransactionCommand } from '@aws-sdk/client-rds-data';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { inventoryCanonical, inventorySha } from './inventory-qualification-artifacts';
import { inventoryQualificationLedgerArtifact, type InventoryLedgerRow } from './inventory-qualification-ledger';
import { inventoryDatabaseIdentityReader, type InventoryDatabaseIdentityBinding, type InventoryIdentityDatabaseTransport } from './inventory-qualification-database-identity';

// Real 107-schema SQL in embedded PostgreSQL, with a fictional Data API adapter.
// The adapter models the database name only; it is not an AWS observation.
let pg: PGlite, rows: InventoryLedgerRow[];
const u = (n: number) => String(n).repeat(8) + '-1111-4111-8111-111111111111';
const people = { consumer: u(5), foreignConsumer: u(6), workforce: u(7) };
const binding: InventoryDatabaseIdentityBinding = { database: { DatabaseName: 'clinical_core_qualification',
  DatabaseClusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional', DatabaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional' },
  organizationId: u(1), subjects: { consumer: u(2), foreignConsumer: u(3), workforce: u(4) }, cognitoPersonBindingsSha256: inventorySha(inventoryCanonical(people)) };
beforeAll(async () => {
  const a = JSON.parse(execFileSync(process.execPath, ['scripts/build-adopted-plan-inventory-candidate.mjs', '--json'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }));
  rows = inventoryQualificationLedgerArtifact(a);
  pg = new PGlite({ extensions: { pgcrypto } });
  const admin: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({ query: (sql: string, values: unknown[] = []) => tx.query(sql, values) } as ClinicalCoreTransaction)) };
  await applyProductionClinicalCoreMigrations(admin, a.manifest.migrations.map((m: { version: string; file: string }) => ({
    version: m.version, name: m.file.slice(15, -4), sql: a.files[m.file], sha256: createHash('sha256').update(a.files[m.file]).digest('hex'),
  })));
  await pg.query('insert into clinical_core.organizations(id,organization_label) values($1,$2)', [binding.organizationId, 'Fictional qualification clinic']);
  for (const [key, person] of Object.entries(people)) {
    await pg.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [person, `subject_fictional_${key}_0001`]);
    await pg.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)',
      [person, key === 'workforce' ? 'workforce' : 'consumer', binding.subjects[key as keyof typeof binding.subjects]]);
  }
  await pg.query("insert into clinical_core.organization_memberships(id,organization_id,person_id,role) values($1,$2,$3,'practitioner')",
    [u(8), binding.organizationId, people.workforce]);
  await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Qualification')",
    [u(9), binding.organizationId, 'patient_fictional_0001']);
  await pg.query("insert into clinical_core.patient_connections(organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,'verified',clock_timestamp())",
    [binding.organizationId, u(9), people.consumer]);
}, 90000);
afterAll(async () => { await pg?.close(); });

function adapter() {
  const calls: string[] = []; let destroyed = false;
  const make: () => InventoryIdentityDatabaseTransport = () => ({ destroy: () => { destroyed = true; }, send: async command => {
    calls.push(command.constructor.name);
    if (command instanceof BeginTransactionCommand) { await pg.exec('begin'); return { transactionId: 'fictional-embedded-transaction' }; }
    if (command instanceof RollbackTransactionCommand) { await pg.exec('rollback'); return {}; }
    if (!(command instanceof ExecuteStatementCommand)) throw Error('fictional_unexpected_command');
    const sql = command.input.sql!;
    if (sql === 'select current_database()') return { records: [[{ stringValue: binding.database.DatabaseName }]] };
    const parameters = command.input.parameters ?? [], values = parameters.map(p => p.value!.stringValue);
    const actualSql = sql.replace(/:(consumer|foreignConsumer|workforce|organization)\b/g, (_match, name: string) => {
      const n = parameters.findIndex(p => p.name === name); if (n < 0) throw Error('fictional_missing_parameter'); return `$${n + 1}`;
    });
    const result = await pg.query<Record<string, unknown>>(actualSql, values);
    return { records: result.rows.map(r => Object.values(r).map(v => ({ stringValue: String(v) }))) };
  } });
  return { inspect: inventoryDatabaseIdentityReader(rows, make), calls, destroyed: () => destroyed };
}
it('executes the actual bounded SQL against all107 migrations and rolls back without changing metadata or audit counts', async () => {
  const before = await pg.query('select count(*)::int n from clinical_audit.events');
  const f = adapter(), result = await f.inspect(binding);
  expect(result.databaseIdentityAuthorityVerified).toBe(true); expect(result.identityDependenciesVerified).toBe(false);
  expect(f.calls.at(-1)).toBe('RollbackTransactionCommand'); expect(f.destroyed()).toBe(true);
  expect(await pg.query('select count(*)::int n from clinical_audit.events')).toEqual(before);
  expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.identities')).rows[0].n).toBe(3);
});
it('refuses a Cognito person digest that does not equal the real database mappings', async () => {
  await expect(adapter().inspect({ ...binding, cognitoPersonBindingsSha256: 'b'.repeat(64) })).rejects.toThrow('database_identity_authority_refused');
});
const changes = [
  { name: 'disabled person', set: "update clinical_core.persons set status='disabled' where id=$1", restore: "update clinical_core.persons set status='active' where id=$1", values: [people.consumer] },
  { name: 'inactive clinic membership', set: "update clinical_core.organization_memberships set status='suspended' where id=$1", restore: "update clinical_core.organization_memberships set status='active' where id=$1", values: [u(8)] },
  { name: 'insufficient clinic role', set: "update clinical_core.organization_memberships set role='staff' where id=$1", restore: "update clinical_core.organization_memberships set role='practitioner' where id=$1", values: [u(8)] },
  { name: 'foreign consumer connection', set: 'update clinical_core.patient_connections set consumer_person_id=$1 where patient_record_id=$2', restore: 'update clinical_core.patient_connections set consumer_person_id=$1 where patient_record_id=$2', values: [people.foreignConsumer, u(9)], restoreValues: [people.consumer, u(9)] },
  { name: 'second identity on a consumer person', set: "insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce','fictional-extra-subject',true)", restore: "delete from clinical_core.identities where identity_subject='fictional-extra-subject'", values: [people.consumer], restoreValues: [] },
] as const;
for (const c of changes) it(`real SQL refuses ${c.name} and a restored baseline is admitted`, async () => {
  await pg.query(c.set, [...c.values]);
  try { await expect(adapter().inspect(binding)).rejects.toThrow('database_identity_authority_refused'); }
  finally { await pg.query(c.restore, [...('restoreValues' in c ? c.restoreValues : c.values)]); }
  expect((await adapter().inspect(binding)).databaseIdentityAuthorityVerified).toBe(true);
});
