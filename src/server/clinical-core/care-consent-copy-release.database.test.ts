import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import type { ClinicalCoreMigration } from './migrations';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { CARE_CONNECTIONS_UPGRADE } from './care-connections-schema-upgrade';
import { CARE_CLAIM_RECOVERY_UPGRADE } from './care-claim-recovery-schema-upgrade';
import { runCareConsentCopyRegistration } from './care-consent-copy-registration';

// Both real ordered SQL artifacts run in embedded PostgreSQL. Only the database
// name is substituted; this is neither hosted evidence nor an activation review.
let old: PGlite, current: PGlite, migrations: ClinicalCoreMigration[];
const base = { expectedAccountId: '588966314750', region: 'us-east-2', phiAllowed: false as const,
  activation: 'blocked' as const, clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional',
  qualificationDatabaseName: 'clinical_core_qualification', stagingDatabaseName: 'clinical_core' };
const configuration = (count: 105 | 106): QualificationUpgradeConfiguration => {
  const transition = count === 105 ? CARE_CONNECTIONS_UPGRADE : CARE_CLAIM_RECOVERY_UPGRADE;
  return { ...base, fromReleaseSha256: transition.from, toReleaseSha256: transition.to };
};
const database = (pg: PGlite): ClinicalCoreDatabase => ({ transaction: work => pg.transaction(async tx =>
  work({ query: async (sql: string, args: readonly unknown[] = []) => sql === 'select current_database() as name'
    ? { rows: [{ name: base.qualificationDatabaseName }] } : tx.query(sql, [...args]) } as ClinicalCoreTransaction)) });
beforeAll(async () => {
  const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 }));
  migrations = artifact.manifest.migrations.map((m: { version: string; file: string }) => ({ version: m.version,
    name: m.file.slice(15, -4), sql: artifact.files[m.file],
    sha256: createHash('sha256').update(artifact.files[m.file]).digest('hex') }));
  old = new PGlite({ extensions: { pgcrypto } }); current = new PGlite({ extensions: { pgcrypto } });
  expect(await applyProductionClinicalCoreMigrations(database(old), migrations.slice(0, 105)))
    .toMatchObject({ tableCount: 128, contractCount: 85, clinicalRowCount: 0 });
  expect(await applyProductionClinicalCoreMigrations(database(current), migrations))
    .toMatchObject({ tableCount: 130, contractCount: 86, clinicalRowCount: 0 });
}, 90000);
afterAll(async () => { await old?.close(); await current?.close(); });
const inventory = (pg: PGlite, artifactCount: 105 | 106, targetCount = artifactCount) =>
  runCareConsentCopyRegistration(database(pg), migrations.slice(0, artifactCount), configuration(targetCount), 'inventory');
describe('exact historical and current consent release admission', () => {
  it('admits the original 105 target only with its original artifact', async () => {
    expect(await inventory(old, 105)).toMatchObject({ migrationCount: 105,
      migrationReleaseSha256: CARE_CONNECTIONS_UPGRADE.to, inventory: { approvedArtifacts: 0, registeredCopies: 0 },
      approvalsCreated: false, grantsCreated: false, phiAllowed: false, activation: 'blocked' });
  });
  it('admits registered 106 without generating approvals or grants', async () => {
    expect(await inventory(current, 106)).toMatchObject({ migrationCount: 106,
      migrationReleaseSha256: CARE_CLAIM_RECOVERY_UPGRADE.to, inventory: { approvedArtifacts: 0, registeredCopies: 0 },
      approvalsCreated: false, grantsCreated: false, phiAllowed: false, activation: 'blocked' });
  });
  it('refuses either live ledger paired with the other artifact', async () => {
    await expect(inventory(old, 106)).rejects.toThrow('history_refused');
    await expect(inventory(current, 105)).rejects.toThrow('history_refused');
  });
  it('refuses count-only selection and mixed transition identities before a transaction', async () => {
    let entered = false;
    const never: ClinicalCoreDatabase = { transaction: async () => { entered = true; throw new Error('must not enter'); } };
    for (const [count, target] of [[105, 106], [106, 105]] as const) {
      await expect(runCareConsentCopyRegistration(never, migrations.slice(0, count), configuration(target), 'inventory'))
        .rejects.toThrow('artifact_refused');
    }
    const altered = migrations.map((m, i) => i === 105 ? { ...m, sql: m.sql + '\n-- tampered' } : m);
    await expect(runCareConsentCopyRegistration(never, altered, configuration(106), 'inventory')).rejects.toThrow('artifact_refused');
    expect(entered).toBe(false);
  });
});
