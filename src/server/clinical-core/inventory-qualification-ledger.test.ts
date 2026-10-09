import { beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertInventoryQualificationLedger, inventoryQualificationLedgerArtifact, inventoryQualificationLedgerReader, type InventoryLedgerRow } from './inventory-qualification-ledger';
let artifact: Record<string, unknown>, rows: InventoryLedgerRow[];
beforeAll(() => {
  artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-adopted-plan-inventory-candidate.mjs', '--json'],
    { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }));
  rows = inventoryQualificationLedgerArtifact(artifact);
}, 35000);
it('binds the entire actual 107 artifact and immutable ordered parent', () => {
  expect(rows).toHaveLength(107); expect(() => assertInventoryQualificationLedger('clinical_core_qualification', rows, rows)).not.toThrow();
  for (const changed of [rows.slice(0, 106), [...rows, rows[106]], [rows[1], rows[0], ...rows.slice(2)],
    rows.map((r, n) => n === 14 ? { ...r, sha256: 'a'.repeat(64) } : r), rows.map((r, n) => n === 106 ? rows[105] : r)]) {
    expect(() => assertInventoryQualificationLedger('clinical_core_qualification', changed, rows)).toThrow('inventory_ledger_refused');
  }
  expect(() => assertInventoryQualificationLedger('clinical_core', rows, rows)).toThrow('inventory_ledger_refused');
  expect(() => assertInventoryQualificationLedger('clinical_core_qualification', rows, rows.slice(0, 106))).toThrow('inventory_ledger_artifact_refused');
});
it('metadata, extra files and modified SQL cannot become the reviewed artifact', () => {
  const mutations = [
    (a: Record<string, unknown>) => { (a.candidate as Record<string, unknown>).phiAllowed = true; },
    (a: Record<string, unknown>) => { (a.candidate as Record<string, unknown>).migrationReleaseSha256 = 'a'.repeat(64); },
    (a: Record<string, unknown>) => { const f = a.files as Record<string, string>; f[Object.keys(f)[0]] += '\n-- altered'; },
    (a: Record<string, unknown>) => { (a.files as Record<string, string>)['unexpected.sql'] = 'select 1'; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(artifact); mutate(changed); expect(() => inventoryQualificationLedgerArtifact(changed)).toThrow('inventory_ledger_artifact_refused'); }
});
const target = { DatabaseName: 'clinical_core_qualification', DatabaseClusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  DatabaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional' };
for (const mode of ['good', '106 ledger', 'changed row', 'wrong database', 'extra column', 'missing transaction', 'query error', 'rollback error', 'resuming']) {
  it(`read-only SDK behavior ${mode}`, async () => {
    const calls: Array<{ type: string; input: Record<string, unknown> }> = []; let destroyed = false;
    const inspect = inventoryQualificationLedgerReader(rows, () => ({ destroy: () => { destroyed = true; }, send: async (command, options) => {
      expect(options.abortSignal).toBeInstanceOf(AbortSignal);
      const type = command.constructor.name, input = command.input as unknown as Record<string, unknown>;
      calls.push({ type, input }); expect(input.resourceArn).toBe(target.DatabaseClusterArn); expect(input.secretArn).toBe(target.DatabaseSecretArn);
      if (type === 'BeginTransactionCommand') {
        if (mode === 'resuming') { const e = Error('provider private text'); e.name = 'DatabaseResumingException'; throw e; }
        return mode === 'missing transaction' ? {} : { transactionId: 'fictional-transaction' };
      }
      expect(input.transactionId).toBe('fictional-transaction');
      if (type === 'RollbackTransactionCommand') { if (mode === 'rollback error') throw Error('private store error'); return {}; }
      expect(type).toBe('ExecuteStatementCommand'); expect(input.database).toBe(target.DatabaseName);
      if (mode === 'query error') throw Error('private query detail');
      if (String(input.sql).startsWith('set ')) return {};
      if (input.sql === 'select current_database()') return { records: [[{ stringValue: mode === 'wrong database' ? 'clinical_core' : target.DatabaseName }]] };
      expect(input.sql).toBe('select version,sha256 from clinical_core.schema_migrations order by version');
      return { records: (mode === '106 ledger' ? rows.slice(0, 106) : rows).map((r, n) => [{ stringValue: r.version },
        { stringValue: mode === 'changed row' && n === 5 ? 'wrong' : r.sha256 }, ...(mode === 'extra column' ? [{ stringValue: 'unreviewed' }] : [])]) };
    } }));
    if (mode === 'good') expect(await inspect(target)).toEqual({ contract: 'inventory-qualification-ledger-observation/1', database: target.DatabaseName,
      release: '542b101ca1729576d2b203c9c2b3d98d2d9dd897e7480ab08ff150c8eacf773c', rows: 107, rolledBack: true, writes: false, acceptance: false, liveFleetVerified: false });
    else await expect(inspect(target)).rejects.toThrow(mode === 'rollback error' ? 'inventory_rollback_unverified' : mode === 'resuming' ? 'inventory_database_resuming' : 'inventory_ledger_refused');
    expect(destroyed).toBe(true); expect(calls.filter(c => c.type === 'BeginTransactionCommand')).toHaveLength(1);
    expect(calls.some(c => c.type === 'CommitTransactionCommand')).toBe(false);
    if (!['resuming', 'missing transaction'].includes(mode)) expect(calls.at(-1)?.type).toBe('RollbackTransactionCommand');
    if (mode === 'good') expect(calls.filter(c => c.type === 'ExecuteStatementCommand').map(c => c.input.sql)).toEqual([
      'set transaction isolation level repeatable read read only', "set local statement_timeout = '30s'", "set local lock_timeout = '5s'",
      'select current_database()', 'select version,sha256 from clinical_core.schema_migrations order by version']);
  });
}
it('refuses a foreign account, region, secret or staging database before constructing a client', async () => {
  const inspect = inventoryQualificationLedgerReader(rows, () => { throw Error('client must never be constructed'); });
  for (const changed of [{ ...target, DatabaseName: 'clinical_core' }, { ...target, DatabaseClusterArn: target.DatabaseClusterArn.replace('588966314750', '173535830222') },
    { ...target, DatabaseSecretArn: target.DatabaseSecretArn.replace('us-east-2', 'us-west-2') }]) await expect(inspect(changed)).rejects.toThrow('inventory_ledger_target_refused');
});
it('historical ledger remains strict 106 and the adapter has no commit, DDL or caller SQL', () => {
  const old = readFileSync('scripts/qualification-consent-ledger.mjs', 'utf8'), code = readFileSync('src/server/clinical-core/inventory-qualification-ledger.ts', 'utf8');
  expect(old).toContain('records.length!==106'); expect(code).not.toMatch(/CommitTransactionCommand|insert into|update clinical|create table/i);
  expect(code).toContain('maxAttempts: 1');
});
