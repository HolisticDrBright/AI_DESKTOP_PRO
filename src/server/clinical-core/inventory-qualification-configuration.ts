import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { inventorySourceIdentity } from '../../../scripts/inventory-qualification-source.mjs';
import { inventoryBoundedFile, inventoryCanonical, inventoryRefuse, inventorySha, readInventoryQualificationArtifacts } from './inventory-qualification-artifacts';
import { validateInventoryQualificationTarget } from './inventory-qualification-target';

/** Configuration check only. Freshly rebuilds exact source; no AWS access,
 * activation, provider call, fixture creation or approval/signing operation. */
export function prepareInventoryQualificationConfiguration(args: string[], mode: '--check-configuration' | '--observe-fleet') {
  if (!['--check-configuration', '--observe-fleet'].includes(mode)
    || args.length !== 2 || args[0] !== mode || !/^--target=.+$/.test(args[1])) return inventoryRefuse('argument_refused');
  const first = inventorySourceIdentity(); if (!first.sourceClean) return inventoryRefuse('dirty_source_refused');
  const file = resolve(args[1].slice(9));
  const input = inventoryBoundedFile(dirname(file), [basename(file)], 2 * 1024 * 1024);
  const temporary = mkdtempSync(join(tmpdir(), 'alp-inventory-target-'));
  const dispose = () => {
    // Validate the exact directory created above before any recursive cleanup.
    const absolute = resolve(temporary), parent = realpathSync(tmpdir()), stat = lstatSync(absolute);
    if (dirname(realpathSync(absolute)) !== parent || !basename(absolute).startsWith('alp-inventory-target-') || !stat.isDirectory() || stat.isSymbolicLink()) {
      inventoryRefuse('temporary_cleanup_refused');
    }
    rmSync(absolute, { recursive: true, force: false });
  };
  try {
    execFileSync(process.execPath, ['scripts/build-inventory-qualification-fleet.mjs', `--out-dir=${temporary}`], {
      encoding: 'utf8', windowsHide: true, timeout: 240000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const artifacts = readInventoryQualificationArtifacts(temporary, first);
    let value: unknown; try { value = JSON.parse(input.toString('utf8')); } catch { return inventoryRefuse('target_json_refused'); }
    const target = validateInventoryQualificationTarget(value, artifacts);
    const assertUnchanged = () => {
      if (inventoryCanonical(inventorySourceIdentity()) !== inventoryCanonical(first)
        || !inventoryBoundedFile(dirname(file), [basename(file)], 2 * 1024 * 1024).equals(input)) return inventoryRefuse('source_or_target_changed');
      if (inventoryCanonical(readInventoryQualificationArtifacts(temporary, first)) !== inventoryCanonical(artifacts))
        return inventoryRefuse('artifact_observation_changed');
    };
    assertUnchanged();
    return { source: first, target, artifacts, targetSha256: inventorySha(input), assertUnchanged, dispose };
  } catch (error) { dispose(); throw error; }
}

/** Source-only check remains synchronous and makes no AWS call. */
export function checkInventoryQualificationConfiguration(args: string[]) {
  const prepared = prepareInventoryQualificationConfiguration(args, '--check-configuration');
  try {
    const { source: first, artifacts, target, targetSha256 } = prepared;
    return { contract: 'inventory-qualification-configuration-check/1', configurationChecked: true, liveTargetVerified: false,
      reviewVerified: false, acceptance: false, deploymentPerformed: false, phiAllowed: false,
      sourceCommit: first.sourceCommit, sourceInputSha256: first.sourceInputSha256, buildManifestSha256: artifacts.manifestSha256,
      targetSha256, candidates: target.candidates.length, packages: target.candidates.reduce((n, c) => n + c.packages.length, 0),
      remaining: ['actual complete-fleet resource and ledger observation', 'real custody recovery qualification',
        'reviewed preserving upgrade and deployment', 'hosted acceptance', 'matched releases and physical devices', 'human approvals'] };
  } finally { prepared.dispose(); }
}
