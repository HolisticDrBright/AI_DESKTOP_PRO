/** Source-only addition of consent and clinic-record request artifacts. This
 * does not complete the Fullscript/Zoom fleet, target observer or deployment. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inventorySourceIdentity } from './inventory-qualification-source.mjs';
import { inventoryQualificationZip } from './inventory-qualification-zip.mjs';
import { successorProviderTemplate } from './successor-qualification-provider-template.mjs';
import { successorQualificationReleaseArtifact, SUCCESSOR_QUALIFICATION_RELEASE } from './successor-qualification-release.mjs';
const args = process.argv.slice(2);
if (args.length > 1 || args.length && !/^--out-dir=.+$/.test(args[0])) throw Error('successor_provider_argument_refused');
const out = resolve(args.length ? args[0].slice(10) : 'dist/aws-clinical-core/successor-qualification-providers');
const sha = value => createHash('sha256').update(value).digest('hex'), json = value => JSON.stringify(value, null, 2) + '\n';
const execute = (script, flags = []) => execFileSync(process.execPath, ['scripts/' + script, ...flags], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true,
});
const identity = inventorySourceIdentity(), compiled = { ...identity, ...SUCCESSOR_QUALIFICATION_RELEASE };
const releaseBytes = execute('build-telehealth-transfer-authority-candidate.mjs', ['--json']);
const artifact = JSON.parse(releaseBytes), release = successorQualificationReleaseArtifact(artifact);
const shaBody = (sql, expression) => {
  const bodies = [...sql.matchAll(expression)];
  if (bodies.length !== 1) throw Error('successor_provider_function_refused');
  return sha(bodies[0][1]);
};
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'release-artifact.json'), json(release));
const candidates = [];
for (const kind of ['telehealth-consent', 'clinic-records']) {
  const directory = join(out, kind), historical = join(directory, 'historical-builder');
  execute(`build-aws-${kind}.mjs`, [`--out-dir=${historical}`]);
  const parentBytes = readFileSync(join(historical, 'template.json')), parent = JSON.parse(parentBytes);
  let metadata, factory, activationKey;
  if (kind === 'telehealth-consent') {
    const sql = artifact.files['20261010100000_production_telehealth_consent_copy.sql'];
    const functions = [...artifact.files['20261006020000_production_care_connections.sql'].matchAll(
      /create(?: or replace)? function (clinical_(?:core|private)\.[a-z_]+)\([^]*?security definer set search_path='' as \$\$([^]*?)\$\$/g)]
      .map(([, name, body]) => ({ name, bodySha256: sha(body), apiExecute: name.startsWith('clinical_core.') }));
    if (functions.length !== 7 || new Set(functions.map(f => f.name)).size !== 7
      || sha(sql) !== '5d4b361c4849b900c4c6e4f95686cf77c28797584bc9e9ec1136f38bdc325e0e') throw Error('successor_provider_sql_refused');
    metadata = { ...compiled, sqlSha256: sha(sql), functions, telehealthFunctionSha256: shaBody(sql,
      /create function clinical_core\.production_telehealth_consent_request\(_request jsonb\) returns jsonb\s+language plpgsql security definer set search_path='' as \$\$([^]*?)\$\$/g) };
    factory = 'createSuccessorTelehealthConsentHandler'; activationKey = 'TELEHEALTH_CONSENT_ACTIVATION';
    await build({ entryPoints: ['src/server/clinical-core/successor-telehealth-consent-configuration-command.ts'],
      outfile: join(directory, 'configuration-identity.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: true, legalComments: 'none' });
  } else {
    const sql = artifact.files['20261011000000_production_clinic_record_privacy.sql'];
    if (sha(sql) !== 'c326461d26c0b2c4e93083f84e4b75cced0c72d6457be16634e2df9a5852714f') throw Error('successor_provider_sql_refused');
    metadata = { ...compiled, extensionSha256: sha(sql), dispatcher: { schema: 'clinical_core', name: 'clinic_record_request',
      sha256: shaBody(sql, /create function clinical_core\.clinic_record_request\(_request jsonb\) returns jsonb\s+language plpgsql security definer set search_path='' as \$\$([^]*?)\$\$;/g) } };
    factory = 'createSuccessorClinicRecordsHandler'; activationKey = 'CLINIC_RECORDS_ACTIVATION';
  }
  // Same drift-fenced envelope as the other successor entry points. Lazy import
  // of the actual factory only after admission; re-check after await and cache.
  const contents = `import {createSuccessorQualificationEnvelope} from './src/server/clinical-core/successor-qualification-profile';\n`
    + `const build=${JSON.stringify(metadata)};export const handler=createSuccessorQualificationEnvelope(()=>process.env,build,${JSON.stringify(activationKey)},'api',async()=>{`
    + `const m=await import('./src/server/clinical-core/${kind}-deployment');return m.${factory}(process.env,build);});`;
  await build({ stdin: { contents, resolveDir: process.cwd(), sourcefile: `successor-${kind}.ts`, loader: 'ts' },
    outfile: join(directory, 'index.js'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: true, legalComments: 'none' });
  const code = readFileSync(join(directory, 'index.js')), zip = inventoryQualificationZip([{ name: 'index.js', bytes: code }]);
  const zipCodeSha256 = createHash('sha256').update(zip).digest('base64');
  const { template, bindings } = successorProviderTemplate(parent, identity, kind, zipCodeSha256);
  const templateBytes = Buffer.from(json(template));
  writeFileSync(join(directory, 'template.json'), templateBytes); writeFileSync(join(directory, 'deployment-1.zip'), zip);
  const packages = [{ bucketParameter: 'CodeBucket', keyParameter: 'CodeKey', versionParameter: 'CodeVersion', file: 'deployment-1.zip',
    sha256: sha(zip), bytes: zip.length, lambdaCodeSha256: zipCodeSha256, files: [{ name: 'index.js', sha256: sha(code), bytes: code.length }] }];
  const manifest = { contract: 'successor-qualification-provider-candidate/1', candidate: kind, ...metadata, sourceCandidateSha256: sha(releaseBytes),
    parentTemplateSha256: sha(parentBytes), templateSha256: sha(templateBytes), packages, lambdaBindings: bindings,
    ...(kind === 'telehealth-consent' ? { configurationIdentityContract: 'telehealth-consent-configuration/2',
      configurationToolSha256: sha(readFileSync(join(directory, 'configuration-identity.cjs'))) } : {}),
    immutablePublishedVersionRequired: true, deploymentPerformed: false, hostedVerified: false, activationApproved: false,
    defaults: { phiAllowed: false, activation: 'blocked', qualification: 'disabled', ...(kind === 'telehealth-consent' ? { consentEnabled: false } : {}) } };
  const bytes = Buffer.from(json(manifest)); writeFileSync(join(directory, 'artifact-manifest.json'), bytes);
  candidates.push({ candidate: kind, manifestSha256: sha(bytes), templateSha256: sha(templateBytes), packages });
}
if (JSON.stringify(inventorySourceIdentity()) !== JSON.stringify(identity)) throw Error('successor_provider_source_changed');
writeFileSync(join(out, 'manifest.json'), json({ contract: 'successor-qualification-providers-build/1', ...compiled,
  sourceCandidateSha256: sha(releaseBytes), scope: 'telehealth-consent-and-clinic-records', candidates,
  artifactSetCompleteForDeclaredScope: true, completeFleetQualified: false, targetBindingComplete: false,
  deploymentPerformed: false, hostedVerified: false, phiAllowed: false, activation: 'blocked',
  remaining: ['Fullscript and telehealth request provider artifacts', 'complete successor target/resource/code/ledger observer',
    'reviewed restricted credentials and grants', 'reviewed preserving schema execution', 'hosted acceptance', 'matched releases and devices', 'human approvals'] }));
console.log('Built two separate successor request candidates. Complete fleet and hosted qualification remain; no AWS access or activation.');
