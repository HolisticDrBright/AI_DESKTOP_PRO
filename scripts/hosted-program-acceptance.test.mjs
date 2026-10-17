// Fictional adapters only. No AWS, Cognito or HTTP call is made; a fictional transport is never hosted evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CARE_RELEASE as P, careReleaseZip} from './synthetic-care-release.mjs';
import {DEPLOYED_CARE} from './verify-deployed-synthetic-care.mjs';

// Loaded per test, so that against a tree without the modules every test fails on its own.
const loaded = await Promise.all([import('./hosted-program-acceptance-observation.mjs'), import('./hosted-program-acceptance.mjs')])
  .then(([observation, acceptance]) => ({...observation, ...acceptance}), loadError => ({loadError}));
const need = () => {if (loaded.loadError) throw loaded.loadError; return loaded;};

const sha256 = value => createHash('sha256').update(value).digest('hex');
const fictional = (label, length = 64) => createHash(length === 40 ? 'sha1' : 'sha256').update(`fictional:${label}`).digest('hex');
const b64 = hex => Buffer.from(hex, 'hex').toString('base64');
const issuer = pool => `https://cognito-idp.${P.region}.amazonaws.com/${pool}`;
const WRONG_POOL = 'us-east-2_FictionalWrongPool';
const PAIR_COMMIT = fictional('reviewed desktop commit', 40);
const OTHER_COMMIT = fictional('another desktop commit', 40);
const BUNDLE = Buffer.from('/* fictional identity bundle; not clinical code */\nmodule.exports={handler:async()=>({statusCode:404})};\n');
function fictionalRelease(commit = PAIR_COMMIT, bundle = BUNDLE) {
  return {contract: 'synthetic-care-release/1', execution: 'synthetic-staging', phiAllowed: false,
    desktop: {commit, clean: true, files: 1, sha256: fictional('desktop tree')},
    mobile: {source: {commit: fictional('mobile commit', 40), clean: true, files: 1, sha256: fictional('mobile tree')}},
    bundleSha256: sha256(bundle), deployed: false, acceptance: false};
}
const ARTIFACT = careReleaseZip(BUNDLE, fictionalRelease());
const ZIP = sha256(ARTIFACT);
const PAIR = Object.freeze({contract: 'desktop-reviewed-source-pair/1', desktopCommit: PAIR_COMMIT,
  identityBundleSha256: sha256(BUNDLE), identityBundleBytes: BUNDLE.length});
const CONNECTION = '00000000-0000-4000-8000-00000000c0de', VERSION = '00000000-0000-4000-8000-00000000beef';
const ENROLLMENT = '00000000-0000-4000-8000-0000000e0011';

