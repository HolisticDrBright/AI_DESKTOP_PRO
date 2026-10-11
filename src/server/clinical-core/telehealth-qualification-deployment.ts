if (typeof window !== 'undefined') throw Error('telehealth deployment observation is server-only');
import { z } from 'zod';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { LambdaClient, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { ApiGatewayV2Client, GetApiCommand, GetStageCommand, GetDeploymentCommand, GetRouteCommand,
  GetAuthorizerCommand, GetIntegrationCommand } from '@aws-sdk/client-apigatewayv2';
import { DynamoDBClient, DescribeTableCommand, DescribeContinuousBackupsCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, DescribeSecretCommand } from '@aws-sdk/client-secrets-manager';
import { RDSDataClient, RollbackTransactionCommand } from '@aws-sdk/client-rds-data';
import { createRdsDataClinicalCoreDatabase } from './rds-data-database';
import type { ClinicalCoreDatabase } from './database';
import { TELEHEALTH_PUBLIC_ROUTE_POOLS } from './aws-telehealth-requests';
import { parseTelehealthAuthenticationTarget, type TelehealthAuthenticationTarget } from './telehealth-qualification-authentication';

const hash = z.string().regex(/^[a-f0-9]{64}$/).refine(v => v !== '0'.repeat(64));
const id = z.string().regex(/^[a-z0-9]{1,32}$/);
const keyArn = z.string().regex(/^arn:aws:kms:us-east-2:588966314750:key\/[a-f0-9-]{36}$/);
const targetSchema = z.object({ contract: z.literal('telehealth-qualification-deployment/1'),
  account: z.literal('588966314750'), region: z.literal('us-east-2'), phiAllowed: z.literal(false), activation: z.literal('blocked'),
  reviewSha256: hash, sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), sourceInputSha256: hash,
  apiId: z.string().regex(/^[a-z0-9]{10}$/), stage: z.literal('$default'),
  functionArn: z.string().regex(/^arn:aws:lambda:us-east-2:588966314750:function:[A-Za-z0-9_-]{1,64}:[1-9][0-9]*$/),
  executionRoleArn: z.string().regex(/^arn:aws:iam::588966314750:role\/[A-Za-z0-9_+=,.@/-]{1,256}$/),
  codeSha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/).refine(v => Buffer.from(v, 'base64').toString('base64') === v),
  tableName: z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/), tableId: z.uuid(), tableKeyArn: keyArn,
  clusterArn: z.string().regex(/^arn:aws:rds:us-east-2:588966314750:cluster:[A-Za-z0-9-]{1,63}$/),
  secretArn: z.string().regex(/^arn:aws:secretsmanager:us-east-2:588966314750:secret:alp\/qualification\/telehealth-runtime-[A-Za-z0-9-]+$/),
  databaseName: z.literal('clinical_core_qualification'),
  routes: z.array(z.object({ routeKey: z.string(), pool: z.enum(['consumer', 'workforce']),
    routeId: id, integrationId: id, authorizerId: id }).strict()).length(Object.keys(TELEHEALTH_PUBLIC_ROUTE_POOLS).length),
}).strict().superRefine((c, ctx) => {
  const expected = Object.keys(TELEHEALTH_PUBLIC_ROUTE_POOLS);
  if (new Set(c.routes.map(r => r.routeKey)).size !== expected.length
    || new Set(c.routes.map(r => r.routeId)).size !== expected.length
    || c.routes.some(r => TELEHEALTH_PUBLIC_ROUTE_POOLS[r.routeKey] !== r.pool)
    || new Set(c.routes.filter(r => r.pool === 'consumer').map(r => r.authorizerId)).size !== 1
    || new Set(c.routes.filter(r => r.pool === 'workforce').map(r => r.authorizerId)).size !== 1
    || c.routes.find(r => r.pool === 'consumer')?.authorizerId === c.routes.find(r => r.pool === 'workforce')?.authorizerId)
    ctx.addIssue({ code: 'custom', message: 'route bindings refused' });
});
export type TelehealthDeploymentTarget = z.infer<typeof targetSchema>;
export type TelehealthDeploymentEvent = { routeKey?: string; requestContext?: { apiId?: string; routeId?: string; stage?: string } };
export type TelehealthLambdaInvocation = { invokedFunctionArn: string; functionVersion: string };
type Reader = { send(command: unknown, options: { abortSignal: AbortSignal }): Promise<unknown> };
type Clients = { sts: Reader; lambda: Reader; gateway: Reader; dynamo: Reader; secrets: Reader };
export class TelehealthDeploymentError extends Error { constructor() { super('telehealth_deployment_refused'); } }
function refused(): never { throw new TelehealthDeploymentError(); }
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) refused();
  return v as Record<string, unknown>;
};
const canonical = (v: unknown): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}' : JSON.stringify(v);
const exact = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const setEqual = (a: unknown, b: unknown[]) => Array.isArray(a) && a.length === b.length
  && new Set(a.map(canonical)).size === a.length && exact(a.map(canonical).sort(), b.map(canonical).sort());
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new TelehealthDeploymentError());
    if (signal.aborted) { stop(); return; }
    signal.addEventListener('abort', stop, { once: true });
    work.then(v => { signal.removeEventListener('abort', stop); if (signal.aborted) stop(); else resolve(v); },
      () => { signal.removeEventListener('abort', stop); stop(); });
  });
}

