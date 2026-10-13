import { createHash, createHmac, createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { readFileSync } from 'node:fs';
import { ACCEPTANCE_FIXTURE, buildChainAndFixture } from '../sql-acceptance-host';
import { journeyCoursePhases, JOURNEY_COURSE_TITLE } from '../journey-fixture';
import { createSqlProgramOfferLedger } from '../program-offer-ledger-sql';
import { createSqlCheckoutLedger } from '../program-checkout-ledger-sql';
import { PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256 } from '../program-commerce-activation';
import { createRdsDataCommerceSessionDatabase } from '../../clinical-core/rds-data-database';
import { createConsumerSessionVerifier, ConsumerSessionRevoked, type ConsumerUser } from '../../learner/consumer-session';
import { CONSUMER_ACCESS_COOKIE, CONSUMER_ID_COOKIE, __resetReviewedLearner } from '../../learner/reviewed-learner-host';
import { __resetLearnerHost } from '../../learner/learner-host';
import { __resetReviewedPurchasing, resolvePurchaseRuntime } from '../program-commerce-runtime';
import { POST as webhookRoute } from '../../../app/api/live/commerce/webhook/route';
import { POST as myCoursesRoute } from '../../../app/api/my-courses/route';
import { REVIEWED_COMMERCE_CANDIDATES, programCommerceHostTarget, type ProgramCommerceHostTarget } from './commerce-host-target';
import { PROGRAM_COMMERCE_RUNTIME_SESSIONS_SCHEMA_CANDIDATE_SHA256 } from './commerce-role-sessions';
import { bootstrapReviewedCommerce } from './reviewed-bootstrap';
import { createReviewedEducationApiHandler, CONSUMER_ACCESS_TOKEN_HEADER } from './education-api';
import { createReviewedCommerceWorkerHandler } from './commerce-worker-entry';
import { createPgliteRdsDataClient } from './pglite-rds-data.test-support';
import type { ReviewedCommerceInputs } from './reviewed-commerce-runtime';

/**
 * Purchase → webhook → settlement → delivery → claim → exact curriculum → progress, through the
 * REVIEWED runtime as composed from one pinned target, with every boundary outside this repository
 * replaced by a visibly fictional stand-in:
 *
 *   database   the BLOCKED candidate chain (and the runtime-sessions successor) on an embedded engine
 *              on disk, reached ONLY through the RDS Data factory and a fake Data API that maps each
 *              secret to its login. Embedded, single connection, one superuser: role isolation here is
 *              the candidates' grants, not hosted isolation, and nothing here contends for a lock;
 *   identity   real ID-token signature verification (aws-jwt-verify against a cached key set this test
 *              generated) and a fake Cognito GetUser that can revoke;
 *   processor  a fake Stripe API over injected fetch; webhook events signed with a fictional secret;
 *   email      a fake SES send that can lose a reply or refuse.
 * It is source evidence only: not hosted, not a device, not a real purchase, account or learner.
 */
const ORG = ACCEPTANCE_FIXTURE.organizationId, PROGRAM = ACCEPTANCE_FIXTURE.programId;
const PRICE = 'price_FictionalAccept01';
const POOL = 'us-east-2_FictionalPool1', CLIENT = 'fictionalclient1', KID = 'fictional-key-1';
const ISSUER = `https://cognito-idp.us-east-2.amazonaws.com/${POOL}`;
const WEBHOOK_SECRET = 'whsec_FictionalReviewed01';
const ORIGIN = 'https://clinic.fictional.example';
const secretArn = (name: string) => `arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional/program-commerce/${name}-AbCdEf`;
const LOGINS = {
  [secretArn('api')]: 'program_commerce_api_runtime', [secretArn('worker')]: 'program_commerce_worker_runtime',
  [secretArn('delivery')]: 'program_commerce_delivery_runtime', [secretArn('operator')]: 'program_commerce_operator_runtime',
};
const decided = <T>(value: T) => ({ state: 'decided' as const, value, decidedBy: 'FICTIONAL REVIEW FIXTURE', decidedAt: '2026-10-12T00:00:00Z', evidenceSha256: 'd'.repeat(64) });
const baseTarget = () => ({
  contract: 'program-commerce-host-target/1', execution: 'qualification', account: '588966314750', region: 'us-east-2', phiAllowed: false, productionActivation: 'blocked',
  sourceCommit: 'a'.repeat(40), hostReviewSha256: 'b'.repeat(64),
  database: { clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional-qualification', databaseName: 'clinical_core_qualification', sessions: {
    api: { secretArn: secretArn('api'), login: 'program_commerce_api_runtime' }, worker: { secretArn: secretArn('worker'), login: 'program_commerce_worker_runtime' },
    delivery: { secretArn: secretArn('delivery'), login: 'program_commerce_delivery_runtime' }, operator: { secretArn: secretArn('operator'), login: 'program_commerce_operator_runtime' },
  } },
  consumer: { poolId: POOL, clientId: CLIENT, signInOrigin: 'https://fictional-learners.auth.us-east-2.amazoncognito.com', desktopOrigin: ORIGIN },
  activation: { contract: 'program-commerce-activation/1', enabled: true, target: 'synthetic-staging', schemaCandidateSha256: PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256, evidenceSha256: 'e'.repeat(64), reviewedBy: 'FICTIONAL REVIEW FIXTURE', reviewedAt: '2026-10-12T00:00:00Z' },
  candidates: { ...REVIEWED_COMMERCE_CANDIDATES },
  processor: { mode: 'test', accountRef: ACCEPTANCE_FIXTURE.expected.accountRef, apiVersion: ACCEPTANCE_FIXTURE.expected.apiVersion, priceRefs: [PRICE] },
  delivery: { provider: 'ses', region: 'us-east-2', fromAddress: 'courses@fictional.example', configurationSet: null, messageIdDomain: 'mail.fictional.example' },
  sealing: { keyRef: 'claim-sealer:fictional-qualification/v1' },
  decisions: { purchaserContactAuthority: decided('payment_processor_collected_email'), claimCodeLifetimeDays: decided(7), staffProgressVisibility: { state: 'held' }, storefrontClassification: { state: 'held' } },
});
const TARGET: ProgramCommerceHostTarget = programCommerceHostTarget.parse(baseTarget());
const SEALING_KEY = randomBytes(32).toString('base64');
const ENV: Record<string, string> = {
  APP_EDITION: 'clinical', PROGRAM_COMMERCE_QUALIFICATION_ENABLED: 'true', PHI_ALLOWED: 'false', PRODUCTION_ACTIVATION: 'blocked', CLINICAL_CONTRACT_FIXTURE: '0',
  STRIPE_TEST_MODE_ENABLED: '1', STRIPE_TEST_SECRET_KEY: 'sk_test_FictionalReviewed01', STRIPE_TEST_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_TEST_ACCOUNT_ID: ACCEPTANCE_FIXTURE.expected.accountRef, STRIPE_API_VERSION_PINNED: ACCEPTANCE_FIXTURE.expected.apiVersion,
  PROGRAM_COMMERCE_CLAIM_SEALING_KEY: SEALING_KEY,
};
const stubEnv = (over: Record<string, string> = {}) => { for (const [key, value] of Object.entries({ ...ENV, ...over })) vi.stubEnv(key, value); };