function world({commit = PAIR_COMMIT, keyZip = ZIP, codeZip = ZIP, family = 'care-release', legacyKey = false,
  consumerIssuer = issuer(P.consumerPool), workforceIssuer = issuer(P.workforcePool), envConsumerIssuer,
  revision = 'fictional-revision-1', extraAuthorizer = false, state = 'Active', phi = 'false'} = {}) {
  const key = legacyKey ? `clinical-core/authenticated-api/${keyZip}.zip`
    : family === 'care-registered-release' ? `clinical-core/authenticated-api/${family}/${commit}/${fictional('mobile commit', 40)}/${keyZip}.zip`
      : `clinical-core/authenticated-api/${family}/${commit}/${keyZip}.zip`;
  const authorizers = [[consumerIssuer, P.consumerClient, 'consumer'], [workforceIssuer, P.workforceClient, 'workforce'],
    ...(extraAuthorizer ? [[issuer(WRONG_POOL), 'fictionalclient', 'extra']] : [])];
  return {
    caller: {Account: P.account, Arn: `arn:aws:sts::${P.account}:assumed-role/FictionalMember/fictional`, UserId: 'FICTIONAL:fictional'},
    stack: {Stacks: [{StackName: P.stack, StackStatus: 'UPDATE_COMPLETE',
      StackId: `arn:aws:cloudformation:${P.region}:${P.account}:stack/${P.stack}/fictional`,
      Parameters: [{ParameterKey: 'LambdaCodeBucket', ParameterValue: P.bucket}, {ParameterKey: 'LambdaCodeKey', ParameterValue: key}], Outputs: []}]},
    foundation: {Stacks: [{StackName: P.foundation, StackStatus: 'UPDATE_COMPLETE',
      Outputs: [{OutputKey: 'PhiAllowed', OutputValue: phi}, {OutputKey: 'DataClassification', OutputValue: 'synthetic_only'}]}]},
    fn: {FunctionName: P.functionName, FunctionArn: `arn:aws:lambda:${P.region}:${P.account}:function:${P.functionName}`,
      State: state, LastUpdateStatus: 'Successful', RevisionId: revision, CodeSha256: b64(codeZip), CodeSize: ARTIFACT.length,
      Environment: {Variables: {CLINICAL_CONSUMER_ISSUER: envConsumerIssuer ?? consumerIssuer, CLINICAL_CONSUMER_AUDIENCE: P.consumerClient,
        CLINICAL_WORKFORCE_ISSUER: workforceIssuer, CLINICAL_WORKFORCE_AUDIENCE: P.workforceClient}}},
    authorizers: {Items: authorizers.map(([Issuer, audience, id]) => ({AuthorizerId: id, AuthorizerType: 'JWT',
      IdentitySource: ['$request.header.Authorization'], JwtConfiguration: {Issuer, Audience: [audience]}}))},
  };
}
/** Each observation starts with STS, so the n-th STS call selects the n-th fictional state. */
function fictionalReader(...states) {
  const calls = [];
  let observation = -1;
  return {calls, reader: {kind: 'fictional', async read(operation, input) {
    calls.push(operation);
    if (operation === 'sts:GetCallerIdentity') observation++;
    const w = states[Math.min(Math.max(observation, 0), states.length - 1)];
    if (operation === 'sts:GetCallerIdentity') return structuredClone(w.caller);
    if (operation === 'cloudformation:DescribeStacks') return structuredClone(input.StackName === P.stack ? w.stack : w.foundation);
    if (operation === 'lambda:GetFunctionConfiguration') return structuredClone(w.fn);
    if (operation === 'apigatewayv2:GetAuthorizers') return structuredClone(w.authorizers);
    throw new Error('fictional_reader_operation');
  }}};
}
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(role, overrides = {}) {
  const workforce = role === 'workforce';
  return `${part({alg: 'none', kid: 'fictional'})}.${part({sub: fictional(role).slice(0, 36), 'custom:person_id': `fictional-${role}`,
    iss: issuer(workforce ? P.workforcePool : P.consumerPool), aud: workforce ? P.workforceClient : P.consumerClient,
    token_use: 'id', 'custom:synthetic_attested': 'true', exp: 4102444800, ...overrides})}.fictional-signature`;
}
const roleOf = authorization => {
  const payload = authorization.split(' ')[1]?.split('.')[1];
  return payload ? JSON.parse(Buffer.from(payload, 'base64url').toString())['custom:person_id']?.replace('fictional-', '') : null;
};
/** A fictional program API. `duplicate` models a replay: the assignment already exists and is active. */
function fictionalApi({marked = true, duplicate = false, providerBody = false, unmarkedAction} = {}) {
  const requests = [];
  let accepted = false;
  const fetch = async (url, init) => {
    const path = new URL(url).pathname, body = JSON.parse(init.body ?? '{}'), role = roleOf(init.headers.authorization ?? '');
    requests.push({path, action: body.action, role});
    const headers = new Headers({'content-type': 'application/json',
      ...(marked && body.action !== unmarkedAction ? {'x-clinical-execution': 'qualification'} : {})});
    const reply = (status, payload) => ({status, headers, text: async () => JSON.stringify(payload)});
    const digest = fictional('source digest');
    if (path === '/clinical-core/consumer/programs' && body.action === 'list') return reply(200, {data: {action: 'list', assignments: []}});
    if (path === '/clinical-core/workforce/programs' && body.action === 'assign') {
      if (role !== 'workforce') return reply(403, {error: 'identity_refused'});
      return reply(200, {data: {action: 'assign', enrollmentId: ENROLLMENT, sourceDigest: digest, duplicate,
        state: duplicate ? 'active' : 'offered',
        ...(providerBody ? {checkout: {object: 'checkout.session', id: 'cs_test_fictional', payment_status: 'paid'}} : {})}});
    }
    if (path === '/clinical-core/consumer/programs' && body.action === 'read') {
      if (role !== 'consumer') return reply(403, {error: 'identity_refused'});
      return reply(200, {data: {sourceDigest: digest, assignment: {state: duplicate || accepted ? 'active' : 'offered', revision: 1},
        review: {planRevision: 1, inventoryComplete: false, held: ['supp-1'], add: ['lesson-a']}}});
    }
    if (path === '/clinical-core/consumer/programs' && body.action === 'accept') {accepted = true; return reply(200, {data: {state: 'active', revision: 2}});}
    if (path === '/clinical-core/consumer/programs' && body.action === 'complete') return reply(403, {error: 'identity_refused'});
    return reply(404, {error: 'not_found'});
  };
  return {fetch, requests};
}
async function session({states = [world()], api = fictionalApi(), plan, pair = PAIR, artifact = ARTIFACT, deploymentClaim, identities = true} = {}) {
  const m = need(), {reader, calls} = fictionalReader(...states);
  const s = await m.beginAcceptanceSession({reader, transport: m.createObservedTransport({fetch: api.fetch}),
    plan: plan ?? m.PROGRAM_ASSIGNMENT_PLAN, pair, artifact, deploymentClaim});
  if (identities) for (const role of ['consumer', 'foreignConsumer', 'workforce']) s.identity(role, token(role));
  return {s, calls, api};
}
const journey = s => need().runProgramAssignmentJourney(s, {connectionId: CONNECTION, programVersionId: VERSION, heldItemId: 'supp-1'});
const refusedWith = (...codes) => error => {
  assert.ok(Array.isArray(error?.refusals), `expected a refusal, got ${error?.message}`);
  for (const code of codes) assert.ok(error.refusals.includes(code), `${code} missing from ${error.refusals}`);
  return true;
};
async function bind(stateOptions, extra = {}) {
  const m = need(), {reader} = fictionalReader(world(stateOptions));
  const observation = await m.observeProgramTarget(reader);
  return {observation, binding: m.evaluateTargetBinding({observation, pair: PAIR, artifact: ARTIFACT, ...extra})};
}

