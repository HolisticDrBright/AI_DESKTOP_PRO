/**
 * Read-only observation for hosted program ACCEPTANCE on the Desktop synthetic API (`wxv734oi12`). The hosted smoke
 * scripts are not this: they print a source commit they never compare, take digests from a local deployment file, and
 * report `pass` whether their writes happened in this run or were skipped as already present.
 *
 * This module observes for itself, through an injected reader that can only issue four fixed read operations:
 * - the stack's advertised source (the `LambdaCodeKey` path, and any `SourceCommit` parameter or output);
 * - the live function's `CodeSha256`, state and issuer configuration, and the API's JWT authorizers;
 * - the foundation's PHI posture.
 * Through an injected HTTP transport, it records every answer's `x-clinical-execution` marker and never keeps a token.
 *
 * What it produces is held in module-private sets and deep-frozen. A copy, a file, or an edited object is not an
 * observation, so a caller-supplied deployment file cannot stand in for one. Only the AWS CLI reader built here with its
 * own runner, and the transport built here over the global fetch, count as hosted; an injected (fictional) adapter is
 * never hosted evidence, however complete its answers are.
 */
import {execFileSync} from 'node:child_process';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {SYNTHETIC_MEMBER_PROFILE} from './synthetic-aws-principal.mjs';

// The same constants as src/server/clinical-core/qualification-execution.ts (a test holds them equal).
export const QUALIFICATION_EXECUTION_HEADER = 'x-clinical-execution';
export const QUALIFICATION_EXECUTION_MODE = 'qualification';

const issuerFor = pool => `https://cognito-idp.${P.region}.amazonaws.com/${pool}`;
export const PROGRAM_TARGET = Object.freeze({
  contract: 'hosted-program-target/1', account: P.account, region: P.region,
  stack: P.stack, foundation: P.foundation, apiId: P.apiId, functionName: P.functionName,
  apiOrigin: `https://${P.apiId}.execute-api.${P.region}.amazonaws.com`,
  consumer: Object.freeze({issuer: issuerFor(P.consumerPool), audience: P.consumerClient}),
  workforce: Object.freeze({issuer: issuerFor(P.workforcePool), audience: P.workforceClient}),
});

/** The only operations a reader is ever asked for. Each is a Get or Describe. */
export const READ_OPERATIONS = Object.freeze(['sts:GetCallerIdentity', 'cloudformation:DescribeStacks',
  'lambda:GetFunctionConfiguration', 'apigatewayv2:GetAuthorizers']);

export class HostedObservationError extends Error {
  constructor(code) {super(`hosted_program_observation_refused:${code}`); this.name = 'HostedObservationError'; this.code = code;}
}
const refuse = code => {throw new HostedObservationError(code);};

const TRUSTED_READERS = new WeakSet(), TRUSTED_TRANSPORTS = new WeakSet();
const OBSERVATIONS = new WeakSet(), RESPONSES = new WeakSet(), IDENTITIES = new WeakSet();
export const isTrustedReader = reader => TRUSTED_READERS.has(reader);
export const isTrustedTransport = transport => TRUSTED_TRANSPORTS.has(transport);
export const isAdapterObservation = value => typeof value === 'object' && value !== null && OBSERVATIONS.has(value);
export const isObservedResponse = value => typeof value === 'object' && value !== null && RESPONSES.has(value);
export const isObservedIdentity = value => typeof value === 'object' && value !== null && IDENTITIES.has(value);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
export function assertReadOperation(operation) {
  if (!READ_OPERATIONS.includes(operation)) refuse('read_operation_refused');
  return operation;
}

const NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/, API = /^[a-z0-9]{10}$/;
/** The AWS CLI reader. Built with its own runner it is trusted; with an injected runner it is not (tests use that). */
export function createAwsCliReader({run, profile = SYNTHETIC_MEMBER_PROFILE, region = P.region} = {}) {
  const runner = run ?? execFileSync;
  const argv = (operation, input) => {
    assertReadOperation(operation);
    const value = (key, pattern) => {
      const v = input?.[key];
      if (typeof v !== 'string' || !pattern.test(v)) refuse('read_input_refused');
      return v;
    };
    switch (operation) {
      case 'sts:GetCallerIdentity': return ['sts', 'get-caller-identity'];
      case 'cloudformation:DescribeStacks': return ['cloudformation', 'describe-stacks', '--stack-name', value('StackName', NAME)];
      case 'lambda:GetFunctionConfiguration': return ['lambda', 'get-function-configuration', '--function-name', value('FunctionName', NAME)];
      default: return ['apigatewayv2', 'get-authorizers', '--api-id', value('ApiId', API)];
    }
  };
  const reader = Object.freeze({
    kind: run ? 'injected-cli' : 'aws-cli',
    async read(operation, input = {}) {
      const args = [...argv(operation, input), '--profile', profile, '--region', region, '--output', 'json'];
      let text;
      try {
        text = runner('aws', args, {encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']});
      } catch {refuse('aws_read_failed');}
      try {return JSON.parse(text);} catch {return refuse('observation_shape');}
    },
  });
  if (!run) TRUSTED_READERS.add(reader);
  return reader;
}

const pairs = (rows, key, value) => {
  if (rows === undefined) return {};
  if (!Array.isArray(rows) || rows.some(row => typeof row?.[key] !== 'string')
    || new Set(rows.map(row => row[key])).size !== rows.length) refuse('observation_shape');
  return Object.fromEntries(rows.map(row => [row[key], typeof row[value] === 'string' ? row[value] : null]));
};
const KEY_FAMILIES = Object.freeze({'care-release': false, 'care-intent-release': false,
  'care-registered-release': true, 'catalog-runtime-release': true});
/** What a `LambdaCodeKey` advertises. Only the versioned families name the Desktop commit they were built from. */
export function parseLambdaCodeKey(key) {
  if (typeof key !== 'string') return {family: null, desktopCommit: null, mobileCommit: null, zipSha256: null};
  const versioned = /^clinical-core\/authenticated-api\/([a-z-]+)\/([a-f0-9]{40})\/(?:([a-f0-9]{40})\/)?([a-f0-9]{64})\.zip$/.exec(key);
  if (versioned && versioned[1] in KEY_FAMILIES && KEY_FAMILIES[versioned[1]] === Boolean(versioned[3]))
    return {family: versioned[1], desktopCommit: versioned[2], mobileCommit: versioned[3] ?? null, zipSha256: versioned[4]};
  const legacy = /^clinical-core\/authenticated-api\/([a-f0-9]{64})\.zip$/.exec(key);
  if (legacy) return {family: 'unversioned', desktopCommit: null, mobileCommit: null, zipSha256: legacy[1]};
  return {family: 'unrecognised', desktopCommit: null, mobileCommit: null, zipSha256: null};
}
const hexFromBase64 = value => {
  if (typeof value !== 'string') return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === value ? bytes.toString('hex') : null;
};
const COMMIT = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : value == null ? null : 'invalid';

/** Observes the target once. Only the four read operations are issued; nothing is written. */
export async function observeProgramTarget(reader, {target = PROGRAM_TARGET, now = () => new Date()} = {}) {
  if (typeof reader?.read !== 'function') refuse('reader_required');
  const read = async (operation, input) => {
    const response = await reader.read(assertReadOperation(operation), input);
    if (!response || typeof response !== 'object' || Array.isArray(response)) refuse('observation_shape');
    return response;
  };
  const caller = await read('sts:GetCallerIdentity', {});
  const describe = async name => {
    const rows = (await read('cloudformation:DescribeStacks', {StackName: name})).Stacks;
    if (!Array.isArray(rows) || rows.length !== 1 || (rows[0].StackName !== undefined && rows[0].StackName !== name)) refuse('observation_shape');
    return rows[0];
  };
  const stack = await describe(target.stack), foundation = await describe(target.foundation);
  const fn = await read('lambda:GetFunctionConfiguration', {FunctionName: target.functionName});
  if (fn.FunctionName !== target.functionName) refuse('observation_target_mismatch');
  const authorizers = await read('apigatewayv2:GetAuthorizers', {ApiId: target.apiId});
  if (!Array.isArray(authorizers.Items) || authorizers.NextToken) refuse('observation_shape');
  const parameters = pairs(stack.Parameters, 'ParameterKey', 'ParameterValue'), outputs = pairs(stack.Outputs, 'OutputKey', 'OutputValue');
  const foundationOutputs = pairs(foundation.Outputs, 'OutputKey', 'OutputValue');
  const variables = fn.Environment?.Variables && typeof fn.Environment.Variables === 'object' ? fn.Environment.Variables : {};
  const env = name => typeof variables[name] === 'string' ? variables[name] : null;
  const observation = deepFreeze({
    contract: 'hosted-program-target-observation/1', observedAt: now().toISOString(),
    transport: TRUSTED_READERS.has(reader) ? 'aws-cli' : 'fictional',
    account: typeof caller.Account === 'string' ? caller.Account : null,
    principalArn: typeof caller.Arn === 'string' ? caller.Arn : null,
    stack: {name: target.stack, status: typeof stack.StackStatus === 'string' ? stack.StackStatus : null,
      lambdaCodeKey: parameters.LambdaCodeKey ?? null, key: parseLambdaCodeKey(parameters.LambdaCodeKey),
      sourceCommitParameter: COMMIT(parameters.SourceCommit), sourceCommitOutput: COMMIT(outputs.SourceCommit)},
    foundation: {name: target.foundation, status: typeof foundation.StackStatus === 'string' ? foundation.StackStatus : null,
      phiAllowed: foundationOutputs.PhiAllowed ?? null, dataClassification: foundationOutputs.DataClassification ?? null},
    function: {name: fn.FunctionName, state: fn.State ?? null, lastUpdateStatus: fn.LastUpdateStatus ?? null,
      revisionId: typeof fn.RevisionId === 'string' ? fn.RevisionId : null, codeSha256Hex: hexFromBase64(fn.CodeSha256),
      codeSize: Number.isSafeInteger(fn.CodeSize) ? fn.CodeSize : null, sourceCommitEnvironment: COMMIT(env('SOURCE_COMMIT')),
      consumerIssuer: env('CLINICAL_CONSUMER_ISSUER'), consumerAudience: env('CLINICAL_CONSUMER_AUDIENCE'),
      workforceIssuer: env('CLINICAL_WORKFORCE_ISSUER'), workforceAudience: env('CLINICAL_WORKFORCE_AUDIENCE')},
    authorizers: authorizers.Items.map(item => ({id: typeof item?.AuthorizerId === 'string' ? item.AuthorizerId : null,
      type: item?.AuthorizerType ?? null, issuer: item?.JwtConfiguration?.Issuer ?? null,
      audiences: Array.isArray(item?.JwtConfiguration?.Audience) ? [...item.JwtConfiguration.Audience] : []})),
  });
  OBSERVATIONS.add(observation);
  return observation;
}

/** The answers' marker semantics are `observeExecution` in qualification-execution.ts: a marked answer is qualification;
 * an unmarked 401/403 is an authorizer denial that classifies nothing; any other unmarked answer is production. */
const executionOf = (marker, status) => marker === QUALIFICATION_EXECUTION_MODE ? 'qualification'
  : status === 401 || status === 403 ? 'unmarked_denial' : 'production';

/** Every answer passes through here and is recorded with its marker. The token is sent and forgotten. */
export function createObservedTransport({fetch, origin = PROGRAM_TARGET.apiOrigin, now = () => new Date()} = {}) {
  if (typeof origin !== 'string' || !/^https:\/\/[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(origin)) refuse('origin_https_required');
  const send = fetch ?? globalThis.fetch;
  if (typeof send !== 'function') refuse('transport_required');
  const kind = fetch ? 'fictional' : 'https-fetch', records = [];
  const transport = Object.freeze({
    kind,
    async send({role = null, token, method = 'POST', path, body}) {
      if (typeof path !== 'string' || !/^\/clinical-core\/[a-z0-9/-]+$/.test(path)) refuse('request_path_refused');
      const headers = {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})};
      const startedAt = now().toISOString();
      const response = await send(origin + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(30000)});
      const status = Number(response?.status);
      const raw = await response.text();
      if (typeof raw !== 'string' || raw.length > 250000) refuse('response_oversize');
      let parsed = null;
      try {parsed = JSON.parse(raw);} catch {parsed = null;}
      const marker = response.headers?.get?.(QUALIFICATION_EXECUTION_HEADER) ?? null;
      const record = deepFreeze({seq: records.length + 1, transport: kind, role, method, path,
        action: typeof body?.action === 'string' ? body.action : null, status, marker,
        execution: executionOf(marker, status), body: parsed, startedAt});
      RESPONSES.add(record);
      records.push(record);
      return record;
    },
    records: () => [...records],
  });
  if (!fetch) TRUSTED_TRANSPORTS.add(transport);
  return transport;
}

