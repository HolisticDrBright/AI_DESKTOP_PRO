import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {DEPLOYED_CARE as D} from './verify-deployed-synthetic-care.mjs';
import {CARE_VERSION_DESCRIPTION as description, verifyCareVersionPreflight, verifyCareVersionLatest,
  verifyRetainedCareVersion, retainCareVersion, runCareVersionChild} from './retain-synthetic-care-version.mjs';
const checksum = Buffer.from(D.zip, 'hex').toString('base64'), arn = `arn:aws:lambda:${P.region}:${P.account}:function:${P.functionName}`;
const harness = {commit: 'a'.repeat(40), clean: true, files: 100, sha256: 'b'.repeat(64)}, now = 1700000000000;
function plan() {return {contract: 'synthetic-care-deployed-inspection/1', observedAt: new Date(now).toISOString(), account: P.account,
  execution: 'synthetic-staging', phiAllowed: false, deployedSource: D.desktop, deployedZip: D.zip, exactObjectVersion: D.version,
  exactVersionReadbackVerified: true, liveIamRoleVerified: true, liveLoggingVerified: true, deployedCodeSha256: checksum,
  routeCount: 51, awsMutationPerformed: false, schemaChanged: false, upgradeAuthorized: false, rollbackRehearsed: false,
  database: {liveCount: 46, sourceCount: 45, tableCount: 87, liveLedger: P.liveBefore, referenceLedger: P.reference},
  harness, revisionId: 'fictional-revision'};}
function latest() {return {FunctionName: P.functionName, FunctionArn: arn, Version: '$LATEST', CodeSha256: checksum, CodeSize: D.bytes,
  RevisionId: 'fictional-revision', State: 'Active', LastUpdateStatus: 'Successful', Runtime: 'nodejs22.x', Handler: 'index.handler',
  MemorySize: 256, Timeout: 29, Architectures: ['arm64'], Role: `arn:aws:iam::${P.account}:role/fictional`,
  PackageType: 'Zip', EphemeralStorage: {Size: 512}, TracingConfig: {Mode: 'PassThrough'},
  LoggingConfig: {LogGroup: '/ai-clinical-core/synthetic-staging/identity-api', LogFormat: 'JSON', ApplicationLogLevel: 'WARN', SystemLogLevel: 'WARN'},
  Environment: {Variables: {CLINICAL_DATABASE_CLUSTER_ARN: P.cluster, CLINICAL_DATABASE_SECRET_ARN: P.secret, CLINICAL_DATABASE_NAME: P.database,
    CLINICAL_CONSUMER_ISSUER: `https://cognito-idp.${P.region}.amazonaws.com/${P.consumerPool}`, CLINICAL_CONSUMER_AUDIENCE: P.consumerClient,
    CLINICAL_WORKFORCE_ISSUER: `https://cognito-idp.${P.region}.amazonaws.com/${P.workforcePool}`, CLINICAL_WORKFORCE_AUDIENCE: P.workforceClient}}};}