// ---- The positive control: every check satisfied, and still not hosted evidence. ----
test('a complete fictional run satisfies every check and is still not hosted evidence', async () => {
  const {s, calls} = await session();
  const report = await journey(s);
  assert.deepEqual(report.refusals, []);
  assert.equal(report.verdict, 'fictional_only_not_hosted_evidence');
  assert.equal(report.hostedEvidence, false);
  assert.equal(report.execution.execution, 'qualification');
  assert.deepEqual({created: report.writes.created, reused: report.writes.reused, skipped: report.writes.skipped, refused: report.writes.refused},
    {created: 2, reused: 0, skipped: 0, refused: 2});
  assert.equal(report.purchasesObserved, 0);
  assert.equal(report.observed.desktopCommit, PAIR_COMMIT);
  assert.equal(report.expected.codeSha256, ZIP);
  assert.ok(calls.every(op => need().READ_OPERATIONS.includes(op)));
  assert.equal(calls.filter(op => op === 'sts:GetCallerIdentity').length, 2, 'the target is observed before and after the run');
  assert.ok(!JSON.stringify(report).includes('fictional-signature'), 'no token reaches the report');
});

test('the reviewed source pair is the packet code pair, and a substituted pair is never hosted evidence', async () => {
  const m = need();
  assert.equal(m.REVIEWED_SOURCE_PAIR.desktopCommit, '8bfe2349af869cbc0d93712fe6050300bb4ce4ab');
  assert.equal(m.REVIEWED_SOURCE_PAIR.v2Commit, 'dd704abf820de5556c5e6da9dcb39495c138fa87');
  assert.equal(m.REVIEWED_SOURCE_PAIR.identityBundleSha256, '24a65189e2351e7d0b4911944e271f5c09849689e23ca67be05650375979ff8f');
  assert.equal(m.REVIEWED_SOURCE_PAIR.identityBundleBytes, 1980414);
  assert.ok(Object.isFrozen(m.REVIEWED_SOURCE_PAIR));
  const {binding} = await bind({}, {pair: m.REVIEWED_SOURCE_PAIR});
  assert.ok(binding.refusals.includes('reviewed_bundle_mismatch'), 'a fictional artifact is not the pair bundle');
});

test('only fixed read operations reach the AWS reader; any other operation is refused', async () => {
  const m = need();
  assert.deepEqual([...m.READ_OPERATIONS].sort(), ['apigatewayv2:GetAuthorizers', 'cloudformation:DescribeStacks',
    'lambda:GetFunctionConfiguration', 'sts:GetCallerIdentity']);
  for (const operation of ['lambda:UpdateFunctionCode', 'cloudformation:UpdateStack', 'cognito-idp:AdminCreateUser', 'rds-data:ExecuteStatement'])
    assert.throws(() => m.assertReadOperation(operation), /read_operation_refused/);
});

