if (typeof window !== 'undefined') throw Error('inventory database identity observation is server-only');
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { BeginTransactionCommand, ExecuteStatementCommand, RDSDataClient, RollbackTransactionCommand } from '@aws-sdk/client-rds-data';
import { inventoryCanonical, inventoryRecord, inventoryRefuse, inventorySha } from './inventory-qualification-artifacts';
import { assertInventoryQualificationLedger, type InventoryLedgerDatabase, type InventoryLedgerRow } from './inventory-qualification-ledger';
import type { InventoryIdentityDependency } from './inventory-qualification-identity-dependency';

type Row = Record<string, unknown>;
export type InventoryDatabaseIdentityBinding = { database: InventoryLedgerDatabase; organizationId: string;
  subjects: InventoryIdentityDependency['subjects']; cognitoPersonBindingsSha256: string };
type Command = BeginTransactionCommand | ExecuteStatementCommand | RollbackTransactionCommand;
export type InventoryIdentityDatabaseTransport = { send(command: Command, options: { abortSignal: AbortSignal }): Promise<unknown>; destroy(): void };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const refuse = () => inventoryRefuse('database_identity_authority_refused');
const obj = (v: unknown, names: string[]): Row => {
  if (!inventoryRecord(v) || Object.keys(v).sort().join(',') !== [...names].sort().join(',')) return refuse();
  return v;
};
const rows = (v: unknown): Row[] => {
  if (!Array.isArray(v) || v.length > 16 || v.some(r => !inventoryRecord(r))) return refuse();
  return v;
};
const id = (v: unknown): string => typeof v === 'string' && uuid.test(v) ? v : refuse();
const cell = (v: unknown): string => {
  const r = obj(v, ['stringValue']); return typeof r.stringValue === 'string' ? r.stringValue : refuse();
};
const posture = (v: Row) => {
  // Qualification uses the real production-shaped schema. These columns are
  // schema posture, NOT permission for PHI or evidence that content is fictional.
  if (v.data_classification !== 'clinical_phi' || v.contains_phi !== true) refuse();
};

// Fixed parameterized, bounded metadata projection. It reads no names, contact
// values, labs, record contents, secrets or consent copy. All identities sharing
// an admitted person's ID are included, so an extra identity cannot be hidden by
// filtering only the three expected subjects. A seventeenth row forces refusal.
const identitySql = `with selected_people as (
  select distinct person_id from clinical_core.identities where identity_subject in (:consumer,:foreignConsumer,:workforce)
)
select jsonb_build_object(
 'identities',coalesce((select jsonb_agg(to_jsonb(r)) from (
   select i.id::text id,i.person_id::text person_id,i.identity_pool,i.identity_subject,i.status,i.production_bound,
     p.status person_status,p.data_classification,p.contains_phi
   from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
   where i.identity_subject in (:consumer,:foreignConsumer,:workforce) or i.person_id in(select person_id from selected_people)
   order by i.id limit 17) r),'[]'::jsonb),
 'organizations',coalesce((select jsonb_agg(to_jsonb(r)) from (
   select o.id::text id,o.status,o.environment,o.data_classification,o.contains_phi
   from clinical_core.organizations o where o.id=cast(:organization as uuid) order by o.id limit 17) r),'[]'::jsonb),
 'memberships',coalesce((select jsonb_agg(to_jsonb(r)) from (
   select m.id::text id,m.person_id::text person_id,m.organization_id::text organization_id,m.role,m.status
   from clinical_core.organization_memberships m where m.person_id in(select person_id from selected_people)
   order by m.id limit 17) r),'[]'::jsonb),
 'connections',coalesce((select jsonb_agg(to_jsonb(r)) from (
   select c.id::text id,c.consumer_person_id::text consumer_person_id,c.organization_id::text organization_id,
     c.patient_record_id::text patient_record_id,c.state,(c.verified_at is not null) verified,
     p.status patient_status,p.data_classification,p.contains_phi
   from clinical_core.patient_connections c join clinical_core.patient_records p on p.id=c.patient_record_id and p.organization_id=c.organization_id
   where c.consumer_person_id in(select person_id from selected_people) order by c.id limit 17) r),'[]'::jsonb),
 'directory',coalesce((select jsonb_agg(to_jsonb(r)) from (
   select d.person_id::text person_id,d.identity_subject,d.status from clinical_core.workforce_identity_directory d
   where d.person_id in(select person_id from selected_people) or d.identity_subject in (:consumer,:foreignConsumer,:workforce)
   order by d.id limit 17) r),'[]'::jsonb)
)::text`;

