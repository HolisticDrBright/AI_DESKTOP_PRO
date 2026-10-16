import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateQualificationProgramUpdatePreflight } from './preflight-qualification-program-api-update.mjs';

const template = JSON.parse(readFileSync('infra/aws-clinical-core/qualification-program-api-restricted-credential.json', 'utf8'));
const param = (ParameterKey, ParameterValue) => ({ ParameterKey, ParameterValue });
const out = (OutputKey, OutputValue) => ({ OutputKey, OutputValue });
const str = stringValue => ({ stringValue });
const num = longValue => ({ longValue });
const bool = booleanValue => ({ booleanValue });
const lambdaArn = 'arn:aws:lambda:us-east-2:588966314750:function:6zt8e9qz04-qualification-bound-programs';
const deployedCommit = '46dd96fb39d0c78ecd9947c1215687b6a32d49af';
const oldSecret = 'arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-test';
function fixture() {
  const sourceCommit = 'a'.repeat(40), bundleSha256 = 'b'.repeat(64);
  const integrationId = 'flcrskp';
  const consumerPool = template.Parameters.ConsumerUserPoolId.AllowedValues[0];
  const consumerClient = template.Parameters.ConsumerUserPoolClientId.AllowedValues[0];
  const workforcePool = template.Parameters.WorkforceUserPoolId.AllowedValues[0];
  const workforceClient = template.Parameters.WorkforceUserPoolClientId.AllowedValues[0];
  return {
    caller: { Account: '588966314750', Arn: 'arn:aws:sts::588966314750:assumed-role/OrganizationAccountAccessRole/test' },
    sourceCommit, sourceClean: true, bundleSha256,
    buildIdentity: { contract: 'qualification-program-bundle/1', sourceCommit, bundleSha256,
      boundaryCandidateSha256: '0f07717d240d981b3900f6c2e926aa79025157f916e869c4a74def52214261a6' },
    template,
    stack: { StackStatus: 'UPDATE_COMPLETE', Parameters: [
      param('SourceCommit', deployedCommit), param('ClinicalApiId', '6zt8e9qz04'),
      param('DatabaseName', 'clinical_core_qualification'),
      param('ConsumerUserPoolId', consumerPool), param('ConsumerUserPoolClientId', consumerClient),
      param('WorkforceUserPoolId', workforcePool), param('WorkforceUserPoolClientId', workforceClient),
      param('QualificationProgramOrganizationId', 'a82dafa6-190f-4769-bb0a-89f4f318b5aa'),
      param('QualificationIdentitySubjects', 'a16b2580-9091-709c-26f5-543bc0f312a9,815b1540-10d1-706c-53f9-6955699ac385,31db0500-60b1-70b4-9046-371730a55db5'),
      param('DatabaseClusterArn', template.Parameters.DatabaseClusterArn.AllowedValues[0]),
      param('QualificationBillingApiOrigin', 'https://qeep30uo68.execute-api.us-east-2.amazonaws.com'),
    ], Outputs: [out('FunctionArn', lambdaArn), out('PhiAllowed', 'false'),
      out('QualificationExecution', 'programs_fictional_only')] },
    routes: { Items: [
      { RouteKey: 'POST /clinical-core/consumer/programs', Target: `integrations/${integrationId}`,
        AuthorizationType: 'JWT', AuthorizerId: 'consumer-auth' },
      { RouteKey: 'POST /clinical-core/workforce/programs', Target: `integrations/${integrationId}`,
        AuthorizationType: 'JWT', AuthorizerId: 'workforce-auth' },
    ] },
    integration: { IntegrationType: 'AWS_PROXY', IntegrationUri: lambdaArn, PayloadFormatVersion: '2.0' },
    authorizers: { Items: [
      { AuthorizerId: 'consumer-auth', AuthorizerType: 'JWT', JwtConfiguration: {
        Issuer: `https://cognito-idp.us-east-2.amazonaws.com/${consumerPool}`, Audience: [consumerClient] } },
      { AuthorizerId: 'workforce-auth', AuthorizerType: 'JWT', JwtConfiguration: {
        Issuer: `https://cognito-idp.us-east-2.amazonaws.com/${workforcePool}`, Audience: [workforceClient] } },
    ] },
    lambda: { FunctionArn: lambdaArn, State: 'Active', LastUpdateStatus: 'Successful',
      CodeSha256: '575Fr1TJFj7yxh9oFjjNWS8Kv7ABlu5TOFCA4yV1qsc=',
      Environment: { Variables: { SOURCE_COMMIT: deployedCommit, PHI_ALLOWED: 'false',
        PROGRAM_ACTIVATION: 'blocked', QUALIFICATION_EXECUTION: 'enabled',
        CLINICAL_DATABASE_NAME: 'clinical_core_qualification', CLINICAL_DATABASE_SECRET_ARN: oldSecret,
        QUALIFICATION_PROGRAM_BOUNDARY_SHA256: '0f07717d240d981b3900f6c2e926aa79025157f916e869c4a74def52214261a6',
        MIGRATION_RELEASE_SHA256: '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4' } } },
    database: { records: [[str('clinical_core_qualification'), num(112),
      str('45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4'),
      bool(true), num(3), bool(false), bool(false),
      str('83ce2f61711f9fa8b94962cf9330af8eb2e0c984a55e4c0edf2a40764c8a31af'),
      str('d9c07fec841cd1d68689be602c933fa67cddd343f4ee5228f336efe9362c981d'),
      num(1), num(1), num(1), num(1), num(1), num(1)]] },
  };
}