test('the AWS CLI reader issues get/describe commands under the synthetic member profile, untrusted when its runner is injected', async () => {
  const m = need(), argv = [];
  const reader = m.createAwsCliReader({run: (file, args) => {argv.push([file, ...args]); return '{}';}});
  for (const [operation, input] of [['sts:GetCallerIdentity', {}], ['cloudformation:DescribeStacks', {StackName: P.stack}],
    ['lambda:GetFunctionConfiguration', {FunctionName: P.functionName}], ['apigatewayv2:GetAuthorizers', {ApiId: P.apiId}]]) await reader.read(operation, input);
  assert.deepEqual(argv.map(a => a.slice(0, 3)), [['aws', 'sts', 'get-caller-identity'], ['aws', 'cloudformation', 'describe-stacks'],
    ['aws', 'lambda', 'get-function-configuration'], ['aws', 'apigatewayv2', 'get-authorizers']]);
  for (const a of argv) assert.deepEqual(a.slice(-6), ['--profile', 'ai-synthetic-member', '--region', 'us-east-2', '--output', 'json']);
  assert.equal(m.isTrustedReader(reader), false);
  await assert.rejects(reader.read('lambda:UpdateFunctionCode', {}), /read_operation_refused/);
  await assert.rejects(reader.read('cloudformation:DescribeStacks', {StackName: 'x; rm -rf'}), /read_input_refused/);
});

// ---- Forged deployment files: a caller-supplied file is never an observation. ----
const forgedClaim = () => ({deployed: true, programRoutesWithheld: true, phiAllowed: false, account: P.account,
  sourceCommit: PAIR_COMMIT, deployedCodeSha256: b64(ZIP), artifactSha256: ZIP});

test('a deployment file alone cannot stand in for an observation', () => {
  const m = need();
  const alone = m.evaluateTargetBinding({observation: undefined, pair: PAIR, artifact: ARTIFACT, deploymentClaim: forgedClaim()});
  assert.ok(alone.refusals.includes('observation_required'));
  assert.equal(alone.deploymentClaim, 'unverifiable');
  const asObservation = m.evaluateTargetBinding({observation: forgedClaim(), pair: PAIR, artifact: ARTIFACT});
  assert.ok(asObservation.refusals.includes('observation_not_from_adapter'));
});

test('a copied or edited observation is refused, and an adapter observation cannot be edited in place', async () => {
  const m = need(), {observation} = await bind({});
  const copied = JSON.parse(JSON.stringify(observation));
  assert.ok(m.evaluateTargetBinding({observation: copied, pair: PAIR, artifact: ARTIFACT}).refusals.includes('observation_not_from_adapter'));
  assert.ok(Object.isFrozen(observation.function));
  assert.throws(() => {observation.function.codeSha256Hex = ZIP;}, TypeError);
});

test('a forged deployment file naming the pair is refused when the live Lambda runs the pinned old release', async () => {
  const {binding} = await bind({commit: DEPLOYED_CARE.desktop, keyZip: DEPLOYED_CARE.zip, codeZip: DEPLOYED_CARE.zip},
    {deploymentClaim: forgedClaim()});
  for (const code of ['deployment_claim_disagrees', 'observed_source_stale', 'observed_code_stale']) assert.ok(binding.refusals.includes(code), code);
  assert.equal(binding.deploymentClaim, 'disagrees');
  assert.equal(binding.observed.desktopCommit, DEPLOYED_CARE.desktop);
});

test('a deployment file that agrees with the observation adds nothing, and one that names nothing is refused', async () => {
  assert.equal((await bind({}, {deploymentClaim: forgedClaim()})).binding.deploymentClaim, 'agrees');
  assert.deepEqual((await bind({}, {deploymentClaim: forgedClaim()})).binding.refusals, []);
  const unbound = (await bind({}, {deploymentClaim: {deployed: true, verdict: 'pass'}})).binding;
  assert.ok(unbound.refusals.includes('deployment_claim_unbound'));
});

test('forged or missing reviewed artifacts are refused', async () => {
  const tampered = careReleaseZip(Buffer.from(BUNDLE.toString().replace('404', '200')), fictionalRelease());
  assert.ok((await bind({}, {artifact: tampered})).binding.refusals.includes('reviewed_bundle_mismatch'));
  const renamed = careReleaseZip(BUNDLE, fictionalRelease(OTHER_COMMIT));
  assert.ok((await bind({}, {artifact: renamed})).binding.refusals.includes('reviewed_artifact_source_mismatch'));
  assert.ok((await bind({}, {artifact: Buffer.concat([ARTIFACT, Buffer.from('x')])})).binding.refusals.includes('reviewed_artifact_not_canonical'));
  assert.ok((await bind({}, {artifact: Buffer.from('{"zipSha256":"forged"}')})).binding.refusals.includes('reviewed_artifact_invalid'));
  assert.ok((await bind({}, {artifact: undefined})).binding.refusals.includes('reviewed_artifact_required'));
});

