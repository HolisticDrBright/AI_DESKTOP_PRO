/** Read-only AWS preparation. Never uploads, creates or executes a change set. */
import {execFileSync} from 'node:child_process';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CARE_RELEASE as P, careSourceSnapshot, careMobileBinding, careMigrationBinding,
  normalizedText, sha256, careReleaseZip, buildCareIdentityBundle, refuseCareRelease as fail} from './synthetic-care-release.mjs';
import {assertSyntheticMemberIdentity, SYNTHETIC_MEMBER_PROFILE} from './synthetic-aws-principal.mjs';

const canonical = v => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
const entries = (rows, key, value) => {
  if (!Array.isArray(rows) || rows.some(r => typeof r?.[key] !== 'string' || typeof r?.[value] !== 'string')
    || new Set(rows.map(r => r[key])).size !== rows.length) fail('duplicate_or_missing_binding');
  return Object.fromEntries(rows.map(r => [r[key], r[value]]));
};
const settled = s => ['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(s?.StackStatus);
export function verifyCareCandidate(manifest, release, bundle, zip, current) {
  if (manifest?.contract !== P.contract || release?.contract !== P.contract
    || manifest.execution !== 'synthetic-staging' || manifest.phiAllowed !== false
    || manifest.deployed !== false || manifest.acceptance !== false || manifest.phiActivation !== false
    || manifest.legacyErasureAdmission !== false || manifest.erasureProtocol !== 'request-id-receipt-settlement/1'
    || manifest.mobile?.built !== false || manifest.mobile?.deviceVerified !== false
    || canonical(manifest.desktop) !== canonical(current.desktop) || canonical(manifest.mobile) !== canonical(current.mobile)
    || canonical(manifest.migrations) !== canonical(current.migrations) || manifest.templateSha256 !== current.templateSha256
    || canonical(manifest.rollback) !== canonical({databaseDownMigrationAllowed: false, previousApiAllowedAfterUpgrade: false,
      successorCompatibleReForwardRequired: true, rehearsed: false})) fail('candidate_binding');
  const {zipSha256, zipBytes, key, ...embedded} = manifest;
  if (canonical(embedded) !== canonical(release) || manifest.bundleSha256 !== sha256(bundle)
    || zipSha256 !== sha256(zip) || zipBytes !== zip.length || !zip.equals(careReleaseZip(bundle, release))
    || key !== `clinical-core/authenticated-api/care-release/${manifest.desktop.commit}/${zipSha256}.zip`) fail('candidate_bytes');
}
export function verifyCareObservation(o, source, manifest) {
  assertSyntheticMemberIdentity(o.caller);
  const foundation = o.foundation?.Stacks?.[0], stack = o.stack?.Stacks?.[0];
  if (o.foundation?.Stacks?.length !== 1 || !settled(foundation)
    || !foundation.StackId?.startsWith(`arn:aws:cloudformation:${P.region}:${P.account}:stack/${P.foundation}/`)
    || o.stack?.Stacks?.length !== 1 || !settled(stack)
    || !stack.StackId?.startsWith(`arn:aws:cloudformation:${P.region}:${P.account}:stack/${P.stack}/`)) fail('stack');
  const output = entries(foundation.Outputs, 'OutputKey', 'OutputValue');
  for (const [key, value] of Object.entries({PhiAllowed: 'false', Environment: 'synthetic-staging', DataClassification: 'synthetic_only',
    DatabaseName: P.database, ClinicalApiId: P.apiId, DatabaseClusterArn: P.cluster, DatabaseSecretArn: P.secret})) {
    if (output[key] !== value) fail('foundation');
  }
  const params = entries(stack.Parameters, 'ParameterKey', 'ParameterValue');
  const expected = {ClinicalApiId: P.apiId, DatabaseName: P.database, DatabaseClusterArn: P.cluster,
    DatabaseSecretArn: '****', ConsumerUserPoolId: P.consumerPool, ConsumerUserPoolClientId: P.consumerClient,
    WorkforceUserPoolId: P.workforcePool, WorkforceUserPoolClientId: P.workforceClient,
    ClinicalCoreKeyArn: P.keyArn, LambdaCodeBucket: P.bucket,
    LambdaCodeKey: `clinical-core/authenticated-api/${P.previousZipSha256}.zip`};
  if (canonical(params) !== canonical(expected)) fail('stack_parameters');
  // Verify all live resources, IAM, authorizers and environment declarations.
  // Keep the existing 51 routes, not the 55 in the source template.
  const baseline = structuredClone(source);
  for (const name of P.absentRoutes) {
    if (!baseline.Resources?.[name]) fail('source_routes'); delete baseline.Resources[name];
  }
  baseline.Outputs.RoutesEnabled.Value = '32'; // observed historical annotation, not the actual count
  if (canonical(o.template) !== canonical(baseline)) fail('template_drift');
  const fn = o.fn, variables = fn?.Environment?.Variables;
  const env = {CLINICAL_DATABASE_CLUSTER_ARN: P.cluster, CLINICAL_DATABASE_SECRET_ARN: P.secret, CLINICAL_DATABASE_NAME: P.database,
    CLINICAL_CONSUMER_ISSUER: `https://cognito-idp.${P.region}.amazonaws.com/${P.consumerPool}`,
    CLINICAL_CONSUMER_AUDIENCE: P.consumerClient,
    CLINICAL_WORKFORCE_ISSUER: `https://cognito-idp.${P.region}.amazonaws.com/${P.workforcePool}`,
    CLINICAL_WORKFORCE_AUDIENCE: P.workforceClient};
  if (fn?.FunctionName !== P.functionName || fn.FunctionArn !== `arn:aws:lambda:${P.region}:${P.account}:function:${P.functionName}`
    || fn.CodeSha256 !== Buffer.from(P.previousZipSha256, 'hex').toString('base64') || fn.State !== 'Active'
    || fn.LastUpdateStatus !== 'Successful' || fn.Runtime !== 'nodejs22.x' || fn.Handler !== 'index.handler'
    || fn.Timeout !== 29 || fn.MemorySize !== 256 || canonical(fn.Architectures) !== canonical(['arm64'])
    || fn.Layers?.length || fn.VpcConfig?.VpcId || canonical(variables) !== canonical(env)
    || typeof fn.RevisionId !== 'string' || !fn.RevisionId) fail('function_drift');
  const integration = o.integrations?.Items?.filter(i => i.IntegrationUri === fn.FunctionArn);
  if (integration?.length !== 1 || integration[0].TimeoutInMillis !== 30000
    || integration[0].IntegrationType !== 'AWS_PROXY' || integration[0].PayloadFormatVersion !== '2.0') fail('integration');
  const routes = o.routes?.Items;
  if (!Array.isArray(routes) || new Set(routes.map(r => r.RouteKey)).size !== routes.length) fail('route_duplicates');
  const liveRoutes = routes.filter(r => r.Target === `integrations/${integration[0].IntegrationId}`);
  const templateRoutes = Object.values(baseline.Resources).filter(r => r.Type === 'AWS::ApiGatewayV2::Route');
  if (liveRoutes.length !== 51 || templateRoutes.length !== 51) fail('route_count');
  for (const expectedRoute of templateRoutes) {
    const prop = expectedRoute.Properties, route = liveRoutes.find(r => r.RouteKey === prop.RouteKey);
    const pool = prop.AuthorizerId?.Ref === 'ConsumerJwtAuthorizer' ? [P.consumerPool, P.consumerClient]
      : prop.AuthorizerId?.Ref === 'WorkforceJwtAuthorizer' ? [P.workforcePool, P.workforceClient] : fail('source_authorizer');
    const auth = o.authorizers?.Items?.find(a => a.AuthorizerId === route?.AuthorizerId);
    if (route?.AuthorizationType !== 'JWT' || auth?.AuthorizerType !== 'JWT'
      || canonical(auth.IdentitySource) !== canonical(['$request.header.Authorization'])
      || auth.JwtConfiguration?.Issuer !== `https://cognito-idp.${P.region}.amazonaws.com/${pool[0]}`
      || canonical(auth.JwtConfiguration?.Audience) !== canonical([pool[1]])) fail('route_authority');
  }
  const db = o.database;
  if (db?.contract !== 'care-erasure-schema-upgrade/1' || db.command !== 'inspect'
    || db.operatorSource?.sourceCommit !== manifest.desktop.commit || db.operatorSource.clean !== true
    || db.awsAccountId !== P.account || db.foundation !== P.foundation || db.execution !== 'synthetic-staging'
    || db.phiAllowed !== false || db.observedMigrationCount !== 46 || db.sourceMigrationCount !== 45
    || db.tableCount !== 87 || db.fromLedgerSha256 !== P.liveBefore || db.toLedgerSha256 !== P.liveAfter
    || db.referenceLedgerSha256 !== P.reference || db.dataPreserved !== true || db.applied !== false
    || db.alreadyApplied !== false || db.acceptance !== false || db.phiActivation !== false || db.apiDeploymentPerformed !== false
    || !/^[a-f0-9]{64}$/.test(db.dataSha256) || !Number.isSafeInteger(db.rowCount) || db.rowCount < 0) fail('database');
  const candidate = structuredClone(o.template);
  candidate.Outputs.RoutesEnabled.Value = '51'; // fix reporting, do not add the four undeployed routes
  return {template: candidate, parameters: stack.Parameters.map(p => p.ParameterKey === 'LambdaCodeKey'
    ? {ParameterKey: p.ParameterKey, ParameterValue: manifest.key} : {ParameterKey: p.ParameterKey, UsePreviousValue: true}),
    observed: {account: P.account, stackId: stack.StackId, previousCodeSha256: fn.CodeSha256, revisionId: fn.RevisionId,
      templateSha256: sha256(canonical(o.template)), routeCount: liveRoutes.length,
      apiInventorySha256: sha256(canonical(routes)), databaseRows: db.rowCount, databaseDataSha256: db.dataSha256}};
}
function aws(args) {
  try {return JSON.parse(execFileSync('aws', [...args, '--profile', SYNTHETIC_MEMBER_PROFILE, '--region', P.region, '--output', 'json'],
    {encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}));}
  catch {fail('aws_observation');}
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 5 || args[0] !== '--v2-root' || args[2] !== '--candidate' || args[4] !== '--prepare-fictional-only'
    || args[1].startsWith('--') || args[3].startsWith('--')) fail('arguments');
  const root = process.cwd(), mobileRoot = resolve(args[1]), dir = resolve(args[3]);
  const current = {desktop: careSourceSnapshot(root, 'desktop'), mobile: careMobileBinding(mobileRoot, root),
    migrations: careMigrationBinding(root), templateSha256: sha256(normalizedText(root, 'infra/aws-clinical-core/identity-api-extension.json'))};
  const manifest = JSON.parse(readFileSync(resolve(dir, 'artifact-manifest.json'), 'utf8'));
  verifyCareCandidate(manifest, JSON.parse(readFileSync(resolve(dir, 'release.json'), 'utf8')),
    readFileSync(resolve(dir, 'index.js')), readFileSync(resolve(dir, 'candidate.zip')), current);
  // Hashes in a file are assertions. Rebuild the actual current source before
  // making any AWS request; a rehashed replacement bundle is not that source.
  if (!(await buildCareIdentityBundle(root)).equals(readFileSync(resolve(dir, 'index.js')))) fail('rebuilt_bundle_mismatch');
  const operatorDir = resolve(root, 'dist/aws-clinical-core/care-erasure-schema-upgrade');
  const operatorManifest = JSON.parse(readFileSync(resolve(operatorDir, 'artifact-manifest.json'), 'utf8'));
  if (operatorManifest.contract !== 'care-erasure-schema-upgrade-build/1' || operatorManifest.sourceCommit !== current.desktop.commit
    || operatorManifest.clean !== true || operatorManifest.execution !== 'synthetic-staging' || operatorManifest.phiAllowed !== false
    || operatorManifest.migrationPerformed !== false || operatorManifest.sourceMigrationCount !== 46
    || operatorManifest.sha256 !== sha256(readFileSync(resolve(operatorDir, 'index.cjs')))) fail('inspect_operator_binding');
  const caller = aws(['sts', 'get-caller-identity']); assertSyntheticMemberIdentity(caller);
  const foundation = aws(['cloudformation', 'describe-stacks', '--stack-name', P.foundation]);
  const stack = aws(['cloudformation', 'describe-stacks', '--stack-name', P.stack]);
  const raw = aws(['cloudformation', 'get-template', '--stack-name', P.stack]).TemplateBody;
  const template = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const fn = aws(['lambda', 'get-function-configuration', '--function-name', P.functionName]);
  const integrations = aws(['apigatewayv2', 'get-integrations', '--api-id', P.apiId]);
  const routes = aws(['apigatewayv2', 'get-routes', '--api-id', P.apiId]);
  const authorizers = aws(['apigatewayv2', 'get-authorizers', '--api-id', P.apiId]);
  const database = JSON.parse(execFileSync(process.execPath, [resolve(root, 'dist/aws-clinical-core/care-erasure-schema-upgrade/index.cjs'), 'inspect'],
    {encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}));
  const prepared = verifyCareObservation({caller, foundation, stack, template, fn, integrations, routes, authorizers, database},
    JSON.parse(normalizedText(root, 'infra/aws-clinical-core/identity-api-extension.json')), manifest);
  // Recheck sources after network and database waits. The live observation is time-bound,
  // not a permission to execute later without another observation.
  if (canonical(current.desktop) !== canonical(careSourceSnapshot(root, 'desktop'))
    || canonical(current.mobile) !== canonical(careMobileBinding(mobileRoot, root))) fail('source_changed');
  const plan = {contract: 'synthetic-care-release-preparation/1', observedAt: new Date().toISOString(),
    candidateZipSha256: manifest.zipSha256, desktop: current.desktop, mobile: current.mobile,
    ...prepared.observed, databaseDownMigrationAllowed: false, previousApiAllowedAfterUpgrade: false,
    rollbackRehearsed: false, awsMutationPerformed: false, candidateUploaded: false, changeSetCreated: false,
    deployed: false, hostedAcceptance: false, phiAllowed: false, paidMobileBuildStarted: false,
    next: ['Upload and independently verify this exact ZIP; re-observe the fixed target before a Lambda-only change set.',
      'Deploy the request-ID-aware API before the schema change; verify safe legacy refusal and unaffected routes.',
      'Rehearse an explicit schema-compatible API recovery before lasting schema upgrade. Never restore the old ID-less API after live 47.',
      'Complete matched native builds only after authorization; prove journals, restart, second-device reconciliation and account isolation.']};
  const out = resolve(dir, 'preparation', sha256(canonical(plan))); mkdirSync(out, {recursive: true});
  for (const [name, data] of [['template.json', prepared.template], ['parameters.json', prepared.parameters], ['preparation.json', plan]])
    writeFileSync(resolve(out, name), JSON.stringify(data, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({directory: out, ...plan}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {console.error(error.message?.startsWith('synthetic_care_release_refused:') ? error.message : 'synthetic_care_release_refused:preparation'); process.exitCode = 1;});
}
