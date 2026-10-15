import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateQualificationProgramPreflight } from './preflight-qualification-program-api.mjs';

const template = JSON.parse(readFileSync('infra/aws-clinical-core/qualification-program-api-successor.json', 'utf8'));
const pair = (key, value) => ({ OutputKey: key, OutputValue: value });
const param = (key, value) => ({ ParameterKey: key, ParameterValue: value });
const text = value => ({ stringValue: value });
const integer = value => ({ longValue: value });
const boolean = value => ({ booleanValue: value });
function fixture() {
  const commit = 'a'.repeat(40), bundle = 'b'.repeat(64);
  const consumer = template.Parameters.ConsumerUserPoolId.AllowedValues[0];
  const consumerClient = template.Parameters.ConsumerUserPoolClientId.AllowedValues[0];
  const workforce = template.Parameters.WorkforceUserPoolId.AllowedValues[0];
  const workforceClient = template.Parameters.WorkforceUserPoolClientId.AllowedValues[0];
  return {
    caller: { Account: '588966314750', Arn: 'arn:aws:sts::588966314750:assumed-role/OrganizationAccountAccessRole/test' },
    sourceCommit: commit, sourceClean: true, bundleSha256: bundle,
    buildIdentity: { contract: 'qualification-program-bundle/1', sourceCommit: commit,
      boundaryCandidateSha256: '0f07717d240d981b3900f6c2e926aa79025157f916e869c4a74def52214261a6', bundleSha256: bundle },
    template,
    foundation: { StackStatus: 'CREATE_COMPLETE', Outputs: [
      pair('ApiId', '6zt8e9qz04'), pair('DatabaseName', 'clinical_core_qualification'),
      pair('PhiAllowed', 'false'), pair('Activation', 'blocked'), pair('QualificationExecution', 'disabled'),
      pair('DataClassification', 'synthetic_only'), pair('CodeBucket', 'alp-qualification-code-588966314750-us-east-2'),
      pair('AlarmTopicArn', 'arn:aws:sns:us-east-2:588966314750:ai-clinical-core-qualification-alarms'),
      pair('DatabaseClusterArn', template.Parameters.DatabaseClusterArn.AllowedValues[0]),
      pair('LogsKmsKeyArn', template.Parameters.ClinicalCoreKeyArn.AllowedValues[0]),
    ] },
    billing: { StackStatus: 'CREATE_COMPLETE', Parameters: [
      param('BillingActivation', 'blocked'), param('CommercialReleaseApproval', 'blocked'),
      param('EnabledStores', 'none'), param('StoreEnvironment', 'Sandbox'), param('StoreSecretArn', ''),
      param('ReservedConcurrency', '0'), param('ConsumerPoolId', consumer), param('ConsumerClientId', consumerClient),
    ], Outputs: [pair('Activation', 'blocked'), pair('ApiOrigin', 'https://qeep30uo68.execute-api.us-east-2.amazonaws.com')] },
    routes: { Items: Array.from({ length: 32 }, (_, i) => ({ RouteKey: `GET /clinical-core/consumer/existing-${i}` })) },
    authorizers: { Items: [
      { AuthorizerType: 'JWT', JwtConfiguration: { Issuer: `https://cognito-idp.us-east-2.amazonaws.com/${consumer}`, Audience: [consumerClient] } },
      { AuthorizerType: 'JWT', JwtConfiguration: { Issuer: `https://cognito-idp.us-east-2.amazonaws.com/${workforce}`, Audience: [workforceClient] } },
    ] },
    database: { records: [[text('clinical_core_qualification'), integer(112),
      text('45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4'), boolean(false), integer(0),
      boolean(false), boolean(false), text('83ce2f61711f9fa8b94962cf9330af8eb2e0c984a55e4c0edf2a40764c8a31af'),
      text('d9c07fec841cd1d68689be602c933fa67cddd343f4ee5228f336efe9362c981d'), integer(0),
      integer(1), integer(1), integer(1), integer(1), integer(1)]] },
  };
}
test('only the exact blocked synthetic target passes the read-only preflight', () => {
  assert.deepEqual(evaluateQualificationProgramPreflight(fixture()), {
    contract: 'qualification-program-api-preflight/1', account: '588966314750', region: 'us-east-2',
    database: 'clinical_core_qualification', sourceCommit: 'a'.repeat(40), programRouteVacant: true,
    reviewedBoundaryInstalledButDisabled: true, qualificationSubjects: 0,
    designatedFictionalAccountsBound: true, billing: 'blocked', phiAllowed: false,
    templateSha256: evaluateQualificationProgramPreflight(fixture()).templateSha256, bundleSha256: 'b'.repeat(64),
    changeSetReady: false, reason: 'requires_reviewed_subjects_and_separate_deployment_review',
  });
});
test('refuses an account, source, billing, route, authorizer, or database drift', () => {
  const changes = [
    x => { x.caller.Account = '173535830222'; },
    x => { x.buildIdentity.sourceCommit = 'c'.repeat(40); },
    x => { x.billing.Parameters[0].ParameterValue = 'approved'; },
    x => { x.billing.Parameters[6].ParameterValue = 'us-east-2_other'; },
    x => { x.routes.Items[0].RouteKey = 'POST /clinical-core/consumer/programs'; },
    x => { x.authorizers.Items[0].JwtConfiguration.Audience = ['wrong']; },
    x => { x.database.records[0][2] = text('c'.repeat(64)); },
    x => { x.database.records[0][3] = boolean(true); },
    x => { x.database.records[0][4] = integer(1); },
    x => { x.database.records[0][8] = text('c'.repeat(64)); },
    x => { x.database.records[0][10] = integer(0); },
    x => { x.database.records[0][11] = integer(0); },
    x => { x.database.records[0][12] = integer(0); },
    x => { x.database.records[0][13] = integer(0); },
    x => { x.database.records[0][14] = integer(0); },
  ];
  for (const change of changes) {
    const observed = fixture(); change(observed);
    assert.throws(() => evaluateQualificationProgramPreflight(observed), /qualification_program_preflight_refused/);
  }
});
