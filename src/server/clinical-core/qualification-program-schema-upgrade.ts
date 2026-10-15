if (typeof window !== 'undefined') throw Error('qualification-program-schema-upgrade is server-only');
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { careErasurePreservation } from './care-erasure-schema-upgrade';
import { splitPostgresStatements, type ClinicalCoreMigration } from './migrations';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const PARENT_LEDGER = '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4';
const CANDIDATES = [
  ['infra/aws-clinical-core/production-candidates/lab-result-transfer-v2.sql', 'fa6ee162a03a85ab23543371d9d1dbaf8ee6dd486b4a8cc64b5545fc16be3b94', 13],
  ['infra/aws-clinical-core/production-candidates/lab-observation-attestation.sql', 'd0423bcec5067a668f3522bbba65d096f642f083c1ef95448da190b38494bb83', 22],
  ['infra/aws-clinical-core/production-candidates/production-program-assignments.sql', '78bd5b3805d96443829f6e7380deba0d66ad2f03073374bd6681f4f6bc25b4f3', 41],
  ['infra/aws-clinical-core/production-candidates/production-program-consumer-boundary.sql', 'ca0ce5a62e68638c7c29bd114018344c2755da946d1785f849e11088f8e1122d', 14],
  ['infra/aws-clinical-core/source-candidates/qualification-program-boundary.sql', '0f07717d240d981b3900f6c2e926aa79025157f916e869c4a74def52214261a6', 15],
] as const;
const ROLLBACK = ['infra/aws-clinical-core/source-candidates/qualification-program-boundary-rollback.sql',
  'bfdf50b7bb0676d83fa2bb37fa653b8023e03cce1efa20d5916896a76274da9e'] as const;
const FUNCTION_DIGESTS = [
  ['clinical_core.production_program_bounded_request(jsonb)', 'e9c77ccd0cb9be11d65a4a1a105de859717ecf7a2e98512228dc05bd0c234d6e'],
  ['clinical_private.production_program_bounded_complete(jsonb)', 'bacef375e5952a1283b0004d892dbe93516a401016da4cc75a95a310af98144a'],
  ['clinical_core.production_program_assignment_request(jsonb)', 'd9c07fec841cd1d68689be602c933fa67cddd343f4ee5228f336efe9362c981d'],
  ['clinical_private.production_program_without_destinations(jsonb)', '4bd3cdd359d584414bd17791c62f828fb7244e204ce2742ed72ceb4e6c8989d2'],
  ['clinical_private.program_qualification_open()', '83ce2f61711f9fa8b94962cf9330af8eb2e0c984a55e4c0edf2a40764c8a31af'],
] as const;
const ADDED_TABLES = new Set([
  'clinical_core.lab_result_transfer_v2_activation',
  'clinical_core.lab_observation_attestation_activation',
  'clinical_core.lab_observation_attestations',
  'clinical_core.production_program_activation',
  'clinical_core.program_assignments',
  'clinical_core.program_assignment_completions',
  'clinical_core.program_phase_authorizations',
  'clinical_core.program_assignment_audit',
  'clinical_core.program_consumer_boundary_activation',
  'clinical_core.program_qualification_boundary',
  'clinical_core.program_qualification_subjects',
]);

export class QualificationProgramUpgradeError extends Error {
  constructor(readonly category: 'boundary_refused' | 'artifact_refused' | 'history_refused' | 'inventory_refused' |
    'upgrade_busy' | 'verification_failed' | 'recovery_required' | 'upgrade_failed', readonly stage?: string) {
    super(stage ? `${category}:${stage}` : category); this.name = 'QualificationProgramUpgradeError';
  }
}
const fail = (category: ConstructorParameters<typeof QualificationProgramUpgradeError>[0], stage?: string): never => {
  throw new QualificationProgramUpgradeError(category, stage);
};
type Source = { migrations: ClinicalCoreMigration[]; statements: string[][]; rollbackSha256: string };
const source = (): Source => {
  const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-consent-copy-candidate.mjs', '--json'],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }));
  if (artifact.candidate?.contract !== 'telehealth-consent-copy-candidate/1' || artifact.candidate?.migrationCount !== 112
    || artifact.candidate?.migrationReleaseSha256 !== PARENT_LEDGER || artifact.manifest?.migrations?.length !== 112) fail('artifact_refused');
  const migrations: ClinicalCoreMigration[] = artifact.manifest.migrations.map((m: { version: string; file: string }) => {
    const sql = artifact.files?.[m.file];
    if (typeof sql !== 'string' || sql.includes('\r')) fail('artifact_refused');
    return { version: m.version, name: m.file.slice(15, -4), sql, sha256: sha(sql) };
  });
  if (sha(migrations.map(m => `${m.version}:${m.sha256}`).join('\n')) !== PARENT_LEDGER
    || migrations.some((m, i) => !/^\d{14}$/.test(m.version) || !/^[a-z0-9_]+$/.test(m.name)
      || (i > 0 && m.version <= migrations[i - 1]!.version))) fail('artifact_refused');
  const statements = CANDIDATES.map(([path, digest, count]) => {
    const sql = readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
    const parts = splitPostgresStatements(sql);
    if (sha(sql) !== digest || parts.length !== count) fail('artifact_refused');
    return parts;
  });
  const rollback = readFileSync(ROLLBACK[0], 'utf8').replace(/\r\n?/g, '\n');
  if (sha(rollback) !== ROLLBACK[1]) fail('artifact_refused');
  return { migrations, statements, rollbackSha256: sha(rollback) };
};