/* ------------------------------------------------------------- identity (real signatures) */
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(keys.publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: KID, alg: 'RS256', use: 'sig' };
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function signIdToken(claims: Record<string, unknown>, key = keys.privateKey) {
  const head = b64({ alg: 'RS256', kid: KID, typ: 'JWT' }), body = b64(claims);
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
  return `${head}.${body}.${signature}`;
}
type Learner = 'a' | 'b';
const cognitoUsers = new Map<string, { learner: Learner; revoked: boolean }>();
let getUserDown = false;
function signIn(learner: Learner, over: Record<string, unknown> = {}) {
  const fixture = ACCEPTANCE_FIXTURE.learners[learner];
  const now = Math.floor(Date.now() / 1000);
  const idToken = signIdToken({ sub: fixture.identitySubject, iss: ISSUER, aud: CLIENT, token_use: 'id', iat: now, auth_time: now, exp: now + 3600, 'custom:person_id': fixture.personId, 'custom:organization_id': ORG, 'custom:synthetic_attested': 'true', ...over });
  const accessToken = `acc.${randomBytes(18).toString('base64url')}.sig`;
  cognitoUsers.set(accessToken, { learner, revoked: false });
  return { idToken, accessToken };
}
const revokeAll = (learner: Learner) => { for (const [token, user] of cognitoUsers) if (user.learner === learner) cognitoUsers.set(token, { ...user, revoked: true }); };
const jwtVerifier = CognitoJwtVerifier.create({ userPoolId: POOL, tokenUse: 'id', clientId: CLIENT });
jwtVerifier.cacheJwks({ keys: [jwk] } as never);
const consumerSessions = createConsumerSessionVerifier({
  verifyIdToken: async token => (await jwtVerifier.verify(token)) as unknown as Record<string, unknown>,
  getUser: async (accessToken): Promise<ConsumerUser> => {
    if (getUserDown) throw new Error('fictional identity service outage');
    const user = cognitoUsers.get(accessToken);
    if (!user || user.revoked) throw new ConsumerSessionRevoked();
    const fixture = ACCEPTANCE_FIXTURE.learners[user.learner];
    return { username: fixture.identitySubject, attributes: { sub: fixture.identitySubject, 'custom:person_id': fixture.personId, 'custom:organization_id': ORG } };
  },
});

