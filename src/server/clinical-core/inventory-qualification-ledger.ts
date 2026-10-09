if (typeof window !== 'undefined') throw Error('inventory qualification ledger is server-only');
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { BeginTransactionCommand, ExecuteStatementCommand, RDSDataClient, RollbackTransactionCommand } from '@aws-sdk/client-rds-data';
import { INVENTORY_RELEASE, INVENTORY_PARENT } from '../../../scripts/inventory-care-qualification-template.mjs';
import { inventoryRecord, inventoryRefuse, inventorySha } from './inventory-qualification-artifacts';

export type InventoryLedgerRow = { version: string; sha256: string };
const extensionVersion = '20261009010000', extensionSha = '9624b2c199421a52e0ddba03ae8dd2a5fb6a578e7f9380f42a066a343d6b53c5';
const digest = (rows: InventoryLedgerRow[]) => inventorySha(rows.map(row => `${row.version}:${row.sha256}`).join('\n'));

/** Exact distinct successor. Never widens the historical 106 inspector. */
function expectedRows(input: unknown): InventoryLedgerRow[] {
  if (!Array.isArray(input) || input.length !== 107 || input.some((row, n) => !inventoryRecord(row)
    || Object.keys(row).sort().join(',') !== 'sha256,version' || typeof row.version !== 'string' || typeof row.sha256 !== 'string'
    || !/^\d{14}$/.test(row.version) || !/^[a-f0-9]{64}$/.test(row.sha256)
    || n > 0 && String(input[n - 1].version) >= String(row.version))) return inventoryRefuse('inventory_ledger_artifact_refused');
  const rows = input as InventoryLedgerRow[];
  if (rows[106].version !== extensionVersion || rows[106].sha256 !== extensionSha
    || digest(rows.slice(0, 106)) !== INVENTORY_PARENT || digest(rows) !== INVENTORY_RELEASE) return inventoryRefuse('inventory_ledger_artifact_refused');
  return structuredClone(rows);
}

export function inventoryQualificationLedgerArtifact(input: unknown): InventoryLedgerRow[] {
  if (!inventoryRecord(input) || !inventoryRecord(input.manifest) || !inventoryRecord(input.files) || !inventoryRecord(input.candidate)) return inventoryRefuse('inventory_ledger_artifact_refused');
  const m = input.manifest, files = input.files, c = input.candidate;
  if (m.contract_version !== 'clinical-core-migrations/1' || !Array.isArray(m.migrations) || m.migrations.length !== 107
    || c.contract !== 'adopted-plan-inventory-candidate/1' || c.parentMigrationCount !== 106 || c.parentMigrationReleaseSha256 !== INVENTORY_PARENT
    || c.migrationCount !== 107 || c.migrationReleaseSha256 !== INVENTORY_RELEASE || c.extensionSha256 !== extensionSha
    || c.deployment !== 'not_deployed' || c.activation !== 'blocked' || c.phiAllowed !== false) return inventoryRefuse('inventory_ledger_artifact_refused');
  const names = m.migrations.map(row => {
    if (!inventoryRecord(row) || typeof row.file !== 'string' || !/^\d{14}_[a-z0-9_]+\.sql$/.test(row.file)
      || typeof files[row.file] !== 'string') return inventoryRefuse('inventory_ledger_artifact_refused');
    return row.file;
  });
  if (new Set(names).size !== 107 || Object.keys(files).sort().join('\n') !== [...names].sort().join('\n')) return inventoryRefuse('inventory_ledger_artifact_refused');
  return expectedRows(m.migrations.map((row, n) => ({ version: (row as Record<string, unknown>).version,
    sha256: inventorySha((files[names[n]] as string).replace(/\r\n?/g, '\n')) })));
}

export function assertInventoryQualificationLedger(database: unknown, records: unknown, supplied: InventoryLedgerRow[]) {
  const expected = expectedRows(supplied);
  if (database !== 'clinical_core_qualification' || !Array.isArray(records) || records.length !== 107
    || records.some((row, n) => !inventoryRecord(row) || Object.keys(row).sort().join(',') !== 'sha256,version'
      || row.version !== expected[n].version || row.sha256 !== expected[n].sha256)) return inventoryRefuse('inventory_ledger_refused');
}

