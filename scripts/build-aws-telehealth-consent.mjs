/** Source-only deterministic artifact. No upload, deploy, registration or approval. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { inventorySourceIdentity } from './inventory-qualification-source.mjs';
import { careMessagingZip } from './care-messaging-zip.mjs';
import { telehealthConsentTemplate } from './telehealth-consent-template.mjs';
const args = process.argv.slice(2);
if (args.length > 1 || args.length && !/^--out-dir=.+$/.test(args[0])) throw Error('telehealth_consent_build_argument_refused');
const out = resolve(args.length ? args[0].slice(10) : 'dist/aws-clinical-core/telehealth-consent');
const sha = v => createHash('sha256').update(v).digest('hex'), json = v => JSON.stringify(v, null, 2) + '\n';
const identity = inventorySourceIdentity();
const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-consent-copy-candidate.mjs', '--json'],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }));
if (artifact.candidate?.contract !== 'telehealth-consent-copy-candidate/1' || artifact.candidate.migrationCount !== 112
  || artifact.candidate.migrationReleaseSha256 !== '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4'
  || artifact.releaseHash !== '6cc191355442ae2c2349cab50466979eaab0e45961a4e1547f34785294dce4b9'
  || artifact.candidate.extensionSha256 !== '5d4b361c4849b900c4c6e4f95686cf77c28797584bc9e9ec1136f38bdc325e0e'
  || artifact.candidate.activation !== 'blocked' || artifact.candidate.phiAllowed !== false) throw Error('telehealth_consent_build_artifact_refused');
const functions = [...artifact.files['20261006020000_production_care_connections.sql'].matchAll(/create(?: or replace)? function (clinical_(?:core|private))\.([a-z_]+)\([^]*?security definer set search_path='' as \$\$([^]*?)\$\$/g)]
  .map(([, schema, name, body]) => ({ name: `${schema}.${name}`, bodySha256: sha(body), apiExecute: schema === 'clinical_core' }));
const extension = artifact.files['20261010100000_production_telehealth_consent_copy.sql'];
const body = [...extension.matchAll(/create function clinical_core\.production_telehealth_consent_request\(_request jsonb\) returns jsonb\s+language plpgsql security definer set search_path='' as \$\$([^]*?)\$\$/g)];
if (functions.length !== 7 || new Set(functions.map(f => f.name)).size !== 7 || body.length !== 1) throw Error('telehealth_consent_build_functions_refused');
const compiled = { ...identity, migrationCount: 112, migrationReleaseSha256: artifact.candidate.migrationReleaseSha256,
  assemblySha256: artifact.releaseHash, sqlSha256: sha(extension), functions, telehealthFunctionSha256: sha(body[0][1]) };
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['src/server/clinical-core/telehealth-consent-lambda.ts'], outfile: join(out, 'index.js'), bundle: true,
  platform: 'node', target: 'node22', format: 'cjs', minify: true, legalComments: 'none',
  define: { __TELEHEALTH_CONSENT_BUILD__: JSON.stringify(compiled) } });
await build({ entryPoints: ['src/server/clinical-core/telehealth-consent-configuration-command.ts'],
  outfile: join(out, 'configuration-identity.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  minify: true, legalComments: 'none' });
const code = readFileSync(join(out, 'index.js')), zip = careMessagingZip(code), codeSha256 = createHash('sha256').update(zip).digest('base64');
const template = Buffer.from(json(telehealthConsentTemplate(compiled, codeSha256)));
if (JSON.stringify(inventorySourceIdentity()) !== JSON.stringify(identity)) throw Error('telehealth_consent_build_source_changed');
writeFileSync(join(out, 'deployment.zip'), zip); writeFileSync(join(out, 'template.json'), template);
writeFileSync(join(out, 'artifact-manifest.json'), json({ contract: 'telehealth-consent-deployment/1', ...compiled,
  handler: 'index.handler', codeSha256: sha(code), deploymentZipSha256: sha(zip), deploymentZipBytes: zip.length,
  configurationToolSha256: sha(readFileSync(join(out, 'configuration-identity.cjs'))),
  lambdaCodeSha256: codeSha256, templateSha256: sha(template), immutablePublishedVersionRequired: true,
  configurationIdentityRequired: true, defaults: { phiAllowed: false, activation: 'blocked', qualification: 'disabled', consentEnabled: false },
  deploymentPerformed: false, hostedVerified: false, activationApproved: false, seededApprovals: false, seededConsents: false,
  remaining: ['preserving 111-to-112 migration operator and rollback custody', 'exact 112 consent-copy registrar mapping',
    'independent reviews and clean matched source/configuration', 'hosted target/ledger/version binding and provider races', 'physical patient/host acceptance'] }));
console.log('Built separate 112 telehealth consent Lambda/template: source bound, default blocked. No AWS access or activation.');
