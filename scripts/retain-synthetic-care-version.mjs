/** Retain a verified immutable Lambda version only; no traffic switch, schema change or rollback certification. */
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CARE_RELEASE as P, careSourceSnapshot, refuseCareRelease as fail} from './synthetic-care-release.mjs';
import {DEPLOYED_CARE as D} from './verify-deployed-synthetic-care.mjs';
import {observeSyntheticMemberIdentity, SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
export const CARE_VERSION_DESCRIPTION = `ALP synthetic recovery source=${D.desktop} zip=${D.zip} request-id-erasure/1 PHI=off`;
const arn = `arn:aws:lambda:${P.region}:${P.account}:function:${P.functionName}`;
const checksum = Buffer.from(D.zip, 'hex').toString('base64');
const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
export function verifyCareVersionPreflight(report, harness, now = Date.now()) {
  const age = now - Date.parse(report?.observedAt);
  if (report?.contract !== 'synthetic-care-deployed-inspection/1' || !Number.isFinite(age) || age < 0 || age > 120000
    || report.account !== P.account || report.execution !== 'synthetic-staging' || report.phiAllowed !== false
    || report.deployedSource !== D.desktop || report.deployedZip !== D.zip || report.exactObjectVersion !== D.version
    || report.exactVersionReadbackVerified !== true || report.liveIamRoleVerified !== true || report.liveLoggingVerified !== true
    || report.deployedCodeSha256 !== checksum || report.routeCount !== 51 || report.awsMutationPerformed !== false
    || report.schemaChanged !== false || report.upgradeAuthorized !== false || report.rollbackRehearsed !== false
    || report.database?.liveCount !== 46 || report.database?.sourceCount !== 45 || report.database?.tableCount !== 87
    || report.database?.liveLedger !== P.liveBefore || report.database?.referenceLedger !== P.reference
    || canonical(report.harness) !== canonical(harness) || harness.clean !== true
    || typeof report.revisionId !== 'string' || !report.revisionId) fail('version_preflight');
}
export function verifyCareVersionLatest(fn, revision) {
  const env = {CLINICAL_DATABASE_CLUSTER_ARN: P.cluster, CLINICAL_DATABASE_SECRET_ARN: P.secret, CLINICAL_DATABASE_NAME: P.database,
    CLINICAL_CONSUMER_ISSUER: `https://cognito-idp.${P.region}.amazonaws.com/${P.consumerPool}`, CLINICAL_CONSUMER_AUDIENCE: P.consumerClient,
    CLINICAL_WORKFORCE_ISSUER: `https://cognito-idp.${P.region}.amazonaws.com/${P.workforcePool}`, CLINICAL_WORKFORCE_AUDIENCE: P.workforceClient};
  if (typeof revision !== 'string' || !revision || fn?.FunctionName !== P.functionName || fn.FunctionArn !== arn || fn.Version !== '$LATEST'
    || fn.CodeSha256 !== checksum || fn.CodeSize !== D.bytes || fn.RevisionId !== revision
    || fn.State !== 'Active' || fn.LastUpdateStatus !== 'Successful' || fn.Runtime !== 'nodejs22.x'
    || fn.Handler !== 'index.handler' || fn.MemorySize !== 256 || fn.Timeout !== 29
    || canonical(fn.Architectures) !== canonical(['arm64']) || fn.Layers?.length || fn.VpcConfig?.VpcId
    || fn.PackageType !== 'Zip' || fn.FileSystemConfigs?.length || fn.ImageConfigResponse || fn.MasterArn
    || fn.CapacityProviderConfig || fn.DurableConfig || fn.TenancyConfig
    || fn.EphemeralStorage?.Size !== 512 || fn.TracingConfig?.Mode !== 'PassThrough'
    || canonical(fn.Environment?.Variables) !== canonical(env) || fn.Environment?.Error
    || canonical(fn.LoggingConfig) !== canonical({LogGroup: '/ai-clinical-core/synthetic-staging/identity-api',
      LogFormat: 'JSON', ApplicationLogLevel: 'WARN', SystemLogLevel: 'WARN'})
    || typeof fn.Role !== 'string' || !fn.Role.startsWith(`arn:aws:iam::${P.account}:role/`)) fail('version_latest');
}
const versionNumber = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
export function verifyRetainedCareVersion(version, latest) {
  if (!versionNumber(version?.Version) || version.FunctionArn !== `${arn}:${version.Version}`
    || version.FunctionName !== P.functionName || version.Description !== CARE_VERSION_DESCRIPTION
    || version.State !== 'Active' || version.LastUpdateStatus && version.LastUpdateStatus !== 'Successful') fail('retained_version');
  // Published code/config must match the independently checked latest. Every
  // executable setting, including identifiers/logging, is retained, not inferred
  // from a description or checksum alone. Version/revision/timestamps differ.
  const fields = ['CodeSha256', 'CodeSize', 'Runtime', 'Handler', 'MemorySize', 'Timeout', 'Role', 'Environment', 'Architectures',
    'Layers', 'VpcConfig', 'KMSKeyArn', 'PackageType', 'EphemeralStorage', 'TracingConfig', 'LoggingConfig', 'FileSystemConfigs',
    'DeadLetterConfig', 'SnapStart', 'ImageConfigResponse', 'MasterArn', 'SigningProfileVersionArn', 'SigningJobArn', 'RuntimeVersionConfig'];
  for (const field of fields) if (canonical(version[field]) !== canonical(latest[field])) fail('retained_version_configuration');
}
/** Injectable transport is only for credential-free failure tests, never a CLI override. */
export async function retainCareVersion(run, latest) {
  verifyCareVersionLatest(latest, latest?.RevisionId);
  const versions = [], markers = new Set(); let marker;
  for (let page = 0; page < 10; page++) {
    const response = await run(['lambda', 'list-versions-by-function', '--no-paginate', '--cli-input-json',
      JSON.stringify({FunctionName: P.functionName, MaxItems: 50, ...(marker ? {Marker: marker} : {})})]);
    if (!Array.isArray(response.Versions) || response.Versions.length > 50) fail('version_inventory');
    versions.push(...response.Versions);
    if (new Set(versions.map(v => v.Version)).size !== versions.length) fail('version_duplicates');
    marker = response.NextMarker;
    if (!marker) break;
    if (typeof marker !== 'string' || marker.length > 1024 || markers.has(marker) || page === 9) fail('version_pagination');
    markers.add(marker);
  }
  const matches = versions.filter(v => v.Version !== '$LATEST' && v.Description === CARE_VERSION_DESCRIPTION);
  if (matches.length > 1) fail('version_ambiguous');
  let published = false, selected;
  if (matches.length === 1) {
    if (!versionNumber(matches[0].Version)) fail('retained_version'); selected = matches[0].Version;
  } else {
    // Source/config optimistic guards are service-side. Unknown failure is never
    // retried: a later explicit run reconciles the actual version inventory.
    const answer = await run(['lambda', 'publish-version', '--function-name', P.functionName,
      '--code-sha256', checksum, '--revision-id', latest.RevisionId, '--description', CARE_VERSION_DESCRIPTION]);
    if (!versionNumber(answer.Version)) fail('version_publication_unknown');
    selected = answer.Version; published = true;
  }
  const version = await run(['lambda', 'get-function-configuration', '--function-name', P.functionName, '--qualifier', selected]);
  verifyRetainedCareVersion(version, latest);
  return {version: selected, functionArn: version.FunctionArn, codeSha256: version.CodeSha256,
    configurationVerified: true, newlyPublished: published};
}
function aws(args) {
  try {return JSON.parse(execFileSync('aws', [...args, '--profile', profile, '--region', P.region, '--output', 'json'],
    {encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}));}
  catch {fail('version_aws_outcome_unconfirmed');}
}
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--retain-reviewed-fictional-code-only') fail('arguments');
  const root = process.cwd(), harness = careSourceSnapshot(root, 'desktop'); observeSyntheticMemberIdentity();
  const child = file => execFileSync(process.execPath, [resolve(root, 'scripts', file),
    ...(file.startsWith('verify-') ? ['--inspect-deployed-fictional-only'] : [])],
  {encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  child('build-care-erasure-schema-upgrade.mjs');
  const report = JSON.parse(child('verify-deployed-synthetic-care.mjs')); verifyCareVersionPreflight(report, harness);
  const latest = aws(['lambda', 'get-function-configuration', '--function-name', P.functionName]);
  verifyCareVersionLatest(latest, report.revisionId);
  const unchanged = () => {if (canonical(careSourceSnapshot(root, 'desktop')) !== canonical(harness)) fail('version_source_changed');};
  unchanged(); const retained = await retainCareVersion(aws, latest); unchanged();
  const after = aws(['lambda', 'get-function-configuration', '--function-name', P.functionName]);
  // Publishing may change service bookkeeping. Code and executable settings may not change.
  verifyCareVersionLatest(after, after.RevisionId); verifyRetainedCareVersion(
    aws(['lambda', 'get-function-configuration', '--function-name', P.functionName, '--qualifier', retained.version]), after);
  const postflight = JSON.parse(child('verify-deployed-synthetic-care.mjs'));
  verifyCareVersionPreflight(postflight, harness); unchanged();
  if (postflight.templateSha256 !== report.templateSha256 || postflight.apiInventorySha256 !== report.apiInventorySha256
    || canonical(postflight.database) !== canonical(report.database)) fail('version_target_changed');
  const result = {contract: 'synthetic-care-retained-version/1', observedAt: new Date().toISOString(), harness,
    execution: 'synthetic-staging', account: P.account, source: D.desktop, zipSha256: D.zip, s3Version: D.version,
    preflight: report.report, postflight: postflight.report, ...retained, awsMutationPerformed: retained.newlyPublished,
    trafficChanged: false, apiDeploymentPerformed: false, schemaChanged: false, upgradeAuthorized: false,
    recoveryRehearsed: false, afterUpgradeVerified: false, functionalRollbackVerified: false,
    phiAllowed: false, paidMobileBuildStarted: false};
  const dir = resolve(root, 'dist/synthetic-care-retained-version', harness.commit); mkdirSync(dir, {recursive: true});
  const file = resolve(dir, `${Date.now()}.json`); writeFileSync(file, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({report: file, ...result}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(error.message?.startsWith('synthetic_care_release_refused:') ? error.message : 'synthetic_care_release_refused:version_not_verified');
  process.exitCode = 1;
});
