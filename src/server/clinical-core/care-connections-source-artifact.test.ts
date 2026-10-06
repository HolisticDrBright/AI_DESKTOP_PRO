import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
let directory: string;
type Manifest = { contract: string; status: string; deployable: boolean; sourceCommit: string; sourceDirty: boolean;
  baselineMigrationCount: number; baselineLedgerReleaseSha256: string; baselineAssemblySha256: string;
  proposedUpgrade: { version: string; migrationCount: number; ledgerReleaseSha256: string; canonical: boolean;
    hostedVerified: boolean; cliOperatorAvailable: boolean };
  schema: { file: string; sha256: string; bytes: number }; libraries: { file: string; sha256: string }[];
  functions: { name: string; bodySha256: string; apiExecute: boolean }[]; proposedRoutes: string[];
  proposedCoveredEntityMapping: { table: string; status: string; dependsOn: string[] };
  connectionCode: { entropyBits: number; symbols: number; stored: string }; activation: string; phiAllowed: boolean;
  seededApprovals: boolean; seededConsents: boolean; remaining: string[] };
let manifest: Manifest;
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'care-connections-source-'));
  execFileSync(process.execPath, ['scripts/build-care-connections-source-candidate.mjs', `--out-dir=${directory}`], { encoding: 'utf8', timeout: 30000 });
  manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
}, 35000);
afterAll(() => {
  if (!directory) return;
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('care-connections-source-')) throw new Error('temporary_cleanup_boundary_refused');
  rmSync(target, { recursive: true, force: true });
});
describe('unreleased connection candidate mapping', () => {
  it('pins the entire unchanged 104-migration prefix, not a guessed next release', () => {
    expect(manifest).toMatchObject({ contract: 'care-connections-source-candidate/1', status: 'unreleased', deployable: false,
      baselineMigrationCount: 104, baselineLedgerReleaseSha256: '57fdf022f0fdd7d70be12384d6e6d54caab1a0ddb4965a884e4d59eec4c552b0',
      phiAllowed: false, activation: 'blocked', seededApprovals: false, seededConsents: false });
    expect(manifest.sourceCommit).toMatch(/^[a-f0-9]{40}$/); expect(typeof manifest.sourceDirty).toBe('boolean');
    expect(manifest).not.toHaveProperty('migrationReleaseSha256');
  });
  it('hashes actual emitted SQL and both runnable libraries, including every function body', () => {
    const sql = readFileSync(join(directory, manifest.schema.file), 'utf8');
    expect(sql).not.toContain('\r'); expect(manifest.schema.sha256).toBe(sha(sql)); expect(manifest.schema.bytes).toBe(Buffer.byteLength(sql));
    expect(manifest.libraries.map(l => l.file)).toEqual(['api-library.cjs', 'service-library.cjs', 'upgrade-library.cjs']);
    for (const library of manifest.libraries) expect(library.sha256).toBe(sha(readFileSync(join(directory, library.file))));
    const functions = [...sql.matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
      .map(([, name, body]) => ({ name, bodySha256: sha(body), apiExecute: name.startsWith('clinical_core.') }));
    expect(functions).toHaveLength(7); expect(manifest.functions).toEqual(functions);
    expect(functions.filter(f => f.apiExecute).map(f => f.name)).toEqual(['clinical_core.create_sync_invitation', 'clinical_core.production_care_connection_request']);
  });
  it('derives the canonical source upgrade identity without claiming hosted verification', () => {
    const { manifest: baseline, files } = JSON.parse(execFileSync(process.execPath,
      ['scripts/build-aws-production-clinical-core.mjs', '--json'], { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 }));
    expect(baseline.migrations).toHaveLength(105);
    const ledger = baseline.migrations.map((m: { version: string; file: string }) => `${m.version}:${sha(files[m.file])}`).join('\n');
    expect(manifest.proposedUpgrade).toEqual({ version: '20261006020000', migrationCount: 105,
      ledgerReleaseSha256: sha(ledger), canonical: true, hostedVerified: false, cliOperatorAvailable: true });
    expect(manifest.proposedUpgrade.ledgerReleaseSha256).toBe('7da8e4ed999a3298bccc4ef33e7a1005201db45fa2b46682622a208486f17743');
  });
  it('declares pending lifecycle integration and the exact two routes instead of claiming a deployed handler', () => {
    expect(manifest.proposedRoutes).toEqual(['POST /clinical-core/consumer/connection', 'POST /clinical-core/workforce/connection']);
    expect(manifest.proposedCoveredEntityMapping).toMatchObject({ table: 'clinical_core.care_consent_texts', status: 'inventory_integrated_disposition_blocked',
      dependsOn: ['clinical_core.consent_artifacts'] });
    expect(manifest.connectionCode).toMatchObject({ entropyBits: 65, symbols: 13, stored: 'sha256_only' });
    expect(manifest.remaining.join(' ')).toContain('preserving 104-prefix upgrade');
    expect(manifest.remaining.join(' ')).toContain('physical-device acceptance');
  });
});