type Table = { schema_name: string; table_name: string; kind: string; rls: boolean; forced: boolean } & Record<string, unknown>;
type Observation = { contract: 'qualification-program-schema-upgrade/1'; databaseName: 'clinical_core_qualification';
  migrationCount: 112; migrationReleaseSha256: string; tableCount: number; rowCount: number; dataSha256: string;
  boundaryPresent: boolean; phiAllowed: false; activation: 'blocked' };
const sameObservation = (a: Observation, b: Observation) =>
  a.contract === b.contract && a.databaseName === b.databaseName &&
  a.migrationCount === b.migrationCount && a.migrationReleaseSha256 === b.migrationReleaseSha256 &&
  a.tableCount === b.tableCount && a.rowCount === b.rowCount && a.dataSha256 === b.dataSha256 &&
  a.boundaryPresent === b.boundaryPresent && a.phiAllowed === b.phiAllowed && a.activation === b.activation;
const tablesSql = `select n.nspname schema_name,c.relname table_name,c.relkind::text kind,c.relrowsecurity rls,c.relforcerowsecurity forced
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in
  ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference','fullscript_delivery')
  and c.relkind='r' and c.relname<>'schema_migrations' order by n.nspname,c.relname`;
async function history(tx: ClinicalCoreTransaction, migrations: ClinicalCoreMigration[]) {
  const rows = (await tx.query<{ version: string; name: string; sha256: string }>(
    'select version,name,sha256 from clinical_core.schema_migrations order by version')).rows;
  if (rows.length !== 112 || rows.some((r, i) => r.version !== migrations[i]?.version
    || r.name !== migrations[i]?.name || r.sha256 !== migrations[i]?.sha256)) fail('history_refused');
}
async function inspectTx(tx: ClinicalCoreTransaction, migrations: ClinicalCoreMigration[]): Promise<Observation> {
  const identity = (await tx.query<{ name: string }>('select current_database() name')).rows[0];
  if (identity?.name !== 'clinical_core_qualification') fail('boundary_refused');
  await history(tx, migrations);
  const tables = (await tx.query<Table>(tablesSql)).rows;
  if (tables.length < 200 || tables.some(t => t.kind !== 'r')) fail('inventory_refused');
  const added = tables.filter(t => ADDED_TABLES.has(careErasurePreservation.tableName(t)));
  if (added.length !== 0 && added.length !== ADDED_TABLES.size) fail('recovery_required');
  const historical = tables.filter(t => !ADDED_TABLES.has(careErasurePreservation.tableName(t)));
  const fingerprint = await careErasurePreservation.fingerprint(tx, historical);
  const boundary = (await tx.query<{ present: boolean }>(
    "select to_regclass('clinical_core.program_qualification_boundary') is not null present")).rows[0]?.present;
  if (typeof boundary !== 'boolean') fail('inventory_refused');
  if (boundary !== (added.length === ADDED_TABLES.size)) fail('recovery_required');
  return { contract: 'qualification-program-schema-upgrade/1', databaseName: 'clinical_core_qualification',
    migrationCount: 112, migrationReleaseSha256: PARENT_LEDGER, tableCount: tables.length,
    rowCount: fingerprint.rows, dataSha256: fingerprint.sha256, boundaryPresent: boundary,
    phiAllowed: false, activation: 'blocked' };
}
async function closed(tx: ClinicalCoreTransaction, migrations: ClinicalCoreMigration[]) {
  await history(tx, migrations);
  const row = (await tx.query<{ enabled: boolean; database_name: string | null; review_sha256: string | null }>(
    'select enabled,database_name,review_sha256 from clinical_core.program_qualification_boundary')).rows;
  if (row.length !== 1 || row[0]?.enabled !== false || row[0]?.database_name !== null || row[0]?.review_sha256 !== null) fail('verification_failed', 'boundary_row');
  if ((await tx.query<{ n: number }>('select count(*)::int n from clinical_core.program_qualification_subjects')).rows[0]?.n !== 0)
    fail('verification_failed', 'subjects');
  for (const table of ['lab_result_transfer_v2_activation', 'lab_observation_attestation_activation',
    'production_program_activation', 'program_consumer_boundary_activation']) {
    const rows = (await tx.query<{ enabled: boolean }>(`select enabled from clinical_core.${table}`)).rows;
    if (rows.length !== 1 || rows[0]?.enabled !== false) fail('verification_failed', 'production_activation');
  }
  for (const [signature, expected] of FUNCTION_DIGESTS) {
    const rows = (await tx.query<{ digest: string }>(`select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') digest
      from pg_proc p where p.oid=to_regprocedure($1)`, [signature])).rows;
    if (rows.length !== 1 || rows[0]?.digest !== expected) fail('verification_failed', 'function_digest');
  }
}
class RehearsalRollback extends Error { constructor(readonly before: Observation) { super('rehearsal_rollback'); } }
export type QualificationProgramUpgradeCommand = 'inspect' | 'rehearse' | 'upgrade';
export async function runQualificationProgramSchemaUpgrade(database: ClinicalCoreDatabase,
  command: QualificationProgramUpgradeCommand): Promise<Observation & { command: QualificationProgramUpgradeCommand; applied: boolean; rolledBack: boolean }> {
  if (!['inspect', 'rehearse', 'upgrade'].includes(command)) fail('boundary_refused');
  const src = source();
  if (command === 'inspect') {
    const observation = await database.transaction(async tx => {
      await tx.query('set transaction isolation level repeatable read read only');
      await tx.query("set local statement_timeout='30s'");
      return inspectTx(tx, src.migrations);
    });
    return { ...observation, command, applied: false, rolledBack: false };
  }
  const initial = await runQualificationProgramSchemaUpgrade(database, 'inspect');
  if (initial.boundaryPresent) fail('recovery_required');
  let stage = 'transaction_start';
  try {
    const result = await database.transaction(async tx => {
      await tx.query('set transaction isolation level read committed');
      await tx.query("set local lock_timeout='5s'");
      await tx.query("set local statement_timeout='30s'");
      await tx.query('set local row_security=off');
      stage = 'identity_and_locks';
      if ((await tx.query<{ name: string }>('select current_database() name')).rows[0]?.name !== 'clinical_core_qualification') fail('boundary_refused');
      for (const key of ['ai-desktop-pro:production-clinical-core-migrations', 'ai-desktop-pro:qualification-fixtures']) {
        if ((await tx.query<{ acquired: boolean }>('select pg_try_advisory_xact_lock(hashtext($1)) acquired', [key])).rows[0]?.acquired !== true)
          fail('upgrade_busy');
      }
      const tables = (await tx.query<Table>(tablesSql)).rows;
      if (tables.length !== initial.tableCount || tables.some(t => t.kind !== 'r')) fail('inventory_refused');
      await tx.query(`lock table ${tables.map(careErasurePreservation.qualified).concat('clinical_core.schema_migrations').sort().join(',')} in share row exclusive mode`);
      stage = 'fresh_custody';
      const before = await inspectTx(tx, src.migrations);
      if (!sameObservation(before, initial)) fail('inventory_refused');
      for (let index = 0; index < src.statements.length; index++) {
        stage = `candidate_${index + 1}`;
        for (const statement of src.statements[index]!) await tx.query(statement);
      }
      stage = 'closed_boundary';
      await closed(tx, src.migrations);
      stage = 'data_preservation';
      const afterTables = (await tx.query<Table>(tablesSql)).rows;
      const names = new Set(afterTables.map(careErasurePreservation.tableName));
      if (afterTables.length !== tables.length + ADDED_TABLES.size
        || tables.some(t => !names.has(careErasurePreservation.tableName(t)))
        || [...ADDED_TABLES].some(name => !names.has(name))) fail('verification_failed', 'table_delta');
      const after = await careErasurePreservation.fingerprint(tx, tables);
      if (after.rows !== before.rowCount || after.sha256 !== before.dataSha256) fail('verification_failed', 'historical_data');
      if (command === 'rehearse') throw new RehearsalRollback(before);
      return { ...before, boundaryPresent: true, tableCount: afterTables.length, command, applied: true, rolledBack: false };
    });
    const settled = await runQualificationProgramSchemaUpgrade(database, 'inspect');
    if (!settled.boundaryPresent || settled.dataSha256 !== initial.dataSha256 || settled.rowCount !== initial.rowCount
      || settled.tableCount !== result.tableCount) fail('verification_failed', 'committed_readback');
    return result;
  } catch (error) {
    if (error instanceof RehearsalRollback) {
      const readback = await runQualificationProgramSchemaUpgrade(database, 'inspect');
      if (!sameObservation(readback, error.before))
        fail('verification_failed', 'rollback_readback');
      return { ...error.before, command: 'rehearse', applied: false, rolledBack: true };
    }
    if (error instanceof QualificationProgramUpgradeError) throw new QualificationProgramUpgradeError(error.category, error.stage ?? stage);
    throw new QualificationProgramUpgradeError('upgrade_failed', stage);
  }
}
