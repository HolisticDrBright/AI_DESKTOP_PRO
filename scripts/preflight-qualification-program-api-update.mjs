/** Read-only inspection of an already deployed fictional program API. No change-set creation. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { databaseSql } from './preflight-qualification-program-api.mjs';

const account = '588966314750';
const region = 'us-east-2';
const profile = 'ai-synthetic-member';
const apiId = '6zt8e9qz04';
const deployedCommit = '46dd96fb39d0c78ecd9947c1215687b6a32d49af';
const lambdaArn = `arn:aws:lambda:${region}:${account}:function:${apiId}-qualification-bound-programs`;
const stackName = 'ai-clinical-core-qualification-bound-program-api';
const boundarySha256 = '0f07717d240d981b3900f6c2e926aa79025157f916e869c4a74def52214261a6';
const ledgerSha256 = '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4';
const qualificationFunctionSha256 = '83ce2f61711f9fa8b94962cf9330af8eb2e0c984a55e4c0edf2a40764c8a31af';
const assignmentFunctionSha256 = 'd9c07fec841cd1d68689be602c933fa67cddd343f4ee5228f336efe9362c981d';
const deployedCodeSha256 = '575Fr1TJFj7yxh9oFjjNWS8Kv7ABlu5TOFCA4yV1qsc=';
const reject = reason => { throw Error(`qualification_program_update_preflight_refused:${reason}`); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const map = (rows, keyName, valueName) => Object.fromEntries((rows ?? []).map(row => [row[keyName], row[valueName]]));
const cell = value => value?.stringValue ?? value?.longValue ?? value?.booleanValue;
const complete = value => ['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(value);
const expectedSubjects = [
  'a16b2580-9091-709c-26f5-543bc0f312a9',
  '815b1540-10d1-706c-53f9-6955699ac385',
  '31db0500-60b1-70b4-9046-371730a55db5',
].join(',');

export function evaluateQualificationProgramUpdatePreflight(input) {
  const { caller, sourceCommit, sourceClean, bundleSha256, buildIdentity, template,
    stack, routes, integration, authorizers, lambda, database } = input;
  if (caller?.Account !== account || !String(caller.Arn ?? '').startsWith(
    `arn:aws:sts::${account}:assumed-role/`)) reject('account');
  if (!sourceClean || !/^[a-f0-9]{40}$/.test(sourceCommit) || sourceCommit === deployedCommit
    || buildIdentity?.contract !== 'qualification-program-bundle/1'
    || buildIdentity.sourceCommit !== sourceCommit
    || buildIdentity.bundleSha256 !== bundleSha256
    || buildIdentity.boundaryCandidateSha256 !== boundarySha256) reject('source');
  if (template?.Metadata?.ClinicalCore?.ContractVersion !== 'qualification-program-api-candidate/3'
    || template.Metadata.ClinicalCore.PhiAllowed !== false
    || template.Metadata.ClinicalCore.Activation !== 'blocked'
    || template.Metadata.ClinicalCore.RuntimeSchemaRequirement?.BoundaryCandidateSha256 !== boundarySha256
    || template.Metadata.ClinicalCore.RuntimeSchemaRequirement?.MigrationReleaseSha256 !== ledgerSha256
    || !String(template.Parameters?.DatabaseSecretArn?.AllowedPattern ?? '').includes(
      'alp-qualification-program-api-db-')) reject('candidate');
  const params = map(stack?.Parameters, 'ParameterKey', 'ParameterValue');
  const outputs = map(stack?.Outputs, 'OutputKey', 'OutputValue');
  const consumerPool = template.Parameters.ConsumerUserPoolId.AllowedValues[0];
  const consumerClient = template.Parameters.ConsumerUserPoolClientId.AllowedValues[0];
  const workforcePool = template.Parameters.WorkforceUserPoolId.AllowedValues[0];
  const workforceClient = template.Parameters.WorkforceUserPoolClientId.AllowedValues[0];
  if (!complete(stack?.StackStatus) || params.SourceCommit !== deployedCommit
    || params.ClinicalApiId !== apiId || params.DatabaseName !== 'clinical_core_qualification'
    || params.ConsumerUserPoolId !== consumerPool || params.ConsumerUserPoolClientId !== consumerClient
    || params.WorkforceUserPoolId !== workforcePool || params.WorkforceUserPoolClientId !== workforceClient
    || params.QualificationProgramOrganizationId !== 'a82dafa6-190f-4769-bb0a-89f4f318b5aa'
    || params.QualificationIdentitySubjects !== expectedSubjects
    || params.DatabaseClusterArn !== template.Parameters.DatabaseClusterArn.AllowedValues[0]
    || params.QualificationBillingApiOrigin !== 'https://qeep30uo68.execute-api.us-east-2.amazonaws.com'
    || outputs.FunctionArn !== lambdaArn || outputs.PhiAllowed !== 'false'
    || outputs.QualificationExecution !== 'programs_fictional_only') reject('stack');
  const programRoutes = routes?.Items?.filter(row => String(row.RouteKey ?? '').includes('/programs'));
  if (!Array.isArray(routes?.Items) || programRoutes?.length !== 2
    || programRoutes.some(row => row.AuthorizationType !== 'JWT'
      || !/^integrations\/[a-z0-9]+$/.test(row.Target ?? ''))
    || new Set(programRoutes.map(row => row.Target)).size !== 1) reject('routes');
  const byKey = Object.fromEntries(programRoutes.map(row => [row.RouteKey, row]));
  const consumerRoute = byKey['POST /clinical-core/consumer/programs'];
  const workforceRoute = byKey['POST /clinical-core/workforce/programs'];
  if (!consumerRoute || !workforceRoute || !consumerRoute.AuthorizerId || !workforceRoute.AuthorizerId
    || consumerRoute.AuthorizerId === workforceRoute.AuthorizerId) reject('routes');
  if (integration?.IntegrationType !== 'AWS_PROXY' || integration.IntegrationUri !== lambdaArn
    || integration.PayloadFormatVersion !== '2.0') reject('integration');
  const authById = Object.fromEntries((authorizers?.Items ?? []).map(row => [row.AuthorizerId, row]));
  for (const [id, pool, client] of [
    [consumerRoute.AuthorizerId, consumerPool, consumerClient],
    [workforceRoute.AuthorizerId, workforcePool, workforceClient],
  ]) {
    const auth = authById[id];
    if (auth?.AuthorizerType !== 'JWT'
      || auth.JwtConfiguration?.Issuer !== `https://cognito-idp.${region}.amazonaws.com/${pool}`
      || auth.JwtConfiguration?.Audience?.length !== 1
      || auth.JwtConfiguration.Audience[0] !== client) reject('authorizers');
  }
  const env = lambda?.Environment?.Variables;
  if (lambda?.FunctionArn !== lambdaArn || lambda.State !== 'Active'
    || lambda.LastUpdateStatus !== 'Successful' || lambda.CodeSha256 !== deployedCodeSha256
    || env?.SOURCE_COMMIT !== deployedCommit || env.PHI_ALLOWED !== 'false'
    || env.PROGRAM_ACTIVATION !== 'blocked'
    || env.QUALIFICATION_EXECUTION !== 'programs_fictional_only'
    || env.CLINICAL_DATABASE_NAME !== 'clinical_core_qualification'
    || !/^arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-[A-Za-z0-9-]+$/.test(
      env.CLINICAL_DATABASE_SECRET_ARN ?? '')
    || env.QUALIFICATION_PROGRAM_BOUNDARY_SHA256 !== boundarySha256
    || env.MIGRATION_RELEASE_SHA256 !== ledgerSha256) reject('lambda');
  const row = database?.records?.[0]?.map(cell);
  if (!row || row.length !== 15 || row[0] !== 'clinical_core_qualification' || row[1] !== 112
    || row[2] !== ledgerSha256 || row[3] !== true || row[4] !== 3
    || row[5] !== false || row[6] !== false
    || row[7] !== qualificationFunctionSha256 || row[8] !== assignmentFunctionSha256
    || row[9] !== 1 || row.slice(10).some(count => count !== 1)) reject('database');
  return {
    contract: 'qualification-program-api-update-preflight/1', account, region,
    deployedSourceCommit: deployedCommit, targetSourceCommit: sourceCommit,
    currentRoutesBound: true, designatedFictionalSubjects: 3, existingAssignments: 1,
    productionPrograms: 'blocked', billing: 'blocked', phiAllowed: false,
    candidateTemplateSha256: sha(JSON.stringify(template)), bundleSha256,
    changeSetReady: false, reason: 'restricted_credential_and_owner_review_required',
  };
}

function aws(...args) {
  try {
    return JSON.parse(execFileSync('aws', [...args, '--profile', profile, '--region', region, '--output', 'json'],
      { encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  } catch {
    reject('aws_read');
  }
}
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--read-only-fictional') reject('command');
  const caller = aws('sts', 'get-caller-identity');
  if (caller.Account !== account) reject('account');
  const git = args => String(execFileSync('git', args, { encoding: 'utf8', timeout: 10_000,
    windowsHide: true })).trim();
  const sourceCommit = git(['rev-parse', 'HEAD']);
  const sourceClean = !git(['status', '--porcelain', '--untracked-files=all']);
  if (!sourceClean) reject('source');
  const template = JSON.parse(readFileSync(
    'infra/aws-clinical-core/qualification-program-api-restricted-credential.json', 'utf8'));
  const buildIdentity = JSON.parse(readFileSync(
    'dist/aws-clinical-core/qualification-program/build-identity.json', 'utf8'));
  const bundleSha256 = sha(readFileSync('dist/aws-clinical-core/qualification-program/index.js'));
  const stack = aws('cloudformation', 'describe-stacks', '--stack-name', stackName).Stacks?.[0];
  const routes = aws('apigatewayv2', 'get-routes', '--api-id', apiId);
  const targets = routes?.Items?.filter(row => String(row.RouteKey ?? '').includes('/programs'))
    .map(row => String(row.Target ?? ''));
  if (targets?.length !== 2 || new Set(targets).size !== 1
    || !/^integrations\/[a-z0-9]+$/.test(targets[0])) reject('routes');
  const integration = aws('apigatewayv2', 'get-integration', '--api-id', apiId,
    '--integration-id', targets[0].slice('integrations/'.length));
  const authorizers = aws('apigatewayv2', 'get-authorizers', '--api-id', apiId);
  const lambda = aws('lambda', 'get-function-configuration', '--function-name', lambdaArn);
  const params = map(stack?.Parameters, 'ParameterKey', 'ParameterValue');
  const database = aws('rds-data', 'execute-statement', '--resource-arn', params.DatabaseClusterArn,
    '--secret-arn', lambda.Environment?.Variables?.CLINICAL_DATABASE_SECRET_ARN,
    '--database', 'clinical_core_qualification', '--sql', databaseSql);
  console.log(JSON.stringify(evaluateQualificationProgramUpdatePreflight({
    caller, sourceCommit, sourceClean, bundleSha256, buildIdentity, template,
    stack, routes, integration, authorizers, lambda, database,
  })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(String(error.message ?? 'qualification_program_update_preflight_failed'));
    process.exitCode = 1; });
}
