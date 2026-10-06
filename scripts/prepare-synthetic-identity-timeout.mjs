/** Generate a timeout-only update from the live fictional staging template; never execute a change set. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SYNTHETIC_MEMBER_PROFILE, observeSyntheticMemberIdentity } from './synthetic-aws-principal.mjs';

const account = '588966314750', region = 'us-east-2';
const foundationName = 'ai-clinical-core-synthetic-staging';
const stackName = 'ai-clinical-core-synthetic-staging-authenticated-api';
const apiId = 'wxv734oi12';
const functionName = `${apiId}-synthetic-identity`;
const oldTimeout = { lambda: 15, integration: 15000 };
const nextTimeout = { lambda: 29, integration: 30000 };
const refuse = code => { throw new Error(`synthetic_timeout_refused:${code}`); };
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function timeoutOnlyTemplate(live, source) {
  const liveFn = live?.Resources?.IdentityApiFunction?.Properties;
  const liveIntegration = live?.Resources?.IdentityApiIntegration?.Properties;
  const sourceFn = source?.Resources?.IdentityApiFunction?.Properties;
  const sourceIntegration = source?.Resources?.IdentityApiIntegration?.Properties;
  if (liveFn?.Timeout !== oldTimeout.lambda || liveIntegration?.TimeoutInMillis !== oldTimeout.integration
    || sourceFn?.Timeout !== nextTimeout.lambda || sourceIntegration?.TimeoutInMillis !== nextTimeout.integration
    || JSON.stringify(liveFn.FunctionName) !== JSON.stringify({ 'Fn::Sub': '${ClinicalApiId}-synthetic-identity' })
    || JSON.stringify(liveIntegration.IntegrationUri) !== JSON.stringify({ 'Fn::GetAtt': ['IdentityApiFunction', 'Arn'] })) {
    refuse('template_or_source_drift');
  }
  const candidate = structuredClone(live);
  candidate.Resources.IdentityApiFunction.Properties.Timeout = nextTimeout.lambda;
  candidate.Resources.IdentityApiIntegration.Properties.TimeoutInMillis = nextTimeout.integration;
  const reversed = structuredClone(candidate);
  reversed.Resources.IdentityApiFunction.Properties.Timeout = oldTimeout.lambda;
  reversed.Resources.IdentityApiIntegration.Properties.TimeoutInMillis = oldTimeout.integration;
  if (JSON.stringify(reversed) !== JSON.stringify(live)) refuse('non_timeout_change');
  return candidate;
}

function aws(...args) {
  try {
    return JSON.parse(execFileSync('aws', [...args, '--profile', SYNTHETIC_MEMBER_PROFILE,
      '--region', region, '--output', 'json'], { encoding: 'utf8', windowsHide: true, timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 }));
  } catch { refuse('aws_observation'); }
}

function prepare() {
  if (process.argv.length !== 3 || process.argv[2] !== '--prepare-fictional-only') refuse('command');
  if (observeSyntheticMemberIdentity().Account !== account) refuse('account');
  const foundation = aws('cloudformation', 'describe-stacks', '--stack-name', foundationName).Stacks?.[0];
  const outputs = Object.fromEntries((foundation?.Outputs ?? []).map(x => [x.OutputKey, x.OutputValue]));
  if (foundation?.StackStatus !== 'UPDATE_COMPLETE' || outputs.PhiAllowed !== 'false'
    || outputs.DataClassification !== 'synthetic_only' || outputs.DatabaseName !== 'clinical_core'
    || outputs.ClinicalApiId !== apiId) refuse('foundation');
  const stack = aws('cloudformation', 'describe-stacks', '--stack-name', stackName).Stacks?.[0];
  if (stack?.StackStatus !== 'UPDATE_COMPLETE'
    || !stack.StackId?.startsWith(`arn:aws:cloudformation:${region}:${account}:stack/${stackName}/`)) refuse('stack');
  const parameters = stack.Parameters ?? [];
  if (parameters.length !== 11 || new Set(parameters.map(x => x.ParameterKey)).size !== 11
    || !parameters.some(x => x.ParameterKey === 'ClinicalApiId' && x.ParameterValue === apiId)
    || !parameters.some(x => x.ParameterKey === 'LambdaCodeKey'
      && x.ParameterValue === 'clinical-core/authenticated-api/58f5978301be218896b269a44438fecb8ae89a690bee6671008b64f215f14247.zip')) refuse('parameters');
  const body = aws('cloudformation', 'get-template', '--stack-name', stackName).TemplateBody;
  let live;
  try { live = typeof body === 'string' ? JSON.parse(body) : body; }
  catch { refuse('template_parse'); }
  const source = JSON.parse(readFileSync('infra/aws-clinical-core/identity-api-extension.json', 'utf8'));
  const candidate = timeoutOnlyTemplate(live, source);
  const functionState = aws('lambda', 'get-function-configuration', '--function-name', functionName);
  if (functionState.FunctionName !== functionName || functionState.Timeout !== oldTimeout.lambda
    || functionState.State !== 'Active' || functionState.LastUpdateStatus !== 'Successful') refuse('function_state');
  const integrations = aws('apigatewayv2', 'get-integrations', '--api-id', apiId).Items ?? [];
  const exact = integrations.filter(x => x.IntegrationUri === `arn:aws:lambda:${region}:${account}:function:${functionName}`);
  if (exact.length !== 1 || exact[0].TimeoutInMillis !== oldTimeout.integration) refuse('integration_state');
  const compact = JSON.stringify(candidate);
  if (Buffer.byteLength(compact) > 51200) refuse('template_size');
  const digest = sha256(compact);
  const directory = resolve('dist', 'synthetic-identity-timeout', digest.slice(0, 16));
  mkdirSync(directory, { recursive: true });
  const templatePath = resolve(directory, 'template.json');
  const paramsPath = resolve(directory, 'parameters.json');
  const params = JSON.stringify(parameters.map(x => ({ ParameterKey: x.ParameterKey, UsePreviousValue: true })));
  for (const [path, content] of [[templatePath, compact], [paramsPath, params]]) {
    try { writeFileSync(path, content, { flag: 'wx' }); }
    catch { if (readFileSync(path, 'utf8') !== content) refuse('artifact_collision'); }
  }
  console.log(JSON.stringify({ mode: 'timeout_only_change_set_prepared', account, region, phiAllowed: false,
    stack: stackName, stackId: stack.StackId, deployedFunction: functionName, integrationId: exact[0].IntegrationId,
    oldTimeout, nextTimeout, templatePath, parametersPath: paramsPath, templateSha256: digest,
    awsMutationPerformed: false, changeSetCreated: false, deployed: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { prepare(); } catch (error) {
    console.error(error.message?.startsWith('synthetic_timeout_refused:') ? error.message : 'synthetic_timeout_refused:unclassified');
    process.exitCode = 1;
  }
}
