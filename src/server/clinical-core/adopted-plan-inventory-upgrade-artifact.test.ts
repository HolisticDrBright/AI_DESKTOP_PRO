import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ADOPTED_INVENTORY_UPGRADE } from './adopted-plan-inventory-schema-upgrade';

const out = resolve('dist/aws-clinical-core/adopted-plan-inventory-upgrade');
let manifest: Record<string, unknown>, bundle: string;
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-adopted-plan-inventory-upgrade.mjs'],
    { timeout: 30000, maxBuffer: 2 * 1024 * 1024, stdio: 'pipe' });
  manifest = JSON.parse(readFileSync(resolve(out, 'artifact-manifest.json'), 'utf8'));
  bundle = readFileSync(resolve(out, 'index.cjs'), 'utf8');
}, 35000);

describe('actual bundled inventory upgrade operator, no AWS requests', () => {
  it('binds its source, exact bundle bytes and distinct embedded migration release', () => {
    expect(manifest).toMatchObject({
      contract: 'adopted-plan-inventory-upgrade-build/1',
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      embeddedMigrationCount: 107, fromReleaseSha256: ADOPTED_INVENTORY_UPGRADE.from,
      toReleaseSha256: ADOPTED_INVENTORY_UPGRADE.to, execution: 'qualification_only',
      phiAllowed: false, activation: 'blocked', migrationPerformed: false,
      mandatoryRollbackRehearsal: true, postRehearsalPrestateRecheck: true, automaticWriteRetry: false,
      durableNativeCustody: true, sharedOperatorNamespace: true, readOnlyInterruptionReconciliation: true,
      reconciliationRequiresMigrationLocks: true, hostedRecoveryQualified: false,
    });
    expect(manifest.operatorSha256).toBe(createHash('sha256').update(readFileSync(resolve(out, 'index.cjs'))).digest('hex'));
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
      'src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.github'], { encoding: 'utf8' }).trim();
    expect(manifest.clean).toBe(!dirty);
    expect(bundle).toContain('create function clinical_core.get_owned_plan_inventory_source()');
    expect(bundle).toContain('20261009010000');
    // AWS credential providers legitimately read the fixed profile/token files.
    // The application migration loader, unlike those bundled SDK internals,
    // must not read SQL or manifests from the working directory or environment.
    const operator = readFileSync('src/server/clinical-core/adopted-plan-inventory-schema-upgrade-operator.ts', 'utf8');
    expect(operator).toContain('createNativeInventoryUpgradeDependencies(__filename, () => __ADOPTED_INVENTORY_MIGRATIONS__)');
    expect(operator).not.toMatch(/readFile|node:fs|process\.env|loadMigrations\s*:\s*[^\n]*resolve\(/);
    const nativePorts = readFileSync('src/server/clinical-core/adopted-plan-inventory-native-ports.ts', 'utf8');
    expect(nativePorts).toContain('root: INVENTORY_OPERATOR_SHARED_ROOT, operatorFile');
    expect(nativePorts).toContain('withInventoryOperatorFence(database, work)');
    expect(nativePorts).toContain("endpoint: INVENTORY_RDS_ENDPOINT, maxAttempts: 1");
    expect(nativePorts).toContain('AbortSignal.timeout(INVENTORY_RDS_REQUEST_DEADLINE_MS)');
    expect(manifest.interruptionWorkerSha256).toBe(createHash('sha256').update(readFileSync(resolve(out, 'interruption-worker.cjs'))).digest('hex'));
    expect(manifest.interruptionWorkerScope).toBe('instrumented_real_core_and_ports_before_write_and_precommit_only');
    expect(bundle).toContain('inventory-upgrade-reconciliation.lock');
  });
  it('refuses every override before observing AWS even from an unrelated directory', () => {
    for (const args of [[], ['apply'], ['inspect', '--profile=production'], ['inspect', '--database=clinical_core'],
      ['upgrade'], ['upgrade', '--yes'], ['upgrade', '--confirm-fictional-adopted-inventory-upgrade', '--skip-rehearsal'],
      ['rehearse', '--activate'], ['inspect', '--phi-allowed=true'], ['reconcile'],
      ['reconcile', '--yes'], ['reconcile', '--reconcile-fictional-adopted-inventory-upgrade', '--root=other']]) {
      const r = spawnSync(process.execPath, [resolve(out, 'index.cjs'), ...args], {
        cwd: tmpdir(), encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: '', AWS_PROFILE: 'not-an-authority', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' },
      });
      expect(r.error).toBeUndefined(); expect(r.status).toBe(1);
      expect(r.stdout.trim()).toBe(''); expect(r.stderr.trim()).toBe('boundary_refused');
    }
  });
  it('refuses builder activation and target overrides instead of packaging them', () => {
    for (const args of [['--activate'], ['--database=clinical_core'], ['--skip-rehearsal'], ['--phi-allowed']]) {
      const r = spawnSync(process.execPath, ['scripts/build-adopted-plan-inventory-upgrade.mjs', ...args],
        { encoding: 'utf8', timeout: 10000 });
      expect(r.status).toBe(1); expect(r.stderr).toContain('adopted_inventory_upgrade_argument_invalid');
    }
  });
  it('compiled interruption worker refuses non-IPC invocation before AWS, even with the fictional confirmation', () => {
    for (const mode of ['before-write', 'precommit', 'reconcile']) {
      const r = spawnSync(process.execPath, [resolve(out, 'interruption-worker.cjs'), mode, '--confirm-fictional-inventory-interruption'], {
        cwd: tmpdir(), encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: '', AWS_PROFILE: 'not-an-authority' },
      });
      expect(r.error).toBeUndefined(); expect(r.status).toBe(1); expect(r.stdout.trim()).toBe(''); expect(r.stderr.trim()).toBe('');
    }
  });
});
