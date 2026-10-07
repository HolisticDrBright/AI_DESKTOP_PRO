/** Read-only verification of the reviewed deployed successor. Does not authorize upgrade or recovery. */
import {execFileSync} from 'node:child_process';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {S3Client, HeadObjectCommand, GetObjectCommand} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P, sha256, careSourceSnapshot, careReleaseZip, buildCareIdentityBundle,
  normalizedText, refuseCareRelease as fail} from './synthetic-care-release.mjs';
import {verifyCareObservation} from './prepare-synthetic-care-release.mjs';
import {verifyCareStoredArtifact, readCareArtifact} from './upload-synthetic-care-release.mjs';
import {observeSyntheticMemberIdentity, SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
export const DEPLOYED_CARE = Object.freeze({
  desktop: '5b6f8aa45347d33757ac9bfb34658e2e09daefd3', mobile: '11197e527a1ffc9317513837087e347531076957',
  zip: '644967eec4241c19f2365aabc7cec304f200f95622c8ef3a0188f57633dd64db',
  version: 'hruo6Qx4lq5maqBp.E_Kp.x1utrFXFPh', bytes: 1818387,
});
const canonical = v => JSON.stringify(v, (_k, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
export function verifyDeployedCareArtifact(manifest, release, bundle, zip) {
  if (manifest?.contract !== P.contract || manifest.desktop?.commit !== DEPLOYED_CARE.desktop
    || manifest.mobile?.source?.commit !== DEPLOYED_CARE.mobile || manifest.zipSha256 !== DEPLOYED_CARE.zip
    || manifest.zipBytes !== DEPLOYED_CARE.bytes || zip.length !== DEPLOYED_CARE.bytes || sha256(zip) !== DEPLOYED_CARE.zip
    || manifest.key !== `clinical-core/authenticated-api/care-release/${DEPLOYED_CARE.desktop}/${DEPLOYED_CARE.zip}.zip`
    || manifest.bundleSha256 !== sha256(bundle) || !zip.equals(careReleaseZip(bundle, release))) fail('deployed_artifact');
  const {zipSha256: _sha, zipBytes: _bytes, key: _key, ...embedded} = manifest;
  if (canonical(embedded) !== canonical(release)) fail('deployed_manifest');
}
export function verifyDeployedCareObservation(observation, source, manifest, harness) {
  if (sha256(canonical(observation.template)) !== sha256(canonical(sourceWithVersion(source)))) fail('deployed_template');
  const params = observation.stack?.Stacks?.[0]?.Parameters;
  if (params?.filter(p => p.ParameterKey === 'LambdaCodeKey' && p.ParameterValue === manifest.key).length !== 1
    || observation.fn?.CodeSha256 !== Buffer.from(DEPLOYED_CARE.zip, 'hex').toString('base64')
    || observation.database?.operatorSource?.sourceCommit !== harness.commit || harness.clean !== true) fail('deployed_binding');
  // Reuse the unchanged authority/history verifier, normalizing ONLY the three
  // separately verified deployment differences back to its historical baseline.
  // No source, IAM, environment, route, identity or database check is bypassed.
  const historical = structuredClone(observation);
  historical.template.Outputs.RoutesEnabled.Value = '32';
  delete historical.template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion;
  historical.stack.Stacks[0].Parameters.find(p => p.ParameterKey === 'LambdaCodeKey').ParameterValue = `clinical-core/authenticated-api/${P.previousZipSha256}.zip`;
  historical.fn.CodeSha256 = Buffer.from(P.previousZipSha256, 'hex').toString('base64');
  const checked = verifyCareObservation(historical, source, {desktop: {commit: harness.commit}, key: manifest.key});
  verifyDeployedCareRole(observation, source);
  return {...checked.observed, deployedCodeSha256: observation.fn.CodeSha256,
    templateSha256: sha256(canonical(observation.template)), exactObjectVersion: DEPLOYED_CARE.version};
}
export function verifyDeployedCareRole(o, source) {
  const expectedLog = source.Resources.IdentityApiLogGroup.Properties;
  const roles = o.resources?.StackResources?.filter(r => r.LogicalResourceId === 'IdentityApiRole');
  const logs = o.resources?.StackResources?.filter(r => r.LogicalResourceId === 'IdentityApiLogGroup');
  if (roles?.length !== 1 || logs?.length !== 1 || roles[0].ResourceType !== 'AWS::IAM::Role'
    || logs[0].ResourceType !== 'AWS::Logs::LogGroup' || logs[0].PhysicalResourceId !== expectedLog.LogGroupName
    || !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(roles[0].ResourceStatus)
    || !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(logs[0].ResourceStatus)) fail('deployed_role_resources');
  const role = o.role?.Role, roleArn = `arn:aws:iam::${P.account}:role/${roles[0].PhysicalResourceId}`;
  if (role?.RoleName !== roles[0].PhysicalResourceId || role.Arn !== roleArn || o.fn.Role !== roleArn
    || role.PermissionsBoundary || canonical(role.AssumeRolePolicyDocument) !== canonical(source.Resources.IdentityApiRole.Properties.AssumeRolePolicyDocument)
    || o.attached?.IsTruncated !== false || o.attached.AttachedPolicies?.length !== 0
    || o.inline?.IsTruncated !== false) fail('deployed_role_authority');
  const expected = source.Resources.IdentityApiRole.Properties.Policies;
  if (canonical([...(o.inline.PolicyNames ?? [])].sort()) !== canonical(expected.map(p => p.PolicyName).sort())
    || o.policies?.length !== expected.length || new Set(o.policies.map(p => p.PolicyName)).size !== expected.length) fail('deployed_policy_set');
  const resolveBinding = v => {
    if (Array.isArray(v)) return v.map(resolveBinding);
    if (!v || typeof v !== 'object') return v;
    if ('Ref' in v) return {DatabaseClusterArn: P.cluster, DatabaseSecretArn: P.secret, ClinicalCoreKeyArn: P.keyArn}[v.Ref] ?? fail('deployed_policy_ref');
    if ('Fn::Sub' in v) {
      if (v['Fn::Sub'] !== 'secretsmanager.${AWS::Region}.${AWS::URLSuffix}') fail('deployed_policy_sub');
      return `secretsmanager.${P.region}.amazonaws.com`;
    }
    if ('Fn::GetAtt' in v) {
      if (canonical(v['Fn::GetAtt']) !== canonical(['IdentityApiLogGroup', 'Arn'])) fail('deployed_policy_getatt');
      return `arn:aws:logs:${P.region}:${P.account}:log-group:${expectedLog.LogGroupName}:*`;
    }
    return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, resolveBinding(value)]));
  };
  for (const policy of expected) {
    const actual = o.policies.find(p => p.PolicyName === policy.PolicyName);
    if (actual?.RoleName !== role.RoleName || canonical(actual.PolicyDocument) !== canonical(resolveBinding(policy.PolicyDocument))) fail('deployed_policy');
  }
  const groups = o.logGroups?.logGroups?.filter(g => g.logGroupName === expectedLog.LogGroupName);
  if (groups?.length !== 1 || groups[0].retentionInDays !== expectedLog.RetentionInDays || groups[0].kmsKeyId !== P.keyArn) fail('deployed_logs');
}
function sourceWithVersion(source) {
  const expected = structuredClone(source);
  for (const name of P.absentRoutes) delete expected.Resources[name];
  expected.Outputs.RoutesEnabled.Value = '51';
  expected.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion = DEPLOYED_CARE.version;
  return expected;
}
function aws(args) {
  try {return JSON.parse(execFileSync('aws', [...args, '--profile', profile, '--region', P.region, '--output', 'json'],
    {encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}));}
  catch {fail('deployed_aws_observation');}
}
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--inspect-deployed-fictional-only') fail('arguments');
  const root = process.cwd(), harness = careSourceSnapshot(root, 'desktop');
  const dir = resolve(root, 'dist/synthetic-care-release', DEPLOYED_CARE.desktop, DEPLOYED_CARE.mobile);
  const manifest = JSON.parse(readFileSync(resolve(dir, 'artifact-manifest.json'), 'utf8'));
  const release = JSON.parse(readFileSync(resolve(dir, 'release.json'), 'utf8'));
  const bundle = readFileSync(resolve(dir, 'index.js')), zip = readFileSync(resolve(dir, 'candidate.zip'));
  verifyDeployedCareArtifact(manifest, release, bundle, zip);
  if (!(await buildCareIdentityBundle(root)).equals(bundle)) fail('deployed_source_changed');
  const operatorDir = resolve(root, 'dist/aws-clinical-core/care-erasure-schema-upgrade');
  const operator = JSON.parse(readFileSync(resolve(operatorDir, 'artifact-manifest.json'), 'utf8'));
  if (operator.contract !== 'care-erasure-schema-upgrade-build/1' || operator.sourceCommit !== harness.commit
    || operator.clean !== true || operator.execution !== 'synthetic-staging' || operator.phiAllowed !== false
    || operator.migrationPerformed !== false || operator.sourceMigrationCount !== 46
    || operator.sha256 !== sha256(readFileSync(resolve(operatorDir, 'index.cjs')))) fail('inspect_operator_binding');
  const caller = observeSyntheticMemberIdentity();
  const client = new S3Client({region: P.region, credentials: fromIni({profile}), maxAttempts: 1});
  try {
    const request = {Bucket: P.bucket, ExpectedBucketOwner: P.account, Key: manifest.key,
      VersionId: DEPLOYED_CARE.version, ChecksumMode: 'ENABLED'};
    verifyCareStoredArtifact(await client.send(new HeadObjectCommand(request), {abortSignal: AbortSignal.timeout(30000)}), manifest, DEPLOYED_CARE.version);
    const signal = AbortSignal.timeout(30000), remote = await client.send(new GetObjectCommand(request), {abortSignal: signal});
    try {verifyCareStoredArtifact(remote, manifest, DEPLOYED_CARE.version);} catch (error) {remote.Body?.destroy?.(); throw error;}
    if (!(await readCareArtifact(remote.Body, manifest, signal)).equals(zip)) fail('deployed_readback');
    const foundation = aws(['cloudformation', 'describe-stacks', '--stack-name', P.foundation]);
    const stack = aws(['cloudformation', 'describe-stacks', '--stack-name', P.stack]);
    const raw = aws(['cloudformation', 'get-template', '--stack-name', P.stack]).TemplateBody;
    const template = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const fn = aws(['lambda', 'get-function-configuration', '--function-name', P.functionName]);
    const integrations = aws(['apigatewayv2', 'get-integrations', '--api-id', P.apiId]);
    const routes = aws(['apigatewayv2', 'get-routes', '--api-id', P.apiId]);
    const authorizers = aws(['apigatewayv2', 'get-authorizers', '--api-id', P.apiId]);
    const resources = aws(['cloudformation', 'describe-stack-resources', '--stack-name', P.stack]);
    const roleName = resources.StackResources?.find(r => r.LogicalResourceId === 'IdentityApiRole')?.PhysicalResourceId;
    if (typeof roleName !== 'string' || !/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(roleName)) fail('deployed_role_name');
    const role = aws(['iam', 'get-role', '--role-name', roleName]);
    // AWS CLI's paginator strips IsTruncated. Inspect one bounded service page
    // instead, and refuse a truncated response rather than assuming completeness.
    const attached = aws(['iam', 'list-attached-role-policies', '--role-name', roleName, '--no-paginate']);
    const inline = aws(['iam', 'list-role-policies', '--role-name', roleName, '--no-paginate']);
    const policies = ['AuroraDataApiTransactionOnly', 'ManagedDatabaseCredentialRead', 'BoundedFunctionLogging']
      .map(name => aws(['iam', 'get-role-policy', '--role-name', roleName, '--policy-name', name]));
    const logGroups = aws(['logs', 'describe-log-groups', '--log-group-name-prefix', '/ai-clinical-core/synthetic-staging/identity-api']);
    const database = JSON.parse(execFileSync(process.execPath, [resolve(operatorDir, 'index.cjs'), 'inspect'],
      {encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}));
    const observed = verifyDeployedCareObservation({caller, foundation, stack, template, fn, integrations, routes, authorizers, database,
      resources, role, attached, inline, policies, logGroups},
      JSON.parse(normalizedText(root, 'infra/aws-clinical-core/identity-api-extension.json')), manifest, harness);
    if (aws(['lambda', 'get-function-configuration', '--function-name', P.functionName]).RevisionId !== fn.RevisionId
      || canonical(aws(['apigatewayv2', 'get-routes', '--api-id', P.apiId])) !== canonical(routes)
      || canonical(aws(['apigatewayv2', 'get-authorizers', '--api-id', P.apiId])) !== canonical(authorizers)
      || canonical(careSourceSnapshot(root, 'desktop')) !== canonical(harness)) fail('deployed_state_changed');
    verifyDeployedCareRole({fn, resources, role: aws(['iam', 'get-role', '--role-name', roleName]),
      attached: aws(['iam', 'list-attached-role-policies', '--role-name', roleName, '--no-paginate']),
      inline: aws(['iam', 'list-role-policies', '--role-name', roleName, '--no-paginate']),
      policies: policies.map(p => aws(['iam', 'get-role-policy', '--role-name', roleName, '--policy-name', p.PolicyName])),
      logGroups: aws(['logs', 'describe-log-groups', '--log-group-name-prefix', '/ai-clinical-core/synthetic-staging/identity-api'])},
    JSON.parse(normalizedText(root, 'infra/aws-clinical-core/identity-api-extension.json')));
    const report = {contract: 'synthetic-care-deployed-inspection/1', observedAt: new Date().toISOString(), harness,
      execution: 'synthetic-staging', account: P.account, deployedSource: DEPLOYED_CARE.desktop,
      deployedZip: DEPLOYED_CARE.zip, exactVersionReadbackVerified: true, ...observed,
      liveIamRoleVerified: true, liveLoggingVerified: true,
      database: {liveCount: database.observedMigrationCount, sourceCount: database.sourceMigrationCount,
        tableCount: database.tableCount, rows: database.rowCount, dataSha256: database.dataSha256,
        liveLedger: database.fromLedgerSha256, referenceLedger: database.referenceLedgerSha256},
      awsMutationPerformed: false, schemaChanged: false, upgradeAuthorized: false,
      rollbackRehearsed: false, journeyAcceptance: false, phiAllowed: false, paidMobileBuildStarted: false};
    const out = resolve('dist/synthetic-care-deployed', harness.commit); mkdirSync(out, {recursive: true});
    const file = resolve(out, `${Date.now()}.json`); writeFileSync(file, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
    console.log(JSON.stringify({report: file, ...report}));
  } finally {client.destroy();}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(error.message?.startsWith('synthetic_care_release_refused:') ? error.message : 'synthetic_care_release_refused:deployed_inspection');
  process.exitCode = 1;
});
