import { expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { TELEHEALTH_PUBLIC_ROUTE_POOLS } from './aws-telehealth-requests';
import { createTelehealthDeploymentObservationSource, createNativeTelehealthDeploymentObservation, type TelehealthDeploymentTarget } from './telehealth-qualification-deployment';
import { STSClient } from '@aws-sdk/client-sts';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { RUNTIME_CREDENTIAL_ADMISSION_SQL } from './rds-runtime-credential';
import { bindParameters } from './rds-data-database';
import type { TelehealthAuthenticationTarget } from './telehealth-qualification-authentication';
import type { ClinicalCoreDatabase } from './database';

const org = '11111111-1111-4111-8111-111111111111';
const authentication: TelehealthAuthenticationTarget = { contract: 'telehealth-qualification-authentication/1', account: '588966314750', region: 'us-east-2',
  phiAllowed: false, activation: 'blocked', organizationId: org,
  consumer: { poolId: 'us-east-2_FictionalConsumer', clientId: 'c'.repeat(26), identities: [{ subject: 'fictional-consumer', personId: '22222222-2222-4222-8222-222222222222' }] },
  workforce: { poolId: 'us-east-2_FictionalWorkforce', clientId: 'w'.repeat(26), identities: [{ subject: 'fictional-workforce', personId: '33333333-3333-4333-8333-333333333333' }] } };
const target: TelehealthDeploymentTarget = { contract: 'telehealth-qualification-deployment/1', account: '588966314750', region: 'us-east-2', phiAllowed: false, activation: 'blocked',
  reviewSha256: '1'.repeat(64), sourceCommit: '2'.repeat(40), sourceInputSha256: '3'.repeat(64), apiId: 'fictional1', stage: '$default',
  functionArn: 'arn:aws:lambda:us-east-2:588966314750:function:fictional-telehealth:7', executionRoleArn: 'arn:aws:iam::588966314750:role/fictional-role',
  codeSha256: Buffer.alloc(32, 1).toString('base64'), tableName: 'fictional-telehealth', tableId: org,
  tableKeyArn: 'arn:aws:kms:us-east-2:588966314750:key/11111111-1111-4111-8111-111111111111',
  clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional-cluster',
  secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp/qualification/telehealth-runtime-fictional-ABC123',
  databaseName: 'clinical_core_qualification', routes: Object.entries(TELEHEALTH_PUBLIC_ROUTE_POOLS).map(([routeKey, pool], i) =>
    ({ routeKey, pool, routeId: 'route' + i, integrationId: 'integration1', authorizerId: pool + 'auth' })) };
type Row = Record<string, unknown>;
const name = (c: unknown) => (c as { constructor: { name: string } }).constructor.name;
function rig(supplied: unknown = target, workforce = true) {
  let time = 1_000;
  const route = target.routes.find(r => r.pool === (workforce ? 'workforce' : 'consumer'))!;
  const p = authentication[route.pool];
  const expected = { PHI_ALLOWED: 'false', PRODUCTION_ACTIVATION: 'blocked', QUALIFICATION_EXECUTION: 'true', QUALIFICATION_ACCOUNT_ID: target.account,
    QUALIFICATION_REVIEW_SHA256: target.reviewSha256, SOURCE_COMMIT: target.sourceCommit, SOURCE_INPUT_SHA256: target.sourceInputSha256,
    TELEHEALTH_QUALIFICATION_PROFILE: 'telehealth-native-qualification/1', RUNTIME_MODE: 'qualification', TELEHEALTH_TABLE_NAME: target.tableName,
    CLINICAL_DATABASE_NAME: target.databaseName, CLINICAL_DATABASE_CLUSTER_ARN: target.clusterArn, CLINICAL_DATABASE_SECRET_ARN: target.secretArn,
    CLINICAL_CONSUMER_ISSUER: `https://cognito-idp.us-east-2.amazonaws.com/${authentication.consumer.poolId}`, CLINICAL_CONSUMER_AUDIENCE: authentication.consumer.clientId,
    CLINICAL_WORKFORCE_ISSUER: `https://cognito-idp.us-east-2.amazonaws.com/${authentication.workforce.poolId}`, CLINICAL_WORKFORCE_AUDIENCE: authentication.workforce.clientId,
    ZOOM_ENABLED: 'false', ZOOM_BAA_VERIFIED: 'false', ZOOM_SECRET_ARN: '', STRIPE_TEST_ENABLED: 'false', STRIPE_SECRET_ARN: '', REMINDERS_ENABLED: 'false', CHART_ADMISSION_SECRET_ARN: '' };
  const replies: Record<string, Row> = {
    GetCallerIdentityCommand: { Account: target.account, Arn: 'arn:aws:sts::588966314750:assumed-role/fictional-role/fictional-session' },
    GetFunctionConfigurationCommand: { FunctionArn: target.functionArn, Version: '7', CodeSha256: target.codeSha256, Role: target.executionRoleArn,
      Runtime: 'nodejs22.x', State: 'Active', LastUpdateStatus: 'Successful', PackageType: 'Zip', Environment: { Variables: expected } },
    GetApiCommand: { ApiId: target.apiId, ProtocolType: 'HTTP', ApiEndpoint: 'https://fictional1.execute-api.us-east-2.amazonaws.com', DisableExecuteApiEndpoint: false },
    GetStageCommand: { StageName: '$default', AutoDeploy: true, DeploymentId: 'deployment1' },
    GetDeploymentCommand: { DeploymentId: 'deployment1', DeploymentStatus: 'DEPLOYED', AutoDeployed: true },
    GetRouteCommand: { RouteId: route.routeId, RouteKey: route.routeKey, AuthorizationType: 'JWT', AuthorizerId: route.authorizerId, Target: 'integrations/integration1' },
    GetAuthorizerCommand: { AuthorizerId: route.authorizerId, AuthorizerType: 'JWT', IdentitySource: ['$request.header.Authorization'],
      JwtConfiguration: { Issuer: `https://cognito-idp.us-east-2.amazonaws.com/${p.poolId}`, Audience: [p.clientId] } },
    GetIntegrationCommand: { IntegrationId: 'integration1', IntegrationType: 'AWS_PROXY', PayloadFormatVersion: '2.0', IntegrationUri: target.functionArn },
    DescribeTableCommand: { Table: { TableName: target.tableName, TableArn: 'arn:aws:dynamodb:us-east-2:588966314750:table/fictional-telehealth',
      TableId: org, TableStatus: 'ACTIVE', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      AttributeDefinitions: ['pk', 'sk', 'gsi1pk', 'gsi1sk'].map(AttributeName => ({ AttributeName, AttributeType: 'S' })),
      SSEDescription: { Status: 'ENABLED', SSEType: 'KMS', KMSMasterKeyArn: target.tableKeyArn },
      GlobalSecondaryIndexes: [{ IndexName: 'ByConsumer', IndexStatus: 'ACTIVE', KeySchema: [{ AttributeName: 'gsi1pk', KeyType: 'HASH' }, { AttributeName: 'gsi1sk', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } }] } },
    DescribeContinuousBackupsCommand: { ContinuousBackupsDescription: { ContinuousBackupsStatus: 'ENABLED', PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'ENABLED' } } },
    DescribeSecretCommand: { ARN: target.secretArn },
  };
  const reads: string[] = [];
  const send = vi.fn(async (command: unknown, options: { abortSignal: AbortSignal }) => {
    expect(options.abortSignal).toBeInstanceOf(AbortSignal); reads.push(name(command)); return structuredClone(replies[name(command)]);
  });
  const query = vi.fn(async (): Promise<{ rows: { database_name: string; role_name: string }[] }> =>
    ({ rows: [{ database_name: target.databaseName, role_name: 'clinical_core_api' }] }));
  const database: ClinicalCoreDatabase = { transaction: work => work({ query: query as never }) };
  const makeDatabase = vi.fn(() => database);
  const source = createTelehealthDeploymentObservationSource({ target: supplied, authenticationTarget: authentication,
    clients: { sts: { send }, lambda: { send }, gateway: { send }, dynamo: { send }, secrets: { send } }, database: makeDatabase, now: () => time });
  const event = { routeKey: route.routeKey, requestContext: { apiId: target.apiId, routeId: route.routeId, stage: '$default' } };
  const context = { invokedFunctionArn: target.functionArn, functionVersion: '7' };
  return { event, context, replies, send, reads, query, makeDatabase, source, run: () => source.observe(event, context), setTime: (n: number) => { time = n; } };
}
afterEach(() => vi.restoreAllMocks());
it('binds one actual route, numeric function, execution role, encrypted table and restricted database before issuing a minimal observation', async () => {
  const r = rig(), observation = await r.run();
  expect(observation).toMatchObject({ pool: 'workforce', apiId: target.apiId, functionArn: target.functionArn, databaseName: target.databaseName });
  expect(r.query).toHaveBeenCalledExactlyOnceWith('select current_database() as database_name,current_user as role_name');
  expect(r.source.isObserved(observation)).toBe(true); expect(r.source.isObserved({ ...observation })).toBe(false);
  expect(Object.isFrozen(observation)).toBe(true); expect(observation).not.toHaveProperty('secretArn');
  expect(r.reads).not.toContain('GetSecretValueCommand'); expect(r.reads.filter(n => n === 'GetStageCommand')).toHaveLength(2);
});
it('binds the consumer route to the consumer authorizer, never the workforce authorizer', async () => { expect(await rig(target, false).run()).toMatchObject({ pool: 'consumer' }); });
it('the compiled map covers every existing public appointment route exactly and excludes internal/webhook calls', () => {
  const source = readFileSync(new URL('./aws-telehealth-requests.ts', import.meta.url), 'utf8');
  const routes = [...source.matchAll(/^const (?:CONSUMER|WORKFORCE)_[A-Z_]+ = "([^"]+)";/gm)].map(m => m[1]);
  expect(Object.keys(TELEHEALTH_PUBLIC_ROUTE_POOLS).sort()).toEqual(routes.sort());
  expect(Object.keys(TELEHEALTH_PUBLIC_ROUTE_POOLS)).toHaveLength(29);
  expect(TELEHEALTH_PUBLIC_ROUTE_POOLS['POST /clinical-core/webhooks/stripe/appointments']).toBeUndefined();
});
it.each([
  ['account', '173535830222'], ['region', 'us-east-1'], ['phiAllowed', true], ['activation', 'approved'],
  ['functionArn', target.functionArn.replace(':7', ':$LATEST')], ['functionArn', target.functionArn.replace(':7', ':live')],
  ['secretArn', target.secretArn.replace('telehealth-runtime', 'admin')], ['databaseName', 'clinical_core'],
  ['reviewSha256', '0'.repeat(64)], ['codeSha256', 'invalid'],
])('refuses invalid target %s before any resource or database read', (key, value) => { expect(() => rig({ ...target, [key]: value })).toThrow(); });
it.each(['missing', 'duplicate', 'wrong_pool', 'same_authorizer'])('refuses %s route coverage', fault => {
  const changed = structuredClone(target);
  if (fault === 'missing') changed.routes.pop();
  if (fault === 'duplicate') changed.routes[1] = changed.routes[0];
  if (fault === 'wrong_pool') changed.routes[0].pool = 'workforce';
  if (fault === 'same_authorizer') changed.routes.forEach(r => { r.authorizerId = 'oneauth'; });
  expect(() => rig(changed)).toThrow();
});
it.each(['apiId', 'routeId', 'stage', 'routeKey', 'invokedFunctionArn', 'functionVersion'])('refuses invocation drift %s before resource reads', async key => {
  const r = rig();
  if (key === 'routeKey') r.event.routeKey = 'POST /clinical-core/webhooks/stripe/appointments';
  else if (key === 'invokedFunctionArn' || key === 'functionVersion') r.context[key] = 'wrong';
  else (r.event.requestContext as Row)[key] = 'wrong';
  await expect(r.run()).rejects.toThrow('telehealth_deployment_refused'); expect(r.send).not.toHaveBeenCalled(); expect(r.makeDatabase).not.toHaveBeenCalled();
});
it.each([
  ['GetCallerIdentityCommand', 'Account', '173535830222'], ['GetCallerIdentityCommand', 'Arn', 'arn:aws:sts::588966314750:assumed-role/admin/session'],
  ['GetFunctionConfigurationCommand', 'CodeSha256', Buffer.alloc(32, 2).toString('base64')], ['GetFunctionConfigurationCommand', 'Role', 'admin'],
  ['GetFunctionConfigurationCommand', 'Version', '$LATEST'], ['GetFunctionConfigurationCommand', 'State', 'Pending'],
  ['GetFunctionConfigurationCommand', 'LastUpdateStatus', 'Failed'], ['GetFunctionConfigurationCommand', 'PackageType', 'Image'],
  ['GetApiCommand', 'ApiEndpoint', 'https://other.execute-api.us-east-2.amazonaws.com'], ['GetApiCommand', 'ProtocolType', 'WEBSOCKET'],
  ['GetStageCommand', 'AutoDeploy', false], ['GetDeploymentCommand', 'DeploymentStatus', 'PENDING'],
  ['GetRouteCommand', 'AuthorizationType', 'NONE'], ['GetRouteCommand', 'Target', 'integrations/other'], ['GetRouteCommand', 'RouteId', 'other'],
  ['GetAuthorizerCommand', 'IdentitySource', ['$request.querystring.token']], ['GetIntegrationCommand', 'IntegrationUri', target.functionArn.replace(':7', ':live')],
  ['DescribeSecretCommand', 'ARN', 'other'], ['DescribeSecretCommand', 'DeletedDate', new Date()],
])('refuses actual resource drift %s %s before constructing authority', async (command, key, value) => {
  const r = rig(); r.replies[command][key] = value; await expect(r.run()).rejects.toThrow('telehealth_deployment_refused'); expect(r.makeDatabase).not.toHaveBeenCalled();
});
it.each(['PHI_ALLOWED', 'SOURCE_COMMIT', 'SOURCE_INPUT_SHA256', 'CLINICAL_DATABASE_SECRET_ARN', 'CLINICAL_WORKFORCE_AUDIENCE', 'RUNTIME_MODE', 'QUALIFICATION_REVIEW_SHA256', 'ZOOM_ENABLED', 'STRIPE_TEST_ENABLED', 'REMINDERS_ENABLED', 'CHART_ADMISSION_SECRET_ARN'])('refuses published environment drift %s', async key => {
  const r = rig(); (r.replies.GetFunctionConfigurationCommand.Environment as { Variables: Row }).Variables[key] = 'changed';
  await expect(r.run()).rejects.toThrow('telehealth_deployment_refused'); expect(r.makeDatabase).not.toHaveBeenCalled();
});
it.each(['foreign_table', 'recreated_table', 'inactive', 'bad_key', 'bad_attribute', 'wrong_kms', 'disabled_kms', 'wrong_index', 'index_building', 'no_pitr'])('refuses %s store metadata', async fault => {
  const r = rig(), table = r.replies.DescribeTableCommand.Table as Row;
  if (fault === 'foreign_table') table.TableArn = 'arn:aws:dynamodb:us-east-2:173535830222:table/fictional-telehealth';
  if (fault === 'recreated_table') table.TableId = '44444444-4444-4444-8444-444444444444';
  if (fault === 'inactive') table.TableStatus = 'DELETING';
  if (fault === 'bad_key') table.KeySchema = [{ AttributeName: 'wrong', KeyType: 'HASH' }];
  if (fault === 'bad_attribute') (table.AttributeDefinitions as Row[])[0].AttributeType = 'N';
  if (fault === 'wrong_kms') (table.SSEDescription as Row).KMSMasterKeyArn = 'foreign';
  if (fault === 'disabled_kms') (table.SSEDescription as Row).Status = 'DISABLED';
  if (fault === 'wrong_index') (table.GlobalSecondaryIndexes as Row[])[0].IndexName = 'Other';
  if (fault === 'index_building') (table.GlobalSecondaryIndexes as Row[])[0].IndexStatus = 'CREATING';
  if (fault === 'no_pitr') ((r.replies.DescribeContinuousBackupsCommand.ContinuousBackupsDescription as Row).PointInTimeRecoveryDescription as Row).PointInTimeRecoveryStatus = 'DISABLED';
  await expect(r.run()).rejects.toThrow('telehealth_deployment_refused'); expect(r.makeDatabase).not.toHaveBeenCalled();
});
it.each(['foreign_database', 'admin_role', 'extra_row'])('refuses %s on the same restricted database', async fault => {
  const r = rig(); r.query.mockResolvedValue({ rows: fault === 'extra_row' ? [] : [{ database_name: fault === 'foreign_database' ? 'staging' : target.databaseName, role_name: fault === 'admin_role' ? 'clinical_admin' : 'clinical_core_api' }] });
  await expect(r.run()).rejects.toThrow('telehealth_deployment_refused');
});
it('refuses a changed deployment after the database read', async () => {
  const r = rig(); r.query.mockImplementation(async () => { r.replies.GetStageCommand.DeploymentId = 'successor'; return { rows: [{ database_name: target.databaseName, role_name: 'clinical_core_api' }] }; });
  await expect(r.run()).rejects.toThrow('telehealth_deployment_refused');
});
it('an unreadable resource stops later reads and never leaks its exception', async () => {
  const r = rig(); r.send.mockRejectedValue(Error('private-token-and-secret'));
  await expect(r.run()).rejects.toThrow(/^telehealth_deployment_refused$/); expect(r.send).toHaveBeenCalledTimes(1); expect(r.makeDatabase).not.toHaveBeenCalled();
});
it('a late resource cannot schedule later reads or produce an observation', async () => {
  const r = rig(); r.send.mockImplementationOnce(async () => { r.setTime(16_000); return r.replies.GetCallerIdentityCommand; });
  await expect(r.run()).rejects.toThrow('telehealth_deployment_refused'); expect(r.send).toHaveBeenCalledTimes(1);
});
it('defensively snapshots the reviewed target instead of accepting later request-side changes', async () => {
  const supplied = structuredClone(target), r = rig(supplied); supplied.account = '173535830222' as never; supplied.routes[0].pool = 'workforce';
  expect(await r.run()).toMatchObject({ functionArn: target.functionArn });
});
it.each(['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_DYNAMODB', 'AWS_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'NODE_OPTIONS'])('refuses credential/endpoint/bootstrap override %s', async key => {
  const r = rig(); (r.replies.GetFunctionConfigurationCommand.Environment as { Variables: Row }).Variables[key] = 'private-unreviewed-value';
  await expect(r.run()).rejects.toThrow('telehealth_deployment_refused'); expect(r.makeDatabase).not.toHaveBeenCalled();
});
it('does not impose metadata array ordering that AWS does not guarantee', async () => {
  const r = rig(), table = r.replies.DescribeTableCommand.Table as Row;
  (table.KeySchema as unknown[]).reverse(); (table.AttributeDefinitions as unknown[]).reverse();
  ((table.GlobalSecondaryIndexes as Row[])[0].KeySchema as unknown[]).reverse(); expect(await r.run()).toMatchObject({ tableId: org });
});
function nativeRig(admitted = true, queryFault?: 'wrong_role' | 'wrong_database' | 'query_failed') {
  const r = rig();
  for (const prototype of [STSClient.prototype, LambdaClient.prototype, ApiGatewayV2Client.prototype, DynamoDBClient.prototype, SecretsManagerClient.prototype])
    vi.spyOn(prototype, 'send').mockImplementation(r.send as never);
  const statements: string[] = [], commands: string[] = [];
  const rds = vi.spyOn(RDSDataClient.prototype, 'send').mockImplementation((async (raw: unknown, options: { abortSignal: AbortSignal }) => {
    const command = raw as { input: Row };
    commands.push(name(raw)); expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(command.input).toMatchObject({ resourceArn: target.clusterArn, secretArn: target.secretArn, database: target.databaseName });
    if (name(raw) === 'BeginTransactionCommand') return { transactionId: 'fictional-read-only-transaction' };
    if (name(raw) === 'CommitTransactionCommand' || name(raw) === 'RollbackTransactionCommand') return {};
    if (name(raw) !== 'ExecuteStatementCommand') throw Error('unexpected native request');
    const sql = String(command.input.sql); statements.push(sql);
    if (sql.includes('clinical-runtime-credential/1')) {
      expect(command.input.parameters).toEqual([{ name: 'p1', value: { stringValue: 'clinical_core_api' } }]);
      return { columnMetadata: [{ name: 'runtime_credential_admitted' }], records: [[{ booleanValue: admitted }]] };
    }
    if (sql === 'set local role clinical_core_api') return {};
    if (sql !== 'select current_database() as database_name,current_user as role_name') throw Error('unadmitted SQL');
    if (queryFault === 'query_failed') throw Error('private-query-details');
    return { columnMetadata: [{ name: 'database_name' }, { name: 'role_name' }], records: [[
      { stringValue: queryFault === 'wrong_database' ? 'staging' : target.databaseName }, { stringValue: queryFault === 'wrong_role' ? 'clinical_admin' : 'clinical_core_api' }]] };
  }) as never);
  const source = createNativeTelehealthDeploymentObservation(target, authentication);
  return { ...r, statements, commands, rds, nativeRun: () => source.observe(r.event, r.context) };
}
it('native composition uses the pinned runtime secret and real restricted-role driver, never admin credentials', async () => {
  const r = nativeRig(); expect(await r.nativeRun()).toMatchObject({ databaseName: target.databaseName, functionArn: target.functionArn });
  expect(r.commands).toEqual(['BeginTransactionCommand', 'ExecuteStatementCommand', 'ExecuteStatementCommand', 'ExecuteStatementCommand', 'CommitTransactionCommand']);
  expect(r.statements).toEqual([bindParameters(RUNTIME_CREDENTIAL_ADMISSION_SQL, ['clinical_core_api']).sql,
    'set local role clinical_core_api', 'select current_database() as database_name,current_user as role_name']);
});
it('native credential rejection rolls back before SET ROLE and before any application metadata query', async () => {
  const r = nativeRig(false); await expect(r.nativeRun()).rejects.toThrow(/^telehealth_deployment_refused$/);
  expect(r.commands.at(-1)).toBe('RollbackTransactionCommand'); expect(r.statements).toHaveLength(1);
  expect(r.statements[0]).toContain('clinical-runtime-credential/1');
});
it.each(['wrong_role', 'wrong_database', 'query_failed'] as const)('native %s refuses and rolls back without exposing its exception', async fault => {
  const r = nativeRig(true, fault); await expect(r.nativeRun()).rejects.toThrow(/^telehealth_deployment_refused$/);
  expect(r.commands.at(-1)).toBe('RollbackTransactionCommand'); expect(r.commands).not.toContain('CommitTransactionCommand');
});
it('native resource rejection cannot touch the database secret or begin a transaction', async () => {
  const r = nativeRig(); r.replies.GetFunctionConfigurationCommand.CodeSha256 = 'changed';
  await expect(r.nativeRun()).rejects.toThrow('telehealth_deployment_refused'); expect(r.rds).not.toHaveBeenCalled();
  expect(r.reads).not.toContain('DescribeSecretCommand');
});
it('native construction pins AWS endpoints and keeps webhook/internal actions outside observation', () => {
  const text = readFileSync(new URL('./telehealth-qualification-deployment.ts', import.meta.url), 'utf8');
  expect(text).toContain('ignoreConfiguredEndpointUrls: true');
  expect(text).not.toMatch(/GetSecretValueCommand|createRdsDataAdministrativeDatabase|UpdateFunctionConfigurationCommand/);
});
it('an aborted AWS read stops the observation even if its transport later returns', async () => {
  const r = rig(), controller = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  let resolve!: (value: Row) => void;
  r.send.mockImplementationOnce(() => new Promise<Row>(r => { resolve = r; }));
  const result = expect(r.run()).rejects.toThrow(/^telehealth_deployment_refused$/);
  controller.abort(); await result;
  resolve(r.replies.GetCallerIdentityCommand); await Promise.resolve(); await Promise.resolve();
  expect(r.send).toHaveBeenCalledTimes(1); expect(r.makeDatabase).not.toHaveBeenCalled();
});
it('refuses a backwards clock between later reads even if it remains after invocation start', async () => {
  const r = rig();
  r.send.mockImplementationOnce(async () => { r.setTime(2_000); return r.replies.GetCallerIdentityCommand; });
  r.send.mockImplementationOnce(async () => { r.setTime(1_500); return r.replies.GetFunctionConfigurationCommand; });
  await expect(r.run()).rejects.toThrow('telehealth_deployment_refused'); expect(r.send).toHaveBeenCalledTimes(2); expect(r.makeDatabase).not.toHaveBeenCalled();
});
it('a deadline during the database read cannot issue an observation or schedule the final stage read', async () => {
  const r = rig(); r.query.mockImplementation(async () => { r.setTime(16_000); return { rows: [{ database_name: target.databaseName, role_name: 'clinical_core_api' }] }; });
  await expect(r.run()).rejects.toThrow('telehealth_deployment_refused'); expect(r.reads.filter(n => n === 'GetStageCommand')).toHaveLength(1);
});