// ---- Stale Lambda and stale or unadvertised source. ----
test('the pinned 5b6f8aa4 deployment is refused before any request as stale source and stale code', async () => {
  const api = fictionalApi();
  await assert.rejects(session({states: [world({commit: DEPLOYED_CARE.desktop, keyZip: DEPLOYED_CARE.zip, codeZip: DEPLOYED_CARE.zip})], api}),
    refusedWith('observed_source_stale', 'observed_code_stale'));
  assert.equal(api.requests.length, 0);
});

test('a function whose code differs from its stack code pointer is refused', async () => {
  const {binding} = await bind({codeZip: DEPLOYED_CARE.zip});
  for (const code of ['stack_code_pointer_disagrees', 'observed_code_stale']) assert.ok(binding.refusals.includes(code), code);
});

test('an unversioned code key advertises no source and is refused; every versioned family is read', async () => {
  assert.ok((await bind({legacyKey: true})).binding.refusals.includes('stack_source_unadvertised'));
  for (const family of ['care-release', 'care-intent-release', 'care-registered-release']) {
    const {binding} = await bind({family});
    assert.deepEqual(binding.refusals, [], family);
    assert.equal(binding.observed.keyFamily, family);
  }
});

test('an inactive function or a PHI-allowed foundation is refused', async () => {
  assert.ok((await bind({state: 'Pending'})).binding.refusals.includes('function_not_active'));
  assert.ok((await bind({phi: 'true'})).binding.refusals.includes('phi_posture_refused'));
});

test('a redeploy between the before and after observations is refused', async () => {
  const {s} = await session({states: [world(), world({revision: 'fictional-revision-2'})]});
  const report = await journey(s);
  assert.ok(report.refusals.includes('target_changed_during_run'));
  assert.equal(report.verdict, 'refused');
});

test('the expected source must be a 40-character commit, not a short hash or a branch', async () => {
  for (const desktopCommit of ['8bfe2349', 'main', PAIR_COMMIT.toUpperCase()]) {
    const {binding} = await bind({}, {pair: {...PAIR, desktopCommit}});
    assert.ok(binding.refusals.includes('expected_source_invalid'), desktopCommit);
  }
});

// ---- Wrong issuer: authorizer, function environment, token. ----
test('a wrong authorizer issuer, function issuer or extra authorizer is refused before any request', async () => {
  for (const options of [{consumerIssuer: issuer(WRONG_POOL)}, {envConsumerIssuer: issuer(WRONG_POOL)}, {extraAuthorizer: true},
    {workforceIssuer: issuer(P.consumerPool)}]) {
    const api = fictionalApi();
    await assert.rejects(session({states: [world(options)], api}), refusedWith('issuer_mismatch'), JSON.stringify(options));
    assert.equal(api.requests.length, 0);
  }
});

test('a token from another issuer or audience is refused before it is used', async () => {
  const m = need();
  const {s, api} = await session({identities: false});
  assert.throws(() => s.identity('consumer', token('consumer', {iss: issuer(WRONG_POOL)})), refusedWith('issuer_mismatch'));
  assert.throws(() => s.identity('workforce', token('workforce', {iss: issuer(P.consumerPool), aud: P.consumerClient})), refusedWith('issuer_mismatch'));
  assert.throws(() => s.identity('consumer', token('consumer', {aud: 'fictionalotherclient'})), refusedWith('audience_mismatch'));
  assert.throws(() => s.identity('consumer', token('consumer', {'custom:synthetic_attested': 'false'})), refusedWith('identity_not_synthetic'));
  await assert.rejects(s.read('consumer', '/clinical-core/consumer/programs', {action: 'list'}, 200), refusedWith('identity_not_observed'));
  assert.equal(api.requests.length, 0);
  assert.ok(m.evaluateHostedProgramAcceptance({identities: [{role: 'consumer', iss: issuer(P.consumerPool)}]}).refusals.includes('identity_not_from_adapter'));
});

// ---- Missing marker. ----
test('an unmarked answer stops the run before its first write', async () => {
  const {s, api} = await session({api: fictionalApi({marked: false})});
  await assert.rejects(journey(s), refusedWith('execution_not_qualification'));
  assert.deepEqual(api.requests.map(r => r.action), ['list'], 'the assignment was never sent');
});

