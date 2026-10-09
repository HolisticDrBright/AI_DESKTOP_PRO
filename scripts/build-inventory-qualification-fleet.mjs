/** Twelve exact-source synthetic candidates. No deployment, schema apply,
 * provider calls, fixtures, approval creation or production activation. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { inventorySourceIdentity } from './inventory-qualification-source.mjs';
import { INVENTORY_FLEET_SPECS } from './inventory-qualification-fleet-specs.mjs';
import { inventoryFleetTemplate } from './inventory-qualification-fleet-template.mjs';
import { inventoryQualificationZip } from './inventory-qualification-zip.mjs';
import { INVENTORY_PROFILE, INVENTORY_RELEASE } from './inventory-care-qualification-template.mjs';
const args = process.argv.slice(2);
if (args.length > 1 || args.length && !/^--out-dir=.+$/.test(args[0])) throw Error('inventory_fleet_build_argument_refused');
const out = resolve(args.length ? args[0].slice(10) : 'dist/aws-clinical-core/inventory-qualification-fleet');
const json = v => JSON.stringify(v, null, 2) + '\n', sha = v => createHash('sha256').update(v).digest('hex');
const identity = inventorySourceIdentity();
const compiled = { ...identity, migrationCount: 107, migrationReleaseSha256: INVENTORY_RELEASE, qualificationProfile: INVENTORY_PROFILE };
mkdirSync(out, { recursive: true });
const candidates = [];
for (const spec of INVENTORY_FLEET_SPECS) {
  const root = join(out, spec.name), parentDirectory = join(root, 'historical-builder');
  execFileSync(process.execPath, [`scripts/${spec.builder}`, ...(spec.flags ?? []), `--out-dir=${parentDirectory}`], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  });
  const parentBytes = readFileSync(join(parentDirectory, 'template.json')), parent = JSON.parse(parentBytes);
  const { template, bindings } = inventoryFleetTemplate(parent, identity.sourceCommit, spec);
  const grouped = Map.groupBy(spec.functions, f => f.file), generated = new Map();
  for (const [file, functions] of grouped) {
    const content = `import {createInventoryQualificationEnvelope} from './src/server/clinical-core/inventory-qualification-envelope';\n`
      + `const build=${JSON.stringify(compiled)};\n` + functions.map(f => {
        const source = `./src/server/clinical-core/${f.source}`;
        return `export const ${f.exportName}=createInventoryQualificationEnvelope(()=>process.env,build,${JSON.stringify(f.activation)},${JSON.stringify(f.kind)},async()=>{const parent=await import(${JSON.stringify(source)});return parent.${f.exportName};});`;
      }).join('\n');
    await build({ stdin: { contents: content, resolveDir: process.cwd(), sourcefile: `inventory-${spec.name}-${file}.ts`, loader: 'ts' },
      outfile: join(root, file), bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: true, legalComments: 'none',
      external: spec.runtime ? [`./${spec.runtime}`] : [] });
    generated.set(file, readFileSync(join(root, file)));
  }
  if (spec.runtime) {
    const bytes = readFileSync(join(parentDirectory, spec.runtime));
    writeFileSync(join(root, spec.runtime), bytes); generated.set(spec.runtime, bytes);
  }
  const packages = new Map();
  for (const binding of bindings) {
    const id = `${binding.bucketParameter}:${binding.keyParameter}:${binding.versionParameter}`;
    const existing = packages.get(id) ?? { bucketParameter: binding.bucketParameter, keyParameter: binding.keyParameter,
      versionParameter: binding.versionParameter, files: new Set() };
    existing.files.add(binding.file); if (spec.runtime) existing.files.add(spec.runtime);
    packages.set(id, existing);
  }
  const artifacts = [...packages.values()].map((p, index) => {
    const files = [...p.files].sort().map(name => ({ name, bytes: generated.get(name) }));
    const zip = inventoryQualificationZip(files), file = `deployment-${index + 1}.zip`;
    writeFileSync(join(root, file), zip);
    return { ...p, files: files.map(f => ({ name: f.name, sha256: sha(f.bytes), bytes: f.bytes.length })), file,
      sha256: sha(zip), bytes: zip.length };
  });
  const templateBytes = Buffer.from(json(template)); writeFileSync(join(root, 'template.json'), templateBytes);
  const manifest = { contract: 'inventory-qualification-candidate/1', candidate: spec.name, ...compiled,
    parentTemplateSha256: sha(parentBytes), templateSha256: sha(templateBytes), lambdaBindings: bindings, packages: artifacts,
    productionActivationPossible: false, deploymentPerformed: false, hostedVerified: false,
    defaults: { phiAllowed: false, activation: 'blocked', qualification: 'disabled' } };
  const bytes = Buffer.from(json(manifest)); writeFileSync(join(root, 'artifact-manifest.json'), bytes);
  candidates.push({ candidate: spec.name, manifestSha256: sha(bytes), templateSha256: manifest.templateSha256,
    packages: artifacts.map(p => ({ file: p.file, sha256: p.sha256, bytes: p.bytes })) });
}
// The care services use their dedicated compiled metadata, never an envelope
// around a 106-only entry point or a false 106 count carrying the 107 digest.
const careOut = join(out, 'care-build');
execFileSync(process.execPath, ['scripts/build-inventory-care-qualification.mjs', `--out-dir=${careOut}`], {
  encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
});
const care = JSON.parse(readFileSync(join(careOut, 'manifest.json')));
if (care.sourceCommit !== identity.sourceCommit || care.sourceClean !== identity.sourceClean || care.sourceInputSha256 !== identity.sourceInputSha256
  || care.migrationCount !== 107 || care.migrationReleaseSha256 !== INVENTORY_RELEASE || care.qualificationProfile !== INVENTORY_PROFILE
  || care.candidates.length !== 2) throw Error('inventory_fleet_care_source_refused');
for (const c of care.candidates) {
  const from = join(careOut, c.candidate), to = join(out, c.candidate); mkdirSync(to, { recursive: true });
  const manifestBytes = readFileSync(join(from, 'artifact-manifest.json')), m = JSON.parse(manifestBytes);
  if (sha(manifestBytes) !== c.manifestSha256) throw Error('inventory_fleet_care_artifact_refused');
  for (const file of ['index.js', 'template.json', 'deployment.zip', 'artifact-manifest.json']) writeFileSync(join(to, file), readFileSync(join(from, file)));
  candidates.push({ candidate: c.candidate, manifestSha256: c.manifestSha256, templateSha256: c.templateSha256,
    packages: [{ file: 'deployment.zip', sha256: c.deploymentZipSha256, bytes: m.deploymentZipBytes }] });
}
if (candidates.length !== 12 || new Set(candidates.map(c => c.candidate)).size !== 12
  || JSON.stringify(inventorySourceIdentity()) !== JSON.stringify(identity)) throw Error('inventory_fleet_source_changed');
writeFileSync(join(out, 'manifest.json'), json({ contract: 'inventory-qualification-fleet-build/1', ...compiled, candidates,
  artifactSetComplete: true, targetBindingComplete: false, deploymentPerformed: false, hostedVerified: false,
  phiAllowed: false, activation: 'blocked', remaining: ['distinct complete-fleet target/observer', 'real recovery qualification',
    'preserving upgrade', 'hosted journeys', 'matched releases and physical devices', 'independent human reviews'] }));
console.log('Built all twelve synthetic 107 candidate artifacts. Target/hosted/recovery qualification incomplete; no AWS deployment or activation.');
