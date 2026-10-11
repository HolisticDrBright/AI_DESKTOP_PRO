/** Source-only compilation of the twelve existing request candidates. This is
 * not the additional provider fleet, a deployment, review or hosted acceptance. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inventorySourceIdentity } from './inventory-qualification-source.mjs';
import { INVENTORY_FLEET_SPECS } from './inventory-qualification-fleet-specs.mjs';
import { inventoryQualificationZip } from './inventory-qualification-zip.mjs';
import { successorFleetTemplate, successorCareTemplate } from './successor-qualification-template.mjs';
import { successorQualificationReleaseArtifact, SUCCESSOR_QUALIFICATION_RELEASE } from './successor-qualification-release.mjs';

const args = process.argv.slice(2);
if (args.length > 1 || args.length && !/^--out-dir=.+$/.test(args[0])) throw Error('successor_runtime_argument_refused');
const out = resolve(args.length ? args[0].slice(10) : 'dist/aws-clinical-core/successor-qualification-runtime');
const sha = v => createHash('sha256').update(v).digest('hex'), json = v => JSON.stringify(v, null, 2) + '\n';
const execute = (script, flags = []) => execFileSync(process.execPath, ['scripts/' + script, ...flags], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true,
});
const identity = inventorySourceIdentity(), compiled = { ...identity, ...SUCCESSOR_QUALIFICATION_RELEASE };
const releaseBytes = execute('build-telehealth-transfer-authority-candidate.mjs', ['--json']);
const sourceArtifact = JSON.parse(releaseBytes), release = successorQualificationReleaseArtifact(sourceArtifact);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'release-artifact.json'), json(release));
const candidates = [];
for (const spec of INVENTORY_FLEET_SPECS) {
  const root = join(out, spec.name), parentDirectory = join(root, 'historical-builder');
  execute(spec.builder, [...(spec.flags ?? []), `--out-dir=${parentDirectory}`]);
  const parentBytes = readFileSync(join(parentDirectory, 'template.json')), parent = JSON.parse(parentBytes);
  const { template, bindings } = successorFleetTemplate(parent, identity, spec);
  const generated = new Map();
  for (const [file, functions] of Map.groupBy(spec.functions, f => f.file)) {
    const content = `import {createSuccessorQualificationEnvelope} from './src/server/clinical-core/successor-qualification-profile';\n`
      + `const build=${JSON.stringify(compiled)};\n` + functions.map(f =>
        `export const ${f.exportName}=createSuccessorQualificationEnvelope(()=>process.env,build,${JSON.stringify(f.activation)},${JSON.stringify(f.kind)},async()=>{const parent=await import(${JSON.stringify('./src/server/clinical-core/' + f.source)});return parent.${f.exportName};});`).join('\n');
    await build({ stdin: { contents: content, resolveDir: process.cwd(), sourcefile: `successor-${spec.name}-${file}.ts`, loader: 'ts' },
      outfile: join(root, file), bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: true, legalComments: 'none',
      external: spec.runtime ? [`./${spec.runtime}`] : [] });
    generated.set(file, readFileSync(join(root, file)));
  }
  if (spec.runtime) { const bytes = readFileSync(join(parentDirectory, spec.runtime)); writeFileSync(join(root, spec.runtime), bytes); generated.set(spec.runtime, bytes); }
  const packages = new Map();
  for (const b of bindings) {
    const id = `${b.bucketParameter}:${b.keyParameter}:${b.versionParameter}`;
    const p = packages.get(id) ?? { bucketParameter: b.bucketParameter, keyParameter: b.keyParameter, versionParameter: b.versionParameter, files: new Set() };
    p.files.add(b.file); if (spec.runtime) p.files.add(spec.runtime); packages.set(id, p);
  }
  const artifacts = [...packages.values()].map((p, i) => {
    const files = [...p.files].sort().map(name => ({ name, bytes: generated.get(name) }));
    const zip = inventoryQualificationZip(files), file = `deployment-${i + 1}.zip`; writeFileSync(join(root, file), zip);
    return { ...p, files: files.map(f => ({ name: f.name, sha256: sha(f.bytes), bytes: f.bytes.length })), file, sha256: sha(zip), bytes: zip.length };
  });
  const templateBytes = Buffer.from(json(template)); writeFileSync(join(root, 'template.json'), templateBytes);
  const manifest = { contract: 'successor-qualification-runtime-candidate/1', candidate: spec.name, ...compiled,
    sourceCandidateSha256: sha(releaseBytes), parentTemplateSha256: sha(parentBytes), templateSha256: sha(templateBytes),
    lambdaBindings: bindings, packages: artifacts, deploymentPerformed: false, hostedVerified: false, activationApproved: false };
  const bytes = Buffer.from(json(manifest)); writeFileSync(join(root, 'artifact-manifest.json'), bytes);
  candidates.push({ candidate: spec.name, manifestSha256: sha(bytes), templateSha256: manifest.templateSha256, packages: artifacts });
}
// Care services must be compiled with truthful 117 metadata, not wrapped around
// their count-pinned 106/107 factories. Pins come from the exact source artifact.
for (const kind of ['messaging', 'connections']) {
  const root = join(out, `care-${kind}`), parentDirectory = join(root, 'historical-builder');
  execute(`build-aws-care-${kind}.mjs`, [`--out-dir=${parentDirectory}`]);
  const parentBytes = readFileSync(join(parentDirectory, 'template.json')), parent = JSON.parse(parentBytes);
  const pins = sql => [...sql.matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
    .map(([, name, body]) => ({ name, bodySha256: sha(body), apiExecute: name.startsWith('clinical_core.') }));
  const functions = kind === 'messaging' ? [...sourceArtifact.files['20261006010000_production_care_messaging.sql'].matchAll(
    /create function (clinical_(?:core|private))\.(production_care_message_[a-z]+)\([^]*?security definer set search_path='' as \$\$([^]*?)\$\$/g)]
    .map(([, schema, name, body]) => ({ schema, name, sha256: sha(body), callable: schema === 'clinical_core' }))
    : pins(sourceArtifact.files['20261006020000_production_care_connections.sql']);
  const claimFunctions = kind === 'connections' ? pins(sourceArtifact.files['20261006030000_production_care_claim_recovery.sql']) : undefined;
  if (functions.length !== 7 || claimFunctions && claimFunctions.length !== 2) throw Error('successor_care_function_pins_refused');
  const metadata = { ...compiled, functions, ...(claimFunctions ? { claimFunctions } : {}) };
  const content = `import {createSuccessorCare${kind === 'messaging' ? 'Messaging' : 'Connections'}Handler} from './src/server/clinical-core/care-${kind}-deployment';\n`
    + `const build=${JSON.stringify(metadata)};let cached;export async function handler(event){cached??=createSuccessorCare${kind === 'messaging' ? 'Messaging' : 'Connections'}Handler(process.env,build);return cached(event);}`;
  await build({ stdin: { contents: content, resolveDir: process.cwd(), sourcefile: `successor-care-${kind}.ts`, loader: 'ts' },
    outfile: join(root, 'index.js'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: true, legalComments: 'none' });
  const code = readFileSync(join(root, 'index.js')), zip = inventoryQualificationZip([{ name: 'index.js', bytes: code }]);
  const templateBytes = Buffer.from(json(successorCareTemplate(parent, identity)));
  writeFileSync(join(root, 'template.json'), templateBytes); writeFileSync(join(root, 'deployment-1.zip'), zip);
  const packages = [{ bucketParameter: 'CodeBucket', keyParameter: 'CodeKey', versionParameter: 'CodeVersion', file: 'deployment-1.zip',
    sha256: sha(zip), bytes: zip.length, files: [{ name: 'index.js', sha256: sha(code), bytes: code.length }] }];
  const manifest = { contract: 'successor-qualification-runtime-candidate/1', candidate: `care-${kind}`, ...metadata,
    sourceCandidateSha256: sha(releaseBytes), parentTemplateSha256: sha(parentBytes), templateSha256: sha(templateBytes), packages,
    lambdaBindings: [{ logicalId: 'Function', file: 'index.js', handler: 'index.handler', kind: 'api',
      activationKey: `CARE_${kind.toUpperCase()}_ACTIVATION`, bucketParameter: 'CodeBucket', keyParameter: 'CodeKey', versionParameter: 'CodeVersion' }],
    deploymentPerformed: false, hostedVerified: false, activationApproved: false };
  const bytes = Buffer.from(json(manifest)); writeFileSync(join(root, 'artifact-manifest.json'), bytes);
  candidates.push({ candidate: manifest.candidate, manifestSha256: sha(bytes), templateSha256: manifest.templateSha256, packages });
}
if (candidates.length !== 12 || new Set(candidates.map(c => c.candidate)).size !== 12
  || JSON.stringify(inventorySourceIdentity()) !== JSON.stringify(identity)) throw Error('successor_runtime_source_changed');
writeFileSync(join(out, 'manifest.json'), json({ contract: 'successor-qualification-runtime-build/1', ...compiled,
  sourceCandidateSha256: sha(releaseBytes), candidates, scope: 'twelve-existing-request-candidates',
  artifactSetCompleteForDeclaredScope: true, completeFleetQualified: false, targetBindingComplete: false,
  deploymentPerformed: false, hostedVerified: false, phiAllowed: false, activation: 'blocked',
  remaining: ['separate exact target and complete resource/code/ledger observer', 'additional Fullscript/telehealth/clinic route artifacts and bindings',
    'reviewed restricted credentials and grants', 'reviewed preserving schema sequence', 'hosted acceptance', 'matched mobile releases and physical devices', 'human reviews'] }));
console.log('Compiled twelve existing request candidates with the exact proposed 117 release. Target/provider/fleet qualification incomplete; no deployment or activation.');