test('one unmarked 2xx after the last write still refuses the run', async () => {
  const {s} = await session({api: fictionalApi({unmarkedAction: 'read'}), plan: [
    {step: 'program_assignment', kind: 'assignment', requirement: 'must_create'}]});
  await s.read('consumer', '/clinical-core/consumer/programs', {action: 'list'}, 200);
  const assigned = await s.write('program_assignment', 'workforce', '/clinical-core/workforce/programs',
    {action: 'assign', connectionId: CONNECTION, programVersionId: VERSION}, 200);
  s.created('program_assignment', assigned);
  const unmarked = await s.read('consumer', '/clinical-core/consumer/programs', {action: 'read', enrollmentId: ENROLLMENT}, 200);
  assert.equal(unmarked.execution, 'production');
  const report = await s.finish();
  assert.equal(report.execution.execution, 'mixed');
  assert.ok(report.refusals.includes('execution_not_qualification'));
});

test('unmarked authorizer denials alone are not an observed qualification execution', async () => {
  const m = need(), transport = m.createObservedTransport({fetch: async () => ({status: 401, headers: new Headers(), text: async () => '{"message":"Unauthorized"}'})});
  await transport.send({path: '/clinical-core/consumer/programs', body: {action: 'list'}});
  const report = m.evaluateHostedProgramAcceptance({responses: transport.records()});
  assert.equal(report.execution.execution, 'unobserved');
  assert.equal(report.execution.unmarkedDenials, 1);
  assert.ok(report.refusals.includes('execution_unobserved'));
});

test('the marker header and mode are the clinical-core constants', () => {
  const m = need(), source = readFileSync(new URL('../src/server/clinical-core/qualification-execution.ts', import.meta.url), 'utf8');
  assert.match(source, new RegExp(`QUALIFICATION_EXECUTION_HEADER = "${m.QUALIFICATION_EXECUTION_HEADER}"`));
  assert.match(source, new RegExp(`QUALIFICATION_EXECUTION_MODE = "${m.QUALIFICATION_EXECUTION_MODE}"`));
  assert.equal(m.QUALIFICATION_EXECUTION_HEADER, 'x-clinical-execution');
  assert.equal(m.QUALIFICATION_EXECUTION_MODE, 'qualification');
});

test('the transport refuses a plain-http origin and keeps no token', async () => {
  const m = need();
  assert.throws(() => m.createObservedTransport({fetch: async () => ({}), origin: 'http://wxv734oi12.execute-api.us-east-2.amazonaws.com'}),
    /origin_https_required/);
  const transport = m.createObservedTransport({fetch: async () => ({status: 200, headers: new Headers({'x-clinical-execution': 'qualification'}), text: async () => '{}'})});
  const record = await transport.send({role: 'consumer', token: token('consumer'), path: '/clinical-core/consumer/programs', body: {action: 'list'}});
  assert.ok(!JSON.stringify(record).includes('fictional-signature'));
  assert.ok(Object.isFrozen(record));
});

// ---- Duplicate replay: reused and skipped are recorded as such, never as creation. ----
test('an honest replay is recorded as reused and skipped, and refused as not observed creation', async () => {
  const {s} = await session({api: fictionalApi({duplicate: true})});
  const report = await journey(s);
  assert.deepEqual(report.writes.steps.map(({step, outcome}) => [step, outcome]), [['program_assignment', 'reused'],
    ['assignment_acceptance', 'skipped'], ['foreign_owner_read', 'refused'], ['held_supplement_completion', 'refused']]);
  assert.equal(report.writes.created, 0);
  for (const code of ['mandatory_create_not_observed:program_assignment', 'mandatory_create_not_observed:assignment_acceptance'])
    assert.ok(report.refusals.includes(code), code);
  assert.equal(report.verdict, 'refused');
});

async function assignOnce(options) {
  const {s} = await session({...options, plan: [{step: 'program_assignment', kind: 'assignment', requirement: 'must_create'}]});
  await s.read('consumer', '/clinical-core/consumer/programs', {action: 'list'}, 200);
  const assigned = await s.write('program_assignment', 'workforce', '/clinical-core/workforce/programs',
    {action: 'assign', connectionId: CONNECTION, programVersionId: VERSION}, 200);
  return {s, assigned};
}
test('a replayed answer recorded as created is refused', async () => {
  const {s, assigned} = await assignOnce({api: fictionalApi({duplicate: true})});
  assert.equal(need().classifyWrite(assigned), 'reused');
  s.created('program_assignment', assigned);
  assert.ok((await s.finish()).refusals.includes('replay_counted_as_creation:program_assignment'));
});

