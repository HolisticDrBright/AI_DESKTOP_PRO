import { BeginTransactionCommand, CommitTransactionCommand, ExecuteStatementCommand, RollbackTransactionCommand, type Field, type SqlParameter } from '@aws-sdk/client-rds-data';
import type { PGlite } from '@electric-sql/pglite';
import type { RdsDataCommandClient } from '../../clinical-core/rds-data-database';

/**
 * A FAKE RDS Data API over an embedded database, for source tests only. It speaks the commands the
 * real factory sends (begin, `set local role`, named parameters, commit, rollback), maps each secret
 * to the login it stands for and runs that transaction with the SESSION user switched to that login,
 * so a login's role memberships are what the candidate granted and nothing more. It encodes results
 * the way the Data API does (jsonb and timestamps as strings) and refuses what the Data API cannot
 * carry. It is not RDS: the embedded engine has one connection, serializes every transaction, has one
 * superuser behind every "login" and no network, IAM or secret store. Role isolation shown here is
 * the candidate's grants under that engine, never proof of hosted isolation or lock contention.
 */
export type FakeRdsFaults = {
  /** Called before each command; throw to fail it before it reaches the database. */
  before?: (command: { kind: string; secretArn: string; sql?: string }) => void | Promise<void>;
  /** Called after a command ran; return true to LOSE its reply (the work happened, the caller sees an error). */
  loseReply?: (command: { kind: string; secretArn: string; sql?: string }) => boolean;
};

export function createPgliteRdsDataClient(db: PGlite, logins: Record<string, string>, bootstrapUser: string, faults: FakeRdsFaults = {}) {
  const used: { secretArn: string; kind: string }[] = [];
  let lock: Promise<void> = Promise.resolve();
  const open = new Map<string, { release: () => void; secretArn: string }>();
  let counter = 0;
  const decode = (field: Field | undefined): unknown => {
    if (!field || field.isNull) return null;
    if (field.stringValue !== undefined) return field.stringValue;
    if (field.longValue !== undefined) return field.longValue;
    if (field.doubleValue !== undefined) return field.doubleValue;
    if (field.booleanValue !== undefined) return field.booleanValue;
    if (field.blobValue !== undefined) return field.blobValue;
    throw Object.assign(new Error('unsupported parameter'), { name: 'BadRequestException' });
  };
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const encode = (value: unknown): Field => {
    if (value === null || value === undefined) return { isNull: true };
    if (typeof value === 'string') return { stringValue: value };
    if (typeof value === 'boolean') return { booleanValue: value };
    if (typeof value === 'number') return Number.isInteger(value) ? { longValue: value } : { doubleValue: value };
    if (typeof value === 'bigint') return { longValue: Number(value) };
    if (value instanceof Date) return { stringValue: `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}.${pad(value.getUTCMilliseconds(), 3)}` };
    if (value instanceof Uint8Array) return { blobValue: value };
    return { stringValue: JSON.stringify(value) };
  };
  const pgError = (cause: unknown) => Object.assign(new Error(cause instanceof Error ? cause.message : String(cause)), { name: 'DatabaseErrorException' });
  const client: RdsDataCommandClient & { used: typeof used; faults: FakeRdsFaults } = {
    used, faults,
    async send(command: unknown) {
      const input = (command as { input: Record<string, unknown> }).input;
      const secretArn = String(input.secretArn ?? '');
      const kind = command instanceof BeginTransactionCommand ? 'begin' : command instanceof CommitTransactionCommand ? 'commit' : command instanceof RollbackTransactionCommand ? 'rollback' : command instanceof ExecuteStatementCommand ? 'execute' : 'unknown';
      const sql = typeof input.sql === 'string' ? input.sql : undefined;
      await faults.before?.({ kind, secretArn, sql });
      used.push({ secretArn, kind });
      const reply = async (): Promise<Record<string, unknown>> => {
        if (kind === 'begin') {
          const login = logins[secretArn];
          if (!login) throw Object.assign(new Error('secret not found'), { name: 'ForbiddenException' });
          let release!: () => void;
          const previous = lock;
          lock = new Promise<void>(resolve => { release = resolve; });
          await previous;
          try { await db.exec(`set session authorization ${login}`); await db.exec('begin'); }
          catch (error) { await db.exec(`set session authorization ${bootstrapUser}`).catch(() => undefined); release(); throw pgError(error); }
          const transactionId = 'tx-' + (++counter);
          open.set(transactionId, { release, secretArn });
          return { transactionId };
        }
        const transactionId = String(input.transactionId ?? '');
        const current = open.get(transactionId);
        if (!current || current.secretArn !== secretArn) throw Object.assign(new Error('transaction not found'), { name: 'NotFoundException' });
        if (kind === 'commit' || kind === 'rollback') {
          open.delete(transactionId);
          try { await db.exec(kind === 'commit' ? 'commit' : 'rollback'); }
          catch (error) { await db.exec('rollback').catch(() => undefined); throw pgError(error); }
          finally { await db.exec(`set session authorization ${bootstrapUser}`).catch(() => undefined); current.release(); }
          return { transactionStatus: kind === 'commit' ? 'Transaction Committed' : 'Rollback Complete' };
        }
        const parameters = (input.parameters ?? []) as SqlParameter[];
        const byName = new Map(parameters.map(p => [p.name, decode(p.value)]));
        const positional: unknown[] = [];
        const text = (sql ?? '').replace(/:p(\d+)\b/g, (_whole, n) => { const value = byName.get('p' + n); positional.push(value); return '$' + positional.length; });
        try {
          const result = await db.query<Record<string, unknown>>(text, positional);
          return {
            columnMetadata: result.fields.map(field => ({ name: field.name })),
            records: result.rows.map(row => result.fields.map(field => encode(row[field.name]))),
            numberOfRecordsUpdated: result.affectedRows ?? 0,
          };
        } catch (error) {
          // A failed statement aborts the transaction, as on the Data API; the factory then rolls back.
          throw pgError(error);
        }
      };
      const result = await reply();
      if (faults.loseReply?.({ kind, secretArn, sql })) throw Object.assign(new Error('reply lost'), { name: 'TimeoutError' });
      return result;
    },
  };
  return client;
}
