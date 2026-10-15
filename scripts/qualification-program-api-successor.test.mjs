import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const source = JSON.parse(readFileSync('infra/aws-clinical-core/qualification-program-api-candidate.json', 'utf8'));
const candidate = JSON.parse(readFileSync('infra/aws-clinical-core/qualification-program-api-successor.json', 'utf8'));
const boundary = JSON.parse(readFileSync('infra/aws-clinical-core/source-candidates/qualification-program-boundary.json', 'utf8'));

test('successor is generated from the unchanged first candidate and reviewed boundary identity', () => {
  execFileSync(process.execPath, ['scripts/build-qualification-program-api-successor.mjs', '--check']);
  assert.equal(source.Metadata.ClinicalCore.ContractVersion, 'qualification-program-api-candidate/1');
  assert.equal(candidate.Metadata.ClinicalCore.ContractVersion, 'qualification-program-api-candidate/2');
  assert.equal(candidate.Metadata.ClinicalCore.RuntimeSchemaRequirement.BoundaryCandidateSha256, boundary.successor.sha256);
  assert.equal(candidate.Metadata.ClinicalCore.RuntimeSchemaRequirement.MigrationReleaseSha256, boundary.ledger.migrationReleaseSha256);
  assert.equal(candidate.Metadata.ClinicalCore.RuntimeSchemaRequirement.Function, 'clinical_core.production_program_bounded_request(jsonb)');
  assert.equal(candidate.Metadata.ClinicalCore.PhiAllowed, false);
  assert.equal(candidate.Metadata.ClinicalCore.Activation, 'blocked');
});

test('the successor admits only two JWT-protected routes and cannot accidentally open PHI or purchase', () => {
  const resources = candidate.Resources;
  assert.deepEqual(Object.keys(resources).sort(), Object.keys(source.Resources).sort());
  const routes = Object.values(resources).filter(resource => resource.Type === 'AWS::ApiGatewayV2::Route');
  assert.deepEqual(routes.map(route => route.Properties.RouteKey).sort(), [
    'POST /clinical-core/consumer/programs', 'POST /clinical-core/workforce/programs',
  ]);
  assert.ok(routes.every(route => route.Properties.AuthorizationType === 'JWT'));
  assert.equal(candidate.Parameters.DatabaseName.AllowedValues[0], 'clinical_core_qualification');
  assert.equal(candidate.Parameters.ClinicalApiId.AllowedValues[0], '6zt8e9qz04');
  const e = resources.IdentityApiFunction.Properties.Environment.Variables;
  assert.equal(e.PHI_ALLOWED, 'false');
  assert.equal(e.PROGRAM_ACTIVATION, 'blocked');
  assert.equal(e.QUALIFICATION_EXECUTION, 'enabled');
  assert.equal(e.DEPLOYMENT_ACCOUNT_ID, '588966314750');
  assert.equal(e.MIGRATION_RELEASE_SHA256, boundary.ledger.migrationReleaseSha256);
  assert.equal(e.QUALIFICATION_PROGRAM_BOUNDARY_SHA256, boundary.successor.sha256);
  assert.deepEqual(e.QUALIFICATION_BILLING_API_ORIGIN, { Ref: 'QualificationBillingApiOrigin' });
  assert.deepEqual(e.QUALIFICATION_IDENTITY_SUBJECTS, { Ref: 'QualificationIdentitySubjects' });
  assert.deepEqual(resources.IdentityApiFunction.Properties.Code.S3ObjectVersion, { Ref: 'LambdaCodeVersion' });
  assert.ok(!('CLINICAL_CONSUMER_ISSUER' in e) && !('CLINICAL_WORKFORCE_ISSUER' in e));
  assert.ok(!JSON.stringify(candidate).includes('program_assignment_request(jsonb)'));
  assert.ok(!JSON.stringify(candidate).includes('synthetic_desktop_program_versions'));
  assert.ok(!JSON.stringify(candidate).includes('PhiAllowed=true'));
  const actions = resources.IdentityApiRole.Properties.Policies.flatMap(policy => policy.PolicyDocument.Statement)
    .flatMap(statement => statement.Action);
  assert.ok(!actions.some(action => action === '*' || action.startsWith('s3:') || action.startsWith('ses:')));
});
