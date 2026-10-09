import { beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { inventoryCanonical, inventorySha } from './inventory-qualification-artifacts';
import { inventoryQualificationLedgerArtifact, type InventoryLedgerRow } from './inventory-qualification-ledger';
import { inventoryDatabaseIdentityReader, type InventoryDatabaseIdentityBinding, type InventoryIdentityDatabaseTransport } from './inventory-qualification-database-identity';

type Row = Record<string, unknown>;
let ledger: InventoryLedgerRow[];
const u = (n: number) => String(n).repeat(8) + '-1111-4111-8111-111111111111';
const people = { consumer: u(5), foreignConsumer: u(6), workforce: u(7) };
const binding: InventoryDatabaseIdentityBinding = { database: { DatabaseName: 'clinical_core_qualification',
  DatabaseClusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional', DatabaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional' },
  organizationId: u(1), subjects: { consumer: u(2), foreignConsumer: u(3), workforce: u(4) }, cognitoPersonBindingsSha256: inventorySha(inventoryCanonical(people)) };
function snapshot() {
  return { identities: Object.entries(binding.subjects).map(([key, subject], n) => ({ id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n + 1).padStart(12, '0')}`,
    person_id: people[key as keyof typeof people], identity_pool: key === 'workforce' ? 'workforce' : 'consumer', identity_subject: subject,
    status: 'active', production_bound: true, person_status: 'active', data_classification: 'clinical_phi', contains_phi: true })),
    organizations: [{ id: u(1), status: 'active', environment: 'production-clinical', data_classification: 'clinical_phi', contains_phi: true }],
    memberships: [{ id: u(8), person_id: people.workforce, organization_id: u(1), role: 'practitioner', status: 'active' }],
    connections: [{ id: u(9), consumer_person_id: people.consumer, organization_id: u(1), patient_record_id: u(8), state: 'verified', verified: true,
      patient_status: 'active', data_classification: 'clinical_phi', contains_phi: true }], directory: [] as Row[] };
}
beforeAll(() => {
  const a = JSON.parse(execFileSync(process.execPath, ['scripts/build-adopted-plan-inventory-candidate.mjs', '--json'], { encoding: 'utf8',
    timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })); ledger = inventoryQualificationLedgerArtifact(a);
}, 35000);
function fixture(mode = 'good', supplied = snapshot()) {
  const calls: Array<{ type: string; input: Row }> = []; let destroyed = false, snapshots = 0;
  const make: () => InventoryIdentityDatabaseTransport = () => ({ destroy: () => { destroyed = true; }, send: async (command, options) => {
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    const type = command.constructor.name, input = command.input as unknown as Row; calls.push({ type, input });
    if (type === 'BeginTransactionCommand') {
      if (mode === 'resuming') { const e = Error('private provider detail'); e.name = 'DatabaseResumingException'; throw e; }
      return mode === 'missing transaction' ? {} : { transactionId: 'fictional-transaction' };
    }
    if (type === 'RollbackTransactionCommand') { if (mode === 'rollback error') throw Error('private rollback detail'); return {}; }
    if (mode === 'query error') throw Error('private SQL detail');
    const sql = String(input.sql);
    if (sql.startsWith('set ')) return {};
    if (sql === 'select current_database()') return { records: [[{ stringValue: mode === 'wrong database' ? 'clinical_core' : binding.database.DatabaseName }]] };
    if (sql === 'select version,sha256 from clinical_core.schema_migrations order by version')
      return { records: ledger.slice(0, mode === 'parent' ? 106 : 107).map((r, n) => [{ stringValue: r.version }, { stringValue: mode === 'changed ledger' && n === 0 ? 'a'.repeat(64) : r.sha256 }]) };
    expect(sql).toContain('with selected_people'); snapshots += 1;
    let text = JSON.stringify(supplied);
    if (mode === 'drift' && snapshots === 2) text = text.replace('practitioner', 'admin');
    if (mode === 'too large') text = ' '.repeat(65537);
    return { records: [[mode === 'wrong field' ? { blobValue: text } : { stringValue: text }]] };
  } });
  return { inspect: inventoryDatabaseIdentityReader(ledger, make), calls, destroyed: () => destroyed };
}
it('pins the successor, Cognito person mapping, clinic role and isolation inside a physically rolled-back read-only transaction', async () => {
  const f = fixture(), r = await f.inspect(binding);
  expect(r).toMatchObject({ databaseIdentityAuthorityVerified: true, successorLedgerVerified: true, designatedUsers: 3,
    workforceMemberships: 1, verifiedPatientConnections: 1, foreignConsumerConnections: 0, rolledBack: true, writes: false,
    identityDependenciesVerified: false, retentionServiceIdentityVerified: false, physicalLoginVerified: false, acceptance: false, phiAllowed: false });
  expect(r.observationSha256).toMatch(/^[a-f0-9]{64}$/); expect(f.destroyed()).toBe(true);
  expect(JSON.stringify(r)).not.toContain(binding.organizationId); expect(JSON.stringify(r)).not.toContain(people.consumer);
  expect(f.calls.at(-1)?.type).toBe('RollbackTransactionCommand');
  expect(f.calls.filter(c => c.type === 'BeginTransactionCommand')).toHaveLength(1);
  const reads = f.calls.filter(c => String(c.input.sql).startsWith('with selected_people'));
  expect(reads).toHaveLength(2); expect(reads[0].input).toEqual(reads[1].input);
  expect(reads[0].input.parameters).toEqual(Object.entries({ ...binding.subjects, organization: binding.organizationId }).map(([name, value]) => ({ name, value: { stringValue: value } })));
  for (const c of f.calls) {
    expect(c.input.resourceArn).toBe(binding.database.DatabaseClusterArn); expect(c.input.secretArn).toBe(binding.database.DatabaseSecretArn);
    expect(c.type).not.toBe('CommitTransactionCommand');
    if (c.type === 'ExecuteStatementCommand') expect(c.input.database).toBe(binding.database.DatabaseName);
  }
});
it('refuses target, subject, caller-digest and shape substitutions before constructing an AWS client', async () => {
  const mutations: Array<(b: InventoryDatabaseIdentityBinding) => void> = [
    b => { b.database.DatabaseName = 'clinical_core'; }, b => { b.database.DatabaseClusterArn = b.database.DatabaseClusterArn.replace('588966314750', '173535830222'); },
    b => { b.database.DatabaseSecretArn = b.database.DatabaseSecretArn.replace('us-east-2', 'us-west-2'); }, b => { b.organizationId = 'invalid'; },
    b => { b.subjects.workforce = b.subjects.consumer; }, b => { b.subjects.consumer = 'supplied@email.invalid'; },
    b => { b.cognitoPersonBindingsSha256 = '0'.repeat(64); }, b => { b.cognitoPersonBindingsSha256 = 'true'; },
    b => { (b as unknown as Row).approved = true; }, b => { (b.database as unknown as Row).sql = 'select supplied'; },
  ];
  for (const mutate of mutations) {
    const b = structuredClone(binding); mutate(b);
    await expect(inventoryDatabaseIdentityReader(ledger, () => { throw Error('must not construct'); })(b)).rejects.toThrow('database_identity_authority_refused');
  }
});
it('refuses unsafe, aliased, cross-clinic or inactive observed authority rather than trusting a present identity', async () => {
  const mutations: Array<(s: ReturnType<typeof snapshot>) => void> = [
    s => { s.identities.pop(); }, s => { s.identities.push(s.identities[0]); }, s => { s.identities[1].id = s.identities[0].id; },
    s => { s.identities[1].person_id = s.identities[0].person_id; }, s => { s.identities[0].person_id = u(9); },
    s => { s.identities[0].identity_pool = 'workforce'; }, s => { s.identities[0].identity_subject = u(9); },
    s => { s.identities[0].status = 'disabled'; }, s => { s.identities[0].person_status = 'disabled'; }, s => { s.identities[0].production_bound = false; },
    s => { s.identities[0].contains_phi = false; }, s => { s.identities[0].data_classification = 'synthetic_only'; },
    s => { s.organizations = []; }, s => { s.organizations[0].status = 'suspended'; }, s => { s.organizations[0].environment = 'synthetic-staging'; },
    s => { s.organizations[0].id = u(9); }, s => { s.memberships = []; }, s => { s.memberships[0].status = 'pending'; },
    s => { s.memberships[0].person_id = people.consumer; }, s => { s.memberships[0].organization_id = u(9); }, s => { s.memberships[0].role = 'staff'; },
    s => { s.memberships.push({ ...s.memberships[0], id: u(9), person_id: people.foreignConsumer }); },
    s => { s.connections = []; }, s => { s.connections[0].consumer_person_id = people.foreignConsumer; }, s => { s.connections[0].organization_id = u(9); },
    s => { s.connections[0].verified = false; }, s => { s.connections[0].state = 'paused'; }, s => { s.connections[0].patient_status = 'archived'; },
    s => { s.connections.push({ ...s.connections[0], consumer_person_id: people.foreignConsumer }); },
    s => { s.directory.push({ person_id: people.consumer, identity_subject: binding.subjects.consumer, status: 'active' }); },
    s => { s.directory.push({ person_id: people.workforce, identity_subject: binding.subjects.consumer, status: 'active' }); },
    s => { (s as unknown as Row).accepted = true; }, s => { (s.identities[0] as Row).email = 'private'; },
    s => { s.directory = Array.from({ length: 17 }, () => ({ person_id: people.workforce, identity_subject: binding.subjects.workforce, status: 'active' })); },
  ];
  await fixture().inspect(binding);
  for (const mutate of mutations) {
    const s = snapshot(); mutate(s); const f = fixture('good', s);
    await expect(f.inspect(binding)).rejects.toThrow('database_identity_authority_refused');
    expect(f.calls.at(-1)?.type).toBe('RollbackTransactionCommand'); expect(f.destroyed()).toBe(true);
  }
  const withDirectory = snapshot(); withDirectory.directory.push({ person_id: people.workforce, identity_subject: binding.subjects.workforce, status: 'active' });
  expect((await fixture('good', withDirectory).inspect(binding)).databaseIdentityAuthorityVerified).toBe(true);
});
for (const mode of ['parent', 'changed ledger', 'wrong database', 'wrong field', 'too large', 'drift', 'query error', 'rollback error', 'resuming', 'missing transaction'])
  it(`refuses ${mode} without retry or any completion claim`, async () => {
    const f = fixture(mode); await expect(f.inspect(binding)).rejects.toThrow(mode === 'rollback error' ? 'inventory_rollback_unverified'
      : mode === 'resuming' ? 'inventory_database_resuming' : 'database_identity_authority_refused');
    expect(f.destroyed()).toBe(true); expect(f.calls.filter(c => c.type === 'BeginTransactionCommand')).toHaveLength(1);
    if (!['missing transaction', 'resuming'].includes(mode)) expect(f.calls.at(-1)?.type).toBe('RollbackTransactionCommand');
  });
it('has no caller SQL, writes or commit adapter and admits only bounded metadata', () => {
  const code = readFileSync('src/server/clinical-core/inventory-qualification-database-identity.ts', 'utf8');
  expect(code).not.toMatch(/CommitTransactionCommand|insert into|update clinical|create table|email_sha256|first_name|last_name/);
  expect(code).toContain('limit 17'); expect(code).toContain('maxAttempts: 1'); expect(code).toContain("profile: 'ai-synthetic-member'");
});
