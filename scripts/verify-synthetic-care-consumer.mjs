/** Real-Cognito pre-upgrade acceptance, using existing fictional personas only. No identity or clinical writes. */
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SecretsManagerClient, GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {CognitoIdentityProviderClient, InitiateAuthCommand} from '@aws-sdk/client-cognito-identity-provider';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P, careSourceSnapshot} from './synthetic-care-release.mjs';
import {observeSyntheticMemberIdentity, SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
export const PERSONA_EMAILS = Object.freeze({regular_cycle: 'persona.regular-cycle@brightlongevity.test',
  hormonal_contraception: 'persona.hbc@brightlongevity.test', irregular_cycle: 'persona.irregular-cycle@brightlongevity.test',
  perimenopause: 'persona.perimenopause@brightlongevity.test', menopause: 'persona.menopause@brightlongevity.test'});
const source = '5b6f8aa45347d33757ac9bfb34658e2e09daefd3';
const deployedZip = '644967eec4241c19f2365aabc7cec304f200f95622c8ef3a0188f57633dd64db';
const secretArn = 'arn:aws:secretsmanager:us-east-2:588966314750:secret:ai-longevity-pro/synthetic-staging/testflight-personas-piSA7p';
const check = (ok, code) => {if (!ok) throw new Error(`synthetic_care_consumer_refused:${code}`);};
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export function verifyPersonaRecords(rows) {
  check(Array.isArray(rows) && rows.length === 5 && new Set(rows.map(r => r?.mode)).size === 5
    && new Set(rows.map(r => r?.personId)).size === 5, 'persona_set');
  for (const row of rows) check(Object.hasOwn(PERSONA_EMAILS, row?.mode) && row.email === PERSONA_EMAILS[row.mode]
    && typeof row.password === 'string' && row.password.length >= 12 && row.password.length <= 256
    && uuid(row.personId), 'persona_binding');
}
export function verifyPersonaClaims(claims, row, now = Date.now()) {
  check(claims?.iss === `https://cognito-idp.${P.region}.amazonaws.com/${P.consumerPool}` && claims.aud === P.consumerClient
    && claims.token_use === 'id' && claims['custom:synthetic_attested'] === 'true'
    && claims['custom:production_bound'] !== 'true' && claims['custom:person_id'] === row.personId
    && uuid(claims['custom:organization_id']) && /^[A-Za-z0-9:_-]{8,128}$/.test(claims.sub)
    && claims.email === row.email && [true, 'true'].includes(claims.email_verified)
    && Number.isFinite(claims.exp) && claims.exp * 1000 > now + 300000, 'token_binding');
}
export async function boundedCareJson(response) {
  const length = response.headers.get('content-length');
  try {
    check(length === null || /^\d+$/.test(length) && Number(length) <= 65536, 'response_length');
    check(response.body && /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''), 'response_type');
  } catch (error) {await response.body?.cancel().catch(() => {}); throw error;}
  const reader = response.body.getReader(), parts = []; let count = 0;
  try {
    while (true) {const chunk = await reader.read(); if (chunk.done) break;
      count += chunk.value.byteLength; check(count <= 65536, 'response_overrun'); parts.push(Buffer.from(chunk.value));}
    check(length === null || count === Number(length), 'response_short');
    return JSON.parse(Buffer.concat(parts, count).toString('utf8'));
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}
export const CARE_CONSUMER_CASES = Object.freeze([
  {name: 'posture', path: '/clinical-core/consumer/posture', status: 200},
  {name: 'legacy_erase_refused', path: '/clinical-core/consumer/care-data', status: 400, body: {action: 'erase', scope: 'domain'}},
  {name: 'care_export', path: '/clinical-core/consumer/care-data', status: 200, body: {action: 'export', section: 'threads', limit: 1}},
  {name: 'erasure_history', path: '/clinical-core/consumer/care-data', status: 200, body: {action: 'erasure_history'}},
]);
export function verifyCareConsumerAnswer(spec, status, value) {
  check(CARE_CONSUMER_CASES.includes(spec), 'case_binding');
  check(status === spec.status, 'http_status');
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'response_object');
  if (spec.status === 200) check(!('error' in value), 'unexpected_error');
  if (spec.name === 'posture') check(value?.data?.contractVersion === 'clinical-core/1' && value.data.environment === 'synthetic-staging'
    && value.data.dataClassification === 'synthetic_only' && value.data.identityPool === 'consumer'
    && value.data.authenticated === true && value.data.phiAllowed === false && value.data.realPatientDataAllowed === false, 'posture');
  if (spec.name === 'legacy_erase_refused') check(value?.error === 'request_invalid' && !('data' in value), 'legacy_refusal');
  if (spec.name === 'care_export') check(value?.data?.action === 'export' && value.data.section === 'threads'
    && Array.isArray(value.data.items) && value.data.items.length <= 1
    && (value.data.next === null || typeof value.data.next === 'string'), 'export_contract');
  if (spec.name === 'erasure_history') check(value?.data?.action === 'erasure_history'
    && Array.isArray(value.data.erasures) && value.data.erasures.length <= 50, 'history_contract');
}
async function main() {
  check(process.argv.length === 3 && process.argv[2] === '--verify-existing-fictional-personas', 'arguments');
  const harness = careSourceSnapshot(process.cwd(), 'desktop'); observeSyntheticMemberIdentity();
  const fn = JSON.parse(execFileSync('aws', ['lambda', 'get-function-configuration', '--function-name', P.functionName,
    '--profile', profile, '--region', P.region, '--output', 'json'],
  {encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe']}));
  check(fn.CodeSha256 === Buffer.from(deployedZip, 'hex').toString('base64') && fn.State === 'Active'
    && fn.LastUpdateStatus === 'Successful' && fn.Environment?.Variables?.CLINICAL_DATABASE_NAME === P.database
    && fn.Environment.Variables.CLINICAL_DATABASE_CLUSTER_ARN === P.cluster
    && fn.Environment.Variables.CLINICAL_DATABASE_SECRET_ARN === P.secret, 'deployed_code');
  const credentials = fromIni({profile}), secrets = new SecretsManagerClient({region: P.region, credentials, maxAttempts: 1}),
    cognito = new CognitoIdentityProviderClient({region: P.region, credentials, maxAttempts: 1});
  let rows = [], phase = 'fictional_credential_lookup'; const observations = [];
  try {
    const secret = await secrets.send(new GetSecretValueCommand({SecretId: secretArn}), {abortSignal: AbortSignal.timeout(30000)});
    check(secret.ARN === secretArn && typeof secret.SecretString === 'string' && Buffer.byteLength(secret.SecretString) <= 65536, 'secret_binding');
    rows = JSON.parse(secret.SecretString); verifyPersonaRecords(rows);
    for (const row of rows) {
      phase = `${row.mode}:authenticate`;
      const auth = await cognito.send(new InitiateAuthCommand({ClientId: P.consumerClient, AuthFlow: 'USER_PASSWORD_AUTH',
        AuthParameters: {USERNAME: row.email, PASSWORD: row.password}}), {abortSignal: AbortSignal.timeout(30000)});
      const token = auth.AuthenticationResult?.IdToken; check(typeof token === 'string', 'id_token_missing');
      // Decode only the token returned by Cognito. The real API Gateway separately verifies its signature.
      verifyPersonaClaims(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')), row);
      for (const spec of CARE_CONSUMER_CASES) {
        phase = `${row.mode}:${spec.name}`;
        const response = await fetch(`https://${P.apiId}.execute-api.${P.region}.amazonaws.com${spec.path}`, {
          method: spec.body ? 'POST' : 'GET', headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
          body: spec.body ? JSON.stringify(spec.body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30000)});
        const value = await boundedCareJson(response);
        observations.push({persona: row.mode, case: spec.name, status: response.status,
          ...(value.error === 'request_invalid' ? {error: value.error} : {}),
          ...(Array.isArray(value.data?.items) ? {exportItems: value.data.items.length} : {})});
        verifyCareConsumerAnswer(spec, response.status, value);
      }
    }
    check(JSON.stringify(careSourceSnapshot(process.cwd(), 'desktop')) === JSON.stringify(harness), 'harness_source_changed');
    const report = {contract: 'synthetic-care-consumer-acceptance/1', observedAt: new Date().toISOString(), account: P.account,
      execution: 'synthetic-staging', deployedSource: source, deployedZip, functionRevision: fn.RevisionId, harness,
      verdict: 'pass', observations, legacyAuthenticatedRefusalVerified: true, unaffectedConsumerRoutesVerified: true,
      newErasureReceiptJourneyVerified: false, workforceJourneyVerified: false, selfServiceRegistrationVerified: false,
      physicalDeviceAcceptance: false, phiAllowed: false, paidMobileBuildStarted: false};
    const dir = resolve('dist/synthetic-care-consumer', harness.commit); mkdirSync(dir, {recursive: true});
    const file = resolve(dir, `${Date.now()}.json`); writeFileSync(file, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
    console.log(JSON.stringify({report: file, ...report}));
  } catch (error) {
    console.error(JSON.stringify({verdict: 'finding', phase, observations,
      code: error.message?.startsWith('synthetic_care_consumer_refused:') ? error.message : 'synthetic_care_consumer_failed', phiAllowed: false}));
    process.exitCode = 1;
  } finally {for (const row of rows) if (row && typeof row === 'object') delete row.password; secrets.destroy(); cognito.destroy();}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error('synthetic_care_consumer_refused:preflight'); process.exitCode = 1;
});
