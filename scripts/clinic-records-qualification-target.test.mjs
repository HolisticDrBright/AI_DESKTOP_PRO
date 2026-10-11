import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { clinicTargetFixture } from './clinic-records-qualification-target.fixture.mjs';
import { observeClinicTarget } from './clinic-records-qualification-target.mjs';
import { createHostedPorts, runClinicRecordsQualification } from './clinic-records-qualification-runner.mjs';
import { CLINIC_RECORDS_QUALIFICATION_SUBJECTS } from './clinic-records-qualification-report.mjs';

// Fictional AWS responses and ledger only. The Vitest suite separately checks
// the actual PostgreSQL database name and runs all thirty real handler cases.
const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
const sha = s => createHash('sha256').update(s).digest('hex'), candidate = artifact.candidate;
const subjects = Object.fromEntries(CLINIC_RECORDS_QUALIFICATION_SUBJECTS.map((key, i) => [key, `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
const binding = { contract: 'clinic-records-qualification-binding/1', sourceCommit: '1'.repeat(40), migrationReleaseSha256: candidate.migrationReleaseSha256,
  extensionSha256: candidate.extensionSha256, apiId: 'abcdefghij', organizationId: '11111111-1111-4111-8111-111111111111', otherOrganizationId: '22222222-2222-4222-8222-222222222222',
  consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalC', consumerAudience: 'c'.repeat(26),
  workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalW', workforceAudience: 'w'.repeat(26), subjects,
  reviews: { disclosure: '2'.repeat(64), retention: '3'.repeat(64), workforceMfa: '4'.repeat(64), qualification: '5'.repeat(64) },
  disclosureRelease: { releaseVersion: 'fictional-qualification-1', sections: ['signed_notes', 'lab_observations'], reviewSha256: '2'.repeat(64) } };
const migrations = artifact.manifest.migrations.map(row => ({ version: row.version, sha256: sha(artifact.files[row.file]) }));
const base = clinicTargetFixture(binding, candidate, migrations);
function input(transform = (_key, value) => value) {
  const calls = [], i = { binding, candidate, target: structuredClone(base.target), deployment: { ...base.deployment, manifest: structuredClone(base.deployment.manifest) }, migrations: structuredClone(migrations),
    ports: { readAws: async (service, operation, args) => { calls.push(`${service}/${operation}`); return transform(`${service}/${operation}`, structuredClone(await base.readAws(service, operation, args)), args); },
      sql: async () => ({ rows: [{ database: 'clinical_core_qualification', ledger: structuredClone(migrations) }] }) } };
  return { i, calls };
}
test('independently observes all metadata and the exact ordered ledger without a write operation', async () => {
  const { i, calls } = input(); const result = await observeClinicTarget(i);
  assert.equal(result.database, 'clinical_core_qualification'); assert.equal(result.sourceCommit, binding.sourceCommit);
  assert.equal(result.migrationRows, 114); assert.equal(result.phiAllowed, false); assert.equal(result.humanReviewsVerified, false);
  assert.equal(result.atomicAwsSnapshot, false); assert.ok(calls.includes('lambda/get-function')); assert.ok(calls.includes('secretsmanager/describe-secret'));
  assert.ok(calls.every(c => /\/(get-|describe-|list-)/.test(c))); assert.ok(!JSON.stringify(result).includes('Location'));
});

const mutations = [
  ['root principal', 'sts/get-caller-identity', r => { r.Arn = 'arn:aws:iam::588966314750:root'; }, 'target_principal'],
  ['production account', 'sts/get-caller-identity', r => { r.Account = '173535830222'; }, 'target_principal'],
  ['unfinished stack', 'cloudformation/describe-stacks', r => { r.Stacks[0].StackStatus = 'UPDATE_IN_PROGRESS'; }, 'target_stack'],
  ['different foundation cluster', 'cloudformation/describe-stacks', r => { if (r.Stacks[0].StackId === base.target.foundationStackArn) r.Stacks[0].Parameters[0].ParameterValue += '-wrong'; }, 'target_foundation'],
  ['different candidate database', 'cloudformation/describe-stacks', r => { if (r.Stacks[0].StackId === base.target.candidateStackArn) r.Stacks[0].Parameters.find(p => p.ParameterKey === 'DatabaseName').ParameterValue = 'clinical_core'; }, 'target_stack_parameters'],
  ['extra stack parameter', 'cloudformation/describe-stacks', r => { if (r.Stacks[0].StackId === base.target.candidateStackArn) r.Stacks[0].Parameters.push({ ParameterKey: 'unreviewed', ParameterValue: 'yes' }); }, 'target_stack_parameters'],
  ['changed template permission', 'cloudformation/get-template', r => { r.TemplateBody.Description += ' changed'; }, 'target_foundation_template'],
  ['partial resource listing', 'cloudformation/list-stack-resources', r => { r.NextToken = 'unread'; }, 'target_resource_pagination'],
  ['wrong Lambda physical id', 'cloudformation/list-stack-resources', r => { r.StackResourceSummaries.find(p => p.LogicalResourceId === 'Function').PhysicalResourceId = 'another'; }, 'target_function_binding'],
  ['unencrypted cluster', 'rds/describe-db-clusters', r => { r.DBClusters[0].StorageEncrypted = false; }, 'target_database_resources'],
  ['deleted secret metadata', 'secretsmanager/describe-secret', r => { r.DeletedDate = '2026-10-10'; }, 'target_database_resources'],
  ['different API origin', 'apigatewayv2/get-api', r => { r.ApiEndpoint = 'https://different.example'; }, 'target_api'],
  ['unpublished route configuration', 'apigatewayv2/get-stage', r => { r.AutoDeploy = false; }, 'target_stage'],
  ['incomplete API deployment', 'apigatewayv2/get-deployment', r => { r.DeploymentStatus = 'PENDING'; }, 'target_stage_deployment'],
  ['different deployed zip despite matching env', 'lambda/get-function', r => { r.Configuration.CodeSha256 = Buffer.alloc(32, 4).toString('base64'); }, 'target_lambda'],
  ['PHI enabled in function', 'lambda/get-function', r => { r.Configuration.Environment.Variables.PHI_ALLOWED = 'true'; }, 'target_lambda'],
  ['missing subject binding', 'lambda/get-function', r => { delete r.Configuration.Environment.Variables.QUALIFICATION_IDENTITY_SUBJECTS; }, 'target_lambda'],
  ['unreviewed extra env', 'lambda/get-function', r => { r.Configuration.Environment.Variables.UNREVIEWED_ENDPOINT = 'https://different.example'; }, 'target_lambda'],
  ['duplicate route', 'apigatewayv2/get-routes', r => { r.Items.push({ ...r.Items[0] }); }, 'target_route'],
  ['unauthenticated route', 'apigatewayv2/get-routes', r => { r.Items[0].AuthorizationType = 'NONE'; }, 'target_route'],
  ['wrong JWT audience', 'apigatewayv2/get-authorizer', r => { r.JwtConfiguration.Audience = ['another']; }, 'target_route_authority'],
  ['wrong integration', 'apigatewayv2/get-integration', r => { r.IntegrationUri += '-wrong'; }, 'target_route_authority'],
];
for (const [name, operation, mutate, expected] of mutations) test(`refuses ${name} before any HTTP dispatch or release callback`, async () => {
  const { i } = input((key, response) => { if (key === operation) mutate(response); return response; });
  let http = 0, release = 0;
  const result = await runClinicRecordsQualification({ ...i, tokens: {}, fixtures: { signedNoteText: 'Fictional signed', draftNoteText: 'Fictional draft' },
    ports: { ...i.ports, http: async () => { http++; throw Error('unexpected_http'); } }, awaitRelease: async () => { release++; } });
  assert.equal(result.refusal, expected); assert.equal(result.complete, false); assert.equal(result.verdict, null);
  assert.equal(http, 0); assert.equal(release, 0); assert.deepEqual(result.report.cases, []); assert.equal(result.report.target, null);
});
for (const [name, change] of [
  ['same count but changed hash', rows => { rows[4].sha256 = 'a'.repeat(64); }],
  ['reordered rows', rows => { [rows[2], rows[3]] = [rows[3], rows[2]]; }],
  ['duplicate migration version', rows => { rows[2].version = rows[1].version; }],
  ['truncated ledger', rows => rows.pop()],
]) test(`refuses ${name}, not merely a migration count`, async () => {
  const { i } = input(), ledger = structuredClone(migrations); change(ledger);
  i.ports.sql = async () => ({ rows: [{ database: 'clinical_core_qualification', ledger }] });
  await assert.rejects(observeClinicTarget(i), { category: 'target_actual_ledger' });
});
test('paginates routes and detects a second-page duplicate rather than accepting the first page', async () => {
  const { i } = input(); const read = i.ports.readAws; let pages = 0;
  i.ports.readAws = async (s, o, a) => o === 'get-routes' ? (++pages === 1 ? { Items: base.snapshots.routes, NextToken: 'next' } : { Items: [base.snapshots.routes[0]] }) : read(s, o, a);
  await assert.rejects(observeClinicTarget(i), { category: 'target_route' }); assert.equal(pages, 2);
});
test('successful second route page is examined', async () => {
  const { i } = input(); const read = i.ports.readAws; let pages = 0;
  i.ports.readAws = async (s, o, a) => o === 'get-routes' ? (++pages === 1 ? { Items: [base.snapshots.routes[0]], NextToken: 'next' } : { Items: [base.snapshots.routes[1]] }) : read(s, o, a);
  await observeClinicTarget(i); assert.equal(pages, 2);
});
test('missing observer cannot be replaced by environment booleans', async () => {
  const { i } = input(); delete i.ports.readAws; i.target.hostedVerified = true;
  await assert.rejects(observeClinicTarget(i), { category: 'target_observer_required' });
});
test('tampered local zip is refused before any AWS observation', async () => {
  const { i, calls } = input(); i.deployment.zip = Buffer.from('different bytes');
  await assert.rejects(observeClinicTarget(i), { category: 'target_local_artifact' }); assert.equal(calls.length, 0);
});
test('an unmarked denial cannot masquerade as a qualification response', async () => {
  const { i } = input(), now = Date.now(); let dispatches = 0;
  i.ports.sql = async text => ({ rows: text.includes('current_database()') ? [{ database: 'clinical_core_qualification', ledger: migrations }] : [] });
  const token = `e30.${Buffer.from(JSON.stringify({ sub: subjects.patientA, auth_time: Math.floor(now / 1000) - 16 * 60 })).toString('base64url')}.fictional`;
  const result = await runClinicRecordsQualification({ ...i, tokens: { patientA: { stale: token } }, fixtures: { signedNoteText: 'Fictional signed', draftNoteText: 'Fictional draft' },
    now: () => now, ports: { ...i.ports, hostedVerified: true, http: async () => { dispatches++; return { status: 403, json: { error: 'forbidden' } }; } }, awaitRelease: async () => { throw Error('unexpected_release'); } });
  assert.equal(dispatches, 1); assert.equal(result.refusal, 'response_execution_unverified'); assert.equal(result.verdict, null);
  assert.equal(result.report.evidenceKind, 'embedded'); assert.equal(result.report.cases[0].observed, false);
});
test('direct hosted invocation cannot supply arbitrary build metadata to bypass the clean CLI build', async () => {
  const { i } = input(); let reads = 0, requests = 0, releases = 0;
  // Constructing SDK ports is inert: credential providers are lazy. Replace
  // every transport with a counting refusal so this test makes no AWS call.
  const ports = await createHostedPorts(i.target);
  ports.readAws = async () => { reads++; throw Error('unexpected_aws'); };
  ports.sql = async () => { reads++; throw Error('unexpected_sql'); };
  ports.http = async () => { requests++; throw Error('unexpected_http'); };
  const result = await runClinicRecordsQualification({ ...i, ports, tokens: {}, fixtures: { signedNoteText: 'Fictional signed', draftNoteText: 'Fictional draft' },
    awaitRelease: async () => { releases++; } });
  assert.equal(result.refusal, 'hosted_local_build_required'); assert.equal(result.verdict, null);
  assert.equal(reads, 0); assert.equal(requests, 0); assert.equal(releases, 0); assert.equal(result.report.target, null);
});