/** The claims a run's token carries, decoded (API Gateway verified the signature) and kept without the token. */
export function observeIdentityToken(role, token) {
  let claims;
  try {claims = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));} catch {claims = null;}
  if (!claims || typeof claims !== 'object') refuse('identity_token_shape');
  const identity = deepFreeze({role, iss: typeof claims.iss === 'string' ? claims.iss : null,
    aud: typeof claims.aud === 'string' ? claims.aud : null, tokenUse: claims.token_use ?? null,
    syntheticAttested: claims['custom:synthetic_attested'] === 'true', productionBound: claims['custom:production_bound'] === 'true'});
  IDENTITIES.add(identity);
  return identity;
}

/** A replay the server itself reported. The program assign answers `duplicate`, the cart compile answers `replayed`. */
export const replayIndicated = record => record?.body?.data?.duplicate === true || record?.body?.data?.replayed === true;
/** How an observed write answer must be recorded: never `created` when the server said it was a replay. */
export const classifyWrite = record => replayIndicated(record) ? 'reused' : 'created';

export const REQUIREMENTS = Object.freeze(['must_create', 'create_or_reuse', 'must_replay', 'must_refuse', 'optional']);
export const OUTCOMES = Object.freeze(['created', 'reused', 'skipped', 'refused']);
/** Records what each planned step did in this run. Entries are claims; the evaluator checks each against the answers. */
export function createWriteLedger(plan) {
  if (!Array.isArray(plan) || plan.length === 0) refuse('plan_required');
  const steps = plan.map(item => {
    if (typeof item?.step !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(item.step) || typeof item.kind !== 'string'
      || !REQUIREMENTS.includes(item.requirement)) refuse('plan_invalid');
    return Object.freeze({step: item.step, kind: item.kind, requirement: item.requirement});
  });
  if (new Set(steps.map(s => s.step)).size !== steps.length) refuse('plan_invalid');
  const entries = [];
  const record = (outcome, step, response, reason) => {
    entries.push(Object.freeze({step, outcome, response: response ?? null, reason: typeof reason === 'string' ? reason : null}));
  };
  return Object.freeze({
    plan: Object.freeze(steps),
    created: (step, response) => record('created', step, response),
    reused: (step, response, reason) => record('reused', step, response, reason),
    skipped: (step, reason) => record('skipped', step, null, reason),
    refused: (step, response) => record('refused', step, response),
    entries: () => [...entries],
  });
}
