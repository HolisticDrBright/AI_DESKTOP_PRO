if (typeof window !== 'undefined') throw Error('successor qualification ledger is server-only');
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { BeginTransactionCommand, ExecuteStatementCommand, RDSDataClient, RollbackTransactionCommand } from '@aws-sdk/client-rds-data';
import { assertSuccessorQualificationRows, SUCCESSOR_QUALIFICATION_RELEASE as release,
  type SuccessorQualificationRow } from '../../../scripts/successor-qualification-release.mjs';

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const refuse = (): never => { throw Error('successor_qualification_ledger_refused'); };
type Command = BeginTransactionCommand | ExecuteStatementCommand | RollbackTransactionCommand;
export type SuccessorLedgerTransport = {
  send(command: Command, options: { abortSignal: AbortSignal }): Promise<unknown>; destroy(): void;
};
export type SuccessorLedgerTarget = {
  DatabaseName: string; DatabaseClusterArn: string; OperatorDatabaseSecretArn: string;
};
const actualClient = (): SuccessorLedgerTransport => {
  const client = new RDSDataClient({ region: 'us-east-2', endpoint: 'https://rds-data.us-east-2.amazonaws.com',
    credentials: fromIni({ profile: 'ai-synthetic-member' }), maxAttempts: 1 });
  return { send: (command, options) => {
    if (command instanceof BeginTransactionCommand) return client.send(command, options);
    if (command instanceof ExecuteStatementCommand) return client.send(command, options);
    if (command instanceof RollbackTransactionCommand) return client.send(command, options);
    return refuse();
  }, destroy: () => client.destroy() };
};
const cell = (v: unknown): string => {
  if (!record(v) || Object.keys(v).join(',') !== 'stringValue' || typeof v.stringValue !== 'string') return refuse();
  return v.stringValue;
};

/** Fixed read-only transaction. Operator authority is explicit, never inferred
 * from the API secret. No caller SQL, writes, commit, retry or activation. */
export function successorQualificationLedgerReader(supplied: readonly SuccessorQualificationRow[], makeClient = actualClient) {
  const expected = assertSuccessorQualificationRows(supplied);
  return async (suppliedTarget: SuccessorLedgerTarget) => {
    const target = { ...suppliedTarget };
    if (target?.DatabaseName !== 'clinical_core_qualification'
      || !/^arn:aws:rds:us-east-2:588966314750:cluster:[A-Za-z0-9-]{1,63}$/.test(target.DatabaseClusterArn ?? '')
      || !/^arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-[A-Za-z0-9-]+$/.test(target.OperatorDatabaseSecretArn ?? ''))
      throw Error('successor_qualification_ledger_target_refused');
    const client = makeClient(), base = { resourceArn: target.DatabaseClusterArn, secretArn: target.OperatorDatabaseSecretArn,
      database: target.DatabaseName };
    let transactionId: string | undefined, verified = false;
    const send = (command: Command) => client.send(command, { abortSignal: AbortSignal.timeout(30000) });
    try {
      const begin = await send(new BeginTransactionCommand(base));
      if (!record(begin) || typeof begin.transactionId !== 'string' || !begin.transactionId
        || begin.transactionId.length > 1024 || /[\x00-\x1f]/.test(begin.transactionId)) return refuse();
      transactionId = begin.transactionId;
      const query = (sql: string) => send(new ExecuteStatementCommand({ ...base, transactionId, sql }));
      await query('set transaction isolation level repeatable read read only');
      await query("set local statement_timeout = '30s'");
      await query("set local lock_timeout = '5s'");
      const database = await query('select current_database()');
      if (!record(database) || !Array.isArray(database.records) || database.records.length !== 1
        || !Array.isArray(database.records[0]) || database.records[0].length !== 1
        || cell(database.records[0][0]) !== target.DatabaseName) return refuse();
      const result = await query('select version,name,sha256 from clinical_core.schema_migrations order by version collate "C"');
      if (!record(result) || !Array.isArray(result.records)) return refuse();
      const rows = result.records.map(r => {
        if (!Array.isArray(r) || r.length !== 3) return refuse();
        return { version: cell(r[0]), name: cell(r[1]), sha256: cell(r[2]) };
      });
      assertSuccessorQualificationRows(rows);
      if (JSON.stringify(rows) !== JSON.stringify(expected)) return refuse();
      verified = true;
    } catch (error) {
      if (record(error) && error.name === 'DatabaseResumingException') throw Error('successor_qualification_database_resuming');
      return refuse();
    } finally {
      try {
        if (transactionId) {
          const rollback = await send(new RollbackTransactionCommand({ resourceArn: base.resourceArn, secretArn: base.secretArn, transactionId }));
          if (!record(rollback) || rollback.transactionStatus !== 'Rollback complete' || !record(rollback.$metadata)
            || rollback.$metadata.httpStatusCode !== 200) throw Error('successor_qualification_rollback_unverified');
        }
      } catch { throw Error('successor_qualification_rollback_unverified'); }
      finally { client.destroy(); }
    }
    if (!verified) return refuse();
    return { contract: 'successor-qualification-ledger-observation/1', ...release, database: target.DatabaseName,
      rows: 117, ledgerVerified: true, rolledBack: true, writes: false, liveFleetVerified: false,
      acceptance: false, deploymentPerformed: false, phiAllowed: false };
  };
}
