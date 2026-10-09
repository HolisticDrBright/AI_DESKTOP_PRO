/** Builds two distinct 107 qualification entry points. No AWS calls, no apply,
 * no production activation. This is NOT a complete twelve-candidate fleet. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { careMessagingZip } from './care-messaging-zip.mjs';
import { inventoryCareTemplate, INVENTORY_PROFILE, INVENTORY_PARENT, INVENTORY_RELEASE } from './inventory-care-qualification-template.mjs';
const args = process.argv.slice(2);
if (args.length > 1 || args.length && !/^--out-dir=.+$/.test(args[0])) throw Error('inventory_care_build_argument_refused');
const out = resolve(args.length ? args[0].slice(10) : 'dist/aws-clinical-core/inventory-care-qualification');
const sha = v => createHash('sha256').update(v).digest('hex');
const json = v => JSON.stringify(v, null, 2) + '\n';
const execute = (script, flags = []) => execFileSync(process.execPath, [script, ...flags], {
  encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000,
});
const sourcePaths = ['src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.gitignore', '.github'];
function sourceInputDigest() {
  const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...sourcePaths],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\0').filter(Boolean).sort();
  const entries = [...new Set(names)].map(name => {
    const before = lstatSync(name); if (!before.isFile() || before.isSymbolicLink()) throw Error('inventory_care_source_file_refused');
    const bytes = readFileSync(name), after = lstatSync(name);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || bytes.length !== after.size) throw Error('inventory_care_build_source_changed');
    return `${name}:${sha(bytes)}`;
  });
  return sha(entries.join('\n'));
}
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceClean = !execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
  ...sourcePaths], { encoding: 'utf8' }).trim();
const sourceInputSha256 = sourceInputDigest();
const successor = JSON.parse(execute('scripts/build-adopted-plan-inventory-candidate.mjs', ['--json']));
if (successor.candidate?.parentMigrationCount !== 106 || successor.candidate.parentMigrationReleaseSha256 !== INVENTORY_PARENT
  || successor.candidate.migrationCount !== 107 || successor.candidate.migrationReleaseSha256 !== INVENTORY_RELEASE
  || successor.candidate.phiAllowed !== false || successor.candidate.activation !== 'blocked'
  || successor.manifest.migrations.length !== 107) throw Error('inventory_care_build_successor_refused');
mkdirSync(out, { recursive: true });
const candidates = [];
for (const kind of ['messaging', 'connections']) {
  const directory = join(out, `care-${kind}`), parentDirectory = join(directory, 'historical-106');
  execute(`scripts/build-aws-care-${kind}.mjs`, [`--out-dir=${parentDirectory}`]);
  const parent = JSON.parse(readFileSync(join(parentDirectory, 'artifact-manifest.json'), 'utf8'));
  const parentTemplateBytes = readFileSync(join(parentDirectory, 'template.json'));
  if (parent.contract !== `care-${kind}-deployment/1` || parent.sourceCommit !== sourceCommit || parent.sourceClean !== sourceClean
    || parent.migrationCount !== 106 || parent.migrationReleaseSha256 !== INVENTORY_PARENT
    || parent.templateSha256 !== sha(parentTemplateBytes) || parent.functions.length !== 7
    || kind === 'connections' && parent.claimFunctions.length !== 2) throw Error('inventory_care_build_parent_refused');
  const compiled = { sourceCommit, sourceClean, migrationCount: 107, migrationReleaseSha256: INVENTORY_RELEASE,
    qualificationProfile: INVENTORY_PROFILE, functions: parent.functions,
    ...(kind === 'connections' ? { claimFunctions: parent.claimFunctions } : {}) };
  const define = kind === 'messaging' ? '__INVENTORY_CARE_MESSAGING_BUILD__' : '__INVENTORY_CARE_CONNECTIONS_BUILD__';
  await build({ entryPoints: [`src/server/clinical-core/inventory-care-${kind}-lambda.ts`], outfile: join(directory, 'index.js'),
    bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: true, legalComments: 'none',
    define: { [define]: JSON.stringify(compiled) } });
  const template = inventoryCareTemplate(JSON.parse(parentTemplateBytes), sourceCommit);
  const templateBytes = Buffer.from(json(template)), code = readFileSync(join(directory, 'index.js')), zip = careMessagingZip(code);
  writeFileSync(join(directory, 'template.json'), templateBytes);
  writeFileSync(join(directory, 'deployment.zip'), zip);
  const manifest = { contract: 'inventory-care-qualification-deployment/1', candidate: `care-${kind}`, ...compiled, sourceInputSha256,
    parentManifestSha256: sha(readFileSync(join(parentDirectory, 'artifact-manifest.json'))),
    parentTemplateSha256: parent.templateSha256, codeSha256: sha(code), templateSha256: sha(templateBytes),
    deploymentZipSha256: sha(zip), deploymentZipBytes: zip.length, defaults: parent.defaults,
    deploymentPerformed: false, hostedVerified: false, activationApproved: false,
    remaining: ['ten remaining candidate bindings', 'distinct complete-fleet target and hosted observer',
      'real custody recovery qualification', 'preserving schema upgrade', 'hosted acceptance', 'matched releases and physical devices'] };
  writeFileSync(join(directory, 'artifact-manifest.json'), json(manifest));
  candidates.push({ candidate: manifest.candidate, manifestSha256: sha(json(manifest)), templateSha256: manifest.templateSha256,
    deploymentZipSha256: manifest.deploymentZipSha256 });
}
// Re-read the source identity after both compilers. A changing checkout is not
// a coherent release even if its final dirty/clean flag happens to agree.
if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== sourceCommit
  || sourceInputDigest() !== sourceInputSha256
  || (!execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
    ...sourcePaths], { encoding: 'utf8' }).trim()) !== sourceClean) {
  throw Error('inventory_care_build_source_changed');
}
writeFileSync(join(out, 'manifest.json'), json({ contract: 'inventory-care-qualification-build/1', sourceCommit, sourceClean, sourceInputSha256,
  qualificationProfile: INVENTORY_PROFILE, migrationCount: 107, migrationReleaseSha256: INVENTORY_RELEASE, candidates,
  fleetComplete: false, deploymentPerformed: false, hostedVerified: false, phiAllowed: false, activation: 'blocked' }));
console.log('Built two separate 107 synthetic care candidates; historical 106 remains unchanged. Fleet incomplete, no AWS deployment or activation.');