/* ------------------------------------------------------------- processor (fake Stripe API) */
type StripeSession = Record<string, unknown> & { id: string };
const stripe = {
  sessions: new Map<string, StripeSession>(), keys: new Map<string, { body: string; id: string }>(), calls: [] as string[],
  faults: {} as { loseNextCreateReply?: boolean; down?: boolean },
  pay(id: string, email: string | null) {
    const session = this.sessions.get(id)!;
    Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: { id: 'pi_fictional' + id.slice(-8), status: 'succeeded' }, customer_details: email ? { email } : null });
  },
};
const stripeFetch = async (url: string, init: RequestInit): Promise<Response> => {
  stripe.calls.push(`${init.method} ${url}`);
  if ((init.headers as Record<string, string>).authorization !== `Bearer ${ENV.STRIPE_TEST_SECRET_KEY}`) return Response.json({ error: { type: 'invalid_request_error' } }, { status: 401 });
  if (stripe.faults.down) return new Response('unavailable', { status: 503 });
  const path = new URL(url).pathname;
  if (path === '/v1/account') return Response.json({ id: ACCEPTANCE_FIXTURE.expected.accountRef, object: 'account' });
  if (path === '/v1/checkout/sessions' && init.method === 'POST') {
    const body = String(init.body), key = (init.headers as Record<string, string>)['idempotency-key']!;
    const seen = stripe.keys.get(key);
    if (seen && seen.body !== body) return Response.json({ error: { type: 'idempotency_error' } }, { status: 400 });
    let session = seen ? stripe.sessions.get(seen.id)! : null;
    if (!session) {
      const form = new URLSearchParams(body), id = 'cs_test_' + randomBytes(12).toString('hex');
      session = { id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}`, expires_at: Number(form.get('expires_at')), status: 'open', payment_status: 'unpaid', mode: form.get('mode'), livemode: false,
        amount_total: 1234, currency: 'usd', client_reference_id: form.get('client_reference_id'), metadata: { order_id: form.get('metadata[order_id]') },
        line_items: { data: [{ price: { id: form.get('line_items[0][price]') } }] }, payment_intent: null, success_url: form.get('success_url'), cancel_url: form.get('cancel_url'), customer_details: null };
      stripe.sessions.set(id, session); stripe.keys.set(key, { body, id });
    }
    if (stripe.faults.loseNextCreateReply) { stripe.faults.loseNextCreateReply = false; throw new TypeError('fictional connection reset'); }
    return Response.json(session);
  }
  const match = /^\/v1\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (match && init.method === 'GET') {
    const session = stripe.sessions.get(match[1]!);
    return session ? Response.json(session) : Response.json({ error: { type: 'invalid_request_error' } }, { status: 404 });
  }
  return Response.json({ error: { type: 'invalid_request_error' } }, { status: 404 });
};

/* ------------------------------------------------------------- email (fake SES) */
const ses = { sent: [] as { to: string; messageId: string; raw: string }[], faults: {} as { next?: 'unknown' | 'accept_then_lose_reply' | 'reject' } };
const sesSend = async (command: SendEmailCommand) => {
  const fault = ses.faults.next; ses.faults.next = undefined;
  if (fault === 'unknown') throw Object.assign(new Error('fictional SES timeout'), { name: 'TimeoutError' });
  if (fault === 'reject') throw Object.assign(new Error('fictional rejection'), { name: 'MessageRejected' });
  const raw = new TextDecoder().decode(command.input.Content!.Raw!.Data!);
  ses.sent.push({ to: command.input.Destination!.ToAddresses![0]!, messageId: /^Message-ID: (.+)$/m.exec(raw)![1]!.trim(), raw });
  if (fault === 'accept_then_lose_reply') throw Object.assign(new Error('fictional reply lost'), { name: 'TimeoutError' });
  return { MessageId: 'ses-fictional-' + ses.sent.length };
};
const codesTo = (address: string) => ses.sent.filter(m => m.to === address).map(m => /^([A-Za-z0-9_-]{43,64})\r?$/m.exec(m.raw)![1]!);

/* ------------------------------------------------------------- the database and the host */
let dir = '';
let db: PGlite;
let bootstrapUser = '';
let rds: ReturnType<typeof createPgliteRdsDataClient>;
let inputs: Omit<ReviewedCommerceInputs, 'target' | 'env'>;
/** Time passing for the delivery retry schedule only; every other clock is the engine's. */
let clockOffsetMs = 0;
const now = () => new Date(Date.now() + clockOffsetMs);
let api: ReturnType<typeof createReviewedEducationApiHandler>;
let worker: ReturnType<typeof createReviewedCommerceWorkerHandler>;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const versions = { purchased: '7e1b0000-0000-4000-8000-000000000031', later: '7e1b0000-0000-4000-8000-000000000032' };
const purchasedPhases = () => [
  ...journeyCoursePhases('first'),
  { id: 'phase-3', title: 'Fictional phase three', days: 7, transition: 'scheduled', items: [
    { id: 'supplement-d', title: 'Fictional supplement D (test fixture)', kind: 'supplement', instructions: 'Fictional supplement step: reviewed with a practitioner before anything is added.', released: true,
      product: { id: 'fictional-product-1', ingredientKeys: ['fictional-ingredient'], dose: 'Fictional label text (test fixture)', purchaseUrl: null } },
  ] },
];

async function openDatabase() {
  db = await PGlite.create(dir, { extensions: { pgcrypto } });
  bootstrapUser = (await db.query<{ s: string }>('select session_user::text as s')).rows[0]!.s;
  rds = createPgliteRdsDataClient(db, LOGINS, bootstrapUser);
}
/** A fresh process: new database handle, new runtime, new bootstrap; nothing carried in memory. */
async function startHost() {
  __resetLearnerHost(); __resetReviewedLearner(); __resetReviewedPurchasing();
  inputs = { rdsClient: rds, fetch: stripeFetch, sesSend, consumerSessions, now };
  const outcome = await bootstrapReviewedCommerce({ env: process.env, readTarget: async () => TARGET, runtimeInputs: inputs });
  expect(outcome).toEqual({ installed: true, learner: true, purchasing: true, holds: [] });
  api = createReviewedEducationApiHandler({ env: process.env, target: () => TARGET, runtimeInputs: inputs });
  worker = createReviewedCommerceWorkerHandler({ env: process.env, target: () => TARGET, runtimeInputs: inputs });
}
async function restart() { await db.close(); await openDatabase(); await startHost(); }

async function publish(versionId: string, version: number, phases: unknown[]) {
  await db.query("insert into clinical_core.synthetic_desktop_program_versions(id,organization_id,program_id,version,status,content,created_by_person_id,published_at) values($1,$2,$3,$4,'published',$5::jsonb,$6,clock_timestamp())",
    [versionId, ORG, PROGRAM, version, JSON.stringify({ consumerProgram: { title: JOURNEY_COURSE_TITLE, phases } }), ACCEPTANCE_FIXTURE.staffPersonId]);
  await db.query('update clinical_core.synthetic_desktop_programs set published_version_id=$2 where id=$1', [PROGRAM, versionId]);
}

beforeAll(async () => {
  stubEnv();
  dir = mkdtempSync(join(tmpdir(), 'alp-reviewed-commerce-'));
  db = await PGlite.create(dir, { extensions: { pgcrypto } });
  await buildChainAndFixture(db, process.cwd());
  const sessionsSql = readFileSync('infra/aws-clinical-core/source-candidates/program-commerce-runtime-sessions.sql', 'utf8');
  expect(sha(sessionsSql)).toBe(PROGRAM_COMMERCE_RUNTIME_SESSIONS_SCHEMA_CANDIDATE_SHA256);
  await db.exec(sessionsSql);
  // The purchased version carries a supplement step (held: never completable by a learner).
  await publish(versions.purchased, 2, purchasedPhases());
  await db.close();
  await openDatabase();
  // The fixture clinician publishes one fictional offer through the SQL offer ledger over the API session.
  const offers = createSqlProgramOfferLedger({ database: createRdsDataCommerceSessionDatabase({ clusterArn: TARGET.database.clusterArn, secretArn: secretArn('api'), databaseName: 'clinical_core_qualification', region: 'us-east-2' }, 'api', rds), activation: TARGET.activation, identity: actor => ({ identityPool: 'workforce', identitySubject: 'wf:' + actor.personId }) });
  const me = { personId: ACCEPTANCE_FIXTURE.staffPersonId, organizationId: ORG };
  const created = await offers.execute(me, { action: 'create', programId: PROGRAM, terms: { mode: 'paid', name: 'Fictional reviewed-runtime program (test fixture)', pricing: { currency: 'USD', amountMinor: 1234, billing: { kind: 'one_time' } }, providerPriceRef: PRICE, accessTermsVersion: 'education-access-terms/1', accessDurationDays: 30 } });
  if (created.action !== 'create') throw new Error('offer not created');
  await offers.execute(me, { action: 'approve_provider_mapping', offerId: created.offer.offerId, expectedRevision: 1 });
  await offers.execute(me, { action: 'publish', offerId: created.offer.offerId, expectedRevision: 2 });
  await startHost();
}, 240_000);
afterAll(async () => {
  __resetLearnerHost(); __resetReviewedLearner(); __resetReviewedPurchasing();
  await db?.close().catch(() => undefined);
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => stubEnv());
afterEach(() => { getUserDown = false; stripe.faults = {}; ses.faults = {}; rds.faults.before = undefined; rds.faults.loseReply = undefined; });

/* ------------------------------------------------------------- request helpers */
async function signedEvent(id: string, type: string, sessionRef: string) {
  const raw = JSON.stringify({ id, type, livemode: false, created: Math.floor(Date.now() / 1000), api_version: ACCEPTANCE_FIXTURE.expected.apiVersion, account: ACCEPTANCE_FIXTURE.expected.accountRef, data: { object: { object: 'checkout.session', id: sessionRef } } });
  const t = Math.floor(Date.now() / 1000);
  const response = await webhookRoute(new Request(`${ORIGIN}/api/live/commerce/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${raw}`, 'utf8').digest('hex')}` }, body: raw }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
type Tokens = { idToken: string; accessToken: string };
/** The V2 path: the consumer education API with the ID token as bearer and the access token header. */
async function v2(route: 'education' | 'progress', tokens: Tokens | null, body: unknown, claims?: Record<string, unknown>) {
  const response = await api({
    routeKey: route === 'education' ? 'POST /clinical-core/consumer/education' : 'POST /clinical-core/consumer/education/progress',
    headers: { 'content-type': 'application/json', ...(tokens ? { authorization: `Bearer ${tokens.idToken}`, [CONSUMER_ACCESS_TOKEN_HEADER]: tokens.accessToken } : {}) },
    body: JSON.stringify(body), requestContext: claims ? { authorizer: { jwt: { claims: claims as never } } } : undefined,
  });
  return { status: response.statusCode, json: JSON.parse(response.body) as { data?: Record<string, unknown>; error?: { code: string } } };
}
/** The Desktop path: My courses with the two HttpOnly session cookies. */
async function desktop(tokens: Tokens | null, body: unknown) {
  const cookie = tokens ? `${CONSUMER_ID_COOKIE}=${tokens.idToken}; ${CONSUMER_ACCESS_COOKIE}=${tokens.accessToken}` : '';
  const response = await myCoursesRoute(new Request(`${ORIGIN}/api/my-courses`, { method: 'POST', headers: { host: 'clinic.fictional.example', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }));
  return { status: response.status, json: await response.json() as { data?: Record<string, unknown>; host?: string; error?: { code: string } } };
}
const addressFor = (orderId: string) => `purchaser+${orderId.slice(0, 8)}@purchasers.fictional.example`;
async function purchasing() {
  const runtime = await resolvePurchaseRuntime();
  if (runtime.kind !== 'reviewed') throw new Error('reviewed purchasing not open: ' + runtime.kind);
  return runtime;
}
async function buy(attemptKey: string, email: string | null = null) {
  const runtime = await purchasing();
  const started = await runtime.checkout.start({ funnelSlug: 'fictional-reviewed', programBinding: { organizationId: ORG, programId: PROGRAM }, attemptKey });
  if (!started.started) throw new Error('checkout held: ' + started.reason);
  const order = (await runtime.ledger.readOrder(started.orderId))!;
  const sessionRef = order.processor!.sessionRef!;
  stripe.pay(sessionRef, email ?? addressFor(order.orderId));
  return { orderId: order.orderId, sessionRef, checkoutUrl: started.checkoutUrl };
}

let orderA = '', sessionA = '', entitlementA = '', enrollmentA = '', curriculumA: Record<string, unknown> = {};
let tokensA: Tokens;

describe('the reviewed runtime opens only from the bootstrap, over the four role sessions', () => {
  it('the target pins every candidate, including the runtime-sessions successor, and the bootstrap installed a reviewed host', async () => {
    expect(TARGET.candidates.runtimeSessions).toBe(PROGRAM_COMMERCE_RUNTIME_SESSIONS_SCHEMA_CANDIDATE_SHA256);
    expect((await desktop(null, { service: 'education', body: { action: 'access' } }))).toMatchObject({ status: 401, json: { error: { code: 'learner_signin_required' } } });
  });
  it('each login can assume only its own role (candidate grants on the embedded engine; not hosted isolation)', async () => {
    const as = (secret: string, authority: 'api' | 'worker' | 'delivery' | 'operator') => createRdsDataCommerceSessionDatabase({ clusterArn: TARGET.database.clusterArn, secretArn: secretArn(secret), databaseName: 'clinical_core_qualification', region: 'us-east-2' }, authority, rds);
    const who = async (secret: string, authority: 'api' | 'worker' | 'delivery' | 'operator') => (await as(secret, authority).transaction(tx => tx.query<{ s: string; c: string }>('select session_user::text as s, current_user::text as c'))).rows[0];
    expect(await who('api', 'api')).toEqual({ s: 'program_commerce_api_runtime', c: 'clinical_core_api' });
    expect(await who('worker', 'worker')).toEqual({ s: 'program_commerce_worker_runtime', c: 'commercial_education_worker' });
    expect(await who('delivery', 'delivery')).toEqual({ s: 'program_commerce_delivery_runtime', c: 'commercial_education_delivery' });
    expect(await who('operator', 'operator')).toEqual({ s: 'program_commerce_operator_runtime', c: 'commercial_education_operator' });
    for (const [secret, wrong] of [['api', 'worker'], ['worker', 'api'], ['delivery', 'operator'], ['operator', 'delivery'], ['api', 'delivery']] as const) {
      await expect(as(secret, wrong).transaction(tx => tx.query('select 1')), `${secret} as ${wrong}`).rejects.toBeTruthy();
    }
    // A NOINHERIT login holds nothing until it assumes its role: without `set local role`, the order table is closed even to the API login.
    await expect(createRdsDataCommerceSessionDatabase({ clusterArn: TARGET.database.clusterArn, secretArn: secretArn('delivery'), databaseName: 'clinical_core_qualification', region: 'us-east-2' }, 'delivery', rds).transaction(tx => tx.query("select commercial_education.reissue_program_claim(gen_random_uuid(),gen_random_uuid(),repeat('a',64),now(),'{}'::jsonb,'op:x')"))).rejects.toBeTruthy();
  });
  it('the RDS factory refuses a target outside the qualification account, region or database', () => {
    const good = { clusterArn: TARGET.database.clusterArn, secretArn: secretArn('api'), databaseName: 'clinical_core_qualification', region: 'us-east-2' };
    expect(() => createRdsDataCommerceSessionDatabase({ ...good, databaseName: 'clinical_core' }, 'api', rds)).toThrow();
    expect(() => createRdsDataCommerceSessionDatabase({ ...good, region: 'us-west-2' }, 'api', rds)).toThrow();
    expect(() => createRdsDataCommerceSessionDatabase({ ...good, clusterArn: 'arn:aws:rds:us-east-2:111111111111:cluster:other' }, 'api', rds)).toThrow();
    expect(() => createRdsDataCommerceSessionDatabase(good, 'administrator' as never, rds)).toThrow();
  });
  it('repaired gap: the worker\'s reconciliation list reached the Data API as an array parameter, which the factory cannot encode', async () => {
    const workerOrders = createSqlCheckoutLedger({ database: createRdsDataCommerceSessionDatabase({ clusterArn: TARGET.database.clusterArn, secretArn: secretArn('worker'), databaseName: 'clinical_core_qualification', region: 'us-east-2' }, 'worker', rds), authority: 'worker',
      activation: TARGET.activation, checkoutCandidateSha256: TARGET.candidates.checkout, checkoutRecoveryCandidateSha256: TARGET.candidates.checkoutRecovery, commerceAuthorityCandidateSha256: TARGET.candidates.commerceAuthority });
    await expect(workerOrders.ordersInStates(['creation_pending', 'checkout_open'], 5)).resolves.toEqual(expect.any(Array));
  });
});

describe('purchase → webhook → settlement → delivery → claim → exact curriculum → progress', () => {
  it('checkout is admitted against a listed price; a lost creation reply is answered by the same order and session', async () => {
    const runtime = await purchasing();
    stripe.faults.loseNextCreateReply = true;
    const first = await runtime.checkout.start({ funnelSlug: 'fictional-reviewed', programBinding: { organizationId: ORG, programId: PROGRAM }, attemptKey: 'browser-a' });
    expect(first.started).toBe(false);
    const again = await runtime.checkout.start({ funnelSlug: 'fictional-reviewed', programBinding: { organizationId: ORG, programId: PROGRAM }, attemptKey: 'browser-a' });
    expect(again).toMatchObject({ started: true, checkoutUrl: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/) });
    if (!again.started) return;
    expect(stripe.sessions.size).toBe(1);
    orderA = again.orderId;
    sessionA = (await runtime.ledger.readOrder(orderA))!.processor!.sessionRef!;
    stripe.pay(sessionA, addressFor(orderA));
  });
  it('the signed webhook only admits; duplicates are recorded as duplicates; nothing settles until the worker runs', async () => {
    expect(await signedEvent('evt_a_completed', 'checkout.session.completed', sessionA)).toMatchObject({ status: 200, body: { outcome: 'admitted' } });
    expect(await signedEvent('evt_a_completed', 'checkout.session.completed', sessionA)).toMatchObject({ status: 200, body: { outcome: 'duplicate' } });
    // A second, distinct event for the same payment converges on the same order.
    expect(await signedEvent('evt_a_completed_again', 'checkout.session.completed', sessionA)).toMatchObject({ status: 200, body: { outcome: 'admitted' } });
    expect((await (await purchasing()).ledger.readOrder(orderA))!.state).toBe('checkout_open');
    expect(ses.sent).toHaveLength(0);
  });
  it('a crash after settlement committed (its reply lost) and a restart still yield ONE entitlement and ONE code, sent by SES under one Message-ID', async () => {
    let lost = false;
    rds.faults.loseReply = command => {
      if (!lost && command.kind === 'commit' && command.secretArn === secretArn('worker') && settling) { lost = true; return true; }
      return false;
    };
    let settling = false;
    rds.faults.before = command => { if (command.kind === 'execute' && command.secretArn === secretArn('worker')) settling = /settle_program_order_sealed/.test(command.sql ?? ''); };
    ses.faults.next = 'accept_then_lose_reply';
    rds.used.length = 0;
    const first = await worker();
    expect(first.ran).toBe(true);
    expect(lost).toBe(true);
    // The worker reached the database only through the worker and delivery sessions.
    const workerSecrets = new Set(rds.used.map(entry => entry.secretArn));
    expect(workerSecrets).toEqual(new Set([secretArn('worker'), secretArn('delivery')]));
    await restart();
    // Settlement already committed: the restarted pass finds nothing to settle and creates nothing new.
    const second = await worker();
    expect(second).toMatchObject({ ran: true, counts: { settlement: {} } });
    expect(ses.sent).toHaveLength(1);
    // The provider's outcome was unknown, so the delivery is retried once its time comes: the SAME message again.
    clockOffsetMs += 5 * 60_000;
    const third = await worker();
    expect(third).toMatchObject({ ran: true, counts: { delivery: { accepted: 1 } } });
    const order = (await (await purchasing()).ledger.readOrder(orderA))!;
    expect(order.state).toBe('payment_verified');
    const sent = ses.sent.filter(m => m.to === addressFor(orderA));
    expect(sent).toHaveLength(2);
    const codes = codesTo(addressFor(orderA));
    // One code and one deterministic Message-ID however many attempts the lost replies caused; SES itself can still deliver both.
    expect(new Set(codes).size).toBe(1);
    expect(new Set(sent.map(m => m.messageId)).size).toBe(1);
    // A fourth pass sends nothing more: the accepted delivery is closed.
    await worker();
    expect(ses.sent.filter(m => m.to === addressFor(orderA))).toHaveLength(2);
    // The worker's summary carries counts, never a code or an address.
    expect(JSON.stringify([first, second, third])).not.toContain(codes[0]!);
    expect(JSON.stringify([first, second, third])).not.toContain('@');
  });
  it('the education API reached the database only through the API session', async () => {
    tokensA = signIn('a');
    rds.used.length = 0;
    expect((await v2('education', tokensA, { action: 'access' })).status).toBe(200);
    expect(new Set(rds.used.map(entry => entry.secretArn))).toEqual(new Set([secretArn('api')]));
  });
  it('V2 claims with a verified session; a retry is the same receipt; another owner is refused and cannot read the course', async () => {
    const code = codesTo(addressFor(orderA))[0]!;
    const claimed = await v2('education', tokensA, { action: 'claim', token: code });
    expect(claimed).toMatchObject({ status: 200, json: { data: { action: 'claim', outcome: 'claimed' } } });
    expect((await v2('education', tokensA, { action: 'claim', token: code })).json.data).toMatchObject({ outcome: 'claimed' });
    const tokensB = signIn('b');
    expect((await v2('education', tokensB, { action: 'claim', token: code })).json.data).toMatchObject({ outcome: 'refused', reason: 'already_claimed_by_other' });
    const view = (await v2('education', tokensA, { action: 'access' })).json.data!.view as { entitlements: { entitlementId: string; curriculum: Record<string, unknown> }[]; enrollments: { enrollmentId: string }[]; consumerSubject: string };
    expect(view.consumerSubject).toBe(ACCEPTANCE_FIXTURE.learners.a.identitySubject);
    expect(view.entitlements).toHaveLength(1);
    entitlementA = view.entitlements[0]!.entitlementId; enrollmentA = view.enrollments[0]!.enrollmentId; curriculumA = view.entitlements[0]!.curriculum;
    expect(curriculumA).toMatchObject({ versionId: versions.purchased, version: 2 });
    expect((await v2('education', tokensB, { action: 'curriculum', entitlementId: entitlementA })).json.data).toMatchObject({ read: { outcome: 'withheld', reason: 'not_owner' } });
    expect((await v2('education', tokensB, { action: 'access' })).json.data).toMatchObject({ view: { entitlements: [] } });
  });
  it('the exact purchased version is served on both surfaces after a later version is published (stale curriculum is not substituted)', async () => {
    await publish(versions.later, 3, journeyCoursePhases('later'));
    const fromV2 = (await v2('education', tokensA, { action: 'curriculum', entitlementId: entitlementA })).json.data;
    expect(fromV2).toMatchObject({ read: { outcome: 'served', curriculum: curriculumA } });
    const fromDesktop = await desktop(tokensA, { service: 'education', body: { action: 'curriculum', entitlementId: entitlementA } });
    expect(fromDesktop).toMatchObject({ status: 200, json: { host: 'reviewed', data: { read: { outcome: 'served', curriculum: curriculumA } } } });
    const served = JSON.stringify(fromDesktop.json.data);
    expect(served).toContain('Fictional reading A for the journey fixture.');
    expect(served).not.toContain('Fictional reading A, revised.');
    // A write naming the newer version is refused as stale; the purchased pin is the only one that records.
    const write = (lesson: { phaseId: string; itemId: string }, expectedRevision: number, curriculum = curriculumA) => ({ action: 'complete', entitlementId: entitlementA, enrollmentId: enrollmentA, curriculum, lesson, expectedRevision, requestId: randomUUID() });
    expect((await v2('progress', tokensA, write({ phaseId: 'phase-1', itemId: 'lesson-a' }, 0, { ...curriculumA, versionId: versions.later, version: 3 }))).json.data).toMatchObject({ outcome: { outcome: 'refused', reason: 'stale_version' } });
    // New purchases are held until the offer names the newer version; the clinic returning to the sold version reopens them.
    expect(await (await purchasing()).offers.availability(ORG, PROGRAM)).toMatchObject({ available: false, reason: 'curriculum_changed' });
    await db.query('update clinical_core.synthetic_desktop_programs set published_version_id=$2 where id=$1', [PROGRAM, versions.purchased]);
    expect(await (await purchasing()).offers.availability(ORG, PROGRAM)).toMatchObject({ available: true });
  });
  it('progress records on one surface and reads on the other; a supplement step stays held; a lost reply is answered by the same receipt', async () => {
    const save = { action: 'complete', entitlementId: entitlementA, enrollmentId: enrollmentA, curriculum: curriculumA, lesson: { phaseId: 'phase-1', itemId: 'lesson-a' }, expectedRevision: 0, requestId: randomUUID() };
    let dropped = false;
    rds.faults.loseReply = command => { if (!dropped && command.kind === 'commit' && command.secretArn === secretArn('api') && recording) { dropped = true; return true; } return false; };
    let recording = false;
    rds.faults.before = command => { if (command.kind === 'execute' && command.secretArn === secretArn('api')) recording = /record_education_progress_for_caller/.test(command.sql ?? ''); };
    expect((await v2('progress', tokensA, save)).status).toBe(503);
    rds.faults.loseReply = undefined; rds.faults.before = undefined;
    expect((await desktop(tokensA, { service: 'progress', body: save })).json.data).toMatchObject({ outcome: { outcome: 'recorded', receipt: { requestId: save.requestId, revision: 1 } } });
    expect((await v2('progress', tokensA, { action: 'read', entitlementId: entitlementA })).json.data).toMatchObject({ read: { outcome: 'read', progress: { revision: 1, completed: [{ lesson: { phaseId: 'phase-1', itemId: 'lesson-a' } }] } } });
    const supplement = { ...save, lesson: { phaseId: 'phase-3', itemId: 'supplement-d' }, expectedRevision: 1, requestId: randomUUID() };
    expect((await desktop(tokensA, { service: 'progress', body: supplement })).json.data).toMatchObject({ outcome: { outcome: 'refused', reason: 'not_completable' } });
    const tokensB = signIn('b');
    expect((await v2('progress', tokensB, { ...save, requestId: randomUUID(), expectedRevision: 1 })).json.data).toMatchObject({ outcome: { outcome: 'refused', reason: 'not_owner' } });
  });
});

describe('identity: verified sessions only, revocation on every request, no remembered answer', () => {
  it('a request body, a forged or foreign token, a production-bound or unattested token, and an access token for another user are refused', async () => {
    const other = signIn('b');
    expect((await v2('education', null, { action: 'access' })).status).toBe(401);
    expect((await v2('education', { idToken: tokensA.idToken, accessToken: other.accessToken }, { action: 'access' })).status).toBe(401);
    const forged = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const { accessToken } = signIn('a');
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: ACCEPTANCE_FIXTURE.learners.a.identitySubject, iss: ISSUER, aud: CLIENT, token_use: 'id', iat: now, auth_time: now, exp: now + 3600, 'custom:person_id': ACCEPTANCE_FIXTURE.learners.a.personId, 'custom:organization_id': ORG, 'custom:synthetic_attested': 'true' };
    expect((await v2('education', { idToken: signIdToken(claims, forged), accessToken }, { action: 'access' })).status).toBe(401);
    expect((await v2('education', { idToken: signIdToken({ ...claims, aud: 'workforceclient1' }), accessToken }, { action: 'access' })).status).toBe(401);
    expect((await v2('education', { idToken: signIdToken({ ...claims, token_use: 'access' }), accessToken }, { action: 'access' })).status).toBe(401);
    expect((await v2('education', { idToken: signIdToken({ ...claims, 'custom:production_bound': 'true' }), accessToken }, { action: 'access' })).status).toBe(401);
    expect((await v2('education', { idToken: signIdToken({ ...claims, 'custom:synthetic_attested': 'false' }), accessToken }, { action: 'access' })).status).toBe(401);
    expect((await v2('education', { idToken: signIdToken({ ...claims, exp: now - 10 }), accessToken }, { action: 'access' })).status).toBe(401);
    // The gateway's own claims must name the same subject as the verified session.
    expect((await v2('education', tokensA, { action: 'access' }, { sub: ACCEPTANCE_FIXTURE.learners.b.identitySubject })).status).toBe(401);
    // A body naming another learner changes nothing: the view is the verified caller's.
    expect((await v2('education', tokensA, { action: 'access', consumerSubject: ACCEPTANCE_FIXTURE.learners.b.identitySubject })).status).toBe(400);
  });
  it('a revoked session stops at the next request on both surfaces, including mid-request (the reply is discarded)', async () => {
    const session = signIn('a');
    expect((await desktop(session, { service: 'education', body: { action: 'access' } })).status).toBe(200);
    // Revoked while the service call runs: the API session's first statement is the moment.
    rds.faults.before = command => { if (command.kind === 'execute' && /education_access_for_caller/.test(command.sql ?? '')) revokeAll('a'); };
    expect(await v2('education', session, { action: 'access' })).toMatchObject({ status: 401, json: { error: { code: 'consumer_signin_required' } } });
    rds.faults.before = undefined;
    expect((await desktop(session, { service: 'education', body: { action: 'access' } })).status).toBe(401);
    expect((await v2('education', session, { action: 'access' })).status).toBe(401);
    tokensA = signIn('a');
    expect((await v2('education', tokensA, { action: 'access' })).status).toBe(200);
  });
  it('an unreachable identity service is unavailable, never "signed out" and never a remembered positive', async () => {
    getUserDown = true;
    expect(await v2('education', tokensA, { action: 'access' })).toMatchObject({ status: 503, json: { error: { code: 'service_unavailable' } } });
    expect((await desktop(tokensA, { service: 'education', body: { action: 'access' } })).status).toBe(503);
  });
});