function inspectSnapshot(raw: unknown, binding: InventoryDatabaseIdentityBinding) {
  const s = obj(raw, ['identities', 'organizations', 'memberships', 'connections', 'directory']);
  const identities = rows(s.identities), organizations = rows(s.organizations), memberships = rows(s.memberships), connections = rows(s.connections), directory = rows(s.directory);
  if (identities.length !== 3 || organizations.length !== 1 || memberships.length !== 1 || connections.length !== 1 || directory.length > 1) return refuse();
  const people: Record<string, string> = {}, identityIds = new Set<string>();
  for (const rawIdentity of identities) {
    const i = obj(rawIdentity, ['id', 'person_id', 'identity_pool', 'identity_subject', 'status', 'production_bound', 'person_status', 'data_classification', 'contains_phi']);
    const key = Object.entries(binding.subjects).find(([, subject]) => subject === i.identity_subject)?.[0];
    if (!key || Object.hasOwn(people, key) || i.identity_pool !== (key === 'workforce' ? 'workforce' : 'consumer')
      || i.status !== 'active' || i.person_status !== 'active' || i.production_bound !== true) return refuse();
    posture(i); people[key] = id(i.person_id); identityIds.add(id(i.id));
  }
  if (identityIds.size !== 3 || new Set(Object.values(people)).size !== 3
    || inventorySha(inventoryCanonical(people)) !== binding.cognitoPersonBindingsSha256) return refuse();
  const o = obj(organizations[0], ['id', 'status', 'environment', 'data_classification', 'contains_phi']);
  if (o.id !== binding.organizationId || o.status !== 'active' || o.environment !== 'production-clinical') return refuse();
  posture(o);
  const m = obj(memberships[0], ['id', 'person_id', 'organization_id', 'role', 'status']);
  id(m.id);
  if (m.person_id !== people.workforce || m.organization_id !== binding.organizationId || m.status !== 'active'
    || !['owner', 'admin', 'practitioner'].includes(String(m.role))) return refuse();
  const c = obj(connections[0], ['id', 'consumer_person_id', 'organization_id', 'patient_record_id', 'state', 'verified', 'patient_status', 'data_classification', 'contains_phi']);
  id(c.id); id(c.patient_record_id);
  if (c.consumer_person_id !== people.consumer || c.organization_id !== binding.organizationId || c.state !== 'verified'
    || c.verified !== true || c.patient_status !== 'active') return refuse();
  posture(c);
  for (const rawDirectory of directory) {
    const d = obj(rawDirectory, ['person_id', 'identity_subject', 'status']);
    if (d.person_id !== people.workforce || d.identity_subject !== binding.subjects.workforce || d.status !== 'active') return refuse();
  }
}

function actualClient(): InventoryIdentityDatabaseTransport {
  const c = new RDSDataClient({ region: 'us-east-2', endpoint: 'https://rds-data.us-east-2.amazonaws.com',
    credentials: fromIni({ profile: 'ai-synthetic-member' }), maxAttempts: 1 });
  return { send: (command, options) => {
    if (command instanceof BeginTransactionCommand) return c.send(command, options);
    if (command instanceof ExecuteStatementCommand) return c.send(command, options);
    if (command instanceof RollbackTransactionCommand) return c.send(command, options);
    return inventoryRefuse('database_identity_command_refused');
  }, destroy: () => c.destroy() };
}

/** Complete successor ledger and designated DB identities in one read-only
 * repeatable-read transaction, always rolled back. Cognito person digest comes
 * from the fleet's independent reader, not a manifest or environment assertion.
 * Retention service, real login, privileges/body integrity and runtime isolation
 * remain separate requirements; this component never certifies acceptance. */