type Command = BeginTransactionCommand | ExecuteStatementCommand | RollbackTransactionCommand;
type Transport = { send(command: Command, options: { abortSignal: AbortSignal }): Promise<unknown>; destroy(): void };
export type InventoryLedgerDatabase = { DatabaseName: string; DatabaseClusterArn: string; DatabaseSecretArn: string };
function actualClient(): Transport {
  const client = new RDSDataClient({ region: 'us-east-2', credentials: fromIni({ profile: 'ai-synthetic-member' }), maxAttempts: 1 });
  return { send: (command, options) => {
    if (command instanceof BeginTransactionCommand) return client.send(command, options);
    if (command instanceof ExecuteStatementCommand) return client.send(command, options);
    if (command instanceof RollbackTransactionCommand) return client.send(command, options);
    return inventoryRefuse('inventory_ledger_command_refused');
  }, destroy: () => client.destroy() };
}
const cell = (value: unknown): string => {
  if (!inventoryRecord(value) || Object.keys(value).join(',') !== 'stringValue' || typeof value.stringValue !== 'string') return inventoryRefuse('inventory_ledger_refused');
  return value.stringValue;
};

/** Read-only SDK adapter for the future complete resource observer. It does not
 * verify STS, source, resources, reviews, schema/function definitions or data
 * preservation; the whole observer must separately bind those observations.
 * No SQL supplied by a caller, no commit, no writes and no automatic retry. */
export function inventoryQualificationLedgerReader(supplied: InventoryLedgerRow[], makeClient: () => Transport = actualClient) {
  const expected = expectedRows(supplied);
  return async (foundation: InventoryLedgerDatabase) => {
    if (foundation?.DatabaseName !== 'clinical_core_qualification'
      || !/^arn:aws:rds:us-east-2:588966314750:cluster:[A-Za-z0-9-]{1,63}$/.test(foundation.DatabaseClusterArn ?? '')
      || !/^arn:aws:secretsmanager:us-east-2:588966314750:secret:[A-Za-z0-9/_+=.@!-]+$/.test(foundation.DatabaseSecretArn ?? '')) return inventoryRefuse('inventory_ledger_target_refused');
    const client = makeClient(), base = { resourceArn: foundation.DatabaseClusterArn, secretArn: foundation.DatabaseSecretArn, database: foundation.DatabaseName };
    const send = (command: Command) => client.send(command, { abortSignal: AbortSignal.timeout(30000) });
    let transactionId: string | undefined, verified = false, rolledBack = false;
    try {
      const begin = await send(new BeginTransactionCommand(base));
      if (!inventoryRecord(begin) || typeof begin.transactionId !== 'string' || !begin.transactionId || begin.transactionId.length > 1024
        || /[\x00-\x1f]/.test(begin.transactionId)) return inventoryRefuse('inventory_ledger_refused');
      transactionId = begin.transactionId;
      const query = (sql: string) => send(new ExecuteStatementCommand({ ...base, transactionId, sql }));
      await query('set transaction isolation level repeatable read read only');
      await query("set local statement_timeout = '30s'");
      await query("set local lock_timeout = '5s'");
      const database = await query('select current_database()');
      if (!inventoryRecord(database) || !Array.isArray(database.records) || database.records.length !== 1
        || !Array.isArray(database.records[0]) || database.records[0].length !== 1 || cell(database.records[0][0]) !== foundation.DatabaseName) return inventoryRefuse('inventory_ledger_refused');
      const result = await query('select version,sha256 from clinical_core.schema_migrations order by version');
      if (!inventoryRecord(result) || !Array.isArray(result.records)) return inventoryRefuse('inventory_ledger_refused');
      const rows = result.records.map(row => {
        if (!Array.isArray(row) || row.length !== 2) return inventoryRefuse('inventory_ledger_refused');
        return { version: cell(row[0]), sha256: cell(row[1]) };
      });
      assertInventoryQualificationLedger(foundation.DatabaseName, rows, expected); verified = true;
    } catch (error) {
      return inventoryRefuse(inventoryRecord(error) && error.name === 'DatabaseResumingException' ? 'inventory_database_resuming' : 'inventory_ledger_refused');
    } finally {
      try { if (transactionId) { await send(new RollbackTransactionCommand({ resourceArn: base.resourceArn, secretArn: base.secretArn, transactionId })); rolledBack = true; } }
      catch { inventoryRefuse('inventory_rollback_unverified'); }
      finally { client.destroy(); }
    }
    if (!verified || !rolledBack) return inventoryRefuse('inventory_ledger_refused');
    return { contract: 'inventory-qualification-ledger-observation/1', database: foundation.DatabaseName,
      release: INVENTORY_RELEASE, rows: 107, rolledBack: true, writes: false, acceptance: false, liveFleetVerified: false };
  };
}