describe('a second purchase: delivery faults, restarts, the payment processor holding the only contact', () => {
  it('no processor-held email means no send and a recorded failure; an SES refusal is recorded; nothing invents a recipient', async () => {
    const { orderId, sessionRef } = await buy('browser-c');
    stripe.pay(sessionRef, null);
    const before = ses.sent.length;
    expect((await signedEvent('evt_c_completed', 'checkout.session.completed', sessionRef)).status).toBe(200);
    expect(await worker()).toMatchObject({ ran: true, counts: { settlement: { settled_queued: 1 }, delivery: { failed: 1 } } });
    expect((await (await purchasing()).ledger.readOrder(orderId))!.state).toBe('payment_verified');
    expect(ses.sent).toHaveLength(before);
    // An address SES refuses is a recorded failure, not a retry and not a second address.
    const refused = await buy('browser-e');
    expect((await signedEvent('evt_e_completed', 'checkout.session.completed', refused.sessionRef)).status).toBe(200);
    ses.faults.next = 'reject';
    expect(await worker()).toMatchObject({ ran: true, counts: { delivery: { failed: 1 } } });
    clockOffsetMs += 120 * 60_000;
    await worker();
    expect(codesTo(addressFor(refused.orderId))).toHaveLength(0);
  });
  it('a restart between admission and processing loses nothing: the next process settles and delivers', async () => {
    const { orderId, sessionRef } = await buy('browser-d');
    expect((await signedEvent('evt_d_completed', 'checkout.session.completed', sessionRef)).status).toBe(200);
    await restart();
    await worker();
    expect(codesTo(addressFor(orderId))).toHaveLength(1);
  });
});