/** Read-only deployment/resource prerequisite. NOT approval, current consent,
 * whole-ledger authority, provider admission, or a durable write capability.
 * The same restricted database factory must be used by subsequent authority.
 * Native clients are constructed below, never selected by an incoming event. */
export function createTelehealthDeploymentObservationSource(input: {
  target: unknown; authenticationTarget: TelehealthAuthenticationTarget; clients: Clients;
  database: (signal: AbortSignal) => ClinicalCoreDatabase; now?: () => number;
}) {
  const target = targetSchema.parse(structuredClone(input.target));
  const authentication = parseTelehealthAuthenticationTarget(input.authenticationTarget);
  if (authentication.account !== target.account || authentication.region !== target.region
    || authentication.phiAllowed !== false || authentication.activation !== 'blocked') refused();
  const clock = input.now ?? Date.now, observations = new WeakSet<object>();
  const observe = async (event: TelehealthDeploymentEvent, context: TelehealthLambdaInvocation) => {
    const started = clock(), signal = AbortSignal.timeout(15_000);
    if (!Number.isFinite(started)) refused();
    let latestTime = started;
    const current = () => {
      const time = clock();
      if (!Number.isFinite(time) || time < latestTime || time - started >= 15_000 || signal.aborted) refused();
      latestTime = time;
      return time;
    };
    current();
    const route = target.routes.find(r => r.routeKey === event.routeKey);
    if (!route || event.requestContext?.apiId !== target.apiId || event.requestContext.routeId !== route.routeId
      || event.requestContext.stage !== target.stage || context.invokedFunctionArn !== target.functionArn
      || context.functionVersion !== target.functionArn.split(':').at(-1)) refused();
    const read = async (reader: Reader, command: unknown) => { current();
      const result = object(await bounded(reader.send(command, { abortSignal: signal }), signal)); current(); return result;
    };
    try {
      const principal = await read(input.clients.sts, new GetCallerIdentityCommand({}));
      const roleName = target.executionRoleArn.split('/').at(-1)!;
      if (principal.Account !== target.account || typeof principal.Arn !== 'string'
        || !principal.Arn.startsWith(`arn:aws:sts::${target.account}:assumed-role/${roleName}/`)
        || !/^[A-Za-z0-9_+=,.@-]{1,128}$/.test(principal.Arn.split('/').at(-1)!)) refused();
      const fn = await read(input.clients.lambda, new GetFunctionConfigurationCommand({ FunctionName: target.functionArn }));
      if (fn.FunctionArn !== target.functionArn || fn.Version !== context.functionVersion || fn.CodeSha256 !== target.codeSha256
        || fn.Role !== target.executionRoleArn || fn.Runtime !== 'nodejs22.x' || fn.State !== 'Active'
        || fn.LastUpdateStatus !== 'Successful' || fn.PackageType !== 'Zip') refused();
      const environment = object(fn.Environment);
      if (environment.Error !== undefined) refused();
      const env = object(environment.Variables);
      const expected = { PHI_ALLOWED: 'false', PRODUCTION_ACTIVATION: 'blocked', QUALIFICATION_EXECUTION: 'true',
        QUALIFICATION_ACCOUNT_ID: target.account, QUALIFICATION_REVIEW_SHA256: target.reviewSha256,
        SOURCE_COMMIT: target.sourceCommit, SOURCE_INPUT_SHA256: target.sourceInputSha256,
        TELEHEALTH_QUALIFICATION_PROFILE: 'telehealth-native-qualification/1', RUNTIME_MODE: 'qualification',
        TELEHEALTH_TABLE_NAME: target.tableName, CLINICAL_DATABASE_NAME: target.databaseName,
        CLINICAL_DATABASE_CLUSTER_ARN: target.clusterArn, CLINICAL_DATABASE_SECRET_ARN: target.secretArn,
        CLINICAL_CONSUMER_ISSUER: `https://cognito-idp.${target.region}.amazonaws.com/${authentication.consumer.poolId}`,
        CLINICAL_CONSUMER_AUDIENCE: authentication.consumer.clientId,
        CLINICAL_WORKFORCE_ISSUER: `https://cognito-idp.${target.region}.amazonaws.com/${authentication.workforce.poolId}`,
        CLINICAL_WORKFORCE_AUDIENCE: authentication.workforce.clientId,
        ZOOM_ENABLED: 'false', ZOOM_BAA_VERIFIED: 'false', ZOOM_SECRET_ARN: '',
        STRIPE_TEST_ENABLED: 'false', STRIPE_SECRET_ARN: '', REMINDERS_ENABLED: 'false', CHART_ADMISSION_SECRET_ARN: '' };
      if (!Object.entries(expected).every(([name, value]) => env[name] === value)
        || Object.keys(env).some(name => /^(?:AWS_ENDPOINT_URL|AWS_PROFILE|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|NODE_OPTIONS)/.test(name))
        || env.INVENTORY_QUALIFICATION_PROFILE !== undefined || env.SUCCESSOR_QUALIFICATION_PROFILE !== undefined) refused();
      const api = await read(input.clients.gateway, new GetApiCommand({ ApiId: target.apiId }));
      if (api.ApiId !== target.apiId || api.ProtocolType !== 'HTTP'
        || api.ApiEndpoint !== `https://${target.apiId}.execute-api.${target.region}.amazonaws.com` || api.DisableExecuteApiEndpoint === true) refused();
      const stage = await read(input.clients.gateway, new GetStageCommand({ ApiId: target.apiId, StageName: target.stage }));
      // A manual stage can point at an older immutable deployment. Its routes
      // require an independent deployed-stage observation, not this live-route check.
      if (stage.StageName !== target.stage || stage.AutoDeploy !== true || typeof stage.DeploymentId !== 'string'
        || !/^[a-z0-9]+$/.test(stage.DeploymentId)) refused();
      const deployment = await read(input.clients.gateway, new GetDeploymentCommand({ ApiId: target.apiId, DeploymentId: stage.DeploymentId }));
      if (deployment.DeploymentId !== stage.DeploymentId || deployment.DeploymentStatus !== 'DEPLOYED' || deployment.AutoDeployed !== true) refused();
      const liveRoute = await read(input.clients.gateway, new GetRouteCommand({ ApiId: target.apiId, RouteId: route.routeId }));
      if (liveRoute.RouteId !== route.routeId || liveRoute.RouteKey !== route.routeKey || liveRoute.AuthorizationType !== 'JWT'
        || liveRoute.AuthorizerId !== route.authorizerId || liveRoute.Target !== `integrations/${route.integrationId}`) refused();
      const authorizer = await read(input.clients.gateway, new GetAuthorizerCommand({ ApiId: target.apiId, AuthorizerId: route.authorizerId }));
      const p = authentication[route.pool], jwt = object(authorizer.JwtConfiguration);
      if (authorizer.AuthorizerId !== route.authorizerId || authorizer.AuthorizerType !== 'JWT'
        || !exact(authorizer.IdentitySource, ['$request.header.Authorization'])
        || jwt.Issuer !== `https://cognito-idp.${target.region}.amazonaws.com/${p.poolId}` || !exact(jwt.Audience, [p.clientId])) refused();
      const integration = await read(input.clients.gateway, new GetIntegrationCommand({ ApiId: target.apiId, IntegrationId: route.integrationId }));
      if (integration.IntegrationId !== route.integrationId || integration.IntegrationType !== 'AWS_PROXY'
        || integration.PayloadFormatVersion !== '2.0' || integration.IntegrationUri !== target.functionArn) refused();
      const table = object((await read(input.clients.dynamo, new DescribeTableCommand({ TableName: target.tableName }))).Table);
      if (table.TableName !== target.tableName || table.TableArn !== `arn:aws:dynamodb:${target.region}:${target.account}:table/${target.tableName}`
        || table.TableStatus !== 'ACTIVE' || table.TableId !== target.tableId
        || !setEqual(table.KeySchema, [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }])
        || !setEqual(table.AttributeDefinitions, [{ AttributeName: 'gsi1pk', AttributeType: 'S' }, { AttributeName: 'gsi1sk', AttributeType: 'S' },
          { AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }])) refused();
      const encryption = object(table.SSEDescription);
      if (encryption.Status !== 'ENABLED' || encryption.SSEType !== 'KMS' || encryption.KMSMasterKeyArn !== target.tableKeyArn
        || encryption.InaccessibleEncryptionDateTime !== undefined) refused();
      const indices = table.GlobalSecondaryIndexes;
      if (!Array.isArray(indices) || indices.length !== 1) refused();
      const index = object(indices[0]);
      if (index.IndexName !== 'ByConsumer' || index.IndexStatus !== 'ACTIVE' || index.Backfilling === true
        || !setEqual(index.KeySchema, [{ AttributeName: 'gsi1pk', KeyType: 'HASH' }, { AttributeName: 'gsi1sk', KeyType: 'RANGE' }])
        || !exact(index.Projection, { ProjectionType: 'ALL' })) refused();
      const backups = object((await read(input.clients.dynamo, new DescribeContinuousBackupsCommand({ TableName: target.tableName }))).ContinuousBackupsDescription);
      if (backups.ContinuousBackupsStatus !== 'ENABLED'
        || object(backups.PointInTimeRecoveryDescription).PointInTimeRecoveryStatus !== 'ENABLED') refused();
      const secret = await read(input.clients.secrets, new DescribeSecretCommand({ SecretId: target.secretArn }));
      if (secret.ARN !== target.secretArn || secret.DeletedDate !== undefined || secret.PrimaryRegion !== undefined && secret.PrimaryRegion !== target.region) refused();
      const database = input.database(signal);
      await bounded(database.transaction(async tx => {
        const result = await tx.query<{ database_name: string; role_name: string }>('select current_database() as database_name,current_user as role_name');
        if (result.rows.length !== 1 || result.rows[0].database_name !== target.databaseName || result.rows[0].role_name !== 'clinical_core_api') refused();
      }), signal);
      const finalStage = await read(input.clients.gateway, new GetStageCommand({ ApiId: target.apiId, StageName: target.stage }));
      if (finalStage.StageName !== target.stage || finalStage.AutoDeploy !== true || finalStage.DeploymentId !== stage.DeploymentId) refused();
      const observation = Object.freeze({ contract: 'telehealth-deployment-observation/1' as const,
        apiId: target.apiId, functionArn: target.functionArn, sourceCommit: target.sourceCommit,
        tableId: table.TableId as string, databaseName: target.databaseName, routeKey: route.routeKey, pool: route.pool, observedAt: current() });
      observations.add(observation); return observation;
    } catch { return refused(); }
  };
  return Object.freeze({ observe, isObserved: (v: unknown) => !!v && typeof v === 'object' && observations.has(v) });
}

/** No AWS write, secret retrieval, provider client or admin fallback. Separate
 * source-only constructor: the historical handler/stack are not changed. */
export function createNativeTelehealthDeploymentObservation(target: unknown, authenticationTarget: TelehealthAuthenticationTarget) {
  const pinned = targetSchema.parse(structuredClone(target));
  const config = { region: pinned.region, maxAttempts: 1, ignoreConfiguredEndpointUrls: true };
  const clients = { sts: new STSClient(config), lambda: new LambdaClient(config), gateway: new ApiGatewayV2Client(config),
    dynamo: new DynamoDBClient(config), secrets: new SecretsManagerClient(config) };
  const rds = new RDSDataClient({ region: pinned.region, maxAttempts: 1, ignoreConfiguredEndpointUrls: true });
  return createTelehealthDeploymentObservationSource({ target: pinned, authenticationTarget, clients,
    database: signal => createRdsDataClinicalCoreDatabase(pinned, { send: async command =>
      await rds.send(command as never, { abortSignal: command instanceof RollbackTransactionCommand ? AbortSignal.timeout(3_000) : signal }) as unknown as Record<string, unknown> }) });
}
