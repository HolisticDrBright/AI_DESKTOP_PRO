import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

type Artifact = {
  manifest: { migrations: { version: string; file: string }[] };
  files: Record<string, string>;
  releaseHash: string;
  candidate?: Record<string, unknown>;
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const build = (script: string) => JSON.parse(execFileSync(process.execPath, [script, '--json'], {
  encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000,
})) as Artifact;
let parent: Artifact, candidate: Artifact;
beforeAll(() => {
  parent = build('scripts/build-aws-production-clinical-core.mjs');
  candidate = build('scripts/build-adopted-plan-inventory-candidate.mjs');
}, 20000);

describe('distinct, undeployed adopted-plan inventory candidate', () => {
  it('preserves every historical parent byte without changing the canonical 106-migration release', () => {
    expect(parent.manifest.migrations).toHaveLength(106);
    expect(candidate.manifest.migrations).toHaveLength(107);
    expect(candidate.manifest.migrations.slice(0, 106)).toEqual(parent.manifest.migrations);
    for (const entry of parent.manifest.migrations) expect(candidate.files[entry.file]).toBe(parent.files[entry.file]);
    const ledger = sha(parent.manifest.migrations.map(m => `${m.version}:${sha(parent.files[m.file])}`).join('\n'));
    expect(ledger).toBe('514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b');
  });
  it('binds the extension and entire successor to their actual bytes, never deployed or activated', () => {
    const entry = candidate.manifest.migrations.at(-1)!;
    expect(entry.file).toBe('20261009010000_production_adopted_plan_inventory.sql');
    const extension = readFileSync('infra/aws-clinical-core/production-candidates/owned-plan-inventory.sql', 'utf8').replace(/\r\n?/g, '\n');
    expect(candidate.files[entry.file]).toBe(extension);
    expect(Object.keys(candidate.files)).toHaveLength(107);
    expect(candidate.candidate).toEqual({
      contract: 'adopted-plan-inventory-candidate/1', parentMigrationCount: 106,
      parentMigrationReleaseSha256: '514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b',
      migrationCount: 107, migrationReleaseSha256: sha(candidate.manifest.migrations.map(m => `${m.version}:${sha(candidate.files[m.file])}`).join('\n')),
      extensionSha256: sha(extension), deployment: 'not_deployed', activation: 'blocked', phiAllowed: false,
    });
    expect(candidate.releaseHash).toBe(sha(candidate.manifest.migrations.map(m => `${m.version}:${m.file}:${sha(candidate.files[m.file])}`).join('\n')));
  });
  it('is refused by the unchanged historical qualification gate', () => {
    const result = execFileSync(process.execPath, ['--input-type=module', '-e',
      "import {qualificationConsentArtifact} from './scripts/qualification-consent-ledger.mjs';" +
      "let raw='';for await(const part of process.stdin)raw+=part;" +
      "try{qualificationConsentArtifact(JSON.parse(raw));process.exitCode=1;}" +
      "catch(e){if(e.message!=='qualification_consent_artifact_refused')throw e;process.stdout.write('refused');}"],
    { input: JSON.stringify(candidate), encoding: 'utf8', timeout: 10000 });
    expect(result).toBe('refused');
  });
  it('refuses an activation flag instead of accepting a build-time shortcut', () => {
    expect(() => execFileSync(process.execPath, ['scripts/build-adopted-plan-inventory-candidate.mjs', '--activate'],
      { stdio: 'pipe', timeout: 10000 })).toThrow();
  });
});
