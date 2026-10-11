import { beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { inventoryQualificationLedgerArtifact } from './inventory-qualification-ledger';
import { assertSuccessorQualificationRows, successorQualificationReleaseArtifact,
  SUCCESSOR_QUALIFICATION_RELEASE } from '../../../scripts/successor-qualification-release.mjs';
import { successorQualificationLedgerReader, type SuccessorLedgerTarget } from './successor-qualification-ledger';

type Artifact = { manifest: { contract_version: string; migrations: Array<{ version: string; file: string }> };
  files: Record<string, string>; candidate: Record<string, unknown>; releaseHash: string };
let artifact: Artifact;
let bound: ReturnType<typeof successorQualificationReleaseArtifact>;
beforeAll(() => {
  artifact = JSON.parse(execFileSync(process.execPath,
    ['scripts/build-telehealth-transfer-authority-candidate.mjs', '--json'],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }));
  bound = successorQualificationReleaseArtifact(artifact);
}, 65000);

it('binds the entire actual successor, while preserving the historical 107 refusal', () => {
  expect(artifact.manifest.migrations).toHaveLength(117);
  expect(() => inventoryQualificationLedgerArtifact(artifact)).toThrow('inventory_ledger_artifact_refused');
  expect(bound).toMatchObject({ ...SUCCESSOR_QUALIFICATION_RELEASE, executionAllowed: false,
    managedQualified: false, deploymentPerformed: false, phiAllowed: false });
  expect(bound.rows).toHaveLength(117);
  expect(Object.isFrozen(bound)).toBe(true); expect(Object.isFrozen(bound.rows)).toBe(true);
  expect(bound.rows.every(Object.isFrozen)).toBe(true);
});
const mutations: Array<[string, (a: Artifact) => void]> = [
  ['parent bytes', a => { a.files[a.manifest.migrations[21].file] += '\n-- changed'; }],
  ['extension bytes', a => { a.files[a.manifest.migrations[116].file] += '\n-- changed'; }],
  ['117 count only', a => { a.candidate.migrationReleaseSha256 = 'a'.repeat(64); }],
  ['assembly', a => { a.releaseHash = 'a'.repeat(64); }],
  ['parent', a => { a.candidate.parentArtifactSha256 = 'a'.repeat(64); }],
  ['filename', a => { const r = a.manifest.migrations[12], previous = r.file; r.file = r.version + '_changed.sql';
    a.files[r.file] = a.files[previous]; delete a.files[previous]; }],
  ['duplicate version', a => { a.manifest.migrations[116] = { ...a.manifest.migrations[115] }; }],
  ['order', a => { [a.manifest.migrations[0], a.manifest.migrations[1]] = [a.manifest.migrations[1], a.manifest.migrations[0]]; }],
  ['extra file', a => { a.files['unlisted.sql'] = 'select 1'; }],
  ['prefix only', a => { a.manifest.migrations = a.manifest.migrations.slice(0, 112); }],
  ['extra row', a => { a.manifest.migrations.push({ ...a.manifest.migrations[116] }); }],
  ['CRLF', a => { a.files[a.manifest.migrations[116].file] = a.files[a.manifest.migrations[116].file].replaceAll('\n', '\r\n'); }],
  ['claimed admission', a => { a.candidate.runtimeAdmission = true; }],
  ['claimed managed verification', a => { a.candidate.managedRoleSemanticsVerified = true; }],
  ['PHI', a => { a.candidate.phiAllowed = true; }],
  ['approval', a => { a.candidate.activation = 'approved'; }],
  ['unknown metadata', a => { a.candidate.unreviewed = true; }],
];
it.each(mutations)('refuses %s rather than relabeling an artifact', (_name, mutate) => {
  const changed = structuredClone(artifact); mutate(changed);
  expect(() => successorQualificationReleaseArtifact(changed)).toThrow('successor_release_artifact_refused');
});
it('refuses malformed roots and rows, changed names and every shorter/longer ledger', () => {
  for (const a of [null, [], {}, { ...artifact, manifest: null }, { ...artifact, files: null },
    { ...artifact, candidate: null }, { ...artifact, extra: true }])
    expect(() => successorQualificationReleaseArtifact(a)).toThrow('successor_release_artifact_refused');
  for (const count of [0, 106, 107, 111, 112, 113, 114, 115, 116])
    expect(() => assertSuccessorQualificationRows(bound.rows.slice(0, count))).toThrow('successor_release_artifact_refused');
  for (const rows of [[...bound.rows, bound.rows[116]], [...bound.rows].reverse(),
    bound.rows.map((r, i) => i === 30 ? { ...r, name: 'different' } : r),
    bound.rows.map((r, i) => i === 30 ? { ...r, sha256: 'a'.repeat(64) } : r),
    bound.rows.map((r, i) => i === 30 ? { ...r, extra: true } : r)])
    expect(() => assertSuccessorQualificationRows(rows)).toThrow('successor_release_artifact_refused');
});
const target: SuccessorLedgerTarget = { DatabaseName: 'clinical_core_qualification',
  DatabaseClusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  OperatorDatabaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-fictional-AbCd12' };
it.each(['good', '112', 'name', 'digest', 'database', 'extra cell', 'missing transaction', 'query error',
  'rollback missing', 'rollback denied', 'rollback error', 'resuming'])('read-only exact ledger and settlement %s', async mode => {
  const calls: Array<{ type: string; input: Record<string, unknown> }> = []; let destroyed = false;
  const read = successorQualificationLedgerReader(bound.rows, () => ({ destroy: () => { destroyed = true; }, send: async (command, options) => {
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    const type = command.constructor.name, input = command.input as unknown as Record<string, unknown>;
    calls.push({ type, input }); expect(input.secretArn).toBe(target.OperatorDatabaseSecretArn);
    if (type === 'BeginTransactionCommand') {
      if (mode === 'resuming') { const error = Error('private detail'); error.name = 'DatabaseResumingException'; throw error; }
      return mode === 'missing transaction' ? {} : { transactionId: 'fictional-tx' };
    }
    expect(input.transactionId).toBe('fictional-tx');
    if (type === 'RollbackTransactionCommand') {
      if (mode === 'rollback error') throw Error('store refused');
      return mode === 'rollback missing' ? {} : { transactionStatus: 'Rollback complete',
        $metadata: { httpStatusCode: mode === 'rollback denied' ? 403 : 200 } };
    }
    expect(type).toBe('ExecuteStatementCommand'); expect(input.database).toBe(target.DatabaseName);
    if (mode === 'query error') throw Error('private detail');
    if (String(input.sql).startsWith('set ')) return {};
    if (input.sql === 'select current_database()') return { records: [[{ stringValue: mode === 'database' ? 'clinical_core' : target.DatabaseName }]] };
    expect(input.sql).toBe('select version,name,sha256 from clinical_core.schema_migrations order by version collate "C"');
    return { records: (mode === '112' ? bound.rows.slice(0, 112) : bound.rows).map((r, i) => [
      { stringValue: r.version }, { stringValue: mode === 'name' && i === 3 ? 'wrong' : r.name },
      { stringValue: mode === 'digest' && i === 3 ? 'a'.repeat(64) : r.sha256 },
      ...(mode === 'extra cell' ? [{ stringValue: 'extra' }] : []),
    ]) };
  } }));
  if (mode === 'good') expect(await read(target)).toMatchObject({ ...SUCCESSOR_QUALIFICATION_RELEASE, rows: 117,
    ledgerVerified: true, rolledBack: true, writes: false, liveFleetVerified: false, acceptance: false, phiAllowed: false });
  else await expect(read(target)).rejects.toThrow(mode === 'resuming' ? 'successor_qualification_database_resuming'
    : mode.startsWith('rollback') ? 'successor_qualification_rollback_unverified'
      : 'successor_qualification_ledger_refused');
  expect(destroyed).toBe(true); expect(calls.filter(c => c.type === 'BeginTransactionCommand')).toHaveLength(1);
  expect(calls.some(c => c.type === 'CommitTransactionCommand')).toBe(false);
  if (!['resuming', 'missing transaction'].includes(mode)) expect(calls.at(-1)?.type).toBe('RollbackTransactionCommand');
});
it('never falls back from missing operator authority to a request secret', async () => {
  let clients = 0;
  const read = successorQualificationLedgerReader(bound.rows, () => { clients++; throw Error('must not construct'); });
  for (const t of [{ ...target, DatabaseName: 'clinical_core' },
    { ...target, DatabaseClusterArn: target.DatabaseClusterArn.replace('588966314750', '173535830222') },
    { ...target, OperatorDatabaseSecretArn: target.OperatorDatabaseSecretArn.replace('us-east-2', 'us-west-2') },
    { ...target, OperatorDatabaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp/qualification/runtime-api-fictional' },
    { ...target, OperatorDatabaseSecretArn: undefined, DatabaseSecretArn: target.OperatorDatabaseSecretArn }])
    await expect(read(t as SuccessorLedgerTarget)).rejects.toThrow('successor_qualification_ledger_target_refused');
  expect(clients).toBe(0);
});
it('captures the target so caller mutation cannot relabel the completed ledger observation', async () => {
  const mutable = { ...target };
  const read = successorQualificationLedgerReader(bound.rows, () => ({ destroy() {}, send: async command => {
    const type = command.constructor.name, input = command.input as unknown as Record<string, unknown>;
    expect(input.resourceArn).toBe(target.DatabaseClusterArn);
    expect(input.secretArn).toBe(target.OperatorDatabaseSecretArn);
    if (type === 'BeginTransactionCommand') return { transactionId: 'fictional-tx' };
    if (type === 'RollbackTransactionCommand') return { transactionStatus: 'Rollback complete', $metadata: { httpStatusCode: 200 } };
    expect(input.database).toBe(target.DatabaseName);
    if (String(input.sql).startsWith('set ')) return {};
    if (input.sql === 'select current_database()') return { records: [[{ stringValue: target.DatabaseName }]] };
    mutable.DatabaseName = 'clinical_core'; mutable.DatabaseClusterArn = 'unrelated'; mutable.OperatorDatabaseSecretArn = 'unrelated';
    return { records: bound.rows.map(r => [r.version, r.name, r.sha256].map(stringValue => ({ stringValue }))) };
  } }));
  expect(await read(mutable)).toMatchObject({ database: target.DatabaseName, ledgerVerified: true, rolledBack: true });
});
