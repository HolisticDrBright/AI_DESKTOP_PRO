import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {PERSONA_EMAILS, verifyPersonaRecords, verifyPersonaClaims, boundedCareJson,
  CARE_CONSUMER_CASES, verifyCareConsumerAnswer} from './verify-synthetic-care-consumer.mjs';
const personId = '11111111-1111-4111-8111-111111111111';
const rows = () => Object.entries(PERSONA_EMAILS).map(([mode, email], i) => ({mode, email,
  personId: personId.slice(0, -1) + (i + 1), password: 'fictional-test-only'}));
test('only the five existing fictional credential bindings are admitted', () => {
  verifyPersonaRecords(rows());
  for (const mutate of [v => v.pop(), v => v.push(v[0]), v => v[1].mode = v[0].mode, v => v[1].personId = v[0].personId,
    v => v[0].email = 'real@example.com', v => v[0].mode = 'other', v => v[0].personId = 'a'.repeat(36),
    v => v[0].password = 'short', v => v[0].password = 'x'.repeat(257), v => v[0] = null]) {
    const value = rows(); mutate(value); assert.throws(() => verifyPersonaRecords(value));
  }
});
const now = 1700000000000;
const claims = () => ({iss: `https://cognito-idp.${P.region}.amazonaws.com/${P.consumerPool}`, aud: P.consumerClient,
  token_use: 'id', 'custom:synthetic_attested': 'true', 'custom:person_id': personId,
  'custom:organization_id': personId, sub: personId, email: rows()[0].email, email_verified: true, exp: now / 1000 + 3600});
test('issued claims bind owner, fictional email, organization, native consumer audience and lifetime', () => {
  verifyPersonaClaims(claims(), rows()[0], now);
  for (const [key, value] of Object.entries({iss: 'other', aud: P.workforceClient, token_use: 'access',
    'custom:synthetic_attested': 'false', 'custom:production_bound': 'true', 'custom:person_id': 'other',
    'custom:organization_id': 'a'.repeat(36), sub: '', email: 'real@example.com', email_verified: false,
    exp: now / 1000 + 300})) {
    assert.throws(() => verifyPersonaClaims({...claims(), [key]: value}, rows()[0], now));
  }
  assert.throws(() => verifyPersonaClaims({...claims(), exp: '9999999999'}, rows()[0], now));
});
function streamed(parts, headers = {}) {
  let cancelled = false;
  const stream = new ReadableStream({start(controller) {
    for (const part of parts) controller.enqueue(Buffer.from(part));
  }, cancel() {cancelled = true;}});
  // Leave open so refusal must explicitly cancel; final short-length tests use a closed stream instead.
  return {response: new Response(stream, {headers: {'content-type': 'application/json', ...headers}}),
    cancelled: () => cancelled};
}
test('header refusals and unknown-length overruns cancel the unread stream', async () => {
  for (const headers of [{'content-length': '65537'}, {'content-length': '-1'}, {'content-type': 'application/jsonp'},
    {'content-type': 'text/html'}]) {
    const value = streamed(['{}'], headers);
    await assert.rejects(boundedCareJson(value.response)); assert.equal(value.cancelled(), true);
  }
  const overrun = streamed(['x'.repeat(65536), 'x']);
  await assert.rejects(boundedCareJson(overrun.response), /response_overrun/);
  assert.equal(overrun.cancelled(), true);
});
test('byte-exact bounded JSON refuses short bodies, invalid JSON and accepts a split response', async () => {
  assert.deepEqual(await boundedCareJson(new Response('{"ok":true}', {headers: {'content-type': 'application/json; charset=utf-8', 'content-length': '11'}})), {ok: true});
  await assert.rejects(boundedCareJson(new Response('{}', {headers: {'content-type': 'application/json', 'content-length': '3'}})), /response_short/);
  await assert.rejects(boundedCareJson(new Response('not-json', {headers: {'content-type': 'application/json'}})));
  const body = new ReadableStream({start(c) {c.enqueue(Buffer.from('{"ok":')); c.enqueue(Buffer.from('true}')); c.close();}});
  assert.deepEqual(await boundedCareJson(new Response(body, {headers: {'content-type': 'application/json'}})), {ok: true});
});
function answer(name) {
  if (name === 'posture') return {data: {contractVersion: 'clinical-core/1', environment: 'synthetic-staging',
    dataClassification: 'synthetic_only', identityPool: 'consumer', authenticated: true, phiAllowed: false, realPatientDataAllowed: false}};
  if (name === 'legacy_erase_refused') return {error: 'request_invalid'};
  if (name === 'care_export') return {data: {action: 'export', section: 'threads', items: [], next: null}};
  return {data: {action: 'erasure_history', erasures: []}};
}
test('a 200 refusal, PHI posture or mismatched contract is never acceptance', () => {
  for (const spec of CARE_CONSUMER_CASES) {
    verifyCareConsumerAnswer(spec, spec.status, answer(spec.name));
    for (const value of [null, [], {}, {error: 'not_configured'}, {data: {}}]) {
      assert.throws(() => verifyCareConsumerAnswer(spec, spec.status, value));
    }
    assert.throws(() => verifyCareConsumerAnswer(spec, 403, answer(spec.name)));
  }
  const posture = CARE_CONSUMER_CASES[0];
  for (const [key, value] of Object.entries({environment: 'production', identityPool: 'workforce', authenticated: false,
    phiAllowed: true, realPatientDataAllowed: true, dataClassification: 'phi'})) {
    const changed = answer('posture'); changed.data[key] = value;
    assert.throws(() => verifyCareConsumerAnswer(posture, 200, changed));
  }
  assert.throws(() => verifyCareConsumerAnswer({name: 'other', status: 200}, 200, {}));
  assert.throws(() => verifyCareConsumerAnswer(CARE_CONSUMER_CASES[1], 400, {error: 'request_invalid', data: {}}));
  assert.throws(() => verifyCareConsumerAnswer(CARE_CONSUMER_CASES[2], 200, {data: {action: 'export', section: 'messages', items: [], next: null}}));
  assert.throws(() => verifyCareConsumerAnswer(CARE_CONSUMER_CASES[3], 200, {data: {action: 'erasure_history', erasures: Array(51).fill({})}}));
});
test('case inventory cannot admit erasure, reset, consent, fixture or identity writes', () => {
  assert.deepEqual(CARE_CONSUMER_CASES.map(v => v.body?.action ?? 'GET'), ['GET', 'erase', 'export', 'erasure_history']);
  assert.equal(CARE_CONSUMER_CASES[1].status, 400);
  const script = readFileSync(new URL('./verify-synthetic-care-consumer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /AdminSetUserPassword|AdminCreateUser|SignUpCommand|execute-statement|erase_request|settle_erasure|consent_grant/);
  assert.match(script, /newErasureReceiptJourneyVerified: false/);
  assert.match(script, /physicalDeviceAcceptance: false/);
  assert.match(script, /selfServiceRegistrationVerified: false/);
});