const version = (n = '1') => ({...structuredClone(latest()), FunctionArn: `${arn}:${n}`, Version: n, RevisionId: 'published-revision', Description: description});
test('publication requires a fresh source-bound full live inspection, never a saved success flag', () => {
  verifyCareVersionPreflight(plan(), harness, now);
  for (const mutate of [p => p.observedAt = new Date(now - 120001).toISOString(), p => p.observedAt = new Date(now + 1).toISOString(),
    p => p.account = '173535830222', p => p.execution = 'qualification', p => p.phiAllowed = true,
    p => p.liveIamRoleVerified = false, p => p.liveLoggingVerified = false, p => p.exactVersionReadbackVerified = false,
    p => p.deployedZip = 'f'.repeat(64), p => p.exactObjectVersion = 'latest', p => p.deployedSource = 'f'.repeat(40),
    p => p.routeCount = 55, p => p.database.liveLedger = P.liveAfter, p => p.database.liveCount = 47,
    p => p.harness.commit = 'f'.repeat(40), p => p.harness.clean = false, p => p.upgradeAuthorized = true]) {
    const p = structuredClone(plan()); mutate(p); assert.throws(() => verifyCareVersionPreflight(p, harness, now));
  }
});
test('latest must retain the fixed executable bounds, identifiers, role account and quiet encrypted-log destination', () => {
  verifyCareVersionLatest(latest(), 'fictional-revision');
  for (const mutate of [f => f.RevisionId = 'changed', f => f.CodeSha256 = 'other', f => f.CodeSize++, f => f.FunctionArn += ':1',
    f => f.State = 'Pending', f => f.LastUpdateStatus = 'InProgress', f => f.Role = 'arn:aws:iam::173535830222:role/other',
    f => f.Environment.Variables.EXTRA = 'unexpected', f => f.LoggingConfig.LogFormat = 'Text', f => f.Layers = [{Arn: 'other'}],
    f => f.FileSystemConfigs = [{Arn: 'other'}], f => f.VpcConfig = {VpcId: 'other'}, f => f.DurableConfig = {},
    f => f.EphemeralStorage.Size = 10240, f => f.TracingConfig.Mode = 'Active', f => f.PackageType = 'Image']) {
    const f = latest(); mutate(f); assert.throws(() => verifyCareVersionLatest(f, 'fictional-revision'));
  }
});
test('readback pins a numerical qualified version and all executable configuration, not its label alone', () => {
  verifyRetainedCareVersion(version(), latest());
  for (const mutate of [v => v.Version = '$LATEST', v => v.FunctionArn = arn, v => v.Description = 'invented',
    v => v.CodeSha256 = 'wrong', v => v.Role = 'other', v => v.State = 'Pending', v => v.Timeout = 30,
    v => v.Environment.Variables.CLINICAL_DATABASE_NAME = 'clinical_core_qualification', v => v.LoggingConfig.LogFormat = 'Text',
    v => v.EphemeralStorage.Size++, v => v.Architectures = ['x86_64']]) {
    const v = version(); mutate(v); assert.throws(() => verifyRetainedCareVersion(v, latest()));
  }
});
test('bounded actual inventory and optimistic code/revision guard publish exactly once, then qualified readback', async () => {
  const calls = [];
  const result = await retainCareVersion(async args => {
    calls.push(args);
    if (args[1] === 'list-versions-by-function') return {Versions: [latest()]};
    if (args[1] === 'publish-version') return {Version: '1'};
    return version();
  }, latest());
  assert.equal(result.newlyPublished, true); assert.equal(result.version, '1');
  const list = calls[0]; assert.equal(list[2], '--no-paginate');
  assert.deepEqual(JSON.parse(list[4]), {FunctionName: P.functionName, MaxItems: 50});
  assert.deepEqual(calls[1], ['lambda', 'publish-version', '--function-name', P.functionName,
    '--code-sha256', checksum, '--revision-id', 'fictional-revision', '--description', description]);
  assert.equal(calls[2].at(-1), '1');
});
test('a previously retained identical version is reconciled without publishing again, including a second page', async () => {
  const calls = [];
  const result = await retainCareVersion(async args => {
    calls.push(args);
    if (args[1] === 'list-versions-by-function') return JSON.parse(args[4]).Marker
      ? {Versions: [version('2')]} : {Versions: [latest()], NextMarker: 'next'};
    assert.equal(args[1], 'get-function-configuration'); return version('2');
  }, latest());
  assert.equal(result.newlyPublished, false); assert.equal(result.version, '2'); assert.equal(calls.length, 3);
});
test('repeated pagination, duplicate or ambiguous bindings, unknown publication and wrong readback never pass or blind-retry', async () => {
  for (const inventory of [{Versions: [version(), version('2')]}, {Versions: [version(), version()]}, {Versions: {}},
    {Versions: [latest()], NextMarker: 'repeated'}]) {
    let writes = 0;
    await assert.rejects(retainCareVersion(async args => {if (args[1] === 'publish-version') writes++; return inventory;}, latest()));
    assert.equal(writes, 0);
  }
  for (const outcome of ['throw', 'no-version', 'bad-readback']) {
    let writes = 0;
    await assert.rejects(retainCareVersion(async args => {
      if (args[1] === 'list-versions-by-function') return {Versions: [latest()]};
      if (args[1] === 'publish-version') {writes++; if (outcome === 'throw') throw new Error('timeout'); return outcome === 'no-version' ? {} : {Version: '1'};}
      return {...version(), CodeSha256: 'wrong'};
    }, latest())); assert.equal(writes, 1);
  }
});
test('retention has no alias, traffic, environment, permission, fixture, erasure or schema mutation method', () => {
  const script = readFileSync(new URL('./retain-synthetic-care-version.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /'update-alias'|'create-alias'|'update-function-code'|'update-function-configuration'|'update-integration'|'add-permission'|'execute-change-set'|'upgrade'/);
  assert.match(script, /functionalRollbackVerified: false/); assert.match(script, /afterUpgradeVerified: false/);
  assert.match(script, /trafficChanged: false/); assert.match(script, /upgradeAuthorized: false/);
});

test('child failures preserve their stage and bounded refusal, never command, response or secret text', () => {
  assert.equal(runCareVersionChild(() => 'result', 'build'), 'result');
  for (const [stage, error, expected] of [
    ['preflight', {stderr: 'synthetic_care_release_refused:deployed_inspection\n'}, 'version_preflight_deployed_inspection'],
    ['postflight', {stderr: 'sensitive response\nsynthetic_care_release_refused:source_dirty\n'}, 'version_postflight_source_dirty'],
    ['preflight', {code: 'ETIMEDOUT', message: 'secret command'}, 'version_preflight_timeout'],
    ['build', {stderr: 'token=fictional-secret\n'}, 'version_build_child_failed'],
    ['postflight', {stderr: 'synthetic_care_release_refused:token=fictional-secret\n'}, 'version_postflight_child_failed'],
  ]) assert.throws(() => runCareVersionChild(() => {throw error;}, stage), e =>
    e.message === `synthetic_care_release_refused:${expected}`);
  assert.throws(() => runCareVersionChild(() => 'unused', 'unreviewed'));
});
