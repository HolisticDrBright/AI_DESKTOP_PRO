import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {CARE_RELEASE as P, sha256, careReleaseZip, careSourceSnapshot, careMigrationBinding} from './synthetic-care-release.mjs';
import {verifyCareCandidate, verifyCareObservation} from './prepare-synthetic-care-release.mjs';
const source = JSON.parse(readFileSync(new URL('../infra/aws-clinical-core/identity-api-extension.json', import.meta.url), 'utf8'));
const clone = structuredClone;
function candidate() {
  const snapshot = {commit: 'a'.repeat(40), clean: true, files: 2, sha256: 'b'.repeat(64)};
  const current = {desktop: snapshot, mobile: {source: {...snapshot, commit: 'c'.repeat(40)}, built: false, deviceVerified: false},
    migrations: careMigrationBinding(process.cwd()), templateSha256: sha256(JSON.stringify(source))};
  const bundle = Buffer.from('exports.handler = async () => ({statusCode:403});\n');
  const release = {contract: P.contract, execution: 'synthetic-staging', phiAllowed: false, ...current,
    bundleSha256: sha256(bundle), erasureProtocol: 'request-id-receipt-settlement/1', legacyErasureAdmission: false,
    rollback: {databaseDownMigrationAllowed: false, previousApiAllowedAfterUpgrade: false,
      successorCompatibleReForwardRequired: true, rehearsed: false}, deployed: false, acceptance: false, phiActivation: false};
  const zip = careReleaseZip(bundle, release), zipSha256 = sha256(zip);
  const manifest = {...release, zipSha256, zipBytes: zip.length,
    key: `clinical-core/authenticated-api/care-release/${snapshot.commit}/${zipSha256}.zip`};
  return {current, bundle, release, zip, manifest};
}
function observation() {
  const template = clone(source); for (const name of P.absentRoutes) delete template.Resources[name];
  template.Outputs.RoutesEnabled.Value = '32';
  const params = {ClinicalApiId: P.apiId, DatabaseName: P.database, DatabaseClusterArn: P.cluster, DatabaseSecretArn: '****',
    ConsumerUserPoolId: P.consumerPool, ConsumerUserPoolClientId: P.consumerClient, WorkforceUserPoolId: P.workforcePool,
    WorkforceUserPoolClientId: P.workforceClient, ClinicalCoreKeyArn: P.keyArn, LambdaCodeBucket: P.bucket,
    LambdaCodeKey: `clinical-core/authenticated-api/${P.previousZipSha256}.zip`};
  const outputs = {PhiAllowed: 'false', Environment: 'synthetic-staging', DataClassification: 'synthetic_only',
    DatabaseName: P.database, ClinicalApiId: P.apiId, DatabaseClusterArn: P.cluster, DatabaseSecretArn: P.secret};
  const fn = {FunctionName: P.functionName, FunctionArn: `arn:aws:lambda:${P.region}:${P.account}:function:${P.functionName}`,
    CodeSha256: Buffer.from(P.previousZipSha256, 'hex').toString('base64'), State: 'Active', LastUpdateStatus: 'Successful',
    Runtime: 'nodejs22.x', Handler: 'index.handler', Timeout: 29, MemorySize: 256, Architectures: ['arm64'], RevisionId: 'observed-revision',
    Environment: {Variables: {CLINICAL_DATABASE_CLUSTER_ARN: P.cluster, CLINICAL_DATABASE_SECRET_ARN: P.secret,
      CLINICAL_DATABASE_NAME: P.database, CLINICAL_CONSUMER_ISSUER: `https://cognito-idp.${P.region}.amazonaws.com/${P.consumerPool}`,
      CLINICAL_CONSUMER_AUDIENCE: P.consumerClient, CLINICAL_WORKFORCE_ISSUER: `https://cognito-idp.${P.region}.amazonaws.com/${P.workforcePool}`,
      CLINICAL_WORKFORCE_AUDIENCE: P.workforceClient}}};
  const authorizers = {Items: [[P.consumerPool, P.consumerClient, 'consumer'], [P.workforcePool, P.workforceClient, 'workforce']].map(([pool, client, name]) => ({
    AuthorizerId: name, AuthorizerType: 'JWT', IdentitySource: ['$request.header.Authorization'],
    JwtConfiguration: {Issuer: `https://cognito-idp.${P.region}.amazonaws.com/${pool}`, Audience: [client]}}))};
  const routes = {Items: Object.values(template.Resources).filter(r => r.Type === 'AWS::ApiGatewayV2::Route').map(r => ({
    RouteKey: r.Properties.RouteKey, AuthorizationType: 'JWT', Target: 'integrations/identity',
    AuthorizerId: r.Properties.AuthorizerId.Ref === 'ConsumerJwtAuthorizer' ? 'consumer' : 'workforce'}))};
  routes.Items.push({RouteKey: 'GET /separate-stack', Target: 'integrations/other', AuthorizationType: 'JWT'});
  return {caller: {Account: P.account, Arn: `arn:aws:sts::${P.account}:assumed-role/OrganizationAccountAccessRole/fictional`},
    foundation: {Stacks: [{StackStatus: 'UPDATE_COMPLETE', StackId: `arn:aws:cloudformation:${P.region}:${P.account}:stack/${P.foundation}/fictional`,
      Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({OutputKey, OutputValue}))}]},
    stack: {Stacks: [{StackStatus: 'UPDATE_COMPLETE', StackId: `arn:aws:cloudformation:${P.region}:${P.account}:stack/${P.stack}/fictional`,
      Parameters: Object.entries(params).map(([ParameterKey, ParameterValue]) => ({ParameterKey, ParameterValue}))}]},
    template, fn, authorizers, routes,
    integrations: {Items: [{IntegrationId: 'identity', IntegrationUri: fn.FunctionArn, IntegrationType: 'AWS_PROXY', PayloadFormatVersion: '2.0', TimeoutInMillis: 30000}]},
    database: {contract: 'care-erasure-schema-upgrade/1', command: 'inspect', operatorSource: {sourceCommit: 'a'.repeat(40), clean: true},
      awsAccountId: P.account, foundation: P.foundation, execution: 'synthetic-staging', phiAllowed: false,
      observedMigrationCount: 46, sourceMigrationCount: 45, tableCount: 87, fromLedgerSha256: P.liveBefore, toLedgerSha256: P.liveAfter,
      referenceLedgerSha256: P.reference, dataPreserved: true, applied: false, alreadyApplied: false,
      acceptance: false, phiActivation: false, apiDeploymentPerformed: false, dataSha256: 'd'.repeat(64), rowCount: 23980}};
}
test('candidate binds exact index, embedded release, ZIP, both sources and unchanged migration histories', () => {
  const c = candidate(); verifyCareCandidate(c.manifest, c.release, c.bundle, c.zip, c.current);
  assert.deepEqual(c.zip, careReleaseZip(c.bundle, c.release));
  for (const mutate of [m => m.phiAllowed = true, m => m.mobile.built = true,
    m => m.desktop.commit = 'f'.repeat(40), m => m.mobile.source.sha256 = 'e'.repeat(64),
    m => m.rollback.previousApiAllowedAfterUpgrade = true, m => m.rollback.rehearsed = true,
    m => m.migrations.reference = 'e'.repeat(64), m => m.key += '/escape', m => m.zipBytes++,
    m => m.templateSha256 = 'd'.repeat(64)]) {
    const changed = clone(c.manifest); mutate(changed);
    assert.throws(() => verifyCareCandidate(changed, c.release, c.bundle, c.zip, c.current), /synthetic_care_release_refused/);
  }
  assert.throws(() => verifyCareCandidate(c.manifest, c.release, Buffer.from('changed'), c.zip, c.current), /candidate_bytes/);
  assert.throws(() => verifyCareCandidate(c.manifest, c.release, c.bundle, Buffer.concat([c.zip, Buffer.from('extra')]), c.current), /candidate_bytes/);
});
test('prepare preserves every live resource, all 51 JWT routes, and every non-code parameter; fixes count annotation only', () => {
  const o = observation(), before = clone(o), c = candidate();
  const result = verifyCareObservation(o, source, c.manifest);
  assert.deepEqual(o, before);
  const restored = clone(result.template); restored.Outputs.RoutesEnabled.Value = '32'; assert.deepEqual(restored, o.template);
  assert.equal(result.template.Outputs.RoutesEnabled.Value, '51');
  assert.deepEqual(result.parameters.filter(p => 'ParameterValue' in p), [{ParameterKey: 'LambdaCodeKey', ParameterValue: c.manifest.key}]);
  assert.equal(result.parameters.filter(p => p.UsePreviousValue === true).length, 10);
  assert.equal(result.observed.routeCount, 51);
  for (const name of P.absentRoutes) assert.equal(result.template.Resources[name], undefined);
});
test('real target, function, IAM/template, JWT, history or source mismatch cannot prepare', () => {
  const c = candidate();
  const changes = [o => o.caller.Account = '173535830222', o => o.caller.Arn = `arn:aws:iam::${P.account}:root`,
    o => o.foundation.Stacks[0].Outputs.find(r => r.OutputKey === 'PhiAllowed').OutputValue = 'true',
    o => o.foundation.Stacks[0].Outputs.find(r => r.OutputKey === 'DatabaseName').OutputValue = 'clinical_core_qualification',
    o => o.stack.Stacks[0].StackStatus = 'UPDATE_IN_PROGRESS', o => o.stack.Stacks[0].Parameters.pop(),
    o => o.stack.Stacks[0].Parameters.push(clone(o.stack.Stacks[0].Parameters[0])),
    o => o.fn.CodeSha256 = 'wrong', o => o.fn.Runtime = 'nodejs20.x', o => o.fn.Environment.Variables.CLINICAL_DATABASE_NAME = 'production',
    o => o.fn.Layers = [{Arn: 'unreviewed'}], o => o.fn.VpcConfig = {VpcId: 'other'},
    o => o.template.Resources.IdentityApiRole.Properties.Policies[0].PolicyDocument.Statement[0].Resource = '*',
    o => o.template.Resources.PublicConsultIntakeRoute = clone(source.Resources.PublicConsultIntakeRoute),
    o => o.integrations.Items.push(clone(o.integrations.Items[0])), o => o.integrations.Items[0].TimeoutInMillis = 15000,
    o => o.routes.Items[0].AuthorizationType = 'NONE', o => o.routes.Items[0].Target = 'integrations/other',
    o => o.routes.Items.push(clone(o.routes.Items[0])),
    o => o.authorizers.Items[0].JwtConfiguration.Audience.push('other-audience'),
    o => o.authorizers.Items[0].JwtConfiguration.Issuer = 'https://other.invalid',
    o => o.database.observedMigrationCount = 47, o => o.database.operatorSource.sourceCommit = 'f'.repeat(40),
    o => o.database.referenceLedgerSha256 = 'e'.repeat(64), o => o.database.dataPreserved = false,
    o => o.database.acceptance = true];
  for (const change of changes) {const o = observation(); change(o); assert.throws(() => verifyCareObservation(o, source, c.manifest));}
});
test('source snapshots refuse dirty/untracked runtime changes, but not unrelated graph output', t => {
  const root = mkdtempSync(resolve(tmpdir(), 'alp care source ')); t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(resolve(root, 'src')); writeFileSync(resolve(root, 'src/a.ts'), 'export const a=1;\n');
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  git(['init']); git(['add', '.']); git(['-c', 'user.name=Fictional', '-c', 'user.email=fictional@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'fixture']);
  const original = careSourceSnapshot(root, 'desktop');
  mkdirSync(resolve(root, 'graphify-out')); writeFileSync(resolve(root, 'graphify-out/graph.json'), '{}');
  assert.deepEqual(careSourceSnapshot(root, 'desktop'), original);
  writeFileSync(resolve(root, 'src/new.ts'), 'untracked'); assert.throws(() => careSourceSnapshot(root, 'desktop'), /source_dirty/);
  rmSync(resolve(root, 'src/new.ts')); writeFileSync(resolve(root, 'src/a.ts'), 'changed'); assert.throws(() => careSourceSnapshot(root, 'desktop'), /source_dirty/);
});
test('stored ZIP has the standard CRC32 and exactly two local entries and a complete central directory', () => {
  const zip = careReleaseZip(Buffer.from('123456789'), {});
  assert.equal(zip.readUInt32LE(14), 0xcbf43926); assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.subarray(30, 38).toString(), 'index.js');
  const second = 30 + 8 + 9; assert.equal(zip.readUInt32LE(second), 0x04034b50);
  assert.equal(zip.subarray(second + 30, second + 42).toString(), 'release.json');
  const end = zip.length - 22; assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), 2); const central = zip.readUInt32LE(end + 16);
  assert.equal(zip.readUInt32LE(central), 0x02014b50); assert.equal(central + zip.readUInt32LE(end + 12), end);
});