export function inventoryDatabaseIdentityReader(expected: InventoryLedgerRow[], makeClient: () => InventoryIdentityDatabaseTransport = actualClient) {
  assertInventoryQualificationLedger('clinical_core_qualification', expected, expected);
  const admittedRows = structuredClone(expected);
  return async (input: InventoryDatabaseIdentityBinding) => {
    const b = structuredClone(input);
    obj(b, ['database', 'organizationId', 'subjects', 'cognitoPersonBindingsSha256']);
    obj(b.database, ['DatabaseName', 'DatabaseClusterArn', 'DatabaseSecretArn']); obj(b.subjects, ['consumer', 'foreignConsumer', 'workforce']);
    if (b.database.DatabaseName !== 'clinical_core_qualification' || !uuid.test(b.organizationId)
      || !/^arn:aws:rds:us-east-2:588966314750:cluster:[A-Za-z0-9-]{1,63}$/.test(b.database.DatabaseClusterArn)
      || !/^arn:aws:secretsmanager:us-east-2:588966314750:secret:[A-Za-z0-9/_+=.@!-]+$/.test(b.database.DatabaseSecretArn)
      || Object.values(b.subjects).some(s => typeof s !== 'string' || !uuid.test(s)) || new Set(Object.values(b.subjects)).size !== 3
      || !/^[a-f0-9]{64}$/.test(b.cognitoPersonBindingsSha256) || /^0+$/.test(b.cognitoPersonBindingsSha256)) return refuse();
    const client = makeClient(), base = { resourceArn: b.database.DatabaseClusterArn, secretArn: b.database.DatabaseSecretArn, database: b.database.DatabaseName };
    const send = (command: Command) => client.send(command, { abortSignal: AbortSignal.timeout(30000) });
    let transactionId: string | undefined, rolledBack = false, observed: unknown;
    try {
      const begin = await send(new BeginTransactionCommand(base));
      if (!inventoryRecord(begin) || typeof begin.transactionId !== 'string' || !begin.transactionId || begin.transactionId.length > 1024
        || /[\x00-\x1f]/.test(begin.transactionId)) return refuse();
      transactionId = begin.transactionId;
      const query = (sql: string, parameters?: ExecuteStatementCommand['input']['parameters']) => send(new ExecuteStatementCommand({ ...base, transactionId, sql, ...(parameters ? { parameters } : {}) }));
      await query('set transaction isolation level repeatable read read only');
      await query("set local statement_timeout = '30s'"); await query("set local lock_timeout = '5s'");
      const read = async (sql: string, parameters?: ExecuteStatementCommand['input']['parameters']) => {
        const r = await query(sql, parameters);
        if (!inventoryRecord(r) || !Array.isArray(r.records) || r.records.length !== 1 || !Array.isArray(r.records[0]) || r.records[0].length !== 1) return refuse();
        return cell(r.records[0][0]);
      };
      if (await read('select current_database()') !== base.database) return refuse();
      const ledger = await query('select version,sha256 from clinical_core.schema_migrations order by version');
      if (!inventoryRecord(ledger) || !Array.isArray(ledger.records)) return refuse();
      assertInventoryQualificationLedger(base.database, ledger.records.map(r => {
        if (!Array.isArray(r) || r.length !== 2) return refuse(); return { version: cell(r[0]), sha256: cell(r[1]) };
      }), admittedRows);
      const parameters = Object.entries({ ...b.subjects, organization: b.organizationId }).map(([name, value]) => ({ name, value: { stringValue: value } }));
      const snapshot = async () => {
        const text = await read(identitySql, parameters); if (text.length > 65536) return refuse();
        let value: unknown; try { value = JSON.parse(text); } catch { return refuse(); }
        inspectSnapshot(value, b); return value;
      };
      observed = await snapshot();
      if (inventoryCanonical(observed) !== inventoryCanonical(await snapshot())) return refuse();
    } catch (e) {
      return inventoryRefuse(inventoryRecord(e) && e.name === 'DatabaseResumingException' ? 'inventory_database_resuming' : 'database_identity_authority_refused');
    } finally {
      try { if (transactionId) { await send(new RollbackTransactionCommand({ resourceArn: base.resourceArn, secretArn: base.secretArn, transactionId })); rolledBack = true; } }
      catch { inventoryRefuse('inventory_rollback_unverified'); }
      finally { client.destroy(); }
    }
    if (!rolledBack || observed === undefined) return refuse();
    return { contract: 'inventory-qualification-database-identity/1', databaseIdentityAuthorityVerified: true, successorLedgerVerified: true,
      cognitoPersonBindingsSha256: b.cognitoPersonBindingsSha256, observationSha256: inventorySha(inventoryCanonical(observed)),
      designatedUsers: 3, workforceMemberships: 1, verifiedPatientConnections: 1, foreignConsumerConnections: 0,
      rolledBack: true, writes: false, retentionServiceIdentityVerified: false, physicalLoginVerified: false,
      identityDependenciesVerified: false, liveFleetVerified: false, acceptance: false, humanReviewsVerified: false, phiAllowed: false };
  };
}