test('the same step recorded twice is refused', async () => {
  const {s, assigned} = await assignOnce();
  s.created('program_assignment', assigned);
  s.created('program_assignment', assigned);
  assert.ok((await s.finish()).refusals.includes('step_recorded_twice:program_assignment'));
});

test('a creation claimed on a response this run did not observe is refused', async () => {
  const {s} = await assignOnce();
  s.created('program_assignment', {status: 200, execution: 'qualification', marker: 'qualification', body: {data: {duplicate: false}}});
  const report = await s.finish();
  for (const code of ['response_not_from_transport', 'created_without_observed_response:program_assignment']) assert.ok(report.refusals.includes(code), code);
});

test('a skipped mandatory step and an unrecorded step are refused', async () => {
  const {s} = await assignOnce();
  s.skipped('program_assignment', 'fixture_already_present');
  assert.ok((await s.finish()).refusals.includes('mandatory_create_not_observed:program_assignment'));
  const {s: silent} = await assignOnce();
  assert.ok((await silent.finish()).refusals.includes('step_not_recorded:program_assignment'));
});

test('a replay the plan requires must be observed as a replay', async () => {
  const plan = [{step: 'assignment_replay', kind: 'assignment', requirement: 'must_replay'}];
  for (const [duplicate, refused] of [[false, true], [true, false]]) {
    const {s} = await session({api: fictionalApi({duplicate}), plan});
    await s.read('consumer', '/clinical-core/consumer/programs', {action: 'list'}, 200);
    const replay = await s.write('assignment_replay', 'workforce', '/clinical-core/workforce/programs',
      {action: 'assign', connectionId: CONNECTION, programVersionId: VERSION}, 200);
    s.reused('assignment_replay', replay, 'second_assign');
    assert.equal((await s.finish()).refusals.includes('replay_not_observed:assignment_replay'), refused, `duplicate=${duplicate}`);
  }
});

// ---- Provider-shaped JSON and purchases. ----
const PROVIDER_SHAPES = [
  {object: 'checkout.session', id: 'cs_test_fictional', payment_status: 'paid', amount_total: 0},
  {signedTransactionInfo: 'fictional', originalTransactionId: '0', environment: 'Sandbox'},
  {purchaseToken: 'fictional', orderId: 'GPA.0000-0000-0000-00000', purchaseState: 0, acknowledgementState: 1},
  {treatment_plan: {id: 'fictional', state: 'active'}},
];
test('store and provider receipts supplied as evidence are refused', () => {
  const m = need();
  for (const shape of PROVIDER_SHAPES) {
    const {refusals} = m.evaluateHostedProgramAcceptance({evidence: [shape]});
    for (const code of ['evidence_not_observed', 'provider_shaped_evidence']) assert.ok(refusals.includes(code), `${code} for ${Object.keys(shape)}`);
    assert.equal(m.providerShaped(shape), true);
  }
  assert.equal(m.providerShaped({data: {action: 'list', assignments: [], review: {held: ['supp-1']}}}), false);
});

test('a purchase step is never sent and never accepted', async () => {
  const m = need(), plan = [{step: 'program_purchase', kind: 'purchase', requirement: 'must_create'}];
  const {s, api} = await session({plan});
  await s.read('consumer', '/clinical-core/consumer/programs', {action: 'list'}, 200);
  await assert.rejects(s.write('program_purchase', 'consumer', '/clinical-core/consumer/programs', {action: 'purchase'}, 200),
    refusedWith('purchase_simulation_refused:program_purchase'));
  assert.deepEqual(api.requests.map(r => r.action), ['list']);
  const listed = s.responses()[0];
  s.created('program_purchase', listed);
  const report = await s.finish();
  assert.ok(report.refusals.includes('purchase_simulation_refused:program_purchase'));
  assert.equal(report.purchasesObserved, 0);
  assert.ok(m.evaluateHostedProgramAcceptance({}).purchasesObserved === 0);
});

test('a provider-shaped answer from the API itself is refused', async () => {
  const {s} = await session({api: fictionalApi({providerBody: true})});
  assert.ok((await journey(s)).refusals.includes('provider_shaped_evidence:program_assignment'));
});