test('a populated, blocked fictional target is observed but never approved for update', () => {
  const result = evaluateQualificationProgramUpdatePreflight(fixture());
  assert.equal(result.contract, 'qualification-program-api-update-preflight/1');
  assert.equal(result.deployedSourceCommit, deployedCommit);
  assert.equal(result.targetSourceCommit, 'a'.repeat(40));
  assert.equal(result.existingAssignments, 1);
  assert.equal(result.changeSetReady, false);
  assert.equal(result.reason, 'restricted_credential_and_owner_review_required');
});
test('source, current stack, route, authorizer, Lambda and database drift each refuse', () => {
  const changes = [
    x => { x.caller.Account = '173535830222'; },
    x => { x.sourceClean = false; },
    x => { x.buildIdentity.sourceCommit = 'c'.repeat(40); },
    x => { x.template.Metadata.ClinicalCore.Activation = 'approved'; },
    x => { x.stack.StackStatus = 'UPDATE_IN_PROGRESS'; },
    x => { x.stack.Parameters[0].ParameterValue = 'c'.repeat(40); },
    x => { x.stack.Outputs[1].OutputValue = 'true'; },
    x => { x.routes.Items[0].Target = 'integrations/other'; },
    x => { x.routes.Items[1].AuthorizationType = 'NONE'; },
    x => { x.integration.IntegrationUri = 'arn:aws:lambda:us-east-2:588966314750:function:other'; },
    x => { x.authorizers.Items[0].JwtConfiguration.Audience = ['other']; },
    x => { x.lambda.Environment.Variables.SOURCE_COMMIT = 'c'.repeat(40); },
    x => { x.lambda.Environment.Variables.CLINICAL_DATABASE_SECRET_ARN = 'arn:aws:secretsmanager:us-east-2:588966314750:secret:other'; },
    x => { x.database.records[0][2] = str('c'.repeat(64)); },
    x => { x.database.records[0][3] = bool(false); },
    x => { x.database.records[0][4] = num(2); },
    x => { x.database.records[0][5] = bool(true); },
    x => { x.database.records[0][9] = num(0); },
    x => { x.database.records[0][14] = num(0); },
  ];
  for (const change of changes) {
    const input = fixture(); change(input);
    assert.throws(() => evaluateQualificationProgramUpdatePreflight(input),
      /qualification_program_update_preflight_refused/);
  }
});
