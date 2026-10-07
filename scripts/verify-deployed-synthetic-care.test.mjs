import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {DEPLOYED_CARE as D, verifyDeployedCareArtifact, verifyDeployedCareObservation, verifyDeployedCareRole} from './verify-deployed-synthetic-care.mjs';
const source = JSON.parse(readFileSync(new URL('../infra/aws-clinical-core/identity-api-extension.json', import.meta.url), 'utf8'));
const key = `clinical-core/authenticated-api/care-release/${D.desktop}/${D.zip}.zip`;
const harness = {commit: 'a'.repeat(40), clean: true};
function observation() {
  const template = structuredClone(source); for (const name of P.absentRoutes) delete template.Resources[name];
  template.Outputs.RoutesEnabled.Value = '51'; template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion = D.version;
  const params = {ClinicalApiId: P.apiId, DatabaseName: P.database, DatabaseClusterArn: P.cluster, DatabaseSecretArn: '****',
    ConsumerUserPoolId: P.consumerPool, ConsumerUserPoolClientId: P.consumerClient, WorkforceUserPoolId: P.workforcePool,
    WorkforceUserPoolClientId: P.workforceClient, ClinicalCoreKeyArn: P.keyArn, LambdaCodeBucket: P.bucket, LambdaCodeKey: key};
  const outputs = {PhiAllowed: 'false', Environment: 'synthetic-staging', DataClassification: 'synthetic_only', DatabaseName: P.database,
    ClinicalApiId: P.apiId, DatabaseClusterArn: P.cluster, DatabaseSecretArn: P.secret};
  const roleName = 'fictional-role', roleArn = `arn:aws:iam::${P.account}:role/${roleName}`;
  const fn = {FunctionName: P.functionName, FunctionArn: `arn:aws:lambda:${P.region}:${P.account}:function:${P.functionName}`,
    CodeSha256: Buffer.from(D.zip, 'hex').toString('base64'), State: 'Active', LastUpdateStatus: 'Successful',
    Runtime: 'nodejs22.x', Handler: 'index.handler', Timeout: 29, MemorySize: 256, Architectures: ['arm64'], RevisionId: 'fictional-revision', Role: roleArn,
    Environment: {Variables: {CLINICAL_DATABASE_CLUSTER_ARN: P.cluster, CLINICAL_DATABASE_SECRET_ARN: P.secret, CLINICAL_DATABASE_NAME: P.database,
      CLINICAL_CONSUMER_ISSUER: `https://cognito-idp.${P.region}.amazonaws.com/${P.consumerPool}`, CLINICAL_CONSUMER_AUDIENCE: P.consumerClient,
      CLINICAL_WORKFORCE_ISSUER: `https://cognito-idp.${P.region}.amazonaws.com/${P.workforcePool}`, CLINICAL_WORKFORCE_AUDIENCE: P.workforceClient}}};
  const authorizers = {Items: [[P.consumerPool, P.consumerClient, 'consumer'], [P.workforcePool, P.workforceClient, 'workforce']].map(([pool, client, name]) => ({
    AuthorizerId: name, AuthorizerType: 'JWT', IdentitySource: ['$request.header.Authorization'],
    JwtConfiguration: {Issuer: `https://cognito-idp.${P.region}.amazonaws.com/${pool}`, Audience: [client]}}))};
  const routes = {Items: Object.values(template.Resources).filter(r => r.Type === 'AWS::ApiGatewayV2::Route').map(r => ({
    RouteKey: r.Properties.RouteKey, AuthorizationType: 'JWT', Target: 'integrations/identity',
    AuthorizerId: r.Properties.AuthorizerId.Ref === 'ConsumerJwtAuthorizer' ? 'consumer' : 'workforce'}))};
  const logName = '/ai-clinical-core/synthetic-staging/identity-api';
  const policy = (PolicyName, Statement) => ({RoleName: roleName, PolicyName, PolicyDocument: {Version: '2012-10-17', Statement}});
  return {caller: {Account: P.account, Arn: `arn:aws:sts::${P.account}:assumed-role/OrganizationAccountAccessRole/fictional`},
    foundation: {Stacks: [{StackStatus: 'UPDATE_COMPLETE', StackId: `arn:aws:cloudformation:${P.region}:${P.account}:stack/${P.foundation}/fictional`,
      Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({OutputKey, OutputValue}))}]},
    stack: {Stacks: [{StackStatus: 'UPDATE_COMPLETE', StackId: `arn:aws:cloudformation:${P.region}:${P.account}:stack/${P.stack}/fictional`,
      Parameters: Object.entries(params).map(([ParameterKey, ParameterValue]) => ({ParameterKey, ParameterValue}))}]},
    template, fn, authorizers, routes, integrations: {Items: [{IntegrationId: 'identity', IntegrationUri: fn.FunctionArn,
      IntegrationType: 'AWS_PROXY', PayloadFormatVersion: '2.0', TimeoutInMillis: 30000}]},
    database: {contract: 'care-erasure-schema-upgrade/1', command: 'inspect', operatorSource: {sourceCommit: harness.commit, clean: true},
      awsAccountId: P.account, foundation: P.foundation, execution: 'synthetic-staging', phiAllowed: false,
      observedMigrationCount: 46, sourceMigrationCount: 45, tableCount: 87, fromLedgerSha256: P.liveBefore, toLedgerSha256: P.liveAfter,
      referenceLedgerSha256: P.reference, dataPreserved: true, applied: false, alreadyApplied: false,
      acceptance: false, phiActivation: false, apiDeploymentPerformed: false, dataSha256: 'd'.repeat(64), rowCount: 23980},
    resources: {StackResources: [{LogicalResourceId: 'IdentityApiRole', PhysicalResourceId: roleName, ResourceType: 'AWS::IAM::Role', ResourceStatus: 'CREATE_COMPLETE'},
      {LogicalResourceId: 'IdentityApiLogGroup', PhysicalResourceId: logName, ResourceType: 'AWS::Logs::LogGroup', ResourceStatus: 'CREATE_COMPLETE'}]},
    role: {Role: {RoleName: roleName, Arn: roleArn, AssumeRolePolicyDocument: structuredClone(source.Resources.IdentityApiRole.Properties.AssumeRolePolicyDocument)}},
    attached: {IsTruncated: false, AttachedPolicies: []}, inline: {IsTruncated: false, PolicyNames: ['AuroraDataApiTransactionOnly', 'ManagedDatabaseCredentialRead', 'BoundedFunctionLogging']},
    policies: [policy('AuroraDataApiTransactionOnly', [{Effect: 'Allow', Action: ['rds-data:BeginTransaction', 'rds-data:ExecuteStatement', 'rds-data:CommitTransaction', 'rds-data:RollbackTransaction'], Resource: P.cluster}]),
      policy('ManagedDatabaseCredentialRead', [{Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: P.secret},
        {Effect: 'Allow', Action: 'kms:Decrypt', Resource: P.keyArn, Condition: {StringEquals: {'kms:ViaService': `secretsmanager.${P.region}.amazonaws.com`}}}]),
      policy('BoundedFunctionLogging', [{Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: `arn:aws:logs:${P.region}:${P.account}:log-group:${logName}:*`}])],
    logGroups: {logGroups: [{logGroupName: logName, retentionInDays: 30, kmsKeyId: P.keyArn}]}};
}
test('deployed successor verification preserves the historical guard and refuses all non-code drift', () => {
  const o = observation(), before = structuredClone(o);
  const result = verifyDeployedCareObservation(o, source, {key}, harness);
  assert.deepEqual(o, before); assert.equal(result.routeCount, 51); assert.equal(result.exactObjectVersion, D.version);
  for (const mutate of [o => delete o.template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion,
    o => o.template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion = 'latest', o => o.template.Outputs.RoutesEnabled.Value = '32',
    o => o.fn.CodeSha256 = Buffer.from(P.previousZipSha256, 'hex').toString('base64'),
    o => o.stack.Stacks[0].Parameters.find(p => p.ParameterKey === 'LambdaCodeKey').ParameterValue = 'other',
    o => o.database.operatorSource.sourceCommit = 'f'.repeat(40), o => o.database.observedMigrationCount = 47,
    o => o.database.fromLedgerSha256 = P.liveAfter, o => o.fn.Environment.Variables.CLINICAL_DATABASE_NAME = 'production',
    o => o.routes.Items[0].AuthorizationType = 'NONE', o => o.authorizers.Items[0].JwtConfiguration.Audience.push('other')]) {
    const changed = observation(); mutate(changed); assert.throws(() => verifyDeployedCareObservation(changed, source, {key}, harness));
  }
});
test('live IAM and log resources cannot drift independently of the unchanged template', () => {
  verifyDeployedCareRole(observation(), source);
  for (const mutate of [o => o.fn.Role = 'other', o => o.role.Role.PermissionsBoundary = {Arn: 'other'},
    o => o.role.Role.AssumeRolePolicyDocument.Statement[0].Principal.Service = 'ec2.amazonaws.com',
    o => o.attached.AttachedPolicies.push({PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess'}),
    o => o.attached.IsTruncated = true, o => o.inline.IsTruncated = true,
    o => delete o.attached.IsTruncated, o => delete o.inline.IsTruncated,
    o => o.inline.PolicyNames.push('Extra'), o => o.policies.push(o.policies[0]),
    o => o.policies[0].PolicyDocument.Statement[0].Resource = '*', o => o.policies[1].PolicyDocument.Statement[1].Action = 'kms:*',
    o => delete o.policies[1].PolicyDocument.Statement[1].Condition, o => o.policies[2].PolicyDocument.Statement[0].Resource = '*',
    o => o.resources.StackResources[0].ResourceStatus = 'DELETE_IN_PROGRESS',
    o => o.logGroups.logGroups[0].retentionInDays = 1, o => o.logGroups.logGroups[0].kmsKeyId = 'other']) {
    const changed = observation(); mutate(changed); assert.throws(() => verifyDeployedCareRole(changed, source));
  }
});
test('a locally asserted artifact with invented hashes or another source is never accepted', () => {
  assert.throws(() => verifyDeployedCareArtifact({contract: P.contract, desktop: {commit: D.desktop}, mobile: {source: {commit: D.mobile}},
    key, zipSha256: D.zip, zipBytes: D.bytes}, {}, Buffer.from('fictional'), Buffer.alloc(10)));
  assert.throws(() => verifyDeployedCareArtifact({}, {}, Buffer.from('fictional'), Buffer.alloc(10)));
});
test('inspection exposes no mutation, upgrade, recovery or activation operation', () => {
  const script = readFileSync(new URL('./verify-deployed-synthetic-care.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /PutObjectCommand|create-change-set|execute-change-set|update-function-code|update-stack|execute-statement|\['upgrade'\]/);
  assert.match(script, /upgradeAuthorized: false/); assert.match(script, /rollbackRehearsed: false/);
  assert.match(script, /journeyAcceptance: false/);
  assert.equal((script.match(/'--no-paginate'/g) ?? []).length, 4);
});