test('the program and settlement smoke outputs are not admissible in any position', async () => {
  const m = need();
  const programSmoke = {verdict: 'pass', account: P.account, phiAllowed: false, deployedSourceCommit: fictional('smoke commit', 40),
    deployedArtifactSha256: fictional('smoke artifact'), observed: {fictionalAssignmentAccepted: true, fictionalFormCreatedOrReused: true}};
  const settlementSmoke = {execution: 'synthetic-staging-real-jwt-settlement', apiAcceptance: true, verdict: 'pass',
    sourceCommit: PAIR_COMMIT, artifactSha256: ZIP, passed: ['send_first_reports_committed']};
  for (const smoke of [programSmoke, settlementSmoke]) {
    assert.ok(m.evaluateHostedProgramAcceptance({before: smoke, after: smoke}).refusals.includes('observation_not_from_adapter'));
    assert.ok(m.evaluateHostedProgramAcceptance({evidence: [smoke]}).refusals.includes('evidence_not_observed'));
  }
  assert.ok((await bind({}, {deploymentClaim: programSmoke})).binding.refusals.includes('deployment_claim_disagrees'));
});

// ---- The command line refuses before any AWS call. ----
test('the acceptance command refuses unknown or relative arguments without calling AWS', () => {
  const script = fileURLToPath(new URL('./hosted-program-acceptance.mjs', import.meta.url));
  for (const args of [[], ['--observe-read-only', '--reviewed-artifact=candidate.zip'], ['--observe-read-only', '--journey'],
    ['--observe-read-only', '--observe-read-only']]) {
    const run = spawnSync(process.execPath, [script, ...args], {encoding: 'utf8', env: {PATH: ''}, timeout: 30000});
    assert.equal(run.status, 1, args.join(' '));
    assert.match(run.stderr, /hosted_program_acceptance_refused:arguments/);
  }
});

// ---- The smoke scripts stay smoke: labelled in their header, body and output unchanged. ----
const SMOKE = {
  'verify-synthetic-program-routes-hosted.mjs': 'da8e008f5b4cdc57e4932300f3da3f308c41d8682ab23c30e86d35f4287703a7',
  'verify-settlement-hosted.mjs': '18920a2c110dededa771d7d6b19c1f7cdcac642aa74b03aba1910a257b7e79a0',
  'qualify-aws-daily-guidance-hosted.mjs': '160c732c0cb083a97574f9d5523ea6f4ecc3e1af2e09595a85569d21ecc7b426',
};
const smokeText = file => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
function split(text) {
  let body = text;
  for (;;) {const m = /^(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)\n/.exec(body); if (!m) break; body = body.slice(m[0].length);}
  return {header: text.slice(0, text.length - body.length), body};
}
test('each hosted smoke script says SMOKE in its header and names the separate acceptance path', () => {
  for (const file of Object.keys(SMOKE)) {
    const {header} = split(smokeText(file));
    assert.match(header, /\bSMOKE\b/, file);
    assert.match(header, /not acceptance evidence/, file);
    assert.match(header, /scripts\/hosted-program-acceptance\.mjs/, file);
  }
});
test('coverage: each smoke script body (its logic and its printed output) is byte-identical to the base', () => {
  for (const [file, digest] of Object.entries(SMOKE)) assert.equal(sha256(split(smokeText(file)).body), digest, file);
});
test('coverage: the gaps the qualification packet names are still present in the smoke bodies', () => {
  const program = split(smokeText('verify-synthetic-program-routes-hosted.mjs')).body;
  assert.equal(program.match(/deployedSourceCommit/g).length, 2, 'declared and printed only');
  assert.doesNotMatch(program, /[!=]==\s*deployedSourceCommit|deployedSourceCommit\s*[!=]==/);
  assert.doesNotMatch(program, /x-clinical-execution/);
  assert.match(program, /fictionalFormCreatedOrReused:true/);
  assert.equal(program.match(/verdict:'pass'/g).length, 1);
  const settlement = split(smokeText('verify-settlement-hosted.mjs')).body;
  assert.match(settlement, /readFileSync\('dist\/settlement-qualification\/deployment\.json'/);
  assert.match(settlement, /evidence\.sourceCommit = deploy\.sourceCommit/);
  assert.doesNotMatch(settlement, /x-clinical-execution/);
  const guidance = split(smokeText('qualify-aws-daily-guidance-hosted.mjs')).body;
  assert.doesNotMatch(guidance, /describe-stacks|CodeSha256|SourceCommit|x-clinical-execution/);
  assert.match(guidance, /generated\.provider !== "openai"/);
});