describe('missing configuration leaves purchasing (and the worker) disabled while reading stays as configured', () => {
  const without = (env: Record<string, string>, target = TARGET) => {
    __resetLearnerHost(); __resetReviewedLearner(); __resetReviewedPurchasing();
    return bootstrapReviewedCommerce({ env: { ...ENV, ...env }, readTarget: async () => target, runtimeInputs: inputs });
  };
  afterAll(async () => { await startHost(); });
  it.each([
    ['no Stripe test key', { STRIPE_TEST_SECRET_KEY: '' }, 'stripe_credentials_missing'],
    ['a live key', { STRIPE_TEST_SECRET_KEY: 'sk_live_FictionalReviewed01' }, 'stripe_credentials_missing'],
    ['no webhook secret', { STRIPE_TEST_WEBHOOK_SECRET: '' }, 'stripe_credentials_missing'],
    ['another account', { STRIPE_TEST_ACCOUNT_ID: 'acct_SomeoneElse0001' }, 'stripe_account_mismatch'],
    ['another API version', { STRIPE_API_VERSION_PINNED: '2024-01-01' }, 'stripe_api_version_mismatch'],
    ['no sealing key', { PROGRAM_COMMERCE_CLAIM_SEALING_KEY: '' }, 'sealing_key_missing'],
  ])('%s', async (_name, env, hold) => {
    const outcome = await without(env);
    expect(outcome).toMatchObject({ installed: true, purchasing: false, holds: expect.arrayContaining([hold]) });
  });
  it('no price ids, a held purchaser-contact decision, a held code lifetime', async () => {
    const t = (over: Record<string, unknown>) => programCommerceHostTarget.parse({ ...baseTarget(), ...over });
    expect(await without({}, t({ processor: { ...baseTarget().processor, priceRefs: [] } }))).toMatchObject({ purchasing: false, holds: ['price_ids_missing'] });
    expect(await without({}, t({ decisions: { ...baseTarget().decisions, purchaserContactAuthority: { state: 'held' } } }))).toMatchObject({ purchasing: false, holds: ['purchaser_contact_authority_held'] });
    expect(await without({}, t({ decisions: { ...baseTarget().decisions, claimCodeLifetimeDays: { state: 'held' } } }))).toMatchObject({ purchasing: false, holds: ['claim_code_lifetime_held'] });
  });
  it('no review evidence, flags off, a fixture process, PHI on: nothing installs at all', async () => {
    const disabled = programCommerceHostTarget.parse({ ...baseTarget(), activation: { contract: 'program-commerce-activation/1', enabled: false } });
    expect(await without({}, disabled)).toEqual({ installed: false, reason: 'runtime_closed', holds: ['activation_evidence_missing'] });
    expect(await without({ PROGRAM_COMMERCE_QUALIFICATION_ENABLED: 'false' })).toEqual({ installed: false, reason: 'flags_off' });
    expect(await without({ CLINICAL_CONTRACT_FIXTURE: '1' })).toEqual({ installed: false, reason: 'flags_off' });
    expect(await without({ PHI_ALLOWED: 'true' })).toEqual({ installed: false, reason: 'flags_off' });
    expect(await without({ PRODUCTION_ACTIVATION: 'allowed' })).toEqual({ installed: false, reason: 'flags_off' });
    expect(await without({ APP_EDITION: 'consumer' })).toEqual({ installed: false, reason: 'not_clinical' });
    __resetLearnerHost(); __resetReviewedLearner(); __resetReviewedPurchasing();
    expect(await bootstrapReviewedCommerce({ env: ENV, readTarget: async () => { throw new Error('no mount'); }, runtimeInputs: inputs })).toEqual({ installed: false, reason: 'target_unavailable' });
    // With nothing installed, the webhook answers 503 and My courses answers that no host exists.
    expect((await signedEvent('evt_none', 'checkout.session.completed', sessionA)).status).toBe(503);
    expect((await desktop(tokensA, { service: 'education', body: { action: 'access' } }))).toMatchObject({ status: 503, json: { error: { code: 'learner_host_unavailable' } } });
  });
  it('an unlisted price is held as unapproved and the processor will not charge it', async () => {
    const unlisted = programCommerceHostTarget.parse({ ...baseTarget(), processor: { ...baseTarget().processor, priceRefs: ['price_SomethingElse01'] } });
    expect(await without({}, unlisted)).toMatchObject({ installed: true, purchasing: true });
    const runtime = await purchasing();
    expect(await runtime.offers.availability(ORG, PROGRAM)).toMatchObject({ available: false, reason: 'provider_mapping_unapproved' });
  });
});
